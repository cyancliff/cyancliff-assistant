#!/usr/bin/env node
/**
 * mail-send.mjs — 只在确认之后发送回复
 *
 *   node scripts/mail-send.mjs --list              有哪些草稿、各自什么状态
 *   node scripts/mail-send.mjs <id> --show         看草稿正文
 *   node scripts/mail-send.mjs <id> --edit <文件>   用文件内容替换草稿正文
 *   node scripts/mail-send.mjs <id> --confirm      确认这封草稿
 *   node scripts/mail-send.mjs <id> --send --dry-run  看会发什么，不发
 *   node scripts/mail-send.mjs <id> --send         真的发出去
 *   node scripts/mail-send.mjs <id> --check        这封确认了吗、发出去了吗
 *
 * ## 确认闸门
 *
 * 发送是不可逆的，所以有意做成**两步**：
 *
 *   1. `--confirm` 把草稿标成已确认，并往 data/confirmations/<id>.json
 *      写一条审计记录（谁确认的、什么时候、内容摘要）
 *   2. `--send` 才真发。它要求那个审计记录存在且内容摘要对得上
 *
 * 为什么不要一步 `--confirm --send`：那等于一键发送，
 * 而这个脚本的整个意义就是"发送之前有人真正看过"。
 *
 * ## 摘要校验是干什么的
 *
 * 审计记录里存草稿正文的 sha256。发送时重新算一遍对比 ——
 * 确认之后又改了正文的话，摘要不匹配，**拒绝发送**。
 * 这道检查防的是"确认的是 A，发出去的是 B"。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gmailFetch, getEnv, DATA_ROOT, readToken, credentialsPath } from './gmail-auth.mjs';
import { restartIfNeeded } from './proxy.mjs';

// 联网脚本：需要时先带代理开关重启一次自己（见 proxy.mjs 顶部说明）
restartIfNeeded();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = c(31);
const green = c(32);
const yellow = c(33);
const dim = c(2);
const bold = c(1);

const MAIL_DIR = path.join(DATA_ROOT, 'data', 'mail');
const DRAFT_DIR = path.join(MAIL_DIR, 'drafts');
const CONFIRM_DIR = path.join(DATA_ROOT, 'data', 'confirmations');

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--edit']);
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]));
const flagValue = (n) => {
  const i = args.indexOf(n);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};

const dryRun = args.includes('--dry-run');

// ── 草稿读写 ──────────────────────────────────────────────────
/**
 * 草稿文件有两部分：frontmatter（状态）和正文（人写的）。
 * 分开处理是因为改正文时**不能碰 frontmatter** ——
 * 那是闸门状态，手滑改掉就等于绕开闸门。
 */
export function readDraft(id) {
  const f = path.join(DRAFT_DIR, `${id}.md`);
  if (!existsSync(f)) return null;
  const text = readFileSync(f, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { id, path: f, fm: {}, fmText: '', body: text, raw: text };

  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (v.startsWith('"') && v.endsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    }
    fm[kv[1]] = v;
  }

  const rest = text.slice(m[0].length);
  const bm = rest.match(/^([\s\S]*?##\s*草稿正文\s*\r?\n\r?\n)([\s\S]*?)(\r?\n##\s*拟稿依据|$)/);
  return {
    id,
    path: f,
    fm,
    fmText: m[1],
    header: bm ? bm[1] : '',
    body: bm ? bm[2] : rest,
    tail: bm?.[3] || '',
    raw: text,
  };
}

/** 只改 frontmatter 里的字段，正文和其余部分原样保留。 */
export function setFrontmatter(draft, updates) {
  const lines = draft.fmText.split(/\r?\n/);
  const seen = new Set();
  const out = lines.map((line) => {
    const kv = line.match(/^([a-z_]+):/i);
    if (!kv || !(kv[1] in updates)) return line;
    seen.add(kv[1]);
    const v = updates[kv[1]];
    return `${kv[1]}: ${typeof v === 'string' && !/^[\w.:@<>\- ]+$/.test(v) ? JSON.stringify(v) : v}`;
  });
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) out.push(`${k}: ${v}`);
  }
  const text = `---\n${out.join('\n')}\n---\n${draft.header}${draft.body}${draft.tail}`;
  writeFileSync(draft.path, text, 'utf8');
  return text;
}

/** 草稿正文的摘要 —— 用于确认记录，防止"确认的是 A、发的是 B"。 */
export function bodyHash(body) {
  return createHash('sha256').update(body.replace(/\s+/g, ' ').trim()).digest('hex');
}

// ── 确认记录 ──────────────────────────────────────────────────
export function confirmPath(id) {
  return path.join(CONFIRM_DIR, `${id}.json`);
}

export function readConfirm(id) {
  const f = confirmPath(id);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

export function writeConfirm(id, draft, via) {
  mkdirSync(CONFIRM_DIR, { recursive: true });
  const rec = {
    draft: id,
    confirmed_at: new Date().toISOString(),
    via,
    body_sha256: bodyHash(draft.body),
    body_chars: draft.body.trim().length,
    // 存一段预览，便于事后核对"当时确认的是哪一版"
    body_preview: draft.body.trim().slice(0, 120),
  };
  writeFileSync(confirmPath(id), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

// ── 发送锁 ────────────────────────────────────────────────────
//
// 为什么需要它：`--send` 分支读 `sent_at` 判断"发过没有"，
// 而 `sent_at` 是**发完之后**才写的。中间那段时间是敞开的。
//
// 命令行时代无所谓 —— 一次命令一个进程，跑完就退了。
// 但 bot 会在**同一进程里并发**处理回调（飞书超时会重推同一条），
// 两次都能通过那个判断，于是**真的会发两封**。
//
// 锁跨进程：CLI 与 bot 同时发同一封，也只有一个能进。
// 陈旧的锁（进程被 kill 掉了）超过 STALE 就当无效，免得永久卡住。
const SEND_LOCK_STALE_MS = 120_000;

/** 进程退出时兜底清锁 —— `process.exit()` 不会走 finally。 */
const heldLocks = new Set();
process.on('exit', () => {
  for (const f of heldLocks) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* 退出路径上尽力而为，失败也不能抛 */
    }
  }
});

export function sendLockPath(id) {
  return path.join(CONFIRM_DIR, `${id}.send.lock`);
}

/**
 * 拿锁。返回 `{ acquired: false, reason: 'busy', holder, ageMs }` 表示别人正在发，
 * **调用方必须据此拒绝**，不能当成成功。
 *
 * 拿到之后**必须**配对调用 `releaseSendLock`，否则会一直占着到进程退出。
 * （CLI 那种每个分支都 `process.exit` 的场景可以省掉 —— 退出兜底会清。）
 */
export function acquireSendLock(id) {
  const lock = sendLockPath(id);
  mkdirSync(CONFIRM_DIR, { recursive: true });

  if (existsSync(lock)) {
    let ageMs = Infinity;
    let holder = '';
    try {
      ageMs = Date.now() - statSync(lock).mtimeMs;
      holder = readFileSync(lock, 'utf8').trim();
    } catch {
      /* 读不到就当它陈旧，往下走 */
    }
    if (ageMs < SEND_LOCK_STALE_MS) {
      return { acquired: false, reason: 'busy', holder, ageMs };
    }
    rmSync(lock, { force: true }); // 陈旧 → 清掉重来
  }

  try {
    // wx：文件已存在就失败。这一步才是真正的互斥点 ——
    // 上面那些判断都可能是两个进程同时做，只有这个是原子的。
    writeFileSync(lock, `pid ${process.pid} @ ${new Date().toISOString()}`, { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') return { acquired: false, reason: 'busy' };
    throw e;
  }

  heldLocks.add(lock);
  return { acquired: true };
}

export function releaseSendLock(id) {
  const lock = sendLockPath(id);
  heldLocks.delete(lock);
  rmSync(lock, { force: true });
}

/** 「别人正在发」的统一说法，CLI 与 bot 都用它，免得两处措辞不一致。 */
export function busyMessage(lock) {
  const secs = Number.isFinite(lock.ageMs) ? `${Math.round(lock.ageMs / 1000)} 秒前` : '刚刚';
  return `这一封正在发送中（${lock.holder || '另一个进程'}，${secs}上的锁），不重复发。`;
}

/** 上锁 → 执行 → 无论如何解锁。给**不会退出进程**的调用方（bot）用。 */
export async function withSendLock(id, fn) {
  const lock = acquireSendLock(id);
  if (!lock.acquired) return lock;
  try {
    return { acquired: true, value: await fn() };
  } finally {
    releaseSendLock(id);
  }
}

// ── 列表 ──────────────────────────────────────────────────────
function listDrafts() {
  if (!existsSync(DRAFT_DIR)) return [];
  return readdirSync(DRAFT_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
}

function statusOf(draft) {
  if (draft.fm.sent_at) return { label: `${green('已发送')} ${dim(draft.fm.sent_at)}`, ok: true };
  const rec = readConfirm(draft.id);
  if (rec && bodyHash(draft.body) === rec.body_sha256) {
    return { label: `${green('已确认，待发送')} ${dim(`(${rec.via}, ${rec.confirmed_at.slice(0, 16)})`)}`, ok: true };
  }
  if (rec) {
    return {
      label: `${red('已确认但正文被改过')}`,
      hint: '确认时的摘要和现在的正文不一致 —— 要重新确认，否则发不出去',
    };
  }
  return { label: `${yellow('未确认')}`, hint: '先 --show 看清楚，再 --confirm' };
}

// ── 主流程 ────────────────────────────────────────────────────
/**
 * 是不是直接运行（而不是被 import）。
 *
 * 用 pathname 比较并包 try/catch：`path.resolve` 和 `fileURLToPath` 在
 * Windows 上的盘符大小写、分隔符可能有差异，裸比较不总是成立；
 * 而 `node -e` 这类用法下 `process.argv[1]` 可能根本不是一个文件路径。
 * 判错的后果是 import 时误跑 CLI —— workflow.mjs 会 import 这个文件。
 *
 * 更稳的做法是把可复用部分拆成单独模块（见 notify-lib.mjs）。
 * 这里先用加固的判据，等哪天需要给外部调用的函数变多再拆。
 */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const isMain = isMainModule();

if (!isMain) {
  // 被 import 时只导出上面的函数
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(`${bold('mail-send.mjs')} — 只在确认之后发送回复

  ${bold('看')}
    --list                      有哪些草稿、各自什么状态
    <id> --show                 看草稿正文
    <id> --check                这封确认了吗、发出去了吗

  ${bold('改')}
    <id> --edit <文件>          用文件内容替换草稿正文
                                （改了就要重新确认 —— 摘要会不匹配）

  ${bold('确认')}
    <id> --confirm              确认这封草稿
    <id> --confirm --via feishu 记录确认渠道（默认 cli）

  ${bold('发')}
    <id> --send --dry-run       看会发什么，不发
    <id> --send                 真的发出去

  ${dim('发送是不可逆的，所以有意做成两步：--confirm 之后才 --send。')}
  ${dim('确认之后又改正文的话，摘要不匹配，会拒绝发送。')}
`);
  process.exit(0);
} else if (args.includes('--list')) {
  const ids = listDrafts();
  console.log(`\n${bold('草稿')}  ${dim(DRAFT_DIR)}\n`);
  if (!ids.length) {
    console.log(dim('  还没有草稿。先拟一份：'));
    console.log(dim('    node scripts/mail-fetch.mjs --seed'));
    console.log(dim('    node scripts/mail-draft.mjs <id> --template\n'));
    process.exit(0);
  }
  for (const id of ids) {
    const d = readDraft(id);
    const s = statusOf(d);
    console.log(`  ${id}  ${s.label}`);
    console.log(`    ${dim(`主题：${String(d.fm.subject || '(无)').slice(0, 60)}`)}`);
    console.log(`    ${dim(`收件人：${String(d.fm.to || '(无)').slice(0, 60)}`)}`);
    if (s.hint) console.log(`    ${dim(s.hint)}`);
  }
  const pending = ids.filter((id) => !readDraft(id).fm.sent_at);
  console.log(`\n  共 ${ids.length} 份，${pending.length} 份未发送\n`);
  process.exit(0);
} else {
  const id = positional[0];
  if (!id) {
    console.error(`${red('✗')} 没给草稿 id。用 --list 看有哪些，或 --help 看用法。`);
    process.exit(2);
  }

  const draft = readDraft(id);
  if (!draft) {
    console.error(`${red('✗')} 找不到草稿 ${id}（期望 ${path.join(DRAFT_DIR, `${id}.md`)}）`);
    process.exit(2);
  }

  // ── --show ──
  if (args.includes('--show')) {
    const s = statusOf(draft);
    console.log(`\n${bold(`草稿 ${id}`)}  ${s.label}\n`);
    console.log(dim(`  收件人：${draft.fm.to || '(无)'}`));
    console.log(dim(`  主题：${draft.fm.subject || '(无)'}`));
    console.log(dim(`  拟稿：${draft.fm.generated_by || '(未知)'}  ${draft.fm.created_at || ''}`));
    if (s.hint) console.log(`  ${dim(s.hint)}`);
    console.log(`\n${dim('── 正文 ──')}\n`);
    console.log(draft.body.trim());
    console.log('');
    process.exit(0);
  }

  // ── --check ──
  if (args.includes('--check')) {
    const s = statusOf(draft);
    const rec = readConfirm(id);
    console.log(`\n${bold(`草稿 ${id}`)}\n`);
    console.log(`  状态        ${s.label}`);
    console.log(`  frontmatter confirmed=${draft.fm.confirmed}  sent_at=${draft.fm.sent_at || '(无)'}`);
    if (rec) {
      console.log(`  确认记录    ${rec.confirmed_at}  渠道 ${rec.via}  ${rec.body_chars} 字符`);
      const now = bodyHash(draft.body);
      console.log(`  摘要比对    ${now === rec.body_sha256 ? green('一致') : red('不一致 —— 正文在确认后被改过')}`);
    } else {
      console.log(`  确认记录    ${dim('（还没有）')}`);
    }
    console.log('');
    process.exit(0);
  }

  // ── --edit ──
  if (args.includes('--edit')) {
    const src = flagValue('--edit');
    if (!src || !existsSync(src)) {
      console.error(`${red('✗')} --edit 要给一个存在的文件：${src || '(没给)'}`);
      process.exit(2);
    }
    if (draft.fm.sent_at) {
      console.error(`${red('✗')} 这封已经发出去了，不能再改。`);
      process.exit(2);
    }
    const newBody = readFileSync(src, 'utf8').trim();
    if (!newBody) {
      console.error(`${red('✗')} 新正文是空的，不写。`);
      process.exit(2);
    }
    const text = `---\n${draft.fmText}\n---\n${draft.header}${newBody}\n${draft.tail}`;
    writeFileSync(draft.path, text, 'utf8');
    // 改过就要重新确认 —— 旧的确认记录立刻作废，不能留着让人误以为还能发
    if (existsSync(confirmPath(id))) {
      rmSync(confirmPath(id), { force: true });
      console.log(`${yellow('注意')} 正文改过了，之前的确认已作废 —— 要重新 --confirm。`);
    }
    setFrontmatter(readDraft(id), { confirmed: false });
    console.log(`${green('✓')} 正文已替换（${newBody.length} 字符）`);
    process.exit(0);
  }

  // ── --confirm ──
  if (args.includes('--confirm')) {
    if (draft.fm.sent_at) {
      console.error(`${red('✗')} 这封已经发出去了。`);
      process.exit(2);
    }
    if (!draft.body.trim()) {
      console.error(`${red('✗')} 正文是空的，不确认。`);
      process.exit(2);
    }
    const via = flagValue('--via') || 'cli';
    const rec = writeConfirm(id, draft, via);
    setFrontmatter(readDraft(id), { confirmed: true });

    console.log(`\n${green('✓')} 已确认 ${id}`);
    console.log(`  渠道      ${via}`);
    console.log(`  正文      ${rec.body_chars} 字符`);
    console.log(`  摘要      ${rec.body_sha256.slice(0, 16)}…`);
    console.log(`  记录      ${confirmPath(id)}`);
    console.log(`\n  ${dim('确认 ≠ 发送。真发出去要再跑一次带 --send 的。')}\n`);
    process.exit(0);
  }

  // ── --send ──
  if (args.includes('--send')) {
    // 先上锁再判 sent_at —— 顺序不能反。
    // 读 sent_at（下面几行）到写 sent_at（发完之后）之间是敞开的，
    // 并发进来两次就都以为"还没发过"，于是发两封。
    // 锁不放：本进程每个分支都会 process.exit，退出兜底会清掉。
    const lock = acquireSendLock(id);
    if (!lock.acquired) {
      console.error(`${red('✗')} ${busyMessage(lock)}`);
      process.exit(2);
    }

    if (draft.fm.sent_at) {
      console.error(`${red('✗')} 这封已经发过了（${draft.fm.sent_at}），不重复发。`);
      process.exit(2);
    }

    // 闸门 1：必须有确认记录
    const rec = readConfirm(id);
    if (!rec) {
      console.error(`${red('✗')} 这封还没确认，不发。\n`);
      console.error(`  先看清楚内容：node scripts/mail-send.mjs ${id} --show`);
      console.error(`  确认：        node scripts/mail-send.mjs ${id} --confirm\n`);
      console.error(dim('  这是机制不是劝告 —— 未确认的草稿发不出去。'));
      process.exit(2);
    }

    // 闸门 2：确认之后正文不能被改过
    const nowHash = bodyHash(draft.body);
    if (nowHash !== rec.body_sha256) {
      console.error(`${red('✗')} 正文在确认之后被改过，不发。\n`);
      console.error(`  确认时：${rec.body_chars} 字符，摘要 ${rec.body_sha256.slice(0, 16)}…`);
      console.error(`  现在：  ${draft.body.trim().length} 字符，摘要 ${nowHash.slice(0, 16)}…`);
      console.error(`\n  确认的是 A、发出去的是 B —— 这道检查就是防这个。`);
      console.error(dim(`  重新确认：node scripts/mail-send.mjs ${id} --confirm`));
      process.exit(2);
    }

    const to = String(draft.fm.to || '');
    const subject = String(draft.fm.subject || '');
    if (!to || !subject) {
      console.error(`${red('✗')} 草稿里缺收件人或主题，不发。to=${to || '(空)'} subject=${subject || '(空)'}`);
      process.exit(2);
    }

    if (dryRun) {
      console.log(`\n${yellow('dry-run')} ${dim('（没有发送任何东西）')}\n`);
      console.log(`  收件人  ${to}`);
      console.log(`  主题    ${subject}`);
      console.log(`  确认于  ${rec.confirmed_at}（渠道 ${rec.via}）`);
      console.log(`  摘要    一致 ✓`);
      console.log(`\n${dim('── 会发出去的正文 ──')}\n`);
      console.log(draft.body.trim());
      console.log('');
      process.exit(0);
    }

    // 真发之前再要一次凭据 —— 早失败比晚失败好
    if (!existsSync(credentialsPath())) {
      console.error(`${red('✗')} 没有 Gmail 凭据，发不出去。`);
      console.error(`  期望：${credentialsPath()}`);
      console.error(dim('  先跑：node scripts/gmail-auth.mjs --auth'));
      process.exit(2);
    }
    if (!readToken()) {
      console.error(`${red('✗')} 没有授权令牌，发不出去。`);
      console.error(dim('  先跑：node scripts/gmail-auth.mjs --auth'));
      process.exit(2);
    }

    // 组装 MIME。用 base64url 是 Gmail API 的要求。
    const mime = [
      `To: ${to}`,
      `Subject: ${/^re:/i.test(subject) ? subject : `Re: ${subject}`}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      '',
      draft.body.trim(),
      '',
    ].join('\r\n');

    let sent;
    try {
      sent = await gmailFetch('/users/me/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: Buffer.from(mime, 'utf8').toString('base64url') }),
      });
    } catch (err) {
      console.error(`${red('✗')} 发送失败：${err.message}`);
      console.error(dim('  草稿没有标成已发送 —— 可以重试。'));
      process.exit(1);
    }

    setFrontmatter(readDraft(id), {
      sent_at: new Date().toISOString(),
      sent_message_id: sent.id,
    });

    // 归档：把发送结果写回原邮件那份记录里
    const mailFile = path.join(MAIL_DIR, `${id}.md`);
    if (existsSync(mailFile)) {
      const orig = readFileSync(mailFile, 'utf8');
      writeFileSync(
        mailFile,
        `${orig.trimEnd()}\n\n---\n\n## 已回复\n\n- 回复于：${new Date().toISOString()}\n- Gmail message id：\`${sent.id}\`\n- 草稿：\`drafts/${id}.md\`\n- 确认渠道：${rec.via}\n`,
        'utf8'
      );
    }

    console.log(`\n${green('✓')} 已发送`);
    console.log(`  Gmail message id  ${sent.id}`);
    console.log(`  收件人            ${to}`);
    console.log(`  归档              已写回 data/mail/${id}.md`);
    console.log('');
    process.exit(0);
  }

  // 没给动作
  const s = statusOf(draft);
  console.log(`\n${bold(`草稿 ${id}`)}  ${s.label}\n`);
  console.log('  想干什么？');
  console.log(dim(`    --show      看正文`));
  console.log(dim(`    --confirm   确认`));
  console.log(dim(`    --send      发送（要先确认）`));
  console.log('');
  process.exit(0);
}
