#!/usr/bin/env node
/**
 * cite-check.mjs — 引用核验器
 *
 * 核验引用能不能在资料里被重新找到。这是"出处可查"唯一的实际保障：
 * 没有检查器，一套引用格式只是排版上的礼貌。
 *
 *   node scripts/cite-check.mjs                         # 扫描 --scan（默认 docs/）
 *   node scripts/cite-check.mjs <文件.md>                # 只检查指定文件
 *   node scripts/cite-check.mjs --explain               # 打印引用格式说明
 *   node scripts/cite-check.mjs --scan notes --root .   # 换扫描目录与资料根
 *
 * 路径约定：引用写成 `library/<文件>.md:<行号>`，
 * 工具到 `<root>/library/` 下找这个文件。`--root` 改的就是这个根。
 * `--scan` 的值**相对 --root 解析**（写绝对路径也可以）。
 *
 * 引用格式：
 *
 *   1. `library/x.md:42`              文本原生资料
 *   2. “引用原文”（library/x.md:42）    带到行号
 *   3. （library/x.pdf 第7页）          只到原件，没有 md
 *
 * 核验做到哪一步、没做到哪一步 —— 别把"绿了"当成超过它实际含义的东西：
 *
 *   做   md 存在；行号在范围里；引用的原文在那一行（或跨行）里
 *   不做 判断引文是否忠实于 PDF 原件 —— 需要解析器，v1 有意不做
 *        所以「原文」类可引用性目前只保证到 md 这一层
 *
 * 只读，不改任何东西。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function flagValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** 资料根目录：引用里的 `library/...` 是相对它算的。 */
const ROOT = path.resolve(flagValue('--root', path.join(HERE, '..')));
/**
 * 不带文件参数时扫描哪个目录（条目文件所在处）。
 * **相对当前工作目录解析**，不是相对 ROOT —— 两者常常不是同一个地方：
 * 条目可能在一个仓库里，而它们引用的资料在另一个仓库里。
 * 用 --root 指定资料在哪，用 --scan 指定条目在哪。
 */
const SCAN = flagValue('--scan', path.join(ROOT, 'docs'));

// ── 输出 ──────────────────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = c(31);
const green = c(32);
const yellow = c(33);
const dim = c(2);
const bold = c(1);

// ── 引用语法 ──────────────────────────────────────────────────
// 只认中文全角引号 “”；半角引号留给代码，省得把 JS 字符串当成引用。
const RE_QUOTED = /“([^“”]+)”[^\S\n]*[（(]\s*((?:library|private)\/[^\s:()]+?\.md):(\d+)\s*[)）]/g;
const RE_PATH_LINE = /\b((?:library|private)\/[^\s:()"'`“”]+?\.md):(\d+)\b/g;
const RE_ORIGINAL_ONLY = /[（(]\s*((?:library|private)\/[^\s()“”]+?\.(?:pdf|png|jpe?g|webp|html?))\s+第\s*(\d+)\s*页\s*[)）]/g;

const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

/**
 * 收集引用，跳过三种"不是引用"的内容：
 *
 *   1. 代码围栏（``` / ~~~）整块
 *   2. 反引号行内代码 `like this`
 *   3. 显式示例区（示例区标记，见 README）
 *
 * 为什么必须跳过：条目文件自己会用示例展示引用格式，
 * 那些示例是文档，不是真引用，拿它们去 library/ 里找必然失败。
 *
 * 代价要说清楚：**写进反引号或围栏里的引用不会被核验**。
 * 想让一条引用被检查，就不要把它包进代码里。
 */
function collectRefs(text) {
  const lines = text.split(/\r?\n/);
  const body = [];
  let inFence = false;
  let inExample = false;

  for (const line of lines) {
    // 示例区标记独立成行，不受围栏影响 —— 否则围栏那行的 continue
    // 会把标记吞掉，状态机就错乱了。
    if (/^\s*<!--\s*cite-check:off\b.*-->\s*$/.test(line)) {
      inExample = true;
      continue;
    }
    if (/^\s*<!--\s*cite-check:on\s*-->\s*$/.test(line)) {
      inExample = false;
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && !inExample) {
      // 剥掉行内代码。用一个空白占位，避免把前后文粘成一个词。
      body.push(line.replace(/`[^`]*`/g, ' '));
    }
  }

  const quotes = [];
  const pathLines = [];
  const pages = [];

  for (const line of body) {
    for (const m of line.matchAll(RE_QUOTED)) {
      quotes.push({ path: m[2], line: Number(m[3]), quote: m[1] });
    }
    for (const m of line.matchAll(RE_PATH_LINE)) {
      pathLines.push({ path: m[1], line: Number(m[2]) });
    }
    for (const m of line.matchAll(RE_ORIGINAL_ONLY)) {
      pages.push({ path: m[1], page: Number(m[2]) });
    }
  }

  const refs = [];
  const claimed = new Set();

  for (const q of quotes) {
    refs.push({ kind: '原文+行号', path: q.path, line: q.line, page: null, quote: q.quote });
    claimed.add(`${q.path}:${q.line}`);
  }
  for (const p of pathLines) {
    if (claimed.has(`${p.path}:${p.line}`)) continue;
    refs.push({ kind: 'md:行号', path: p.path, line: p.line, page: null, quote: null });
  }
  for (const p of pages) {
    refs.push({ kind: '原件:页', path: p.path, line: null, page: p.page, quote: null });
  }
  return refs;
}

/**
 * 把文本压成"丢空白"的串，并保留每个字符回到原行的映射。
 *
 * 为什么需要：引文经常跨行。逐行匹配会让一段跨行的引文变成
 * "整份资料都找不到"，从而把一条**好引用误报成坏引用**。
 */
function haystack(text) {
  const chars = [];
  const lineOf = [];
  const raw = text.replace(/^\uFEFF/, '');
  raw.split(/\r?\n/).forEach((line, i) => {
    for (const ch of line) {
      if (/\s/.test(ch)) continue;
      chars.push(ch);
      lineOf.push(i + 1);
    }
  });
  return { s: chars.join(''), lineOf };
}

const squash = (s) =>
  // 空白一律归一：普通空格、NBSP(U+00A0)、各类 Unicode 空格都算同一个东西。
  // 否则 `0.5\xa0表示` 和 `0.5 表示` 会被判成不同 —— 那对引用者是假警报，
  // 肉眼看不出差别，却要花时间查。
  s.replace(/[\s\u00a0\u2000-\u200b\u3000]+/g, '').normalize('NFC');

function physicalLines(text) {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/);
}

function checkOne({ kind, path: rel, line, page, quote }) {
  // rel 形如 `library/x.md`，相对 ROOT 解析（--root 可改）。
  const abs = path.resolve(ROOT, rel);

  if (!existsSync(abs)) return { ok: false, why: `资料不存在：${rel}（相对 ${ROOT}）` };

  // 只到原件那一类：文件还在就算通过，页码由人看。
  if (kind === '原件:页') {
    if (!(page >= 1)) return { ok: false, why: `页码 ${page} 不合法` };
    return { ok: true };
  }

  if (!rel.endsWith('.md')) {
    return { ok: false, why: `路径行号引用只能指向 .md，这里是 ${path.extname(rel) || '无扩展名'}` };
  }

  const lines = physicalLines(readFileSync(abs, 'utf8'));

  if (!(line >= 1 && line <= lines.length)) {
    return { ok: false, why: `行号 ${line} 超范围（文件共 ${lines.length} 行）` };
  }

  if (!quote) return { ok: true };

  // 先在声明的行上找 —— 这是引用正确时的快路径。
  // 用 squash 而不是 includes：不换行空格、全半角这类差异不该判为失败。
  if (squash(lines[line - 1]).includes(squash(quote))) return { ok: true };

  // 再在整份资料里找 —— 找得到就是行号漂移，找不到才是真坏。
  const { s, lineOf } = haystack(readFileSync(abs, 'utf8'));
  const q = squash(quote);
  const at = s.indexOf(q);

  if (at === -1) {
    return {
      ok: false,
      why: `引文在整个 ${rel} 里都找不到`,
      hint: '行号漂移和转换有损都排除了：这条引用本身是坏的，不要当它成立',
    };
  }

  const from = lineOf[at];
  const to = lineOf[Math.min(at + q.length - 1, lineOf.length - 1)];

  // 同一行上仍有字符差异（常见：上下标、全角半角、连字符）。
  // 这**不是**行号漂移，两者的修法完全不同 —— 所以话要说准。
  if (from === to && from === line) {
    return {
      ok: false,
      why: `引文和第 ${line} 行**不完全一致**，差异在字符层面`,
      hint: '常见原因：上下标（σ02 vs σ²₀）、全角半角、行尾连字符、PDF 的字符编码错误。' +
        '逐字核对那一行，或把引文改成原文里的确切写法。',
    };
  }

  return {
    ok: false,
    why: `引文在 ${rel} 里，但不在第 ${line} 行`,
    hint: `实际在第 ${from === to ? from : `${from}–${to}`} 行 —— 引用漂移了`,
  };
}

// ── 入口 ──────────────────────────────────────────────────────
const argv = process.argv.slice(2);

if (argv.includes('--explain')) {
  console.log(`${bold('引用格式')}

  ${green('library/x.md:42')}               文本原生资料
  ${green('“原文…”（library/x.md:42）')}      带到行号（引文可以跨行）
  ${green('（library/x.pdf 第7页）')}         只到原件，没有 md

${bold('核验做到哪一步')}

  做   md 存在；行号在范围里；引用的原文在那一行（或跨行）里
  不做 判断引文是否忠实于 PDF 原件 —— 需要解析器，v1 有意不做

${dim('所以「原文」类可引用性目前只保证到 md 这一层。')}
${dim('代码围栏里的示例会被跳过 —— 那些是文档，不是引用。')}
${dim('围栏之外的示例可以用示例区标记圈起来，标记写法见 README。')}
`);
  process.exit(0);
}

// 带值的开关：它们后面的那个词是**参数值**，不是要检查的文件。
// 不显式跳过的话 `--scan notes` 里的 notes 会被当成文件路径，
// 而目录不是文件 —— 会以 EISDIR 崩掉。
const VALUE_FLAGS = new Set(['--scan', '--root']);

const fileArgs = argv.filter((a, i) => {
  if (a.startsWith('--')) return false;
  return !VALUE_FLAGS.has(argv[i - 1]);
});

const scanDir = path.isAbsolute(SCAN) ? SCAN : path.resolve(process.cwd(), SCAN);

if (!fileArgs.length && !existsSync(scanDir)) {
  console.error(
    `找不到扫描目录：${scanDir}\n\n` +
      `  --scan 相对当前工作目录解析；--root 是**资料**根目录（引用里\n` +
      `  library/... 的基准），两者是分开的 —— 条目和它引用的资料\n` +
      `  可以在不同仓库里。\n\n` +
      `  当前：--root = ${ROOT}\n` +
      `        --scan = ${scanDir}\n`
  );
  process.exit(2);
}

const files = fileArgs.length
  ? fileArgs
      .map((a) => path.resolve(a))
      .filter((f) => {
        if (statSync(f).isDirectory()) {
          console.error(`✗ ${f} 是目录，不是文件。要扫整个目录请用 --scan。`);
          return false;
        }
        return true;
      })
  : walk(scanDir);

let total = 0;
let bad = 0;
const failures = [];

for (const file of files) {
  if (!existsSync(file)) {
    failures.push({ file, ref: null, why: `文件不存在：${file}` });
    bad++;
    continue;
  }

  const refs = collectRefs(readFileSync(file, 'utf8'));
  if (!refs.length) continue;

  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  console.log(`\n${bold(rel)}  ${dim(`${refs.length} 条引用`)}`);

  for (const ref of refs) {
    total++;
    const r = checkOne(ref);
    const shown =
      ref.kind === '原件:页' ? `${ref.path} 第${ref.page}页` : `${ref.path}:${ref.line}`;

    if (r.ok) {
      console.log(`  ${green('✓')} ${shown}  ${dim(ref.kind)}`);
    } else {
      bad++;
      console.log(`  ${red('✗')} ${shown}  ${dim(ref.kind)}`);
      console.log(`      ${r.why}`);
      if (r.hint) console.log(`      ${dim(r.hint)}`);
      failures.push({ file: rel, ref: shown, why: r.why });
    }
  }
}

console.log('');
if (total === 0) {
  console.log(`${dim('没有找到任何引用。')} ${dim('（条目还是空的，这是真实状态，不是错误。）')}`);
  process.exit(0);
}

if (bad === 0) {
  console.log(`${green('✓')} ${total} 条引用全部通过。`);
  console.log(dim('  注意：这只证明引文在 md 里找得到；md 与 PDF 原件的一致性还需要人工抽查。'));
  process.exit(0);
}

console.log(`${red('✗')} ${bad} / ${total} 条引用有问题：\n`);
for (const f of failures) {
  console.log(`  ${f.file}${f.ref ? ` → ${f.ref}` : ''}`);
  console.log(`    ${f.why}`);
}
console.log(
  `\n${yellow('可疑引用不要当它成立。')} 核对条目里记的「保真度」一栏，`
);
console.log(`再决定是修引用，还是把这条资料降级为「仅页码」。\n`);
process.exit(1);
