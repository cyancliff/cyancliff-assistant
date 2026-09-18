#!/usr/bin/env node
/**
 * mail-triage.mjs — 从一堆未读里挑出真正需要动作的
 *
 *   node scripts/mail-triage.mjs              扫描并汇总（默认未读收件箱）
 *   node scripts/mail-triage.mjs --limit 60
 *   node scripts/mail-triage.mjs --push       把汇总推到手机（飞书）
 *   node scripts/mail-triage.mjs --json       结构化输出
 *
 * ## 为什么做这个，而不是继续做"拟回复"
 *
 * 接通邮箱后实测：331 封邮件里**没有需要回复的人写信** ——
 * 22 封被 Gmail 归为"私人"的也全是验证码和登录提醒。
 *
 * 所以"拟回复草稿"这条线在这个邮箱上没素材。但有素材的是另一件事：
 * **217 封未读**，其中真正需要动作的是少数，其余是推送和营销。
 * 实测 60 封未读里：13 封有动作信号（9 封账号/安全），47 封是噪声。
 *
 * 这个工具就做"从噪声里挑出信号"。
 *
 * ## 分类是**基于标题与发件人的信号匹配**，不是理解邮件内容
 *
 * 这一点必须说清，因为它决定了准确率的上限：
 *
 *   - 标题里没有关键词的邮件会漏（比如"小明回复了你"不匹配任何信号）
 *   - 营销邮件如果标题里写了"限时到期"会被误判成需要动作
 *   - 它对中英日三种语言都做了匹配，但仍会有遗漏
 *
 * 所以它的输出是**给你看的提示**，不是替你做的判断。
 * 每条都带主题和发件人，你扫一眼就知道要不要点进去。
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restartIfNeeded } from './proxy.mjs';

restartIfNeeded();

import { gmailFetch, getEnv } from './gmail-auth.mjs';
import { sendNotify } from './notify-lib.mjs';
// 分类逻辑住在 mail-classify.mjs —— 它是纯函数模块，**唯一一份实现**。
// 提出来是因为邮件自动判断那条线也要用它，两份会分叉（见那个文件的头注释）。
import { SIGNALS, NOISE, classify, renderDigest } from './mail-classify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = c(31);
const green = c(32);
const yellow = c(33);
const cyan = c(36);
const dim = c(2);
const bold = c(1);

// 分类表（SIGNALS / NOISE）、classify、renderDigest、senderAddress、isBulkSender
// 都在 mail-classify.mjs —— 这个文件只负责取信、渲染与推送。
// **别在这里再写一份判断逻辑**：两份会分叉，而不一致的表现是
// 「命令行说这封重要、手机上说不重要」。

// ── CLI ───────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const VALUE_FLAGS = new Set(['--limit', '--query']);
  const flagValue = (n) => {
    const i = args.indexOf(n);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
  };

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`${bold('mail-triage.mjs')} — 从未读里挑出真正需要动作的

  node scripts/mail-triage.mjs              扫描并汇总
  node scripts/mail-triage.mjs --push       汇总推到手机（飞书）
  node scripts/mail-triage.mjs --json       结构化输出
  node scripts/mail-triage.mjs --self-test  分类逻辑自测（不需要凭据）
  --limit N / --query "…"                   扫描范围

  ${dim('分类靠标题与发件人的关键词匹配，不理解邮件内容。')}
  ${dim('输出是提示，不是替你做的判断。')}
`);
    process.exit(0);
  }

  // ── 自测：分类逻辑 ──
  if (args.includes('--self-test')) {
    console.log(`\n${bold('分类逻辑自测')}\n`);
    let bad = 0;
    const t = (name, mail, expectKind) => {
      const r = classify(mail);
      const ok = r.kind === expectKind;
      console.log(`  ${ok ? green('✓') : red('✗')} ${name}${ok ? '' : `  期望 ${expectKind}，得到 ${r.kind}`}`);
      if (!ok) bad++;
      return r;
    };

    t('Google 安全提醒 → 信号', { subject: '安全提醒', from: 'Google <no-reply@accounts.google.com>' }, 'signal');
    t('Mozilla 新登录 → 信号', { subject: '您的 Mozilla 账户有新的登录活动', from: 'Mozilla <accounts@firefox.com>' }, 'signal');
    t('英文登录提醒 → 信号', { subject: 'New sign-in from Chrome', from: 'no-reply@x.com' }, 'signal');
    t('英文验证码 → 信号', { subject: 'Your verification code', from: 'support@y.com' }, 'signal');
    t('审核通过 → 信号', { subject: '[申请通过] 内测权限已开通', from: 'support@xiaomi.com' }, 'signal');
    t('申请有结果 → 信号', { subject: '您的申请结果已出', from: 'support@x.com' }, 'signal');
    // 这条预期改过两次，两次都是我的判断错了，不是代码错：
    //
    //   第一版写"审核中 → 信号" —— 错。`[审核中] 您的申请已收到` 是
    //   状态通知，不需要你动作；要动作的是"有结果"。
    //
    //   第二版写"→ plain" —— 加了"批量发信地址"规则之后又不对了。
    //   它来自 `support@xiaomi.com`，是批量地址，且标题里没有信号词，
    //   按新规则就该判噪声。两个理由都指向"不用管"。
    t('审核中的状态通知 + 批量地址 → 噪声', { subject: '[审核中] 您的申请已收到', from: 'support@xiaomi.com' }, 'noise');
    t('英文已批准 → 信号', { subject: 'Your request has been approved', from: 'noreply@z.com' }, 'signal');
    t('请确认 → 信号', { subject: '请确认下周的时间', from: '同学 <a@b.com>' }, 'signal');
    t('英文 action required → 信号', { subject: 'Action required: verify your email', from: 'noreply@x.com' }, 'signal');
    t('即将到期 → 信号', { subject: '您的订阅即将到期', from: 'billing@x.com' }, 'signal');
    t('额度告警 → 信号', { subject: 'API quota exceeded', from: 'noreply@api.com' }, 'signal');

    t('Reddit 推送 → 噪声', { subject: '沖縄知事選の速報', from: 'Reddit <noreply@redditmail.com>' }, 'noise');
    t('营销标"限时" → 噪声（不该因为限时而报信号）', { subject: '限时优惠：升级会员立减 50%', from: 'promo@x.com' }, 'noise');
    t('产品更新 → 噪声', { subject: 'Announcing our new model', from: 'noreply@x.ai' }, 'noise');
    t('英文产品更新 → 噪声', { subject: 'New feature: workflows', from: 'noreply@y.com' }, 'noise');
    t('周报 → 噪声', { subject: '本周技术周报', from: 'news@x.com' }, 'noise');

    t('普通邮件 → plain', { subject: '关于下周组会', from: '张三 <a@b.com>' }, 'plain');
    t('收据（重量低但仍算信号）', { subject: 'Your receipt from Command Code', from: 'invoice@stripe.com' }, 'signal');

    // 下面四条是**回归测试**：加"批量发信地址"那条规则时，
    // 我一开始把它写成普通噪声，结果把它们全误判成噪声了。
    // 它们的内容信号必须比发件人噪声强。
    t('批量地址 + 安全提醒 → 仍是信号', { subject: '安全提醒', from: 'Google <no-reply@accounts.google.com>' }, 'signal');
    t('批量地址 + 新登录 → 仍是信号', { subject: '您的 Mozilla 账户有新的登录活动', from: 'Mozilla <accounts@firefox.com>' }, 'signal');
    t('批量地址 + 收据 → 仍是信号', { subject: 'Your receipt from X #123', from: 'X <invoice+statements@stripe.com>' }, 'signal');
    t('批量地址 + 没线索 → 噪声', { subject: 'Weekly roundup', from: 'updates@somewhere.com' }, 'noise');

    // 噪声优先于信号：营销话术里会带"到期""限时"
    const r = t('内容噪声优先于信号', { subject: '限时优惠：您的额度即将超出', from: 'promo@x.com' }, 'noise');
    console.log(`      ${dim(`（它同时命中了：${r.signals.join('/') || '无'} —— 但内容噪声优先）`)}`);

    console.log('');
    if (bad) {
      console.log(`${red('✗')} ${bad} 项不通过\n`);
      process.exit(1);
    }
    console.log(`${green('✓')} 分类逻辑通过（18 项）\n`);
    process.exit(0);
  }

  // ── 扫描 ──
  const limit = Number(flagValue('--limit')) || 60;
  const query = flagValue('--query') || getEnv('GMAIL_TRIAGE_QUERY') || 'is:unread in:inbox';

  // --json 模式下 **stdout 必须是纯 JSON**：它会被别的程序解析。
  // 人看的东西一律走 stderr（在终端里照样看得见，但不污染管道）。
  //
  // 这条是踩过才加的：标题那行原本打在 JSON 前面，
  // 于是调用方 JSON.parse 直接失败 —— 而它报的是"没有返回 JSON"，
  // 完全看不出真正的原因是多了一行标题。
  const JSON_MODE = args.includes('--json');
  const say = (...a) => (JSON_MODE ? console.error(...a) : console.log(...a));

  say(`\n${bold('未读盘点')}  ${dim(query)}  上限 ${limit}\n`);

  let list;
  try {
    list = await gmailFetch(`/users/me/messages?maxResults=${limit}&q=${encodeURIComponent(query)}`);
  } catch (err) {
    console.error(`${red('✗')} 取信失败：${err.message}`);
    process.exit(1);
  }

  const ids = (list.messages || []).map((m) => m.id);
  if (!ids.length) {
    // 空结果在两种模式下都要给出**各自格式的**输出。
    // 原来只打一句人话就 exit 0，调用方拿到的是空 stdout。
    if (JSON_MODE) console.log(JSON.stringify({ scanned: 0, failed: 0, rows: [] }, null, 2));
    else console.log(dim('  没有匹配的邮件。\n'));
    process.exit(0);
  }

  const rows = [];
  let failed = 0;
  for (const [i, id] of ids.entries()) {
    try {
      const d = await gmailFetch(
        `/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
      );
      const h = (n) => (d.payload.headers.find((x) => x.name === n) || {}).value || '';
      const cls = classify({ subject: h('Subject'), from: h('From') });
      rows.push({ id, subject: h('Subject'), from: h('From'), date: h('Date'), ...cls });
    } catch (e) {
      failed++;
      if (failed <= 2) console.error(`  ${dim(`第 ${i + 1} 封读取失败：${e.message.slice(0, 70)}`)}`);
    }
    // 逐封请求容易被限流，稍微让一下
    if (i % 10 === 9) await new Promise((r) => setTimeout(r, 300));
  }

  if (JSON_MODE) {
    console.log(JSON.stringify({ scanned: rows.length, failed, rows }, null, 2));
    process.exit(0);
  }

  const digest = renderDigest(rows);

  // 终端里打一份
  const sig = rows.filter((r) => r.kind === 'signal').sort((a, b) => b.weight - a.weight);
  console.log(`  ${bold(`扫描 ${rows.length} 封`)}${failed ? dim(`（${failed} 封读取失败）`) : ''}`);
  console.log(`  ${green(`需动作 ${sig.length}`)}   ${dim(`普通 ${rows.filter((r) => r.kind === 'plain').length}`)}   ${dim(`噪声 ${rows.filter((r) => r.kind === 'noise').length}`)}\n`);

  if (sig.length) {
    console.log(`  ${bold('需要你看一眼的：')}\n`);
    for (const r of sig) {
      console.log(`  ${cyan(`[${r.signals.join('/')}]`)} ${r.subject.slice(0, 60)}`);
      console.log(`    ${dim(r.from.slice(0, 64))}`);
    }
    console.log('');
  } else {
    console.log(dim('  没有检出需要动作的邮件。\n'));
  }

  console.log(dim('  分类靠标题与发件人的关键词匹配，不理解邮件内容 ——'));
  console.log(dim('  可能漏掉标题里没线索的邮件。仅供参考。\n'));

  if (args.includes('--push')) {
    const webhook = getEnv('FEISHU_WEBHOOK_URL');
    if (!webhook) {
      console.error(`${red('✗')} 没有 FEISHU_WEBHOOK_URL，推不了。`);
      process.exit(2);
    }
    const r = await sendNotify({
      body: digest,
      title: `未读盘点：${sig.length} 封需要动作`,
      webhook,
      secret: getEnv('FEISHU_WEBHOOK_SECRET') || null,
    });
    if (!r.ok) {
      console.error(`${red('✗')} 推送失败：${r.detail || r.reason}`);
      process.exit(1);
    }
    console.log(`${green('✓')} 汇总已推到手机${r.truncated ? dim('（内容被截断）') : ''}\n`);
  }
}
