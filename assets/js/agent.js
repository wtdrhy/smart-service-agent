/**
 * agent.js — 客服 Agent 编排核心
 * ---------------------------------------------------------------
 * 职责：
 *   1. 会话状态机（Session State）——跨轮次维护意图、槽位、追问计数、未解决计数
 *   2. 槽位填充（Slot Filling）——按意图 schema 收集必要信息，缺失则追问
 *   3. 回答生成（RAG）——FAQ 检索 → 提示词拼装 → LLM 生成；无 LLM 时回落知识库原文
 *   4. 转人工（Human Handoff）——多策略触发，自动生成工单并落库
 *   5. 全链路埋点——意图、置信度、来源、耗时全部写入 messages 表，供后台分析
 */

/* ============================================================
 * 槽位定义
 *   mode:
 *     hard —— 必须先拿到槽位才能作答（如查订单必须要订单号）
 *     soft —— 先给通用解答，再顺带追问（体验更好）
 *     auto —— 命中 how-to 类 FAQ 时转 soft，否则按 hard
 * ==========================================================*/
/** 知识库命中阈值：由 test/tune.js 网格扫描得出（该点 F1 最优） */
const FAQ_HIT_THRESHOLD = 0.45;

const SLOT_SCHEMA = {
  refund: { fields: ['order_id'], mode: 'soft' },
  order_query: { fields: ['order_id'], mode: 'auto' },
  logistics: { fields: ['order_id'], mode: 'soft' },
  tech_support: { fields: [], mode: 'none' },
  account: { fields: [], mode: 'none' },
  complaint: { fields: [], mode: 'none' },
  human: { fields: [], mode: 'none' },
  greeting: { fields: [], mode: 'none' },
  other: { fields: [], mode: 'none' },
};

const SLOT_PROMPTS = {
  order_id: '麻烦提供一下订单号（16-20 位数字，形如 20261016123456），我就能直接帮你查到准确信息。',
  phone: '方便留一下下单时用的手机号吗？我按手机号也能查到订单。',
};

/* 用户表达「没解决」的检测 */
const UNSOLVED_PATTERNS = [
  /还是(不|没|不能|无法)/, /没(解决|搞定|用)/, /解决不了/, /不管用/, /没用/,
  /试了.*没/, /又说错/, /答非所问/, /听不懂/, /不是这个/,
];

/* ---------------- 模拟业务数据（订单中心 / 物流中心） ----------------
 * 真实项目里这里应替换为后端接口调用。
 * 用订单号做确定性哈希，保证同一单号每次查询结果一致。
 */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const ORDER_STATUS = ['待发货', '已发货', '运输中', '派送中', '已签收', '退款中', '已完成'];
const PRODUCTS = ['无线降噪耳机 Pro', '智能手环 8', '便携榨汁杯', '纯棉四件套', '机械键盘 87 键', '空气炸锅 5L'];
const CARRIERS = ['顺丰速运', '中通快递', '京东物流', '圆通速递'];

function mockOrderQuery(orderId) {
  const h = hashStr(orderId);
  const status = ORDER_STATUS[h % ORDER_STATUS.length];
  const product = PRODUCTS[h % PRODUCTS.length];
  const amount = ((h % 80000) / 100 + 29.9).toFixed(2);
  const daysAgo = h % 9;
  const created = new Date(Date.now() - daysAgo * 86400000);
  const carrier = CARRIERS[(h >> 3) % CARRIERS.length];
  const tracking = 'SF' + (100000000000 + (h % 89999999999));
  return {
    order_id: orderId,
    status,
    product,
    amount: `¥${amount}`,
    created_at: created.toLocaleDateString('zh-CN'),
    carrier,
    tracking_no: status === '待发货' ? '（未发货，暂无单号）' : tracking,
    can_refund: !['已完成', '退款中'].includes(status),
  };
}

function renderOrderCard(o) {
  return [
    `已查到订单 \`${o.order_id}\` 的信息：`,
    '',
    `· 商品：${o.product}`,
    `· 金额：${o.amount}`,
    `· 状态：${o.status}`,
    `· 下单时间：${o.created_at}`,
    o.tracking_no !== '（未发货，暂无单号）' ? `· 承运商：${o.carrier}　运单号：${o.tracking_no}` : `· 承运商：尚未发货`,
    '',
    o.can_refund ? '这单目前符合退款条件，需要我帮你发起退款吗？' : '这单已进入售后/完成状态，如需处理请告诉我具体情况。',
  ].join('\n');
}

/* ============================================================
 * Agent 会话
 * ==========================================================*/
class AgentSession {
  constructor(sessionRecord) {
    this.session = sessionRecord;
    this.history = [];      // {role, content, intent, confidence, source, pendingIntent, lowConfidence}
    this.slots = {};
    this.slotRetries = {};
    this.unsolvedCount = 0;
    this.turn = 0;
    this.transferred = false;
  }

  push(msg) {
    this.history.push(msg);
  }

  /** 转人工 */
  async handoff(reason, extra = {}) {
    if (this.transferred) {
      return {
        content: '已为你接入人工客服，专员正在查看你们的对话记录，请稍等一下～',
        meta: { transferred: true, skipped: true },
      };
    }
    this.transferred = true;
    const sentiment = extra.sentiment || { label: 'neutral', score: 0, urgent: false };
    const ticket = await Store.createTicket({
      session_id: this.session.id,
      reason,
      category: extra.category || extra.intent || 'other',
      priority: sentiment.urgent || sentiment.score >= 0.7 ? 'urgent' : sentiment.label === 'negative' ? 'high' : 'normal',
      summary: extra.summary || this.history.slice(-6).map((m) => `${m.role}: ${m.content}`).join(' | ').slice(0, 900),
    }).catch((e) => {
      console.warn('[agent] 工单落库失败', e);
      return null;
    });

    await Store.updateSession(this.session.id, { status: 'transferred', transferred: true });

    const content = [
      '已为你转接人工客服 👩‍💼',
      '',
      `转接原因：${reason}`,
      ticket ? `工单号：${ticket.id.slice(0, 8).toUpperCase()}（优先级：${{ low: '低', normal: '普通', high: '高', urgent: '紧急' }[ticket.priority]}）` : '',
      '',
      '专员会在 2 分钟内接入，对话记录已同步，你不需要重复描述问题。',
      '工作时间：每天 9:00-22:00。',
    ].filter(Boolean).join('\n');

    return { content, meta: { transferred: true, ticket } };
  }

  /**
   * 处理一轮用户输入
   * @param {string} text
   * @returns {Promise<{content:string, meta:object}>}
   */
  async handle(text) {
    const t0 = performance.now();
    this.turn++;

    // 1. 落库用户消息
    await Store.appendMessage({ session_id: this.session.id, role: 'user', content: text });
    this.push({ role: 'user', content: text });

    // 2. 意图识别（三层融合）
    const r = await Intent.recognize(text, this.history);

    // 2.1 未解决信号累积
    if (UNSOLVED_PATTERNS.some((p) => p.test(text))) this.unsolvedCount++;

    // 3. 转人工裁决
    if (r.needHuman) {
      const out = await this.handoff(r.humanReasons.join('；'), {
        intent: r.intent,
        sentiment: r.sentiment,
        summary: `意图=${r.intentText} 置信=${r.confidence.toFixed(2)}；${r.humanReasons.join('；')}`,
      });
      const latency = Math.round(performance.now() - t0);
      await Store.appendMessage({
        session_id: this.session.id, role: 'agent', content: out.content,
        intent: r.intent, confidence: r.confidence, source: 'human', latency_ms: latency,
      });
      this.push({ role: 'agent', content: out.content, intent: r.intent, source: 'human', lowConfidence: r.confidence < Config.load().agent.confidenceThreshold });
      return { content: out.content, meta: Object.assign({ intent: r, latency, source: 'human' }, out.meta) };
    }

    // 4. 槽位合并
    Object.entries(r.slots || {}).forEach(([k, v]) => {
      if (v) this.slots[k] = v;
    });

    // 5. 槽位检查
    const schema = SLOT_SCHEMA[r.intent] || { fields: [], mode: 'none' };
    const faqHits = FAQ.search(text, 3);
    const topFaq = faqHits[0] || null;
    let mode = schema.mode;
    if (mode === 'auto') {
      const isHowTo = topFaq && /^(怎么|如何|在哪|什么)/.test(topFaq.item.q);
      mode = isHowTo ? 'soft' : 'hard';
    }

    const missing = schema.fields.filter((f) => !this.slots[f]);

    if (missing.length && mode === 'hard') {
      const field = missing[0];
      this.slotRetries[field] = (this.slotRetries[field] || 0) + 1;
      const cfg = Config.load().agent;

      if (this.slotRetries[field] > cfg.maxSlotRetries) {
        const out = await this.handoff(`多次未能获取「${field}」，转人工核实身份`, { intent: r.intent, sentiment: r.sentiment });
        const latency = Math.round(performance.now() - t0);
        await Store.appendMessage({
          session_id: this.session.id, role: 'agent', content: out.content,
          intent: r.intent, confidence: r.confidence, source: 'human', latency_ms: latency,
        });
        return { content: out.content, meta: { intent: r, latency, source: 'human', transferred: true } };
      }

      const content = `好的，这个问题我可以帮你处理。${SLOT_PROMPTS[field] || ''}`;
      const latency = Math.round(performance.now() - t0);
      await Store.appendMessage({
        session_id: this.session.id, role: 'agent', content,
        intent: r.intent, confidence: r.confidence, source: 'slot', latency_ms: latency,
      });
      this.push({
        role: 'agent', content, intent: r.intent, source: 'slot',
        pendingIntent: r.intent, lowConfidence: false,
      });
      return { content, meta: { intent: r, latency, source: 'slot', awaitingSlot: field } };
    }

    // 6. 回答生成
    let content = '';
    let source = 'faq';

    // 6.1 数据类意图：命中槽位后直接查业务系统
    if (r.intent === 'order_query' && this.slots.order_id) {
      const o = mockOrderQuery(this.slots.order_id);
      content = renderOrderCard(o);
      source = 'rule';
    } else if (r.intent === 'refund' && this.slots.order_id) {
      // 用户补充了订单号：结合订单实际状态给出针对性答复，而不是重复通用流程
      const o = mockOrderQuery(this.slots.order_id);
      content = o.can_refund
        ? [
            `已核对订单 \`${o.order_id}\`：`,
            '',
            `· 商品：${o.product}`,
            `· 金额：${o.amount}`,
            `· 状态：${o.status}`,
            '',
            '该单符合退款条件。路径：我的订单 → 订单详情 → 申请退款，提交后 1-3 个工作日原路退回。',
            '需要我帮你发起退款申请吗？',
          ].join('\n')
        : [
            `已核对订单 \`${o.order_id}\`（${o.product} · ${o.status}）。`,
            '',
            '该单当前不在可直接退款的状态（已完成或已在退款流程中），需要走售后复核。',
            '方便说一下具体遇到了什么问题吗？或者直接说「转人工」，我帮你接入专员处理。',
          ].join('\n');
      source = 'rule';
    } else if (r.intent === 'logistics' && this.slots.order_id) {
      const o = mockOrderQuery(this.slots.order_id);
      content = [
        `订单 \`${o.order_id}\` 的物流状态：${o.status}`,
        o.tracking_no !== '（未发货，暂无单号）'
          ? `· ${o.carrier}　运单号：${o.tracking_no}\n· 可在快递官网或「我的订单 → 查看物流」查看实时轨迹`
          : '· 尚未发货，发货后 24 小时内会生成运单号',
      ].join('\n');
      source = 'rule';
    } else if (topFaq && topFaq.score >= FAQ_HIT_THRESHOLD) {
      // 6.2 知识库命中 → RAG 生成
      const gen = await this.generateAnswer(text, r, faqHits);
      content = gen.content;
      source = gen.source;
    } else if (Config.llmReady() && Config.load().agent.useLlmAnswer) {
      // 6.3 知识库未命中，交给大模型兜底（仍受提示词约束）
      const gen = await this.generateAnswer(text, r, faqHits);
      content = gen.content;
      source = gen.source;
    } else {
      content = this.fallbackAnswer(r, faqHits);
      source = 'fallback';
    }

    // 6.4 soft 模式：答完顺带追问槽位
    if (mode === 'soft' && missing.length) {
      const f = missing[0];
      this.slotRetries[f] = (this.slotRetries[f] || 0) + 1;
      content += `\n\n———\n另外，${SLOT_PROMPTS[f] || ''}`;
    }

    // 6.5 情绪安抚前缀
    if (r.sentiment.label === 'negative' && !this.transferred) {
      content = this.empathyPrefix() + content;
    }

    const latency = Math.round(performance.now() - t0);
    await Store.appendMessage({
      session_id: this.session.id, role: 'agent', content,
      intent: r.intent, confidence: r.confidence, source, latency_ms: latency,
    });
    this.push({
      role: 'agent', content, intent: r.intent, source,
      pendingIntent: missing.length ? r.intent : null,
      lowConfidence: r.confidence < Config.load().agent.confidenceThreshold,
    });

    return {
      content,
      meta: { intent: r, latency, source, faqHits: faqHits.map((h) => ({ id: h.item.id, q: h.item.q, score: +h.score.toFixed(3) })) },
    };
  }

  empathyPrefix() {
    const lines = [
      '非常抱歉给你带来了不好的体验，我完全理解你的心情 🙏',
      '抱歉让你遇到这样的问题，我这边马上为你处理 🙏',
      '理解你的着急，我这边优先帮你跟进 🙏',
    ];
    return lines[Math.floor(Math.random() * lines.length)] + '\n\n';
  }

  /* ---------------- RAG 回答生成 ---------------- */
  async generateAnswer(text, r, faqHits) {
    const ctxDocs = (faqHits || [])
      .filter((h) => h.score >= 0.3)
      .map((h, i) => `[片段${i + 1}]（相关度 ${h.score.toFixed(2)}）\n问题：${h.item.q}\n答案：${h.item.a}`)
      .join('\n\n');

    const slotText = Object.entries(this.slots).length
      ? Object.entries(this.slots).map(([k, v]) => `${k}=${v}`).join('，')
      : '（暂无）';

    const historyText = this.history.slice(-6).map((m) => `${m.role === 'user' ? '用户' : '客服'}: ${m.content}`).join('\n');

    const system = `你是「${Config.load().ui.botName}」，一个专业、亲切、高效的电商智能客服坐席。

硬性约束：
1. 只能依据【知识库片段】中的事实回答，禁止编造政策、金额、时限、订单号、单号等具体数据。
2. 知识库没有覆盖用户的问题时，直接说：「这块我需要转给人工专员帮你确认」，不要硬答。
3. 回复控制在 150 字以内，用中文，条理清晰，必要时用短列表。
4. 不要复述知识库编号，不要说「根据片段1」这类内部措辞。
5. 用户情绪不好时先共情一句，再给解决方案。
6. 结尾如需补充信息，用一句话自然追问，不要连续追问两个以上问题。

【知识库片段】
${ctxDocs || '（未命中任何片段）'}

【已收集的用户信息】
${slotText}

【最近对话】
${historyText || '（无）'}

【当前识别】
意图=${r.intentText}，置信度=${r.confidence.toFixed(2)}，情绪=${r.sentiment.label}`;

    try {
      if (!Config.llmReady()) throw new Error('NO_KEY');
      const content = await LLM.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: `用户问题：${text}` },
        ],
        { temperature: 0.4, maxTokens: 600 }
      );
      return { content: content.trim(), source: 'llm' };
    } catch (e) {
      // LLM 不可用 → 回落知识库原文（保证永远有答案）
      if (faqHits && faqHits.length && faqHits[0].score >= FAQ_HIT_THRESHOLD) {
        const best = faqHits[0].item;
        return { content: best.a, source: 'faq' };
      }
      return { content: this.fallbackAnswer(r, faqHits), source: 'fallback' };
    }
  }

  fallbackAnswer(r, faqHits) {
    if (r.intent === 'greeting') {
      return '在的～ 退款、查订单、技术支持、查物流都可以直接问我，也可以说「转人工」找真人客服。';
    }
    const guesses = (faqHits || []).filter((h) => h.score >= 0.25).slice(0, 2);
    if (guesses.length) {
      return [
        '我想确认一下你遇到的是不是下面这些问题：',
        ...guesses.map((g, i) => `${i + 1}. ${g.item.q}`),
        '',
        '回复对应数字，或者直接把问题再描述得具体一点，我就能更准确地帮你。',
      ].join('\n');
    }
    return [
      '抱歉，你描述的情况我暂时没有匹配到对应的解决方案。',
      '可以补充一下具体信息吗？比如：订单号、遇到问题的具体页面、报错提示文字。',
      '如果比较紧急，直接说「转人工」，我马上帮你接入人工专员。',
    ].join('\n');
  }
}

/* ============================================================
 * 工厂
 * ==========================================================*/
const Agent = {
  async start(meta = {}) {
    Store.init();
    const session = await Store.createSession(meta);
    return new AgentSession(session);
  },

  /** 从已有 session 恢复（后台回放用） */
  async resume(sessionId) {
    Store.init();
    const sessions = await Store.listSessions(1000);
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) throw new Error('会话不存在');
    const messages = await Store.listMessages(sessionId, 500);
    const as = new AgentSession(s);
    as.history = messages.map((m) => ({
      role: m.role,
      content: m.content,
      intent: m.intent,
      confidence: m.confidence,
      source: m.source,
      pendingIntent: m.source === 'slot' ? m.intent : null,
      lowConfidence: typeof m.confidence === 'number' && m.confidence < Config.load().agent.confidenceThreshold,
    }));
    as.transferred = !!s.transferred;
    return as;
  },

  async submitFeedback(sessionId, score, comment = '') {
    Store.init();
    await Store.createFeedback({ session_id: sessionId, score, comment });
    await Store.updateSession(sessionId, { status: 'closed' });
    return true;
  },

  mockOrderQuery,
  SLOT_SCHEMA,
};

window.Agent = Agent;
window.AgentSession = AgentSession;
