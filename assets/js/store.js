/**
 * store.js — 持久化数据层
 * ---------------------------------------------------------------
 * 双适配器设计：
 *   1) SupabaseAdapter —— 通过 PostgREST 直连云端 Postgres，数据真正在云上
 *   2) LocalAdapter    —— 无凭据时降级到 localStorage，保证零配置可跑
 * 两者暴露完全相同的 Promise 接口，上层业务（agent.js / admin.js）无感知。
 *
 * 表结构见 sql/schema.sql
 */

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** 统一时间戳（ISO 字符串，Postgres timestamptz 可直接吃） */
function now() {
  return new Date().toISOString();
}

/* ============================================================
 * Supabase (PostgREST) 适配器
 * ==========================================================*/
class SupabaseAdapter {
  constructor(url, anonKey) {
    this.base = url.replace(/\/+$/, '') + '/rest/v1';
    this.key = anonKey;
  }

  _headers(extra) {
    return Object.assign(
      {
        apikey: this.key,
        Authorization: 'Bearer ' + this.key,
        'Content-Type': 'application/json',
      },
      extra || {}
    );
  }

  async _req(path, opts) {
    const res = await fetch(this.base + path, opts);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Supabase ${res.status}: ${txt.slice(0, 200)}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  }

  insert(table, rows) {
    return this._req(`/${table}`, {
      method: 'POST',
      headers: this._headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(rows),
    }).then((r) => r[0]);
  }

  update(table, id, patch) {
    return this._req(`/${table}?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: this._headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(patch),
    }).then((r) => r[0]);
  }

  select(table, { order = 'created_at.desc', limit = 1000, filters = [] } = {}) {
    const qs = [`select=*`, `order=${order}`, `limit=${limit}`, ...filters].join('&');
    return this._req(`/${table}?${qs}`, { method: 'GET', headers: this._headers() });
  }
}

/* ============================================================
 * 本地降级适配器（localStorage）
 * ==========================================================*/
class LocalAdapter {
  constructor() {
    this.prefix = 'ssa_db_';
    this.tables = ['sessions', 'messages', 'tickets', 'feedbacks'];
  }

  _read(t) {
    try {
      return JSON.parse(localStorage.getItem(this.prefix + t) || '[]');
    } catch (e) {
      return [];
    }
  }

  _write(t, rows) {
    try {
      localStorage.setItem(this.prefix + t, JSON.stringify(rows));
    } catch (e) {
      console.warn('[store] 本地写入失败（可能超出配额）', e);
    }
  }

  async insert(table, rows) {
    const list = this._read(table);
    const row = Array.isArray(rows) ? rows[0] : rows;
    list.push(row);
    this._write(table, list);
    return row;
  }

  async update(table, id, patch) {
    const list = this._read(table);
    const i = list.findIndex((r) => r.id === id);
    if (i >= 0) {
      list[i] = Object.assign({}, list[i], patch);
      this._write(table, list);
      return list[i];
    }
    return null;
  }

  async select(table, { order = 'created_at.desc', limit = 1000 } = {}) {
    let list = this._read(table).slice();
    const desc = String(order).endsWith('.desc');
    const field = String(order).split('.')[0];
    list.sort((a, b) => {
      const va = a[field] || '',
        vb = b[field] || '';
      return desc ? (vb < va ? -1 : 1) : va < vb ? -1 : 1;
    });
    return list.slice(0, limit);
  }
}

/* ============================================================
 * 统一门面
 * ==========================================================*/
const Store = (() => {
  let adapter = null;
  let mode = 'local';

  function init() {
    const c = Config.load();
    if (c.db.provider === 'supabase' && c.db.url && c.db.anonKey) {
      adapter = new SupabaseAdapter(c.db.url, c.db.anonKey);
      mode = 'supabase';
    } else {
      adapter = new LocalAdapter();
      mode = 'local';
    }
    return mode;
  }

  function getAdapter() {
    if (!adapter) init();
    return adapter;
  }

  function getMode() {
    if (!adapter) init();
    return mode;
  }

  /* ---------- sessions ---------- */
  async function createSession(meta) {
    const row = Object.assign(
      {
        id: uuid(),
        user_id: meta?.user_id || 'guest',
        channel: meta?.channel || 'web',
        status: 'open', // open | transferred | closed
        message_count: 0,
        transferred: false,
        created_at: now(),
        updated_at: now(),
      },
      meta || {}
    );
    return getAdapter().insert('sessions', row);
  }

  async function updateSession(id, patch) {
    return getAdapter().update('sessions', id, Object.assign({ updated_at: now() }, patch));
  }

  async function listSessions(limit = 200) {
    return getAdapter().select('sessions', { order: 'created_at.desc', limit });
  }

  /* ---------- messages ---------- */
  async function appendMessage(msg) {
    const row = Object.assign(
      {
        id: uuid(),
        session_id: msg.session_id,
        role: msg.role, // user | agent | system
        content: msg.content || '',
        intent: msg.intent || null,
        confidence: typeof msg.confidence === 'number' ? msg.confidence : null,
        source: msg.source || null, // rule | faq | llm | human | slot | fallback
        // 允许调用方指定时间（演示数据造历史、历史数据迁移时使用）
        created_at: msg.created_at || now(),
      },
      {}
    );
    if (typeof msg.latency_ms === 'number') row.latency_ms = msg.latency_ms;
    const saved = await getAdapter().insert('messages', row);
    // 冗余计数，方便后台列表直接展示
    try {
      const sessions = await getAdapter().select('sessions', { limit: 1000 });
      const s = sessions.find((x) => x.id === msg.session_id);
      if (s) await updateSession(msg.session_id, { message_count: (s.message_count || 0) + 1 });
    } catch (e) {
      /* 计数失败不影响主流程 */
    }
    return saved;
  }

  async function listMessages(sessionId, limit = 500) {
    return getAdapter().select('messages', {
      order: 'created_at.asc',
      limit,
      filters: [`session_id=eq.${encodeURIComponent(sessionId)}`],
    });
  }

  async function listAllMessages(limit = 3000) {
    return getAdapter().select('messages', { order: 'created_at.desc', limit });
  }

  /* ---------- tickets（转人工工单） ---------- */
  async function createTicket(t) {
    const row = Object.assign(
      {
        id: uuid(),
        session_id: t.session_id,
        reason: t.reason || '',
        category: t.category || 'other',
        priority: t.priority || 'normal', // low | normal | high | urgent
        status: 'pending', // pending | processing | resolved
        summary: t.summary || '',
        created_at: t.created_at || now(),
      },
      {}
    );
    return getAdapter().insert('tickets', row);
  }

  async function listTickets(limit = 200) {
    return getAdapter().select('tickets', { order: 'created_at.desc', limit });
  }

  async function updateTicket(id, patch) {
    return getAdapter().update('tickets', id, patch);
  }

  /* ---------- feedbacks（满意度） ---------- */
  async function createFeedback(f) {
    const row = Object.assign(
      {
        id: uuid(),
        session_id: f.session_id,
        score: f.score, // 1-5
        comment: f.comment || '',
        created_at: f.created_at || now(),
      },
      {}
    );
    return getAdapter().insert('feedbacks', row);
  }

  async function listFeedbacks(limit = 1000) {
    return getAdapter().select('feedbacks', { order: 'created_at.desc', limit });
  }

  /** 清空本地演示数据（仅 local 模式有效） */
  function clearLocal() {
    ['sessions', 'messages', 'tickets', 'feedbacks'].forEach((t) =>
      localStorage.removeItem('ssa_db_' + t)
    );
    adapter = null;
  }

  return {
    init,
    getMode,
    createSession,
    updateSession,
    listSessions,
    appendMessage,
    listMessages,
    listAllMessages,
    createTicket,
    listTickets,
    updateTicket,
    createFeedback,
    listFeedbacks,
    clearLocal,
    uuid,
    now,
  };
})();

window.Store = Store;
