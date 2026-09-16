#!/usr/bin/env node
/**
 * gmail-auth.mjs — Gmail 的 OAuth 与令牌管理（内部模块，也给用户直接跑）
 *
 * 零依赖：OAuth 的刷新令牌流程和 Gmail API 都能用 `fetch` + `node:crypto` 直接调，
 * 不值得为它装一棵 googleapis 依赖树。这个文件就是"那棵树的最小子集"。
 *
 *   node scripts/gmail-auth.mjs --auth      # 首次授权（要浏览器点同意）
 *   node scripts/gmail-auth.mjs --status    # 看当前凭据状态
 *   node scripts/gmail-auth.mjs --test      # 打一次真实 API 调用
 *
 * 凭据从 .env 读（路径见 .env.example）：
 *   GMAIL_CREDENTIALS_PATH   OAuth 客户端 JSON（Google Cloud Console 下载的）
 *   GMAIL_TOKEN_PATH         令牌缓存，首次授权后自动生成
 *
 * **令牌文件是凭据** —— 拿到它就能读你的邮件。已在 .gitignore 里挡住。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export const SCOPE = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

// ── .env（与 notify.mjs 同样的解析，刻意保持行为一致）────────
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

export const ENV_PATH = resolveEnvPath();
const envFile = existsSync(ENV_PATH) ? parseEnvFile(ENV_PATH) : {};
export const getEnv = (k) => process.env[k] || envFile[k] || '';

/** 私有仓是 data/ 的所在处 —— 凭据路径相对它解析。 */
export const DATA_ROOT = path.join(ROOT, 'Personal Memory');

export function credentialsPath() {
  return path.resolve(DATA_ROOT, getEnv('GMAIL_CREDENTIALS_PATH') || 'data/gmail-credentials.json');
}
export function tokenPath() {
  return path.resolve(DATA_ROOT, getEnv('GMAIL_TOKEN_PATH') || 'data/gmail-token.json');
}

// ── 读取客户端凭据 ────────────────────────────────────────────
/**
 * 兼容两种 JSON 形状：Google 下载的 `{installed:{...}}` 和直接平铺的。
 * 手工从 Console 抄字段的人很容易做出后一种，报错时要说清是哪一种不对。
 */
export function readClient() {
  const f = credentialsPath();
  if (!existsSync(f)) {
    throw new Error(
      `找不到 OAuth 客户端文件：${f}\n\n` +
        `  怎么拿：\n` +
        `    1. Google Cloud Console → API 和服务 → 启用 Gmail API\n` +
        `    2. 凭据 → 创建凭据 → OAuth 客户端 ID → 应用类型选「桌面应用」\n` +
        `    3. 下载 JSON，存到上面这个路径\n\n` +
        `  注意：下载的是**客户端**凭据，不是访问令牌。\n` +
        `  首次运行 --auth 之后才会生成令牌文件。`
    );
  }
  let json;
  try {
    json = JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    throw new Error(`${f} 不是合法 JSON：${e.message}`);
  }
  const c = json.installed || json.web || json;
  if (!c.client_id || !c.client_secret) {
    throw new Error(
      `${f} 里没有 client_id / client_secret。\n` +
        `  期望的形状是 {"installed":{"client_id":...,"client_secret":...}}，\n` +
        `  或者直接平铺的 {"client_id":...,"client_secret":...}。`
    );
  }
  return { client: c, raw: json };
}

export function readToken() {
  const f = tokenPath();
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function writeToken(tok) {
  const f = tokenPath();
  mkdirSync(path.dirname(f), { recursive: true });
  const withExpiry = { ...tok, expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000 - 60_000 };
  writeFileSync(f, JSON.stringify(withExpiry, null, 2), 'utf8');
  return withExpiry;
}

// ── 刷新 ──────────────────────────────────────────────────────
/**
 * 拿到一个可用的 access token。
 *
 * 提前 60 秒算过期（见 writeToken），避免"检查时还没过期、请求发出去就过期"。
 */
export async function getAccessToken() {
  const tok = readToken();
  if (tok?.access_token && tok.expires_at && Date.now() < tok.expires_at) {
    return tok.access_token;
  }
  if (!tok?.refresh_token) {
    throw new Error(
      `还没有可用的令牌（或令牌里没有 refresh_token）。\n` +
        `  先跑一次：node scripts/gmail-auth.mjs --auth\n` +
        `  令牌文件：${tokenPath()}`
    );
  }

  const { client } = readClient();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: tok.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    // invalid_grant 最常见的原因是令牌被撤销或授权被删 —— 这时重试没用，
    // 要重新授权。把这个判断说清楚，别让人对着 401 反复重试。
    const hint =
      json.error === 'invalid_grant'
        ? '\n  这个错误通常意味着授权已被撤销或过期，重试没用 —— 要重新跑 --auth。'
        : '';
    throw new Error(`刷新令牌失败（HTTP ${res.status}）：${json.error || ''} ${json.error_description || ''}${hint}`);
  }

  return writeToken({ ...tok, ...json }).access_token;
}

/** 带认证的 Gmail API 调用。 */
export async function gmailFetch(urlPath, init = {}) {
  const token = await getAccessToken();
  const res = await fetch(
    urlPath.startsWith('http') ? urlPath : `https://gmail.googleapis.com/gmail/v1${urlPath}`,
    {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    }
  );
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 保留原文用于报错 */
  }
  if (!res.ok) {
    throw new Error(`Gmail API ${res.status}：${json?.error?.message || text.slice(0, 300)}`);
  }
  return json;
}

// ── 首次授权：本地回环 + PKCE ─────────────────────────────────
/**
 * 桌面应用的 OAuth 用回环地址收授权码。
 *
 * 用 PKCE（S256）而不是客户端密钥直接换码：桌面应用没法保守密，
 * PKCE 让"偷到授权码"也不足以换取令牌。Google 对桌面客户端也推荐这个。
 */
async function doAuth() {
  const { client } = readClient();
  const port = 51789;
  const redirectUri = `http://127.0.0.1:${port}`;

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  // access_type=offline + prompt=consent 才能拿到 refresh_token。
  // 少了它们，Google 只在首次授权给 refresh_token，之后再授权就没有了 ——
  // 那会让"删掉令牌重来一次"这个常见操作静默失效。
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  const codePromise = new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, redirectUri);
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      const gotState = u.searchParams.get('state');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (err) {
        res.end(`<h2>授权被拒绝</h2><p>${err}</p><p>可以关掉这个页面。</p>`);
        server.close();
        reject(new Error(`授权被拒绝：${err}`));
        return;
      }
      if (gotState !== state) {
        res.end('<h2>state 不匹配</h2><p>出于安全考虑已中止，请重新运行。</p>');
        server.close();
        reject(new Error('回调里的 state 和发起时不一致，可能被篡改。'));
        return;
      }
      res.end('<h2>授权成功</h2><p>可以关掉这个页面，回到终端。</p>');
      server.close();
      resolve(code);
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
  });

  console.log('\n在浏览器里打开这个地址，同意授权：\n');
  console.log(`  ${authUrl.toString()}\n`);
  console.log('（如果浏览器没自动打开，手动复制上面那行）\n');

  // 尽力自动打开；打不开也不影响 —— 地址已经打印在上面了
  try {
    const cmd =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '', authUrl.toString()]]
      : process.platform === 'darwin' ? ['open', [authUrl.toString()]]
      : ['xdg-open', [authUrl.toString()]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 忽略：地址已经打印了 */
  }

  const code = await codePromise;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`换取令牌失败（HTTP ${res.status}）：${json.error || ''} ${json.error_description || ''}`);
  }
  if (!json.refresh_token) {
    throw new Error(
      'Google 没有返回 refresh_token。\n' +
        '  通常是因为这个客户端之前授权过。去 Google 账号的"第三方访问"里\n' +
        '  撤掉本应用，再跑一次 --auth。'
    );
  }
  writeToken(json);
  return json;
}

// ── CLI ───────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
  const green = c(32);
  const yellow = c(33);
  const dim = c(2);
  const bold = c(1);

  try {
    if (args.includes('--auth')) {
      await doAuth();
      console.log(`${green('✓')} 授权完成，令牌已存到 ${dim(tokenPath())}`);
      console.log(dim('  这个文件是凭据 —— 已在 .gitignore 里挡住，不要手动复制到别处。'));
    } else if (args.includes('--test')) {
      const profile = await gmailFetch('/users/me/profile');
      console.log(`${green('✓')} API 可用`);
      console.log(`  邮箱：${profile.emailAddress}`);
      console.log(`  邮件总数：${profile.messagesTotal}`);
    } else {
      const tok = readToken();
      console.log(`\n${bold('Gmail 凭据状态')}\n`);
      console.log(`  .env             ${ENV_PATH}${existsSync(ENV_PATH) ? '' : dim('  （不存在）')}`);
      console.log(`  客户端凭据       ${credentialsPath()}${existsSync(credentialsPath()) ? '' : dim('  （不存在）')}`);
      console.log(`  令牌             ${tokenPath()}${tok ? '' : dim('  （不存在）')}`);
      if (tok) {
        const left = tok.expires_at ? Math.round((tok.expires_at - Date.now()) / 1000) : null;
        console.log(`  refresh_token    ${tok.refresh_token ? '有' : yellow('没有 —— 要重新授权')}`);
        console.log(
          `  access_token     ${left === null ? '未知有效期' : left > 0 ? `${left} 秒后过期` : '已过期（用时会自动刷新）'}`
        );
      }
      console.log(
        `\n  ${dim('下一步：')}${existsSync(credentialsPath()) ? (tok ? ' --test 打一次真实调用' : ' --auth 走浏览器授权') : ' 先放好客户端凭据 JSON'}\n`
      );
    }
  } catch (err) {
    console.error(`\n${yellow('✗')} ${err.message}\n`);
    process.exit(1);
  }
}
