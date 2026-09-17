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
import path from 'node:path';

import {
  v2Card, button, buttonRow, markdown, helpCard, digestCard,
  draftConfirmCard, draftFullCard, resultCard, probeCard,
  escapeInline, truncate, ACTION, SCHEMA,
} from './feishu-card.mjs';

import { COMMANDS, parseCommand, helpRows, usageOf } from './feishu-commands.mjs';

import { DECISION, decideMessage, decideCardAction, replyFor, allowsAction } from './feishu-policy.mjs';

import {
  acquireSendLock, releaseSendLock, sendLockPath, busyMessage, withSendLock,
} from './mail-send.mjs';

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
  // 第一版这条写成了检查 'p' —— 而 "action":"preview" 里本来就有 p，恒真。
  // 换了有辨识度的字符串才真的在检查。
  chk('按钮 value 里不含正文（卡片内容会往返、会进日志）',
    !JSON.stringify(btns.map((b) => b.value)).includes('ZZPREVIEWZZ'));

  chk('确认按钮是 primary、作废是 danger',
    btns.find((b) => b.value.action === ACTION.CONFIRM).type === 'primary' &&
    btns.find((b) => b.value.action === ACTION.DISCARD).type === 'danger');

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
      .some((b) => b.value.action === ACTION.CONFIRM));

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
