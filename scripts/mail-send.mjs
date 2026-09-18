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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gmailFetch, getEnv, DATA_ROOT, readToken, credentialsPath } from './gmail-auth.mjs';
import { restartIfNeeded, onExitCleanup } from './proxy.mjs';

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
/**
 * 确认记录与发送标记放哪。
 *
 * **可以用 `ASSISTANT_CONFIRM_DIR` 覆盖**（2026-09-19 加）。理由不是"方便"，
 * 是**可测性**：确认记录里现在有闸门 2 的摘要与三态标记，
 * 而它们只有在真发送流程里才被写到 —— 如果测试必须往真目录写，
 * 那就没人会去测它们（要么污染真数据，要么不测）。这个项目里已经有过
 * "因为没法测所以从没被验证过"的东西好几次了。
 */
const CONFIRM_DIR = process.env.ASSISTANT_CONFIRM_DIR
  ? path.resolve(process.env.ASSISTANT_CONFIRM_DIR)
  : path.join(DATA_ROOT, 'data', 'confirmations');

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

/**
 * **完整发送载荷**的摘要：收件人 + 主题 + 正文。
 *
 * ## 为什么不能只算正文（2026-09-19 修，来自一次外部审查）
 *
 * 原先确认记录里只有 `body_sha256`，于是这条路径是通的：
 *
 *   1. 生成确认卡片（卡片上写着收件人 A）
 *   2. 改草稿的 `to:` 为 B
 *   3. 点**那张旧卡片** → 闸门 2 只比正文 → 通过 → **发给了 B**
 *
 * 而 `feishu-core.mjs` 的确认流程是"锁外读一次（卡片上显示的就是它）、
 * 锁内再读一次（真正拿去发的）"—— 两次读之间改了草稿，卡片就成了假象。
 *
 * 摘要覆盖 `to` 与 `subject` 之后，第 3 步会因为在锁内重算而不一致被拒。
 *
 * ## 为什么没有 cc/bcc
 *
 * 因为**草稿里根本没有这两个字段**，`buildMime` 也只传 `to`/`subject`/`body`。
 * 摘要只该覆盖"真的会发出去的东西" —— 凭想象加两个字段，会造出一个
 * 永远为空、永远无法被验证的保护。
 *
 * 正文用与 `bodyHash` 同一个归一化（空白折叠），这样"只改排版"不会被打回。
 */
export function payloadHash({ to, subject, body }) {
  const canonical = JSON.stringify({
    to: String(to || '').trim(),
    subject: String(subject || '').trim(),
    body: String(body || '').replace(/\s+/g, ' ').trim(),
  });
  return createHash('sha256').update(canonical).digest('hex');
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
    // 完整载荷摘要（收件人 + 主题 + 正文）—— **发送时比的是它**（见 payloadHash）
    payload_sha256: payloadHash({ to: draft.fm.to, subject: draft.fm.subject, body: draft.body }),
    // 下三个字段保留：便于事后核对"当时确认的是哪一版"，也让旧记录仍可读
    body_sha256: bodyHash(draft.body),
    body_chars: draft.body.trim().length,
    body_preview: draft.body.trim().slice(0, 120),
    // **确认时你看到的收件人**。卡片上显示的就是它；事后有争议时以它为准。
    agreed_to: String(draft.fm.to || ''),
    agreed_subject: String(draft.fm.subject || ''),
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

// 注意：**不能自己 process.on('exit')**。
// proxy.mjs 在模块加载时（也就是这个模块之前）装了一个调 reallyExit 的处理器，
// 它会立刻终止进程，把之后注册的 exit 处理器全部闷掉 —— 实测撞过，
// 锁从来没被清过。所以走它提供的注册表。
onExitCleanup(() => {
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

/**
 * 持锁期间**心跳续期**（2026-09-19 加，来自一次外部审查）。
 *
 * ## 它修的是什么
 *
 * 原先只有一个固定的 `SEND_LOCK_STALE_MS = 120_000`：
 * **锁存在超过 120 秒就被当成"进程死了"清掉**。
 * 但"发信慢"与"进程死了"用时间根本分不开 —— Gmail 调用 + 网络抖动
 * 完全可能超过两分钟，于是：
 *
 *   进程 A 还在发 → 锁被判陈旧 → 进程 B 拿到锁 → **两封都发出去**
 *
 * 而飞书回调会重推、用户也会连点两下，所以 B 真的会出现。
 *
 * ## 修法
 *
 * 持锁的那个进程每 `HEARTBEAT_MS` 摸一次锁文件（更新 mtime）。
 * 于是"看着像陈旧"重新只说明一件事：**确实没有活着的进程在发**。
 * 固定的 STALE 值不用改大，它只需要大于心跳间隔。
 *
 * 返回 `stop()`；**必须在发送结束后调用**（含失败路径），否则心跳会一直跑。
 */
const SEND_HEARTBEAT_MS = Number(process.env.ASSISTANT_SEND_HEARTBEAT_MS) || 20_000;

export function startSendLockHeartbeat(id) {
  const lock = sendLockPath(id);
  const timer = setInterval(() => {
    try {
      // 只更新 mtime：文件内容仍是原来的持有者信息
      const now = new Date();
      utimesSync(lock, now, now);
    } catch {
      // 锁被别人清掉/文件没了 —— 心跳救不了，交给发送路径自己收尾
    }
  }, SEND_HEARTBEAT_MS);
  // 别让心跳把进程钉住：它是辅助，不是工作。
  timer.unref?.();
  return () => clearInterval(timer);
}

// ── 发送前的"结果未知"状态 ─────────────────────────────────────
/**
 * `data/confirmations/<id>.sending.json` —— 记"我正在发、结果还不知道"。
 *
 * ## 它修的是什么（2026-09-19，外部审查发现的 P0）
 *
 * 发送顺序是：**先调 Gmail，再写 `sent_at`**。于是中间那一段是敞开的：
 *
 *   Gmail 侧**已经发出去了** → 进程崩了 → `sent_at` 没写上
 *   → 重试时读 `sent_at` 看到"没发过" → **再发一封**
 *
 * 判据（幂等键）只有本地草稿 id，而本地状态在那一刻是不可信的。
 *
 * ## 修法：三态，而不是两态
 *
 * | 状态 | 靠什么表示 | 重试时怎么办 |
 * |---|---|---|
 * | 没发过 | 没有标记、没有 `sent_at` | 正常发 |
 * | **正在发 / 结果未知** | **有标记、没有 `sent_at`** | **停，让人核查** |
 * | 发过了（成功） | 有 `sent_at` | 拒绝 |
 * | 发过了（明确失败） | 无标记、无 `sent_at` | 正常发（失败是确定的结论） |
 *
 * 关键在第二行：**绝不自动重发**。因为它无法区分"Gmail 根本没收到请求"
 * 与"Gmail 收到了并且发了、只是我们没记下来"—— 而后者重试就是双发。
 *
 * 标记里存 `payload_sha256`：草稿改过之后，旧标记就不再算数（那已经不是同一封信）。
 */
export function sendMarkerPath(id) {
  return path.join(CONFIRM_DIR, `${id}.sending.json`);
}

export function readSendMarker(id) {
  const f = sendMarkerPath(id);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    // 读不出来也要当成"有标记" —— 宁可多问一次，不能当它不存在
    return { unreadable: true };
  }
}

export function writeSendMarker(id, payload) {
  mkdirSync(CONFIRM_DIR, { recursive: true });
  const rec = { draft: id, at: new Date().toISOString(), pid: process.pid, payload_sha256: payload };
  // 与 sent_at 用同一条路径写，保证"标记先于网络调用存在"
  writeFileSync(sendMarkerPath(id), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

export function clearSendMarker(id) {
  rmSync(sendMarkerPath(id), { force: true });
}

/** 「别人正在发」的统一说法，CLI 与 bot 都用它，免得两处措辞不一致。 */
export function busyMessage(lock) {
  const secs = Number.isFinite(lock.ageMs) ? `${Math.round(lock.ageMs / 1000)} 秒前` : '刚刚';
  return `这一封正在发送中（${lock.holder || '另一个进程'}，${secs}上的锁），不重复发。`;
}

/**
 * 把邮件头里的非 ASCII 文本编成 RFC 2047。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * MIME 头里**不能直接放非 ASCII 字符**。正文没问题（`Content-Type` 里声明了
 * `charset="UTF-8"`），但头是另一回事：非 ASCII 必须编成 `=?UTF-8?B?...?=`。
 *
 * 这是踩过才加的。给自测邮件写了个中文主题，收到时变成
 *
 *     Re: Ã©Â£ÂžÃ¤Â¹Â¦ bot ...
 *
 * 原文是「Re: 飞书 bot 发送链路测试」—— 被双重编码了。
 * 有些客户端会猜、有些不猜；给真人回信时主题就会花掉。
 * （发现它纯属偶然：`/取信` 扫到的那封测试邮件正好是自己发的。）
 *
 * ── 为什么按字符切块而不是按词 ──────────────────────────────────
 * RFC 2047 规定相邻两个编码词之间的空白会被解码器**吃掉**。
 * 所以整串（含空格）必须都在编码词里面，不能把空格留在外面。
 * 按字符切、每块单独编，解码后拼起来才和原文一模一样。
 */
export function encodeHeaderValue(value) {
  const s = String(value == null ? '' : value);
  // 纯 ASCII 且无控制字符 —— 原样用，没必要套一层编码（也更可读）
  if (!/[^\x20-\x7e]/.test(s)) return s;

  const chunks = [];
  let buf = [];
  let bytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    // 45 字节 → base64 60 字符；加 `=?UTF-8?B?` 与 `?=` 共 12 → 72，在 RFC 的 75 以内
    if (bytes + n > 45) {
      chunks.push(buf.join(''));
      buf = [];
      bytes = 0;
    }
    buf.push(ch);
    bytes += n;
  }
  if (buf.length) chunks.push(buf.join(''));

  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/**
 * 地址头（To/Cc）的编码。
 *
 * 与主题不同：**地址本身不能被编码**，只有显示名可以 ——
 * `=?UTF-8?B?…?= <a@b.com>` 合法；把整个 `名字 <地址>` 编成一坨就不合法了。
 */
export function encodeAddress(value) {
  const s = String(value == null ? '' : value).trim();
  const m = s.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (!m) return s; // 光秃秃一个地址，没什么可编的
  const name = m[1].replace(/^"(.*)"$/, '$1').trim();
  return name ? `${encodeHeaderValue(name)} <${m[2]}>` : `<${m[2]}>`;
}

/**
 * 组装 MIME。用 base64url 是 Gmail API 的要求。
 *
 * 单独抽出来是为了**能测** —— 头编码这种事不测就只能靠发真邮件看，
 * 而"发出去看结果"恰恰是最慢、最容易漏的验证方式。
 */
export function buildMime({ to, subject, body }) {
  const subj = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  return [
    `To: ${encodeAddress(to)}`,
    `Subject: ${encodeHeaderValue(subj)}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    '',
    String(body).trim(),
    '',
  ].join('\r\n');
}

/**
 * 解析 `--send` 的输出。**给 bot 用** —— 它 spawn 这个脚本，然后要判断成败。
 *
 * 为什么放在这里而不是调用方：**打印和解析必须一起改。**
 * 分成两处的话，哪天上面那句"✓ 已发送"改了措辞，
 * 调用方会安静地开始把成功当失败 —— 而"安静地"是最坏的那部分。
 *
 * 为什么不用退出码：这个项目在 Windows 上有个未解决的问题 ——
 * 走过代理后进程退出时会撞 libuv 断言，退出码变成 3221226505，
 * **而输出完整正确**（见 scripts/proxy.mjs 的注释）。
 * 所以这里一律看输出，不看退出码，否则每次成功都会被当成失败。
 */
export function parseSendOutput(stdout, stderr = '') {
  const out = `${stdout || ''}\n${stderr || ''}`;

  const sent = out.match(/Gmail message id\s+(\S+)/);
  if (/✓\s*已发送/.test(out) && sent) {
    return { ok: true, messageId: sent[1] };
  }

  const why = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .find((l) => l.startsWith('✗'));

  return { ok: false, reason: (why || '未知原因（输出里既没有成功也没有失败的行）').replace(/^✗\s*/, '') };
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
export function listDrafts() {
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

  // ── --clear-sending ──
  /**
   * 人工核查之后：**确认上一封没发出去**，撤掉"结果未知"标记。
   *
   * 这个命令存在的理由：三态里的第二态**只能由人收尾**。
   * 程序分不清"Gmail 没收到"与"收到了但没记下来"，所以它必须停下来问人；
   * 而人核查完（去「已发送」里看了一眼）需要一个动作把状态收敛掉 —— 那就是它。
   */
  if (args.includes('--clear-sending')) {
    const m = readSendMarker(id);
    if (!m) {
      console.error(`${yellow('注意')} 没有"结果未知"标记，不用清。`);
      process.exit(0);
    }
    clearSendMarker(id);
    console.log(`${green('✓')} 已清掉"结果未知"标记 —— 现在可以重发这一封了。`);
    console.log(`  被清掉的标记：${m.at || '(时间不详)'}（pid ${m.pid ?? '?'}）`);
    console.log(dim(`  你说过已经核查过「已发送」里没有它。`));
    process.exit(0);
  }

  // ── --mark-sent ──
  /**
   * 人工核查之后：**确认那一封其实已经发出去了**，补上 `sent_at`。
   *
   * 场景同上，但结论相反。补 `sent_at` 之后，所有"发过没有"的判断都会正确拒绝重发，
   * 飞书那边的旧卡片也会显示"已经发过了"。
   */
  if (args.includes('--mark-sent')) {
    if (draft.fm.sent_at) {
      console.error(`${yellow('注意')} 这封本来就标着已发送（${draft.fm.sent_at}），没动它。`);
      process.exit(0);
    }
    const m = readSendMarker(id);
    setFrontmatter(readDraft(id), {
      sent_at: new Date().toISOString(),
      sent_message_id: 'unknown-manual',
    });
    clearSendMarker(id);
    console.log(`${green('✓')} 已标成"已发送"（message id 记为 unknown-manual）。`);
    console.log(`  依据：你在 Gmail 的「已发送」里看到了它。`);
    if (m) console.log(dim(`  原"结果未知"标记：${m.at || '(时间不详)'} —— 已清掉。`));
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
    // 持锁期间心跳续期：把"发信慢"与"进程死了"分开（见 startSendLockHeartbeat）
    const stopHeartbeat = startSendLockHeartbeat(id);

    if (draft.fm.sent_at) {
      stopHeartbeat();
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

    // 闸门 2：确认之后**整份发送载荷**都不能被改过 —— 收件人、主题、正文。
    //
    // 2026-09-19 修：原先只比正文。于是"确认时收件人是 A、发送时是 B"
    // 这条路径是通的（旧确认卡片 + 改草稿 = 发给另一个人）。详见 payloadHash。
    const nowPayload = payloadHash({ to: draft.fm.to, subject: draft.fm.subject, body: draft.body });
    if (!rec.payload_sha256) {
      // 旧记录（本次修复之前落的确认）只覆盖了正文，无法证明收件人也是当初那个。
      console.error(`${red('✗')} 这条确认记录是旧格式（只覆盖正文），不发。\n`);
      console.error(`  确认于：${rec.confirmed_at}（渠道 ${rec.via}）`);
      console.error(`  旧记录无法证明"收件人也是当时确认的那个" —— 而卡片上显示过它。`);
      console.error(`\n  重新确认一次即可（会写入完整载荷摘要）：`);
      console.error(dim(`    node scripts/mail-send.mjs ${id} --show`));
      console.error(dim(`    node scripts/mail-send.mjs ${id} --confirm`));
      process.exit(2);
    }
    if (nowPayload !== rec.payload_sha256) {
      const changed = [];
      if (String(draft.fm.to || '') !== String(rec.agreed_to || '')) {
        changed.push(`收件人：确认时是「${rec.agreed_to || '(空)'}」，现在是「${draft.fm.to || '(空)'}」`);
      }
      if (String(draft.fm.subject || '') !== String(rec.agreed_subject || '')) {
        changed.push(`主题：确认时是「${rec.agreed_subject || '(空)'}」，现在是「${draft.fm.subject || '(空)'}」`);
      }
      const nowBody = bodyHash(draft.body);
      if (nowBody !== rec.body_sha256) {
        changed.push(`正文：确认时 ${rec.body_chars} 字符，现在 ${draft.body.trim().length} 字符`);
      }

      console.error(`${red('✗')} 确认之后内容被改过，不发。\n`);
      for (const c of changed) console.error(`  · ${c}`);
      if (!changed.length) {
        // 摘要不一致但逐项看不出差别 —— 那说明是别的东西变了（换行/空格之外的字符）。
        console.error(`  · 摘要不一致，但收件人/主题/正文逐项看不出差别（可能是不可见字符）`);
      }
      console.error(`\n  确认的是 A、发出去的是 B —— 这道检查就是防这个。`);
      console.error(dim(`  重新确认：node scripts/mail-send.mjs ${id} --confirm`));
      process.exit(2);
    }

    const to = String(draft.fm.to || '');
    const subject = String(draft.fm.subject || '');
    if (!to || !subject) {
      stopHeartbeat();
      console.error(`${red('✗')} 草稿里缺收件人或主题，不发。to=${to || '(空)'} subject=${subject || '(空)'}`);
      process.exit(2);
    }

    // 三态里的第二态：**上次发送的结果未知** → 停下来让人核查，绝不自动重发。
    //
    // 场景：Gmail 已经收了请求并发出去了，而我们在写 sent_at 之前崩了。
    // 此时"没有 sent_at"不能证明"没发过"。重试就是双发。
    // 草稿改过（载荷变了）则旧标记不算数 —— 那已经不是同一封信。
    const marker = readSendMarker(id);
    if (marker) {
      stopHeartbeat();
      const sameDraft = marker.payload_sha256 === nowPayload;
      if (sameDraft) {
        console.error(`${red('✗')} 上一次发送的**结果未知**，不自动重发。\n`);
        console.error(`  上次发起：${marker.at || '(时间不详)'}（pid ${marker.pid ?? '?'}）`);
        console.error(`  那次发送在写"已发送"标记之前就中断了，所以现在无法判断 Gmail 到底收没收到。`);
        console.error(`\n  **重试可能发出第二封。** 请先核查：`);
        console.error(dim(`    ① 去 Gmail 的「已发送」里找这封信：${subject}`));
        console.error(dim(`       收件人 ${to}`));
        console.error(dim(`    ② 如果已经发出去了：node scripts/mail-send.mjs ${id} --mark-sent`));
        console.error(dim(`    ③ 如果确认没发出去（已发送里没有）：node scripts/mail-send.mjs ${id} --clear-sending`));
        console.error(`\n  ${dim('这不是故障，是设计：分不清"没发"和"发了没记住"时，只能问人。')}`);
      } else {
        console.error(`${red('✗')} 有上一次发送未收尾的标记，而且草稿已经改过。\n`);
        console.error(`  标记时间：${marker.at || '(不详)'}`);
        console.error(`  标记里的载荷与现在的草稿**不是同一封** —— 需要你先确认上一封的下落。`);
        console.error(dim(`    核查后：--clear-sending（确认没发出去）或 --mark-sent（确认已发出）`));
      }
      process.exit(2);
    }

    if (dryRun) {
      stopHeartbeat();
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

    const mime = buildMime({ to, subject, body: draft.body });

    // ★ 标记必须**先于**网络调用落盘。
    //   顺序反了（先发再记）就回到了这次修掉的那个洞：
    //   Gmail 收到了、进程崩了、本地什么痕迹都没有 → 重试双发。
    writeSendMarker(id, nowPayload);

    let sent;
    try {
      sent = await gmailFetch('/users/me/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: Buffer.from(mime, 'utf8').toString('base64url') }),
      });
    } catch (err) {
      stopHeartbeat();
      console.error(`${red('✗')} 发送失败：${err.message}`);
      // 失败分两种，**不能一概而论**：
      //   ① 服务端明确拒绝（4xx：权限/参数/配额）→ Gmail 没接受这封信 → 清标记，可以重试
      //   ② 网络层失败 / 429 / 5xx → **结果未知**（请求可能已经到达并被处理）→ 留标记，让人核查
      // 原来这里只打印一句"可以重试"，那是把 ② 也当成 ① 了 —— 而 ② 重试就是双发。
      //
      // 判据用 `unknownOutcome`（由 gmailFetch 打在错误对象上），不看错误消息里的数字：
      // **从人看的文案里解析状态码**是这个项目明确反对过的做法
      // （`mail-send.mjs` 里 `parseSendOutput` 那个注释讲过同一件事）。
      const unknown = err.unknownOutcome === true;
      if (!unknown) {
        clearSendMarker(id);
        console.error(dim(`  服务端明确拒绝了这封信 —— 可以重试。`));
      } else {
        console.error(`${yellow('!')} 这次失败**结果未知** —— 标记保留。`);
        console.error(dim(`  重试前先查 Gmail 的「已发送」里有没有它；确认没发出去再跑：`));
        console.error(dim(`    node scripts/mail-send.mjs ${id} --clear-sending`));
      }
      process.exit(1);
    }

    setFrontmatter(readDraft(id), {
      sent_at: new Date().toISOString(),
      sent_message_id: sent.id,
    });
    // 发送成功、sent_at 已落盘 → 三态收敛到"发过了"，标记可以撤
    clearSendMarker(id);
    stopHeartbeat();

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
