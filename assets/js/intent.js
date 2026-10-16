/**
 * intent.js — 三层融合意图识别
 * ---------------------------------------------------------------
 * L1 规则快通道：正则 + 关键词，响应快、可解释，显式信号（如订单号）直接高置信命中
 * L2 FAQ 检索信号：BM25 命中条目的类目反推意图，补充规则的泛化能力
 * L3 LLM 分类：DeepSeek 结构化输出，处理长句、口语、多意图
 * 融合策略：加权投票 + 上下文修正 + 阈值裁决，任一层缺失则权重重分配
 */

const INTENT_LABELS = {
  refund: '退款退货',
  order_query: '查询订单',
  tech_support: '技术支持',
  logistics: '物流查询',
  account: '账号相关',
  human: '转人工',
  complaint: '投诉维权',
  greeting: '闲聊问候',
  other: '其他',
};

/* ---------------- 关键词词典 ---------------- */
const RULES = [
  {
    intent: 'human',
    weight: 0.95,
    strong: [/转\s*人工/, /人工\s*客服/, /真人/, /找\s*人工/, /接\s*人工/],
    weak: [/(客服|专员).*(在哪|联系)/],
  },
  {
    intent: 'refund',
    weight: 0.7,
    strong: [/退\s*款/, /退\s*钱/, /退\s*回/, /退\s*货/, /无理由/, /仅退款/, /不想要了/, /退\s*了/, /(东西|货|商品|件|订的).{0,6}退/],
    weak: [/退款进度/, /到账/, /退货政策/, /运费/],
  },
  {
    intent: 'order_query',
    weight: 0.7,
    strong: [/查\s*(订)?单/, /订单.*(在哪|查询|进度|状态)/, /我(买|订)的/, /待发货/, /取消订单/, /开发票/],
    weak: [/订单/, /发货/, /收货/],
  },
  {
    intent: 'tech_support',
    weight: 0.72,
    strong: [/闪退/, /崩溃/, /登(不|不上|录不)/, /密码/, /验证码/, /支付(失败|不了)/, /卡(顿|死)/, /打不开/, /报错/, /同步(失败|不了)/, /bug/i, /黑屏/],
    weak: [/加载慢/, /版本/, /更新/, /网络/],
  },
  {
    intent: 'logistics',
    weight: 0.72,
    strong: [/物\s*流/, /快\s*递/, /运单/, /到哪了/, /什么时候到/, /少件/, /破损/, /拒收/],
    weak: [/配送/, /签收/, /运输/],
  },
  {
    intent: 'account',
    weight: 0.7,
    strong: [/注销/, /换\s*手机/, /改\s*手机/, /优惠券/, /会员/, /实名/],
    weak: [/账\s*号/, /绑定/],
  },
  {
    intent: 'complaint',
    weight: 0.8,
    strong: [/投\s*诉/, /举\s*报/, /维\s*权/, /315/, /工商局/, /骗/, /欺诈/, /假货/, /态度差/],
    weak: [/太差/, /垃圾/, /失望/],
  },
  {
    intent: 'greeting',
    weight: 0.6,
    strong: [/^(你好|您好|hi|hello|哈喽|在吗|hi there)/i, /^(谢谢|感谢|多谢)/, /再见|拜拜/],
    weak: [],
  },
];

/**
 * 负向上下文抑制
 * 某些关键词会跨意图误命中，例如「退款什么时候到账」里的「什么时候到」
 * 会命中 logistics 的强规则。命中下列词时，对应意图的分数按比例衰减。
 */
const EXCLUSIONS = {
  logistics: [/退款/, /退货/, /退钱/, /退还/],
  account: [/发票/, /物流/],
  // 「我想把买的东西退了」会被 order_query 的 /我(买|订)的/ 抢走，用退类词抑制
  order_query: [/闪退/, /密码/, /验证码/, /退\s*了/, /(想|要|能)?把.{0,4}(退|不要)/, /不想要了/],
};

/* ---------------- 槽位抽取 ---------------- */
const SLOT_PATTERNS = {
  order_id: [
    /(?:订单号|单号|订单)?\s*[:：]?\s*(\d{12,25})/,
    /\b(20\d{12,18})\b/,
  ],
  phone: [/\b(1[3-9]\d{9})\b/],
  amount: [/(\d+(?:\.\d{1,2})?)\s*元/],
  days: [/(\d+)\s*(?:天|日)/],
};

function extractSlots(text) {
  const slots = {};
  for (const [name, patterns] of Object.entries(SLOT_PATTERNS)) {
    for (const p of patterns) {
      const m = text.match(p);
      if (m && m[1]) {
        slots[name] = m[1];
        break;
      }
    }
  }
  return slots;
}

/* ---------------- 情绪检测 ---------------- */
const NEGATIVE_WORDS = [
  '垃圾', '太差', '很差', '生气', '愤怒', '投诉', '骗子', '骗人', '维权',
  '失望', '离谱', '荒唐', '无语', '坑', '慢死了', '没人管', '推诿', '敷衍',
  '已经很久', '还没解决', '第三次', '又坏了',
];
const URGENT_WORDS = ['紧急', '急', '马上', '立刻', '尽快', '等不了', '加急'];

function detectSentiment(text) {
  const t = String(text || '');
  let neg = 0;
  NEGATIVE_WORDS.forEach((w) => {
    if (t.includes(w)) neg++;
  });
  const urgent = URGENT_WORDS.some((w) => t.includes(w));
  const exclaim = (t.match(/[!！?？]/g) || []).length >= 2;
  if (neg >= 2 || (neg >= 1 && urgent)) return { label: 'negative', score: Math.min(1, 0.5 + neg * 0.2), urgent };
  if (neg === 1 || exclaim) return { label: 'negative', score: 0.45, urgent };
  return { label: 'neutral', score: 0.1, urgent };
}

/* ---------------- L1：规则层 ---------------- */
function ruleClassify(text) {
  const t = String(text || '').trim();
  const scores = {};
  const hits = {};
  for (const r of RULES) {
    let s = 0;
    const hitStrong = (r.strong || []).filter((p) => p.test(t));
    const hitWeak = (r.weak || []).filter((p) => p.test(t));
    if (hitStrong.length) {
      s = r.weight + Math.min(0.2, (hitStrong.length - 1) * 0.08);
      hits[r.intent] = hitStrong.length;
    } else if (hitWeak.length) {
      s = r.weight * 0.5;
      hits[r.intent] = 0.5;
    }
    if (s > 0) scores[r.intent] = Math.max(scores[r.intent] || 0, Math.min(0.98, s));
  }

  // 负向上下文：跨意图误命中衰减
  for (const [intent, patterns] of Object.entries(EXCLUSIONS)) {
    if (scores[intent] && patterns.some((p) => p.test(t))) {
      scores[intent] *= 0.3;
    }
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return {
    intent: best ? best[0] : null,
    confidence: best ? best[1] : 0,
    scores,
  };
}

/* ---------------- L2：FAQ 检索层 ---------------- */
function faqClassify(text) {
  const results = FAQ.search(text, 3);
  if (!results.length) return { intent: null, confidence: 0, scores: {}, hits: [] };
  const scores = {};
  results.forEach((r) => {
    // FAQ 类目 → 意图（human 类目映射到 human）
    const intent = r.item.category;
    scores[intent] = Math.max(scores[intent] || 0, r.score * 0.9);
  });
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return {
    intent: best ? best[0] : null,
    confidence: best ? best[1] : 0,
    scores,
    hits: results,
  };
}

/* ---------------- L3：LLM 分类层 ---------------- */
async function llmClassify(text, context) {
  if (!Config.llmReady() || !Config.load().agent.useLlmIntent) {
    return { intent: null, confidence: 0, scores: {}, skipped: true, reason: 'no-key' };
  }
  const labels = Object.keys(INTENT_LABELS).map((k) => `${k}(${INTENT_LABELS[k]})`).join(', ');
  const history = (context || []).slice(-4).map((m) => `${m.role}: ${m.content}`).join('\n');

  const prompt = `你是电商客服系统的意图分类器。根据用户输入与最近对话，输出唯一意图标签。

可选意图：${labels}

分类规则：
- 用户明确要求「转人工/人工客服/真人」→ human
- 涉及退款、退货、已付款想拿回钱 → refund
- 查询/修改/取消订单、开发票 → order_query
- 软件闪退、登录、密码、验证码、支付报错、卡顿 → tech_support
- 物流、快递、配送、少件破损 → logistics
- 账号注销、换绑手机、优惠券、会员 → account
- 投诉、举报、维权、假货、商家态度 → complaint
- 打招呼、感谢、告别 → greeting
- 都不属于 → other

最近对话：
${history || '（无）'}

用户输入："""${text}"""

只输出 JSON，不要任何解释、不要 markdown 代码块：
{"intent":"...","confidence":0.0~1.0,"reason":"10字以内"}`;

  try {
    const raw = await LLM.chat([
      { role: 'system', content: '你是精确的意图分类器，只输出合法 JSON。' },
      { role: 'user', content: prompt },
    ], { temperature: 0, maxTokens: 120, jsonMode: true });

    const cleaned = String(raw).replace(/```json|```/g, '').trim();
    const obj = JSON.parse(cleaned);
    if (!obj || !INTENT_LABELS[obj.intent]) throw new Error('非法意图标签: ' + obj.intent);
    return {
      intent: obj.intent,
      confidence: Math.max(0, Math.min(1, Number(obj.confidence) || 0.7)),
      scores: { [obj.intent]: Math.max(0, Math.min(1, Number(obj.confidence) || 0.7)) },
      reason: obj.reason || '',
    };
  } catch (e) {
    console.warn('[intent] LLM 分类失败，降级到规则+检索', e);
    return { intent: null, confidence: 0, scores: {}, skipped: true, reason: e.message };
  }
}

/* ---------------- 融合 ---------------- */
const FUSE_WEIGHTS = { rule: 0.45, faq: 0.3, llm: 0.25 };

function fuse(layers, context, text) {
  const { rule, faq, llm } = layers;
  const acc = {};
  let totalW = 0;

  function add(scores, w) {
    if (!scores || !Object.keys(scores).length) return;
    totalW += w;
    for (const [k, v] of Object.entries(scores)) {
      acc[k] = (acc[k] || 0) + v * w;
    }
  }

  add(rule.scores, FUSE_WEIGHTS.rule);
  add(faq.scores, FUSE_WEIGHTS.faq);
  add(llm.scores, FUSE_WEIGHTS.llm);

  // 权重重分配：缺失层不参与，保证总分仍是加权平均
  if (totalW > 0) {
    for (const k of Object.keys(acc)) acc[k] = acc[k] / totalW;
  }

  // 一致性加成：多层的 top1 相同 → 置信度提升
  const tops = [rule.intent, faq.intent, llm.intent].filter(Boolean);
  let sorted = Object.entries(acc).sort((a, b) => b[1] - a[1]);
  if (sorted.length) {
    const top = sorted[0][0];
    const agree = tops.filter((t) => t === top).length;
    if (agree >= 2) acc[top] = Math.min(0.99, acc[top] + 0.12 * (agree - 1));
  }

  // 上下文修正：上一轮在追问槽位，本轮只回答槽位值 → 继承上轮意图
  const lastAgent = [...(context || [])].reverse().find((m) => m.role === 'agent' && m.pendingIntent);
  if (lastAgent && lastAgent.pendingIntent) {
    const slots = extractSlots(text);
    const isPureSlot = Object.keys(slots).length > 0 && String(text).replace(/[\d\s]/g, '').length <= 4;
    if (isPureSlot) {
      acc[lastAgent.pendingIntent] = Math.max(acc[lastAgent.pendingIntent] || 0, 0.92);
    } else {
      // 弱继承：会话主题延续
      acc[lastAgent.pendingIntent] = Math.min(0.95, (acc[lastAgent.pendingIntent] || 0) + 0.15);
    }
  }

  sorted = Object.entries(acc).sort((a, b) => b[1] - a[1]);
  const intent = sorted.length ? sorted[0][0] : 'other';
  const confidence = sorted.length ? sorted[0][1] : 0;
  const runnerUp = sorted.length > 1 ? sorted[1] : null;

  return {
    intent,
    confidence,
    runnerUp: runnerUp ? { intent: runnerUp[0], confidence: runnerUp[1] } : null,
    scores: acc,
  };
}

/**
 * 主入口
 * @param {string} text 用户输入
 * @param {Array} context 历史消息（含 pendingIntent 字段）
 */
async function recognize(text, context = []) {
  const sentiment = detectSentiment(text);
  const slots = extractSlots(text);

  const rule = ruleClassify(text);
  const faq = faqClassify(text);
  const llm = await llmClassify(text, context);

  const fused = fuse({ rule, faq, llm }, context, text);

  // ---------------------------------------------------------
  // 转人工决策（多策略，任一命中即转）
  // ---------------------------------------------------------
  const cfg = Config.load().agent;
  const reasons = [];

  /* 知识库强命中豁免：口语化表达（如「券用不上咋回事」）的融合置信度天然偏低，
   * 但只要检索到了高相关条目，就说明能给出有效答案，不应转人工——
   * 否则会误伤大量正常咨询，把人工坐席淹没。 */
  const strongFaqHit = faq.hits && faq.hits[0] && faq.hits[0].score >= 0.6;

  if (fused.intent === 'human') reasons.push('用户显式要求人工');
  if (fused.intent === 'complaint') reasons.push('投诉维权类问题');
  if (sentiment.label === 'negative' && sentiment.score >= 0.5) reasons.push('检测到强烈负面情绪');

  // 极低置信且无知识库支撑 → 判定为完全无法理解
  if (fused.confidence < 0.25 && !strongFaqHit) reasons.push('意图置信度过低，且未命中知识库');

  // 连续多轮未能理解 → 兜底转人工（由 agent.js 维护 lowConfidence 标记）
  const lowStreak = context.filter((m) => m.role === 'agent' && m.lowConfidence).length;
  if (lowStreak >= cfg.maxLowConfidenceTurns && !strongFaqHit) {
    reasons.push(`连续 ${lowStreak} 轮未能理解`);
  }

  return {
    intent: fused.intent,
    intentText: INTENT_LABELS[fused.intent] || fused.intent,
    confidence: fused.confidence,
    runnerUp: fused.runnerUp,
    scores: fused.scores,
    slots,
    sentiment,
    needHuman: reasons.length > 0,
    humanReasons: reasons,
    layers: {
      rule: { intent: rule.intent, confidence: rule.confidence },
      faq: { intent: faq.intent, confidence: faq.confidence, hits: (faq.hits || []).map((h) => ({ id: h.item.id, q: h.item.q, score: +h.score.toFixed(3) })) },
      llm: { intent: llm.intent, confidence: llm.confidence, skipped: !!llm.skipped, reason: llm.reason || '' },
    },
  };
}

window.Intent = { recognize, extractSlots, detectSentiment, INTENT_LABELS, ruleClassify };
