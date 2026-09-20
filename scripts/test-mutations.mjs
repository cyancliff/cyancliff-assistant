#!/usr/bin/env node
/**
 * test-mutations.mjs — 证明 test-feishu.mjs 的断言真的在检查什么
 *
 * ── 为什么需要这个 ──────────────────────────────────────────────
 * 这个项目里已经五次撞上"断言恒真"：看着像检查、其实两个分支相同，
 * 或者只检查了报告值没检查实际行为。最近一次就在本文件旁边 ——
 * 我用 `includes('p')` 检查"按钮里不含正文"，而 `"action":"preview"`
 * 里本来就有 p，恒真。
 *
 * 唯一的发现办法是**故意破坏代码，看测试会不会报**。
 * 所以把这件事做成脚本，而不是靠"这次我记得手动试一下"。
 *
 * ── 安全性 ────────────────────────────────────────────────────
 * 每个突变都在 try/finally 里还原，并且还原后**逐字节核对**内容一致。
 * 还原失败会立刻大声报错并停下 —— 绝不留下改坏的文件。
 * 运行前会检查工作区是否干净（有未提交改动就拒绝跑，免得把正常改动弄丢）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TEST = path.join(HERE, 'test-feishu.mjs');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const green = c(32), red = c(31), yellow = c(33), dim = c(2), bold = c(1);

/**
 * 每个突变：把 find 换成 replace，然后**期待测试失败**。
 * 若测试仍然全绿，说明那条断言是假的 —— 这正是我们要找的东西。
 */
const MUTATIONS = [
  {
    name: '权限：不检查发送者是不是主人',
    file: 'feishu-policy.mjs',
    find: 'if (sender !== owner) return { decision: DECISION.NOT_OWNER, senderOpenId: sender };',
    replace: 'if (false) return { decision: DECISION.NOT_OWNER, senderOpenId: sender };',
    why: '谁都能用 bot —— 这是最严重的一种',
  },
  {
    name: '权限：群聊也处理',
    file: 'feishu-policy.mjs',
    find: "if (norm(chatType) !== 'p2p') return { decision: DECISION.NOT_DM };",
    replace: 'if (false) return { decision: DECISION.NOT_DM };',
    why: '群里任何人都能命令它',
  },
  {
    name: '权限：owner 没配也放行',
    file: 'feishu-policy.mjs',
    find: "if (!owner) return { decision: DECISION.CLAIM, senderOpenId: sender };",
    replace: 'if (!owner) return { decision: DECISION.ALLOW };',
    why: '默认信任 —— 谁先发消息谁就是主人',
  },
  {
    name: '卡片：按钮不带 callback 行为',
    file: 'feishu-card.mjs',
    find: "behaviors: [{ type: 'callback', value }],",
    replace: 'behaviors: [],',
    why: '按钮点了没反应 —— 整个交互方案失效',
  },
  {
    name: '卡片：按钮 value 里塞进正文',
    file: 'feishu-card.mjs',
    find: 'button({ text: \'确认发送\', value: { action: ACTION.CONFIRM, id }, type: \'primary\' }),',
    replace: 'button({ text: \'确认发送\', value: { action: ACTION.CONFIRM, id, leak: preview }, type: \'primary\' }),',
    why: '正文会随卡片往返、进日志',
  },
  {
    name: '卡片：markdown 不转义',
    file: 'feishu-card.mjs',
    find: ".replace(/[`*_~[\\]]/g, (ch) => `\\\\${ch}`)",
    replace: '.replace(/[\\u0000]/g, (ch) => ch)',
    why: '邮件主题里的 ** 能把卡片排版搅乱，甚至伪造出类似系统提示的块',
  },
  {
    name: '命令：不带斜杠的话也当命令',
    file: 'feishu-commands.mjs',
    find: "if (!raw.startsWith('/')) return { kind: 'none' };",
    replace: "if (false) return { kind: 'none' };",
    why: '闲聊会被当成命令执行',
  },
  {
    name: '命令：参数不全也当命令',
    file: 'feishu-commands.mjs',
    find: `  if (cmd.args.length && args.length === 0) {
    return { kind: 'help', reason: \`\\\`/\${cmd.name}\\\` 要带参数。用法：\\\`\${usageOf(cmd)}\\\`\` };
  }`,
    replace: '  if (false) { /* 突变：不检查参数 */ }',
    why: '`/稿` 不带 id 会往下走成 undefined',
  },
  {
    name: '锁：拿不到也当拿到了',
    file: 'mail-send.mjs',
    find: "    if (ageMs < SEND_LOCK_STALE_MS) {\n      return { acquired: false, reason: 'busy', holder, ageMs };\n    }",
    replace: '    // 突变：忽略已有锁',
    why: '并发下会发两封 —— 这正是加锁要防的',
  },
  {
    name: '锁：陈旧的锁不接管',
    file: 'mail-send.mjs',
    find: "    rmSync(lock, { force: true }); // 陈旧 → 清掉重来",
    replace: "    return { acquired: false, reason: 'busy', holder: 'stale-never-cleared' };",
    why: '进程崩一次就永久卡住，再也发不出去',
  },
  {
    name: '核心：确认时不走锁',
    file: 'feishu-core.mjs',
    find: 'const locked = await ports.withSendLock(id, async () => {',
    replace: 'const locked = await (async (f) => ({ acquired: true, value: await f() }))(async () => {',
    why: '连点两次按钮会发两封 —— 锁就是为这个加的',
  },
  {
    name: '核心：锁内不重读草稿状态',
    file: 'feishu-core.mjs',
    find: "      if (draft?.fm?.sent_at) return { ok: false, reason: 'already-sent', sentAt: draft.fm.sent_at };",
    replace: '      // 突变：锁内不重读',
    why: '等锁期间别人已经发掉了，这里不查就会再发一封',
  },
  {
    name: '核心：非主人也执行',
    file: 'feishu-core.mjs',
    find: '    if (!allowsAction(d.decision)) {\n      log(`拒绝消息：${d.decision}`);',
    replace: '    if (false) {\n      log(`拒绝消息：${d.decision}`);',
    why: '权限判定形同虚设',
  },
  {
    name: '核心：闲聊也往下走',
    file: 'feishu-core.mjs',
    find: "    if (parsed.kind === 'none') {",
    replace: '    if (false) {',
    why: '不是命令的话会被当成命令处理',
  },
  {
    name: '退出清理：不在 reallyExit 之前跑',
    file: 'proxy.mjs',
    find: '    for (const fn of exitCleanups) {',
    replace: '    for (const fn of []) {',
    why: '所有退出的兜底清理都失效（发送锁就是这么漏的）—— 只有子进程测试能发现',
  },
  {
    name: '核心：确认时同步等发信完成',
    file: 'feishu-core.mjs',
    find: "    return { decision: DECISION.ALLOW, acted: true, command: 'confirm', id, pending: true, done };",
    replace: "    return { ...(await done), pending: false, done: Promise.resolve() };",
    why: '超飞书的 3 秒回调限制 → 重推 → 卡片被重置（实测踩过：邮件发出去了但卡片不变绿）',
  },
  {
    name: '邮件头：非 ASCII 不做 RFC 2047 编码',
    file: 'mail-send.mjs',
    find: "  if (!/[^\\x20-\\x7e]/.test(s)) return s;",
    replace: '  return s;',
    why: '中文主题变成 Re: Ã©Â£ÂžÃ¤Â¹Â¦ bot ...（实测踩过；只有发出去才看得见）',
  },

  // ── 以下是 2026-09-19 加的：**三个原先没有任何突变覆盖的文件**
  //
  // 外部审查指出：`mail-important.mjs` / `mail-classify.mjs` / `workflow.mjs`
  // 的自测看起来"有 21 项"，但**没有任何已提交的机制证明过那些断言会失败**。
  // 下面每一条都对应一个真实的历史缺陷，不是随便改一行。
  {
    name: '漏斗：升级词不再优先（放回噪声之后）',
    file: 'mail-important.mjs',
    test: 'mail-important.mjs',
    testArgs: ['--self-test'],
    find: `  const escalated = ESCALATE.find((e) => e.re.test(subject));
  if (escalated) {`,
    replace: `  const escalated = false ? ESCALATE.find((e) => e.re.test(subject)) : null;
  if (escalated) {`,
    why: '这条顺序自测逼了两次：先是被例行的"账号…删除"吃掉，再是被噪声判据吃掉。改回去 → "账号将被永久删除"重新变成 ignore，而那是丢账号级别的漏报',
  },
  {
    name: '漏斗：批量地址也给生成回复',
    file: 'mail-important.mjs',
    test: 'mail-important.mjs',
    testArgs: ['--self-test'],
    find: '  if (!bulk) {',
    replace: '  if (true) {',
    why: '那个硬闸门防的是"自动回复变成对营销信、甚至对密码重置信的回信"',
  },
  {
    name: '漏斗：没有历史就一律推（不区分机器发的）',
    file: 'mail-important.mjs',
    test: 'mail-important.mjs',
    testArgs: ['--self-test'],
    /**
     * **这条原先打的是死代码**（2026-09-20 修正）。
     *
     * 原来的写法把 `if (bulk) { …第一次见到这个机器发件人… }` 整段替换掉。
     * 但那段写在 `if (!bulk) { … }` 里面 —— 恒假、不可达。于是这条突变
     * **等价于什么都没改**，任何测试都不可能抓住它。表现是突变测试永远报
     * `22/23 被抓住`，而这道门正好是 CI 的第一步：**CI 从第一次跑起就是红的。**
     *
     * 现在改打真正活着的那个闸门：把"批量地址一律不生成回复"的守卫拿掉。
     * 用基准集里那条 `no-reply@` + 无历史 + 标题在要求回复的用例来抓它 ——
     * 那一封在 `asks` 分支出结果，正是这条守卫决定的。
     */
    find: '  if (!bulk) {\n    const asks = ASKS_REPLY.find((a) => a.re.test(subject));',
    replace: '  if (true) {\n    const asks = ASKS_REPLY.find((a) => a.re.test(subject));',
    why: '接进真数据时抓到的：Anthropic 的营销信被判 high + "要回"，9 封里 6 封 high —— 通知疲劳原样搬回来。这条闸门就是防它的：批量地址哪怕标题写着"请确认"，也不给生成回复',
  },
  {
    name: '漏斗：判噪声就直接丢掉（不看有没有证据）',
    file: 'mail-important.mjs',
    test: 'mail-important.mjs',
    testArgs: ['--self-test'],
    find: '    const enough = bulk ? history && history.senderTotal >= 2 : historySaysRoutine;',
    replace: '    const enough = false;',
    why: '"噪声"不等于"可以丢"：没有"你不在乎这一类"的证据时应当攒进汇总而不是忽略',
  },
  {
    name: '编排：拟稿失败的邮件下轮不再重试',
    file: 'workflow.mjs',
    test: 'workflow.mjs',
    testArgs: ['--self-test'],
    find: '  const toPrepare = [...new Set([...fetch.fresh, ...pending])];',
    replace: '  const toPrepare = fetch.fresh;',
    why: '外部审查发现的 P1：取信那一步已经记进 seen 了，于是第一轮拟稿失败 = 永久跳过。症状是"偶发丢信"，不报错也不重试',
  },
  {
    name: '编排：阶段可以倒退（重复打扰用户）',
    file: 'mail-fetch.mjs',
    test: 'workflow.mjs',
    testArgs: ['--self-test'],
    find: '  if (STAGES.indexOf(stage) <= STAGES.indexOf(stageOf(seen, id))) return false;',
    replace: '  if (false) return false;',
    why: '允许倒退会让已 notified 的退回 drafted，下一轮再推一次给用户。这条原先漏掉，是因为自测里**没有一条直接测 advanceStage 的顺序** —— 现在补了',
  },
];

// ── 前置：工作区必须干净 ──────────────────────────────────────
function assertClean() {
  const out = execFileSync('git', ['status', '--porcelain', '--', 'scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  if (out) {
    console.error(`\n  ${red('✗')} scripts/ 下有未提交的改动，拒绝跑突变测试（怕把正常改动弄丢）：\n`);
    console.error(out.split('\n').map((l) => `      ${l}`).join('\n'));
    console.error(`\n    ${dim('先提交或 stash，再跑。')}\n`);
    process.exit(2);
  }
}

function runTests() {
  try {
    execFileSync(process.execPath, [TEST], { cwd: ROOT, stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    return { ok: false, output: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

/**
 * **按突变自己的靶子跑测试**（2026-09-19 加）。
 *
 * ## 为什么需要
 *
 * 原先只有一个 `TEST = test-feishu.mjs`，于是**所有突变都只对着飞书模块**。
 * 外部审查指出：`mail-important.mjs` / `mail-classify.mjs` / `workflow.mjs`
 * 这三个文件**没有任何机制做过突变验证** —— 而它们的自测看起来"有 21 项"，
 * 却没人证明过那些断言会失败。
 *
 * 现在每个突变可以自带 `test` 字段（跑哪个自测）；不带就仍用默认的飞书那套
 * （那 17 个突变是针对它的，改掉它们的靶子会让它们全部失效）。
 */
function runTestsFor(m) {
  const target = m.test ? path.join(HERE, m.test) : TEST;
  const args = m.testArgs || [];
  try {
    execFileSync(process.execPath, [target, ...args], { cwd: ROOT, stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    return { ok: false, output: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

assertClean();

console.log(`\n${bold('突变测试')} ${dim('—— 故意破坏代码，看测试抓不抓得住')}`);
console.log(dim(`  ${MUTATIONS.length} 个突变\n`));

let caught = 0;
let missed = [];
let restoreFailed = [];

for (const m of MUTATIONS) {
  const file = path.join(HERE, m.file);
  const original = readFileSync(file, 'utf8');

  if (!original.includes(m.find)) {
    console.log(`  ${yellow('⚠')} ${m.name}`);
    console.log(`      ${dim(`找不到要替换的片段 —— 代码变了，这个突变已经过期：`)}`);
    console.log(`      ${dim(m.file)}`);
    missed.push({ ...m, reason: 'pattern-not-found' });
    continue;
  }

  try {
    writeFileSync(file, original.replace(m.find, m.replace), 'utf8');
    const r = runTestsFor(m);

    if (!r.ok) {
      caught++;
      console.log(`  ${green('✓')} 抓住：${m.name}`);
      console.log(`      ${dim(m.why)}`);
    } else {
      missed.push(m);
      console.log(`  ${red('✗')} 漏掉：${m.name}`);
      console.log(`      ${dim(`破坏了这一点，测试却全绿 —— 说明没有断言在检查它`)}`);
      console.log(`      ${dim(m.why)}`);
    }
  } finally {
    writeFileSync(file, original, 'utf8');
    const back = readFileSync(file, 'utf8');
    if (back !== original) {
      restoreFailed.push(m.file);
      console.log(`  ${red('✗✗')} 还原失败：${m.file} —— 立刻停下`);
      break;
    }
  }
}

console.log('');
if (restoreFailed.length) {
  console.log(`  ${red('✗✗')} 有文件没还原成功，已中止：${restoreFailed.join(', ')}\n`);
  process.exit(3);
}

if (missed.length === 0) {
  console.log(`  ${green('✓')} ${caught}/${MUTATIONS.length} 个突变全部被抓住 —— 断言不是恒真的\n`);
  process.exit(0);
} else {
  console.log(`  ${red('✗')} ${caught}/${MUTATIONS.length} 被抓住，${missed.length} 个漏掉：`);
  for (const m of missed) console.log(`      ${m.name}`);
  console.log('');
  process.exit(1);
}
