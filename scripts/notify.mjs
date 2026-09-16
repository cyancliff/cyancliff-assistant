#!/usr/bin/env node
/**
 * notify.mjs — 把一条消息推到手机（飞书 webhook）· 命令行入口
 *
 *   node scripts/notify.mjs "构建失败了"
 *   node scripts/notify.mjs --title "待确认草稿" --file path/to/draft.md
 *   node scripts/notify.mjs "测试" --dry-run
 *   echo "从 stdin 读" | node scripts/notify.mjs -
 *
 * 可复用的部分在 notify-lib.mjs —— 那边没有任何顶层副作用，可以放心 import。
 * 这个文件只做：解析参数、读输入、把结果翻译成退出码和人话。
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
 * 退出码: 0 成功（或 --dry-run）  1 发送失败  2 用法/配置错误
 */

import { readFileSync, existsSync } from 'node:fs';
import { sendNotify, getEnv, truncateBody, maskWebhook, ENV_PATH } from './notify-lib.mjs';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = c(31);
const green = c(32);
const yellow = c(33);
const dim = c(2);
const bold = c(1);

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--title', '--file', '--url']);
const flagValue = (n) => {
  const i = args.indexOf(n);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};

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

const preview = truncateBody(body);
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

if (dryRun) {
  console.log(`${yellow('dry-run')} ${dim('（没有发送任何东西）')}\n`);
  console.log(`  ${bold('目标')}  ${maskWebhook(webhook)}`);
  console.log(`  ${bold('签名')}  ${secret ? '会带上' : '未配置（机器人没开签名校验就不用）'}`);
  console.log(`  ${bold('形式')}  ${title ? `交互卡片，标题「${title}」` : '纯文本'}`);
  console.log(`  ${bold('长度')}  ${body.length} 字符${preview.truncated ? '（已截断）' : ''}\n`);
  console.log(dim('  ── 正文 ──'));
  for (const line of preview.body.split('\n')) console.log(`  ${line}`);
  console.log('');
  process.exit(0);
}

const r = await sendNotify({ body, title, webhook, secret });

if (!r.ok) {
  if (r.reason === 'network') {
    console.error(`${red('✗')} 请求发不出去：${r.detail}`);
    console.error(dim('  检查网络，或者 webhook 地址是否还完整。'));
  } else if (r.reason === 'http') {
    console.error(`${red('✗')} ${r.detail}`);
    console.error(`  ${r.raw}`);
  } else if (r.reason === 'feishu') {
    console.error(`${red('✗')} 飞书拒绝了这条消息（${r.detail}）`);
    console.error(dim('  常见原因：机器人被移出群、webhook 被重置、内容含被拦截的词。'));
  } else {
    console.error(`${red('✗')} 发送失败：${r.reason}`);
  }
  process.exit(1);
}

console.log(
  `${green('✓')} 已推送${title ? dim(`（${title}）`) : ''} ${dim(`${r.chars} 字符`)}` +
    `${r.truncated ? dim('（已截断）') : ''}`
);
process.exit(0);
