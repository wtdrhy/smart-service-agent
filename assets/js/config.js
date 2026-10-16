/**
 * config.js — 运行时配置中心
 * ---------------------------------------------------------------
 * 所有外部依赖（大模型、云数据库）都通过本模块注入，业务代码不感知具体厂商。
 * 配置优先从 localStorage 读取，允许用户在页面「设置」面板里热更新，
 * 无需重新部署即可从「演示模式（本地规则引擎）」切换到「生产模式（真 LLM + 真云端）」。
 */

const CONFIG_STORAGE_KEY = 'ssa_config_v1';

/** 默认配置：零凭据即可完整运行 */
const DEFAULT_CONFIG = {
  llm: {
    provider: 'deepseek',
    // DeepSeek 官方端点不带 CORS 头，浏览器直连会被拦截。
    // 生产环境请填自建反代地址（见 deploy/worker-proxy.js），或留空走内置规则引擎。
    baseUrl: 'https://api.deepseek.com',
    proxyUrl: '',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.3,
    maxTokens: 800,
    timeoutMs: 20000,
  },
  db: {
    provider: 'supabase', // 'supabase' | 'local'
    url: '',     // 例：https://xxxxx.supabase.co
    anonKey: '', // Supabase anon public key
  },
  agent: {
    // 意图置信度低于该值 → 判定为「不确定」，走澄清或转人工
    confidenceThreshold: 0.45,
    // 连续 N 轮低置信 / 未解决 → 自动转人工
    maxLowConfidenceTurns: 2,
    // 单会话最多追问次数（防止死循环追问）
    maxSlotRetries: 3,
    // 是否开启 LLM 意图分类（无 Key 时自动关闭）
    useLlmIntent: true,
    useLlmAnswer: true,
  },
  ui: {
    botName: '小知',
    welcome: '你好，我是智能客服小知 👋 退款、查订单、技术支持都能问我，也可以直接说「转人工」。',
  },
  admin: {
    // 管理后台访问口令（演示环境简单保护，生产应接真实鉴权）
    passcode: 'admin2026',
  },
};

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!patch || typeof patch !== 'object') return out;
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

const Config = (() => {
  let state = null;

  function load() {
    if (state) return state;
    state = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    try {
      const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (raw) state = deepMerge(state, JSON.parse(raw));
    } catch (e) {
      console.warn('[config] 读取本地配置失败，使用默认值', e);
    }
    return state;
  }

  function save(patch) {
    state = deepMerge(load(), patch || {});
    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('[config] 配置持久化失败', e);
    }
    return state;
  }

  function reset() {
    state = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    localStorage.removeItem(CONFIG_STORAGE_KEY);
    return state;
  }

  /** LLM 是否真正可用（有 Key 且未禁用） */
  function llmReady() {
    const c = load().llm;
    return !!(c.apiKey && c.apiKey.trim());
  }

  /** 云数据库是否真正可用 */
  function dbReady() {
    const c = load().db;
    return c.provider === 'supabase' && !!(c.url && c.anonKey);
  }

  return { load, save, reset, llmReady, dbReady, DEFAULT_CONFIG };
})();

window.Config = Config;
