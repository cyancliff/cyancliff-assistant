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
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
 * 2026-09-19 我手动跑了一次才发现当时是干净的 —— 也就是说
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

  // 私有仓：要检查的是**它的 memory/ 真的在**，而不是"Personal Memory 目录存在"。
  // 原先判的是后者，于是"私有仓没克隆下来"（干净 clone / CI 的常态）
  // 会被报成"引用核验失败" —— 外部审查在一份干净 clone 上实测到了这一条。
  if (existsSync(path.join(PRIVATE, 'memory'))) {
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
/**
 * 从自测输出里挑出**真正的失败**，并把它的下一行一起带上。
 *
 * ## 这段为什么存在（2026-09-20 重写）
 *
 * 原先是这一行：
 *
 *     const failed = out.split('\n').filter((l) => l.includes('✗')).slice(0, 2).join(' | ');
 *
 * 它错在两处，而且两处都在**最需要它的时候**才暴露 —— CI 第一次真跑：
 *
 *   1. **它截的是"含 ✗ 的行"，不是"失败的行"。** 被自测测的那些程序自己就会
 *      打印带 ✗ 的报错文案（`gmail-auth` 的「✗ 凭据文件不是合法 JSON」就是），
 *      于是摘要里出现的是那两行，真正的失败行被挤掉了。
 *   2. **它没有带上"下一行"。** 这个仓的自测把「期望 X，实际 Y」打在
 *      **标题行的下一行**（`chk()` / `test-hooks.sh` 都是这个格式），
 *      所以只取标题行等于把答案丢掉：留下的是一句被腰斩的路径，
 *      60 字符处断在 `.../Person`，看的人只能猜。
 *
 * 结果是：CI 三次红，我三次都在读同一句被腰斩的话，最后不得不另起一个
 * Linux 环境去复现 —— 而真正的原因**一直就在那儿，只是没被打出来**。
 * 这是"报错信息要指得准"那条规矩欠在**门自己**身上的债。
 *
 * 现在的判据：**带缩进**的行才是自测报告的结果行（`  ✗ 拦住 .env（期望 1，实际 0）`）；
 * 顶格的行是它跑的那些程序自己的 stdout（`✗ /path/...`），不算 —— 这一条是实测撞出来的。
 */
function extractFailures(out, max = 4) {
  const lines = out.split('\n').map((l) => l.replace(/\s+$/, ''));
  const found = [];
  for (let i = 0; i < lines.length && found.length < max; i++) {
    const l = lines[i];
    if (!/^\s+✗/.test(l)) continue; // 必须带缩进，且以 ✗ 开头
    if (/✓/.test(l)) continue; // 同一行里还有 ✓ 的，是程序输出不是结果
    /**
     * 细节行**只在第一条也带缩进时才收**。
     *
     * 为什么加这一条（2026-09-20 第二次改）：上面那些被测程序往 stdout 打的
     * `✗ /path/...` 是**顶格**的，它们的续行（如 `  这一步要先修好客户端凭据…`）
     * 也是顶格或浅缩进。原先无脑收 2 行，于是每次摘出来的"失败行 + 细节"
     * 其实是**程序输出的头和尾**，拼起来像一句莫名其妙的话：
     *     失败：✗ .../Person
     *     细节：这一步要先修好客户端凭据，再谈令牌
     * 真正的自测结果行（`  ✗ 拦住 .env（期望 1，实际 0）`）是**带缩进**的，
     * 它的续行（`      期望 …，实际 …`）缩进更深。用缩进把两类分开。
     */
    const detail = [];
    for (let j = i + 1; j < lines.length && detail.length < 2; j++) {
      const next = lines[j];
      if (!next.trim()) break;
      if (/^\s*[✓✗]/.test(next)) break; // 下一条结果开始了
      if (!/^\s{4,}/.test(next)) break; // 第一条细节本身不缩进 → 这不是结果行，别硬凑
      detail.push(next.trim().slice(0, 200));
    }
    found.push({ line: l.trim().slice(0, 200), detail });
  }
  return found;
}

/**
 * 尾部几行也叫「摘要」的一部分：它回答的是"这个脚本**跑到头**了吗"。
 *
 * 为什么必须带它（2026-09-20 第三次改）：CI 三次红，我按"失败行"去读，
 * 读到的都是被测程序自己的报错文案（顶格 ✗）。而"是自己打印了失败、
 * 还是进程死在半路"这件事，只有尾部那行能回答 ——
 * `✗ 2/7 条不合格` 是前者，什么都不打印就是后者。少了它就得靠猜。
 */
function extractTail(out, n = 6) {
  const lines = out.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  return lines.slice(-n).map((l) => l.slice(0, 200));
}

function gateTests() {
  const t0 = Date.now();
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // shell 是必须的（npm.cmd 直接 exec 会 EINVAL），且传完整命令字符串
  // —— 传 args 数组会被 Node 拼接并报 DEP0190。这个坑 publish.mjs 里也遇到过。
  const r = spawnSync(`${npm} test`, { cwd: ROOT, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = r.status === 0;

  if (!ok) {
    /**
     * **失败时把完整输出落盘，并把路径打出来。**
     * 为什么必须落盘：CI 里这一步的输出**只进得了 Node 的缓冲区**，
     * 不会出现在 GitHub 的步骤日志里 —— 于是"跑一遍看看"在 CI 上做不到，
     * 只能在本机重做一遍环境才能查。存一份文件是最便宜的补救。
     */
    const logPath = path.join(ROOT, '.dsh', 'gate-tests-failed.log');
    let note = '';
    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
      writeFileSync(logPath, out, 'utf8');
      note = `完整输出：${path.relative(ROOT, logPath)}`;
    } catch (e) {
      note = `（完整输出落盘失败：${e.message}）`;
    }

    const failures = extractFailures(out);
    const tail = extractTail(out);
    console.log(`\n  ${red('✗')} 全量自测失败\n`);
    if (!failures.length) {
      console.log(`    ${dim('没找到带缩进的 ✗ 结果行 —— 说明失败不在自测的报告里，可能是命令本身没跑起来。')}`);
    } else {
      console.log(`    ${bold('真正的失败行')}（带缩进的那几行，最多 4 条）：`);
      for (const f of failures) {
        console.log(`      ${red('✗')} ${f.line}`);
        for (const d of f.detail) console.log(`          ${dim(d)}`);
      }
    }
    console.log(`\n    ${bold('输出末尾 6 行')}${dim('（回答"脚本跑到头了吗"：有收尾那行 = 跑完了；没有 = 死在半路）')}：`);
    for (const l of tail) console.log(`      ${dim(l)}`);
    if (note) console.log(`\n    ${dim(note)}`);
    console.log('');
  }

  record('全量自测', ok, ok ? '' : '见上面那几行（这次不再截断）', Date.now() - t0);
  return ok;
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
