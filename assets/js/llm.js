/**
 * llm.js — 大模型适配层（DeepSeek / OpenAI 兼容协议）
 * ---------------------------------------------------------------
 * 设计要点：
 *   1. 所有失败都「软失败」——抛错由上层捕获后降级到规则引擎，绝不阻塞对话
 *   2. 支持自定义反代地址（DeepSeek 官方端点无 CORS 头，浏览器无法直连）
 *   3. 超时控制 + 一次性重试
 */

const LLM = (() => {
  /** 实际请求地址：优先反代，其次官方端点 */
  function endpoint() {
    const c = Config.load().llm;
    const base = (c.proxyUrl && c.proxyUrl.trim()) || c.baseUrl;
    if (/\/chat\/completions$/.test(base)) return base;
    return base.replace(/\/+$/, '') + '/chat/completions';
  }

  function ready() {
    return Config.llmReady();
  }

  async function request(body, timeoutMs) {
    const c = Config.load().llm;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || c.timeoutMs || 20000);
    try {
      const res = await fetch(endpoint(), {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`LLM ${res.status}: ${txt.slice(0, 180)}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('LLM 返回内容为空');
      return { content, usage: data.usage || null };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 对话补全
   * @param {Array<{role:string,content:string}>} messages
   * @param {{temperature?:number,maxTokens?:number,jsonMode?:boolean,timeoutMs?:number}} opts
   */
  async function chat(messages, opts = {}) {
    if (!ready()) throw new Error('LLM_NOT_CONFIGURED');
    const c = Config.load().llm;
    const body = {
      model: c.model,
      messages,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : c.temperature,
      max_tokens: opts.maxTokens || c.maxTokens,
      stream: false,
    };
    if (opts.jsonMode) body.response_format = { type: 'json_object' };

    try {
      return (await request(body, opts.timeoutMs)).content;
    } catch (e) {
      // 超时/网络抖动重试一次
      if (e.name === 'AbortError' || /network|fetch|Failed/i.test(e.message)) {
        const retry = await request(body, (opts.timeoutMs || c.timeoutMs) + 8000).catch((e2) => {
          throw new Error(`LLM 重试仍失败: ${e2.message}`);
        });
        return retry.content;
      }
      throw e;
    }
  }

  /** 连通性自检，供设置面板显示状态 */
  async function ping() {
    if (!ready()) return { ok: false, msg: '未配置 API Key' };
    try {
      const t0 = performance.now();
      await request(
        { model: Config.load().llm.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, stream: false },
        12000
      );
      return { ok: true, msg: `连通正常（${Math.round(performance.now() - t0)}ms）` };
    } catch (e) {
      return { ok: false, msg: e.message.slice(0, 120) };
    }
  }

  return { chat, ping, ready, endpoint };
})();

window.LLM = LLM;
