#!/usr/bin/env node
/**
 * mail-classify.mjs — 邮件分类的**唯一一份**实现
 *
 * 从 `mail-triage.mjs` 提出来的（2026-09-19）。提出来的理由不是"文件太长"，
 * 而是**要有第二个用户了**：邮件自动判断那条线（`PLAN-MAIL-TRIAGE-AUTO.md`）
 * 也要分类，如果各写一份，两份判断会慢慢分叉 ——
 * 而不一致的表现是「命令行说这封重要、手机上说不重要」。
 *
 * > 这条规矩写死在 `AGENTS.md` 第 0 节：bot 不复制发信逻辑，spawn 那个脚本。
 * > 分类同理。
 *
 * ## 这是纯函数模块，不联网、不读文件、不需要凭据
 *
 * `mail-triage.mjs` 负责取信与渲染，这里只负责"给定主题与发件人，它算什么"。
 * 所以它可以被单独测（`mail-triage.mjs --self-test` 那 18 项就是测它）。
 *
 * ## 天花板（必须说清，因为它决定了这个模块能用在哪）
 *
 * **只看主题与发件人，不理解邮件内容。** 后果是双向的：
 *
 *   - 漏：标题里没有关键词的信（"小明回复了你"不匹配任何信号）
 *   - 误：营销邮件标题里写了"限时到期"会被当成需要动作
 *
 * 实测（2026-09-19，44 封真实未读）：它判"需动作 25 封"，其中 **17 封是例行登录提醒**
 * （Google/Mozilla/xAI），真正值得打断用户的只有 1 封（账号被停用）。
 * **所以这个模块的输出是"候选"，不是"结论"。** 要判重要与否，
 * 得在它上面再加一层（见 PLAN-MAIL-TRIAGE-AUTO.md 的三层漏斗）。
 */

// ── 信号表 ────────────────────────────────────────────────────
/**
 * 每个信号有：名字、匹配标题/发件人的正则、以及"要不要紧"。
 *
 * `weight` 的含义：数字越大越可能需要你动手。
 * 排序靠它决定，所以重要的往前排。
 *
 * 加信号时注意：**宽泛的正则会让营销邮件涌进来**。
 * 比如 "expire" 会命中"限时优惠即将到期"这类。
 * 所以这里对营销口径做了排除（见 NOISE）。
 */
export const SIGNALS = [
  {
    name: '账号安全',
    weight: 90,
    re: /安全提醒|新的登录活动|new (sign-?in|login)|verification code|验证码|suspicious|unauthorized|被停用|suspended|账号.*(异常|受限|锁定)|password (reset|changed)/i,
    why: '账号被人动过，或需要你确认身份',
  },
  {
    name: '申请结果',
    weight: 80,
    re: /审核(通过|结果|完成)|申请(通过|结果|完成)|已开通|approved|rejected|accepted|waitlist|通过审核|开通成功/i,
    why: '你等的结果出来了',
  },
  {
    name: '待办/需确认',
    weight: 75,
    re: /请(确认|回复|回复我)|需要你|等你|确认一下|please (confirm|reply|respond|review|sign)|action required|需要(处理|操作)/i,
    why: '对方在等你回话',
  },
  {
    name: '临期/续费',
    weight: 70,
    re: /即将(到期|失效|过期)|(到期|截止)日期|deadline|will expire|expiring soon|续费提醒|renewal|最后通知/i,
    why: '有东西要到期了',
  },
  {
    name: '账单/付款',
    weight: 40,
    re: /receipt|invoice|payment|billing|收据|发票|账单|扣款|已支付/i,
    why: '通常只是留个记录',
  },
  {
    name: '额度/用量告警',
    weight: 60,
    re: /quota|usage (limit|exceeded)|余额不足|insufficient|额度|超出限制|rate limit/i,
    why: '可能影响你正在用的服务',
  },
];

/**
 * 明确不算"要动作"的东西 —— 用来降低误报。
 *
 * 分两类，**优先级不同**（见 classify）：
 *
 *   senderOnly  只看发件人**不足以**判噪声，必须配合"没有内容信号"
 *               才生效。因为 `no-reply@accounts.google.com` 是批量地址，
 *               但它发的"安全提醒"恰恰是真信号。
 *
 *   其余        内容是营销/推送，可以直接判噪声（即使标题里也带了
 *               "到期""限时"这类词，那是在推销）。
 */
export const NOISE = [
  { name: '社交推送', re: /reddit|quora|知乎|weibo|微博|twitter|facebook|instagram|linkedin|discord/i },
  { name: '推广/营销', re: /限时|优惠|折扣|promo|offer|deal|sale|升级(会员|套餐)|订阅(更|优)划算|\% off/i },
  { name: '产品更新', re: /new (model|feature|version|release)|changelog|release notes|更新公告|现已(支持|可用)|上线了|announcing/i },
  { name: '新闻通讯', re: /newsletter|digest|周报|日报|早报|精选|weekly|daily/i },
  {
    // 从批量发信地址来的，**且没有内容信号**时，才当噪声。
    //
    // 动机是实测的误报：OpenRouter 的一封营销邮件标题里写了 "rate limit"，
    // 被「额度/用量告警」命中，混进了"需动作"里。
    //
    // 一开始我把这条写成普通的噪声规则，结果**误伤了全部真信号** ——
    // `no-reply@accounts.google.com`（安全提醒）、
    // `accounts@firefox.com`（新登录）、`invoice+…@stripe.com`（收据）
    // 全都命中它。所以它必须比内容信号**弱**。
    //
    // 代价仍要说清：真人若用 `support@公司域名` 发信且标题无线索，会被误判成噪声。
    //
    // 2026-09-19 扩表：`team@` / `hello@` / `info@` 这些**看着像人、其实是团队群发**的
    // 地址原先漏了。实测撞到的是 `team@email.anthropic.com` —— 它被判成"真人首次来信"，
    // 于是营销信同时拿走了 high 与"要回"（9 封里 6 封 high，通知疲劳原样搬回来）。
    //
    // 但**靠地址猜"是不是机器发的"永远会有漏网**。所以这只是一道，
    // 第二道见 `looksAutomated()`（用 Gmail 自己的分类标签，不靠猜）。
    name: '批量发信地址',
    senderOnly: true,
    re: /\b(no-?reply|donotreply|do-not-reply|newsletter|news|updates?|notifications?|marketing|promo|billing|invoice|support|mailer|bounce|team|hello|hi|info|contact|admin|accounts?|alerts?|digest|press|events?|community|feedback)@/i,
  },
];

/**
 * **机器发的**（第二道，不靠猜地址）。
 *
 * ## 为什么需要它
 *
 * 上一条靠"地址里有没有 no-reply 这类词"猜，而**猜不准**：`team@`、`hello@`、
 * `welcome@` 看着像人，其实是群发；而 `accounts@firefox.com` 看着像机器，
 * 它发的"新登录"却可能是真信号。
 *
 * Gmail **自己**已经在分类了，而且分得比关键词准。所以：
 *
 *   · 发件人地址命中批量模式 → 机器发的
 *   · 这封信被 Gmail 归进 `CATEGORY_PROMOTIONS` / `CATEGORY_UPDATES` /
 *     `CATEGORY_FORUMS` / `CATEGORY_SOCIAL` → 机器发的
 *
 * `CATEGORY_PERSONAL` 与没有分类**都不算**（默认邮箱根本不分这些类，
 * 那时这个判据必须是"不知道"，不能是"不是机器"）。
 *
 * @param {string} from  `From:` 头
 * @param {string[]|null} labels  Gmail 的 labelIds（取不到就传 null）
 */
export function looksAutomated(from = '', labels = null) {
  if (isBulkSender(from)) return true;
  if (!Array.isArray(labels)) return false; // 不知道 ≠ 不是
  const bulkCategories = ['CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'CATEGORY_SOCIAL'];
  return labels.some((l) => bulkCategories.includes(l));
}

/**
 * **删掉的东西，记下来免得以后有人再想加。**
 *
 * 本来想给每条信号标一个「可能误报」，判据是"信号类型容易被营销模仿
 * **且** 发件人像批量地址"。写出来一测，**两个方向都错**：
 *
 *   Google 安全提醒   发件人 no-reply@ → 判为可疑 ✗ 它是真信号
 *   OpenRouter 营销   发件人 welcome@  → 判为不可疑 ✗ 它是营销
 *   Stripe 收据       发件人 invoice@  → 判为可疑 ✗ 它是真的
 *
 * 错法是结构性的：**发件人地址的模式与"这条信号是真是假"没有稳定关系。**
 * 要判准就得理解邮件内容，而那是这个模块明确不做的事（见文件头）。
 *
 * 所以不标了，改成输出里**始终带上主题和发件人** —— 人扫一眼自己判断。
 * 这比一个半准的自动判断诚实：**半准的判断会被信，而它不值得被信。**
 */

// ── 分类（纯函数，可单独测）──────────────────────────────────
/**
 * 给一封邮件分类。优先级：**内容信号 > 发件人噪声 > 内容噪声**。
 *
 * 这个顺序是踩出来的，不是设计出来的：
 *
 *   1. 内容信号最强 —— "安全提醒""申请通过"这类词出现在标题里，
 *      不管发件人是谁都值得你看一眼。
 *   2. 发件人噪声次之 —— 只用来过滤"批量地址 + 标题没线索"的邮件。
 *   3. 内容噪声最弱 —— 但一旦命中（营销、推送），即使同时有信号词
 *      也判噪声，因为那是推销话术（"限时到期"）。
 *
 * @param {{subject: string, from: string}} mail
 */
export function classify({ subject = '', from = '' }) {
  const contentHay = subject;
  const senderHay = from;

  const signals = SIGNALS.filter((s) => s.re.test(contentHay) || s.re.test(senderHay)).map((s) => s.name);

  const hardNoise = NOISE.filter((n) => !n.senderOnly && n.re.test(`${contentHay}\n${senderHay}`)).map((n) => n.name);
  const senderNoise = NOISE.filter((n) => n.senderOnly && n.re.test(senderHay)).map((n) => n.name);

  // 1. 内容噪声：即使有信号词也判噪声（推销话术会带"限时""到期"）
  if (hardNoise.length) return { kind: 'noise', signals, noise: hardNoise, weight: 0 };

  // 2. 有内容信号 —— 比发件人噪声强
  if (signals.length) {
    const weight = Math.max(...signals.map((n) => SIGNALS.find((s) => s.name === n).weight));
    return {
      kind: 'signal',
      signals,
      noise: senderNoise,
      weight,
    };
  }

  // 3. 没信号、又是批量地址 → 噪声
  if (senderNoise.length) return { kind: 'noise', signals: [], noise: senderNoise, weight: 0 };

  return { kind: 'plain', signals: [], noise: [], weight: 0 };
}

// ── 发件人地址提取 ────────────────────────────────────────────
/**
 * 从 `From:` 头里取出纯地址。`"名字" <a@b.com>` / `名字 <a@b.com>` / `a@b.com` 都认。
 *
 * 为什么要单独有这个：判断"是不是批量地址"要靠地址本身，
 * 而 `From:` 里常常带显示名 —— 拿整个头去匹配 `no-reply@` 会被显示名干扰。
 */
export function senderAddress(from = '') {
  const m = from.match(/<([^>]+)>/);
  if (m) return m[1].trim().toLowerCase();
  const bare = from.match(/[\w.+-]+@[\w.-]+\.\w+/);
  return bare ? bare[0].trim().toLowerCase() : from.trim().toLowerCase();
}

/**
 * 这封信是不是"机器发的"（批量地址）。
 *
 * **注意它的用途**：它只能回答"是不是机器地址"，**不能**回答"重不重要" ——
 * `no-reply@accounts.google.com` 是机器地址，但它发的"账号被停用"很重要。
 * 所以这个函数只适合用来做"要不要给机器人回信"这类判断（`needsReply`），
 * 不适合单独用来判重要与否。
 */
export function isBulkSender(from = '') {
  const addr = senderAddress(from);
  const bulk = NOISE.find((n) => n.senderOnly);
  return bulk.re.test(addr);
}

export const KIND_LABEL = {
  账号安全: '账号安全',
  申请结果: '申请结果',
  待办需确认: '待办/需确认',
  临期续费: '临期/续费',
  账单付款: '账单/付款',
  额度告警: '额度/用量',
};

/** 渲染成一段给人看的汇总。 */
export function renderDigest(rows) {
  const signals = rows.filter((r) => r.kind === 'signal').sort((a, b) => b.weight - a.weight);
  const noise = rows.filter((r) => r.kind === 'noise');
  const plain = rows.filter((r) => r.kind === 'plain');

  const out = [];
  out.push(`**扫描 ${rows.length} 封**：需动作 ${signals.length} · 普通 ${plain.length} · 噪声 ${noise.length}`);
  out.push('');

  if (!signals.length) {
    out.push('没有检出需要动作的邮件。');
  } else {
    out.push('**需要你看一眼的：**');
    out.push('');
    for (const r of signals) {
      out.push(`· [${r.signals.join('/')}] ${r.subject}`);
      out.push(`  ${r.from}`);
    }
  }

  if (plain.length) {
    out.push('');
    out.push(`另有 ${plain.length} 封没命中任何信号（可能是需要人读的信，也可能是没见过的格式）。`);
  }
  if (noise.length) {
    out.push(`噪声 ${noise.length} 封已略过（社交推送、营销、产品更新、新闻通讯）。`);
  }

  out.push('');
  out.push('> 分类靠标题与发件人的关键词匹配，**不理解邮件内容** ——');
  out.push('> 它可能漏掉标题里没线索的邮件，也可能把某些营销当成信号。仅供参考。');

  return out.join('\n');
}
