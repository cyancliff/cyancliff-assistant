/**
 * feishu-policy.mjs — 谁的话算数
 *
 * **纯函数，不 import 任何东西。**
 *
 * ── 为什么单独成一个模块 ────────────────────────────────────────
 * 能收按钮回调的 bot，离"能让它替你发邮件"只差一步。
 * 所以"谁的话算数"不能散落在各个处理函数里 —— 那样加一条新命令时
 * 很容易忘了先判权限，而忘了的表现是**一切正常，只是谁都能用**。
 * 集中在一个纯函数里，就能把它单独测穷。
 *
 * ── 默认不信任 ─────────────────────────────────────────────────
 * `FEISHU_OWNER_OPEN_ID` 没配之前**拒绝执行任何操作**。
 * 不做"首次私聊自动认领" —— 那是默认信任：谁先发消息谁就是主人。
 *
 * 唯一的例外是"认领提示"：bot 会回一条消息告诉对方他的 open_id 是多少。
 * 没有这个例外，用户根本无从知道自己的 open_id，会卡死在第一步。
 * **这个例外只"说"，不做任何事、不改任何状态。**
 */

export const DECISION = {
  /** 就是主人，放行 */
  ALLOW: 'allow',
  /** owner 还没配 —— 只允许回一条"你的 open_id 是…" */
  CLAIM: 'claim',
  /** 不是主人 */
  NOT_OWNER: 'not_owner',
  /** 不是单聊 */
  NOT_DM: 'not_dm',
  /** 事件里缺关键字段（拿不到发送者） */
  MALFORMED: 'malformed',
};

const norm = (s) => String(s == null ? '' : s).trim();

/**
 * 判断一条**消息**能不能处理。
 *
 * 顺序有意：先判"能不能拿到发送者"，再判聊天类型，最后才比身份。
 * 反过来的话，缺字段会被误报成"不是主人"，而这两件事的修法完全不同。
 */
export function decideMessage({ ownerOpenId, senderOpenId, chatType }) {
  const owner = norm(ownerOpenId);
  const sender = norm(senderOpenId);

  if (!sender) return { decision: DECISION.MALFORMED };

  // 群聊一律不处理。这个 bot 是私人入口 —— 在群里回话会让别人也看见，
  // 而且群里任何人都能 @ 它。要支持群聊得单独设计，不是放开这个判断就行。
  if (norm(chatType) !== 'p2p') return { decision: DECISION.NOT_DM };

  if (!owner) return { decision: DECISION.CLAIM, senderOpenId: sender };

  if (sender !== owner) return { decision: DECISION.NOT_OWNER, senderOpenId: sender };

  return { decision: DECISION.ALLOW };
}

/**
 * 判断一次**卡片按钮点击**能不能处理。
 *
 * 与消息不同，这里**只看身份**，不看聊天类型 —— 因为 SDK 给的
 * `CardActionEvent` 里没有 chatType（只有 chatId）。
 *
 * 少这一层判断是安全的：卡片只发给主人，而点了按钮的人必须
 * open_id 与主人一致才算数。别人就算看得到卡片、点得动按钮，
 * 也会停在这里。
 */
export function decideCardAction({ ownerOpenId, operatorOpenId }) {
  const owner = norm(ownerOpenId);
  const who = norm(operatorOpenId);

  if (!who) return { decision: DECISION.MALFORMED };
  if (!owner) return { decision: DECISION.CLAIM, senderOpenId: who };
  if (who !== owner) return { decision: DECISION.NOT_OWNER, senderOpenId: who };

  return { decision: DECISION.ALLOW };
}

/**
 * 各类拒绝该回什么话。
 *
 * 返回 `null` 表示**什么都不回**。这一条很重要：
 * 对"不是命令的闲聊"回一句"我不懂"会变成骚扰。
 *
 * `NOT_OWNER` 回一句话是有意的 —— 让点错的人知道没生效，
 * 而不是以为点了没反应。但**不透露主人的任何信息**。
 */
export function replyFor(decision, ctx = {}) {
  switch (decision) {
    case DECISION.ALLOW:
      return null;

    case DECISION.CLAIM:
      // 这个例外存在的唯一理由：否则用户无从知道自己的 open_id
      return [
        '**还没有配置主人。**',
        '',
        `你的 open_id：\`${norm(ctx.senderOpenId)}\``,
        '',
        '把它填进 `.env` 的 `FEISHU_OWNER_OPEN_ID=`，重启 bot 之后就能用了。',
        '',
        '_在你配置之前，这个机器人不会执行任何操作。_',
      ].join('\n');

    case DECISION.NOT_OWNER:
      return '无权操作。';

    case DECISION.NOT_DM:
      return null; // 群里不回话，免得刷屏

    case DECISION.MALFORMED:
      return null; // 拿不到发送者，没法回，也不该猜着处理

    default:
      return null;
  }
}

/** 这个决定是否允许"执行操作"（而不是只回一句话）。 */
export function allowsAction(decision) {
  return decision === DECISION.ALLOW;
}
