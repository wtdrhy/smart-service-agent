/**
 * chat.js — 客服对话端交互
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const body = $('chatBody');
  const input = $('input');
  let session = null;
  let busy = false;
  let debugMode = localStorage.getItem('ssa_debug') === '1';
  let surveyShown = false;
  let turnCount = 0;
  let rendered = []; // 已渲染的消息，用于切换调试模式时整体重绘

  const QUICKS = [
    '怎么申请退款',
    '我的订单还没发货',
    'App 一直闪退打不开',
    '帮我查一下物流',
    '优惠券为什么用不了',
    '转人工',
  ];

  /* ---------------- 基础 UI ---------------- */
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function esc(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&', '<': '<', '>': '>' }[c]));
  }

  /** 轻量 markdown：反引号代码 + 换行 */
  function render(text) {
    return esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function scrollBottom() {
    body.scrollTop = body.scrollHeight;
  }

  function addBubble(role, content, meta) {
    rendered.push({ role, content, meta });
    const row = document.createElement('div');
    row.className = 'msg-row ' + (role === 'user' ? 'user' : role === 'system' ? 'system' : '');
    const av = role === 'user' ? '我' : role === 'system' ? '·' : '知';
    let metaHtml = '';
    if (debugMode && meta && role === 'agent') {
      const r = meta.intent || {};
      const conf = typeof r.confidence === 'number' ? r.confidence : 0;
      const confChip = conf >= 0.7 ? 'green' : conf >= 0.45 ? 'amber' : 'red';
      const srcMap = { llm: 'LLM生成', faq: '知识库', rule: '业务查询', slot: '槽位追问', human: '转人工', fallback: '兜底' };
      metaHtml = `<div class="msg-meta">
        <span class="chip brand">${esc(r.intentText || '未知意图')}</span>
        <span class="chip ${confChip}">置信 ${conf.toFixed(2)}</span>
        <span class="chip">${esc(srcMap[meta.source] || meta.source || '')}</span>
        <span class="chip">${meta.latency}ms</span>
        ${r.sentiment && r.sentiment.label === 'negative' ? '<span class="chip red">负面情绪</span>' : ''}
      </div>`;
      if (r.layers) {
        const L = r.layers;
        metaHtml += `<div class="msg-meta">
          <span class="chip blue">规则层 ${L.rule.intent || '—'}</span>
          <span class="chip blue">检索层 ${L.faq.intent || '—'}</span>
          <span class="chip blue">模型层 ${L.llm.skipped ? '未启用' : (L.llm.intent || '—')}</span>
        </div>`;
      }
      if (meta.faqHits && meta.faqHits.length) {
        metaHtml += `<div class="cite">知识库召回：${meta.faqHits.map((h) => `${esc(h.q)} (${h.score})`).join(' ｜ ')}</div>`;
      }
    }
    row.innerHTML = `
      <div class="msg-avatar">${av}</div>
      <div class="bubble-wrap">
        <div class="bubble">${render(content)}</div>
        ${metaHtml}
      </div>`;
    body.appendChild(row);
    scrollBottom();
    return row;
  }

  /** 整体重绘：切换调试模式时，让历史消息也带上意图/置信度标签 */
  function rerender() {
    const saved = rendered.slice();
    rendered = [];
    body.innerHTML = '';
    saved.forEach((m) => addBubble(m.role, m.content, m.meta));
  }

  function showTyping() {
    const row = document.createElement('div');
    row.className = 'msg-row';
    row.id = 'typingRow';
    row.innerHTML = `
      <div class="msg-avatar">知</div>
      <div class="bubble-wrap">
        <div class="bubble typing"><span></span><span></span><span></span></div>
      </div>`;
    body.appendChild(row);
    scrollBottom();
  }

  function hideTyping() {
    const t = $('typingRow');
    if (t) t.remove();
  }

  /* ---------------- 满意度 ---------------- */
  function showSurvey() {
    if (surveyShown) return;
    surveyShown = true;
    const area = $('surveyArea');
    area.innerHTML = `
      <div class="survey">
        <p>这次服务你还满意吗？</p>
        <div class="stars" id="stars">
          ${[1, 2, 3, 4, 5].map((i) => `<div class="star" data-s="${i}">${'★'.repeat(1)} ${i}</div>`).join('')}
        </div>
        <textarea id="fbComment" placeholder="还有什么想告诉我们的？（选填）"></textarea>
        <div class="row" style="margin-top:9px">
          <button class="btn primary" id="fbSubmit">提交评价</button>
          <button class="btn ghost" id="fbSkip">暂不评价</button>
        </div>
      </div>`;
    let score = 0;
    area.querySelectorAll('.star').forEach((s) => {
      s.addEventListener('click', () => {
        score = Number(s.dataset.s);
        area.querySelectorAll('.star').forEach((x) => x.classList.toggle('on', Number(x.dataset.s) <= score));
      });
    });
    $('fbSubmit').addEventListener('click', async () => {
      if (!score) return toast('请先选择 1-5 星');
      await Agent.submitFeedback(session.session.id, score, $('fbComment').value.trim());
      area.innerHTML = '';
      addBubble('system', `感谢你的 ${score} 星评价，已记录到后台统计 🙌`);
    });
    $('fbSkip').addEventListener('click', () => { area.innerHTML = ''; });
    scrollBottom();
  }

  /* ---------------- 发送 ---------------- */
  async function send(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    busy = true;
    $('btnSend').disabled = true;

    addBubble('user', text);
    input.value = '';
    autoGrow();
    showTyping();

    try {
      const out = await session.handle(text);
      // 依据来源模拟自然停顿
      const delay = out.meta.source === 'llm' ? 420 : out.meta.source === 'human' ? 300 : 240;
      await new Promise((r) => setTimeout(r, Math.min(900, delay)));
      hideTyping();
      addBubble('agent', out.content, out.meta);
      turnCount++;

      if (out.meta.transferred) {
        setTimeout(showSurvey, 900);
      } else if (turnCount >= 3) {
        setTimeout(showSurvey, 1400);
      }
    } catch (e) {
      hideTyping();
      console.error(e);
      addBubble('agent', '抱歉，服务开小差了，请再试一次；如果持续报错，直接说「转人工」。');
    } finally {
      busy = false;
      $('btnSend').disabled = false;
      input.focus();
    }
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(120, input.scrollHeight) + 'px';
  }

  /* ---------------- 快捷问题 ---------------- */
  function renderQuicks() {
    const row = $('quickRow');
    row.innerHTML = '';
    QUICKS.forEach((q) => {
      const b = document.createElement('button');
      b.className = 'quick';
      b.textContent = q;
      b.addEventListener('click', () => send(q));
      row.appendChild(b);
    });
  }

  /* ---------------- 状态显示 ---------------- */
  function refreshStatus() {
    const cfg = Config.load();
    const llmOn = Config.llmReady();
    $('llmDot').className = 'dot' + (llmOn ? '' : ' off');
    $('modeText').textContent = llmOn ? 'LLM 模式 · ' + cfg.llm.model : '演示模式 · 内置规则引擎';
    $('dbText').textContent = Store.getMode() === 'supabase' ? '云端数据库 · Supabase' : '本地存储';
    $('botName').textContent = cfg.ui.botName;
    $('btnDebug').textContent = debugMode ? '隐藏调试信息' : '调试面板';
  }

  /* ---------------- 设置面板 ---------------- */
  function openSetting() {
    const c = Config.load();
    $('cfgApiKey').value = c.llm.apiKey || '';
    $('cfgProxy').value = c.llm.proxyUrl || '';
    $('cfgModel').value = c.llm.model;
    $('cfgDbUrl').value = c.db.url || '';
    $('cfgDbKey').value = c.db.anonKey || '';
    $('cfgThreshold').value = c.agent.confidenceThreshold;
    $('cfgMaxLow').value = c.agent.maxLowConfidenceTurns;
    $('cfgUseLlmIntent').checked = c.agent.useLlmIntent;
    $('cfgUseLlmAnswer').checked = c.agent.useLlmAnswer;
    $('settingModal').style.display = 'grid';
    updateStatusLines();
  }

  async function updateStatusLines() {
    $('llmStatus').textContent = Config.llmReady() ? '大模型：已配置 Key，点击「测试连通性」验证' : '大模型：未配置 Key，当前使用内置规则引擎（全流程可正常运行）';
    const dbOk = Config.dbReady();
    $('dbStatus').textContent = dbOk
      ? '云数据库：已配置 Supabase，数据将写入云端 Postgres'
      : '云数据库：未配置，数据暂存在浏览器 localStorage';
  }

  function collectCfg() {
    return {
      llm: {
        apiKey: $('cfgApiKey').value.trim(),
        proxyUrl: $('cfgProxy').value.trim(),
        model: $('cfgModel').value,
      },
      db: {
        url: $('cfgDbUrl').value.trim(),
        anonKey: $('cfgDbKey').value.trim(),
      },
      agent: {
        confidenceThreshold: Number($('cfgThreshold').value) || 0.45,
        maxLowConfidenceTurns: Number($('cfgMaxLow').value) || 2,
        useLlmIntent: $('cfgUseLlmIntent').checked,
        useLlmAnswer: $('cfgUseLlmAnswer').checked,
      },
    };
  }

  /* ---------------- 事件绑定 ---------------- */
  $('btnSend').addEventListener('click', () => send(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input.value);
    }
  });
  input.addEventListener('input', autoGrow);

  $('btnSetting').addEventListener('click', openSetting);
  $('btnCloseSetting').addEventListener('click', () => { $('settingModal').style.display = 'none'; });
  $('settingModal').addEventListener('click', (e) => {
    if (e.target === $('settingModal')) $('settingModal').style.display = 'none';
  });

  $('btnDebug').addEventListener('click', () => {
    debugMode = !debugMode;
    localStorage.setItem('ssa_debug', debugMode ? '1' : '0');
    refreshStatus();
    rerender();
    toast(debugMode ? '已开启调试信息：显示意图、置信度、召回片段' : '已隐藏调试信息');
  });

  $('btnAdmin').addEventListener('click', () => { location.href = 'admin.html'; });

  $('btnNew').addEventListener('click', async () => {
    body.innerHTML = '';
    rendered = [];
    $('surveyArea').innerHTML = '';
    surveyShown = false;
    turnCount = 0;
    session = await Agent.start({ channel: 'web' });
    addBubble('system', `新会话已创建 · ID ${session.session.id.slice(0, 8)}`);
    addBubble('agent', Config.load().ui.welcome);
    toast('已开启新会话');
  });

  $('btnResetCfg').addEventListener('click', () => {
    Config.reset();
    openSetting();
    toast('已恢复默认配置');
  });

  $('btnTestCfg').addEventListener('click', async () => {
    Config.save(collectCfg());
    Store.init();
    const l = await LLM.ping();
    $('llmStatus').textContent = '大模型：' + l.msg;
    if (Config.dbReady()) {
      try {
        await Store.listSessions(1);
        $('dbStatus').textContent = '云数据库：连接成功 ✅ 数据将写入 Supabase';
      } catch (e) {
        $('dbStatus').textContent = '云数据库：连接失败 ❌ ' + e.message;
      }
    } else {
      $('dbStatus').textContent = '云数据库：未配置，数据暂存在浏览器 localStorage';
    }
  });

  $('btnSaveCfg').addEventListener('click', () => {
    Config.save(collectCfg());
    Store.init();
    refreshStatus();
    $('settingModal').style.display = 'none';
    toast('配置已保存，新配置将在下一轮对话生效');
  });

  /* ---------------- 启动 ---------------- */
  (async function boot() {
    Store.init();
    refreshStatus();
    renderQuicks();
    session = await Agent.start({ channel: 'web' });
    addBubble('system', `会话已创建 · ID ${session.session.id.slice(0, 8)} · 存储模式：${Store.getMode() === 'supabase' ? '云端 Supabase' : '本地'}`);
    addBubble('agent', Config.load().ui.welcome);
    input.focus();
  })();
})();
