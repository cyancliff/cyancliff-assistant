#!/usr/bin/env node
/**
 * setup.mjs — 配置引导（零依赖，不需要任何凭据就能跑）
 *
 *   node scripts/setup.mjs            看还差什么、每项怎么补
 *   node scripts/setup.mjs --check    只检查，不打印步骤（给别的脚本调）
 *
 * 为什么要这个东西：四项能力都写完并自测通过了，但**一条真实链路都没跑通**，
 * 缺的全是凭据，而那些凭据只能在浏览器/手机里手工拿。
 * 与其让人对着 README 找，不如把"还差什么、去哪儿拿、填到哪个文件的哪一行"
 * 一次打印出来。
 *
 * 这个脚本只读不写 —— 它不会替你创建 .env，也不会改任何配置文件。
 * 凭据得你自己填，因为那是你的账号。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_ROOT, ENV_PATH, getEnv, credentialsPath, tokenPath, readToken } from './gmail-auth.mjs';
import { findApiKey } from './mail-draft.mjs';

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

const onlyCheck = process.argv.includes('--check');

// ── 检查各项 ──────────────────────────────────────────────────
const envExists = existsSync(ENV_PATH);
const feishu = getEnv('FEISHU_WEBHOOK_URL');
const gmailCreds = existsSync(credentialsPath());
const gmailToken = Boolean(readToken());
const modelKey = findApiKey();

const items = [
  {
    name: '飞书 webhook',
    why: 'B 手机端联动：把草稿推到手机',
    done: Boolean(feishu),
    // 缺了会怎样 —— 这一栏是"你现在能做什么"和"缺了之后能做什么"的区别
    limit: '没有它：草稿只写在本机，手机上收不到；其余功能不受影响',
    how: [
      '飞书里建一个只有自己的群（或用一个现成的群）',
      '群设置 → 群机器人 → 添加机器人 → 自定义机器人',
      '给它起个名字，复制生成的 webhook 地址',
      `粘进 ${path.relative(ROOT, ENV_PATH)} 的这一行：`,
      '    FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/…',
      '',
      '如果建机器人时勾了「签名校验」，还要把密钥也填上：',
      '    FEISHU_WEBHOOK_SECRET=…',
      '',
      '填完验证：node scripts/notify.mjs "测试" --dry-run   然后去掉 --dry-run',
    ],
  },
  {
    name: 'Gmail API 凭据',
    why: 'C 邮件：取信',
    done: gmailCreds,
    limit: '没有它：取不了信，整条邮件流程起不来',
    how: [
      '打开 console.cloud.google.com，新建（或选）一个项目',
      '「API 和服务」→「库」→ 搜 Gmail API → 启用',
      '「API 和服务」→「OAuth 同意屏幕」：',
      '    用户类型选「外部」，填应用名，测试用户里加上你自己的 Gmail 地址',
      '    （不发布也能用，测试用户的授权有效期 7 天，到期重新授权即可）',
      '「凭据」→「创建凭据」→「OAuth 客户端 ID」→ 应用类型选「桌面应用」',
      '下载 JSON，存成：',
      `    ${path.relative(ROOT, credentialsPath())}`,
      '',
      '注意：下载的是**客户端**凭据，不是访问令牌 —— 别把这两个搞混。',
    ],
  },
  {
    name: 'Gmail 授权令牌',
    why: 'C 邮件：取信与发送',
    done: gmailToken,
    limit: '没有它：即使有了客户端凭据也调不通 API',
    how: [
      '上一步的凭据文件放好之后，跑：',
      '    node scripts/gmail-auth.mjs --auth',
      '会自动打开浏览器，点「同意」即可。令牌存到：',
      `    ${path.relative(ROOT, tokenPath())}`,
      '',
      '这一步必须你自己点 —— 它是你的账号授权，我代替不了。',
      '授权范围只有 gmail.readonly 和 gmail.send 两项，可以随时在',
      'Google 账号的「第三方访问」里撤销。',
    ],
  },
  {
    name: '模型密钥',
    why: 'C2 拟邮件草稿',
    done: Boolean(modelKey),
    limit: '没有它：草稿那一步跳过（可用 --template 出占位稿），其余功能不受影响',
    how: [
      '密钥已经在 DSH 的凭据库里（CMDGOAT_API_KEY）。',
      '助手不复制第二份 —— 那会让同一份凭据出现两个副本，轮换时要改两处。',
      '',
      '两种给法，选一个：',
      '  A. 设成用户级环境变量（推荐，一份真源两边用）：',
      '       setx CMDGOAT_API_KEY "<密钥>"',
      '     然后**重开终端**（环境变量不会在已开的进程里生效）',
      '',
      '  B. 写进 .env：',
      `       ${path.relative(ROOT, ENV_PATH)}`,
      '       ASSISTANT_MODEL_API_KEY=<密钥>',
      '',
      '密钥可以从 DSH 设置界面里看，或者你自己知道它在哪。',
      '**不要把它贴进对话、日志或提交信息。**',
    ],
  },
];

// ── --check：只报状态 ─────────────────────────────────────────
if (onlyCheck) {
  for (const it of items) console.log(`${it.done ? 'OK' : 'MISSING'}  ${it.name}`);
  process.exit(items.every((i) => i.done) ? 0 : 1);
}

// ── 打印 ──────────────────────────────────────────────────────
const doneCount = items.filter((i) => i.done).length;
const allDone = doneCount === items.length;

console.log(`\n${bold('配置引导')}  ${dim(`${doneCount}/${items.length} 项就绪`)}\n`);

console.log(`${bold('已经就绪的')}\n`);
for (const it of items.filter((i) => i.done)) {
  console.log(`  ${green('✓')} ${it.name}  ${dim(it.why)}`);
}

const missing = items.filter((i) => !i.done);
if (!missing.length) {
  console.log(`\n${green('✓')} 四项都配好了。`);
  console.log(`\n  下一步（会真的取信、发信）：`);
  console.log(`    node scripts/workflow.mjs mail:prepare     # 取信 → 拟稿 → 推手机`);
  console.log(`    node scripts/workflow.mjs mail:finish <id> --confirm   # 确认后发送`);
  console.log(`\n  ${dim('建议先用 --dry-run 走一遍看清楚会发什么：')}`);
  console.log(`  ${dim('  node scripts/mail-send.mjs <id> --send --dry-run')}\n`);
  process.exit(0);
}

console.log(`\n${bold('还差的')}\n`);
for (const it of missing) {
  console.log(`${yellow('○')} ${bold(it.name)}  ${dim(it.why)}`);
  console.log(`  ${dim(it.limit)}`);
  console.log('');
  for (const line of it.how) {
    console.log(line ? `    ${line}` : '');
  }
  console.log('');
}

console.log(`${dim('─'.repeat(60))}`);
console.log(`\n填完之后回来跑一次：${cyan('node scripts/setup.mjs')}`);
console.log(`随时看整条链的状态：${cyan('node scripts/workflow.mjs mail:status')}\n`);
console.log(dim('这个脚本只读不写 —— 凭据得你自己填，因为那是你的账号。\n'));

process.exit(1);
