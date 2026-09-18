#!/usr/bin/env node
/**
 * mail-important.mjs — 判断一封邮件重不重要、要不要回复
 *
 *   node scripts/mail-important.mjs --self-test        # 用基准集自测（不需要凭据）
 *   node scripts/mail-important.mjs --fixture         # 打印基准集里每一封的判定
 *   node scripts/mail-important.mjs --explain <json>  # 解释单封（调试判据用）
 *
 * ## 它为什么存在
 *
 * `mail-triage.mjs` 的规则分类**不能直接拿来做"重要的才推给我"** ——
 * 2026-09-19 实测：45 封未读里它判"需动作 25 封"，其中 **17 封是例行登录提醒**
 * （Google/Mozilla/xAI），真正值得打断用户的只有 1 封（`Your account has been suspended`）。
 * 照它推送，手机上 25 条里 24 条是废话。
 *
 * 问题不在阈值，在**判据**：那 11 封 `安全提醒` 与那 1 封 `账号被停用`
 * 在规则层是**同一个信号、同一个权重**。要分开它俩只能看内容。
 *
 * ## 三层漏斗
 *
 *   ① 规则层（mail-classify.mjs 的信号表）
 *        明确噪声 → 直接 ignore（营销、通讯、社交推送）
 *        明确信号 → 继续 ②
 *   ② 升级/例行层（本文件的核心）
 *        **升级词**：账号被停用/删除/关闭、未授权、欠费、未知设备、首次登录 …
 *                    → high，**压过**例行的降权
 *        **例行的特征**：批量地址 + 同类发件人多次 + 你从未处置过
 *                    → 降一级（signal → digest；digest 且无动作要求 → ignore）
 *   ③ 历史层（buildSenderStats）
 *        同类发件人的历史量 + 你读过没有 + 你回过没有
 *
 * **模型层不在这一版里**（见 PLAN-MAIL-TRIAGE-AUTO.md 阶段 1）。这里只做规则与历史：
 * 它们免费、可自测、可解释，而且实测的基线已经证明"例行 vs 升级"这个区分
 * 大部分能靠规则做掉。模型该处理的是剩下的含糊的一部分，不是全部。
 *
 * ## 一个诚实的边界：历史层的可信度依赖你的行为
 *
 * 「同类发件人发了 N 封、你一封都没读过」被当作例行 —— **但"你没读"不等于"不重要"**，
 * 可能只是没空看。而现在这个邮箱有 217 封未读，所以这个信号目前**大部分是缺失的**。
 * 因此这一版只把它当**降权项**、不当判据：它能压掉"第 11 封例行登录提醒"，
 * 但压不掉一个真正重要的东西（升级词永远优先）。
 *
 * ## 绝对不做的事
 *
 * - **不判断正文。** 输入只有主题与发件人（历史层用元数据）。要看正文得先解决
 *   提示注入问题（见 PLAN-MAIL-TRIAGE-AUTO.md §2.5），那是另一件事。
 * - **不发送任何东西、不替你做决定。** 输出是"候选"，每条都带理由。
 * - **不给批量地址生成回复。** `needsReply` 对批量发件人一律 false ——
 *   哪怕它的标题在要求你回复。这是防止"自动回复变成对营销信的回信"的第一道闸。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, senderAddress, isBulkSender, looksAutomated } from './mail-classify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PRIVATE = path.join(ROOT, 'Personal Memory');
const MAIL_DIR = path.join(PRIVATE, 'data', 'mail');
const FIXTURE = path.join(HERE, 'fixtures', 'mail-importance-cases.json');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const red = c(31);
const green = c(32);
const yellow = c(33);
const cyan = c(36);
const dim = c(2);
const bold = c(1);

// ── 判据表 ────────────────────────────────────────────────────
/**
 * **升级词**：出现它，就压过例行的降权。
 *
 * 这张表是从实测里长出来的：那 11 封例行登录提醒与那 1 封
 * `Your account has been suspended` 在信号层完全一样，差别只在这里。
 *
 * 加词时的规矩：**只加"必须立刻知道"的**。加了"提醒""注意"这类泛词，
 * 这张表就退化成信号表，等于没做。
 */
export const ESCALATE = [
  { re: /suspended|被停用|已被停|账户被?冻结|冻结了/i, why: '账号被停用 —— 可能直接失去服务' },
  {
    // 语序有两种：中文常说"账号将在 N 天后被删除"，英文是"account will be deleted"。
    // 第一版只写了"删除账号"，于是那条真实用例**没被升级词抓住**（自测报的就是它）。
    // 第二版仍然漏了"被永久删除"（动词被"永久"隔开）—— 所以这里允许中间有少量字符。
    // 第三版的问题是**它反过来吃掉了自己**：这一条同时命中例行判据
    // （"账号…删除"本来是用来防恐吓营销的），于是真通知被降权成 ignore。
    // 所以升级检查现在排在例行之前（见 judgeImportance 的顺序说明）。
    re: /(账号|账户)[^。]{0,24}(删除|注销|关闭|清空)|(删除|注销|关闭|清空)[^。]{0,6}(账号|账户)|account (will be )?(deleted|closed|terminated)|(deleted|closed|terminated)[^.]{0,10}account/i,
    why: '账号将被删除/注销',
  },
  { re: /未授权|未经授权|unauthorized|not you|不是您本人|盗用|hacked|compromised/i, why: '有人可能在用你的账号' },
  {
    // 登录提醒分两种，这条区分是实测数据的核心：
    //   「安全提醒」×11（例行，你从没理过）  vs  「来自未知设备」（异常）
    // 所以升级词只认**具体到"异常"的措辞**，不认"新的登录活动"这句话本身。
    re: /未知(设备|位置)|unrecognized|unknown (device|location)|新设备|首次登录|first (sign-?in|login)/i,
    why: '从未见过的设备/位置登录（不是又一次例行登录）',
  },
  { re: /欠费|余额不足|服务(将在|即将)?(暂停|中断)|overdue|payment (failed|declined)/i, why: '服务要停了' },
  { re: /安全(漏洞|事件)|数据泄露|breach|security alert/i, why: '安全事件' },
];

/**
 * **例行通知的特征**：批量地址，且主题是"又一次同一件事"。
 *
 * 注意它只用于**降权**，不用于判定"不重要" —— 真正的升级词优先。
 * 这条区分是这批数据里最重要的一个判断：17 封里 16 封该压掉，第 17 封不能压。
 */
export const ROUTINE = [
  { re: /安全提醒|新的登录活动|new (sign-?in|login)|login (alert|notification)|登录提醒/i, why: '又一次登录通知' },
  { re: /verification code|验证码|your code|one-?time (code|password)|otp/i, why: '验证码（有时效，转发无意义）' },
  { re: /receipt|invoice|收据|发票|账单|payment received|已支付|订单(号|已)/i, why: '收据/账单留档' },
  { re: /(权限|功能|服务)(已|现已)?开通|开通成功|已生效|now available|has been enabled/i, why: '一次性开通通知' },
  {
    // 产品宣发：标题像一个技术建议，其实是劝你用它。
    // 实测撞过：OpenRouter 那封的标题里有 "rate limit"，被规则层当成「额度告警」。
    re: /one parameter|why your|how to (fix|stop|avoid)|tips? for|best practices?|guide to|教你|如何(避免|解决)|stops? .{0,20}from failing/i,
    why: '产品宣发/技术软文（标题像建议）',
  },
];

/**
 * **例行通知的加强版**：批量地址 + 你从未理过它。
 *
 * 这一档直接 ignore。与上一档的区别是**证据更强**：
 * 「安全提醒」你收到 11 封一封没读，那不是"暂时没空"，是这一类你不在乎。
 *
 * 但这一档**极易误伤** —— 它必须排在升级词之后（见 judgeImportance 的顺序说明）。
 */
export const ROUTINE_WITH_HISTORY = [
  {
    re: /^安全提醒$|^安全提醒[：:]|^new (sign-?in|login)$|^your (sign-?in|login)/i,
    why: '极简的例行登录通知（标题里没有任何具体信息）',
  },
];

/** 主题里出现这些 → 对方在等你回话。**批量地址除外**（见 needsReply 的闸门）。 */
const ASKS_REPLY = [
  { re: /请(确认|回复|答复|签名|签字)|需要你(确认|回复|提供|操作)|等你(回|确认)|麻烦你/i, why: '对方明确要求你回应' },
  { re: /please (confirm|reply|respond|review|sign|advise)|action required|your (input|response) is (needed|required)/i, why: '对方明确要求你回应（英文）' },
  { re: /[?？]\s*$/i, why: '主题以问号结尾' },
  {
    // 真人用陈述句说明一件事时，往往也是要回话的（"下周组会的时间"= 你什么时候有空）。
    // 这条会带来误报，所以它**排在最后**，且只在发件人是人时才算数。
    re: /(时间|安排|计划|组会|会议|见面|答辩|面谈|讨论|商量)/i,
    why: '主题涉及安排/时间（通常是等你定）',
  },
];

// ── 历史层 ────────────────────────────────────────────────────
/**
 * 从已取回的邮件里统计"同类发件人的历史"。
 *
 * 只用**元数据**（from / labels），不读正文 —— 所以它不需要额外凭据，
 * 也不会把正文里的东西带进判断。
 *
 * `senderReplied` 目前恒为 0：判断"你回过谁"要看 Gmail 的 SENT 标签或同线程去信，
 * 那需要**另一次 API 调用**，这一版没做。**所以这个字段现在是占位的** ——
 * 写出来是为了让接口固定，而不是假装它已经有值。**别拿它当判据。**
 *
 * @returns {Map<string, {senderTotal:number, senderUnread:number, senderReplied:number, seenDays:number[]}>}
 */
export function buildSenderStats(mailDir = MAIL_DIR) {
  const stats = new Map();
  if (!existsSync(mailDir)) return stats;

  for (const name of readdirSync(mailDir)) {
    if (!name.endsWith('.md')) continue;
    let text;
    try {
      text = readFileSync(path.join(mailDir, name), 'utf8');
    } catch {
      continue;
    }
    const fm = text.split('---')[1] || '';
    const from = (fm.match(/^from:\s*"?(.*?)"?\s*$/m) || [])[1] || '';
    if (!from) continue;
    const addr = senderAddress(from);
    if (!addr) continue;

    const s = stats.get(addr) || { senderTotal: 0, senderUnread: 0, senderReplied: 0, seenDays: [] };
    s.senderTotal++;
    if (/UNREAD/.test(fm)) s.senderUnread++;
    // 距今多少天（用于以后做时间衰减；这一版只记录不判）
    const dateStr = (fm.match(/^date:\s*"?(.*?)"?\s*$/m) || [])[1] || '';
    const t = Date.parse(dateStr);
    if (!Number.isNaN(t)) s.seenDays.push(Math.max(0, Math.round((Date.now() - t) / 86400000)));
    stats.set(addr, s);
  }
  return stats;
}

// ── 漏斗 ──────────────────────────────────────────────────────
/**
 * 给一封邮件判重要性与"要不要回"。
 *
 * @param {{subject:string, from:string}} mail
 * @param {{senderTotal:number, senderUnread:number, senderReplied:number, seenDays:number[]}|null} history
 *        null = 没有历史数据（第一次遇到）。**不能崩，也不能默认判重要。**
 * @returns {{importance:'high'|'digest'|'ignore', needsReply:boolean, why:string[]}}
 */
export function judgeImportance(mail, history = null) {
  const why = [];
  const subject = mail.subject || '';
  const from = mail.from || '';
  const labels = Array.isArray(mail.labels) ? mail.labels : null;
  const base = classify({ subject, from });
  /**
   * 「是不是机器发的」用两道判据（见 `looksAutomated`）：
   * 地址模式 + **Gmail 自己的分类标签**。
   * 只看地址会漏（`team@` 这种看着像人的群发地址），只看标签会在
   * 默认邮箱（根本不分类）上失效 —— 两者取或，且都拿不到时是"不知道"而非"不是"。
   */
  const bulk = looksAutomated(from, labels);
  const addr = senderAddress(from);
  /**
   * 「有证据说这一类你不在乎」：机器发的 + 收过至少 3 封 + 一封没读过。
   *
   * **刻意不只看"没读过"**：「你没读」不等于「不重要」，可能只是没空看。
   * **也刻意不只看"机器发的"**：机器发的信里也有重要的（那由升级词兜住）。
   * 两条同时成立才算有证据 —— 这个判据要提前算，因为噪声那一档也要用它。
   */
  const historySaysRoutine =
    history && history.senderTotal >= 3 && history.senderUnread === history.senderTotal;

  // ① 升级词 —— **排在所有降权判据之前**，包括噪声。
  //
  // 这个顺序是自测逼出来的，而且逼了两次：
  //
  //   第一次：例行的"账号…删除"（本来防恐吓营销）**吃掉了**真正的
  //           「您的账号将在 30 天后被永久删除」。
  //   第二次：把升级挪到例行之前之后，它**仍然被噪声判据吃掉** ——
  //           因为 `no-reply@` 让规则层判它噪声，而噪声是第一道出口。
  //
  // 两次是同一个错误：**降权判据之间的相对顺序，掩盖了"升级该不该最优先"这个问题。**
  // 现在写死成一条：撞在同一封信上时，**升级赢**。
  // 把重要的事推给用户，代价是多一条通知；把重要的事压掉，代价是丢账号。
  const escalated = ESCALATE.find((e) => e.re.test(subject));
  if (escalated) {
    why.push(`升级词：${escalated.why}`);
    if (base.kind === 'noise') why.push(`（规则层本来判它噪声：${base.noise.join('/')} —— 升级词压过了它）`);
    return { importance: 'high', needsReply: false, why };
  }

  // ② 规则层判了噪声 —— 但**"噪声"不等于"可以丢"**（这个项目的规矩）。
  //
  // 分两种处理，区别在**有没有证据**：
  //
  //   · 机器发的 + 你收过至少 3 封、一封没读过 → 有证据说这一类你不在乎 → 忽略
  //   · 其余（包括**完全没有历史**的）→ 攒进每日汇总，不打断你，也不悄悄丢掉
  //
  // 第二行是 2026-09-19 接进真数据之后补的：Anthropic 的营销信
  // （`team@email.anthropic.com`，Gmail 归 CATEGORY_UPDATES）原来会落到 ignore，
  // 而它此前**从没出现过** —— 拿"从没见过"当"不重要"是没有依据的。
  if (base.kind === 'noise') {
    why.push(`规则层判为噪声（${base.noise.join('/')}）`);
    /**
     * 「有证据说这一类你不在乎」——**分两档，因为两类发件人的门槛不一样**：
     *
     *   · 已经是机器发的：收过 ≥2 封、一封没读过就够了
     *     （对机器发件人本来就不指望你读，两封不理已经说明问题）
     *   · 不确定是不是机器发的：要 ≥3 封、一封没读过
     *     （地址猜"是不是机器"永远有漏网 —— `weekly@news.example.com` 就被漏了，
     *      所以不能把"机器"当必要条件，只能当**降低门槛**的理由）
     *
     * 两档都不满足 → 攒进每日汇总。**"没证据"不等于"不重要"**。
     */
    const enough = bulk ? history && history.senderTotal >= 2 : historySaysRoutine;
    if (enough && history.senderUnread === history.senderTotal) {
      why.push(`你收过 ${history.senderTotal} 封、一封没读过${bulk ? '（且是机器发的）' : ''} → 忽略`);
      return { importance: 'ignore', needsReply: false, why };
    }
    why.push('但没有"你不在乎这一类"的证据（历史不足）→ 攒进每日汇总，不丢');
    return { importance: 'digest', needsReply: false, why };
  }

  // ③ 例行通知 → 降权
  const routine = ROUTINE.find((r) => r.re.test(subject));

  if (routine) {
    const isCode = /验证码|verification code|your code|one-?time|otp/i.test(subject);
    why.push(`例行：${routine.why}`);
    if (historySaysRoutine) {
      why.push(`历史：同一发件人 ${history.senderTotal} 封、一封没读过`);
    }
    // 验证码有时效，转发没有意义 → 直接忽略
    if (isCode) return { importance: 'ignore', needsReply: false, why };
    // 你显然不在乎这一类 → 不打扰你。两个条件都要成立：
    //   ① 是机器发的（不是真人）  ② 你收过至少 3 封、一封没读过
    // **刻意不只看①**：机器发的信里也有重要的（那由升级词兜住）。
    // **也刻意不只看②**：「你没读」不等于「不重要」，可能只是没空看。
    const strongRoutine = ROUTINE_WITH_HISTORY.some((r) => r.re.test(subject.trim()));
    if (bulk && historySaysRoutine && strongRoutine) {
      why.push('标题里没有任何具体信息 + 机器发的 + 你多次没理 → 忽略');
      return { importance: 'ignore', needsReply: false, why };
    }
    return { importance: 'digest', needsReply: false, why };
  }

  // ④ 历史层：没有升级词、也没有例行的特征，但同类太多且从未处置 → 降一级
  if (historySaysRoutine && base.kind === 'signal') {
    why.push(`历史：同一发件人 ${history.senderTotal} 封、你一封没读过 —— 降一级（不是"不重要"，是"不打断你"）`);
    return { importance: 'digest', needsReply: false, why };
  }

  // ⑤ 要不要回复 —— **批量地址一律 false**，这是硬闸门
  let needsReply = false;
  let firstContact = false;
  if (!bulk) {
    const asks = ASKS_REPLY.find((a) => a.re.test(subject));
    const repliedBefore = history && history.senderReplied > 0;
    if (asks) {
      needsReply = true;
      why.push(`要回：${asks.why}`);
    } else if (repliedBefore) {
      needsReply = true;
      why.push('要回：你回过这个发件人（历史往来）');
    } else if (!history) {
      /**
       * 没有历史数据时的处理。
       *
       * **这里的第一版是错的，而且是接进真数据之后才发现的**（2026-09-19）：
       * 它原先无条件判"首次来信 → high + needsReply"，于是真扫一遍的结果是
       * Anthropic 的**营销信**（`team@email.anthropic.com`）被判 high 且"要回"。
       * 6/9 封 high，等于把通知疲劳原样搬了回来。
       *
       * 错因很简单：**"没有历史"不等于"是人写的"**。
       * 这个账户只取过一部分邮件，所以"没有历史"里混着大量机器发件人。
       *
       * 现在按发件人性质分两条路：
       *   · 机器发的 + 没历史 → 没有任何证据说它重要 → 攒进每日汇总
       *   · 人发的   + 没历史 → 这个邮箱里真人第一次写信是罕见事件，
       *                          漏掉的代价比多一条通知大 → 推，并且算"要回"
       */
      if (bulk) {
        why.push('第一次见到这个机器发件人 —— 没有证据说它重要，攒进汇总');
        return { importance: 'digest', needsReply: false, why };
      }
      needsReply = true;
      firstContact = true;
      why.push('第一次收到这个发件人的信（没有历史，且不是机器地址）→ 直接推给你，自己看一眼');
    }
  } else if (ASKS_REPLY.some((a) => a.re.test(subject))) {
    why.push('标题在要求回复，但发件人是批量地址 —— **不给它生成回复**');
  }

  // 重要性：有信号 / 要求回复 / 首次来信 → high；否则 digest
  if (base.kind === 'signal' || needsReply || firstContact) {
    why.push(
      base.kind === 'signal'
        ? `信号：${base.signals.join('/')}`
        : firstContact
          ? '首次来信'
          : '真人来信'
    );
    return { importance: 'high', needsReply, why };
  }

  why.push('没命中任何信号，也不是明确的例行通知');
  return { importance: 'digest', needsReply, why };
}

// ── 自测（用基准集，不需要凭据）─────────────────────────────
function selfTest() {
  console.log(`\n${bold('重要性漏斗自测（基准集）')}\n`);
  if (!existsSync(FIXTURE)) {
    console.error(`${red('✗')} 基准集不存在：${FIXTURE}`);
    process.exit(2);
  }
  const data = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  let bad = 0;

  for (const [i, cse] of data.cases.entries()) {
    const got = judgeImportance(cse.mail, cse.history);
    const okImp = got.importance === cse.expect.importance;
    const okRep = got.needsReply === cse.expect.needsReply;
    const ok = okImp && okRep;

    console.log(`  ${ok ? green('✓') : red('✗')} ${cse.mail.subject.slice(0, 46)}`);
    if (!ok) {
      bad++;
      console.log(
        `      ${red('期望')} importance=${cse.expect.importance} needsReply=${cse.expect.needsReply}`
      );
      console.log(
        `      ${red('得到')} importance=${got.importance} needsReply=${got.needsReply}`
      );
    }
    console.log(`      ${dim(cse.why)}`);
    if (ok) console.log(`      ${dim(`→ ${got.importance} · ${got.why.join('；')}`)}`);
  }

  console.log('');
  if (bad) {
    console.log(`${red('✗')} ${bad}/${data.cases.length} 项与基准不符\n`);
    process.exit(1);
  }
  console.log(`${green('✓')} 全部通过（${data.cases.length} 项）\n`);
  process.exit(0);
}

/** 打印基准集里每一封的判定（人看整体倾向用）。 */
function showFixture() {
  const data = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const counts = { high: 0, digest: 0, ignore: 0 };
  console.log(`\n${bold('基准集判定')}\n`);
  for (const cse of data.cases) {
    const got = judgeImportance(cse.mail, cse.history);
    counts[got.importance]++;
    const mark = got.importance === 'high' ? red('high  ') : got.importance === 'digest' ? yellow('digest') : dim('ignore');
    console.log(`  ${mark}  ${cse.mail.subject.slice(0, 50)}`);
    console.log(`          ${dim(got.why.join('；'))}`);
  }
  console.log(
    `\n  ${bold('合计')} high ${counts.high} · digest ${counts.digest} · ignore ${counts.ignore}（共 ${data.cases.length} 封）\n`
  );
}

const args = process.argv.slice(2);

/**
 * `--scan`：连 Gmail 扫未读，过漏斗，输出**判定结果**。
 *
 * ## 为什么要有它（2026-09-19 加，外部审查发现的 P1）
 *
 * 漏斗做完之后，**生产路径里没有任何人调用它** —— `feishu-bot.mjs` 的 `/取信`
 * 调的还是 `mail-triage.mjs`（只做标题/发件人规则），于是"25 封里 24 封是废话"
 * 的问题**一点没变**。判断改好了但没接上，等于没改。
 *
 * 这个模式是给程序用的接口（风格与 `mail-triage.mjs --json` 一致）：
 * **`--json` 时 stdout 必须是纯 JSON**，人看的一律走 stderr。
 * 这条规矩是踩过的：标题那行打在 JSON 前面，调用方 `JSON.parse` 直接失败，
 * 而报的是"没有返回 JSON"—— 完全指不出真正的原因是多了一行标题。
 */
async function scan() {
  const jsonMode = args.includes('--json');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) || 25 : 25;
  const say = (...a) => (jsonMode ? console.error(...a) : console.log(...a));

  // 动态 import：本文件的自测不该需要凭据或网络，而 gmail-auth 会读凭据文件
  const { gmailFetch, getEnv } = await import('./gmail-auth.mjs');

  const query = getEnv('GMAIL_TRIAGE_QUERY') || 'is:unread in:inbox';
  say(`\n${bold('重要性盘点')}  ${dim(query)}  上限 ${limit}\n`);

  let list;
  try {
    list = await gmailFetch(`/users/me/messages?maxResults=${limit}&q=${encodeURIComponent(query)}`);
  } catch (err) {
    console.error(`${red('✗')} 取信失败：${err.message}`);
    process.exit(1);
  }

  const ids = (list.messages || []).map((m) => m.id);
  if (!ids.length) {
    if (jsonMode) console.log(JSON.stringify({ scanned: 0, failed: 0, rows: [] }, null, 2));
    else console.log(dim('  没有匹配的邮件。\n'));
    process.exit(0);
  }

  // 历史层：只读已取回邮件的元数据，不额外调 API
  const stats = buildSenderStats();

  const rows = [];
  let failed = 0;
  for (const [i, id] of ids.entries()) {
    try {
      const d = await gmailFetch(
        `/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
      );
      const h = (n) => (d.payload.headers.find((x) => x.name === n) || {}).value || '';
      const from = h('From');
      const subject = h('Subject');
      // labelIds 是 Gmail 自己的分类，比关键词准 —— 拿它当"是不是机器发的"的第二道判据
      const verdict = judgeImportance(
        { subject, from, labels: Array.isArray(d.labelIds) ? d.labelIds : null },
        stats.get(senderAddress(from)) || null
      );
      rows.push({ id, subject, from, date: h('Date'), labels: d.labelIds || null, ...verdict });
    } catch (e) {
      failed++;
      if (failed <= 2) console.error(`  ${dim(`第 ${i + 1} 封读取失败：${e.message.slice(0, 70)}`)}`);
    }
    if (i % 10 === 9) await new Promise((r) => setTimeout(r, 300));
  }

  if (jsonMode) {
    console.log(JSON.stringify({ scanned: rows.length, failed, rows }, null, 2));
    process.exit(0);
  }

  const high = rows.filter((r) => r.importance === 'high');
  const digest = rows.filter((r) => r.importance === 'digest');
  const ignore = rows.filter((r) => r.importance === 'ignore');

  console.log(`  ${bold(`扫描 ${rows.length} 封`)}${failed ? dim(`（${failed} 封读取失败）`) : ''}`);
  console.log(
    `  ${red(`要立刻看 ${high.length}`)}   ${yellow(`汇总 ${digest.length}`)}   ${dim(`忽略 ${ignore.length}`)}\n`
  );

  if (high.length) {
    console.log(`  ${bold('要立刻看的：')}\n`);
    for (const r of high) {
      console.log(`  ${red('●')} ${r.subject.slice(0, 58)}`);
      console.log(`    ${dim(r.from.slice(0, 62))}`);
      console.log(`    ${dim(r.why.join('；'))}`);
      if (r.needsReply) console.log(`    ${cyan('→ 这封看起来要回复')}`);
    }
    console.log('');
  } else {
    console.log(dim('  没有需要立刻看的。\n'));
  }
  if (digest.length) console.log(dim(`  ${digest.length} 封攒进每日汇总（收据、一次性通知这类）。\n`));

  console.log(dim('  规则层 + 历史层，不读邮件正文。每条都带理由，自己扫一眼。\n'));
}

if (args.includes('--self-test')) selfTest();
else if (args.includes('--fixture')) showFixture();
else if (args.includes('--scan')) await scan();
else {
  console.log(`${bold('mail-important.mjs')} — 判断邮件重不重要、要不要回复

  node scripts/mail-important.mjs --scan        扫未读并判定（要凭据；bot 的 /取信 走这条）
  node scripts/mail-important.mjs --scan --json 结构化输出（stdout 是纯 JSON）
  node scripts/mail-important.mjs --self-test   用基准集自测（不需要凭据）
  node scripts/mail-important.mjs --fixture     打印基准集里每一封的判定

  ${dim('规则层 + 历史层。模型层不在这一版（见 PLAN-MAIL-TRIAGE-AUTO.md 阶段 1）。')}
  ${dim('输出是候选不是结论 —— 每条都带理由。')}
`);
}
