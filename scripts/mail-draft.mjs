#!/usr/bin/env node
/**
 * mail-draft.mjs — 为一封已取回的邮件拟回复草稿
 *
 *   node scripts/mail-draft.mjs <message-id>
 *   node scripts/mail-draft.mjs <message-id> --template    不用模型，模板拼装
 *   node scripts/mail-draft.mjs --list                     看有哪些可取回的邮件
 *   node scripts/mail-draft.mjs <message-id> --show        打印草稿
 *
 * **草稿不会发送。** 这个脚本只写文件，发送是 mail-send.mjs 的事，
 * 而且必须在确认之后。
 *
 * ## 上下文从哪来
 *
 *   1. 原邮件本身（data/mail/<id>.md）
 *   2. 同一发件人的历史邮件（data/mail/ 里按 from 匹配）
 *   3. memory/preferences.md 里的语气偏好
 *   4. memory/rules.md 里被纠正过的规则 —— 这些是"上次做错过什么"，
 *      比偏好更重要，因为它们是具体场景
 *
 * ## 密钥
 *
 * 按顺序找：ASSISTANT_MODEL_API_KEY → CMDGOAT_API_KEY（环境变量或 .env）。
 * 都没有时**不静默降级**：要么用 --template，要么报错说清该设哪个变量。
 * 悄悄用模板代替模型会让人以为草稿是模型写的。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEnv, DATA_ROOT, ENV_PATH } from './gmail-auth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = c(31);
const green = c(32);
const yellow = c(33);
const dim = c(2);
const bold = c(1);

const MAIL_DIR = path.join(DATA_ROOT, 'data', 'mail');
const DRAFT_DIR = path.join(MAIL_DIR, 'drafts');
const MEMORY_DIR = path.join(DATA_ROOT, 'memory');

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set([]);
const flagValue = (n) => {
  const i = args.indexOf(n);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]));

const useTemplate = args.includes('--template');
const showOnly = args.includes('--show');
const listOnly = args.includes('--list');

// ── 解析已落盘的邮件 ─────────────────────────────────────────
/**
 * data/mail/<id>.md 的 frontmatter 是 mail-fetch.mjs 写的。
 * 这里只解析它需要的那几个字段 —— 不去引 YAML 库，
 * 因为值的形状是我们自己定的（都是 JSON 字符串）。
 */
export function parseMailFile(id) {
  const f = path.join(MAIL_DIR, `${id}.md`);
  if (!existsSync(f)) return null;
  const text = readFileSync(f, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { id, meta: {}, body: text, path: f };

  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    }
    meta[kv[1]] = v;
  }

  // 正文从 `# 主题` 之后、第一个 `---` 之后的段落取
  const afterFm = text.slice(m[0].length);
  const bodyMatch = afterFm.match(/^[\s\S]*?\r?\n---\r?\n\r?\n([\s\S]*?)(?:\r?\n<details>|$)/);
  return { id, meta, body: (bodyMatch ? bodyMatch[1] : afterFm).trim(), path: f };
}

/**
 * mail-fetch.mjs --seed 写进来的合成邮件用 __seed 前缀。
 *
 * 为什么要放行它们：没有真实邮箱时，下游（拟稿、确认、发送）只能靠它们
 * 端到端验证。挡掉的话整条管道就只能在接通之后才能测。
 *
 * 但**必须能一眼看出来是合成的** —— 否则会把测试邮件当成真实来信处理。
 */
export const isSeed = (id) => id.startsWith('__seed');

function listMails() {
  if (!existsSync(MAIL_DIR)) return [];
  return readdirSync(MAIL_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    // 只挡真正的临时产物。__seed-* 放行，见上面注释。
    .filter((id) => !id.startsWith('__') || isSeed(id));
}

/** 同一发件人的历史邮件（不含当前这封），最多取 5 封。 */
export function historyFrom(senderEmail, excludeId, limit = 5) {
  if (!senderEmail) return [];
  const out = [];
  for (const id of listMails()) {
    if (id === excludeId) continue;
    const p = parseMailFile(id);
    if (!p) continue;
    const from = String(p.meta.from || '');
    if (!from.toLowerCase().includes(senderEmail.toLowerCase())) continue;
    out.push({ id, subject: p.meta.subject || '', date: p.meta.date || '' });
  }
  return out.slice(0, limit);
}

/** 从 "名字 <a@b.com>" 里抠出邮箱；没有尖括号就整串当邮箱。 */
export function extractEmail(addr) {
  const m = String(addr || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(addr || '')).trim();
}

/** 名字部分，用于称呼。取不到就用邮箱前缀。 */
export function extractName(addr) {
  const s = String(addr || '');
  const m = s.match(/^"?([^"<]+?)"?\s*</);
  if (m && m[1].trim()) return m[1].trim();
  const email = extractEmail(s);
  return email.split('@')[0] || '';
}

// ── 记忆 ──────────────────────────────────────────────────────
/**
 * 读记忆文件里的**真实**条目。
 *
 * 有意跳过示例行：memory/preferences.md 和 rules.md 里各有一条标着
 * "（示例，不是真实偏好/规则）"的表格行，用来说明格式。
 * 把示例当成真实偏好会让助手照着一条它编出来的偏好行事 ——
 * 那比"没有偏好"更糟。
 *
 * 返回 '' 表示"没有真实内容"。要区分"文件不存在"和"只有示例"，
 * 调用方另看 existsSync。
 */
function readMemory(file) {
  const f = path.join(MEMORY_DIR, file);
  if (!existsSync(f)) return '';
  return readFileSync(f, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('|') && !l.includes('（示例'))
    .filter((l) => !/^\|\s*(偏好|场景)\s*\|/.test(l) && !/^\|[\s\-:|]+\|$/.test(l))
    .join('\n')
    .trim();
}

// ── 组装提示 ──────────────────────────────────────────────────
export function buildPrompt({ mail, history, preferences, rules }) {
  const senderName = extractName(mail.meta.from) || '对方';
  const parts = [
    '你要替用户起草一封中文回复邮件的正文。',
    '',
    '要求：',
    '- 只输出邮件正文，不要主题行、不要"以下是草稿"这类说明',
    '- 语气自然、简洁，不要客套堆砌',
    '- 不确定的地方不要编造事实，宁可写得笼统一些',
    '- 长度与来信相称：短信短回，长信说清',
  ];

  if (preferences) {
    parts.push('', '用户的长期偏好（必须遵守）：', preferences);
  }
  if (rules) {
    parts.push('', '用户纠正过的规则（这些是具体场景，优先级最高）：', rules);
  }

  parts.push('', '--- 来信 ---', `发件人：${mail.meta.from || '(未知)'}`, `主题：${mail.meta.subject || '(无主题)'}`, `日期：${mail.meta.date || '(未知)'}`, '', mail.body.slice(0, 6000));

  if (history.length) {
    parts.push('', '--- 同一发件人的近期往来（供参考，不要在回信里提及）---');
    for (const h of history) parts.push(`- ${h.date} 《${h.subject}》`);
  }

  parts.push('', `--- 现在写回给 ${senderName} 的正文 ---`);
  return parts.join('\n');
}

// ── 模板回退 ──────────────────────────────────────────────────
/**
 * 没有密钥时的回退。**它产出的不是"像样的回复"**，只是一个起点 ——
 * 目的是让整条管道（组装上下文 → 落盘 → 确认 → 发送）能在没有模型的情况下
 * 端到端跑通并测试。
 *
 * 不要把 template: true 的草稿当成可以发的成品直接送出去。
 */
export function templateDraft({ mail }) {
  const name = extractName(mail.meta.from);
  const greet = name ? `${name}，你好：` : '你好：';
  const firstLine =
    mail.body.split(/\r?\n/).find((l) => l.trim().length > 10 && !l.startsWith('>')) || '';
  const echo = firstLine ? `关于你提到的「${firstLine.trim().slice(0, 40)}…」，` : '';

  // 空行要留着 —— 上面第一版用 filter 把空串删了，结果整段挤成一块，
  // 读起来不像一封邮件。模板草稿本来就弱，排版再塌就更没用了。
  return [
    greet,
    '',
    '（模板草稿 —— 没有配置模型，这段是占位，需要你改写。）',
    '',
    echo,
    '我这边确认一下再回复你。',
    '',
    '谢谢',
  ].join('\n');
}

// ── 调模型 ────────────────────────────────────────────────────
export function findApiKey() {
  // 顺序有意：环境变量优先于 .env，这样"外部注入"能覆盖文件里的值
  return getEnv('ASSISTANT_MODEL_API_KEY') || getEnv('CMDGOAT_API_KEY') || '';
}

export async function callModel(prompt, { apiKey, baseUrl, model, timeoutMs = 120000 }) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
      }),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(`模型调用超过 ${timeoutMs / 1000} 秒没有响应`);
    throw new Error(`连不上模型服务：${err.message}`);
  }
  clearTimeout(timer);

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留原文报错 */
  }

  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 300);
    // 401/403 单独说明：这不是重试能解决的
    const hint =
      res.status === 401 || res.status === 403
        ? '\n  密钥无效或没有权限 —— 重试没用，要换密钥。'
        : '';
    throw new Error(`模型返回 HTTP ${res.status}：${msg}${hint}`);
  }

  const content = json?.choices?.[0]?.message?.content;
  if (!content || !content.trim()) {
    throw new Error(`模型返回了空内容。原始响应：${text.slice(0, 300)}`);
  }
  return content.trim();
}

// ── 落盘 ──────────────────────────────────────────────────────
export function draftPath(id) {
  return path.join(DRAFT_DIR, `${id}.md`);
}

export function renderDraft({ mail, draftBody, usedModel, model, history, preferences, rules }) {
  /** 把读到的记忆渲染成引用块；空的话说明"没有"，而不是留一片空白。 */
  const memory = (text) =>
    text
      ? text
          .split(/\r?\n/)
          .map((l) => `  > ${l}`)
          .join('\n')
      : '  （无）';

  const lines = [
    '---',
    `in_reply_to: ${mail.id}`,
    `to: ${JSON.stringify(mail.meta.from || '')}`,
    `subject: ${JSON.stringify(
      /^re:/i.test(mail.meta.subject || '') ? mail.meta.subject : `Re: ${mail.meta.subject || ''}`
    )}`,
    `created_at: ${new Date().toISOString()}`,
    `generated_by: ${usedModel ? `model:${model}` : 'template'}`,
    `confirmed: false`,
    '---',
    '',
    '<!-- confirmed: false 是确认闸门的状态。mail-send.mjs 只发送',
    '     confirmed: true 的草稿。改这里等于绕开闸门 —— 不要手改。 -->',
    '',
    '## 草稿正文',
    '',
    draftBody,
    '',
    '## 拟稿依据',
    '',
    `- 模型：${usedModel ? model : '**未使用模型（模板草稿）**'}`,
    `- 同一发件人历史：${history.length ? `${history.length} 封` : '无'}`,
    ...history.map((h) => `  - ${h.date} 《${h.subject}》`),
    '',
    '### 读到的长期偏好',
    '',
    memory(preferences),
    '',
    '### 读到的纠正规则',
    '',
    memory(rules),
    '',
    '## 原邮件',
    '',
    `> ${String(mail.meta.from || '')}`,
    `> ${String(mail.meta.subject || '')}`,
    '',
    ...mail.body.split(/\r?\n/).map((l) => `> ${l}`),
    '',
  ];
  return lines.join('\n');
}

// ── 主流程 ────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain && (args.includes('--help') || args.includes('-h'))) {
  console.log(`${bold('mail-draft.mjs')} — 为一封已取回的邮件拟回复草稿

  node scripts/mail-draft.mjs --list                 有哪些邮件
  node scripts/mail-draft.mjs <id>                   调模型拟稿
  node scripts/mail-draft.mjs <id> --template        不用模型，模板拼装
  node scripts/mail-draft.mjs <id> --show            打印已有草稿

  ${dim('草稿写到 data/mail/drafts/<id>.md，带 confirmed: false。')}
  ${dim('发送由 mail-send.mjs 负责，且只发 confirmed: true 的。')}
`);
  process.exit(0);
}

if (isMain && listOnly) {
  const ids = listMails();
  console.log(`\n${bold('已取回的邮件')}  ${dim(`${MAIL_DIR}`)}\n`);
  if (!ids.length) {
    console.log(dim('  一封都没有。先跑：node scripts/mail-fetch.mjs\n'));
    process.exit(0);
  }
  for (const id of ids) {
    const p = parseMailFile(id);
    const hasDraft = existsSync(draftPath(id));
    const tag = isSeed(id) ? `  ${yellow('[合成]')}` : '';
    console.log(
      `  ${id}  ${(p.meta.subject || '(无主题)').slice(0, 48)}` +
        `${hasDraft ? `  ${green('有草稿')}` : ''}${tag}`
    );
    console.log(`    ${dim(String(p.meta.from || '').slice(0, 70))}`);
  }
  const seeds = ids.filter(isSeed).length;
  if (seeds) {
    console.log('');
    console.log(dim(`  其中 ${seeds} 封是 mail-fetch.mjs --seed 写的合成邮件，不是真实来信。`));
    console.log(dim('  清理：删掉 data/mail/__seed-*.md，并从 seen.json 去掉对应键。'));
  }
  console.log('');
  process.exit(0);
}

if (isMain) {
  const id = positional[0];
  if (!id) {
    console.error(`${red('✗')} 没给邮件 id。用 --list 看有哪些，或 --help 看用法。`);
    process.exit(2);
  }

  if (showOnly) {
    const f = draftPath(id);
    if (!existsSync(f)) {
      console.error(`${red('✗')} 还没有这封的草稿：${f}`);
      process.exit(2);
    }
    console.log(readFileSync(f, 'utf8'));
    process.exit(0);
  }

  const mail = parseMailFile(id);
  if (!mail) {
    console.error(`${red('✗')} 找不到邮件 ${id}（期望 ${path.join(MAIL_DIR, `${id}.md`)}）`);
    console.error(dim('  用 --list 看有哪些。'));
    process.exit(2);
  }

  const senderEmail = extractEmail(mail.meta.from);
  const history = historyFrom(senderEmail, id);
  const preferences = readMemory('preferences.md');
  const rules = readMemory('rules.md');

  const apiKey = findApiKey();
  const baseUrl = getEnv('ASSISTANT_MODEL_BASE_URL') || 'https://api.commandcode.ai/provider/v1';
  const model = getEnv('ASSISTANT_MODEL_NAME') || 'deepseek/deepseek-v4.1-flash';

  let draftBody;
  let usedModel = false;

  if (useTemplate) {
    draftBody = templateDraft({ mail });
  } else if (!apiKey) {
    console.error(`${red('✗')} 没有可用的模型密钥。\n`);
    console.error('  按顺序找这两个变量（环境变量或 .env）：');
    console.error(dim('    ASSISTANT_MODEL_API_KEY'));
    console.error(dim('    CMDGOAT_API_KEY'));
    console.error(`\n  .env 位置：${ENV_PATH}${existsSync(ENV_PATH) ? '' : dim('  （不存在）')}`);
    console.error(`\n  想跳过模型、只用模板拼一份占位草稿：`);
    console.error(dim(`    node scripts/mail-draft.mjs ${id} --template\n`));
    console.error(dim('  （不会静默降级 —— 用模板代替模型而不说，会让人以为草稿是模型写的。）'));
    process.exit(2);
  } else {
    console.log(`\n${bold('拟稿')}  ${dim(`${model}`)}\n`);
    const prompt = buildPrompt({ mail, history, preferences, rules });
    console.log(`  上下文：原邮件 ${mail.body.length} 字符，历史 ${history.length} 封，` +
      `偏好 ${preferences ? '有' : '无'}，规则 ${rules ? '有' : '无'}`);
    try {
      draftBody = await callModel(prompt, { apiKey, baseUrl, model });
      usedModel = true;
    } catch (err) {
      console.error(`\n${red('✗')} 拟稿失败：${err.message}`);
      console.error(dim(`\n  想先用模板顶上：node scripts/mail-draft.mjs ${id} --template`));
      process.exit(1);
    }
  }

  if (!draftBody || !draftBody.trim()) {
    console.error(`${red('✗')} 草稿是空的，不写文件。`);
    process.exit(1);
  }

  mkdirSync(DRAFT_DIR, { recursive: true });
  const out = draftPath(id);
  writeFileSync(
    out,
    renderDraft({ mail, draftBody, usedModel, model, history, preferences, rules }),
    'utf8'
  );

  console.log(`\n${green('✓')} 草稿已写：${out}`);
  console.log(`  ${dim('confirmed: false —— 还没确认，发不出去。')}`);
  console.log(`  ${dim(`看内容：node scripts/mail-draft.mjs ${id} --show`)}\n`);
  if (!usedModel) {
    console.log(`${yellow('注意')} 这是**模板草稿**，不是模型写的。`);
    console.log(dim('  它的用途是让管道能端到端跑通，不要直接发出去。\n'));
  }
}
