#!/usr/bin/env node
/**
 * test-send-gates.mjs — 发信闸门与"结果未知"状态的回归测试
 *
 *   node scripts/test-send-gates.mjs
 *
 * ## 它盯的是两件真会出事的事（来自 2026-09-19 的一次外部审查）
 *
 * **P0-1 旧确认卡片发送后来修改过的草稿。**
 * 原流程：生成卡片（卡片上写着收件人 A）→ 改草稿 `to:` 为 B → 点**那张旧卡片**。
 * 闸门 2 当时只比正文，于是通过、发给 B。
 * 修法：确认记录里存**完整载荷**摘要（收件人 + 主题 + 正文），发送时重算比对。
 *
 * **P0-2 Gmail 成功、本地记录失败 → 重试时双发。**
 * 原先只有两态（有 `sent_at` / 没有），而"没有 sent_at"**证明不了**"没发过"。
 * 修法：三态 —— 发送前落"结果未知"标记，成功才清；带标记时**绝不自动重发**。
 *
 * ## 为什么这些用例必须存在
 *
 * 两处修复都在"出事了才知道"的那条路上，而项目对这类代码的要求是
 * **断言必须被证明会失败**。所以这个文件里的每一条都对应一个**具体的历史缺陷**，
 * 而不是"测一下函数能跑"。
 *
 * 写到临时目录（`ASSISTANT_CONFIRM_DIR` 覆盖），**不碰真实确认记录**。
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ★ 必须在 import mail-send.mjs **之前**设好 —— 那个模块在加载时读它
const CONFIRM = mkdtempSync(path.join(tmpdir(), 'send-gates-'));
process.env.ASSISTANT_CONFIRM_DIR = CONFIRM;
// 心跳间隔调短，否则测它要等 20 秒（而"等 20 秒"的测试最终会被人删掉）。
// 这里验的是**续期这件事**，不是那个具体数字 —— 数字由代码里的默认值负责。
process.env.ASSISTANT_SEND_HEARTBEAT_MS = '80';

const {
  payloadHash,
  bodyHash,
  writeConfirm,
  readConfirm,
  confirmPath,
  writeSendMarker,
  readSendMarker,
  clearSendMarker,
  sendMarkerPath,
  acquireSendLock,
  releaseSendLock,
  sendLockPath,
  startSendLockHeartbeat,
} = await import('./mail-send.mjs');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = c(31);
const green = c(32);
const dim = c(2);
const bold = c(1);

let bad = 0;
let n = 0;
function t(name, got, expect) {
  n++;
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  console.log(`  ${ok ? green('✓') : red('✗')} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expect)}\n      得到 ${JSON.stringify(got)}`}`);
  if (!ok) bad++;
}

/** 造一份草稿对象，形状与 mail-send.mjs 里 readDraft 返回的一致。 */
const draftOf = (to, subject, body) => ({
  fm: { to, subject },
  body,
  fmText: `to: ${to}\nsubject: ${subject}`,
  path: path.join(CONFIRM, 'fake-draft.md'),
  header: '',
  tail: '',
});

console.log(`\n${bold('发信闸门回归测试')}\n`);

// ── 一、载荷摘要 ──────────────────────────────────────────────
console.log(`  ${dim('一、完整载荷摘要（P0-1 的地基）')}`);

t(
  '相同内容 → 相同摘要',
  payloadHash({ to: 'a@b.com', subject: 's', body: 'hello' }),
  payloadHash({ to: 'a@b.com', subject: 's', body: 'hello' })
);
t(
  '**改收件人 → 摘要必须变**（这条就是那个 P0）',
  payloadHash({ to: 'a@b.com', subject: 's', body: 'x' }) !== payloadHash({ to: 'evil@b.com', subject: 's', body: 'x' }),
  true
);
t(
  '改主题 → 摘要必须变',
  payloadHash({ to: 'a@b.com', subject: 's1', body: 'x' }) !== payloadHash({ to: 'a@b.com', subject: 's2', body: 'x' }),
  true
);
t(
  '改正文 → 摘要必须变',
  payloadHash({ to: 'a@b.com', subject: 's', body: 'x1' }) !== payloadHash({ to: 'a@b.com', subject: 's', body: 'x2' }),
  true
);
t(
  '只改排版（空白）→ 摘要**不变**（不该因为多一个空格就打回）',
  payloadHash({ to: 'a@b.com', subject: 's', body: 'a  b\n\nc' }),
  payloadHash({ to: 'a@b.com', subject: 's', body: 'a b c' })
);
t(
  '收件人两侧空白不算改动',
  payloadHash({ to: '  a@b.com  ', subject: 's', body: 'x' }),
  payloadHash({ to: 'a@b.com', subject: 's', body: 'x' })
);
t('收件人大小写**算**改动（地址大小写不该假装等价，宁可多问一次）',
  payloadHash({ to: 'A@b.com', subject: 's', body: 'x' }) !== payloadHash({ to: 'a@b.com', subject: 's', body: 'x' }),
  true
);

// ── 二、确认记录里存了什么 ────────────────────────────────────
console.log(`  ${dim('二、确认记录（闸门 2 的凭据）')}`);

const d1 = draftOf('alice@example.com', '你好', '正文一');
const rec1 = writeConfirm('case-1', d1, 'test');

t('确认记录存了完整载荷摘要', typeof rec1.payload_sha256 === 'string' && rec1.payload_sha256.length, 64);
t('确认记录存了"当时确认的收件人"', rec1.agreed_to, 'alice@example.com');
t('确认记录存了"当时确认的主题"', rec1.agreed_subject, '你好');
t('仍然保留旧字段（事后核对用）', typeof rec1.body_sha256, 'string');
t('记录真的落盘了', existsSync(confirmPath('case-1')), true);
t('读回来与写进去一致', readConfirm('case-1').payload_sha256, rec1.payload_sha256);

// 核心断言：同一份草稿重算 → 一致
t(
  '同一份草稿重算摘要 → 与记录一致（能通过闸门）',
  payloadHash({ to: d1.fm.to, subject: d1.fm.subject, body: d1.body }) === rec1.payload_sha256,
  true
);

// ★ 这就是 P0-1：改了收件人之后，闸门必须拦住
const d1Hijacked = draftOf('attacker@evil.com', '你好', '正文一');
t(
  '★ 改了收件人 → 与记录的摘要**不一致**（闸门 2 会拒绝）',
  payloadHash({ to: d1Hijacked.fm.to, subject: d1Hijacked.fm.subject, body: d1Hijacked.body }) === rec1.payload_sha256,
  false
);
t(
  '★ 改收件人时，旧字段（正文摘要）**照样一致** —— 这正说明只比正文拦不住',
  bodyHash(d1Hijacked.body) === rec1.body_sha256,
  true
);

// 旧格式记录：只覆盖正文
writeFileSync(
  confirmPath('case-legacy'),
  JSON.stringify(
    {
      draft: 'case-legacy',
      confirmed_at: '2026-09-01T00:00:00.000Z',
      via: 'cli',
      body_sha256: bodyHash('老正文'),
      body_chars: 3,
      body_preview: '老正文',
    },
    null,
    2
  ),
  'utf8'
);
const legacy = readConfirm('case-legacy');
t('旧格式记录读得出来（不炸）', typeof legacy.body_sha256, 'string');
t('★ 旧格式记录**没有** payload_sha256 —— 发送路径据此拒绝（无法证明收件人）', legacy.payload_sha256, undefined);

// ── 三、三态标记（P0-2）─────────────────────────────────────
console.log(`  ${dim('三、"结果未知"三态（P0-2）')}`);

t('一开始没有标记（= 没发过）', readSendMarker('case-2'), null);
t('标记文件也不存在', existsSync(sendMarkerPath('case-2')), false);

const m1 = writeSendMarker('case-2', rec1.payload_sha256);
t('★ 发送前写标记 → 标记存在', existsSync(sendMarkerPath('case-2')), true);
t('标记里存了当时的载荷摘要', m1.payload_sha256, rec1.payload_sha256);
t('标记里存了 pid（便于判断是谁留下的）', typeof m1.pid, 'number');

const back = readSendMarker('case-2');
t('★ 读得回来 —— 发送路径据此拒绝自动重发', back.payload_sha256, rec1.payload_sha256);

// 标记与草稿是同一封 → 必须停
t(
  '★ 同一封草稿 + 有标记 → 判定为"结果未知"（发送路径会拒绝）',
  back.payload_sha256 === payloadHash({ to: d1.fm.to, subject: d1.fm.subject, body: d1.body }),
  true
);

// 标记与现在的草稿不是同一封 → 也必须停（但理由不同）
const d2 = draftOf('bob@example.com', '另一封', '正文二');
t(
  '★ 草稿改过 + 有标记 → 也停下（标记属于另一封信）',
  back.payload_sha256 === payloadHash({ to: d2.fm.to, subject: d2.fm.subject, body: d2.body }),
  false
);

clearSendMarker('case-2');
t('★ 人工核查后清标记 → 标记消失（可以重发）', existsSync(sendMarkerPath('case-2')), false);
t('清掉之后读回来是 null', readSendMarker('case-2'), null);

// 损坏的标记必须当成"有标记"，不能当成没有
writeFileSync(sendMarkerPath('case-3'), '{ 这不是 JSON', 'utf8');
const broken = readSendMarker('case-3');
t('★ 标记文件损坏 → 仍然算"有标记"（宁可多问一次，不能当它不存在）', broken !== null, true);
t('损坏时带 unreadable 标记', broken.unreadable, true);
clearSendMarker('case-3');

// ── 四、发送锁与心跳（P1）───────────────────────────────────
console.log(`  ${dim('四、发送锁的心跳（P1：锁超时不再等于"进程死了"）')}`);

const lock1 = acquireSendLock('case-4');
t('第一次拿锁 → 拿到', lock1.acquired, true);
const lock2 = acquireSendLock('case-4');
t('同一封再拿 → 拒绝（互斥生效）', lock2.acquired, false);
t('拒绝时带 holder 信息供人看', typeof lock2.reason, 'string');

// 把锁的 mtime 装老到超过 STALE（120 秒）→ 会被当成陈旧
const old = new Date(Date.now() - 200_000);
utimesSync(sendLockPath('case-4'), old, old);
const lock3 = acquireSendLock('case-4');
t('锁陈旧（>120 秒没动过）→ 允许接管', lock3.acquired, true);

// 心跳：拿到锁之后续期，mtime 会被推新 —— 于是"看着陈旧"只说明进程真死了
writeFileSync(sendLockPath('case-4'), `pid ${process.pid} @ test`, { flag: 'w' });
const stale = new Date(Date.now() - 200_000);
utimesSync(sendLockPath('case-4'), stale, stale);
const beforeHeartbeat = statSync(sendLockPath('case-4')).mtimeMs;

const stop = startSendLockHeartbeat('case-4');
t('心跳启动返回 stop 函数', typeof stop, 'function');

// ★ 等一个心跳周期，验证 mtime **真的被推新了**。
//   不这么测的话，"续期"这条修复等于没被验证过 —— 而它正是 P1 的全部内容。
await new Promise((r) => setTimeout(r, 200));
const afterHeartbeat = statSync(sendLockPath('case-4')).mtimeMs;
t('★ 心跳真的把锁的 mtime 推新了（续期生效）', afterHeartbeat > beforeHeartbeat, true);
t(
  '★ 续期后锁不再"陈旧" —— 另一个进程不会误判成"进程死了"',
  Date.now() - afterHeartbeat < 120_000,
  true
);
stop();
releaseSendLock('case-4');
t('释放之后锁没了', existsSync(sendLockPath('case-4')), false);

// ── 清理 ──────────────────────────────────────────────────────
rmSync(CONFIRM, { recursive: true, force: true });

console.log('');
if (bad) {
  console.log(`${red('✗')} ${bad}/${n} 项不通过\n`);
  process.exit(1);
}
console.log(`${green('✓')} 全部通过（${n} 项）\n`);
