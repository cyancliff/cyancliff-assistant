/**
 * feishu-card.mjs — 飞书卡片 JSON 2.0 的构造
 *
 * **纯函数，不 import 任何东西。** 这样不装 SDK 也能写、能测 ——
 * 依赖只在传输层（feishu-bot.mjs）用到。
 *
 * ── 为什么必须是 2.0 ────────────────────────────────────────────
 * 飞书官方 FAQ 点名：**按钮不触发最常见的原因就是用 1.0 的卡片结构**。
 * 1.0 的 `"tag": "action"` 交互模块在 2.0 里已不支持。
 * 2.0 的按钮放在 `column_set → column → button` 里。
 *
 * 还有一个坑：**2.0 的卡片不能更新成 1.0**（飞书错误码 200830）。
 * 所以回调里返回的卡片也必须是 2.0，不然点一下按钮就报错。
 *
 * ── 按钮的回传值放在哪里（已实测，不用再猜）────────────────────
 * **只放 `behaviors[].value`。**
 *
 * 曾经两处都放，因为两处官方文档说法不一致：
 *   - channel.md 说 `behaviors: [{ type: 'callback', value }]`
 *   - Button 组件文档说回调里的 `action.value` 对应组件的 `value` 属性
 *
 * 2026-09-17 用一张三个按钮的卡片实测过（三个按钮的值互不相同）：
 *
 *   A 两处都放、值不同  → 回调收到的是 behaviors 里那个   ← 冲突时 behaviors 赢
 *   B 只放 behaviors    → 收到，可用
 *   C 只放同级 value     → 也收到，也可用
 *
 * 结论：两种写法都能用，冲突时 behaviors 优先。所以只留 behaviors ——
 * **"两处都放"是当时的临时状态，不是长期设计**；留着会让下一个人
 * 以为有两条路要维护。
 *
 * 第一版打样还有个设计缺陷值得记：当时两处放的是**同一个对象**，
 * 于是无论飞书读哪一处，回调里看起来都一样 —— 打样"通过"了，
 * 但那个问题根本没被回答。**自己给自己造的假检查。**
 */

export const SCHEMA = '2.0';

/** 按钮回传值里的动作名。回调处理按它分派。 */
export const ACTION = {
  CONFIRM: 'confirm',   // 确认并发送
  PREVIEW: 'preview',   // 看全文
  DISCARD: 'discard',   // 作废
  PING: 'ping',         // 打样
};

// ── 基础构件 ──────────────────────────────────────────────────
export function v2Card({ title, template = 'blue', elements = [] }) {
  const card = { schema: SCHEMA, body: { elements } };
  if (title) {
    card.header = { template, title: { tag: 'plain_text', content: title } };
  }
  return card;
}

export function markdown(content) {
  return { tag: 'markdown', content };
}

export function divider() {
  return { tag: 'hr' };
}

/**
 * 一个按钮。
 *
 * `value` 会被原样回传，所以**里面只放标识符，不要放正文** ——
 * 卡片内容在飞书客户端与服务端之间往返，回调体也会进日志。
 */
export function button({ text, value, type = 'default' }) {
  return {
    tag: 'button',
    type,
    text: { tag: 'plain_text', content: text },
    behaviors: [{ type: 'callback', value }],
  };
}

/** 把若干按钮横排。飞书 2.0 里按钮不能直接放在 body.elements 下。 */
export function buttonRow(buttons) {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    columns: buttons.map((b) => ({
      tag: 'column',
      width: 'auto',
      weight: 1,
      elements: [b],
    })),
  };
}

// ── 业务卡片 ──────────────────────────────────────────────────

/** 命令列表。`rows` 是 [命令, 说明] 的数组。 */
export function helpCard(rows) {
  const lines = rows.map(([cmd, desc]) => `**\`${cmd}\`** — ${desc}`);
  return v2Card({
    title: '可用命令',
    template: 'blue',
    elements: [
      markdown(lines.join('\n')),
      divider(),
      markdown(
        [
          '**发送邮件不在这里。** 它只能点卡片上的按钮 ——',
          '命令是打字的，打字会打错；按钮上写着收件人和正文，点下去才是明确的确认。',
        ].join('\n')
      ),
    ],
  });
}

/**
 * 待办摘要（对应 `/取信`）。
 *
 * `items` 每条是 `{ subject, from, kind }`，`kind` 取 signal / plain / noise。
 * 只列需要动作的，其余只报数量 —— 摘要的意义是"把 200 封压成看得完的十几条"。
 */
export function digestCard({ scanned, counts, items, limit = 12 }) {
  const shown = items.slice(0, limit);
  const lines = shown.map((it, i) => {
    const tag = it.kind === 'signal' ? '🔴' : it.kind === 'plain' ? '⚪' : '⚫';
    return `${i + 1}. ${tag} **${escapeInline(it.subject)}**\n　　${escapeInline(it.from)}`;
  });

  const more = items.length > shown.length ? `\n\n_还有 ${items.length - shown.length} 条没列出来_` : '';

  return v2Card({
    title: `未读摘要 · 扫了 ${scanned} 封`,
    template: counts.signal > 0 ? 'orange' : 'blue',
    elements: [
      markdown(`🔴 需动作 **${counts.signal}**　⚪ 普通 **${counts.plain}**　⚫ 噪声 **${counts.noise}**`),
      divider(),
      markdown(lines.length ? lines.join('\n') + more : '_没有需要动作的。_'),
    ],
  });
}

/**
 * 邮件确认卡片 —— 唯一一张会出现"确认发送"按钮的卡片。
 *
 * 正文**不放进按钮的 value**，只放草稿 id。按钮的价值在于它写着
 * 收件人与主题：你点的时候看得见自己要发什么。
 */
export function draftConfirmCard({ id, to, subject, preview, chars }) {
  return v2Card({
    title: '待确认：要发这封吗',
    template: 'orange',
    elements: [
      markdown(
        [
          `**收件人**　${escapeInline(to)}`,
          `**主题**　${escapeInline(subject)}`,
          `**长度**　${chars} 字符`,
        ].join('\n')
      ),
      divider(),
      markdown(escapeInline(preview)),
      divider(),
      buttonRow([
        button({ text: '确认发送', value: { action: ACTION.CONFIRM, id }, type: 'primary' }),
        button({ text: '看全文', value: { action: ACTION.PREVIEW, id } }),
        button({ text: '作废', value: { action: ACTION.DISCARD, id }, type: 'danger' }),
      ]),
      markdown('_点「确认发送」之前请先「看全文」—— 这两步是分开的，不是多此一举。_'),
    ],
  });
}

/** 看全文的卡片。 */
export function draftFullCard({ id, to, subject, body }) {
  return v2Card({
    title: `全文 · ${subject}`.slice(0, 60),
    template: 'blue',
    elements: [
      markdown(`**收件人**　${escapeInline(to)}`),
      divider(),
      markdown(escapeInline(body)),
      divider(),
      buttonRow([
        button({ text: '确认发送', value: { action: ACTION.CONFIRM, id }, type: 'primary' }),
        button({ text: '作废', value: { action: ACTION.DISCARD, id }, type: 'danger' }),
      ]),
    ],
  });
}

/** 结果卡片：成功/失败/拒绝，都用它。 */
export function resultCard({ title, template = 'blue', lines }) {
  return v2Card({ title, template, elements: [markdown(lines.join('\n'))] });
}

/**
 * 打样用的卡片。
 *
 * 放在这里而不是留在 feishu-probe.mjs 里：卡片 JSON 的知识只该有一份。
 * 打样脚本 import 它，正式 bot 也 import 它。
 */
export function probeCard(nonce) {
  const value = { action: ACTION.PING, nonce };
  return v2Card({
    title: '打样：按钮能不能走长连接',
    template: 'blue',
    elements: [
      markdown(
        [
          '**点一下下面这个按钮。**',
          '',
          '要验证的是：卡片按钮的点击能不能通过**长连接**收到。',
          'SDK 的 README 说不能，它的 channel.md 和飞书平台文档说能。',
          '',
          `nonce: \`${nonce}\``,
        ].join('\n')
      ),
      buttonRow([button({ text: '点我', value, type: 'primary' })]),
    ],
  });
}

/**
 * 卡片里 markdown 的转义。
 *
 * 邮件主题与发件人是**外部输入**，里面可能有 `**`、`[]()`、`` ` ``
 * 这类 markdown 记号。不转义的话，一封主题叫 `**重要**` 的邮件能把卡片排版搅乱，
 * 更坏的情况是伪造出一个看起来像系统提示的粗体块。
 */
export function escapeInline(s) {
  return String(s == null ? '' : s)
    .replace(/[`*_~[\]]/g, (ch) => `\\${ch}`)
    .replace(/\r?\n/g, ' ');
}

/** 卡片正文按字数截断，截断处明说还剩多少（不悄悄截）。 */
export function truncate(s, max) {
  const t = String(s == null ? '' : s);
  if (t.length <= max) return { text: t, truncated: false };
  return { text: `${t.slice(0, max)}\n\n_…还有 ${t.length - max} 字，点「看全文」看完整的_`, truncated: true };
}
