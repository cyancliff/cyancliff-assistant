/**
 * feishu-commands.mjs — `/` 命令的解析
 *
 * **纯函数，不 import 任何东西。**
 *
 * ── 为什么是 `/` 前缀 ─────────────────────────────────────────
 * 用户在对话里说的话什么样的都有。带 `/` 的才当命令，
 * 其余一律**不猜**（不把"帮我看看邮件"当成 `/取信`）——
 * 猜错的代价是它替你做了你没让它做的事。
 *
 * ── 为什么没有"发送"命令 ──────────────────────────────────────
 * 永远不会有。发送只能点卡片按钮。
 * 命令是打字的、打字会打错；按钮上写着收件人与正文，点下去才是明确的确认。
 * 一旦有 `/发送 <id>`，"确认"就退化成"记得别打错字"。
 */

/** 命令表。顺序就是帮助里的顺序。 */
export const COMMANDS = [
  {
    name: '帮助',
    aliases: ['help', 'h', '?'],
    desc: '看这个',
    args: [],
  },
  {
    name: '取信',
    aliases: ['mail', 'inbox'],
    desc: '拉未读，按"要不要你动手"分类摘要',
    args: [],
  },
  {
    name: '稿',
    aliases: ['draft'],
    desc: '给某封邮件拟草稿，推一张确认卡片',
    args: ['<草稿 id>'],
  },
  {
    name: '找',
    aliases: ['find', 'search'],
    desc: '在资料库里找一段文字，回「文件:行号」',
    args: ['<关键词>'],
  },
  {
    name: '状态',
    aliases: ['status'],
    desc: '看凭据与运行状态',
    args: [],
  },
  {
    name: '停',
    aliases: ['stop'],
    desc: '停掉 bot（再发消息不会回应，重启即恢复）',
    args: [],
  },
];

/** 帮助卡片的行：[命令, 说明]。 */
export function helpRows() {
  return COMMANDS.map((c) => [`/${c.name}`, c.desc]);
}

/** 命令的规范用法串，用于"参数没给全"时的提示。 */
export function usageOf(cmd) {
  return `/${cmd.name}${cmd.args.length ? ' ' + cmd.args.join(' ') : ''}`;
}

function findCommand(word) {
  const w = String(word || '').toLowerCase();
  return COMMANDS.find((c) => c.name === word || c.aliases.some((a) => a.toLowerCase() === w)) || null;
}

/**
 * 解析一条消息。
 *
 * 返回：
 *   { kind: 'command', command, args, raw }   识别成功
 *   { kind: 'help',    reason }               要回帮助（未知命令、参数不全、空命令）
 *   { kind: 'none'    }                       不是命令 —— 正常对话，不回应
 *
 * `kind: 'none'` 与 `kind: 'help'` 分开是有意的：前者**什么都不该回**。
 * 每条闲聊都回一句"我不懂"会变成骚扰。
 */
export function parseCommand(text) {
  const raw = String(text == null ? '' : text).trim();

  if (!raw.startsWith('/')) return { kind: 'none' };

  // `/ 取信` 也认 —— 中文输入法下多打一个空格很常见
  const body = raw.slice(1).trim();

  if (!body) {
    return { kind: 'help', reason: '只打了个斜杠，没说做什么。' };
  }

  // 命令词与参数之间按空白切；参数里的空白保留（`/找 区分度 均值`）
  const m = body.match(/^(\S+)\s*(.*)$/);
  const word = m[1];
  const rest = m[2].trim();

  const cmd = findCommand(word);
  if (!cmd) {
    return { kind: 'help', reason: `没有 \`/${word}\` 这个命令。` };
  }

  const args = rest ? rest.split(/\s+/) : [];

  if (cmd.args.length && args.length === 0) {
    return { kind: 'help', reason: `\`/${cmd.name}\` 要带参数。用法：\`${usageOf(cmd)}\`` };
  }

  if (!cmd.args.length && args.length) {
    return {
      kind: 'help',
      reason: `\`/${cmd.name}\` 不带参数，但收到了 \`${args.join(' ')}\`。\n用法：\`${usageOf(cmd)}\``,
    };
  }

  return { kind: 'command', command: cmd, args, raw };
}
