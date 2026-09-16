#!/usr/bin/env node
/**
 * workflow.mjs — 能力组合：把个人数据库、飞书通知、邮件串成一条流程
 *
 *   node scripts/workflow.mjs mail:inbox              看有哪些未处理的邮件
 *   node scripts/workflow.mjs mail:prepare            取信 + 拟草稿 + 推到手机
 *   node scripts/workflow.mjs mail:finish <id>        确认并发送（需要先 --confirm）
 *   node scripts/workflow.mjs mail:status             整条链的状态
 *   node scripts/workflow.mjs --self-test             用合成数据端到端验证（不需要凭据）
 *
 * ## 这条流程就是课程要的"能力组合"
 *
 *   收到一封需要回复的邮件
 *     → C1 取信
 *     → A  检索个人资料与同发件人历史往来
 *     → C2 拟草稿
 *     → B  推到手机
 *     →     你确认
 *     → C3 发送
 *     → C4 归档回个人数据库
 *
 * ## 为什么写成"端口可注入"
 *
 * 真实的取信、拟稿、通知、发送都需要凭据。如果编排直接调那些脚本，
 * **凭据没配之前这条链一行都跑不了** —— 也就没法验证它到底通不通。
 *
 * 所以核心逻辑 `runMailWorkflow` 只依赖一组函数（ports），
 * 真实端口和合成端口都从外面传进来。`--self-test` 用合成端口跑完整流程，
 * 这样"编排对不对"和"凭据有没有"是两件分开验证的事。
 *
 * ## 确认不由这个脚本做
 *
 * `mail:prepare` 到最后只把草稿推到你手机上，**不会自己确认、更不会自己发送**。
 * 确认必须来自外部（你在手机上/对话里说"发"），然后 `mail:finish` 才走发送。
 *
 * 理由：如果编排能自己确认再自己发送，那道闸门就形同虚设 ——
 * 而这个脚本会跑在无人值守的场景里。
 */

import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_ROOT, getEnv, ENV_PATH, gmailFetch, readToken, credentialsPath } from './gmail-auth.mjs';
import { sendNotify } from './notify-lib.mjs';
import { parseMailFile, buildPrompt, templateDraft, findApiKey, callModel, renderDraft, draftPath, historyFrom, extractEmail } from './mail-draft.mjs';
import { readDraft, readConfirm, writeConfirm, setFrontmatter, bodyHash } from './mail-send.mjs';
import { applyMessages, loadSeenFile, saveSeenFile } from './mail-fetch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = c(31);
const green = c(32);
const yellow = c(33);
const cyan = c(36);
const dim = c(2);
const bold = c(1);

const MAIL_DIR = path.join(DATA_ROOT, 'data', 'mail');
const DRAFT_DIR = path.join(MAIL_DIR, 'drafts');

// ── 分步函数（每步单独可测）────────────────────────────────────

/**
 * 第一步：取新邮件（幂等）。
 *
 * ports.fetchMessages(query, limit) → 邮件 stub 列表 [{id}]
 * ports.fetchMessage(id)            → 邮件对象
 */
export async function stepFetch({ ports, query, limit, dryRun = false }) {
  const stubs = await ports.fetchMessages(query, limit);
  if (!stubs.length) return { phase: 'fetch', ok: true, count: 0, fresh: [], already: [] };

  const full = [];
  for (const s of stubs) full.push(await ports.fetchMessage(s.id));

  const seen = ports.loadSeen();
  const r = applyMessages(full, seen, {
    dryRun,
    writeFile: (id, md) => ports.writeMail(id, md),
  });
  if (!dryRun) ports.saveSeen(seen);

  return { phase: 'fetch', ok: true, count: full.length, fresh: r.fresh, already: r.already };
}

/**
 * 第二步：为每封新邮件拟草稿。
 *
 * 这里**同时用到 A 和 C2**：历史往来来自个人数据库（data/mail 里同发件人的
 * 旧邮件），语气偏好与纠正规则来自 memory/。
 *
 * ports.draftFor(id, { mail, history, preferences, rules }) → 草稿正文
 */
export async function stepPrepare({ ports, ids, dryRun = false }) {
  const prepared = [];
  const failed = [];

  for (const id of ids) {
    const mail = ports.parseMail(id);
    if (!mail) {
      failed.push({ id, why: '找不到邮件' });
      continue;
    }
    try {
      const context = ports.buildContext(mail);
      const draftBody = await ports.draftFor(id, { mail, ...context });
      if (!draftBody || !draftBody.trim()) throw new Error('草稿是空的');
      if (!dryRun) ports.writeDraft(id, { mail, draftBody, ...context });
      prepared.push({ id, subject: String(mail.meta.subject || ''), chars: draftBody.trim().length });
    } catch (err) {
      failed.push({ id, why: err.message });
    }
  }

  return { phase: 'prepare', ok: failed.length === 0, prepared, failed };
}

/**
 * 第三步：把草稿推到手机。
 *
 * **只推不确认。** 确认要来自外部 —— 见文件头部的说明。
 */
export async function stepNotify({ ports, prepared, dryRun = false }) {
  const results = [];
  for (const p of prepared) {
    const draft = ports.readDraft(p.id);
    if (!draft) {
      results.push({ id: p.id, ok: false, why: '草稿不在' });
      continue;
    }
    const body =
      `**待确认回复**\n\n` +
      `收件人：${draft.fm.to || '(无)'}\n` +
      `主题：${draft.fm.subject || '(无)'}\n\n` +
      `---\n\n${draft.body.trim()}\n\n` +
      `---\n\n` +
      `确认后运行：\n\`node scripts/workflow.mjs mail:finish ${p.id} --confirm\``;

    try {
      const r = await ports.notify({ body, title: `待确认：${p.subject || p.id}` });
      results.push({ id: p.id, ok: r.ok, why: r.ok ? null : (r.detail || r.reason) });
    } catch (err) {
      results.push({ id: p.id, ok: false, why: err.message });
    }
  }
  return { phase: 'notify', ok: results.every((r) => r.ok), results };
}

/**
 * 第四步：发送已确认的草稿。
 *
 * **要求草稿已经是被确认过的**（确认记录存在且摘要一致）。
 * 这个函数自己不写确认记录 —— 那是外面 `--confirm` 的事。
 */
export async function stepFinish({ ports, ids, dryRun = false }) {
  const results = [];
  for (const id of ids) {
    const draft = ports.readDraft(id);
    if (!draft) {
      results.push({ id, ok: false, why: '找不到草稿' });
      continue;
    }
    if (draft.fm.sent_at) {
      results.push({ id, ok: false, why: `已经发过了（${draft.fm.sent_at}）` });
      continue;
    }
    const rec = ports.readConfirm(id);
    if (!rec) {
      results.push({ id, ok: false, why: '还没确认 —— 闸门 1 拦住' });
      continue;
    }
    if (ports.bodyHash(draft.body) !== rec.body_sha256) {
      results.push({ id, ok: false, why: '正文在确认后被改过 —— 闸门 2 拦住' });
      continue;
    }
    if (dryRun) {
      results.push({ id, ok: true, wouldSend: true, to: draft.fm.to });
      continue;
    }
    try {
      const sent = await ports.send({ draft, rec });
      results.push({ id, ok: true, messageId: sent.id });
    } catch (err) {
      results.push({ id, ok: false, why: err.message });
    }
  }
  return { phase: 'finish', ok: results.every((r) => r.ok), results };
}

/** 串起来跑。dryRun 时最后一步只报告不发送。 */
export async function runMailWorkflow({ ports, query, limit, dryRun = false, finishIds = [] }) {
  const steps = [];
  const fetch = await stepFetch({ ports, query, limit, dryRun });
  steps.push(fetch);

  const toPrepare = fetch.fresh;
  if (toPrepare.length) {
    const prep = await stepPrepare({ ports, ids: toPrepare, dryRun });
    steps.push(prep);
    if (prep.prepared.length) {
      steps.push(await stepNotify({ ports, prepared: prep.prepared, dryRun }));
    }
  }

  if (finishIds.length) {
    steps.push(await stepFinish({ ports, ids: finishIds, dryRun }));
  }

  return { steps, ok: steps.every((s) => s.ok !== false) };
}

// ── 真实端口 ──────────────────────────────────────────────────
export function realPorts() {
  return {
    fetchMessages: async (query, limit) => {
      const r = await gmailFetch(`/users/me/messages?maxResults=${limit}&q=${encodeURIComponent(query)}`);
      return r.messages || [];
    },
    fetchMessage: (id) => gmailFetch(`/users/me/messages/${id}?format=full`),
    loadSeen: () => loadSeenFile(),
    saveSeen: (seen) => saveSeenFile(seen),
    readConfirm: (id) => readConfirm(id),
    bodyHash: (body) => bodyHash(body),
    writeMail: (id, md) => {
      mkdirSync(MAIL_DIR, { recursive: true });
      writeFileSync(path.join(MAIL_DIR, `${id}.md`), md, 'utf8');
    },
    parseMail: (id) => parseMailFile(id),
    buildContext: (mail) => {
      const sender = extractEmail(mail.meta.from);
      return {
        history: historyFrom(sender, mail.id),
        preferences: readMemoryFile('preferences.md'),
        rules: readMemoryFile('rules.md'),
      };
    },
    draftFor: async (id, ctx) => {
      const apiKey = findApiKey();
      if (!apiKey) throw new Error('没有模型密钥（ASSISTANT_MODEL_API_KEY / CMDGOAT_API_KEY）');
      const baseUrl = getEnv('ASSISTANT_MODEL_BASE_URL') || 'https://api.commandcode.ai/provider/v1';
      const model = getEnv('ASSISTANT_MODEL_NAME') || 'deepseek/deepseek-v4.1-flash';
      return callModel(buildPrompt(ctx), { apiKey, baseUrl, model });
    },
    writeDraft: (id, { mail, draftBody, history, preferences, rules }) => {
      mkdirSync(DRAFT_DIR, { recursive: true });
      writeFileSync(
        draftPath(id),
        renderDraft({ mail, draftBody, usedModel: true, model: getEnv('ASSISTANT_MODEL_NAME') || 'deepseek/deepseek-v4.1-flash', history, preferences, rules }),
        'utf8'
      );
    },
    readDraft: (id) => readDraft(id),
    notify: ({ body, title }) =>
      sendNotify({ body, title, webhook: getEnv('FEISHU_WEBHOOK_URL'), secret: getEnv('FEISHU_WEBHOOK_SECRET') || null }),
    send: async ({ draft }) => {
      if (!existsSync(credentialsPath())) throw new Error(`没有 Gmail 凭据：${credentialsPath()}`);
      if (!readToken()) throw new Error('没有授权令牌，先跑 gmail-auth.mjs --auth');
      const mime = [
        `To: ${draft.fm.to}`,
        `Subject: ${draft.fm.subject}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'MIME-Version: 1.0',
        '',
        draft.body.trim(),
        '',
      ].join('\r\n');
      const sent = await gmailFetch('/users/me/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: Buffer.from(mime, 'utf8').toString('base64url') }),
      });
      setFrontmatter(readDraft(draft.id), { sent_at: new Date().toISOString(), sent_message_id: sent.id });
      return sent;
    },
  };
}

function readMemoryFile(name) {
  const f = path.join(DATA_ROOT, 'memory', name);
  if (!existsSync(f)) return '';
  return readFileSync(f, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('|') && !l.includes('（示例'))
    .filter((l) => !/^\|\s*(偏好|场景)\s*\|/.test(l) && !/^\|[\s\-:|]+\|$/.test(l))
    .join('\n')
    .trim();
}

// ── 合成端口（自测用）──────────────────────────────────────────
/**
 * 一组不碰网络、不碰真实邮箱的端口。
 *
 * 用它跑完整流程，就验证了**编排逻辑本身**（顺序、幂等、闸门、
 * 失败时不继续往下走）。凭据有没有是另一回事。
 */
export function fakePorts({ mailCount = 2, notifyFails = false, sendFails = false, draftFails = [] } = {}) {
  const mails = new Map();
  const drafts = new Map();
  const confirms = new Map();
  const sent = [];
  const notified = [];
  const state = { saveSeenCalls: 0 };
  let seen = { processed: {} };

  const mkPayload = (id, subject, from) => ({
    id,
    threadId: `t-${id}`,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: 'me@example.com' },
        { name: 'Subject', value: subject },
        { name: 'Date', value: 'Wed, 17 Sep 2026 10:00:00 +0800' },
      ],
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: Buffer.from(`${subject} 的正文。\n请回复。`, 'utf8').toString('base64url') },
        },
      ],
    },
  });

  const all = [];
  for (let i = 1; i <= mailCount; i++) {
    const id = `fake-${String(i).padStart(3, '0')}`;
    all.push({ id, subject: `第 ${i} 封来信`, from: i === 1 ? '同一人 <same@example.com>' : `某人${i} <p${i}@example.com>` });
  }

  return {
    _state: {
      mails,
      drafts,
      confirms,
      sent,
      notified,
      state,
      get seen() {
        return seen;
      },
      get saveSeenCalls() {
        return state.saveSeenCalls;
      },
      all,
    },
    /** 测试用：把某份草稿记为已确认（等价于人在外面点了确认）。 */
    _confirm(id, via = 'test') {
      const d = drafts.get(id);
      if (!d) throw new Error(`没找到草稿 ${id}`);
      confirms.set(id, {
        draft: id,
        confirmed_at: new Date().toISOString(),
        via,
        body_sha256: bodyHash(d.body),
        body_chars: d.body.trim().length,
      });
    },
    /** 测试用：确认之后偷改正文 —— 闸门 2 要能发现。 */
    _tamper(id, newBody) {
      const d = drafts.get(id);
      if (!d) throw new Error(`没找到草稿 ${id}`);
      d.body = newBody;
    },
    fetchMessages: async () => all.map((m) => ({ id: m.id })),
    fetchMessage: async (id) => {
      const m = all.find((x) => x.id === id);
      return mkPayload(id, m.subject, m.from);
    },
    loadSeen: () => seen,
    saveSeen: (s) => {
      state.saveSeenCalls++;
      seen = s;
    },
    readConfirm: (id) => confirms.get(id) || null,
    bodyHash: (body) => bodyHash(body),
    writeMail: (id, md) => mails.set(id, md),
    parseMail: (id) => {
      const md = mails.get(id);
      if (!md) return null;
      const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      const meta = {};
      for (const line of (m?.[1] || '').split(/\r?\n/)) {
        const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
        if (kv) {
          let v = kv[2].trim();
          if (v.startsWith('"')) {
            try {
              v = JSON.parse(v);
            } catch {
              v = v.slice(1, -1);
            }
          }
          meta[kv[1]] = v;
        }
      }
      const bodyM = md.match(/\r?\n---\r?\n\r?\n([\s\S]*?)(?:\r?\n<details>|$)/);
      return { id, meta, body: (bodyM ? bodyM[1] : '').trim() };
    },
    buildContext: () => ({ history: [], preferences: '', rules: '' }),
    draftFor: async (id) => {
      if (draftFails.includes(id)) throw new Error('合成：这一步故意失败');
      return `合成草稿：回复 ${id}。`;
    },
    writeDraft: (id, { mail, draftBody, history, preferences, rules }) => {
      drafts.set(id, {
        id,
        fm: {
          in_reply_to: id,
          to: mail.meta.from,
          subject: `Re: ${mail.meta.subject}`,
          generated_by: 'model:fake',
          confirmed: false,
        },
        body: draftBody,
        history,
        preferences,
        rules,
      });
    },
    readDraft: (id) => {
      const d = drafts.get(id);
      if (!d) return null;
      return { ...d, fm: { ...d.fm } };
    },
    // 让 setFrontmatter 能作用到合成草稿上（stepFinish 里发送成功后会调）
    _setDraftFm: (id, updates) => {
      const d = drafts.get(id);
      if (d) Object.assign(d.fm, updates);
    },
    notify: async ({ body, title }) => {
      notified.push({ body, title });
      if (notifyFails) return { ok: false, reason: 'network', detail: '合成：推送失败' };
      return { ok: true, chars: body.length };
    },
    send: async ({ draft }) => {
      if (sendFails) throw new Error('合成：发送失败');
      const id = `sent-${draft.id}`;
      sent.push({ id: draft.id, messageId: id });
      return { id };
    },
  };
}

// ── CLI ───────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const cmd = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const limit = Number((args[args.indexOf('--limit') + 1] || '').match(/^\d+$/)?.[0] || 25);

  // --help 只在**既没给命令、也没给 --self-test** 时才显示。
  // 光是 `!cmd` 判断的话，`--self-test` 这类不带命令的用法会被 help 抢走。
  if (args.includes('--help') || args.includes('-h') || (!cmd && !args.includes('--self-test'))) {
    console.log(`${bold('workflow.mjs')} — 能力组合

  mail:inbox           看有哪些未处理的邮件
  mail:prepare         取信 + 拟草稿 + 推到手机（不会自己确认）
  mail:finish <id>     发送已确认的草稿
  mail:status          整条链的状态
  --self-test          用合成数据端到端验证（不需要凭据）
  --dry-run            走流程但不写不发的部分照常，最后一步只报告

  ${dim('确认必须来自外部：先在手机上（或对话里）说"发"，再跑 mail:finish。')}
  ${dim('编排自己确认再自己发送的话，那道闸门就形同虚设。')}
`);
    process.exit(0);
  }

  // ── 自测：合成端口跑完整流程 ──
  if (args.includes('--self-test')) {
    console.log(`\n${bold('能力组合自测')} ${dim('（合成数据，不碰网络也不碰真实邮箱）')}\n`);
    let bad = 0;
    const chk = (name, ok, extra = '') => {
      console.log(`  ${ok ? green('✓') : red('✗')} ${name}${extra ? dim(`  ${extra}`) : ''}`);
      if (!ok) bad++;
    };

    // 1) 第一次跑：两封新邮件，应当都被处理并推送
    const p1 = fakePorts({ mailCount: 2 });
    const r1 = await runMailWorkflow({ ports: p1, query: 'is:unread', limit: 25 });
    const fetch1 = r1.steps.find((s) => s.phase === 'fetch');
    const prep1 = r1.steps.find((s) => s.phase === 'prepare');
    const noti1 = r1.steps.find((s) => s.phase === 'notify');
    chk('第一次：取到 2 封新的', fetch1.fresh.length === 2);
    chk('第一次：拟出 2 份草稿', prep1.prepared.length === 2);
    chk('第一次：推了 2 条通知', noti1.results.length === 2 && noti1.results.every((x) => x.ok));
    chk('通知里不含"已确认"字样（只推不确认）', !noti1.results.some((x) => /已确认/.test(x.why || '')));

    // 2) 第二次跑：同一批邮件，幂等应当一封都不重处理
    //
    // 这里**不能只检查 stepFetch 报告的数字** —— 那只是 fetch 自己的账。
    // 实测：把编排里的 `toPrepare = fetch.fresh` 改成 `fresh.concat(already)`
    // 之后，fetch 仍然报 fresh=0、already=2，自测照样通过，
    // 但草稿和通知实际上都被重做了一遍。
    // 所以还要检查编排**实际做了什么**：草稿数没涨、通知没重发。
    const draftsBefore = p1._state.drafts.size;
    const notifiedBefore = p1._state.notified.length;
    const r2 = await runMailWorkflow({ ports: p1, query: 'is:unread', limit: 25 });
    const fetch2 = r2.steps.find((s) => s.phase === 'fetch');
    chk('第二次：fetch 报一封都不重处理', fetch2.fresh.length === 0 && fetch2.already.length === 2);
    chk(
      '第二次：草稿数没有增加',
      p1._state.drafts.size === draftsBefore,
      `${draftsBefore} → ${p1._state.drafts.size}`
    );
    chk(
      '第二次：没有重复推送通知',
      p1._state.notified.length === notifiedBefore,
      `${notifiedBefore} → ${p1._state.notified.length}`
    );

    // 3) 未确认就 finish：闸门 1 应当拦住
    const p3 = fakePorts({ mailCount: 1 });
    const r3a = await runMailWorkflow({ ports: p3, query: 'is:unread', limit: 25 });
    const fin3a = await stepFinish({ ports: p3, ids: ['fake-001'] });
    chk('未确认就 finish：被闸门 1 拦住', fin3a.results[0].ok === false && /还没确认/.test(fin3a.results[0].why));
    chk('未确认时没有真的发送', p3._state.sent.length === 0);

    // 4) 确认之后正文被改：闸门 2 应当拦住
    //
    // 这一条一开始漏了 —— 突变测试把 stepFinish 里的摘要检查改成恒假，
    // 自测照样通过。因为自测只走过"未确认"那条路，从没走到"已确认但正文变了"。
    const p4 = fakePorts({ mailCount: 1 });
    await runMailWorkflow({ ports: p4, query: 'is:unread', limit: 25 });
    p4._confirm('fake-001'); // 记为已确认
    p4._tamper('fake-001', '确认之后偷偷改掉的正文'); // 然后改正文
    const fin4 = await stepFinish({ ports: p4, ids: ['fake-001'] });
    chk(
      '确认后改正文：被闸门 2 拦住',
      fin4.results[0].ok === false && /被改过/.test(fin4.results[0].why),
      fin4.results[0].why || ''
    );
    chk('闸门 2 拦住时没有真的发送', p4._state.sent.length === 0);

    // 5) 取信阶段确实保存了 seen（幂等靠它跨会话生效）
    //
    // 一开始也没验这一条：突变测试把 saveSeen 调用删掉，自测照样通过 ——
    // 因为合成端口存的是对象引用，就地改了就"看起来"生效了。
    const p5 = fakePorts({ mailCount: 1 });
    await runMailWorkflow({ ports: p5, query: 'is:unread', limit: 25 });
    chk('取信后调用了 saveSeen', p5._state.saveSeenCalls === 1, `${p5._state.saveSeenCalls} 次`);

    const p6 = fakePorts({ mailCount: 1 });
    await runMailWorkflow({ ports: p6, query: 'is:unread', limit: 25, dryRun: true });
    chk('dry-run 时不写 seen', p6._state.saveSeenCalls === 0, `${p6._state.saveSeenCalls} 次`);

    console.log(`\n  ${bad ? red('✗') : green('✓')} ${bad ? `${bad} 项不通过` : '编排逻辑通过'}\n`);
    process.exit(bad ? 1 : 0);
  }

  // ── mail:inbox ──
  if (cmd === 'mail:inbox') {
    const { readdirSync } = await import('node:fs');
    const ids = existsSync(MAIL_DIR)
      ? readdirSync(MAIL_DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
      : [];
    console.log(`\n${bold('邮箱')}  ${dim(MAIL_DIR)}\n`);
    if (!ids.length) {
      console.log(dim('  一封都没有。先跑：node scripts/workflow.mjs mail:prepare\n'));
      process.exit(0);
    }
    for (const id of ids) {
      const d = readDraft(id);
      const state = d ? (d.fm.sent_at ? green('已发送') : readConfirm(id) ? green('已确认待发') : yellow('未确认')) : dim('无草稿');
      const m = parseMailFile(id);
      console.log(`  ${id}  ${state}  ${(m?.meta.subject || '').slice(0, 44)}`);
    }
    console.log('');
    process.exit(0);
  }

  // ── mail:status ──
  if (cmd === 'mail:status') {
    const seen = loadSeenFile();
    const processed = Object.keys(seen.processed || {}).length;
    const { readdirSync } = await import('node:fs');
    const drafts = existsSync(DRAFT_DIR) ? readdirSync(DRAFT_DIR).filter((f) => f.endsWith('.md')) : [];
    const confirmed = drafts.filter((f) => readConfirm(f.replace(/\.md$/, ''))).length;

    console.log(`\n${bold('整条链的状态')}\n`);
    console.log(`  ${bold('环境')}`);
    console.log(`    .env              ${existsSync(ENV_PATH) ? ENV_PATH : dim('（不存在）')}`);
    console.log(`    飞书 webhook      ${getEnv('FEISHU_WEBHOOK_URL') ? green('已配置') : yellow('未配置')}`);
    console.log(`    Gmail 凭据        ${existsSync(credentialsPath()) ? green('已就位') : yellow('未配置')}`);
    console.log(`    Gmail 令牌        ${readToken() ? green('已授权') : yellow('未授权')}`);
    console.log(`    模型密钥          ${findApiKey() ? green('已配置') : yellow('未配置')}`);
    console.log(`  ${bold('数据')}`);
    console.log(`    已处理邮件        ${processed} 封`);
    console.log(`    草稿              ${drafts.length} 份（已确认 ${confirmed} 份）`);
    console.log('');
    process.exit(0);
  }

  // ── mail:prepare ──
  if (cmd === 'mail:prepare') {
    // 前置检查：凭据不全时**先说清缺什么、去哪儿拿**，
    // 而不是让流程跑到取信那一步才抛一个指向错误方向的错。
    // （实测：缺客户端凭据时报的是"先跑 --auth"，而 --auth 自己也跑不了 ——
    //   因为客户端凭据根本还没放。）
    const missing = [];
    if (!existsSync(credentialsPath())) missing.push('Gmail API 凭据');
    if (!readToken()) missing.push('Gmail 授权令牌');
    if (!findApiKey()) missing.push('模型密钥');
    if (!getEnv('FEISHU_WEBHOOK_URL')) missing.push('飞书 webhook');

    // 前两项是硬阻塞：没有它们连信都取不到。
    // 模型密钥和飞书缺了只影响一部分，不该拦住整个流程。
    const hardBlocked = missing.includes('Gmail API 凭据') || missing.includes('Gmail 授权令牌');

    if (missing.length) console.log(`\n${yellow('还差这些配置：')} ${missing.join('、')}\n`);
    if (hardBlocked) {
      console.error(`${red('✗')} 取不了信，流程走不下去。\n`);
      console.error(`  看每一项怎么补：${bold('node scripts/setup.mjs')}\n`);
      process.exit(2);
    }
    if (missing.includes('模型密钥')) {
      console.log(dim('  没有模型密钥 —— 拟稿那一步会失败。想先看流程用合成数据：'));
      console.log(dim('    node scripts/mail-fetch.mjs --seed && node scripts/mail-draft.mjs <id> --template\n'));
    }
    if (missing.includes('飞书 webhook')) {
      console.log(dim('  没有飞书 webhook —— 草稿会写在本机，但推不到手机。\n'));
    }

    const ports = realPorts();
    const query = getEnv('GMAIL_QUERY') || 'is:unread';
    console.log(`${bold('取信 → 拟稿 → 推送')}  ${dim(query)}${dryRun ? dim('  (dry-run)') : ''}\n`);
    try {
      const r = await runMailWorkflow({ ports, query, limit, dryRun });
      for (const s of r.steps) {
        if (s.phase === 'fetch') console.log(`  取信      新 ${s.fresh.length}   已处理过 ${s.already.length}`);
        if (s.phase === 'prepare') {
          console.log(`  拟稿      ${s.prepared.length} 份`);
          for (const p of s.prepared) console.log(`    ${green('✓')} ${p.id}  ${p.chars} 字符`);
          for (const f of s.failed) console.log(`    ${red('✗')} ${f.id}  ${f.why}`);
        }
        if (s.phase === 'notify') {
          console.log(`  推送      ${s.results.filter((x) => x.ok).length}/${s.results.length}`);
          for (const x of s.results.filter((x) => !x.ok)) console.log(`    ${red('✗')} ${x.id}  ${x.why}`);
        }
      }
      console.log(`\n  ${dim('草稿已推到手机。确认后运行：')}`);
      console.log(`    node scripts/workflow.mjs mail:finish <id>\n`);
      process.exit(0);
    } catch (err) {
      console.error(`${red('✗')} 流程中断：${err.message}\n`);
      process.exit(1);
    }
  }

  // ── mail:finish ──
  if (cmd === 'mail:finish') {
    const id = args.filter((a) => !a.startsWith('--'))[1];
    if (!id) {
      console.error(`${red('✗')} 要指定草稿 id：node scripts/workflow.mjs mail:finish <id>`);
      process.exit(2);
    }

    // --confirm 是"这一步是人在确认"的记录，不是编排自己做的决定。
    // 没有它就不写确认记录 —— 闸门要求确认必须来自外部。
    if (args.includes('--confirm')) {
      const draft = readDraft(id);
      if (!draft) {
        console.error(`${red('✗')} 找不到草稿 ${id}`);
        process.exit(2);
      }
      const rec = writeConfirm(id, draft, 'workflow');
      setFrontmatter(readDraft(id), { confirmed: true });
      console.log(`\n${green('✓')} 已确认 ${id}  ${dim(`${rec.body_chars} 字符  摘要 ${rec.body_sha256.slice(0, 12)}…`)}`);
    }

    const ports = realPorts();
    const r = await stepFinish({ ports, ids: [id], dryRun });
    const res = r.results[0];
    if (res.ok) {
      console.log(`${green('✓')} ${dryRun ? '（dry-run，没有真发）' : '已发送'} ${id}${res.messageId ? `  ${dim(res.messageId)}` : ''}\n`);
      process.exit(0);
    }
    console.error(`${red('✗')} ${id}：${res.why}\n`);
    process.exit(1);
  }

  console.error(`${red('✗')} 不认识的命令：${cmd}。用 --help 看用法。`);
  process.exit(2);
}
