#!/usr/bin/env node
/**
 * contract.mjs — 契约审计：文档里的事实，机器核对
 *
 *   node scripts/contract.mjs               # 审计（不符就退出码 1）
 *   node scripts/contract.mjs --update      # 重新测量并写回 facts.json
 *   node scripts/contract.mjs --json        # 结构化输出
 *   node scripts/contract.mjs --list        # 列出所有事实与当前值
 *
 * ## 为什么需要这个
 *
 * 2026-09-18 核对进度时发现 `AGENTS.md` 第 3 节描述的发布器**从没存在过**，
 * 而且那句假话在那里躺了很久 —— **因为没有任何东西会去问"这还是真的吗"。**
 * 这个项目里已经有过三次同类问题："永不推送"、"待接通"的凭据表、这个发布器。
 * 三次的共同点不是粗心，是**缺少一层会自己发现过期的机制**。
 *
 * ## 元规则（这条是整件事的核心）
 *
 * > **文档里出现的每一个数字、路径、命令，都要么能机器验证，要么带一个日期与来源。**
 *
 * 这个脚本就是那句话的执行者：
 *
 *   1. `scripts/facts.json` 存**测量出来的**事实（断言数、文件数、脚本是否存在…）
 *   2. 每次审计**重新测量一遍**，与 facts.json 比对 → 不符就报"文档/事实漂移"
 *   3. 把文档里**谈到同一件事**的数字抓出来比对 → 不符就指出是哪一句
 *
 * ## 它刻意不做的事
 *
 * - **不改文档。** 它只报"第几行说 X、实际是 Y"，改不改是人的决定
 *   （自动改会掩盖"为什么当初写错"）。
 * - **不猜。** 抓不到就不报。**宁可漏报也不能误报** —— 误报会让人开始无视它，
 *   而一个被无视的检查器等于没有。
 * - **不检查历史文件**（CHANGELOG）：那里写的数字是历史记录，
 *   改了它反而是篡改历史。要检查的只有"描述当前状态"的文件，清单在 facts.json 里。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FACTS_PATH = path.join(HERE, 'facts.json');
const PRIVATE = path.join(ROOT, 'Personal Memory');

// ── 输出 ──────────────────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = c(31);
const green = c(32);
const yellow = c(33);
const dim = c(2);
const bold = c(1);

const args = process.argv.slice(2);
const doUpdate = args.includes('--update');
const asJson = args.includes('--json');
const listOnly = args.includes('--list');
/**
 * `--fast`：**不重新测量**，只拿 facts.json 里已有的值去核文档。
 *
 * 为什么要拆开：测量要跑完所有自测（约 5 秒），而它是要放进
 * `pre-commit` 的 —— 提交门超过几秒就会被绕过（包括被我自己绕过）。
 * 所以：
 *
 *   提交时   `--fast`     读权威表核文档（< 0.1 秒）
 *   推送时   不带参数      重新测量 + 核文档（约 5 秒，值这个时间）
 *   改了测试 `--update`    重新测量并写回权威表
 *
 * **代价要说清**：`--fast` 发现不了"事实本身变了"（比如你加了断言但没跑 --update），
 * 那种漂移要等推送或 CI 才报。这是有意的取舍 —— 提交门要快，推送门要全。
 */
const fast = args.includes('--fast');

// ── 测量 ──────────────────────────────────────────────────────
function nodeRun(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}` };
}

function gitLines(cwd, gitArgs) {
  const r = nodeRun('git', gitArgs, { cwd });
  return r.out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** 数一个自测输出了多少条 ✓。`--self-test` 类脚本没有自报总数，只能数。 */
function countChecks(scriptArgs) {
  const r = nodeRun('node', scriptArgs);
  const checks = r.out.split('\n').filter((l) => l.includes('✓')).length;
  return { checks, ok: r.status === 0 };
}

/**
 * 测量所有事实。**每一件都真的跑/真的读**，不取文档里的说法。
 * 这也是为什么它是"权威表"而不是"又一份文档"。
 */
function measure() {
  const f = {};

  // ── 自测 ──
  const groups = {
    pipeline: ['scripts/test-pipeline.mjs'],
    credentials: ['scripts/test-credentials.mjs'],
    idempotency: ['scripts/mail-fetch.mjs', '--dummy'],
    workflow: ['scripts/workflow.mjs', '--self-test'],
    triage: ['scripts/mail-triage.mjs', '--self-test'],
    feishu: ['scripts/test-feishu.mjs'],
    publish: ['scripts/publish.mjs', '--self-test'],
  };
  f.testGroups = {};
  let total = 0;
  for (const [name, a] of Object.entries(groups)) {
    const r = countChecks(a);
    f.testGroups[name] = { checks: r.checks, ok: r.ok };
    total += r.checks;
  }
  // 钩子的突变测试由 shell 脚本跑，单独数
  const hooks = nodeRun('node', ['scripts/run-sh.mjs', 'scripts/test-hooks.sh']);
  f.testGroups.hooks = {
    checks: hooks.out.split('\n').filter((l) => l.includes('✓')).length,
    ok: hooks.status === 0,
  };
  total += f.testGroups.hooks.checks;
  f.assertionTotal = total;

  // ── 突变测试 ──
  const mut = readFileSync(path.join(HERE, 'test-mutations.mjs'), 'utf8');
  f.mutationCount = (mut.match(/^  \{/gm) || []).length;
  f.mutationTarget = (mut.match(/const TEST = path\.join\(HERE, '([^']+)'\)/) || [])[1] || '';

  // ── 仓库 ──
  f.trackedFiles = { public: gitLines(ROOT, ['ls-files']).length, private: gitLines(PRIVATE, ['ls-files']).length };

  // ── 脚本清单（文档里提到的 npm script / 文件必须真的在）──
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  f.npmScripts = Object.keys(pkg.scripts).sort();
  f.scripts = readdirSync(HERE)
    .filter((n) => statSync(path.join(HERE, n)).isFile())
    .filter((n) => n.endsWith('.mjs') || n.endsWith('.py') || n.endsWith('.sh'))
    .sort();

  // ── 钩子 ──
  const hookFile = path.join(ROOT, '.githooks', 'pre-push');
  f.hooks = {
    prePushExists: existsSync(hookFile),
    preCommitExists: existsSync(path.join(ROOT, '.githooks', 'pre-commit')),
    outerHooksPath: nodeRun('git', ['config', 'core.hooksPath']).out.trim(),
    privateHooksPath: nodeRun('git', ['config', 'core.hooksPath'], { cwd: PRIVATE }).out.trim(),
  };

  // ── 发布链路（这正是那次假契约的所在）──
  f.publish = {
    scriptExists: existsSync(path.join(HERE, 'publish.mjs')),
    npmScriptExists: 'publish' in pkg.scripts,
  };

  // ── 网站（发布目标）──
  const siteArg = process.env.CYANCLIFF_WEB;
  const siteDir = siteArg && siteArg.trim() ? path.resolve(siteArg.trim()) : path.resolve(ROOT, '..', 'CyanCliff Web');
  const sitePkg = path.join(siteDir, 'package.json');
  const siteScripts = existsSync(sitePkg) ? Object.keys(JSON.parse(readFileSync(sitePkg, 'utf8')).scripts || {}) : [];
  f.site = {
    dirExists: existsSync(siteDir),
    hasVerifyScript: siteScripts.includes('verify'),
    verifyChain: existsSync(sitePkg)
      ? (JSON.parse(readFileSync(sitePkg, 'utf8')).scripts || {}).verify || ''
      : '',
  };

  return f;
}

// ── 文档里的数字核对 ──────────────────────────────────────────
/**
 * 从"描述当前状态"的文件里抓出谈到某个事实的数字，与权威值比对。
 *
 * 抓法刻意保守：只认**紧挨着关键词**的数字，宁可漏报也不误报
 * （误报会让人开始无视检查器，而被无视的检查器等于没有）。
 */
const CLAIM_PATTERNS = [
  {
    fact: 'assertionTotal',
    // "246 项断言"、"250 项"（项后面可以跟断言/检查）
    re: /(\d+)\s*项(?:断言|检查)?/g,
    // 只在这些词附近才算"总额声明"，避免把"147 项"这类分组数字当成总额
    near: /(全部自测|一条命令|合计|总共|全量)/,
  },
  {
    fact: 'mutationCount',
    // 只认**明确说"全部/一共"**的那种，否则 "3 个突变验证过会失败"（说的是其中 3 个）
    // 会被当成"总共有 3 个突变" —— 这是我第一版的误报，实测撞到的。
    re: /(?:全部|一共|总共|合计)\s*(\d+)\s*个突变/g,
  },
  {
    fact: 'assertionTotal',
    re: /(\d+)\s*项[，,]*\s*(?:全部|合计|总共|一共)/g,
  },
];

function scanClaims(file, text, facts) {
  const findings = [];
  const lines = text.split('\n');

  for (const pat of CLAIM_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (pat.near && !pat.near.test(line)) continue;
      pat.re.lastIndex = 0;
      let m;
      while ((m = pat.re.exec(line))) {
        const claimed = Number(m[1]);
        const actual = facts[pat.fact];
        if (typeof actual !== 'number') continue;
        if (claimed !== actual) {
          findings.push({
            file,
            line: i + 1,
            fact: pat.fact,
            claimed,
            actual,
            text: line.trim().slice(0, 140),
          });
        }
      }
    }
  }
  return findings;
}

// ── 文档里提到的脚本/命令是否存在 ────────────────────────────
/**
 * 这一条治的正是那次假契约：文档说 `scripts/publish.mjs` 存在，而它不存在。
 * 只检查**反引号里的 `scripts/xxx` 路径**与 **`npm run xxx`** —— 这两种写法
 * 是"我在说这个东西存在"，而不是举例或引用。
 */
function scanReferences(file, text, facts) {
  const out = [];
  const lines = text.split('\n');
  // 网站仓自己的脚本不算"不存在" —— 这里检查的是外层仓与它自己的 scripts/。
  // 误报过一次：AGENTS.md 写 `npm run verify`，那是网站仓的脚本，不在外层 package.json 里。
  const foreignScripts = new Set(facts.foreignNpmScripts || []);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(/`(scripts\/[\w.-]+)`/g)) {
      const name = path.basename(m[1]);
      if (facts.scripts.includes(name)) continue;
      // "抽出 X"、"建 X"、"待建" 这类是**在说计划**，不是"它存在"
      const planned = /(抽出|提取|新建|建 `|待建|计划中|尚未实现|要建|准备建)/.test(line);
      out.push({
        file,
        line: i + 1,
        kind: planned ? 'scripts 路径（**未来时**）' : 'scripts 路径',
        said: m[1],
        planned,
        text: line.trim().slice(0, 140),
      });
    }
    for (const m of line.matchAll(/`npm run ([\w:.-]+)`/g)) {
      const name = m[1];
      if (facts.npmScripts.includes(name) || foreignScripts.has(name)) continue;
      const planned = /(会|将|要|准备|计划)/.test(line);
      out.push({
        file,
        line: i + 1,
        kind: planned ? 'npm 脚本（**未来时**）' : 'npm 脚本',
        said: `npm run ${name}`,
        planned,
        text: line.trim().slice(0, 140),
      });
    }
  }
  return out;
}

// ── 主流程 ────────────────────────────────────────────────────
function loadFactsFile() {
  if (!existsSync(FACTS_PATH)) return null;
  try {
    // **去 BOM**：Windows 上任何"用 PowerShell 写 JSON"的动作都会加 BOM
    // （`Set-Content -Encoding UTF8` 就是），而 `JSON.parse` 见到 BOM 直接失败。
    // 这个项目已经在这上面栽过五次。读的时候宽容一点，比要求所有人
    // 记得别用 PowerShell 写文件更可靠。
    const raw = readFileSync(FACTS_PATH, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (e) {
    console.error(`${red('✗')} facts.json 读不出来：${e.message}`);
    console.error(dim(`  ${FACTS_PATH}`));
    console.error(
      dim('  它由 `node scripts/contract.mjs --update` 生成。手改过就重新生成一份，别手编。')
    );
    process.exit(2);
  }
}

/** 比较两次测量的结果，列出漂移。只比"会被文档引用的"字段。 */
function diffFacts(oldF, newF) {
  const drift = [];
  const cmp = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) drift.push({ what: label, was: a, now: b });
  };
  if (oldF) {
    cmp('断言总数', oldF.assertionTotal, newF.assertionTotal);
    cmp('突变数', oldF.mutationCount, newF.mutationCount);
    cmp('跟踪文件（公开）', oldF.trackedFiles?.public, newF.trackedFiles?.public);
    cmp('跟踪文件（私有）', oldF.trackedFiles?.private, newF.trackedFiles?.private);
    for (const k of Object.keys(newF.testGroups)) {
      cmp(`自测组 ${k}`, oldF.testGroups?.[k]?.checks, newF.testGroups[k].checks);
    }
    cmp('npm 脚本清单', oldF.npmScripts, newF.npmScripts);
    cmp('脚本文件清单', oldF.scripts, newF.scripts);
    cmp('pre-commit 钩子存在', oldF.hooks?.preCommitExists, newF.hooks?.preCommitExists);
    cmp('publish.mjs 存在', oldF.publish?.scriptExists, newF.publish?.scriptExists);
  }
  return drift;
}

function main() {
  const oldFacts = loadFactsFile();

  if (listOnly && fast) {
    console.log(`${red('✗')} --list 需要测量，不能与 --fast 一起用`);
    process.exit(2);
  }

  // ── --fast：不测量，拿已有权威值核文档 ──
  if (fast) {
    if (!oldFacts) {
      console.error(`${red('✗')} facts.json 不存在 —— 先跑 node scripts/contract.mjs --update`);
      process.exit(2);
    }
    const measured = oldFacts;
    const referenceCtx = { ...measured, foreignNpmScripts: oldFacts.foreignNpmScripts || [] };
    const numberClaims = [];
    const refClaims = [];
    const plannedRefs = [];
    for (const rel of [...(oldFacts.docsToCheck || []), ...(oldFacts.privateDocsToCheck || []).map((r) => `Personal Memory/${r}`)]) {
      const p = path.join(ROOT, rel);
      if (!existsSync(p)) continue;
      const text = readFileSync(p, 'utf8');
      numberClaims.push(...scanClaims(rel, text, measured));
      for (const r of scanReferences(rel, text, referenceCtx)) (r.planned ? plannedRefs : refClaims).push(r);
    }
    const bad = numberClaims.length + refClaims.length;
    if (asJson) {
      console.log(JSON.stringify({ ok: bad === 0, numberClaims, refClaims }, null, 2));
      process.exit(bad ? 1 : 0);
    }
    if (!bad) {
      console.log(`${green('✓')} 契约一致（快审计，未重新测量）`);
      process.exit(0);
    }
    for (const f of numberClaims) {
      console.log(`${red('✗')} ${f.file}:${f.line} 说「${f.claimed}」，权威值是 ${f.actual}（${f.fact}）`);
      console.log(dim(`    ${f.text}`));
    }
    for (const r of refClaims) {
      console.log(`${red('✗')} ${r.file}:${r.line} 提到${r.kind}「${r.said}」，而它不存在`);
      console.log(dim(`    ${r.text}`));
    }
    console.log(`\n${yellow('!')} 共 ${bad} 处不一致\n`);
    process.exit(1);
  }

  const measured = measure();

  if (listOnly) {
    console.log(`\n${bold('测量出来的事实')}\n`);
    const show = (k, v) => console.log(`  ${k.padEnd(26)} ${JSON.stringify(v)}`);
    show('assertionTotal', measured.assertionTotal);
    show('mutationCount', measured.mutationCount);
    show('trackedFiles', measured.trackedFiles);
    show('publish', measured.publish);
    show('hooks', { prePush: measured.hooks.prePushExists, preCommit: measured.hooks.preCommitExists });
    show('site', measured.site);
    console.log(`\n  ${dim('自测分组：')}`);
    for (const [k, v] of Object.entries(measured.testGroups)) {
      console.log(`    ${k.padEnd(14)} ${String(v.checks).padStart(4)} ${v.ok ? green('✓') : red('✗ 不过')}`);
    }
    console.log('');
    process.exit(0);
  }

  if (doUpdate) {
    const drift = diffFacts(oldFacts, measured);
    // **配置项要保住**：measure() 只产出测出来的东西，而 docsToCheck 这类
    // 是配置不是测量。直接覆盖会把作用域配置悄悄清掉，审计于是变成"什么都不查"
    // —— 那正是这个脚本要治的病，不能自己犯。
    const CONFIG_KEYS = ['_说明', 'docsToCheck', 'privateDocsToCheck', 'historicalFiles', 'foreignNpmScripts'];
    const merged = { ...measured };
    for (const k of CONFIG_KEYS) {
      if (oldFacts && k in oldFacts) merged[k] = oldFacts[k];
      else if (k === '_说明') merged[k] = 'docsToCheck 只放**描述当前状态**的文件。历史文件不放进来 —— 那里写的是当时的数字，改它等于篡改历史。';
      else if (k === 'foreignNpmScripts') merged[k] = ['verify'];
    }
    writeFileSync(FACTS_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    console.log(`\n${green('✓')} 已重新测量并写回 scripts/facts.json\n`);
    if (drift.length) {
      console.log(`${yellow('!')} 相对上一次有 ${drift.length} 处变化：`);
      for (const d of drift) {
        console.log(`    ${d.what}: ${JSON.stringify(d.was)} → ${JSON.stringify(d.now)}`);
      }
      console.log(
        dim('\n  这些数字如果出现在文档里，文档现在很可能已经过期了 —— 跑一次不带 --update 的审计看看。\n')
      );
    } else {
      console.log(dim('  与上一次测量一致。\n'));
    }
    process.exit(0);
  }

  // ── 审计 ──
  const problems = [];

  if (!oldFacts) {
    problems.push({ kind: 'facts.json 不存在', detail: '先跑 node scripts/contract.mjs --update' });
  } else {
    for (const d of diffFacts(oldFacts, measured)) {
      problems.push({ kind: '事实漂移（facts.json 过期）', detail: `${d.what}: 记着 ${JSON.stringify(d.was)}，实际 ${JSON.stringify(d.now)}` });
    }
  }

  // 文档里的数字与引用。配置项（白名单、要查哪些文件）**从 facts.json 读**，
  // 不从 measured 读 —— measured 里只有测出来的东西。
  const docFiles = oldFacts?.docsToCheck || ['README.md', 'PLAN.md'];
  const referenceCtx = { ...measured, foreignNpmScripts: oldFacts?.foreignNpmScripts || [] };
  const numberClaims = [];
  const refClaims = [];
  const plannedRefs = [];
  for (const rel of docFiles) {
    const p = path.join(ROOT, rel);
    if (!existsSync(p)) {
      problems.push({ kind: '要检查的文档不存在', detail: rel });
      continue;
    }
    const text = readFileSync(p, 'utf8');
    numberClaims.push(...scanClaims(rel, text, measured));
    for (const r of scanReferences(rel, text, referenceCtx)) {
      (r.planned ? plannedRefs : refClaims).push(r);
    }
  }

  // 私有仓的文档
  const privDocs = oldFacts?.privateDocsToCheck || [];
  for (const rel of privDocs) {
    const p = path.join(PRIVATE, rel);
    if (!existsSync(p)) {
      problems.push({ kind: '要检查的私有文档不存在', detail: `Personal Memory/${rel}` });
      continue;
    }
    const text = readFileSync(p, 'utf8');
    numberClaims.push(...scanClaims(`Personal Memory/${rel}`, text, measured));
    for (const r of scanReferences(`Personal Memory/${rel}`, text, referenceCtx)) {
      (r.planned ? plannedRefs : refClaims).push(r);
    }
  }

  const result = {
    ok: problems.length === 0 && numberClaims.length === 0 && refClaims.length === 0,
    facts: { assertionTotal: measured.assertionTotal, mutationCount: measured.mutationCount },
    problems,
    numberClaims,
    refClaims,
  };

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  console.log(`\n${bold('契约审计')}\n`);
  console.log(
    `  权威值：断言 ${measured.assertionTotal} · 突变 ${measured.mutationCount} · ` +
      `跟踪文件 ${measured.trackedFiles.public}/${measured.trackedFiles.private}（公开/私有）`
  );
  console.log(dim(`  检查了 ${docFiles.length + privDocs.length} 份描述当前状态的文件\n`));

  if (result.ok) {
    console.log(`${green('✓')} 全部一致 —— 没有发现过期的数字或指向不存在东西的引用。`);
    if (plannedRefs.length) {
      console.log(
        dim(`  （另有 ${plannedRefs.length} 处提到"计划中/待建"的东西，那是在说未来，不算不一致）`)
      );
    }
    console.log('');
    process.exit(0);
  }

  for (const p of problems) {
    console.log(`${red('✗')} ${p.kind}`);
    console.log(`    ${p.detail}`);
  }
  for (const f of numberClaims) {
    console.log(`${red('✗')} ${f.file}:${f.line} 说「${f.claimed}」，实际是 ${f.actual}（${f.fact}）`);
    console.log(dim(`    ${f.text}`));
  }
  for (const r of refClaims) {
    console.log(`${red('✗')} ${r.file}:${r.line} 提到 ${r.kind}「${r.said}」，而它不存在`);
    console.log(dim(`    ${r.text}`));
  }

  console.log(
    `\n${yellow('!')} 共 ${problems.length + numberClaims.length + refClaims.length} 处不一致。\n` +
      dim('  改文档，或者如果事实本身变了就先跑 --update。\n')
  );
  process.exit(1);
}

main();
