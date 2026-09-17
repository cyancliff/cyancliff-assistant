#!/usr/bin/env node
/**
 * find-quote.mjs — 在资料里找一段文字在哪
 *
 * cite-check 解决的是"我知道在哪，帮我验"；这个解决"帮我在哪"。
 * 两者合起来才是能用的个人数据库：**回答问题时能给出可核对的行号**。
 *
 *   node scripts/find-quote.mjs "某个术语"
 *   node scripts/find-quote.mjs "某段引文" --root <资料根> --limit 5
 *   node scripts/find-quote.mjs "关键词" --context 2
 *
 * 匹配规则（和 cite-check 保持一致，这样找到的位置粘过去就能通过核验）：
 *
 *   - 忽略大小写
 *   - 空白归一：普通空格、不换行空格、全角空格视为同一个
 *   - 引号归一：中文全角引号 “” 和半角 "" 视为同一个（资料里两种都有）
 *   - 整段可能跨行，所以匹配在"压掉空白"的串上做，再映射回行号
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

const ROOT = path.resolve(flagValue('--root', path.join(HERE, '..')));
const LIMIT = Number(flagValue('--limit', 20)) || 20;
const CONTEXT = Number(flagValue('--context', 1)) || 0;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = c(31);
const green = c(32);
const yellow = c(33);
const cyan = c(36);
const dim = c(2);
const bold = c(1);

const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian']);

function walk(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

/**
 * 归一化：空白、大小写、引号。
 *
 * 引号单独处理是有原因的：论文的 docx 和 PDF 抽出来的是 “”（全角），
 * 手打的多半是 ""（半角）。不归一的话，明明在文件里的句子会搜不到 ——
 * 那是最容易让人放弃用工具的一类假失败。
 */
function norm(s) {
  return s
    .replace(/[\s\u00a0\u2000-\u200b\u3000]+/g, '')
    .replace(/[\u201c\u201d\u2018\u2019]/g, '"')
    .toLowerCase()
    .normalize('NFC');
}

/** 压掉空白，保留每个字符回到原行的映射。 */
function haystack(text) {
  const chars = [];
  const lineOf = [];
  text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .forEach((line, i) => {
      for (const ch of line) {
        if (/[\s\u00a0\u2000-\u200b\u3000]/.test(ch)) continue;
        chars.push(ch);
        lineOf.push(i + 1);
      }
    });
  return { s: norm(chars.join('')), lineOf };
}

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h') || !args.filter((a) => !a.startsWith('--'))[0]) {
  console.log(`${bold('find-quote.mjs')} — 在资料里找一段文字在哪

  node scripts/find-quote.mjs <要找的文字> [--root <资料根>] [--limit N] [--context N]

  --root     资料根目录（引用里 library/... 的基准）。默认脚本所在仓的上一级。
  --limit    最多显示几条结果（默认 20）
  --context  每条结果多显示前后几行（默认 0）

  ${dim('匹配忽略大小写与空白差异，全角/半角引号视为同一个。')}
  ${dim('输出的 文件:行号 可以直接粘进引用里，能被 cite-check 核验。')}
`);
  process.exit(0);
}

const VALUE_FLAGS = new Set(['--root', '--limit', '--context']);
const query = args.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]));

if (!query) {
  console.error('没给要找的文字。用 --help 看用法。');
  process.exit(2);
}

const files = walk(ROOT);
if (!files.length) {
  console.error(`资料根目录里没有 .md 文件：${ROOT}`);
  process.exit(2);
}

const needle = norm(query);
const hits = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const { s, lineOf } = haystack(text);
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);

  let from = 0;
  while (from <= s.length - needle.length) {
    const at = s.indexOf(needle, from);
    if (at === -1) break;

    const startLine = lineOf[at];
    const endLine = lineOf[Math.min(at + needle.length - 1, lineOf.length - 1)];
    hits.push({
      file: path.relative(ROOT, file).split(path.sep).join('/'),
      startLine,
      endLine,
      lines,
    });
    from = at + needle.length; // 不重叠，避免同一处重复报
  }
}

// 结构化输出：给别的程序用（飞书 bot 的 `/找` 就是调它）。
// 加这个而不是让调用方去 parse 上面那堆带颜色的文本 ——
// 解析给人看的输出，颜色一改就坏，而且坏得静默。
if (args.includes('--json')) {
  console.log(
    JSON.stringify(
      {
        query,
        root: ROOT,
        filesScanned: files.length,
        total: hits.length,
        hits: hits.slice(0, LIMIT).map((h) => ({
          file: h.file,
          line: h.startLine,
          endLine: h.endLine,
          text: h.lines.slice(h.startLine - 1, h.endLine).join('\n'),
        })),
      },
      null,
      2
    )
  );
  process.exit(0);
}

console.log('');
if (!hits.length) {
  console.log(`${yellow('没找到')} ${JSON.stringify(query)}`);
  console.log(dim(`  在 ${files.length} 个文件里搜过（根目录 ${ROOT}）`));
  console.log(dim('  换个说法，或者确认资料真的进来了。就这么简单 —— 不要凭印象回答。'));
  process.exit(1);
}

console.log(`${green('找到')} ${hits.length} 处 ${dim(`（${files.length} 个文件里搜过）`)}\n`);

for (const h of hits.slice(0, LIMIT)) {
  const where = h.startLine === h.endLine ? `${h.startLine}` : `${h.startLine}-${h.endLine}`;
  console.log(`${cyan(`${h.file}:${where}`)}`);

  const lo = Math.max(1, h.startLine - CONTEXT);
  const hi = Math.min(h.lines.length, h.endLine + CONTEXT);
  for (let n = lo; n <= hi; n++) {
    const isHit = n >= h.startLine && n <= h.endLine;
    const body = h.lines[n - 1] ?? '';
    const shown = body.length > 160 ? body.slice(0, 160) + '…' : body;
    console.log(`  ${isHit ? green('▸') : ' '} ${String(n).padStart(5)} ${isHit ? shown : dim(shown)}`);
  }
  console.log('');
}

if (hits.length > LIMIT) {
  console.log(dim(`（还有 ${hits.length - LIMIT} 处，用 --limit 调整）\n`));
}

console.log(dim('把上面的 文件:行号 粘进引用即可，它能被 cite-check 核验。'));
if (hits.length >= LIMIT) {
  console.log(dim('结果很多时换个更具体的说法 —— 命中最多的那个位置才可能是你要的。'));
}
