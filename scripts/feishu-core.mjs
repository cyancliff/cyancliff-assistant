/**
 * feishu-core.mjs — bot 的编排层
 *
 * **不 import SDK。** 所有副作用走 `ports`，所以没凭据、没依赖也能端到端测。
 * 这是 `workflow.mjs` 那套"端口可注入"的同一做法，理由也一样：
 * **"编排对不对"和"凭据有没有"是两件分开验证的事。**
 *
 * 传输层（长连接、SDK、真发消息）在 `feishu-bot.mjs`。
 *
 * ── 这里最重要的三条 ───────────────────────────────────────────
 * 1. **权限先于一切。** 每个入口第一件事是 `decideMessage` / `decideCardAction`，
 *    只有 `allow` 才继续。不是主人就到此为止。
 * 2. **没有"发送"命令。** 发送只能点按钮。命令是打字的、打字会打错。
 * 3. **确认与发送都在锁里，且锁内重新读一次草稿。**
 *    锁外读的状态到用的时候可能已经过期了（飞书会重推回调）。
 */

import { parseCommand, helpRows, usageOf } from './feishu-commands.mjs';
import { DECISION, decideMessage, decideCardAction, replyFor, allowsAction } from './feishu-policy.mjs';
import {
  ACTION, helpCard, digestCard, draftConfirmCard, draftFullCard, resultCard, truncate,
} from './feishu-card.mjs';

/** 正文预览多长。太长会把卡片撑爆，太短看不出是什么。 */
const PREVIEW_CHARS = 500;

/**
 * 造一个编排器。
 *
 * @param ports 全部副作用。见下面每个调用点的注释。
 * @param ownerOpenId 主人。空字符串 = 还没配（只回认领提示）。
 */
export function createCore({ ports, ownerOpenId = '', now = () => new Date().toISOString() }) {
  const log = ports.log || (() => {});

  // ── 消息 ────────────────────────────────────────────────────
  async function handleMessage(msg) {
    const d = decideMessage({
      ownerOpenId,
      senderOpenId: msg?.senderId,
      chatType: msg?.chatType,
    });

    const reply = replyFor(d.decision, { senderOpenId: msg?.senderId });
    if (reply) {
      await ports.sendText(msg.chatId, reply, { replyTo: msg.messageId });
    }

    if (!allowsAction(d.decision)) {
      log(`拒绝消息：${d.decision}`);
      return { decision: d.decision, acted: false };
    }

    const parsed = parseCommand(msg.content);

    // 不是命令 —— **什么都不回**。每条闲聊都回"我不懂"会变成骚扰。
    if (parsed.kind === 'none') {
      log('不是命令，忽略');
      return { decision: d.decision, acted: false, command: null };
    }

    if (parsed.kind === 'help') {
      await ports.sendCard(msg.chatId, helpCard(helpRows()), { replyTo: msg.messageId });
      log(`回帮助：${parsed.reason}`);
      return { decision: d.decision, acted: true, command: 'help', reason: parsed.reason };
    }

    const name = parsed.command.name;
    log(`执行 /${name} ${parsed.args.join(' ')}`.trim());

    try {
      await dispatch(name, parsed.args, msg);
    } catch (e) {
      await ports.sendCard(
        msg.chatId,
        resultCard({ title: `/${name} 出错`, template: 'red', lines: [`\`${String(e.message)}\``] }),
        { replyTo: msg.messageId }
      );
      log(`/${name} 抛错：${e.message}`);
      return { decision: d.decision, acted: true, command: name, error: e.message };
    }

    return { decision: d.decision, acted: true, command: name };
  }

  async function dispatch(name, args, msg) {
    switch (name) {
      case '帮助':
        return ports.sendCard(msg.chatId, helpCard(helpRows()), { replyTo: msg.messageId });

      case '取信': {
        const s = await ports.mailSummary({ limit: 60 });
        return ports.sendCard(
          msg.chatId,
          digestCard({ scanned: s.scanned, counts: s.counts, items: s.items }),
          { replyTo: msg.messageId }
        );
      }

      case '稿': {
        const id = args[0];
        const draft = ports.readDraft(id);
        if (!draft) {
          const known = ports.listDrafts().map((d) => d.id);
          const hint = known.length ? `现有草稿：\n${known.slice(0, 10).map((k) => `・\`${k}\``).join('\n')}` : '还没有草稿。先发 `/取信`。';
          return ports.sendCard(
            msg.chatId,
            resultCard({ title: `找不到草稿 ${id}`, template: 'red', lines: [hint] }),
            { replyTo: msg.messageId }
          );
        }
        // 有草稿但没正文 —— 先拟一份，再推确认卡片
        const body = draft.body && draft.body.trim() ? draft.body : await ports.draftFor(id);
        const preview = truncate(body, PREVIEW_CHARS);
        return ports.sendCard(
          msg.chatId,
          draftConfirmCard({
            id,
            to: draft.fm.to || '(无收件人)',
            subject: draft.fm.subject || '(无主题)',
            preview: preview.text,
            chars: body.trim().length,
          }),
          { replyTo: msg.messageId }
        );
      }

      case '找': {
        const kw = args.join(' ');
        const hits = await ports.findQuote(kw);
        if (!hits.length) {
          return ports.sendCard(
            msg.chatId,
            resultCard({ title: '没找到', template: 'grey', lines: [`资料库里没有 \`${kw}\`。`] }),
            { replyTo: msg.messageId }
          );
        }
        const lines = hits.slice(0, 8).map(
          (h) => `**\`${h.file}:${h.line}\`**\n　　${truncate(h.text, 160).text}`
        );
        if (hits.length > 8) lines.push(`\n_还有 ${hits.length - 8} 处没列出来_`);
        return ports.sendCard(
          msg.chatId,
          resultCard({ title: `找到 ${hits.length} 处：${kw}`, lines }),
          { replyTo: msg.messageId }
        );
      }

      case '状态':
        return ports.sendCard(msg.chatId, resultCard({ title: '运行状态', lines: await ports.status() }), {
          replyTo: msg.messageId,
        });

      case '停': {
        await ports.sendCard(
          msg.chatId,
          resultCard({
            title: '正在停止',
            template: 'orange',
            lines: ['bot 要停了 —— 再发消息不会有回应。', '', '_重启：`npm run feishu:bot`_'],
          }),
          { replyTo: msg.messageId }
        );
        return ports.stop('命令 /停');
      }

      default:
        return ports.sendCard(msg.chatId, helpCard(helpRows()), { replyTo: msg.messageId });
    }
  }

  // ── 卡片按钮 ────────────────────────────────────────────────
  async function handleCardAction(evt) {
    const d = decideCardAction({
      ownerOpenId,
      operatorOpenId: evt?.operator?.openId,
    });

    // 别人点了按钮：回一句让他知道没生效，但**不透露任何人的信息**
    if (d.decision === DECISION.NOT_OWNER) {
      if (evt.chatId) await ports.sendText(evt.chatId, '无权操作。');
    }
    if (!allowsAction(d.decision)) {
      log(`拒绝卡片操作：${d.decision}（${evt?.operator?.openId || '拿不到 openId'}）`);
      return { decision: d.decision, acted: false };
    }

    const value = (evt.action && typeof evt.action.value === 'object' && evt.action.value) || {};
    const id = value.id;
    const action = value.action;

    if (!id || !action) {
      log(`卡片回调里没有 action/id：${JSON.stringify(evt.action?.value)}`);
      return { decision: d.decision, acted: false, reason: 'no-action' };
    }

    log(`卡片操作 ${action} ${id}`);

    try {
      switch (action) {
        case ACTION.PREVIEW:
          return await doPreview(evt, id);
        case ACTION.DISCARD:
          return await doDiscard(evt, id);
        case ACTION.CONFIRM:
          return await doConfirm(evt, id);
        default:
          log(`不认识的卡片动作：${action}`);
          return { decision: d.decision, acted: false, reason: 'unknown-action' };
      }
    } catch (e) {
      await safeUpdateCard(evt.messageId, {
        title: '操作出错',
        template: 'red',
        lines: [`\`${String(e.message)}\``],
      });
      log(`卡片操作抛错：${e.message}`);
      return { decision: d.decision, acted: true, error: e.message };
    }
  }

  async function doPreview(evt, id) {
    const draft = ports.readDraft(id);
    if (!draft) return failCard(evt, `找不到草稿 ${id}`);
    await ports.updateCard(
      evt.messageId,
      draftFullCard({
        id,
        to: draft.fm.to || '(无收件人)',
        subject: draft.fm.subject || '(无主题)',
        body: draft.body || '(还没有正文)',
      })
    );
    return { decision: DECISION.ALLOW, acted: true, command: 'preview', id };
  }

  async function doDiscard(evt, id) {
    const draft = ports.readDraft(id);
    if (!draft) return failCard(evt, `找不到草稿 ${id}`);
    if (draft.fm.sent_at) return failCard(evt, `这封已经发出去了（${draft.fm.sent_at}），不能作废。`);
    await ports.discardDraft(id);
    await safeUpdateCard(evt.messageId, {
      title: '已作废',
      template: 'grey',
      lines: [`草稿 \`${id}\` 已作废，不会再被发送。`],
    });
    return { decision: DECISION.ALLOW, acted: true, command: 'discard', id };
  }

  /**
   * 点「确认发送」。
   *
   * 这是全项目唯一一条从飞书触发发信的路。所以每一步都不能省：
   *   锁  → 防并发（飞书会重推回调，用户也可能连点两下）
   *   锁内重读 → 锁外读到的状态到此刻可能已经过期
   *   查 sent_at → 已经发过的绝不重发
   *   走 ports.sendDraft → 它内部仍有两道闸门（确认记录 + 正文摘要）
   */
  async function doConfirm(evt, id) {
    const before = ports.readDraft(id);
    if (!before) return failCard(evt, `找不到草稿 ${id}`);
    if (before.fm.sent_at) {
      await safeUpdateCard(evt.messageId, {
        title: '已经发过了',
        template: 'grey',
        lines: [`这封在 ${before.fm.sent_at} 就发出去了，不重复发。`],
      });
      return { decision: DECISION.ALLOW, acted: false, command: 'confirm', reason: 'already-sent' };
    }

    // ★ 先把"收到了"告诉用户，然后立刻返回 —— 远在 3 秒之内。
    //   真发信要 spawn 子进程 + 走网络（2 秒起步），同步做会超时 → 飞书重推 → 卡片被重置。
    //   计划 §5 写对了这一点，实现时写成了同步的，踩过才知道。
    await safeUpdateCard(evt.messageId, {
      title: '正在发送…',
      template: 'orange',
      lines: [
        `**收件人**　${before.fm.to || '(无)'}`,
        `**主题**　${before.fm.subject || '(无)'}`,
        '',
        '_发完这张卡片会再变一次。_',
      ],
    });

    const done = (async () => {
    const locked = await ports.withSendLock(id, async () => {
      // 锁内重读：等锁的这段时间里，另一个回调可能已经把它发掉了
      const draft = ports.readDraft(id);
      if (draft?.fm?.sent_at) return { ok: false, reason: 'already-sent', sentAt: draft.fm.sent_at };

      // 先落确认记录（闸门 1 要求它在），via 标明渠道便于事后审计
      ports.confirmDraft(id, 'feishu-card');
      return ports.sendDraft(id);
    });

    if (!locked.acquired) {
      log(`确认 ${id} → 忙（${locked.holder || '另一个回调'}）`);
      await safeUpdateCard(evt.messageId, {
        title: '正在发送中',
        template: 'orange',
        lines: ['这一封已经在发了，不重复发。', '', '_等它发完再看这张卡片。_'],
      });
      return { decision: DECISION.ALLOW, acted: false, command: 'confirm', reason: 'busy' };
    }

    const r = locked.value || {};

    if (r.reason === 'already-sent') {
      log(`确认 ${id} → 已被发过（${r.sentAt || '刚才'}）`);
      await safeUpdateCard(evt.messageId, {
        title: '已经发过了',
        template: 'grey',
        lines: [`这封在 ${r.sentAt || '(刚才)'} 发出去了，不重复发。`],
      });
      return { decision: DECISION.ALLOW, acted: false, command: 'confirm', reason: 'already-sent' };
    }

    if (r.ok) {
      // 发信结果**必须记日志**。不记的话出问题时终端上一个字都没有，
      // 只能去翻草稿的 frontmatter —— 这一条也是踩过才加的。
      log(`确认 ${id} → 已发送 ${r.messageId || ''}`);
      await safeUpdateCard(evt.messageId, {
        title: '已发送',
        template: 'green',
        lines: [
          `**收件人**　${before.fm.to || '(无)'}`,
          `**主题**　${before.fm.subject || '(无)'}`,
          '',
          `Gmail message id：\`${r.messageId || '(未返回)'}\``,
          `发送于 ${now()}`,
        ],
      });
      return { decision: DECISION.ALLOW, acted: true, command: 'confirm', id, sent: true };
    }

    log(`确认 ${id} → 没发出去：${r.reason || '未知'}`);
    await safeUpdateCard(evt.messageId, {
      title: '没发出去',
      template: 'red',
      lines: [`**原因**　${r.reason || '未知'}`, '', '_草稿没有被标成已发送，可以重试。_'],
    });
    return { decision: DECISION.ALLOW, acted: true, command: 'confirm', id, sent: false, reason: r.reason };
    })();

    // 后台那段不能有未捕获的拒绝 —— 那会把进程带崩，而用户只看到"没反应"
    done.catch((e) => log(`确认 ${id} 的后台任务抛错：${e.message}`));

    return { decision: DECISION.ALLOW, acted: true, command: 'confirm', id, pending: true, done };
  }

  // ── 小工具 ──────────────────────────────────────────────────
  async function failCard(evt, message) {
    await safeUpdateCard(evt.messageId, { title: '不行', template: 'red', lines: [message] });
    return { decision: DECISION.ALLOW, acted: false, reason: 'not-found' };
  }

  /** 更新卡片失败不该让整个操作报错 —— 发送可能已经成功了。 */
  async function safeUpdateCard(messageId, { title, template, lines }) {
    if (!messageId) return;
    try {
      await ports.updateCard(messageId, resultCard({ title, template, lines }));
    } catch (e) {
      log(`更新卡片失败（不影响主流程）：${e.message}`);
    }
  }

  return { handleMessage, handleCardAction };
}
