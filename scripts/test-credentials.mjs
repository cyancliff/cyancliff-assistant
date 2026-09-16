#!/usr/bin/env node
/**
 * test-credentials.mjs — 凭据错误路径的测试
 *
 *   node scripts/test-credentials.mjs
 *
 * 为什么单独一个脚本：凭据报错是**用户最常撞上、也最容易卡住**的一类。
 * 报错说得不对，人会照着错误的方向修，然后一直撞同一面墙。
 *
 * 这里测的都是不需要真实凭据的情况 —— 用临时造的假凭据文件，
 * 看报错有没有说清"哪一步坏了、该怎么修"。
 *
 * 它验证的一个真问题（实测撞出来的）：
 *
 *   凭据文件写成非法 JSON 时，`--test` 原来报的是
 *   "还没有可用的令牌，先跑 --auth" —— 而 `--auth` 自己也要先读凭据，
 *   同样会失败。人照着做会无限撞墙。
 *   根因是检查顺序反了：先看令牌、后看凭据。
 *
 * **假凭据文件用完即删，绝不覆盖真实凭据。**
 */

import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_ROOT, credentialsPath, tokenPath } from './gmail-auth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRED = credentialsPath();
const TOK = tokenPath();

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = c(31);
const green = c(32);
const yellow = c(33);
const dim = c(2);
const bold = c(1);

// 安全闸：有真实凭据就不测，免得覆盖
if (existsSync(CRED) || existsSync(TOK)) {
  console.log(`\n${yellow('跳过')} 检测到真实凭据文件，不测以免覆盖：`);
  if (existsSync(CRED)) console.log(dim(`  ${CRED}`));
  if (existsSync(TOK)) console.log(dim(`  ${TOK}`));
  console.log(dim('\n  想测的话先把它们挪走。\n'));
  process.exit(0);
}

const runAuth = (args) => {
  try {
    const out = execFileSync('node', [path.join(HERE, 'gmail-auth.mjs'), ...args], {
      encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
};

const VALID_CRED = JSON.stringify({
  installed: { client_id: 'x.apps.googleusercontent.com', client_secret: 'y' },
});

const cases = [
  {
    name: '凭据文件不是合法 JSON',
    setup: () => writeFileSync(CRED, '{ 这不是 JSON', 'utf8'),
    expect: /不是合法 JSON/,
    why: '手工编辑时最常见',
  },
  {
    name: '是 JSON 但缺 client_id / client_secret',
    setup: () => writeFileSync(CRED, JSON.stringify({ foo: 'bar' }), 'utf8'),
    expect: /没有 client_id/,
    why: '从别处抄字段时容易漏',
  },
  {
    name: '形状对但值是空的',
    setup: () =>
      writeFileSync(CRED, JSON.stringify({ installed: { client_id: '', client_secret: '' } }), 'utf8'),
    expect: /没有 client_id/,
    why: '空值不该被当成有效凭据',
  },
  {
    name: '平铺形状（没有 installed 包裹）也能认',
    setup: () =>
      writeFileSync(
        CRED,
        JSON.stringify({ client_id: 'x.apps.googleusercontent.com', client_secret: 'y' }),
        'utf8'
      ),
    expect: /还没有授权令牌|--auth/,
    why: '手工抄字段的人会做出来，应该能认，不该报"形状不对"',
  },
  {
    name: '令牌文件损坏 → 要说"损坏"，不是"不存在"',
    setup: () => {
      writeFileSync(CRED, VALID_CRED, 'utf8');
      writeFileSync(TOK, 'not json at all', 'utf8');
    },
    expect: /令牌文件损坏/,
    why: '两件事的处理办法不同：损坏要删掉重来，不存在直接授权',
  },
  {
    name: '令牌存在但没有 refresh_token',
    setup: () => {
      writeFileSync(CRED, VALID_CRED, 'utf8');
      writeFileSync(TOK, JSON.stringify({ access_token: 'stale', expires_at: 1 }), 'utf8');
    },
    expect: /没有 refresh_token/,
    why: '要说清是缺了续期那一项，而不是笼统一句"没有可用令牌"',
  },
  {
    name: '凭据坏 + 令牌也坏 → 先报凭据（顺序不能反）',
    setup: () => {
      writeFileSync(CRED, 'garbage', 'utf8');
      writeFileSync(TOK, 'garbage', 'utf8');
    },
    expect: /不是合法 JSON/,
    why: '凭据是第一步，报后面那步的错会把人引向死路',
  },
];

mkdirSync(path.dirname(CRED), { recursive: true });
console.log(`\n${bold('凭据错误路径测试')} ${dim(`${cases.length} 条`)}\n`);

let bad = 0;
for (const cs of cases) {
  rmSync(CRED, { force: true });
  rmSync(TOK, { force: true });
  cs.setup();

  const r = runAuth(['--test']);
  const matched = cs.expect.test(r.out);
  const ok = matched && r.code !== 0;
  // 只关心仓库自己的报错，不要真的未捕获异常（那种带 "    at file:line:col"）
  const stackFrames = r.out.split('\n').filter((l) => /^\s+at .+:\d+:\d+/.test(l)).length;

  console.log(`  ${ok && !stackFrames ? green('✓') : red('✗')} ${cs.name}`);
  if (!ok) {
    console.log(`      ${dim(`期望 ${cs.expect}，实际 exit=${r.code}`)}`);
    console.log(`      ${r.out.split('\n').filter((l) => l.trim()).slice(0, 2).join(' | ')}`);
    bad++;
  } else {
    console.log(`      ${dim(r.out.split('\n').find((l) => l.trim()).trim().slice(0, 66))}`);
  }
  if (stackFrames) {
    console.log(`      ${red(`⚠ 有 ${stackFrames} 行调用栈 —— 用户看不懂`)}`);
    bad++;
  }
}

rmSync(CRED, { force: true });
rmSync(TOK, { force: true });

console.log('');
if (bad) {
  console.log(`${red('✗')} ${bad} 条不合格\n`);
  process.exit(1);
}
console.log(`${green('✓')} 全部通过：每条报错都指得准，且没有调用栈\n`);
