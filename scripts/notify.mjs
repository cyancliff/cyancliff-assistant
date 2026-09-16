#!/usr/bin/env node
/**
 * notify.mjs — 把一条消息推到手机（飞书自定义机器人 webhook）
 *
 *   node scripts/notify.mjs "构建失败了"
 *   node scripts/notify.mjs --title "待确认草稿" --file path/to/draft.md
 *   node scripts/notify.mjs "测试" --dry-run
 *   echo "从 stdin 读" | node scripts/notify.mjs -
 *
 * 为什么用 webhook 而不是飞书应用：
 *
 *   webhook 不需要公网可达的回调地址，也就是不需要常驻服务 + 隧道。
 *   代价是**单向** —— 只能推送，收不到你的操作。
 *   按钮回调需要应用 + 公网 HTTPS 地址，那是另一个量级的维护成本。
 *   所以这个工具只解决"看"，不解决"改和确认"。别把它当成双向通道。
 *
 * 凭据:
 *   FEISHU_WEBHOOK_URL    必需。飞书群 → 添加自定义机器人 → 复制 webhook 地址
 *   FEISHU_WEBHOOK_SECRET 可选。机器人开了"签名校验"才需要
 *
 *   只从 .env 读，也可以直接用环境变量覆盖。凭据永远不写进代码或日志。
 *
 * 退出码: 0 成功（或 --dry-run）  1 发送失败  2 用法/配置错误
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ── .env ──────────────────────────────────────────────────────
/**
 * 极简 .env 解析。只认 KEY=VALUE，忽略注释和空行。
 *
 * 不引第三方库是刻意的：这个项目零依赖，而且 .env 的格式简单到
 * 不值得为它装一个包。真出现带引号/多行的值再换成正经解析器。
 */
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

/**
 * .env 在哪：脚本住公开仓，但**凭据属于私有数据**，所以私有仓的 .env 优先。
 *
 * 顺序：
 *   1. $ASSISTANT_ENV 指定的文件（要放别处时用这个）
 *   2. <仓库根>/Personal Memory/.env   ← 正常情况
 *   3. <仓库根>/.env                   ← 只有公开仓时
 *   4. 往上找几层
 */
function resolveEnvPath() {
  const candidates = [];
  const explicit = process.env.ASSISTANT_ENV;
  if (explicit) candidates.push(path.resolve(explicit));
  candidates.push(path.join(ROOT, 'Personal Memory', '.env'));
  candidates.push(path.join(ROOT, '.env'));
  let dir = path.dirname(ROOT);
  for (let i = 0; i < 3; i++) {
    candidates.push(path.join(dir, '.env'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const f of candidates) if (existsSync(f)) return f;
  return candidates[0]; // 都不存在时返回首选路径，好让报错指对地方
}

const ENV_PATH = resolveEnvPath();
const envFile = existsSync(ENV_PATH) ? parseEnvFile(ENV_PATH) : {};
/** 进程环境变量优先，其次 .env。 */
const getEnv = (k) => process.env[k] || envFile[k] || '';

// ── 参数 ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--title', '--file', '--url']);

function flagValue(name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = c(31);
const green = c(32);
const yellow = c(33);
const dim = c(2);
const bold = c(1);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`${bold('notify.mjs')} — 把一条消息推到手机（飞书 webhook）

  node scripts/notify.mjs <消息>
  node scripts/notify.mjs <消息> --title <标题>
  node scripts/notify.mjs --file <文件>        # 把文件内容当消息体
  echo <消息> | node scripts/notify.mjs -      # 从 stdin 读
  node scripts/notify.mjs <消息> --dry-run     # 只打印，不发

  --url <地址>   覆盖 .env 里的 FEISHU_WEBHOOK_URL

  ${dim('凭据：FEISHU_WEBHOOK_URL（必需）、FEISHU_WEBHOOK_SECRET（开了签名校验才需要）')}
  ${dim('这个通道是单向的 —— 只推送，收不到操作。')}
`);
  process.exit(0);
}

const dryRun = args.includes('--dry-run');
const title = flagValue('--title');
const filePath = flagValue('--file');

const positional = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]));

let body = '';
if (filePath) {
  if (!existsSync(filePath)) {
    console.error(`${red('✗')} 文件不存在：${filePath}`);
    process.exit(2);
  }
  body = readFileSync(filePath, 'utf8');
} else if (positional[0] === '-') {
  body = readFileSync(0, 'utf8');
} else if (positional.length) {
  body = positional.join(' ');
} else {
  console.error(`${red('✗')} 没给消息内容。用 --help 看用法。`);
  process.exit(2);
}

body = body.trim();
if (!body) {
  console.error(`${red('✗')} 消息是空的，不发。`);
  process.exit(2);
}

// ── 组装卡片 ──────────────────────────────────────────────────
// 飞书 webhook 单条消息有长度上限，太长会被拒。截断并**说明截断了** ——
// 悄悄截断会让人以为看到了全文。
const MAX_CHARS = 4000;
let truncated = false;
if (body.length > MAX_CHARS) {
  body = body.slice(0, MAX_CHARS) + `\n\n…（还有 ${body.length - MAX_CHARS} 字符未显示）`;
  truncated = true;
}

const card = title
  ? {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: title }, template: 'blue' },
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: body } }],
      },
    }
  : { msg_type: 'text', content: { text: body } };

const webhook = flagValue('--url') || getEnv('FEISHU_WEBHOOK_URL');
const secret = getEnv('FEISHU_WEBHOOK_SECRET');

if (!webhook) {
  console.error(`${red('✗')} 没有 FEISHU_WEBHOOK_URL。\n`);
  console.error('  在飞书群里加一个自定义机器人，把 webhook 地址写进 .env：\n');
  console.error(dim('    飞书群 → 设置 → 群机器人 → 添加机器人 → 自定义机器人'));
  console.error(dim('    复制 webhook 地址，写进：'));
  console.error(`      ${ENV_PATH}${existsSync(ENV_PATH) ? '' : dim('  ← 这个文件还不存在，新建它')}\n`);
  console.error(dim('  只想看会发生什么的话，加 --dry-run。'));
  process.exit(2);
}

// 开了签名校验才需要：sign = base64(HMAC-SHA256(key = timestamp + "\n" + secret, data = ""))
if (secret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sign = createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
  card.timestamp = timestamp;
  card.sign = sign;
}

// ── 发送 ──────────────────────────────────────────────────────
/**
 * webhook 地址里的 token 就是凭据本身 —— 拿到它就能往你的群里发消息。
 * 打印时一律遮掉，两种常见形式都覆盖：
 *   https://open.feishu.cn/open-apis/bot/v2/hook/<token>   ← 飞书
 *   https://example.com/hook?token=<token>                 ← 查询参数形式
 */
function maskWebhook(url) {
  return url
    .replace(/(\/hook\/)[^/?#\s]+/, '$1<已隐去>')
    .replace(/([?&](?:hook|token|key|access_token)=)[^&\s]+/gi, '$1<已隐去>');
}

if (dryRun) {
  console.log(`${yellow('dry-run')} ${dim('（没有发送任何东西）')}\n`);
  console.log(`  ${bold('目标')}  ${maskWebhook(webhook)}`);
  console.log(`  ${bold('签名')}  ${secret ? '会带上' : '未配置（机器人没开签名校验就不用）'}`);
  console.log(`  ${bold('形式')}  ${title ? `交互卡片，标题「${title}」` : '纯文本'}`);
  console.log(`  ${bold('长度')}  ${body.length} 字符${truncated ? '（已截断）' : ''}\n`);
  console.log(dim('  ── 正文 ──'));
  for (const line of body.split('\n')) console.log(`  ${line}`);
  console.log('');
  process.exit(0);
}

let res;
try {
  res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(card),
  });
} catch (err) {
  console.error(`${red('✗')} 请求发不出去：${err.message}`);
  console.error(dim('  检查网络，或者 webhook 地址是否还完整。'));
  process.exit(1);
}

const text = await res.text();
let json = null;
try {
  json = JSON.parse(text);
} catch {
  /* 飞书正常返回 JSON；不是 JSON 也要把原文打出来，不然没法排查 */
}

// 飞书的坑：HTTP 200 不代表成功，业务错误在 body.code 里。
// 只看 status 会把"机器人被移出群"这类失败当成发送成功。
if (!res.ok) {
  console.error(`${red('✗')} HTTP ${res.status}`);
  console.error(`  ${text.slice(0, 400)}`);
  process.exit(1);
}
if (json && json.code !== undefined && json.code !== 0) {
  console.error(`${red('✗')} 飞书拒绝了这条消息（code=${json.code}）`);
  console.error(`  ${json.msg || text.slice(0, 200)}`);
  console.error(dim('  常见原因：机器人被移出群、webhook 被重置、内容含被拦截的词。'));
  process.exit(1);
}

console.log(`${green('✓')} 已推送${title ? dim(`（${title}）`) : ''} ${dim(`${body.length} 字符`)}`);
process.exit(0);
