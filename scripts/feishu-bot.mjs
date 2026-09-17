#!/usr/bin/env node
/**
 * feishu-bot.mjs — 传输层与入口
 *
 * 编排逻辑全在 `feishu-core.mjs`（不 import SDK，端口注入，可测）。
 * 这里只做三件事：接飞书长连接、把副作用接成真的、管住生命周期。
 *
 * ── 为什么不重新实现发信 ────────────────────────────────────────
 * 「确认才发送」那两道闸门在 `mail-send.mjs` 里。这个 bot **调用它**，
 * 不复制它的逻辑 —— 复制出来的第二份一定会慢慢和第一份不一致，
 * 而不一致的后果是"网页端拦得住、手机端拦不住"。
 *
 * ── 为什么判断子进程成败看输出不看退出码 ────────────────────────
 * 这个项目在 Windows 上有一个未解决的 Node 问题：走过代理之后，
 * 进程退出时会撞 libuv 断言，退出码变成 3221226505，**而输出完整正确**。
 * 已经试过三种修法都无效，如实记在 `proxy.mjs` 的注释里。
 * 所以这里一律**按输出判断**，不看退出码 —— 否则每次成功都会被当成失败。
 */

import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import lark from '@larksuiteoapi/node-sdk';

import { createCore } from './feishu-core.mjs';
import { readDraft, listDrafts, writeConfirm, confirmPath, parseSendOutput } from './mail-send.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DATA_ROOT = path.join(ROOT, 'Personal Memory');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const bold = c(1), dim = c(2), red = c(31), green = c(32), yellow = c(33), cyan = c(36);

// ── .env（与其它脚本同样的解析，刻意保持行为一致）─────────────
function parseEnvFile(f) {
  const vars = {};
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v !== '') vars[m[1]] = v;
  }
  return vars;
}

function resolveEnvPath() {
  const candidates = [path.join(DATA_ROOT, '.env'), path.join(ROOT, '.env')];
  if (process.env.ASSISTANT_ENV) candidates.unshift(path.resolve(process.env.ASSISTANT_ENV));
  for (const f of candidates) if (existsSync(f)) return f;
  return candidates[0];
}

const ENV_PATH = resolveEnvPath();
const envFile = existsSync(ENV_PATH) ? parseEnvFile(ENV_PATH) : {};
const getEnv = (k) => process.env[k] || envFile[k] || '';

const APP_ID = getEnv('FEISHU_APP_ID');
const APP_SECRET = getEnv('FEISHU_APP_SECRET');
const OWNER = getEnv('FEISHU_OWNER_OPEN_ID');

/** 停止文件：不想开终端也能停掉它。 */
const STOP_FILE = path.join(DATA_ROOT, '.stop-feishu-bot');

// ── 子进程 ────────────────────────────────────────────────────
function run(script, args, { timeout = 180000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(HERE, script), ...args],
      { cwd: ROOT, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' })
    );
  });
}

async function runJson(script, args) {
  const r = await run(script, args);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`${script} 没有返回 JSON。stderr: ${r.stderr.slice(0, 300) || '(空)'}`);
  }
}

// ── 进程内的发送锁 ────────────────────────────────────────────
// core 需要"拿不到就报忙"的语义（这样卡片上能写"正在发送中"），
// 所以要的是 try-lock，不是排队。
// 跨进程那层锁在 mail-send.mjs 里（子进程自己会拿）。
const sending = new Set();

// ── 真端口 ────────────────────────────────────────────────────
function makePorts(channel, { log }) {
  const T = (s) => String(s == null ? '' : s).trim();

  return {
    log,

    // 发送
    sendCard: (chatId, card, opts) => channel.send(chatId, { card }, opts),
    sendText: (chatId, text, opts) => channel.send(chatId, { text }, opts),
    updateCard: (messageId, card) => channel.updateCard(messageId, card),

    // 草稿
    readDraft: (id) => {
      const d = readDraft(id);
      if (!d) return null;
      return { id, fm: d.fm || {}, body: d.body || '' };
    },
    listDrafts: () => listDrafts().map((id) => ({ id })),

    draftFor: async (id) => {
      // 走现成的拟稿脚本，不重写提示组装与模型调用
      const r = await run('mail-draft.mjs', [id]);
      if (/✗/.test(r.stdout + r.stderr)) {
        const line = (r.stdout + r.stderr).split('\n').find((l) => l.includes('✗')) || '拟稿失败';
        throw new Error(line.trim());
      }
      const d = readDraft(id);
      return d ? d.body || '' : '';
    },

    confirmDraft: (id, via) => {
      const d = readDraft(id);
      if (!d) throw new Error(`找不到草稿 ${id}`);
      const rec = writeConfirm(id, d, via);
      log(`已写确认记录 ${path.basename(confirmPath(id))}（${rec.body_chars} 字符）`);
      return rec;
    },

    /**
     * 真发信。
     *
     * 调 `mail-send.mjs --send` —— **闸门在那边**，这里不复制。
     * 成败由 `parseSendOutput` 判断（看输出，不看退出码，理由见那个函数的注释）。
     */
    sendDraft: async (id) => {
      const r = await run('mail-send.mjs', [id, '--send']);
      const parsed = parseSendOutput(r.stdout, r.stderr);
      if (!parsed.ok && r.err && r.err.killed) {
        return { ok: false, reason: '超时（发送可能仍在进行，别急着重试）' };
      }
      return parsed;
    },

    withSendLock: async (id, fn) => {
      if (sending.has(id)) {
        return { acquired: false, reason: 'busy', holder: '本进程内的另一个回调', ageMs: 0 };
      }
      sending.add(id);
      try {
        return { acquired: true, value: await fn() };
      } finally {
        sending.delete(id);
      }
    },

    // 业务
    mailSummary: async ({ limit = 60 } = {}) => {
      const j = await runJson('mail-triage.mjs', ['--json', '--limit', String(limit)]);
      const rows = j.rows || [];
      return {
        scanned: j.scanned ?? rows.length,
        counts: {
          signal: rows.filter((r) => r.kind === 'signal').length,
          plain: rows.filter((r) => r.kind === 'plain').length,
          noise: rows.filter((r) => r.kind === 'noise').length,
        },
        items: rows
          .filter((r) => r.kind !== 'noise')
          .sort((a, b) => (b.weight || 0) - (a.weight || 0))
          .map((r) => ({ subject: r.subject || '(无主题)', from: r.from || '(未知发件人)', kind: r.kind })),
      };
    },

    findQuote: async (kw) => {
      const j = await runJson('find-quote.mjs', [kw, '--root', path.join(DATA_ROOT, 'data'), '--json']);
      return (j.hits || []).map((h) => ({ file: h.file, line: h.line, text: h.text }));
    },

    status: async () => {
      const rows = [];
      rows.push(`**主人**　${OWNER ? `\`${OWNER}\`` : '**还没配**（只能回认领提示）'}`);
      rows.push(`**App ID**　\`${APP_ID || '(缺)'}\``);
      rows.push(`**凭据来源**　\`${ENV_PATH}\``);

      const drafts = listDrafts();
      const unsent = drafts.filter((d) => !d.fm?.sent_at);
      rows.push(`**草稿**　共 ${drafts.length} 份，未发送 ${unsent.length} 份`);

      let ws = '(未知)';
      try {
        const st = channel.getConnectionStatus?.();
        ws = st ? `\`${st.state || JSON.stringify(st)}\`` : '长连接（无状态信息）';
      } catch {
        /* 拿不到就算了，不该因为状态查不到就整个失败 */
      }
      rows.push(`**连接**　${ws}`);
      rows.push(`**发送中**　${sending.size ? [...sending].map((s) => `\`${s}\``).join('、') : '无'}`);
      rows.push('');
      rows.push(`_停止文件：\`${path.relative(ROOT, STOP_FILE)}\`_`);
      return rows;
    },

    stop: (why) => stop(why),
  };
}

// ── 生命周期 ──────────────────────────────────────────────────
let stopping = false;

async function stop(why, { channel, exitCode = 0 } = {}) {
  if (stopping) return;
  stopping = true;
  console.log(`\n  ${yellow('…')} 正在停止（${why}）`);
  try {
    await channel?.disconnect();
  } catch {
    /* 断开失败无所谓，反正在退出 */
  }
  try {
    rmSync(STOP_FILE, { force: true });
  } catch {
    /* 尽力而为 */
  }
  console.log(`  ${green('✓')} 已停止\n`);
  process.exit(exitCode);
}

// ── 入口 ──────────────────────────────────────────────────────
const HELP = `
${bold('feishu-bot.mjs')} — 可交互飞书机器人的常驻进程

  node scripts/feishu-bot.mjs            启动（长连接）
  node scripts/feishu-bot.mjs --status   只看配置，不连
  node scripts/feishu-bot.mjs --help

${dim('停止：对话里发 /停、Ctrl+C、或创建 ' + path.relative(ROOT, STOP_FILE))}
`;

function requireCreds() {
  const missing = [];
  if (!APP_ID) missing.push('FEISHU_APP_ID');
  if (!APP_SECRET) missing.push('FEISHU_APP_SECRET');
  if (missing.length) {
    console.error(`\n  ${red('✗')} 还没有 ${missing.join(' / ')}`);
    console.error(`\n    从开发者后台 → 你的应用 → 凭证与基础信息 复制，填进：`);
    console.error(`      ${ENV_PATH}\n`);
    process.exit(2);
  }
}

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

if (args.includes('--status')) {
  console.log(`\n${bold('飞书 bot 配置')}\n`);
  console.log(`  ${dim('App ID')}   ${APP_ID || red('(缺)')}`);
  console.log(`  ${dim('App Secret')} ${APP_SECRET ? green('已配') : red('(缺)')}`);
  console.log(`  ${dim('主人')}     ${OWNER ? cyan(OWNER) : yellow('(未配 —— 只会回认领提示)')}`);
  console.log(`  ${dim('.env')}     ${ENV_PATH}`);
  console.log(`  ${dim('停止文件')} ${STOP_FILE}${existsSync(STOP_FILE) ? red('  ← 存在，启动后会立刻退出') : ''}`);
  console.log('');
  process.exit(0);
}

requireCreds();

if (existsSync(STOP_FILE)) {
  console.error(`\n  ${yellow('⚠')} 停止文件存在：${STOP_FILE}`);
  console.error(`    删掉它再启动，或者这正是你想要的（不想让它跑）。\n`);
  process.exit(0);
}

const log = (m) => console.log(`  ${dim(new Date().toLocaleTimeString('zh-CN'))} ${m}`);

console.log(`\n${bold('飞书 bot')}`);
console.log(`  ${dim('App ID')} ${APP_ID}`);
console.log(`  ${dim('主人')}   ${OWNER ? cyan(OWNER) : yellow('(未配 —— 只会回认领提示，不执行任何操作)')}`);
console.log('');

const channel = lark.createLarkChannel({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: lark.LoggerLevel.info,
  // 私人入口：单聊放开，群聊一律不理（core 里还会再判一次）
  policy: { requireMention: false, dmMode: 'open' },
});

const core = createCore({ ports: makePorts(channel, { log }), ownerOpenId: OWNER });

channel.on('message', async (msg) => {
  log(`收到消息 ${cyan(msg.senderId)} · ${JSON.stringify(String(msg.content).slice(0, 40))}`);
  await core.handleMessage({
    chatId: msg.chatId,
    chatType: msg.chatType,
    senderId: msg.senderId,
    messageId: msg.messageId,
    content: msg.content,
  });
});

channel.on('cardAction', async (evt) => {
  await core.handleCardAction({
    messageId: evt.messageId,
    chatId: evt.chatId,
    operator: evt.operator,
    action: evt.action,
    raw: evt.raw,
  });
});

channel.on('error', (err) => console.error(`  ${red('✗')} ${err.code || ''} ${err.message}`));
channel.on('reconnecting', () => log(`${yellow('…')} 连接断开，重连中`));
channel.on('reconnected', () => log(`${green('✓')} 已重连`));

try {
  await channel.connect();
} catch (e) {
  console.error(`\n  ${red('✗')} 连接失败：${e.code || ''} ${e.message}\n`);
  console.error(`    ${dim('permission_denied → App ID/Secret 不对，或应用没发版')}`);
  console.error(`    ${dim('not_connected      → 网络不通（这个项目要过代理，见 scripts/proxy.mjs）')}\n`);
  process.exit(1);
}

console.log(`  ${green('✓')} 已连接${channel.botIdentity ? ` —— ${bold(channel.botIdentity.name || APP_ID)}` : ''}`);
console.log(`  ${dim('在飞书里发 /帮助 看看。Ctrl+C 停止。')}\n`);
log('已就绪');

// 停止文件轮询：不开终端也能停
const watch = setInterval(() => {
  if (existsSync(STOP_FILE)) stop('检测到停止文件', { channel });
}, 2000);
watch.unref?.();

process.on('SIGINT', () => stop('Ctrl+C', { channel }));
process.on('SIGTERM', () => stop('SIGTERM', { channel }));
