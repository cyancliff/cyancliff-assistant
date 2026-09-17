#!/usr/bin/env node
/**
 * feishu-probe.mjs — 阶段 1 打样：把长连接挂起来，证明三件事
 *
 *   1. 凭据对不对            —— 连接能不能建起来（起不来就是 App ID/Secret 不对）
 *   2. 能不能收到消息        —— 顺便把**你的 open_id** 打出来（这是要填进 .env 的那个）
 *   3. 卡片按钮能不能走长连接 —— **整个方案的地基**
 *
 * 第 3 件事为什么必须单独验：
 *   SDK 的 README 写着「目前长连接只支持事件订阅，不支持回调订阅」，
 *   而同一个仓库的 docs/channel.md 提供 cardAction 事件、transport 默认 websocket，
 *   飞书平台文档三处也说回调支持长连接。**文档互相矛盾。**
 *   没验之前不能往上盖东西 —— 否则后面所有代码都建在一个"文档说有"的假设上。
 *
 * 用法：
 *   node scripts/feishu-probe.mjs              连接并监听（默认）
 *   node scripts/feishu-probe.mjs --card <open_id>   给某人发一张带按钮的测试卡片
 *   node scripts/feishu-probe.mjs --help
 *
 * ⚠️ 这是**打样脚本，不是正式 bot**。它不对发送者做身份校验（正式 bot 会），
 *    因为它唯一的用途是让你在还没配 FEISHU_OWNER_OPEN_ID 时先拿到自己的 open_id。
 *    它除了回显标识符以外**什么都不做** —— 不改任何状态、不碰邮件。
 *
 * 前置：飞书后台已订阅 im.message.receive_v1（不然输入框都不出现）、
 *       以及 card.action.trigger（不然按钮不触发）。
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import lark from '@larksuiteoapi/node-sdk';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const bold = c(1), dim = c(2), red = c(31), green = c(32), yellow = c(33), cyan = c(36);

// ── .env（与 notify.mjs / gmail-auth.mjs 同样的解析，刻意保持行为一致）────
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
  const candidates = [path.join(ROOT, 'Personal Memory', '.env'), path.join(ROOT, '.env')];
  if (process.env.ASSISTANT_ENV) candidates.unshift(path.resolve(process.env.ASSISTANT_ENV));
  for (const f of candidates) if (existsSync(f)) return f;
  return candidates[0];
}

const ENV_PATH = resolveEnvPath();
const envFile = existsSync(ENV_PATH) ? parseEnvFile(ENV_PATH) : {};
const getEnv = (k) => process.env[k] || envFile[k] || '';

const APP_ID = getEnv('FEISHU_APP_ID');
const APP_SECRET = getEnv('FEISHU_APP_SECRET');

// ── 卡片 JSON 2.0 ─────────────────────────────────────────────
// 必须用 2.0：飞书官方 FAQ 点名，**按钮不触发最常见的原因就是用 1.0 卡片结构**。
// 1.0 的 `"tag": "action"` 交互模块在 2.0 里已不支持。
//
// 按钮的回传值放两个地方：`behaviors[].value` 与同级的 `value`。
// 官方两处文档说法不一致（channel.md 说放 behaviors 里，Button 文档说
// `action.value` 对应组件的 `value` 属性）。打样就是为了查清哪个真的生效，
// 所以两个都放，然后把**原始回调体**打出来 —— 不猜。
export function probeCard(nonce) {
  const value = { probe: 'ping', nonce };
  return {
    schema: '2.0',
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '打样：按钮能不能走长连接' },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            '**点一下下面这个按钮。**',
            '',
            '这个脚本要验证的是：卡片按钮的点击能不能通过**长连接**收到。',
            'SDK 的 README 说不能，它的 channel.md 和飞书平台文档说能。',
            '',
            `nonce: \`${nonce}\``,
          ].join('\n'),
        },
        {
          tag: 'column_set',
          flex_mode: 'flow',
          columns: [
            {
              tag: 'column',
              width: 'auto',
              weight: 1,
              elements: [
                {
                  tag: 'button',
                  type: 'primary',
                  text: { tag: 'plain_text', content: '点我' },
                  behaviors: [{ type: 'callback', value }],
                  value,
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

const HELP = `
${bold('feishu-probe.mjs')} — 阶段 1 打样

  node scripts/feishu-probe.mjs                    连接并监听（默认）
  node scripts/feishu-probe.mjs --card <open_id>   发一张带按钮的测试卡片
  node scripts/feishu-probe.mjs --help             看这个

${dim('凭据从 ' + ENV_PATH + ' 读：FEISHU_APP_ID / FEISHU_APP_SECRET')}
`;

function die(msg) {
  console.error(`\n  ${red('✗')} ${msg}\n`);
  process.exit(1);
}

function requireCreds() {
  const missing = [];
  if (!APP_ID) missing.push('FEISHU_APP_ID');
  if (!APP_SECRET) missing.push('FEISHU_APP_SECRET');
  if (missing.length) {
    die(
      `还没有 ${missing.join(' / ')}\n\n` +
        `    从开发者后台 → 你的应用 → 凭证与基础信息 复制，填进：\n` +
        `      ${ENV_PATH}\n\n` +
        `    ${dim('（别贴进对话 —— 会进会话记录）')}`
    );
  }
  if (!APP_ID.startsWith('cli_')) {
    console.error(`  ${yellow('⚠')} FEISHU_APP_ID 不以 cli_ 开头，确认一下是不是复制错了\n`);
  }
}

// ── --card：发一张带按钮的卡片（不需要长连接，直接调 HTTP API）──────
async function sendCard(receiveId) {
  requireCreds();
  const nonce = Math.random().toString(36).slice(2, 10);
  const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET });

  const res = await client.im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: receiveId,
      content: JSON.stringify(probeCard(nonce)),
      msg_type: 'interactive',
    },
  });

  if (res.code !== 0) {
    console.error(`\n  ${red('✗')} 发卡片失败：code=${res.code} msg=${res.msg}`);
    console.error(`    ${dim('常见原因：可用范围没包含这个人 / 应用没发版 / open_id 不对')}\n`);
    process.exit(1);
  }

  console.log(`\n  ${green('✓')} 卡片已发（message_id: ${res.data.message_id}）`);
  console.log(`    nonce: ${cyan(nonce)}`);
  console.log(`\n    现在：去飞书点那个「点我」按钮，看这个终端有没有反应。\n`);
}

// ── 默认：连接 + 监听 ─────────────────────────────────────────
async function listen() {
  requireCreds();

  console.log(`\n${bold('飞书长连接打样')}`);
  console.log(`  ${dim('凭据')} ${ENV_PATH}`);
  console.log(`  ${dim('App ID')} ${APP_ID}`);
  console.log('');

  // 这个打样脚本刻意放宽策略：要能在还没配 owner 的时候收到你的第一条消息。
  const channel = lark.createLarkChannel({
    appId: APP_ID,
    appSecret: APP_SECRET,
    loggerLevel: lark.LoggerLevel.info,
    includeRawInMessage: true,
    policy: { requireMention: false, dmMode: 'open' },
  });

  channel.on('message', async (msg) => {
    const kind = msg.chatType === 'p2p' ? '单聊' : '群聊';
    console.log(`\n${bold('── 收到消息 ─────────────────────────────')}`);
    console.log(`  ${dim('类型')}      ${kind}`);
    console.log(`  ${dim('发送者')}    ${cyan(msg.senderId)}   ${dim('← 这就是要填进 .env 的 FEISHU_OWNER_OPEN_ID')}`);
    console.log(`  ${dim('会话')}      ${cyan(msg.chatId)}`);
    console.log(`  ${dim('messageId')} ${msg.messageId}`);
    console.log(`  ${dim('内容')}      ${JSON.stringify(msg.content)}`);

    try {
      await channel.send(
        msg.chatId,
        {
          markdown: [
            `**你的 open_id**：\`${msg.senderId}\``,
            '',
            `**会话 chat_id**：\`${msg.chatId}\``,
            '',
            '把 open_id 填进 `.env` 的 `FEISHU_OWNER_OPEN_ID=`，然后告诉助手。',
          ].join('\n'),
        },
        { replyTo: msg.messageId }
      );
      console.log(`  ${green('✓')} 已回复`);
    } catch (e) {
      console.log(`  ${red('✗')} 回复失败：${e.message}`);
    }
  });

  // ★ 这一步就是整块地基
  channel.on('cardAction', async (evt) => {
    console.log(`\n${bold('★ 收到卡片按钮回调 ───────────────────────')}`);
    console.log(`  ${green('长连接确实能收卡片回调。')} README 那句是过时的。`);
    console.log(`  ${dim('点击者')}    ${cyan(evt.operator?.openId)}`);
    console.log(`  ${dim('messageId')} ${evt.messageId}`);
    console.log(`  ${dim('chatId')}    ${evt.chatId}`);
    console.log(`  ${dim('按钮 tag')}  ${evt.action?.tag}`);
    console.log(`  ${dim('按钮 value')} ${JSON.stringify(evt.action?.value)}`);
    if (evt.raw) {
      const raw = evt.raw;
      console.log(`  ${dim('event_id')}  ${raw?.header?.event_id}   ${dim('← 幂等 key 可以用它')}`);
      console.log(`  ${dim('原始 action')} ${JSON.stringify(raw?.event?.action)}`);
    }
    console.log('');

    // 顺手把卡片改掉，验证 updateCard 也能用
    try {
      await channel.updateCard(evt.messageId, {
        schema: '2.0',
        header: { template: 'green', title: { tag: 'plain_text', content: '打样成功' } },
        body: {
          elements: [
            {
              tag: 'markdown',
              content: `按钮回调收到于 ${new Date().toLocaleTimeString('zh-CN')}。\n\n长连接支持卡片回调 —— 方案成立。`,
            },
          ],
        },
      });
      console.log(`  ${green('✓')} 卡片已更新（updateCard 也能用）`);
    } catch (e) {
      console.log(`  ${yellow('⚠')} 卡片更新失败：${e.message}`);
      console.log(`    ${dim('回调本身是通的，只是更新卡片这一步有问题 —— 两个问题要分开看')}`);
    }
    console.log('');
  });

  channel.on('error', (err) => {
    console.error(`\n  ${red('✗')} 收消息出错：${err.code || ''} ${err.message}`);
  });
  channel.on('reconnecting', () => console.log(`  ${yellow('…')} 连接断开，正在重连`));
  channel.on('reconnected', () => console.log(`  ${green('✓')} 已重连`));

  console.log(`  ${dim('正在建立长连接…')}`);
  try {
    await channel.connect();
  } catch (e) {
    console.error(`\n  ${red('✗')} 连接失败：${e.code || ''} ${e.message}\n`);
    console.error(`    ${dim('permission_denied → App ID/Secret 不对，或应用没发版')}`);
    console.error(`    ${dim('not_connected      → 网络不通（这个项目要过代理，见 scripts/proxy.mjs）')}\n`);
    process.exit(1);
  }

  const who = channel.botIdentity;
  console.log(`  ${green('✓')} 已连接${who ? ` —— 机器人：${bold(who.name || who.appId || '(无名)')}` : ''}`);
  const st = channel.getConnectionStatus?.();
  if (st) console.log(`  ${dim('连接状态')} ${JSON.stringify(st)}`);
  console.log('');
  console.log(`  ${dim('现在去飞书给这个机器人发一条消息（比如「你好」）。')}`);
  console.log(`  ${dim('如果对话框里没有输入框，说明后台还没订阅 im.message.receive_v1。')}`);
  console.log(`  ${dim('Ctrl+C 停止。')}\n`);

  const stop = async () => {
    console.log(`\n  ${dim('正在断开…')}`);
    try {
      await channel.disconnect();
    } catch {
      /* 断开失败不重要，反正在退出 */
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// ── 入口 ──────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP);
} else if (argv.includes('--card')) {
  const i = argv.indexOf('--card');
  const id = argv[i + 1];
  if (!id) die('--card 后面要给一个 open_id');
  await sendCard(id);
} else {
  await listen();
}
