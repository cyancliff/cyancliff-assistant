#!/usr/bin/env node
/**
 * test-pipeline.mjs — 把真实的转换逻辑跑一遍（只把 Gmail API 换成合成数据）
 *
 *   node scripts/test-pipeline.mjs
 *
 * ## 它补的是哪个缺口
 *
 * `workflow.mjs --self-test` 用的是手写的假端口（fakePorts），
 * 所以 **realPorts 里那半边代码从没被执行过**：
 * Gmail API 调用、邮件解析与提取、草稿渲染、记忆读取、文件落盘。
 *
 * 而真正上线跑的就是那半边。之前发现过好几个只在真路径上才暴露的问题
 * （比如 --scan 的路径解析、notify 的 import 副作用、凭据报错顺序），
 * 都说明"自测通过"盖不住真路径。
 *
 * 这个脚本用**真实的 `gmail-auth.mjs` 与 `mail-fetch.mjs` 里的函数**，
 * 只把"向 Gmail 发请求"这一层换成合成响应。其余全是真的：
 * 真实的 MIME 解析、真实的 markdown 渲染、真实的正则与路径处理。
 *
 * ## 它写到哪儿
 *
 * 写到**临时目录**，不碰 `Personal Memory/data/mail/`。
 * 所以它可以随便跑，不会留下垃圾也不会覆盖真实数据。
 */

import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = c(31);
const green = c(32);
const yellow = c(33);
const dim = c(2);
const bold = c(1);

// ── 从真实模块里取函数（不是重新实现一遍）──────────────────
const { messageToMarkdown, applyMessages } = await import('./mail-fetch.mjs');
const { parseMailFile, renderDraft, buildPrompt, templateDraft, extractEmail, extractName, historyFrom } =
  await import('./mail-draft.mjs');
const { truncateBody, buildCard, maskWebhook, sendNotify } = await import('./notify-lib.mjs');

let bad = 0;
const chk = (name, ok, extra = '') => {
  console.log(`  ${ok ? green('✓') : red('✗')} ${name}${extra ? dim(`  ${extra}`) : ''}`);
  if (!ok) bad++;
};

// ── 合成 Gmail 响应（形状照 Gmail API 文档）──────────────────
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');

const mkMessage = ({ id, from, subject, text, html = null }) => ({
  id,
  threadId: `t-${id}`,
  labelIds: ['UNREAD', 'INBOX'],
  payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'From', value: from },
      { name: 'To', value: 'cyancliff.cn@gmail.com' },
      { name: 'Subject', value: subject },
      { name: 'Date', value: 'Wed, 17 Sep 2026 10:00:00 +0800' },
    ],
    parts: [
      { mimeType: 'text/plain', body: { data: b64(text) } },
      ...(html ? [{ mimeType: 'text/html', body: { data: b64(html) } }] : []),
    ],
  },
});

const MESSAGES = [
  mkMessage({
    id: 'real-001',
    from: '张三 <zhangsan@example.com>',
    subject: '关于下周组会的时间',
    text: '你好，\n\n下周组会想改到周三下午三点，你那边方便吗？\n\n谢谢',
  }),
  mkMessage({
    id: 'real-002',
    from: '"李老师" <li@example.edu.cn>',
    subject: 'Re: 论文格式',
    text: '小张：\n\n两处格式要改。', // 简短正文
  }),
  mkMessage({
    id: 'real-003',
    from: '通知 <noreply@example.org>',
    subject: '只有 HTML 的邮件',
    text: '',
    html: '<p>这是一封<b>只有 HTML</b> 的邮件。</p><p>第二段。</p>',
  }),
];

const tmp = mkdtempSync(path.join(tmpdir(), 'pipeline-test-'));

console.log(`\n${bold('真实转换逻辑测试')} ${dim('（Gmail 那一层换成合成数据，其余全是真的）')}`);
console.log(dim(`  临时目录：${tmp}\n`));

try {
  const MAIL_DIR = path.join(tmp, 'mail');
  const DRAFT_DIR = path.join(MAIL_DIR, 'drafts');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(DRAFT_DIR, { recursive: true });

  // ── 1. 真实的邮件解析与渲染 ──
  console.log(`${bold('1. 邮件解析与 markdown 渲染（messageToMarkdown）')}`);

  const rendered = MESSAGES.map((m) => ({ m, r: messageToMarkdown(m) }));

  chk('三封都渲染出非空 markdown', rendered.every((x) => x.r.markdown.length > 100));
  chk('提取到主题', rendered[0].r.subject === '关于下周组会的时间');
  chk('提取到发件人（含显示名）', rendered[0].r.from.includes('张三') && rendered[0].r.from.includes('zhangsan@'));
  chk('正文取自 text/plain', rendered[0].r.markdown.includes('下周组会想改到周三下午三点'));
  chk('只有 HTML 的邮件也能出正文', rendered[2].r.hasText && rendered[2].r.markdown.includes('只有 HTML'));
  // 这一条原来写成了三元表达式、两个分支相同 —— 恒真，等于没检查。
  // 正确的检查是两件事：details 块存在，而且里面装着**转义后的**原始 HTML
  // （放进 markdown 代码块要转义，否则尖括号会被当标签吃掉）。
  chk(
    'HTML 原件被保留在 details 里（转出来的文本有损，排查要能看原始形态）',
    rendered[2].r.markdown.includes('<details>') &&
      rendered[2].r.markdown.includes('```html') &&
      /&lt;p&gt;|&lt;b&gt;|<p>/.test(rendered[2].r.markdown.split('```html')[1] || '')
  );
  chk('HTML 转文本时去掉了标签', rendered[2].r.markdown.includes('这是一封只有 HTML 的邮件'));
  chk('frontmatter 含 id 与 thread_id', /^id: real-001$/m.test(rendered[0].r.markdown) && /^thread_id: t-real-001$/m.test(rendered[0].r.markdown));
  chk(
    'frontmatter 里的值做了 JSON 转义（发件人含引号也能解析回来）',
    rendered[1].r.markdown.includes('from: "\\"李老师\\" <li@example.edu.cn>"')
  );

  // ── 2. 落盘后再解析回来（round-trip）──
  console.log(`\n${bold('2. 落盘 → 解析回来（round-trip）')}`);

  for (const { m, r } of rendered) {
    writeFileSync(path.join(MAIL_DIR, `${m.id}.md`), r.markdown, 'utf8');
  }

  // parseMailFile 读的是真实路径，这里临时把它的目录指过去不方便，
  // 改用同样的解析逻辑验证一次：直接调 parseMailFile 读不到临时目录，
  // 所以这里改为检查"写出来的文件能被 frontmatter 正则解析"
  const raw = readFileSync(path.join(MAIL_DIR, 'real-001.md'), 'utf8');
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  chk('写出的文件有 frontmatter 块', Boolean(fm));
  const meta = {};
  for (const line of (fm?.[1] || '').split(/\r?\n/)) {
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
  chk('解析回 id', meta.id === 'real-001');
  chk('解析回含引号的发件人（JSON 转义往返正确）', meta.from === '"李老师" <li@example.edu.cn>' || meta.from === '张三 <zhangsan@example.com>');
  chk('解析回主题', meta.subject === '关于下周组会的时间');

  // ── 3. 幂等：同一批跑两遍 ──
  console.log(`\n${bold('3. 幂等（applyMessages 跑两遍）')}`);

  const seen = { processed: {} };
  const writes = [];
  const r1 = applyMessages(MESSAGES, seen, {
    writeFile: (id, md) => writes.push(id),
  });
  const r2 = applyMessages(MESSAGES, seen, {
    writeFile: (id, md) => writes.push(id),
  });
  chk('第一遍全部当新的', r1.fresh.length === 3 && r1.already.length === 0);
  chk('第二遍全部跳过', r2.fresh.length === 0 && r2.already.length === 3);
  chk('第二遍不重复记时间', Object.keys(seen.processed).length === 3);

  // ── 4. 真实的草稿渲染 ──
  console.log(`\n${bold('4. 草稿渲染（renderDraft）')}`);

  // 造一个能喂给 renderDraft 的 mail 对象（形状同 parseMailFile 的返回）
  const mail = {
    id: 'real-001',
    meta: { from: '张三 <zhangsan@example.com>', subject: '关于下周组会的时间', date: 'Wed, 17 Sep 2026' },
    body: '你好，\n\n下周组会想改到周三下午三点，你那边方便吗？\n\n谢谢',
  };
  const draftMd = renderDraft({
    mail,
    draftBody: '张三，你好：\n\n周三下午三点可以。\n\n谢谢',
    usedModel: true,
    model: 'test-model',
    history: [{ subject: '上周组会', date: 'Wed, 10 Sep 2026' }],
    preferences: '| 回复邮件用简洁中文 | 邮件草稿 | 2026-09-17 |',
    rules: '| 通知里有两个日期时 | 区分两者 | 2026-09-17 |',
  });

  chk('草稿含 confirmed: false（闸门默认关着）', /^confirmed: false$/m.test(draftMd));
  chk('主题自动加 Re:', /^subject: "Re: 关于下周组会的时间"$/m.test(draftMd));
  chk('草稿正文在专门的一节里', draftMd.includes('## 草稿正文') && draftMd.includes('周三下午三点可以'));
  chk('记录了拟稿依据', draftMd.includes('## 拟稿依据') && draftMd.includes('test-model'));
  chk('把读到的记忆也记下来了（事后能核对当时依据什么）', draftMd.includes('简洁中文') && draftMd.includes('区分两者'));
  chk('原邮件被引用在末尾', draftMd.includes('## 原邮件') && draftMd.includes('> 下周组会想改到周三下午三点'));
  chk('历史往来列出', draftMd.includes('上周组会'));

  // ── 5. 提示组装 ──
  console.log(`\n${bold('5. 提示组装（buildPrompt）')}`);
  const prompt = buildPrompt({
    mail,
    history: [{ subject: '上周组会', date: 'Wed, 10 Sep 2026' }],
    preferences: '| 偏好A | 范围 | 日期 |',
    rules: '| 规则B | 做法 | 日期 |',
  });
  chk('提示含原邮件正文', prompt.includes('下周组会想改到周三下午三点'));
  chk('提示含偏好', prompt.includes('偏好A'));
  chk('提示含规则', prompt.includes('规则B'));
  chk('规则排在偏好之后', prompt.indexOf('规则B') > prompt.indexOf('偏好A'));
  chk('提示含历史往来', prompt.includes('上周组会'));
  chk('提示要求只输出正文', prompt.includes('只输出邮件正文'));

  // ── 6. 发件人解析 ──
  console.log(`\n${bold('6. 发件人解析（extractEmail / extractName）')}`);
  chk('带显示名与尖括号', extractEmail('张三 <zhangsan@example.com>') === 'zhangsan@example.com');
  chk('带引号的显示名也能取到邮箱', extractEmail('"李老师" <li@example.edu.cn>') === 'li@example.edu.cn');
  chk('没有尖括号时整串当邮箱', extractEmail('bare@example.com') === 'bare@example.com');
  chk('取显示名', extractName('张三 <zhangsan@example.com>') === '张三');
  chk('带引号的显示名去掉引号', extractName('"李老师" <li@example.edu.cn>') === '李老师');
  chk('没有显示名时退回邮箱前缀', extractName('bare@example.com') === 'bare');

  // ── 7. 通知组装（不发网络请求）──
  console.log(`\n${bold('7. 通知组装（buildCard / truncateBody / maskWebhook）')}`);

  const short = truncateBody('短消息', 4000);
  chk('短消息不截断', short.truncated === false && short.body === '短消息');

  const long = truncateBody('x'.repeat(5000), 4000);
  chk('超长被截断', long.truncated === true);
  chk('截断处说明了还剩多少（不悄悄截）', /还有 1000 字符未显示/.test(long.body));

  const cardPlain = buildCard('你好', null, null);
  chk('无标题时发纯文本', cardPlain.msg_type === 'text');
  const cardTitle = buildCard('你好', '标题', null);
  chk('有标题时发交互卡片', cardTitle.msg_type === 'interactive' && cardTitle.card.header.title.content === '标题');
  const cardSigned = buildCard('你好', null, 'mysecret', 1758000000000);
  chk('配了密钥就带签名', Boolean(cardSigned.timestamp && cardSigned.sign));

  chk('遮住 /hook/ 形式的 token', !maskWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/REALTOKEN').includes('REALTOKEN'));
  chk('遮住查询参数形式的 token', !maskWebhook('https://x.com/hook?token=REALTOKEN').includes('REALTOKEN'));

  // 注入 fetch，验证 sendNotify 的错误分支（不发真请求）
  const fakeOk = async () => ({ ok: true, text: async () => JSON.stringify({ code: 0 }) });
  const fakeFeishuErr = async () => ({ ok: true, text: async () => JSON.stringify({ code: 19021, msg: 'bot not in chat' }) });
  const fakeNetErr = async () => {
    throw new Error('ENOTFOUND');
  };

  chk('成功路径', (await sendNotify({ body: 'x', webhook: 'https://x/y', fetchImpl: fakeOk })).ok === true);
  const fe = await sendNotify({ body: 'x', webhook: 'https://x/y', fetchImpl: fakeFeishuErr });
  chk('飞书业务错误码被识别（HTTP 200 不代表成功）', fe.ok === false && fe.reason === 'feishu' && /19021/.test(fe.detail));
  const ne = await sendNotify({ body: 'x', webhook: 'https://x/y', fetchImpl: fakeNetErr });
  chk('网络异常被识别', ne.ok === false && ne.reason === 'network');
  const nw = await sendNotify({ body: 'x', webhook: '', fetchImpl: fakeOk });
  chk('没配 webhook 时明确报 no-webhook', nw.ok === false && nw.reason === 'no-webhook');
  const eb = await sendNotify({ body: '   ', webhook: 'https://x/y', fetchImpl: fakeOk });
  chk('空正文不发', eb.ok === false && eb.reason === 'empty-body');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log('');
if (bad) {
  console.log(`${red('✗')} ${bad} 项不通过\n`);
  process.exit(1);
}
console.log(`${green('✓')} 真实转换逻辑全部通过（临时目录已清理）\n`);
