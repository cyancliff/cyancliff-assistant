#!/usr/bin/env node
/**
 * notify-lib.mjs — 飞书推送的可复用部分（内部模块）
 *
 * 拆出来的原因：`notify.mjs` 既是 CLI 又是库，靠"我是不是被 import"来判断，
 * 而那个判断在 Windows 上、在 `node -e` 里都不可靠：
 * `import('./scripts/notify.mjs')` 会让 `process.argv[1]` 变成工作目录，
 * CLI 部分照样执行，然后因为"没给消息内容"而退出。
 *
 * 与其把判据修得更绕，不如按结构解决：**能 import 的放这里，CLI 放那边。**
 * 和 gmail-auth.mjs 的做法一致。
 *
 * 这个文件没有任何顶层副作用 —— import 它不会发任何东西。
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ── .env ──────────────────────────────────────────────────────
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
 *   1. $ASSISTANT_ENV 指定的文件
 *   2. <仓库根>/Personal Memory/.env   ← 正常情况
 *   3. <仓库根>/.env
 *   4. 往上找几层
 */
export function resolveEnvPath() {
  const candidates = [];
  if (process.env.ASSISTANT_ENV) candidates.push(path.resolve(process.env.ASSISTANT_ENV));
  candidates.push(path.join(ROOT, 'Personal Memory', '.env'), path.join(ROOT, '.env'));
  let dir = path.dirname(ROOT);
  for (let i = 0; i < 3; i++) {
    candidates.push(path.join(dir, '.env'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const f of candidates) if (existsSync(f)) return f;
  return candidates[0];
}

export const ENV_PATH = resolveEnvPath();
const envFile = existsSync(ENV_PATH) ? parseEnvFile(ENV_PATH) : {};
/** 进程环境变量优先，其次 .env。 */
export const getEnv = (k) => process.env[k] || envFile[k] || '';

// ── 可复用的发送核心 ──────────────────────────────────────────
/** 截断过长的正文。返回新正文和是否截断过。 */
export function truncateBody(body, max = 4000) {
  if (body.length <= max) return { body, truncated: false };
  return {
    body: body.slice(0, max) + `\n\n…（还有 ${body.length - max} 字符未显示）`,
    truncated: true,
  };
}

/** 组装飞书消息体。有 title 就发交互卡片，否则纯文本。 */
export function buildCard(body, title, secret, now = Date.now()) {
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

  // 开了签名校验才需要：sign = base64(HMAC-SHA256(key = timestamp + "\n" + secret, data = ""))
  if (secret) {
    const timestamp = Math.floor(now / 1000).toString();
    card.timestamp = timestamp;
    card.sign = createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
  }
  return card;
}

/**
 * webhook 地址里的 token 就是凭据本身 —— 拿到它就能往你的群里发消息。
 * 打印时一律遮掉，两种常见形式都覆盖：
 *   https://open.feishu.cn/open-apis/bot/v2/hook/<token>   ← 飞书
 *   https://example.com/hook?token=<token>                 ← 查询参数形式
 */
export function maskWebhook(url) {
  return String(url || '')
    .replace(/(\/hook\/)[^/?#\s]+/, '$1<已隐去>')
    .replace(/([?&](?:hook|token|key|access_token)=)[^&\s]+/gi, '$1<已隐去>');
}

/**
 * 把一条消息推到飞书。**这是给其它脚本调的入口**（workflow.mjs 用它）。
 *
 * 返回 {ok, reason, ...}，**不 process.exit** —— 调用方决定怎么处理失败。
 * CLI 那层才把失败转成退出码。
 *
 * fetchImpl 可注入，这样测试不用真发网络请求。
 */
export async function sendNotify({ body, title = null, webhook, secret = null, fetchImpl = fetch }) {
  if (!webhook) return { ok: false, reason: 'no-webhook' };

  const t = truncateBody(String(body ?? '').trim());
  if (!t.body) return { ok: false, reason: 'empty-body' };

  const card = buildCard(t.body, title, secret);

  let res;
  try {
    res = await fetchImpl(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
    });
  } catch (err) {
    return { ok: false, reason: 'network', detail: err.message };
  }

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留原文用于报错 */
  }

  if (!res.ok) {
    return { ok: false, reason: 'http', detail: `HTTP ${res.status}`, raw: text.slice(0, 300) };
  }

  // 飞书的坑：HTTP 200 不代表成功，业务错误在 body.code 里。
  // 只看 status 会把"机器人被移出群"这类失败当成发送成功。
  if (json && json.code !== undefined && json.code !== 0) {
    return { ok: false, reason: 'feishu', detail: `code=${json.code} ${json.msg || ''}` };
  }

  return { ok: true, truncated: t.truncated, chars: t.body.length };
}
