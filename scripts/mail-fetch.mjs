#!/usr/bin/env node
/**
 * mail-fetch.mjs — 从 Gmail 取新邮件，幂等落盘
 *
 *   node scripts/mail-fetch.mjs              # 取未读（默认）
 *   node scripts/mail-fetch.mjs --limit 10
 *   node scripts/mail-fetch.mjs --query "is:unread from:someone@example.com"
 *   node scripts/mail-fetch.mjs --all        # 连同已处理的也重新打印（但不重复写盘）
 *   node scripts/mail-fetch.mjs --dry-run    # 只看会处理哪些，不写任何东西
 *   node scripts/mail-fetch.mjs --status     # 已处理多少、最近几封
 *
 * ## 幂等是这一项能力的硬要求
 *
 * 课程原文：**重复检查邮箱不应重复处理或重复发送同一封邮件。**
 *
 * 幂等 key 用 Gmail 的 message id —— 它是 Gmail 分配的、跨会话稳定的标识。
 * 已处理的 id 记在 data/mail/seen.json。重复运行只会跳过，不会重写文件、
 * 更不会重新生成草稿。
 *
 * 为什么不按"内容哈希"去重：同一封信在 Gmail 里就是同一个 id，
 * 而内容可能因为 Gmail 规范化而略有差异。id 是更精确的键。
 * （真遇到 id 不稳定的情况再改，那时要有证据。）
 *
 * 邮件正文存 data/mail/<id>.md，**私有仓**，不进任何别的地方。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gmailFetch,
  getEnv,
  DATA_ROOT,
  ENV_PATH,
  readToken,
  credentialsPath,
  tokenPath,
} from './gmail-auth.mjs';
import { restartIfNeeded } from './proxy.mjs';

// 联网脚本：需要时先带代理开关重启一次自己（见 proxy.mjs 顶部说明）
restartIfNeeded();

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = c(31);
const green = c(32);
const yellow = c(33);
const dim = c(2);
const bold = c(1);

const MAIL_DIR = path.join(DATA_ROOT, 'data', 'mail');
const SEEN_PATH = path.join(MAIL_DIR, 'seen.json');

// ── 参数 ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--query', '--limit']);
const flagValue = (n) => {
  const i = args.indexOf(n);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};

const dryRun = args.includes('--dry-run');
const showAll = args.includes('--all');
const statusOnly = args.includes('--status');
const limit = Math.max(1, Number(flagValue('--limit')) || 25);
const query = flagValue('--query') || getEnv('GMAIL_QUERY') || 'is:unread';

// ── seen.json ─────────────────────────────────────────────────
/**
 * 形状：{ "processed": { "<id>": {"at": "...", "subject": "...", "from": "..."} } }
 *
 * 只存 id 和一点便于人看的元信息 —— 不存正文，正文在各自的 .md 里。
 * 两边都存会导致"改了哪个才是对的"这种问题。
 */
export function loadSeen() {
  if (!existsSync(SEEN_PATH)) return { processed: {} };
  try {
    const j = JSON.parse(readFileSync(SEEN_PATH, 'utf8'));
    if (!j.processed || typeof j.processed !== 'object') return { processed: {} };
    return j;
  } catch (e) {
    // 读坏了不要静默重建 —— 那会让"已处理"记录凭空消失，然后重复处理一遍。
    console.error(`${red('✗')} ${SEEN_PATH} 读不出来：${e.message}`);
    console.error(dim('  它记录了哪些邮件已处理过。修好它再跑，'));
    console.error(dim('  或者确认要重来一遍，再手动删掉这个文件。'));
    process.exit(2);
  }
}

/** 给 workflow.mjs 用的别名 —— 那两个名字更能说明它在读写文件。 */
export const loadSeenFile = loadSeen;

export function saveSeen(seen) {
  mkdirSync(MAIL_DIR, { recursive: true });
  writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2), 'utf8');
}

export const saveSeenFile = saveSeen;

// ── 解析邮件 ──────────────────────────────────────────────────
function header(msg, name) {
  const h = msg.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

/** 递归找正文。优先 text/plain —— HTML 里的标签会污染引用。 */
function extractBody(payload) {
  const out = { text: '', html: '' };

  const walk = (part) => {
    if (!part) return;
    const mime = part.mimeType || '';
    const data = part.body?.data;

    if (data) {
      const decoded = Buffer.from(data, 'base64url').toString('utf8');
      if (mime === 'text/plain' && !out.text) out.text = decoded;
      else if (mime === 'text/html' && !out.html) out.html = decoded;
    }
    for (const p of part.parts || []) walk(p);
  };

  walk(payload);
  return out;
}

/** 把 HTML 粗粗转成文本 —— 只为可读，不求保真。正文原文另存一份。 */
function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatAddress(v) {
  // "张三 <a@b.com>" → 保留原样，人看得懂；解析留给需要的时候
  return (v || '').replace(/\s+/g, ' ').trim();
}

/**
 * 把一封 Gmail message 对象渲染成 markdown。
 *
 * 导出是为了能被单独测（scripts/test-pipeline.mjs）——
 * 它是这一层里最容易出错的一段：MIME 是多层嵌套的，
 * text/plain 和 text/html 谁先谁后、只有 HTML 时怎么办，都是实测踩过的。
 */
export function messageToMarkdown(msg) {
  const body = extractBody(msg.payload);
  const text = body.text || (body.html ? htmlToText(body.html) : '');
  const from = formatAddress(header(msg, 'From'));
  const to = formatAddress(header(msg, 'To'));
  const subject = header(msg, 'Subject') || '(无主题)';
  const date = header(msg, 'Date');
  const listId = header(msg, 'List-Id');

  const lines = [
    '---',
    `id: ${msg.id}`,
    `thread_id: ${msg.threadId}`,
    `from: ${JSON.stringify(from)}`,
    `to: ${JSON.stringify(to)}`,
    `subject: ${JSON.stringify(subject)}`,
    `date: ${JSON.stringify(date)}`,
  ];
  if (listId) lines.push(`list_id: ${JSON.stringify(listId)}`);
  lines.push(
    `labels: ${JSON.stringify(msg.labelIds || [])}`,
    `fetched_at: ${new Date().toISOString()}`,
    '---',
    '',
    '<!-- 这是从 Gmail 取回的原始内容，不要手改。 -->',
    '<!-- 需要引用某一段时，用 library/ 之外的路径引用它没有意义 ——',
    '     它不在资料库里，不参与 cite-check。 -->',
    '',
    `# ${subject}`,
    '',
    `**发件人**：${from}  `,
    `**收件人**：${to}  `,
    `**日期**：${date}`,
    '',
    '---',
    '',
    text || '（没有可提取的文本正文 —— 可能只有附件或纯 HTML）',
    '',
  );

  // 原文另存：HTML 转出来的文本是有损的，排查时要能看到原始形态
  if (body.html) {
    lines.push('<details><summary>原始 HTML（截断到 20000 字符）</summary>', '', '```html');
    lines.push(body.html.slice(0, 20000));
    lines.push('```', '', '</details>', '');
  }

  return { markdown: lines.join('\n'), subject, from, date, hasText: Boolean(text) };
}

// ── 幂等核心 ──────────────────────────────────────────────────
/**
 * 把一批邮件应用进 seen 记录。**这是幂等逻辑的所在，被单独导出以便测试。**
 *
 * 为什么不在这里调 API：那样就没法验证幂等了 —— 而"重复检查不重复处理"
 * 是这一项能力的硬要求，不能只靠"看起来对"。
 *
 * @returns {{fresh: string[], already: string[], written: string[]}}
 */
export function applyMessages(messages, seen, { dryRun = false, writeFile = null } = {}) {
  const fresh = [];
  const already = [];
  const written = [];

  for (const msg of messages) {
    const parsed = messageToMarkdown(msg);
    const known = Boolean(seen.processed[msg.id]);

    if (known) already.push(msg.id);
    else fresh.push(msg.id);

    if (dryRun) continue;

    if (writeFile) writeFile(msg.id, parsed.markdown);
    written.push(msg.id);

    // 已经记过的**不覆盖记录时间** —— 那会让"第一次处理于何时"失真
    if (!known) {
      seen.processed[msg.id] = {
        at: new Date().toISOString(),
        subject: parsed.subject,
        from: parsed.from,
      };
    }
  }

  return { fresh, already, written };
}

// ── 主流程 ────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain && (args.includes('--help') || args.includes('-h'))) {
  console.log(`${bold('mail-fetch.mjs')} — 从 Gmail 取新邮件，幂等落盘

  node scripts/mail-fetch.mjs                    取未读（默认）
  node scripts/mail-fetch.mjs --limit 10
  node scripts/mail-fetch.mjs --query "is:unread from:某人@example.com"
  node scripts/mail-fetch.mjs --dry-run          只看会处理哪些，不写任何东西
  node scripts/mail-fetch.mjs --dummy            用合成邮件跑一遍幂等（不需要凭据）
  node scripts/mail-fetch.mjs --status           已处理多少、最近几封

  ${dim('幂等 key 是 Gmail 的 message id。重复运行会跳过已处理的，')}
  ${dim('不会重写文件、更不会重新生成草稿。')}

  ${dim('凭据：GMAIL_CREDENTIALS_PATH / GMAIL_TOKEN_PATH，见 .env.example')}
  ${dim('首次使用：node scripts/gmail-auth.mjs --auth')}
`);
  process.exit(0);
}

/**
 * --dummy：用合成邮件验证幂等，不需要任何凭据。
 *
 * 存在的理由：幂等是这一项能力的硬要求，而真实凭据要等用户配置。
 * 没有这个模式，那条要求就只能等接通之后才能验，中间一直是个假设。
 */
if (isMain && (args.includes('--dummy') || args.includes('--seed'))) {
  const seed = args.includes('--seed');
  const mk = (id, subject, from = '某人 <someone@example.com>', body = null) => ({
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
        {
          mimeType: 'text/plain',
          body: {
            data: Buffer.from(
              body || `这是 ${subject} 的正文。\n第二行。`,
              'utf8'
            ).toString('base64url'),
          },
        },
      ],
    },
  });

  if (seed) {
    mkdirSync(MAIL_DIR, { recursive: true });
    const fixtures = [
      mk(
        '__seed-001',
        '关于下周组会的时间',
        '张三 <zhangsan@example.com>',
        '你好，\n\n下周组会想改到周三下午三点，你那边方便吗？\n如果不行，周四上午也可以。\n\n谢谢'
      ),
      mk(
        '__seed-002',
        '论文格式的两处问题',
        '李老师 <li@example.edu.cn>',
        '小张：\n\n你发来的稿子我看了，有两处格式要改：\n1. 三线表的表头字号\n2. 参考文献的标点\n\n改完再发我。'
      ),
    ];
    const seedSeen = loadSeen();
    const r = applyMessages(fixtures, seedSeen, {
      writeFile: (id, md) => writeFileSync(path.join(MAIL_DIR, `${id}.md`), md, 'utf8'),
    });
    saveSeen(seedSeen);
    console.log(`\n${green('✓')} 已写入 ${r.fresh.length} 封合成邮件到 ${dim(MAIL_DIR)}`);
    for (const id of r.fresh) console.log(`    ${id}`);
    console.log(`\n  ${dim('试下游：')}`);
    console.log(`    node scripts/mail-draft.mjs --list`);
    console.log(`    node scripts/mail-draft.mjs __seed-001 --template`);
    console.log(`\n  ${dim('清理：删掉 data/mail/__seed-*.md，并从 seen.json 去掉对应键。')}\n`);
    process.exit(0);
  }

  const tmp = path.join(DATA_ROOT, 'data', 'mail', '__dummy-test');
  const files = new Map();

  const round = (label, msgs, seen) => {
    files.clear();
    const r = applyMessages(msgs, seen, {
      writeFile: (id, md) => files.set(id, md),
    });
    console.log(`  ${bold(label)}`);
    console.log(`    新处理 ${r.fresh.length}   已跳过 ${r.already.length}   写文件 ${r.written.length}`);
    if (r.fresh.length) console.log(`      新: ${r.fresh.join(', ')}`);
    if (r.already.length) console.log(`      跳过: ${r.already.join(', ')}`);
    return r;
  };

  console.log(`\n${bold('幂等自测（合成数据，不碰网络也不碰真实邮箱）')}\n`);
  const seen = { processed: {} };
  const batch = [mk('msg-001', '第一封'), mk('msg-002', '第二封')];

  const r1 = round('第 1 次运行：两封都是新的', batch, seen);
  // 记下第一次的处理时间，第 2 次跑完要核对它没被覆盖 ——
  // 直接比较 "x === x" 是恒真的假断言，得先存下来再比。
  const firstAt = seen.processed['msg-001'].at;
  const firstSubject = seen.processed['msg-001'].subject;

  const r2 = round('第 2 次运行：同样两封，应当全部跳过', batch, seen);
  const r3 = round('第 3 次：第一封跳过、第三封是新的', [batch[0], mk('msg-003', '第三封')], seen);

  console.log('');
  const checks = [
    ['第 1 次处理两封', r1.fresh.length === 2 && r1.already.length === 0],
    ['第 2 次一封都不重复处理', r2.fresh.length === 0 && r2.already.length === 2],
    ['第 2 次仍然写文件（更新内容）', r2.written.length === 2],
    [
      '第 1 次的记录时间没有被第 2、3 次覆盖',
      seen.processed['msg-001'].at === firstAt && Boolean(firstAt),
    ],
    ['记录里的主题也没被改写', seen.processed['msg-001'].subject === firstSubject],
    ['第 3 次只处理新的那封', r3.fresh.length === 1 && r3.fresh[0] === 'msg-003'],
    ['已处理总数正确', Object.keys(seen.processed).length === 3],
  ];
  let bad = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? green('✓') : red('✗')} ${name}`);
    if (!ok) bad++;
  }
  console.log('');
  if (bad) {
    console.log(`${red('✗')} ${bad} 项不通过 —— 幂等逻辑有问题，不要当真。\n`);
    process.exit(1);
  }
  console.log(`${green('✓')} 幂等逻辑通过：重复检查邮箱不会重复处理同一封邮件。\n`);
  process.exit(0);
}

function requireCreds() {
  if (!existsSync(credentialsPath())) {
    console.error(`${red('✗')} 还没有 Gmail 客户端凭据。\n`);
    console.error(`  期望位置：${credentialsPath()}\n`);
    console.error('  怎么拿：');
    console.error(dim('    1. Google Cloud Console → 启用 Gmail API'));
    console.error(dim('    2. 凭据 → 创建凭据 → OAuth 客户端 ID → 桌面应用'));
    console.error(dim('    3. 下载 JSON，存到上面那个路径\n'));
    console.error(dim('  放好之后跑：node scripts/gmail-auth.mjs --auth'));
    process.exit(2);
  }
}

if (isMain && statusOnly) {
  const seen = loadSeen();
  const ids = Object.keys(seen.processed);
  console.log(`\n${bold('邮件处理状态')}\n`);
  console.log(`  .env        ${ENV_PATH}${existsSync(ENV_PATH) ? '' : dim('  （不存在）')}`);
  console.log(`  令牌        ${tokenPath()}${readToken() ? '' : dim('  （不存在）')}`);
  console.log(`  已处理      ${ids.length} 封`);
  console.log(`  记录文件    ${existsSync(SEEN_PATH) ? SEEN_PATH : dim('（还没有，说明一封都没处理过）')}`);

  const files = existsSync(MAIL_DIR) ? readdirSync(MAIL_DIR).filter((f) => f.endsWith('.md')) : [];
  console.log(`  落盘文件    ${files.length} 个 .md`);
  if (ids.length) {
    console.log(`\n  最近 5 封：`);
    for (const id of ids.slice(-5)) {
      const m = seen.processed[id];
      console.log(`    ${dim(m.at?.slice(0, 16) || '?')}  ${(m.subject || '').slice(0, 50)}`);
    }
  }
  console.log('');
  process.exit(0);
}

if (!isMain) {
  // 被 import 时到此为止 —— 上面的 applyMessages 就是给测试用的出口。
  // 不这么挡的话，测试一 import 就会去连 Gmail。
} else {
requireCreds();

let listed;
try {
  listed = await gmailFetch(
    `/users/me/messages?maxResults=${limit}&q=${encodeURIComponent(query)}`
  );
} catch (err) {
  console.error(`${red('✗')} 取信失败：${err.message}`);
  process.exit(1);
}

const messages = listed.messages || [];
console.log(`\n${bold('Gmail 取信')}  ${dim(`查询「${query}」，上限 ${limit}`)}`);
console.log(`  列出 ${messages.length} 封\n`);

if (!messages.length) {
  console.log(dim('  没有匹配的邮件。'));
  console.log(dim('  换个查询看看：--query "is:unread" / --limit 50\n'));
  process.exit(0);
}

const seen = loadSeen();
let fresh = 0;
let skipped = 0;
let failed = 0;

for (const stub of messages) {
  if (seen.processed[stub.id] && !showAll) {
    skipped++;
    continue;
  }

  let msg;
  try {
    msg = await gmailFetch(`/users/me/messages/${stub.id}?format=full`);
  } catch (err) {
    failed++;
    console.error(`  ${red('✗')} ${stub.id} 取详情失败：${err.message}`);
    continue;
  }

  const parsed = messageToMarkdown(msg);
  const already = Boolean(seen.processed[stub.id]);

  if (dryRun) {
    console.log(
      `  ${yellow('会处理')} ${parsed.subject.slice(0, 56)}\n` +
        `        ${dim(`id=${stub.id}  from=${parsed.from.slice(0, 50)}`)}`
    );
    if (!parsed.hasText) console.log(`        ${yellow('⚠ 没有文本正文')}`);
    continue;
  }

  mkdirSync(MAIL_DIR, { recursive: true });
  const out = path.join(MAIL_DIR, `${stub.id}.md`);
  writeFileSync(out, parsed.markdown, 'utf8');

  // 幂等：已经记过的不要覆盖记录时间 —— 那会让"第一次处理于何时"失真
  if (!already) {
    seen.processed[stub.id] = {
      at: new Date().toISOString(),
      subject: parsed.subject,
      from: parsed.from,
    };
    fresh++;
    console.log(`  ${green('✓')} ${parsed.subject.slice(0, 56)}  ${dim(`→ ${stub.id}.md`)}`);
    if (!parsed.hasText) console.log(`      ${yellow('⚠ 没有文本正文，去看原始 HTML 部分')}`);
  } else {
    console.log(`  ${dim('·')} ${parsed.subject.slice(0, 56)}  ${dim('（已记录过，只重写了文件）')}`);
  }
}

if (!dryRun) saveSeen(seen);

console.log('');
if (dryRun) {
  console.log(`${yellow('dry-run')} ${dim('没有写任何东西。')}\n`);
} else {
  console.log(`  新处理 ${green(String(fresh))} 封   跳过已处理 ${skipped} 封${failed ? `   失败 ${red(String(failed))} 封` : ''}\n`);
  if (fresh === 0 && skipped > 0) {
    console.log(dim('  这一封都没新处理是**正确行为** —— 幂等就是这样。'));
    console.log(dim('  重复检查邮箱不应重复处理同一封邮件。\n'));
  }
}
process.exit(failed ? 1 : 0);
} // end isMain
