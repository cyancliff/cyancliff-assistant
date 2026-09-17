#!/usr/bin/env node
/**
 * test-feishu.mjs — 飞书那三个纯函数模块 + 发送锁的自测
 *
 * 为什么单独一个文件：`npm run test` 里已有的几组都是业务的，
 * 而这三个模块是**安全边界**（谁能操作、什么能发出去），
 * 混进业务测试里容易被当成"顺带测一下"。
 *
 * 这个项目里已经四次撞上"断言恒真"（看着像检查、其实什么都没检查），
 * 所以每写完一组都用突变测试证明它会失败 —— 见文件末尾的说明。
 */

import { writeFileSync, existsSync, rmSync, utimesSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

import {
  v2Card, button, buttonRow, markdown, helpCard, digestCard,
  draftConfirmCard, draftFullCard, resultCard, probeCard,
  escapeInline, truncate, ACTION, SCHEMA,
} from './feishu-card.mjs';

import { COMMANDS, parseCommand, helpRows, usageOf } from './feishu-commands.mjs';

import { DECISION, decideMessage, decideCardAction, replyFor, allowsAction } from './feishu-policy.mjs';

import {
  acquireSendLock, releaseSendLock, sendLockPath, busyMessage, withSendLock, parseSendOutput,
} from './mail-send.mjs';

import { createCore } from './feishu-core.mjs';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const green = c(32), red = c(31), dim = c(2), bold = c(1);

let passed = 0;
let failed = 0;

function chk(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`    ${green('✓')} ${name}`);
  } else {
    failed++;
    console.log(`    ${red('✗')} ${name}${detail ? `  ${dim(detail)}` : ''}`);
  }
}

function group(title) {
  console.log(`\n  ${bold(title)}`);
}

/** 卡片里所有 button 组件（递归找，别假设它一定在第几层）。 */
function allButtons(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const x of node) allButtons(x, out);
    return out;
  }
  if (node.tag === 'button') out.push(node);
  for (const v of Object.values(node)) allButtons(v, out);
  return out;
}

// ══ 1. 命令解析 ═══════════════════════════════════════════════
group('1. 命令解析');

{
  const r = parseCommand('/帮助');
  chk('/帮助 → 识别为命令', r.kind === 'command' && r.command.name === '帮助');

  chk('别名 /help 也认', parseCommand('/help').command?.name === '帮助');
  chk('别名 /h 也认', parseCommand('/h').command?.name === '帮助');
  chk('大小写不敏感（/HELP）', parseCommand('/HELP').command?.name === '帮助');
  chk('斜杠后带空格也认（/ 取信）', parseCommand('/ 取信').command?.name === '取信');
  chk('前后空白不影响', parseCommand('  /取信  ').command?.name === '取信');

  const draft = parseCommand('/稿 abc123');
  chk('/稿 abc123 → 参数拿到 id', draft.kind === 'command' && draft.args[0] === 'abc123');

  const find = parseCommand('/找 区分度 均值');
  chk('/找 带空格的参数整串保留', find.kind === 'command' && find.args.join(' ') === '区分度 均值');

  chk('/稿 不给参数 → 回帮助而不是猜', parseCommand('/稿').kind === 'help');
  chk('/取信 多给参数 → 回帮助', parseCommand('/取信 多余').kind === 'help');
  chk('未知命令 → 回帮助', parseCommand('/发送 abc').kind === 'help');
  chk('光一个斜杠 → 回帮助', parseCommand('/').kind === 'help');

  // 这一条最要紧：不是命令的闲聊**什么都不该回**
  chk('「你好」不是命令 → kind=none', parseCommand('你好').kind === 'none');
  chk('「帮我看看邮件」不是命令 → kind=none', parseCommand('帮我看看邮件').kind === 'none');
  chk('空字符串 → kind=none', parseCommand('').kind === 'none');
  chk('null → kind=none 而不是崩', parseCommand(null).kind === 'none');

  // 反面对照：确认上面那些 help 不是"什么都回 help"
  chk('help 与 none 是两种结果', parseCommand('/xxx').kind !== parseCommand('xxx').kind);

  chk('帮助行数与命令表一致', helpRows().length === COMMANDS.length);
  chk('用法串带参数位（/稿 <草稿 id>）', usageOf(COMMANDS.find((c) => c.name === '稿')) === '/稿 <草稿 id>');

  // 设计约束：命令表里永远不该出现"发送"
  chk('命令表里没有发送类命令', !COMMANDS.some((c) => /发送|send/i.test(c.name + c.aliases.join(''))));
}

// ══ 2. 权限判定 ═══════════════════════════════════════════════
group('2. 权限判定');

{
  const owner = 'ou_owner';

  chk('主人单聊 → allow',
    decideMessage({ ownerOpenId: owner, senderOpenId: owner, chatType: 'p2p' }).decision === DECISION.ALLOW);

  chk('别人单聊 → not_owner',
    decideMessage({ ownerOpenId: owner, senderOpenId: 'ou_other', chatType: 'p2p' }).decision === DECISION.NOT_OWNER);

  chk('群聊（哪怕是主人）→ not_dm',
    decideMessage({ ownerOpenId: owner, senderOpenId: owner, chatType: 'group' }).decision === DECISION.NOT_DM);

  chk('owner 没配 → claim（只回 open_id，不执行）',
    decideMessage({ ownerOpenId: '', senderOpenId: owner, chatType: 'p2p' }).decision === DECISION.CLAIM);

  chk('拿不到发送者 → malformed',
    decideMessage({ ownerOpenId: owner, senderOpenId: '', chatType: 'p2p' }).decision === DECISION.MALFORMED);

  // 顺序：缺字段不能被误报成"不是主人" —— 两件事的修法完全不同
  chk('缺字段优先于身份判断',
    decideMessage({ ownerOpenId: owner, senderOpenId: '', chatType: 'p2p' }).decision !== DECISION.NOT_OWNER);

  chk('open_id 前后空白被忽略',
    decideMessage({ ownerOpenId: ` ${owner} `, senderOpenId: owner, chatType: 'p2p' }).decision === DECISION.ALLOW);

  chk('大小写不同算不同人（open_id 是精确匹配）',
    decideMessage({ ownerOpenId: 'ou_ABC', senderOpenId: 'ou_abc', chatType: 'p2p' }).decision === DECISION.NOT_OWNER);

  // 卡片回调：没有 chatType，只看身份
  chk('卡片：主人点 → allow',
    decideCardAction({ ownerOpenId: owner, operatorOpenId: owner }).decision === DECISION.ALLOW);
  chk('卡片：别人点 → not_owner',
    decideCardAction({ ownerOpenId: owner, operatorOpenId: 'ou_other' }).decision === DECISION.NOT_OWNER);
  chk('卡片：owner 没配 → claim',
    decideCardAction({ ownerOpenId: '', operatorOpenId: owner }).decision === DECISION.CLAIM);

  chk('allow 才算允许执行操作', allowsAction(DECISION.ALLOW) && !allowsAction(DECISION.CLAIM));
  chk('claim 的回复里带上了对方的 open_id',
    String(replyFor(DECISION.CLAIM, { senderOpenId: 'ou_x' })).includes('ou_x'));
  chk('not_owner 的回复不泄露主人的 open_id',
    !String(replyFor(DECISION.NOT_OWNER) || '').includes(owner));
  chk('群聊拒绝时什么都不回（免得刷屏）', replyFor(DECISION.NOT_DM) === null);
  chk('闲聊不触发任何回复（replyFor 对 allow 返回 null）', replyFor(DECISION.ALLOW) === null);
}

// ══ 3. 卡片构造 ═══════════════════════════════════════════════
group('3. 卡片构造');

{
  chk('schema 是 2.0（1.0 的按钮不触发）', probeCard('n').schema === SCHEMA && SCHEMA === '2.0');

  const card = draftConfirmCard({ id: 'd1', to: 'a@b.com', subject: 's', preview: 'ZZPREVIEWZZ', chars: 3 });
  const btns = allButtons(card);

  chk('确认卡片有三个按钮', btns.length === 3);
  chk('三个动作齐了（confirm/preview/discard）',
    ['confirm', 'preview', 'discard'].every((a) => btns.some((b) => b.behaviors?.[0]?.value?.action === a)));

  // 关键：2.0 里按钮不能直接挂在 body.elements 下
  chk('按钮没有直接挂在 body.elements 下',
    !card.body.elements.some((e) => e.tag === 'button'));
  chk('按钮放在 column_set → column 里',
    card.body.elements.some((e) => e.tag === 'column_set' && e.columns?.[0]?.elements?.[0]?.tag === 'button'));

  chk('每个按钮的 behaviors 是 callback 类型',
    btns.every((b) => b.behaviors?.length === 1 && b.behaviors[0].type === 'callback'));
  chk('按钮 value 里带草稿 id', btns.every((b) => b.behaviors[0].value.id === 'd1'));
  // 检查**整个按钮**的 JSON，而不是只看 b.value ——
  // 实测之后去掉了同级的 value，`b.value` 变成 undefined，
  // 只看它就变成恒真了（这正是本文件反复撞上的那一类）。
  chk('按钮里不含正文（卡片内容会往返、会进日志）',
    !JSON.stringify(btns).includes('ZZPREVIEWZZ'));
  chk('回传值只放 behaviors 一处（不留两条路要维护）',
    btns.every((b) => !('value' in b) && b.behaviors.length === 1));

  chk('确认按钮是 primary、作废是 danger',
    btns.find((b) => b.behaviors[0].value.action === ACTION.CONFIRM).type === 'primary' &&
    btns.find((b) => b.behaviors[0].value.action === ACTION.DISCARD).type === 'danger');

  // 转义：邮件主题是外部输入
  chk('markdown 记号被转义（主题里的 * 不会变成粗体）',
    escapeInline('**重要**').includes('\\*') && !escapeInline('**重要**').includes('**'));
  chk('换行被压成空格（卡片里一行一个字段）', !escapeInline('a\nb').includes('\n'));
  chk('null 不会崩', escapeInline(null) === '');

  const long = truncate('x'.repeat(300), 100);
  chk('超长被截断', long.truncated && long.text.length < 300);
  chk('截断处说明了还剩多少（不悄悄截）', /还有 200 字/.test(long.text));
  chk('没超长就不动它', truncate('abc', 100).text === 'abc' && !truncate('abc', 100).truncated);

  const digest = digestCard({
    scanned: 60,
    counts: { signal: 11, plain: 23, noise: 26 },
    items: [{ subject: 's1', from: 'f1', kind: 'signal' }],
  });
  const digestText = JSON.stringify(digest);
  chk('摘要卡片带上了三个计数', /11/.test(digestText) && /23/.test(digestText) && /26/.test(digestText));
  chk('有需动作的用橙色表头', digest.header.template === 'orange');

  chk('帮助卡片列出了每个命令',
    COMMANDS.every((c) => JSON.stringify(helpCard(helpRows())).includes(`/${c.name}`)));

  chk('完整卡片也有确认按钮（看完能直接确认）',
    allButtons(draftFullCard({ id: 'd2', to: 't', subject: 's', body: 'b' }))
      .some((b) => b.behaviors[0].value.action === ACTION.CONFIRM));

  chk('结果卡片能构造', resultCard({ title: 't', lines: ['a'] }).body.elements.length === 1);
  chk('buttonRow 的列数与按钮数一致', buttonRow([button({ text: 'a', value: {} }), button({ text: 'b', value: {} })]).columns.length === 2);
  chk('v2Card 不给标题时不生成 header', !('header' in v2Card({ elements: [] })));
}

// ══ 4. 发送锁（防"点两次发两封"）═══════════════════════════════
group('4. 发送锁');

{
  const id = '__test-lock-001';
  const lockPath = sendLockPath(id);

  // 清掉可能残留的
  releaseSendLock(id);
  chk('起始状态没有锁文件', !existsSync(lockPath));

  const a = acquireSendLock(id);
  chk('第一次能拿到锁', a.acquired === true);
  chk('锁文件真的落盘了', existsSync(lockPath));

  const b = acquireSendLock(id);
  chk('第二次拿不到（这就是防重复发送的那一步）', b.acquired === false && b.reason === 'busy');
  chk('busy 时带上了持锁者信息', typeof b.holder === 'string' && b.holder.length > 0);
  chk('busy 的措辞不含 undefined', !busyMessage(b).includes('undefined'));

  releaseSendLock(id);
  chk('释放后锁文件没了', !existsSync(lockPath));

  const c2 = acquireSendLock(id);
  chk('释放后能重新拿到', c2.acquired === true);
  releaseSendLock(id);

  // 陈旧锁：进程被 kill 掉会留下文件，不能永久卡住
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, 'pid 99999 @ 很久以前', 'utf8');
  const old = (Date.now() - 10 * 60 * 1000) / 1000;
  utimesSync(lockPath, old, old);
  const stale = acquireSendLock(id);
  chk('陈旧锁会被接管（进程崩了不会永久卡住）', stale.acquired === true);
  releaseSendLock(id);

  // withSendLock：fn 抛异常也必须解锁，否则会永久卡住
  let threw = false;
  try {
    await withSendLock(id, async () => { throw new Error('boom'); });
  } catch {
    threw = true;
  }
  chk('fn 抛异常时异常照常抛出', threw);
  chk('fn 抛异常后锁被释放了（不然永久卡住）', !existsSync(lockPath));

  const r = await withSendLock(id, async () => 'value');
  chk('withSendLock 返回 fn 的结果', r.acquired && r.value === 'value');
  chk('withSendLock 正常结束后也解锁', !existsSync(lockPath));

  // 持锁期间不执行 fn —— 这条是"点两次只发一封"的核心
  acquireSendLock(id);
  let ran = false;
  const blocked = await withSendLock(id, async () => { ran = true; });
  chk('持锁期间 withSendLock 不执行 fn', blocked.acquired === false && ran === false);
  releaseSendLock(id);

  if (existsSync(lockPath)) rmSync(lockPath, { force: true });

  // ── 回归测试：子进程退出后锁必须被清掉 ──────────────────────
  //
  // 这条钉住的是一个真实撞过的 bug：`proxy.mjs` 在模块加载时装了一个
  // 调 `process.reallyExit()` 的 exit 处理器，而它会**立刻终止进程**，
  // 把之后注册的 exit 处理器全部闷掉。mail-send 的锁清理就是这么失效的 ——
  // 锁从来没被清过，而它会自愈（陈旧超时），所以表现成"偶发的怪毛病"。
  //
  // 为什么必须用子进程：exit 处理器只能在进程真的退出时观察，
  // 在同进程里测不出来。**这也是这个 bug 能活这么久的原因。**
  const CHILD_ID = '__exitcleanup-test';
  const childLock = sendLockPath(CHILD_ID);
  if (existsSync(childLock)) rmSync(childLock, { force: true });

  const probe = [
    "const u=require('node:url'),p=require('node:path');",
    "import(u.pathToFileURL(p.join(process.cwd(),'scripts','mail-send.mjs')).href)",
    ".then(m=>{m.acquireSendLock('" + CHILD_ID + "');process.exit(0)})",
  ].join('');

  execFileSync(process.execPath, ['-e', probe], { cwd: ROOT, stdio: 'ignore' });

  chk(
    '子进程 process.exit 之后锁被清掉了（回归：proxy 的 reallyExit 曾闷掉它）',
    !existsSync(childLock)
  );
}

// ══ 5. 解析子进程输出（bot 判断"发出去了没有"靠它）══════════════
group('5. 输出解析');

{
  const okOut = ['', '  ✓ 已发送', '  Gmail message id  gm_abc123', '  收件人  a@b.com', ''].join('\n');
  const r1 = parseSendOutput(okOut);
  chk('看到 ✓ 已发送 + message id → 成功', r1.ok === true && r1.messageId === 'gm_abc123');

  // 这一条最要紧：退出码在这台机器上不可信
  chk('★ 退出码非零但输出说成功 → 仍然算成功（Windows 上的已知问题）',
    parseSendOutput(okOut, '(node:1234) libuv assertion').ok === true);

  const fail = parseSendOutput('', '  ✗ 正文在确认之后被改过，不发。\n  ...');
  chk('看到 ✗ → 失败并带出那句话', fail.ok === false && fail.reason.includes('正文在确认之后被改过'));

  chk('✗ 前缀被去掉（拼到卡片里不会出现多余符号）', !fail.reason.startsWith('✗'));

  const nothing = parseSendOutput('随便什么输出');
  chk('既没成功也没失败的行 → 失败，而不是默认成功', nothing.ok === false);
  chk('原因里说清了是"没看到那两行"', /既没有成功也没有失败/.test(nothing.reason));

  chk('★ 只有 ✓ 没有 message id → 不算成功（半截输出）',
    parseSendOutput('  ✓ 已发送').ok === false);
  chk('只有 message id 没有 ✓ → 也不算成功',
    parseSendOutput('  Gmail message id  gm_x').ok === false);
}

// ══ 6. 核心编排（假端口）═══════════════════════════════════════
group('6. 核心编排');

{
  const OWNER = 'ou_owner';

  /** 假端口：只记录调用，不碰网络、不碰磁盘。 */
  function fakePorts({ drafts = {}, overrides = {} } = {}) {
    const calls = [];
    const put = (name, args) => calls.push({ name, args });
    const base = {
      calls,
      drafts,
      sendText: async (chatId, text, opts) => put('sendText', [chatId, text, opts]),
      sendCard: async (chatId, card, opts) => put('sendCard', [chatId, card, opts]),
      updateCard: async (messageId, card) => put('updateCard', [messageId, card]),
      readDraft: (id) => drafts[id] || null,
      listDrafts: () => Object.keys(drafts).map((id) => ({ id })),
      draftFor: async (id) => {
        put('draftFor', [id]);
        return '拟出来的正文';
      },
      discardDraft: async (id) => put('discardDraft', [id]),
      confirmDraft: (id, via) => put('confirmDraft', [id, via]),
      sendDraft: async (id) => {
        put('sendDraft', [id]);
        return { ok: true, messageId: 'gm_1' };
      },
      withSendLock: async (id, fn) => {
        put('withSendLock', [id]);
        return { acquired: true, value: await fn() };
      },
      mailSummary: async () => {
        put('mailSummary', []);
        return { scanned: 60, counts: { signal: 11, plain: 23, noise: 26 }, items: [] };
      },
      findQuote: async (kw) => {
        put('findQuote', [kw]);
        return [{ file: 'library/x.md', line: 42, text: '找到的原文' }];
      },
      status: async () => {
        put('status', []);
        return ['一切都好'];
      },
      stop: (why) => put('stop', [why]),
      log: () => {},
    };
    return Object.assign(base, overrides);
  }

  const named = (calls, name) => calls.filter((c) => c.name === name);
  const lastCardOf = (calls, name) => {
    const hit = named(calls, name).pop();
    return hit ? hit.args[1] : null;
  };
  const cardText = (card) => JSON.stringify(card || {});

  const msg = (over = {}) => ({
    chatId: 'oc_1', chatType: 'p2p', senderId: OWNER, messageId: 'om_1', content: '/帮助', ...over,
  });

  // ── 权限先于一切 ──
  {
    const p = fakePorts();
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    const r = await core.handleMessage(msg({ senderId: 'ou_other', content: '/取信' }));

    chk('非主人 → 不执行', r.acted === false && r.decision === DECISION.NOT_OWNER);
    chk('非主人 → 回了「无权操作」', named(p.calls, 'sendText').some((c) => c.args[1].includes('无权操作')));
    chk('非主人 → 没有跑 mailSummary', named(p.calls, 'mailSummary').length === 0);
    chk('非主人 → 没发任何卡片', named(p.calls, 'sendCard').length === 0);
  }
  {
    const p = fakePorts();
    const core = createCore({ ports: p, ownerOpenId: '' });
    const r = await core.handleMessage(msg({ senderId: 'ou_whoever' }));

    chk('owner 没配 → 不执行', r.acted === false && r.decision === DECISION.CLAIM);
    chk('owner 没配 → 回复里带上对方的 open_id',
      named(p.calls, 'sendText').some((c) => c.args[1].includes('ou_whoever')));
  }
  {
    const p = fakePorts();
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    const r = await core.handleMessage(msg({ chatType: 'group' }));

    chk('群聊 → 什么都不发（连拒绝都不回）', r.acted === false && p.calls.length === 0);
  }

  // ── 不是命令就不理 ──
  {
    const p = fakePorts();
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    const r = await core.handleMessage(msg({ content: '你好啊' }));

    chk('闲聊 → 什么都不发', r.acted === false && p.calls.length === 0);
  }

  // ── 各条命令 ──
  {
    const p = fakePorts();
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    await core.handleMessage(msg({ content: '/帮助' }));
    chk('/帮助 → 发帮助卡片', named(p.calls, 'sendCard').length === 1);
  }
  {
    const p = fakePorts();
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    await core.handleMessage(msg({ content: '/取信' }));
    chk('/取信 → 调了 mailSummary', named(p.calls, 'mailSummary').length === 1);
    chk('/取信 → 卡片里带三个计数', /11/.test(cardText(lastCardOf(p.calls, 'sendCard'))));
  }
  {
    const p = fakePorts({ drafts: { d1: { id: 'd1', fm: { to: 'a@b.com', subject: 's' }, body: '正文内容' } } });
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    await core.handleMessage(msg({ content: '/稿 d1' }));
    const card = cardText(lastCardOf(p.calls, 'sendCard'));
    chk('/稿 有草稿 → 推确认卡片', /confirm/.test(card) && /a@b\.com/.test(card));
    chk('/稿 → 没有直接发送', named(p.calls, 'sendDraft').length === 0);
  }
  {
    const p = fakePorts();
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    await core.handleMessage(msg({ content: '/稿 nope' }));
    chk('/稿 找不到 → 回错误卡片而不是崩', named(p.calls, 'sendCard').length === 1);
  }
  {
    const p = fakePorts();
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    await core.handleMessage(msg({ content: '/找 区分度均值' }));
    chk('/找 → 调了 findQuote 且带上关键词',
      named(p.calls, 'findQuote')[0]?.args[0] === '区分度均值');
    chk('/找 → 卡片里带 文件:行号', /library\/x\.md:42/.test(cardText(lastCardOf(p.calls, 'sendCard'))));
  }
  {
    const p = fakePorts();
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    await core.handleMessage(msg({ content: '/状态' }));
    chk('/状态 → 调了 status', named(p.calls, 'status').length === 1);
    chk('/状态 → 没有触发发送', named(p.calls, 'sendDraft').length === 0);
  }
  {
    const p = fakePorts();
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    await core.handleMessage(msg({ content: '/停' }));
    chk('/停 → 调了 stop', named(p.calls, 'stop').length === 1);
  }
  {
    const p = fakePorts();
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    await core.handleMessage(msg({ content: '/发送 d1' }));
    chk('未知命令 → 回帮助', named(p.calls, 'sendCard').length === 1);
    chk('未知命令 → 没有发信', named(p.calls, 'sendDraft').length === 0);
  }
  {
    const p = fakePorts({ overrides: { findQuote: async () => { throw new Error('资料库坏了'); } } });
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    const r = await core.handleMessage(msg({ content: '/找 x' }));
    chk('命令内部抛错 → 回错误卡片，不把进程带崩', r.error === '资料库坏了' && named(p.calls, 'sendCard').length === 1);
  }

  // ── 卡片按钮 ──
  const cardEvt = (over = {}) => ({
    messageId: 'om_card', chatId: 'oc_1',
    operator: { openId: OWNER },
    action: { tag: 'button', value: { action: ACTION.CONFIRM, id: 'd1' } },
    ...over,
  });

  // 点「确认发送」之后，真正干活的是**后台那段** —— 因为飞书要求回调 3 秒内响应，
  // 而真发信要 spawn 子进程 + 走网络。core 把它作为 `done` 返回。
  // 正式运行忽略它；测试必须 await 它才能断言结果。
  const confirmResult = async (core, over = {}) => {
    const r = await core.handleCardAction(cardEvt(over));
    return r.done ? await r.done : r;
  };

  {
    const p = fakePorts();
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    const r = await core.handleCardAction(cardEvt({ operator: { openId: 'ou_other' } }));

    chk('非主人点按钮 → 不执行', r.acted === false);
    chk('非主人点按钮 → 回了无权操作', named(p.calls, 'sendText').some((c) => c.args[1].includes('无权操作')));
    chk('非主人点按钮 → 没有发信', named(p.calls, 'sendDraft').length === 0);
    chk('非主人点按钮 → 没动卡片', named(p.calls, 'updateCard').length === 0);
  }
  {
    const p = fakePorts({ drafts: { d1: { id: 'd1', fm: { to: 'a@b.com', subject: 's' }, body: 'b' } } });
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    const r = await confirmResult(core);

    chk('主人点确认 → 真的发了', r.sent === true && named(p.calls, 'sendDraft').length === 1);
    // 注意：named() 返回的是 {name, args}，取值要走 .args ——
    // 第一版我按数组下标写，取到的是 undefined，于是"断言"永远不成立。
    chk('主人点确认 → 先落了确认记录', named(p.calls, 'confirmDraft')[0]?.args[0] === 'd1');
    chk('确认记录的渠道标明是飞书卡片', named(p.calls, 'confirmDraft')[0]?.args[1] === 'feishu-card');
    chk('★ 发送是在锁里做的（去掉锁这条就会红）', named(p.calls, 'withSendLock').length === 1);
    chk('发完把卡片改成「已发送」', /已发送/.test(cardText(lastCardOf(p.calls, 'updateCard'))));
  }
  {
    // ★ 回调必须在**发送完成之前**就返回 ——
    //   飞书要求 3 秒内响应，而真发信要 spawn 子进程 + 走网络。
    //   同步等待 = 超时 → 飞书重推 → 卡片被重置
    //   （实测踩过：邮件发出去了，但卡片一直不变绿）。
    //
    //   注意断言的是"没等它完成"，不是"没开始"：
    //   async IIFE 会同步执行到第一个 await 之前，所以"已启动"是正常的。
    //   第一版我写成断言"没开始"，结果测试红了 —— 而红的原因是断言错，不是代码错。
    let sendFinished = false;
    const p = fakePorts({
      drafts: { d1: { id: 'd1', fm: { to: 'a@b.com', subject: 's' }, body: 'b' } },
      overrides: {
        sendDraft: async (id) => {
          p.calls.push({ name: 'sendDraft', args: [id] });
          await new Promise((r) => setTimeout(r, 50)); // 假装在走网络
          sendFinished = true;
          return { ok: true, messageId: 'gm_1' };
        },
      },
    });
    const core = createCore({ ports: p, ownerOpenId: OWNER });

    const r = await core.handleCardAction(cardEvt());

    chk('★ 回调返回时发送还没完成（不然就超 3 秒了）', sendFinished === false);
    chk('但已经先把卡片改成了「正在发送」', /正在发送/.test(cardText(lastCardOf(p.calls, 'updateCard'))));

    await r.done;
    chk('await done 之后发送才完成', sendFinished === true);
    chk('完成后卡片变成「已发送」', /已发送/.test(cardText(lastCardOf(p.calls, 'updateCard'))));
  }
  {
    // 已经发过的草稿：再点也不发
    const p = fakePorts({ drafts: { d1: { id: 'd1', fm: { sent_at: '2026-01-01T00:00:00Z' }, body: 'b' } } });
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    const r = await confirmResult(core);

    chk('已发送的草稿 → 不重复发', r.acted === false && named(p.calls, 'sendDraft').length === 0);
    chk('已发送的草稿 → 连锁都不去拿', named(p.calls, 'withSendLock').length === 0);
  }
  {
    // 拿到锁之后才发现已经被发掉了（等锁期间别人发了）
    const drafts = { d1: { id: 'd1', fm: {}, body: 'b' } };
    const p = fakePorts({
      drafts,
      overrides: {
        withSendLock: async (id, fn) => {
          drafts[id].fm.sent_at = '2026-01-01T00:00:00Z'; // 模拟等锁期间被别人发掉
          return { acquired: true, value: await fn() };
        },
      },
    });
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    const r = await confirmResult(core);

    chk('锁内重读发现已发出 → 不重复发', r.reason === 'already-sent' && named(p.calls, 'sendDraft').length === 0);
  }
  {
    // 并发点两下：第二次拿不到锁
    const p = fakePorts({
      drafts: { d1: { id: 'd1', fm: {}, body: 'b' } },
      overrides: {
        withSendLock: async (id, fn) => {
          p.calls.push({ name: 'withSendLock', args: [id] });
          if (p.calls.filter((c) => c.name === 'withSendLock').length > 1) {
            return { acquired: false, reason: 'busy', holder: 'pid 123', ageMs: 500 };
          }
          return { acquired: true, value: await fn() };
        },
      },
    });
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    const [ra, rb] = await Promise.all([core.handleCardAction(cardEvt()), core.handleCardAction(cardEvt())]);
    const [a, b] = [await ra.done, await rb.done];

    chk('连点两次 → 只发一封', named(p.calls, 'sendDraft').length === 1);
    chk('连点两次 → 第二次拿到 busy', [a.reason, b.reason].includes('busy'));
    // 不能只看"最后一次"更新 —— 两个回调交错，谁最后写卡片是不确定的。
    // 要问的是"有没有出现过『正在发送中』"，不是"最后一条是不是它"。
    chk('busy 时卡片上说明了原因',
      named(p.calls, 'updateCard').some((c) => /正在发送中/.test(cardText(c.args[1]))));
  }
  {
    const p = fakePorts({
      drafts: { d1: { id: 'd1', fm: { to: 'a@b.com', subject: 's' }, body: '很长的正文'.repeat(50) } },
    });
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    await core.handleCardAction(cardEvt({ action: { tag: 'button', value: { action: ACTION.PREVIEW, id: 'd1' } } }));
    const card = cardText(lastCardOf(p.calls, 'updateCard'));
    chk('看全文 → 卡片里出现完整正文', card.includes('很长的正文'));
    chk('看全文 → 没有发送', named(p.calls, 'sendDraft').length === 0);
  }
  {
    const p = fakePorts({ drafts: { d1: { id: 'd1', fm: {}, body: 'b' } } });
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    await core.handleCardAction(cardEvt({ action: { tag: 'button', value: { action: ACTION.DISCARD, id: 'd1' } } }));
    chk('作废 → 调了 discardDraft', named(p.calls, 'discardDraft').length === 1);
    chk('作废 → 没有发送', named(p.calls, 'sendDraft').length === 0);
  }
  {
    const p = fakePorts({ drafts: { d1: { id: 'd1', fm: {}, body: 'b' } } });
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    const r = await core.handleCardAction(cardEvt({ action: { tag: 'button', value: {} } }));
    chk('回调里没有 action/id → 什么都不做', r.acted === false && named(p.calls, 'sendDraft').length === 0);
  }
  {
    // 发信失败：卡片上要写清原因
    const p = fakePorts({
      drafts: { d1: { id: 'd1', fm: { to: 'a@b.com', subject: 's' }, body: 'b' } },
      overrides: { sendDraft: async () => ({ ok: false, reason: 'Gmail 401' }) },
    });
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    const r = await confirmResult(core);
    chk('发送失败 → 返回 sent:false 并带上原因', r.sent === false && r.reason === 'Gmail 401');
    chk('发送失败 → 卡片上写了原因', /Gmail 401/.test(cardText(lastCardOf(p.calls, 'updateCard'))));
  }
  {
    // 更新卡片自己失败，不能影响"已经发出去了"这个事实
    const p = fakePorts({
      drafts: { d1: { id: 'd1', fm: { to: 'a@b.com', subject: 's' }, body: 'b' } },
      overrides: { updateCard: async () => { throw new Error('卡片服务 500'); } },
    });
    const core = createCore({ ports: p, ownerOpenId: OWNER });
    const r = await confirmResult(core);
    chk('更新卡片失败不影响发送结果', r.sent === true && named(p.calls, 'sendDraft').length === 1);
  }
}

// ══ 结果 ══════════════════════════════════════════════════════
console.log('');
if (failed === 0) {
  console.log(`  ${green('✓')} 飞书模块自测通过（${passed} 项）\n`);
  process.exit(0);
} else {
  console.log(`  ${red('✗')} ${failed} 项失败，${passed} 项通过\n`);
  process.exit(1);
}
