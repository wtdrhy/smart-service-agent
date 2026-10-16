/**
 * admin.js — 管理后台
 * ---------------------------------------------------------------
 * · 对话记录回放：按会话还原完整多轮对话，含意图、置信度、来源、耗时
 * · 统计分析：意图分布、满意度 CSAT、转人工率、回答来源构成、响应时长
 * · 图表全部用 Canvas 自绘，不依赖任何 CDN，保证离线/内网部署可用
 * · 演示数据生成：一键造 7 天历史数据，便于展示完整看板
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const PALETTE = ['#4f46e5', '#0f9d58', '#d97706', '#2563eb', '#dc2626', '#8b5cf6', '#0891b2', '#db2777', '#65a30d'];
  const SOURCE_LABEL = {
    llm: '大模型生成', faq: '知识库命中', rule: '业务数据查询',
    slot: '槽位追问', human: '转人工', fallback: '兜底澄清',
  };

  let DATA = { sessions: [], messages: [], tickets: [], feedbacks: [] };

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&', '<': '<', '>': '>', '"': '"' }[c]));
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  /* ================= 登录 ================= */
  function checkLogin() {
    if (sessionStorage.getItem('ssa_admin_ok') === '1') {
      $('loginView').style.display = 'none';
      $('adminView').style.display = 'flex';
      return true;
    }
    return false;
  }

  function doLogin() {
    const v = $('passInput').value.trim();
    if (v === Config.load().admin.passcode) {
      sessionStorage.setItem('ssa_admin_ok', '1');
      $('loginView').style.display = 'none';
      $('adminView').style.display = 'flex';
      loadAll();
    } else {
      $('loginErr').textContent = '口令不正确';
    }
  }

  /* ================= Canvas 图表 ================= */
  function setupCanvas(cv, h) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || cv.parentElement.clientWidth || 460;
    cv.width = w * dpr;
    cv.height = h * dpr;
    cv.style.width = '100%';
    cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /** 横向条形图 */
  function drawBar(cv, items) {
    if (!items.length) return;
    const rowH = 30;
    const { ctx, w } = setupCanvas(cv, items.length * rowH + 16);
    const max = Math.max(...items.map((i) => i.value), 1);
    const labelW = 88, valW = 46;
    const barX = labelW + 10, barW = Math.max(40, w - labelW - valW - 16);

    items.forEach((it, i) => {
      const y = 8 + i * rowH;
      ctx.fillStyle = '#5b6178';
      ctx.font = '12px -apple-system,"PingFang SC",sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const label = it.label.length > 6 ? it.label.slice(0, 6) : it.label;
      ctx.fillText(label, 0, y + 7);

      ctx.fillStyle = '#eef0f7';
      roundRect(ctx, barX, y, barW, 12, 6); ctx.fill();

      const ww = Math.max(4, (barW * it.value) / max);
      ctx.fillStyle = it.color || PALETTE[0];
      roundRect(ctx, barX, y, ww, 12, 6); ctx.fill();

      ctx.fillStyle = '#8b91a6';
      ctx.textAlign = 'right';
      ctx.fillText(String(it.value), w, y + 7);
    });
  }

  /** 环形图 */
  function drawDonut(cv, items, centerMain, centerSub) {
    const total = items.reduce((a, b) => a + b.value, 0);
    const size = 210;
    const { ctx, w } = setupCanvas(cv, size);
    const cx = w / 2, cy = size / 2, r = 78;

    if (total === 0) {
      ctx.strokeStyle = '#e4e7ee';
      ctx.lineWidth = 26;
      ctx.beginPath(); ctx.arc(cx, cy, r - 13, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#8b91a6';
      ctx.font = '13px -apple-system,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无评价数据', cx, cy);
      return;
    }

    let start = -Math.PI / 2;
    items.forEach((it) => {
      if (!it.value) return;
      const ang = (it.value / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, start, start + ang);
      ctx.closePath();
      ctx.fillStyle = it.color;
      ctx.fill();
      start += ang;
    });

    // 挖空成环
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.58, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    ctx.fillStyle = '#1c2033';
    ctx.font = '700 26px -apple-system,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(centerMain, cx, cy + 4);
    ctx.fillStyle = '#8b91a6';
    ctx.font = '12px -apple-system,sans-serif';
    ctx.fillText(centerSub, cx, cy + 24);
  }

  /** 折线图 */
  function drawLine(cv, points) {
    const H = 200;
    const { ctx, w } = setupCanvas(cv, H);
    const padL = 30, padR = 12, padT = 14, padB = 26;
    const plotW = w - padL - padR, plotH = H - padT - padB;
    const max = Math.max(...points.map((p) => p.value), 1);

    // 网格
    ctx.strokeStyle = '#eef0f7';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH * i) / 4;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = '#b8bdcc';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(String(Math.round((max * (4 - i)) / 4)), padL - 6, y);
    }

    const stepX = points.length > 1 ? plotW / (points.length - 1) : 0;
    const coords = points.map((p, i) => ({
      x: padL + i * stepX,
      y: padT + plotH - (plotH * p.value) / max,
    }));

    // 面积
    ctx.beginPath();
    ctx.moveTo(coords[0].x, padT + plotH);
    coords.forEach((c) => ctx.lineTo(c.x, c.y));
    ctx.lineTo(coords[coords.length - 1].x, padT + plotH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, 'rgba(79,70,229,.22)');
    grad.addColorStop(1, 'rgba(79,70,229,0)');
    ctx.fillStyle = grad; ctx.fill();

    // 折线
    ctx.beginPath();
    coords.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 点 + 标签
    coords.forEach((c, i) => {
      ctx.beginPath(); ctx.arc(c.x, c.y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.strokeStyle = '#4f46e5'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#8b91a6';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(points[i].label, c.x, padT + plotH + 7);
    });
  }

  /* ================= 数据聚合 ================= */
  function aggregate() {
    const { sessions, messages, tickets, feedbacks } = DATA;
    const agentMsgs = messages.filter((m) => m.role === 'agent');

    const intentCount = {};
    agentMsgs.forEach((m) => {
      if (m.intent) intentCount[m.intent] = (intentCount[m.intent] || 0) + 1;
    });

    const sourceCount = {};
    agentMsgs.forEach((m) => {
      if (m.source) sourceCount[m.source] = (sourceCount[m.source] || 0) + 1;
    });

    const lat = agentMsgs.filter((m) => typeof m.latency_ms === 'number').map((m) => m.latency_ms);
    const avgLatency = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 0;

    const transferred = sessions.filter((s) => s.transferred).length;
    const autoRate = sessions.length ? 1 - transferred / sessions.length : 0;

    const scores = feedbacks.map((f) => Number(f.score)).filter((n) => n >= 1 && n <= 5);
    const avgCsat = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const csatDist = [5, 4, 3, 2, 1].map((s) => ({ label: s + ' 星', value: scores.filter((x) => x === s).length }));
    const goodRate = scores.length ? scores.filter((s) => s >= 4).length / scores.length : 0;

    // 近 7 日趋势
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      days.push({ key: d.toDateString(), label: `${d.getMonth() + 1}/${d.getDate()}`, value: 0 });
    }
    sessions.forEach((s) => {
      const d = new Date(s.created_at);
      if (isNaN(d.getTime())) return;
      const hit = days.find((x) => x.key === d.toDateString());
      if (hit) hit.value++;
    });

    // 未解决问题：兜底回复对应的上一条用户消息
    const bySession = {};
    messages.slice().reverse().forEach((m) => {
      (bySession[m.session_id] = bySession[m.session_id] || []).push(m);
    });
    const unsolvedMap = {};
    Object.values(bySession).forEach((list) => {
      let lastUser = null;
      list.forEach((m) => {
        if (m.role === 'user') lastUser = m.content;
        if (m.role === 'agent' && m.source === 'fallback' && lastUser) {
          const key = lastUser.slice(0, 40);
          unsolvedMap[key] = (unsolvedMap[key] || 0) + 1;
        }
      });
    });
    const unsolved = Object.entries(unsolvedMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => ({ text: k, count: v }));

    return {
      totalSessions: sessions.length,
      totalMessages: messages.length,
      userMessages: messages.filter((m) => m.role === 'user').length,
      agentMessages: agentMsgs.length,
      transferred,
      autoRate,
      avgLatency,
      avgCsat,
      goodRate,
      csatDist,
      csatTotal: scores.length,
      intentCount,
      sourceCount,
      trend: days,
      unsolved,
      avgTurns: sessions.length ? messages.length / sessions.length : 0,
    };
  }

  /* ================= 渲染 ================= */
  function renderOverview(a) {
    const cards = [
      { label: '总会话数', value: a.totalSessions, sub: `平均 ${a.avgTurns.toFixed(1)} 条/会话`, cls: '' },
      { label: '消息总量', value: a.totalMessages, sub: `用户 ${a.userMessages} · 客服 ${a.agentMessages}`, cls: 'blue' },
      { label: '自动化解决率', value: (a.autoRate * 100).toFixed(1), unit: '%', sub: `转人工 ${a.transferred} 次`, cls: 'green' },
      { label: '平均满意度', value: a.avgCsat.toFixed(2), unit: '/5', sub: `${a.csatTotal} 份评价 · 好评率 ${(a.goodRate * 100).toFixed(0)}%`, cls: 'amber' },
      { label: '平均响应时长', value: Math.round(a.avgLatency), unit: 'ms', sub: '含意图识别与生成', cls: 'red' },
      { label: '人工工单', value: DATA.tickets.length, sub: `待处理 ${DATA.tickets.filter((t) => t.status === 'pending').length}`, cls: '' },
    ];
    $('statGrid').innerHTML = cards
      .map(
        (c) => `<div class="stat-card ${c.cls}">
        <div class="label">${esc(c.label)}</div>
        <div class="value">${esc(c.value)}<small>${esc(c.unit || '')}</small></div>
        <div class="delta">${esc(c.sub)}</div>
      </div>`
      )
      .join('');

    // 意图分布
    const intentItems = Object.entries(a.intentCount)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v], i) => ({
        label: Intent.INTENT_LABELS[k] || k,
        value: v,
        color: PALETTE[i % PALETTE.length],
      }));
    drawBar($('chartIntent'), intentItems);
    $('intentTotal').textContent = `共 ${intentItems.reduce((s, i) => s + i.value, 0)} 次识别`;
    $('legendIntent').innerHTML = intentItems
      .map((i) => `<span><i style="background:${i.color}"></i>${esc(i.label)}</span>`)
      .join('');

    // 满意度
    const csatColors = ['#0f9d58', '#4f46e5', '#d97706', '#dc2626', '#b91c1c'];
    drawDonut(
      $('chartCsat'),
      a.csatDist.map((d, i) => ({ ...d, color: csatColors[i] })),
      a.csatTotal ? a.avgCsat.toFixed(2) : '—',
      '平均评分'
    );
    $('csatMeta').textContent = `${a.csatTotal} 份 · 好评率 ${(a.goodRate * 100).toFixed(0)}%`;

    // 趋势
    drawLine($('chartTrend'), a.trend);

    // 回答来源
    const srcTotal = Object.values(a.sourceCount).reduce((s, v) => s + v, 0) || 1;
    $('sourceBars').innerHTML = Object.entries(a.sourceCount)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v], i) => {
        const pct = ((v / srcTotal) * 100).toFixed(1);
        return `<div class="bar-row">
          <span class="name">${esc(SOURCE_LABEL[k] || k)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${((v / srcTotal) * 100).toFixed(1)}%;background:${PALETTE[i % PALETTE.length]}"></span></span>
          <span class="num">${pct}%</span>
        </div>`;
      })
      .join('') || '<div class="empty">暂无数据</div>';

    // 未解决问题
    $('unsolvedList').innerHTML = a.unsolved.length
      ? a.unsolved
          .map(
            (u, i) => `<div class="bar-row">
              <span class="name" style="width:24px;color:var(--brand);font-weight:700">${i + 1}</span>
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(u.text)}">${esc(u.text)}</span>
              <span class="num">${u.count} 次</span>
            </div>`
          )
          .join('')
      : '<div class="empty">暂无兜底记录，说明知识库覆盖率良好 🎉</div>';
  }

  function renderSessions(filter) {
    const list = $('sessionList');
    let sessions = DATA.sessions.slice();
    if (filter === 'transferred') sessions = sessions.filter((s) => s.transferred);
    if (filter === 'open') sessions = sessions.filter((s) => s.status === 'open');

    if (!sessions.length) {
      list.innerHTML = '<div class="empty">暂无会话</div>';
      return;
    }

    list.innerHTML = sessions
      .map((s) => {
        const msgs = DATA.messages.filter((m) => m.session_id === s.id);
        const first = msgs.find((m) => m.role === 'user');
        const fb = DATA.feedbacks.find((f) => f.session_id === s.id);
        const tkt = DATA.tickets.find((t) => t.session_id === s.id);
        return `<div class="replay-item" data-id="${esc(s.id)}">
          <div class="t">${esc(first ? first.content.slice(0, 18) : '（无消息）')}${first && first.content.length > 18 ? '…' : ''}</div>
          <div class="d">${fmtTime(s.created_at)} · ${s.message_count || msgs.length} 条
            ${s.transferred ? ' · <span style="color:var(--amber)">已转人工</span>' : ''}
            ${fb ? ` · ${fb.score}★` : ''}</div>
        </div>`;
      })
      .join('');

    list.querySelectorAll('.replay-item').forEach((el) => {
      el.addEventListener('click', () => {
        list.querySelectorAll('.replay-item').forEach((x) => x.classList.remove('active'));
        el.classList.add('active');
        renderSessionDetail(el.dataset.id);
      });
    });
  }

  function renderSessionDetail(id) {
    const s = DATA.sessions.find((x) => x.id === id);
    if (!s) return $('sessionDetail').innerHTML = '<div class="empty">会话不存在</div>';
    const msgs = DATA.messages.filter((m) => m.session_id === id);
    const fb = DATA.feedbacks.find((f) => f.session_id === id);
    const tkt = DATA.tickets.find((t) => t.session_id === id);

    const meta = `<div style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border)">
      <div class="row" style="margin-bottom:6px">
        <strong>会话 ${esc(id.slice(0, 8))}</strong>
        <span class="chip">${esc(s.channel)}</span>
        <span class="chip ${s.transferred ? 'amber' : 'green'}">${esc(s.status)}</span>
        ${fb ? `<span class="chip green">满意度 ${fb.score}★</span>` : ''}
      </div>
      <div class="muted" style="font-size:12px">开始 ${fmtTime(s.created_at)} · 更新 ${fmtTime(s.updated_at)} · ${msgs.length} 条消息</div>
      ${tkt ? `<div style="margin-top:8px;padding:8px 10px;background:var(--amber-soft);border-radius:8px;font-size:12px">
        🎫 工单：${esc(tkt.reason)}（优先级 ${esc(tkt.priority)}，状态 ${esc(tkt.status)}）</div>` : ''}
      ${fb && fb.comment ? `<div style="margin-top:6px;font-size:12px" class="muted">评价留言：${esc(fb.comment)}</div>` : ''}
    </div>`;

    const bubbles = msgs
      .map((m) => {
        if (m.role === 'user') {
          return `<div class="msg-row user"><div class="msg-avatar">我</div>
            <div class="bubble-wrap"><div class="bubble">${esc(m.content)}</div></div></div>`;
        }
        const conf = m.confidence != null ? Number(m.confidence) : null;
        const confCls = conf == null ? '' : conf >= 0.7 ? 'green' : conf >= 0.45 ? 'amber' : 'red';
        return `<div class="msg-row"><div class="msg-avatar">知</div>
          <div class="bubble-wrap">
            <div class="bubble">${esc(m.content).replace(/`([^`]+)`/g, '<code>$1</code>')}</div>
            <div class="msg-meta">
              ${m.intent ? `<span class="chip brand">${esc(Intent.INTENT_LABELS[m.intent] || m.intent)}</span>` : ''}
              ${conf != null ? `<span class="chip ${confCls}">${conf.toFixed(2)}</span>` : ''}
              ${m.source ? `<span class="chip">${esc(SOURCE_LABEL[m.source] || m.source)}</span>` : ''}
              ${m.latency_ms != null ? `<span class="chip">${m.latency_ms}ms</span>` : ''}
            </div>
          </div></div>`;
      })
      .join('');

    $('sessionDetail').innerHTML = meta + bubbles || '<div class="empty">无消息</div>';
  }

  function renderTickets() {
    const el = $('ticketList');
    if (!DATA.tickets.length) {
      el.innerHTML = '<div class="empty">暂无工单</div>';
      $('ticketMeta').textContent = '';
      return;
    }
    $('ticketMeta').textContent = `共 ${DATA.tickets.length} 条`;
    el.innerHTML = `<table><thead><tr>
      <th>工单号</th><th>转接原因</th><th>类目</th><th>优先级</th><th>状态</th><th>时间</th></tr></thead><tbody>
      ${DATA.tickets
        .map((t) => {
          const pcls = { urgent: 'red', high: 'amber', normal: '', low: '' }[t.priority] || '';
          return `<tr data-sid="${esc(t.session_id)}">
            <td class="mono">${esc(String(t.id).slice(0, 8).toUpperCase())}</td>
            <td>${esc(t.reason)}</td>
            <td>${esc(Intent.INTENT_LABELS[t.category] || t.category)}</td>
            <td><span class="chip ${pcls}">${esc({ urgent: '紧急', high: '高', normal: '普通', low: '低' }[t.priority] || t.priority)}</span></td>
            <td>${esc({ pending: '待处理', processing: '处理中', resolved: '已解决' }[t.status] || t.status)}</td>
            <td>${fmtTime(t.created_at)}</td>
          </tr>`;
        })
        .join('')}
      </tbody></table>`;
    el.querySelectorAll('tr[data-sid]').forEach((tr) => {
      tr.addEventListener('click', () => {
        switchTab('sessions');
        setTimeout(() => renderSessionDetail(tr.dataset.sid), 60);
      });
    });
  }

  function renderFeedbacks() {
    const el = $('fbList');
    if (!DATA.feedbacks.length) {
      el.innerHTML = '<div class="empty">暂无评价</div>';
      $('fbMeta').textContent = '';
      return;
    }
    const avg = DATA.feedbacks.reduce((a, b) => a + Number(b.score), 0) / DATA.feedbacks.length;
    $('fbMeta').textContent = `${DATA.feedbacks.length} 份 · 平均 ${avg.toFixed(2)}`;
    el.innerHTML = `<table><thead><tr><th>评分</th><th>会话</th><th>留言</th><th>时间</th></tr></thead><tbody>
      ${DATA.feedbacks
        .map(
          (f) => `<tr data-sid="${esc(f.session_id)}">
            <td>${'★'.repeat(Number(f.score))}<span style="color:var(--border-strong)">${'★'.repeat(5 - Number(f.score))}</span> <span class="muted">${f.score}.0</span></td>
            <td class="mono">${esc(String(f.session_id).slice(0, 8))}</td>
            <td class="truncate">${esc(f.comment || '—')}</td>
            <td>${fmtTime(f.created_at)}</td>
          </tr>`
        )
        .join('')}
      </tbody></table>`;
    el.querySelectorAll('tr[data-sid]').forEach((tr) => {
      tr.addEventListener('click', () => {
        switchTab('sessions');
        setTimeout(() => renderSessionDetail(tr.dataset.sid), 60);
      });
    });
  }

  function renderKnowledge() {
    const all = FAQ.all();
    const byCat = {};
    all.forEach((i) => (byCat[i.category] = (byCat[i.category] || 0) + 1));
    $('kbMeta').textContent = `共 ${all.length} 条 · ${Object.keys(byCat).length} 个类目`;
    $('kbList').innerHTML = `<table><thead><tr><th style="width:60px">类目</th><th>标准问法</th><th style="width:70px">别称</th></tr></thead><tbody>
      ${all
        .map(
          (i) => `<tr>
            <td><span class="chip brand">${esc(Intent.INTENT_LABELS[i.category] || i.category)}</span></td>
            <td>${esc(i.q)}</td>
            <td class="muted">${(i.aliases || []).length}</td>
          </tr>`
        )
        .join('')}
      </tbody></table>`;
  }

  function renderSettings() {
    const c = Config.load();
    const rows = [
      ['大模型', Config.llmReady() ? `已配置（${esc(c.llm.model)}）` : '未配置 · 使用内置规则引擎', Config.llmReady()],
      ['请求地址', esc(LLM.endpoint()), true],
      ['云数据库', Store.getMode() === 'supabase' ? 'Supabase（云端 Postgres）' : 'localStorage（浏览器本地）', Store.getMode() === 'supabase'],
      ['意图分类', c.agent.useLlmIntent ? '启用三层融合' : '仅规则+检索', true],
      ['回答生成', c.agent.useLlmAnswer ? '启用 RAG 生成' : '仅知识库原文', true],
      ['置信度阈值', String(c.agent.confidenceThreshold), true],
      ['连续未理解阈值', `${c.agent.maxLowConfidenceTurns} 轮`, true],
    ];
    $('settingsBody').innerHTML =
      `<table><tbody>${rows
        .map(
          ([k, v, ok]) => `<tr><td style="width:150px;font-weight:600">${esc(k)}</td>
          <td>${v}</td>
          <td style="width:70px"><span class="chip ${ok ? 'green' : 'amber'}">${ok ? '就绪' : '降级'}</span></td></tr>`
        )
        .join('')}</tbody></table>
      <div class="row" style="margin-top:16px">
        <button class="btn" id="btnClearLocal">清除本地数据</button>
        <span class="muted" style="font-size:12px">仅清除浏览器 localStorage 中的会话数据，云端 Supabase 数据需到控制台删除</span>
      </div>`;
    const b = $('btnClearLocal');
    if (b) {
      b.addEventListener('click', () => {
        if (!confirm('确认清除本地演示数据？该操作不可恢复。')) return;
        Store.clearLocal();
        toast('已清除本地数据');
        loadAll();
      });
    }
  }

  /* ================= Tab 切换 ================= */
  const TITLES = {
    overview: '数据概览', sessions: '对话记录', tickets: '人工工单',
    feedback: '满意度', knowledge: '知识库', settings: '数据源',
  };
  function switchTab(name) {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.tab === name));
    ['overview', 'sessions', 'tickets', 'feedback', 'knowledge', 'settings'].forEach((t) => {
      $('tab-' + t).style.display = t === name ? '' : 'none';
    });
    $('pageTitle').textContent = TITLES[name] || '';
    if (name === 'sessions') renderSessions($('sessionFilter').value);
    if (name === 'tickets') renderTickets();
    if (name === 'feedback') renderFeedbacks();
    if (name === 'knowledge') renderKnowledge();
    if (name === 'settings') renderSettings();
  }

  /* ================= 数据加载 ================= */
  async function loadAll() {
    Store.init();
    $('sideMode').textContent = '存储：' + (Store.getMode() === 'supabase' ? '云端 Supabase' : '本地 localStorage');
    try {
      const [sessions, messages, tickets, feedbacks] = await Promise.all([
        Store.listSessions(500),
        Store.listAllMessages(3000),
        Store.listTickets(500),
        Store.listFeedbacks(1000),
      ]);
      DATA = { sessions, messages, tickets, feedbacks: feedbacks || [] };
    } catch (e) {
      console.error(e);
      toast('数据加载失败：' + e.message);
      return;
    }
    const a = aggregate();
    renderOverview(a);
    $('pageMeta').textContent = `${a.totalSessions} 个会话 · ${a.totalMessages} 条消息 · 更新于 ${new Date().toLocaleTimeString('zh-CN')}`;
    const active = document.querySelector('.nav-item.active');
    if (active) switchTab(active.dataset.tab);
  }

  /* ================= 演示数据 ================= */
  const SEED_SCRIPTS = {
    refund: [['我想申请退款', 'refund'], ['订单号是20261015001122', 'refund']],
    order_query: [['我的订单怎么还没发货', 'order_query']],
    tech_support: [['App一打开就闪退', 'tech_support'], ['登录不上去', 'tech_support']],
    logistics: [['帮我查下物流到哪了', 'logistics']],
    account: [['优惠券用不了', 'account']],
    other: [['你们客服几点上班', 'other']],
  };

  async function seedDemo() {
    if (!confirm('将生成 7 天内的 30 个模拟会话（含消息、工单、评价）。继续？')) return;
    toast('正在生成演示数据…');
    const intents = Object.keys(SEED_SCRIPTS);
    for (let i = 0; i < 30; i++) {
      const intent = intents[Math.floor(Math.random() * intents.length)];
      const dayAgo = Math.floor(Math.random() * 7);
      const hour = 9 + Math.floor(Math.random() * 12);
      const start = new Date();
      start.setDate(start.getDate() - dayAgo);
      start.setHours(hour, Math.floor(Math.random() * 60), 0, 0);

      const script = SEED_SCRIPTS[intent];
      const transfer = Math.random() < 0.18;

      const s = await Store.createSession({
        user_id: 'demo_' + (1000 + i),
        channel: ['web', 'app', 'wechat'][i % 3],
        status: transfer ? 'transferred' : 'closed',
        transferred: transfer,
        created_at: start.toISOString(),
        updated_at: start.toISOString(),
      });

      let t = start.getTime();
      for (const [text, it] of script) {
        await Store.appendMessage({ session_id: s.id, role: 'user', content: text, created_at: new Date(t).toISOString() });
        t += 3000 + Math.random() * 4000;
        const conf = 0.62 + Math.random() * 0.34;
        const src = Math.random() < 0.65 ? 'faq' : Math.random() < 0.7 ? 'rule' : 'fallback';
        const hit = FAQ.search(text, 1)[0];
        const content = src === 'fallback'
          ? '抱歉，你描述的情况我暂时没有匹配到对应的解决方案，可以补充一下具体信息吗？'
          : hit ? hit.item.a : '已为你查询到相关信息。';
        await Store.appendMessage({
          session_id: s.id, role: 'agent', content,
          intent: it, confidence: Number(conf.toFixed(3)), source: src,
          latency_ms: Math.round(180 + Math.random() * 620),
          created_at: new Date(t).toISOString(),
        });
        t += 4000 + Math.random() * 8000;
      }

      if (transfer) {
        await Store.createTicket({
          session_id: s.id,
          reason: ['用户显式要求人工', '连续 2 轮未能理解', '检测到强烈负面情绪'][Math.floor(Math.random() * 3)],
          category: intent,
          priority: ['normal', 'high', 'urgent'][Math.floor(Math.random() * 3)],
          status: ['pending', 'processing', 'resolved'][Math.floor(Math.random() * 3)],
          summary: script.map((x) => x[0]).join(' | '),
          created_at: new Date(t).toISOString(),
        });
      }

      if (Math.random() < 0.62) {
        const score = [1, 2, 3, 3, 4, 4, 4, 5, 5, 5, 5][Math.floor(Math.random() * 11)];
        await Store.createFeedback({
          session_id: s.id, score,
          comment: score >= 4 ? ['解决得挺快', '客服很耐心', '一次就解决了'][Math.floor(Math.random() * 3)] : score <= 2 ? ['没解决问题', '回复太慢', '答非所问'][Math.floor(Math.random() * 3)] : '',
          created_at: new Date(t + 60000).toISOString(),
        });
      }
    }
    toast('演示数据生成完成');
    loadAll();
  }

  /* ================= 事件 ================= */
  $('btnLogin').addEventListener('click', doLogin);
  $('passInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('btnRefresh').addEventListener('click', () => { loadAll(); toast('已刷新'); });
  $('btnSeed').addEventListener('click', seedDemo);
  $('sessionFilter').addEventListener('change', (e) => renderSessions(e.target.value));
  document.querySelectorAll('.nav-item').forEach((n) => {
    n.addEventListener('click', () => switchTab(n.dataset.tab));
  });
  window.addEventListener('resize', () => {
    if (DATA.sessions) renderOverview(aggregate());
  });

  /* ================= 启动 ================= */
  Store.init();
  if (checkLogin()) loadAll();
})();
