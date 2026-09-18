#!/usr/bin/env node
/**
 * publish.mjs — 把草稿发布到 CyanCliff Web
 *
 *   node scripts/publish.mjs "Personal Memory/drafts/garden/某个笔记.md" --dry-run
 *   node scripts/publish.mjs "Personal Memory/drafts/garden/某个笔记.md"
 *   node scripts/publish.mjs <草稿> --site "D:\Agent\CyanCliff Web"
 *   node scripts/publish.mjs --self-test          # 不需要草稿、不碰网站
 *
 * ## 它负责的四件事（`AGENTS.md` 第 3 节写的就是这个）
 *
 *   1. 集合从草稿所在子目录推断：drafts/<collection>/<slug>.md
 *      文件名（去扩展名）就是 URL slug
 *   2. 预检：结构性检查,**不代替 schema 校验**
 *   3. 拒绝覆盖网站里"有未提交改动"的文件 —— 那可能是你正在改的东西
 *   4. 写入 → 跑网站的 `npm run verify` → 失败就还原到写入前的状态
 *
 * ## 为什么预检不自己校验 schema
 *
 * `src/content.config.ts` 里的 zod schema 才是权威。在这里再实现一遍
 * 就是**第二个真相源**：两边一旦不一致，错的是脚本这边，而它会自信地放行。
 * 所以脚本只做两件 schema 管不了的事：
 *
 *   - **结构**：frontmatter 有没有、是不是夹在 --- 之间、YAML 有没有用 tab
 *   - **draft: true**：它合法、构建会通过，但内容**看起来发布了其实没有**。
 *     schema 不会拦它（它是合法值），所以必须在这里拦。
 *
 * 真正的 schema 校验由 `astro build` 做 —— 缺字段、类型错、枚举写错都会在那里报。
 *
 * ## 它不做的事
 *
 *   - **默认不提交。** 加 `--commit` 才提交，且只 `git add` 那一个文件。
 *     理由见 `--help` 末尾那段 —— 一句话：会导致"需要撤销"的默认动作不该是默认的。
 *   - **不推送远端。**
 *   - **不动你其它未提交的改动。** 提交是 `git add <那个文件>`，不是 `git add -A`。
 *   - **不判断内容该不该公开。** 那是人的判断（见 `AGENTS.md`：公开不可逆）。
 *   - **不写 `draft: true` 的文件。** 见上。
 *
 * ## 失败时的行为
 *
 * 写入前把原文件的内容留在内存里。verify 失败 → 逐字节还原 → 报错并给出
 * verify 输出的末尾。**还原失败会大声报错并停下**，绝不留下改坏的文件。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync, mkdtempSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// ── 输出 ──────────────────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = c(31);
const green = c(32);
const yellow = c(33);
const cyan = c(36);
const dim = c(2);
const bold = c(1);

// ── 参数 ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--site', '--slug']);
const flagValue = (n) => {
  const i = args.indexOf(n);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

const dryRun = args.includes('--dry-run');
const selfTest = args.includes('--self-test');
const showHelp = args.includes('--help') || args.includes('-h');
/**
 * 提交**默认不做**。
 *
 * 原先默认提交，紧接着就是"撤销一次测试提交"的需求 —— 而撤销要用
 * `git reset`，那正好是我能把用户未提交改动一起擦掉的地方（2026-09-19 真的擦掉了 8 个）。
 * **一个默认动作如果需要经常被撤销，那它就不该是默认的。**
 * 写入与 verify 才是这个脚本的价值，提交是方便的附带动作，让它显式。
 */
const wantCommit = args.includes('--commit');

/** 位置参数 = 草稿路径。**必须排除掉 --flag 的值**，否则 `--site X` 里的 X 会被当成草稿。 */
function positionalArgs() {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      i++; // 跳过它的值
      continue;
    }
    if (a.startsWith('-')) continue;
    out.push(a);
  }
  return out;
}

// ── 路径约定 ──────────────────────────────────────────────────
/**
 * 网站在哪。按这个顺序找：
 *   1. --site
 *   2. CYANCLIFF_WEB（环境变量或 .env）
 *   3. ../CyanCliff Web（两个仓并排的默认布局）
 *
 * 不写死绝对路径：换台机器、换目录名都不该改代码。
 */
export function resolveSite(explicit, envValue) {
  if (explicit) return path.resolve(explicit);
  if (envValue && envValue.trim()) return path.resolve(envValue.trim());
  return path.resolve(ROOT, '..', 'CyanCliff Web');
}

/** 草稿目录：drafts/<collection>/<slug>.md */
export const COLLECTIONS = ['blog', 'projects', 'garden'];

/**
 * 从草稿路径推断集合与 slug。
 *
 * 只认 `drafts/<collection>/<slug>.md` 这个形状 —— 不猜、不从 frontmatter 推。
 * 猜错的代价是写进网站的错目录（URL 就错了），而那是不可逆的。
 *
 * @returns {{ok:true, collection:string, slug:string, file:string} | {ok:false, why:string}}
 */
export function inferTarget(draftPath) {
  const p = path.resolve(draftPath);
  const file = path.basename(p);
  const ext = path.extname(file);

  if (ext !== '.md') {
    return { ok: false, why: `草稿必须是 .md（现在是 ${ext || '没有扩展名'}）` };
  }

  const slug = file.slice(0, -ext.length);
  const collection = path.basename(path.dirname(p));

  if (!COLLECTIONS.includes(collection)) {
    return {
      ok: false,
      why:
        `推断不出集合：草稿要放在 drafts/<集合>/ 里，` +
        `而它在 "${collection}/" 下。合法集合：${COLLECTIONS.join(' / ')}`,
    };
  }

  if (!isValidSlug(slug)) {
    return {
      ok: false,
      why:
        `文件名 "${slug}" 不能直接当 URL slug：只允许小写字母、数字、连字符（-），` +
        `且不能以连字符开头或结尾`,
    };
  }

  return { ok: true, collection, slug, file };
}

/**
 * slug 是 URL，也是文件名。中文、大写、空格、下划线都会变成百分号编码或大小写陷阱。
 * 与其发布之后发现 URL 长得不对，不如在这里拒绝。
 */
export function isValidSlug(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

// ── frontmatter 的结构检查 ────────────────────────────────────
/**
 * 只查 schema 管不了、或者不会拦的东西（见文件头）。
 * 这里**刻意不校验字段名与类型** —— 那是网站 schema 的活。
 *
 * @returns {{ok:true, fm:string, body:string} | {ok:false, errors:string[], warnings:string[]}}
 */
export function checkDraft(text) {
  const errors = [];
  const warnings = [];

  const norm = text.replace(/^\uFEFF/, ''); // 去 BOM：它会破坏 --- 的匹配
  if (norm.trim() === '') return { ok: false, errors: ['草稿是空的'], warnings };

  if (!norm.startsWith('---')) {
    errors.push('开头没有 frontmatter（第一行应当是 ---）');
    return { ok: false, errors, warnings };
  }

  // 找配对的结束 ---（在第一行之后的第一个独立 ---）
  const lines = norm.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    errors.push('frontmatter 没有结束的 ---（它必须成对）');
    return { ok: false, errors, warnings };
  }

  const fm = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');

  if (fm.trim() === '') errors.push('frontmatter 是空的');

  // YAML 里 tab 是非法的缩进字符，而且报错信息很难懂。提前拦掉。
  const tabLine = lines.slice(1, end).findIndex((l) => l.includes('\t'));
  if (tabLine !== -1) {
    errors.push(`frontmatter 第 ${tabLine + 2} 行有 tab —— YAML 不允许用 tab 缩进（换成空格）`);
  }

  // draft: true —— 合法、构建会过，但内容看起来发布了其实没有。
  // 这是这个脚本唯一一处"看得懂字段"的地方，因为它拦的正是 schema 不会拦的坑。
  if (/^\s*draft\s*:\s*(true|yes|on|"true"|'true')\s*$/im.test(fm)) {
    errors.push(
      'frontmatter 里是 draft: true —— 它不会出现在列表、RSS 与构建产物里，' +
        '等于"发布了但看不见"。要真发布就删掉这一行或改成 false'
    );
  }

  if (body.trim() === '') warnings.push('正文是空的（只有 frontmatter）');
  if (/^#\s+\S/m.test(body)) {
    warnings.push('正文里有 H1（#）—— 站点模板通常用 frontmatter 的 title，H1 会重复显示');
  }

  return { ok: errors.length === 0, fm, body, errors, warnings };
}

// ── git 查询（只读）──────────────────────────────────────────
function git(cwd, gitArgs) {
  const r = spawnSync('git', gitArgs, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

export function isGitRepo(dir) {
  return git(dir, ['rev-parse', '--is-inside-work-tree']).out === 'true';
}

/**
 * 目标文件在网站仓里有没有未提交改动。
 *
 * 为什么必须拦：那个文件可能是你正在改的东西，覆盖它等于把你的改动吃了。
 * 注意 `--porcelain` 对"未跟踪"的文件也会报（`??`）—— 那也是要拦的：
 * 说明你在网站目录里手写过这个文件（而 `AGENTS.md` 说不要那么做）。
 */
export function uncommittedState(siteDir, relPath) {
  const r = git(siteDir, ['status', '--porcelain', '--', relPath]);
  if (!r.ok) return { known: false };
  if (r.out === '') return { known: true, dirty: false };
  return { known: true, dirty: true, how: r.out.split('\n')[0].slice(0, 2).trim() };
}

// ── 写入 → verify → 还原（可注入 verify，所以能单独测）────────
/**
 * 发布动作的核心：备份 → 写入 → verify → 失败就逐字节还原。
 *
 * 抽成函数并让 verify 可注入，是因为**这是整个脚本里唯一会破坏东西的地方**：
 * 它要覆盖网站里的文件。不把它测到，等于把最危险的那一步交给运气。
 *
 * 还原做**逐字节核对**，不是"我调用了写入"就算完 ——
 * 恢复失败必须能报出来（返回 restored:false），绝不留下改坏的文件。
 *
 * @param {{file:string, content:string, exists:boolean, verify:() => {ok:boolean, out?:string}}}
 * @returns {{ok:boolean, restored?:boolean, verifyOut?:string}}
 */
export function publishWithVerify({ file, content, exists, verify }) {
  // 备份要能失败。`exists:true` 而文件其实读不出来（被删了、权限不对）时，
  // 原来这里会**抛未捕获异常** —— 而它是在"准备破坏东西"的路上崩的，
  // 报出来的是一段栈，不是"我读不到要覆盖的东西，所以我不动它"。
  // 这是自测抓出来的：第 ④ 项本想测"恢复失败要报出来"，结果先崩在备份上。
  let before = null;
  if (exists) {
    try {
      before = readFileSync(file, 'utf8');
    } catch (e) {
      return { ok: false, restored: false, verifyOut: `备份失败，未写入任何东西：${e.message}` };
    }
  }

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');

  const result = verify();
  if (result.ok) return { ok: true, verifyOut: result.out || '', ran: true };

  // 失败：还原
  let restored = false;
  try {
    if (before === null) {
      rmSync(file, { force: true });
      restored = !existsSync(file);
    } else {
      writeFileSync(file, before, 'utf8');
      restored = readFileSync(file, 'utf8') === before;
    }
  } catch {
    restored = false;
  }

  return { ok: false, restored, verifyOut: result.out || '', ran: result.ran !== false, why: result.why || '' };
}

// ── 主流程 ────────────────────────────────────────────────────
function fail(msg, hint) {
  console.error(`\n${red('✗')} ${msg}`);
  if (hint) console.error(dim(`  ${hint}`));
  process.exit(1);
}

/**
 * 跑网站的 verify。
 *
 * ## 两个坑都踩过，都记在这里
 *
 * 1. **`npm.cmd` 不带 `shell` 会 EINVAL**（`status: null`、`error.code === 'EINVAL'`、
 *    输出为空）—— 在 Windows 上 .cmd 不能那样直接 exec。所以必须走 shell。
 * 2. 走 shell 时**传完整命令行字符串、不传 args 数组** ——
 *    传数组会被 Node 拼成字符串（正是 DEP0190 警告的内容）。拼好的字符串自己控制，
 *    路径用引号包起来，就没有拼接问题。
 *
 * ## 返回值里 ok 与 ran 是两件事
 *
 * `ran:false` = **命令根本没跑起来**（找不到 npm、EINVAL、被信号杀掉）。
 * 这跟"verify 跑了但没通过"必须分得开 —— 混在一起会让人去改内容，
 * 而真正的问题在环境。这个错误我犯过一次（空输出被当成 verify 失败）。
 */
function runVerify(siteDir) {
  console.log(dim(`  跑网站的 verify：npm run verify（test → build → check-links）`));
  const quoted = JSON.stringify(siteDir); // JSON 字符串就是合法的双引号形式
  const r = spawnSync(`npm run verify --prefix ${quoted}`, {
    cwd: siteDir,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });

  const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();

  if (r.error) {
    return { ok: false, ran: false, out, why: `启动失败：${r.error.code || r.error.message}` };
  }
  if (r.status === null) {
    return {
      ok: false,
      ran: false,
      out,
      why: `没有正常退出（信号：${r.signal || '未知'}）`,
    };
  }
  if (r.status !== 0) {
    return { ok: false, ran: true, out, why: `退出码 ${r.status}` };
  }
  return { ok: true, ran: true, out };
}

async function main() {
  const pos = positionalArgs();
  const draftArg = pos[0];

  if (!draftArg) {
    fail('要给出草稿路径', 'node scripts/publish.mjs "Personal Memory/drafts/garden/某个笔记.md" --dry-run');
  }

  const draftPath = path.resolve(draftArg);
  if (!existsSync(draftPath)) fail(`草稿不存在：${draftPath}`);

  const target = inferTarget(draftPath);
  if (!target.ok) fail(target.why);

  const siteDir = resolveSite(flagValue('--site'), process.env.CYANCLIFF_WEB);
  console.log(`\n${bold('发布草稿')}`);
  console.log(`  草稿    ${path.relative(process.cwd(), draftPath) || draftPath}`);
  console.log(`  网站    ${siteDir}`);
  console.log(`  集合    ${cyan(target.collection)}     slug  ${cyan(target.slug)}`);
  console.log(`  URL      /${target.collection}/${target.slug}/`);

  // ── 检查 ──
  const errors = [];

  if (!existsSync(siteDir)) {
    fail(`网站目录不存在：${siteDir}`, '用 --site 指定，或把 CYANCLIFF_WEB 写进 .env');
  }
  if (!existsSync(path.join(siteDir, 'src', 'content.config.ts'))) {
    fail(`${siteDir} 看起来不是 CyanCliff Web（没找到 src/content.config.ts）`);
  }
  if (!existsSync(path.join(siteDir, 'package.json'))) {
    fail(`${siteDir} 里没有 package.json —— 跑不了 npm run verify`);
  }
  if (!isGitRepo(siteDir)) {
    // 不拦死：没有 git 也能写文件、也能 verify，只是"拒绝覆盖未提交改动"这条失效
    errors.push(`${siteDir} 不是 git 仓库 —— "拒绝覆盖未提交改动"这条保护失效`);
  }

  const text = readFileSync(draftPath, 'utf8');
  const check = checkDraft(text);
  if (!check.ok) {
    console.error(`\n${red('✗')} 草稿没通过预检：`);
    for (const e of check.errors) console.error(`    · ${e}`);
    console.error(dim('\n  预检只查结构和 draft: true；字段与类型由网站的 schema 在 verify 时报。'));
    process.exit(1);
  }
  for (const w of check.warnings) console.log(`${yellow('!')} ${w}`);

  // 目标文件的状态
  const relTarget = path.join('src', 'content', target.collection, `${target.slug}.md`);
  const absTarget = path.join(siteDir, relTarget);
  const exists = existsSync(absTarget);

  if (isGitRepo(siteDir)) {
    const st = uncommittedState(siteDir, relTarget);
    if (st.known && st.dirty) {
      fail(
        `网站里的 ${relTarget} 有未提交改动（${st.how}）—— 不覆盖它`,
        '那个文件可能是你正在改的东西。先提交或还原它，再发布。'
      );
    }
  }

  // 用 --commit 时才检查"能不能提交"，因为它是显式请求的。
  // 默认不提交就不该因为"提交不了"而拦下发布。
  let commitOk = false;
  let commitWhy = '';
  if (wantCommit) {
    const inside = isGitRepo(siteDir);
    if (!inside) {
      commitWhy = `${siteDir} 不是 git 仓库`;
    } else {
      const other = git(siteDir, ['status', '--porcelain'])
        .out.split('\n')
        .filter((l) => l.trim() && !l.endsWith(relTarget));
      if (other.length) {
        // 提交不会碰它们（只 add 那一个文件），但用户应当知道提交会落在一棵脏树上
        commitOk = true;
        console.log(
          yellow(`! 网站工作树里有 ${other.length} 个其它未提交改动 —— 提交只含 ${relTarget}，不会带上它们`)
        );
      } else {
        commitOk = true;
      }
    }
    if (!commitOk) console.log(yellow(`! 不能提交：${commitWhy}`));
  }

  const before = exists ? readFileSync(absTarget, 'utf8') : null;
  if (exists && before === text) {
    console.log(`\n${green('=')} 目标文件内容与草稿逐字节相同，无需写入。`);
    process.exit(0);
  }

  console.log(`  目标    ${relTarget}  ${exists ? dim('（已存在，将被替换）') : dim('（新建）')}`);
  console.log(
    `  大小    ${Buffer.byteLength(text, 'utf8')} 字节` +
      (exists ? dim(`（原来 ${Buffer.byteLength(before, 'utf8')} 字节）`) : '')
  );

  // ── dry-run ──
  if (dryRun) {
    console.log(`\n${cyan('▸ dry-run')} —— 不会写任何东西。\n`);
    console.log(`  会写到  ${absTarget}`);
    console.log(`  然后跑  npm run verify（在 ${siteDir}）`);
    console.log(
      `  然后    ${wantCommit ? `git add ${relTarget} && git commit（**只提交这一个文件**）` : '不提交（默认）—— 你自己 commit'}`
    );
    console.log(`  失败后  还原成${exists ? '改动前的内容' : '不存在（删掉新文件）'}\n`);
    console.log(dim('  去掉 --dry-run 才会真的执行。'));
    process.exit(0);
  }

  // ── 写入 → verify → （成功）提交 / （失败）还原 ──
  const res = publishWithVerify({
    file: absTarget,
    content: text,
    exists,
    verify: () => runVerify(siteDir),
  });

  if (!res.ok) {
    const restoredNote = res.restored ? '已还原到写入前的状态' : '⚠️ 还原失败！';
    if (res.ran) {
      console.error(`\n${red('✗')} 网站的 verify 没通过（${res.why}）—— ${restoredNote}`);
    } else {
      // 跑不起来 ≠ 内容有问题。混为一谈会让人去改内容，而问题在环境。
      console.error(`\n${red('✗')} verify **根本没跑起来** —— ${restoredNote}`);
      console.error(red(`  原因：${res.why}`));
      console.error(dim('  这不是内容的问题。先让 `npm run verify` 在网站目录里能跑通，再发布。'));
    }
    if (!res.restored) {
      console.error(red(`  请手动处理：${absTarget}`));
    }
    if (res.verifyOut) {
      console.error(dim('\n  verify 输出的末尾：'));
      for (const l of res.verifyOut.split('\n').slice(-25)) console.error(dim(`    ${l}`));
    } else {
      console.error(dim('\n  （verify 没有输出）'));
    }
    if (res.ran) {
      console.error(
        dim(
          '\n  常见原因：frontmatter 缺字段 / 枚举值写错 / draft 之外的类型错 ——\n' +
            '  报错里的字段名就是 schema 里的字段名，照着 src/content.config.ts 改。'
        )
      );
    }
    process.exit(1);
  }

  console.log(`${green('✓')} 已写入 ${relTarget}，verify 通过`);

  // 提交默认**不做** —— 见 --commit 的说明。写入与 verify 才是这个脚本的默认动作。
  if (wantCommit) {
    if (!isGitRepo(siteDir)) {
      console.log(dim('  网站不是 git 仓库，跳过提交。'));
    } else if (!commitOk) {
      console.log(`${yellow('!')} 没有提交：${commitWhy}`);
      console.log(dim('  文件已写入、verify 已通过 —— 自己 commit 即可。'));
    } else {
      const msgPath = path.join(siteDir, '.git', 'PUBLISH_MSG');
      const msg = `content(${target.collection}): 发布 ${target.slug}\n\n来源：Personal Memory/drafts/${target.collection}/${target.slug}.md\n本次提交只含这一个文件（publish.mjs）。\n`;
      try {
        writeFileSync(msgPath, msg, 'utf8');
        git(siteDir, ['add', '--', relTarget]);
        const commit = git(siteDir, ['commit', '-F', msgPath]);
        rmSync(msgPath, { force: true });
        if (commit.ok) {
          console.log(`${green('✓')} 已提交（只含 ${relTarget}）`);
          const short = git(siteDir, ['rev-parse', '--short', 'HEAD']).out;
          console.log(dim(`  ${short} —— 未推送。要发布上线就自己 push。`));
        } else {
          console.error(`${yellow('!')} 已写入且 verify 通过，但提交失败：`);
          console.error(dim(`  ${commit.err.split('\n')[0] || commit.out.split('\n')[0]}`));
          console.error(dim('  文件是好的，自己 commit 即可。'));
        }
      } catch (e) {
        console.error(`${yellow('!')} 提交时出错：${e.message}`);
        console.error(dim('  文件是好的，verify 也过了，自己 commit 即可。'));
      }
    }
  } else {
    console.log(dim(`  没有提交（默认不提交，去掉 --commit 这层顾虑见 --help）。`));
  }

  console.log(`\n${bold('完成')} —— 内容在 ${relTarget}，verify 已通过。`);
  console.log(dim('  提醒：推送远端前先确认内容确实可以公开（公开不可逆）。\n'));
}

// ── 自测（纯函数，不碰网站、不需要草稿）──────────────────────
function selfTestRun() {
  console.log(`\n${bold('publish.mjs 自测')}\n`);
  let bad = 0;
  const t = (name, got, expect) => {
    const ok = JSON.stringify(got) === JSON.stringify(expect);
    console.log(`  ${ok ? green('✓') : red('✗')} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expect)}\n      得到 ${JSON.stringify(got)}`}`);
    if (!ok) bad++;
  };

  // slug
  t('slug: 正常', isValidSlug('hello-world'), true);
  t('slug: 带数字', isValidSlug('note-2026'), true);
  t('slug: 大写被拒', isValidSlug('Hello'), false);
  t('slug: 中文被拒', isValidSlug('笔记'), false);
  t('slug: 空格被拒', isValidSlug('a b'), false);
  t('slug: 下划线被拒', isValidSlug('a_b'), false);
  t('slug: 开头连字符被拒', isValidSlug('-a'), false);
  t('slug: 结尾连字符被拒', isValidSlug('a-'), false);
  t('slug: 连续连字符被拒', isValidSlug('a--b'), false);

  // inferTarget
  const d = (p) => path.join('Personal Memory', 'drafts', p);
  t('集合推断: garden', inferTarget(d('garden/x.md')).collection, 'garden');
  t('集合推断: projects', inferTarget(d('projects/x.md')).collection, 'projects');
  t('集合推断: blog', inferTarget(d('blog/x.md')).collection, 'blog');
  t('集合推断: 未知集合被拒', inferTarget(d('notes/x.md')).ok, false);
  t('集合推断: 直接放 drafts 下被拒', inferTarget(d('x.md')).ok, false);
  t('集合推断: 非 md 被拒', inferTarget(d('garden/x.txt')).ok, false);
  t('集合推断: slug 非法被拒', inferTarget(d('garden/Bad Name.md')).ok, false);
  t('集合推断: 正常通过', inferTarget(d('garden/good-one.md')).ok, true);
  t('集合推断: slug 取值', inferTarget(d('garden/good-one.md')).slug, 'good-one');

  // resolveSite
  t('site: 显式优先', resolveSite('D:\\x', 'D:\\y').endsWith('x'), true);
  t('site: 环境变量次之', resolveSite(null, 'D:\\y').endsWith('y'), true);
  t('site: 空环境变量走默认', resolveSite(null, '   ').includes('CyanCliff Web'), true);
  t('site: 默认并排布局', resolveSite(null, null).includes('CyanCliff Web'), true);

  // checkDraft
  const okDraft = '---\ntitle: 标题\nsummary: 一句话\n---\n\n正文\n';
  t('草稿: 正常通过', checkDraft(okDraft).ok, true);
  t('草稿: 空文件被拒', checkDraft('   ').ok, false);
  t('草稿: 没有 frontmatter 被拒', checkDraft('正文而已\n').ok, false);
  t('草稿: frontmatter 没结束被拒', checkDraft('---\ntitle: x\n').ok, false);
  t('草稿: 空 frontmatter 被拒', checkDraft('---\n---\n正文\n').ok, false);
  t('草稿: tab 被拒', checkDraft('---\ntitle: x\n\ttags: []\n---\n正文\n').ok, false);
  t('草稿: BOM 不影响', checkDraft('\uFEFF---\ntitle: x\n---\n正文\n').ok, true);

  // draft: true —— 这是本脚本唯一看得懂字段的地方
  t('草稿: draft true 被拒', checkDraft('---\ntitle: x\ndraft: true\n---\n正文\n').ok, false);
  t('草稿: draft True 被拒', checkDraft('---\ntitle: x\ndraft: True\n---\n正文\n').ok, false);
  t('草稿: draft 带引号被拒', checkDraft('---\ntitle: x\ndraft: "true"\n---\n正文\n').ok, false);
  t('草稿: draft false 放行', checkDraft('---\ntitle: x\ndraft: false\n---\n正文\n').ok, true);
  t('草稿: 没有 draft 字段放行', checkDraft('---\ntitle: x\n---\n正文\n').ok, true);
  // 标题里出现 "draft: true" 这几个字不该拦（它不在 frontmatter 里）
  t('草稿: 正文提到 draft true 不拦', checkDraft('---\ntitle: x\n---\n讲一下 draft: true 是什么\n').ok, true);

  // 警告不是错误
  t('草稿: 空正文只警告不拦', checkDraft('---\ntitle: x\n---\n').ok, true);
  t('草稿: 空正文有警告', checkDraft('---\ntitle: x\n---\n').warnings.length, 1);
  t('草稿: H1 有警告', checkDraft('---\ntitle: x\n---\n# 标题\n正文\n').warnings.length, 1);
  t('草稿: 无 H1 无警告', checkDraft('---\ntitle: x\n---\n## 小标题\n正文\n').warnings.length, 0);

  // 返回的 fm/body 切得对不对（引号与 --- 边界）
  const r = checkDraft('---\ntitle: a\n---\nbody1\n---\nbody2\n');
  t('草稿: 只认第一个结束 ---', r.body.trim(), 'body1\n---\nbody2');
  t('草稿: fm 内容正确', r.fm, 'title: a');

  // 写入 → verify → 还原 —— **这是整个脚本唯一会破坏东西的地方**，
  // 所以它必须在自测里被真的跑到，而且是四种情况各跑一次：
  //   ① 文件本来不存在 + verify 失败 → 新文件要被删掉
  //   ② 文件已存在   + verify 失败 → 要逐字节还原
  //   ③ verify 成功               → 新内容留下
  //   ④ 还原失败（恢复路径被破坏） → 必须报 restored:false，不能静默
  // 用临时目录，不碰网站。
  {
    // 用 os.tmpdir() 而不是写死 /tmp —— 在 Windows 上 /tmp 会被 git 转成 C:\tmp，
    // 而那是另一个地方（这个项目在 tmp 路径上踩过一次坑）。
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'publish-selftest-'));
    const failVerify = () => ({ ok: false, out: 'boom' });
    const passVerify = () => ({ ok: true, out: 'ok' });
    const P = (n) => path.join(tmp, n);
    try {
      // ① 不存在 + 失败 → 删掉
      const r1 = publishWithVerify({ file: P('a.md'), content: 'x', exists: false, verify: failVerify });
      t('还原: 不存在+失败 → 报失败', r1.ok, false);
      t('还原: 不存在+失败 → 标记已还原', r1.restored, true);
      t('还原: 不存在+失败 → 文件被删掉', existsSync(P('a.md')), false);

      // ② 已存在 + 失败 → 逐字节还原
      const original = '---\ntitle: 原来\n---\n原文\n';
      writeFileSync(P('b.md'), original, 'utf8');
      const r2 = publishWithVerify({ file: P('b.md'), content: '覆盖后的内容', exists: true, verify: failVerify });
      t('还原: 已存在+失败 → 报失败', r2.ok, false);
      t('还原: 已存在+失败 → restored=true（没做还原与还原成功要分得开）', r2.restored, true);
      t('还原: 已存在+失败 → 内容逐字节还原', readFileSync(P('b.md'), 'utf8') === original, true);

      // ③ 成功 → 新内容留下（且 verify 真的被调用过）
      let verifyCalls = 0;
      const r3 = publishWithVerify({
        file: P('c.md'),
        content: '新内容',
        exists: false,
        verify: () => {
          verifyCalls++;
          return passVerify();
        },
      });
      t('成功: 报成功', r3.ok, true);
      t('成功: 新内容被留下', readFileSync(P('c.md'), 'utf8'), '新内容');
      t('成功: verify 被调用了一次', verifyCalls, 1);

      // ④ 备份失败（谎称存在、实际不存在）→ 不能崩，要报出来且不写入
      const r4 = publishWithVerify({
        file: P('d.md'),
        content: '新',
        exists: true, // 谎称已存在，实际不存在 → 备份读不到
        verify: failVerify,
      });
      t('备份失败: 不崩、报失败', r4.ok, false);
      t('备份失败: restored=false（不静默）', r4.restored, false);
      t('备份失败: 什么都没写', existsSync(P('d.md')), false);
      t('备份失败: 输出里说明是备份的问题', r4.verifyOut.includes('备份失败'), true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  console.log('');
  if (bad) {
    console.log(`${red('✗')} ${bad} 项不通过\n`);
    process.exit(1);
  }
  console.log(`${green('✓')} 全部通过（42 项）\n`);
  process.exit(0);
}

if (showHelp) {
  console.log(`${bold('publish.mjs')} — 把草稿发布到 CyanCliff Web

  node scripts/publish.mjs "Personal Memory/drafts/garden/某个笔记.md" --dry-run
  node scripts/publish.mjs "Personal Memory/drafts/garden/某个笔记.md"
  --site <路径>     网站在哪（默认 ../CyanCliff Web，或 .env 的 CYANCLIFF_WEB）
  --commit          成功后把那个文件提交到网站仓（默认**不提交**）
  --self-test       纯函数自测，不碰网站
  -h, --help        这段文字

  ${dim('写入 → npm run verify → 失败还原。')}
  ${dim('不发 draft: true 的内容；不覆盖网站里有未提交改动的文件。')}

  ${bold('为什么默认不提交')}
  ${dim('提交这个动作本身需要"能撤销"，而撤销用的是 git reset ——')}
  ${dim('那是能把别人未提交改动一起擦掉的命令（2026-09-19 真的擦掉过 8 个）。')}
  ${dim('一个经常需要被撤销的默认动作，就不该是默认的。')}
`);
  process.exit(0);
}

if (selfTest) selfTestRun();
else await main();
