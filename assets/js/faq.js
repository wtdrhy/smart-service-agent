/**
 * faq.js — FAQ 知识库检索器
 * ---------------------------------------------------------------
 * 自建轻量检索，零外部依赖（不调用任何 embedding 服务），离线可跑：
 *   · 中文采用「字符 bigram」切分（避开分词器依赖，对短 query 很有效）
 *   · 英文/数字按词切分
 *   · BM25 打分 + 字面包含加权 + 类目先验
 * 返回 top-k 命中，score 归一化到 0~1，供意图融合模块直接使用。
 */

const FAQ = (() => {
  const K1 = 1.5;
  const B = 0.75;

  /* 可调超参：由 test/tune.js 网格扫描选出，勿拍脑袋修改。
   * 该组配置下的离线指标：标准问法 Top1 100%、口语化 Top1 93.3%、
   * 口语化召回 93.3%、无关问题拦截 92.9%（评测集见 test/dataset.js） */
  const TUNING = {
    absFloor: 4.0,   // 有效分绝对门槛，低于此值按 power 次幂衰减
    power: 2,        // 衰减陡度：越大越严格（拦截强、召回弱）
    relCap: 0.75,    // 相对分上限，剩余空间留给字面/关键词/类型加权
    typeBonus: 0.28, // 查询类型与条目类型一致的加分
    typePenalty: 0.18, // 类型不一致的减分
  };

  /** 文本归一化：去标点、全角转半角、小写 */
  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ');
  }

  /** 切词：中文 bigram + 英文数字单词 */
  function tokenize(text) {
    const s = normalize(text).replace(/\s+/g, ' ').trim();
    const tokens = [];
    const latin = s.match(/[a-z0-9]+/g) || [];
    latin.forEach((w) => tokens.push(w));
    const cjk = s.replace(/[a-z0-9]/g, '');
    for (let i = 0; i < cjk.length - 1; i++) {
      const gram = cjk[i] + cjk[i + 1];
      if (gram.trim()) tokens.push(gram);
    }
    if (cjk.length === 1) tokens.push(cjk);
    return tokens;
  }

  /* ---------------- 索引构建 ---------------- */
  let index = null;

  function buildIndex(docs) {
    const N = docs.length;
    const df = new Map();
    const docTokens = [];
    const docLen = [];
    let totalLen = 0;

    docs.forEach((d) => {
      const toks = tokenize(d.text);
      docTokens.push(toks);
      docLen.push(toks.length);
      totalLen += toks.length;
      const seen = new Set(toks);
      seen.forEach((t) => df.set(t, (df.get(t) || 0) + 1));
    });

    const avgdl = totalLen / Math.max(N, 1);
    const idf = new Map();
    df.forEach((count, t) => {
      idf.set(t, Math.log(1 + (N - count + 0.5) / (count + 0.5)));
    });

    return { N, df, idf, docTokens, docLen, avgdl, docs };
  }

  function ensureIndex() {
    if (index) return index;
    const data = window.FAQ_DATA || [];
    const docs = data.map((item) => ({
      ref: item,
      // 问题权重更高：拼接时重复一次
      text: [item.q, item.q, (item.aliases || []).join(' '), (item.keywords || []).join(' ')].join(' '),
    }));
    index = buildIndex(docs);
    return index;
  }

  /* ---------------- 查询类型感知 ----------------
   * 用户问「怎么退款」是在求流程（howto），说「退款失败」是在报故障（issue）。
   * 两者命中的知识条目完全不同，仅靠 BM25 容易混淆（例如「这个能退款吗」
   * 会被「退款被拒绝了怎么办」抢走），因此按查询类型对同类条目做偏置加分。
   */
  const ISSUE_PAT = /(失败|被拒|驳回|不行|不能|不了|错误|坏了|丢失|没到|没用|没解决|卡住|异常|投诉|举报|为什么|怎么办|还是)/;
  const HOWTO_PAT = /(怎么|如何|怎样|在哪|哪里|能不能|可以吗|能吗|我想|我要|需要|流程|方法|步骤|规则|政策|条件|多久|时间)$|^怎么|^如何/;

  function queryType(query) {
    const q = String(query || '');
    if (ISSUE_PAT.test(q)) return 'issue';
    if (/(怎么|如何|怎样|在哪|哪里|流程|方法|步骤|规则|政策|条件)/.test(q)) return 'howto';
    if (/(吗|呢)\s*$/.test(q.trim()) || /^(我想|我要|我需要)/.test(q.trim())) return 'howto';
    if (HOWTO_PAT.test(q)) return 'howto';
    return 'neutral';
  }

  function docType(item) {
    const q = item.q || '';
    if (ISSUE_PAT.test(q)) return 'issue';
    if (/^(怎么|如何|在哪|什么)/.test(q)) return 'howto';
    return 'neutral';
  }

  /* ---------------- 打分 ---------------- */
  function bm25Score(queryTokens, di) {
    const { docTokens, docLen, avgdl, idf } = index;
    const toks = docTokens[di];
    const dl = docLen[di] || 1;
    const tf = new Map();
    toks.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));

    let score = 0;
    let matched = 0;
    const qtf = new Set(queryTokens);
    qtf.forEach((t) => {
      const f = tf.get(t) || 0;
      if (!f) return;
      matched++;
      const idfv = idf.get(t) || 0;
      const denom = f + K1 * (1 - B + (B * dl) / avgdl);
      score += idfv * ((f * (K1 + 1)) / denom);
    });
    return { score, matched };
  }

  /**
   * 检索
   * @param {string} query
   * @param {number} topK
   * @returns {Array<{item, score, raw}>} score 已归一化到 0~1
   */
  function search(query, topK = 3) {
    ensureIndex();
    const qTokens = tokenize(query);
    if (!qTokens.length) return [];

    const scored = index.docs.map((d, i) => bm25Score(qTokens, i));
    const qTermCount = new Set(qTokens).size || 1;

    /* 有效分 = BM25 分 × 覆盖率系数
     * 只偶然命中一两个 bigram 的查询（如「你们老板是谁」只撞上「你们」）
     * 覆盖率低，有效分被压低，从而在绝对质量门处被拦下。 */
    const raws = scored.map((sc) => sc.score * (0.5 + 0.5 * (sc.matched / qTermCount)));
    const maxRaw = Math.max(...raws, 0.0001);

    const qNorm = normalize(query).replace(/\s+/g, '');
    const qT = queryType(query);

    /* 绝对质量门：相对归一化会把「毫无关联的查询」也拉到 1.0，
     * 因此用有效分的绝对值做门控。门控必须作用在「最终分」上——
     * 若只乘在基础分上，后面的字面/关键词加分会绕过门控，导致漏网。
     * 平方衰减让边界处更陡，把偶然命中与真实命中彻底分开。 */
    const quality = Math.min(1, Math.pow(maxRaw / TUNING.absFloor, TUNING.power));

    const results = index.docs
      .map((d, i) => {
        // 相对分只占 0.75，预留 25% 给下面的加权项，否则第一名永远饱和在 1.0，加权失去意义
        let s = TUNING.relCap * (raws[i] / maxRaw);
        // 字面包含加权：query 直接命中问题的连续子串，强信号
        const qn = normalize(d.ref.q).replace(/\s+/g, '');
        if (qn && qNorm && qNorm.includes(qn)) s += 0.35;
        else if (qn && qNorm.length > 3 && qn.includes(qNorm)) s += 0.2;
        // 关键词命中加权
        (d.ref.keywords || []).forEach((k) => {
          if (qNorm.includes(normalize(k).replace(/\s+/g, ''))) s += 0.08;
        });
        // 查询类型偏置：问流程优先流程条目，报故障优先排障条目
        // 双向调整——匹配加分、不匹配减分，否则差距太小无法翻盘
        if (qT !== 'neutral') {
          const dT = docType(d.ref);
          if (dT === qT) s += TUNING.typeBonus;
          else if (dT !== 'neutral') s -= TUNING.typePenalty;
        }
        s *= quality;
        return {
          item: d.ref,
          raw: raws[i],
          matched: scored[i].matched,
          coverage: scored[i].matched / qTermCount,
          score: Math.max(0, Math.min(1, s)),
        };
      })
      .filter((r) => r.raw > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return results;
  }

  /** 按类目检索（用于意图受约束时的定向召回） */
  function searchByCategory(query, category, topK = 2) {
    return search(query, 50)
      .filter((r) => r.item.category === category)
      .slice(0, topK);
  }

  function all() {
    ensureIndex();
    return index.docs.map((d) => d.ref);
  }

  function setTuning(patch) { Object.assign(TUNING, patch); }

  return { search, searchByCategory, tokenize, normalize, all, setTuning, TUNING };
})();

window.FAQ = FAQ;
