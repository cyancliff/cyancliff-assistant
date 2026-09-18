#!/usr/bin/env node
/**
 * gate.mjs — 把几道检查串成一条命令
 *
 *   node scripts/gate.mjs              # 提交门：语法 + 契约（快）+ 引用   目标 < 3 秒
 *   node scripts/gate.mjs --push       # 推送门：上面这些 + 全量自测 + 契约全量测量
 *   node scripts/gate.mjs --syntax     # 只跑语法
 *   node scripts/gate.mjs --json       # 结构化输出
 *
 * ## 为什么需要有这个文件
 *
 * 在这之前，检查是**散着的一堆 npm 脚本**，靠人记得跑哪一个。
 * 而"靠人记得"在这个项目里已经被证明不够：契约里那句"发布器是 publish.mjs"
 * 假了很久，因为**没有任何东西会主动去问"这还是真的吗"**。
 *
 * 分层是无奈也是取舍：提交门必须快（超过几秒就会有人用 --no-verify 绕过，
 * 包括我自己），所以慢的检查放在推送门。**每一层都写清它查不到什么。**
 *
 * | 层 | 跑什么 | 查不到什么 |
 * |---|---|---|
 * | 提交（本文件不带参数） | 语法 + 契约快审计 + 引用核验 | 不跑自测、不重新测量事实 |
 * | 推送（--push） | 上面全部 + 全量自测 + 契约全量测量 | 不跑突变测试（它要干净工作区） |
 * | CI（.github/workflows） | 推送门的全部 + 突变测试 | — |
 *
 * 用法都是 `node` 起头，所以 Windows / git-bash 都能跑（这个项目在
 * "shell 脚本在 Windows 上跑不了"上踩过坑，见 run-sh.mjs）。
 */

import { spawnSync, execFileSync } from 'node:child_process';
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PRIVATE = path.join(ROOT, 'Personal Memory');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const pushMode = args.includes('--push');
const syntaxOnly = args.includes('--syntax');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = c(31);
const green = c(32);
const yellow = c(33);
const dim = c(2);
const bold = c(1);

const results = [];
function record(name, ok, detail, ms) {
  results.push({ name, ok, detail: detail || '', ms: Math.round(ms) });
  const mark = ok ? green('✓') : red('✗');
  const time = dim(`${Math.round(ms)}ms`);
  console.log(`  ${mark} ${name.padEnd(22)} ${time}${detail ? `  ${dim(detail)}` : ''}`);
}

function run(cmd, cmdArgs, opts = {}) {
  const finalArgs = opts.nodeFlags ? [...opts.nodeFlags, ...cmdArgs] : cmdArgs;
  return spawnSync(cmd, finalArgs, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: !!opts.shell,
    // 实验性 API 会打一行警告到 stderr —— 我们自己看得到就行，别让它污染输出
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
}

// ── 1. 语法门 ─────────────────────────────────────────────────
/**
 * 这一道存在的理由很具体：**在这个脚本出现之前，没有任何东西在跑语法检查。**
 * 2026-09-18 我手动跑了一次才发现当时是干净的 —— 也就是说
 * "能不能解析"这件事一直是靠运气，而不是靠检查。
 *
 * ## 为什么不用 `node --check` 逐个跑
 *
 * 第一版就是那么写的：29 个脚本 29 次进程启动，**5439ms**。
 * 而这一层是要进 `pre-commit` 的，超过几秒就会有人 `--no-verify` 绕过。
 * 改用 `vm.SourceTextModule` **只解析不执行**：同一次运行里全部过一遍，
 * 实测 **54ms**（快 100 倍）。
 *
 * **兜底**：`SourceTextModule` 是实验性的，拿不到就退回逐个 `node --check`
 * —— 慢，但绝不能因为拿不到快路径就不检查（那正是"检查器悄悄失效"）。
 */
function checkEsmFast(files) {
  // `vm.SourceTextModule` 需要 --experimental-vm-modules。本进程没带这个开关时，
  // 起一个子进程带上它 —— 一次进程启动换掉 26 次，仍然快得多。
  if (typeof vm.SourceTextModule !== 'function') {
    const script = `
      const vm = require('node:vm'), fs = require('node:fs');
      const out = [];
      for (const f of JSON.parse(process.argv[1])) {
        try { new vm.SourceTextModule(fs.readFileSync(f, 'utf8'), { identifier: f }); }
        catch (e) { out.push({ file: f, why: (e.name + ': ' + e.message).slice(0, 120) }); }
      }
      process.stdout.write(JSON.stringify(out));
    `;
    const r = run('node', ['-e', script, JSON.stringify(files.map((f) => path.join(HERE, f)))], {
      nodeFlags: ['--experimental-vm-modules'],
    });
    if (r.status !== 0) return null; // 子进程也起不来 → 交回慢路径
    try {
      const problems = JSON.parse(r.stdout);
      // 子进程报的路径是绝对路径，转回文件名
      return problems.map((p) => ({ ...p, file: path.basename(p.file) }));
    } catch {
      return null;
    }
  }

  const problems = [];
  for (const f of files) {
    const full = path.join(HERE, f);
    try {
      new vm.SourceTextModule(readFileSync(full, 'utf8'), { identifier: full });
    } catch (e) {
      problems.push({ file: f, why: `${e.name}: ${e.message}`.slice(0, 120) });
    }
  }
  return problems;
}

function checkEsmSlow(files) {
  const problems = [];
  for (const f of files) {
    const r = run('node', ['--check', path.join(HERE, f)]);
    if (r.status !== 0) {
      const line = (r.stderr || '').split('\n').find((l) => l.includes('Error'));
      problems.push({ file: f, why: (line || '语法错误').trim().slice(0, 120) });
    }
  }
  return problems;
}

function gateSyntax() {
  const t0 = Date.now();
  const files = readdirSync(HERE).filter((n) => statSync(path.join(HERE, n)).isFile());
  const esm = files.filter((n) => /\.(mjs|js)$/.test(n));
  let problems = [];
  let how = '';

  const fast = checkEsmFast(esm);
  if (fast) {
    problems = fast;
    how = 'vm 解析';
  } else {
    problems = checkEsmSlow(esm);
    how = 'node --check（慢路径）';
  }

  // .py：python -m py_compile（没装 python 就跳过，不算失败）
  const pyFiles = files.filter((n) => n.endsWith('.py'));
  if (pyFiles.length) {
    const probe = run('python', ['--version']);
    if (probe.status !== 0 && probe.error) {
      // python 不在 PATH 上：报"跳过"，别报失败 —— 它不是这次改动的问题
      problems.push({ file: '(python)', why: '跳过：没找到 python', skip: true });
    } else {
      for (const f of pyFiles) {
        const r = run('python', ['-m', 'py_compile', path.join(HERE, f)]);
        if (r.status !== 0)
          problems.push({ file: f, why: (r.stderr || '').trim().split('\n').slice(-1)[0] || 'py_compile 失败' });
      }
    }
  }

  // .sh：交给 bash -n（用 run-sh.mjs 问 git 的 bash 在哪）
  const shFiles = files.filter((n) => n.endsWith('.sh'));
  for (const f of shFiles) {
    const r = run('node', [path.join(HERE, 'run-sh.mjs'), '-n', path.join(HERE, f)]);
    if (r.status !== 0)
      problems.push({ file: f, why: (r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0] || 'sh -n 失败' });
  }

  const real = problems.filter((p) => !p.skip);
  const detail = real.length ? real.map((p) => `${p.file}: ${p.why}`).join(' | ') : `${esm.length} mjs + ${pyFiles.length} py + ${shFiles.length} sh · ${how}`;
  record('语法门', real.length === 0, detail, Date.now() - t0);
  return real.length === 0;
}

// ── 2. 契约审计 ───────────────────────────────────────────────
function gateContract(full) {
  const t0 = Date.now();
  const r = run('node', [path.join(HERE, 'contract.mjs'), ...(full ? [] : ['--fast'])]);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const firstBad = out.split('\n').find((l) => l.includes('✗')) || '';
  record(
    full ? '契约审计（全量）' : '契约审计（快）',
    r.status === 0,
    r.status === 0 ? '' : firstBad.trim().slice(0, 120),
    Date.now() - t0
  );
  return r.status === 0;
}

// ── 3. 引用核验 ───────────────────────────────────────────────
/**
 * 两个仓都要核：外层仓自己的条目 + 私有仓的 memory/。
 * 后者的路径要分开给（引用里的 library/... 基准是 Personal Memory/data）。
 */
function gateCitations() {
  const t0 = Date.now();
  const problems = [];

  const outer = run('node', [path.join(HERE, 'cite-check.mjs')]);
  if (outer.status !== 0) problems.push('外层仓条目');

  if (existsSync(PRIVATE)) {
    const inner = run('node', [
      path.join(HERE, 'cite-check.mjs'),
      '--scan', path.join(PRIVATE, 'memory'),
      '--root', path.join(PRIVATE, 'data'),
    ]);
    if (inner.status !== 0) problems.push('私有仓 memory/');
  }

  record('引用核验', problems.length === 0, problems.join('、'), Date.now() - t0);
  return problems.length === 0;
}

// ── 4. 全量自测（只在推送门）─────────────────────────────────
function gateTests() {
  const t0 = Date.now();
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // shell 是必须的（npm.cmd 直接 exec 会 EINVAL），且传完整命令字符串
  // —— 传 args 数组会被 Node 拼接并报 DEP0190。这个坑 publish.mjs 里也遇到过。
  const r = spawnSync(`${npm} test`, { cwd: ROOT, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const failed = out.split('\n').filter((l) => l.includes('✗')).slice(0, 2).join(' | ');
  record('全量自测', r.status === 0, r.status === 0 ? '' : failed, Date.now() - t0);
  return r.status === 0;
}

// ── 跑 ────────────────────────────────────────────────────────
console.log(`\n${bold(pushMode ? '推送门' : syntaxOnly ? '语法门' : '提交门')}\n`);

let ok = true;
ok = gateSyntax() && ok;
if (!syntaxOnly) {
  ok = gateContract(pushMode) && ok;
  ok = gateCitations() && ok;
  if (pushMode) ok = gateTests() && ok;
}

const total = results.reduce((a, r) => a + r.ms, 0);

if (asJson) {
  console.log(JSON.stringify({ ok, results, totalMs: total }, null, 2));
} else {
  console.log('');
  if (ok) {
    console.log(`${green('✓')} 通过（${results.length} 道，合计 ${total}ms）`);
    if (!pushMode && !syntaxOnly) {
      console.log(
        dim('  这一层查不到：自测是否通过、事实是否变了（那要 --push 或 --update）。')
      );
    }
    console.log('');
  } else {
    console.log(`${red('✗')} 没过 —— 上面 ✗ 那几道就是原因`);
    console.log(dim('  想绕过（不推荐）：git commit --no-verify'));
    console.log('');
  }
}

process.exit(ok ? 0 : 1);
