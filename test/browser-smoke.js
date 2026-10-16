/**
 * browser-smoke.js — 浏览器级冒烟测试（jsdom）
 * ---------------------------------------------------------------
 * 真实加载页面并执行脚本，模拟用户输入，捕获运行时错误。
 * 覆盖静态分析发现不到的问题：DOM 绑定、事件、异步流程、渲染异常。
 *
 * 前置：先启动本地静态服务
 *   python -m http.server 8123
 * 运行：node test/browser-smoke.js   （可用 BASE_URL 环境变量换端口）
 */
const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123';

/** jsdom 不实现 Canvas，用 Proxy 造一个空的 2D context，避免图表代码抛错 */
const noop = () => {};
function mockCanvasContext() {
  return new Proxy(
    {},
    {
      get(_t, p) {
        if (p === 'canvas') return null;
        if (p === 'createLinearGradient') return () => ({ addColorStop: noop });
        if (p === 'measureText') return () => ({ width: 10 });
        return noop;
      },
      set: () => true,
    }
  );
}

function makeConsole(errors, tag) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(`[${tag}] jsdomError: ${e.message}`));
  vc.on('error', (...a) => errors.push(`[${tag}] console.error: ${a.join(' ')}`));
  vc.on('warn', () => {});
  vc.on('log', () => {});
  vc.on('info', () => {});
  return vc;
}

async function waitFor(fn, timeout = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let ok = false;
    try { ok = fn(); } catch (e) { /* DOM 未就绪时忽略 */ }
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  console.log(`   ⏱ 等待超时：${label}`);
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ==================== 客服对话端 ==================== */
async function testChat() {
  console.log('\n──────── 客服对话端（index.html）────────');
  const errors = [];
  const dom = await JSDOM.fromURL(BASE + '/index.html', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: makeConsole(errors, 'chat'),
  });
  const { window } = dom;
  const doc = window.document;

  // 1. 欢迎语渲染
  const okBoot = await waitFor(() => doc.querySelectorAll('#chatBody .msg-row').length >= 2, 8000, '欢迎语');
  console.log(`   ${okBoot ? '✅' : '❌'} 页面初始化，渲染出 ${doc.querySelectorAll('#chatBody .msg-row').length} 条消息`);
  if (!okBoot) { dom.window.close(); return { errors, ok: false }; }

  // 2. 发送一条退款咨询
  async function send(text) {
    const t0 = Date.now();
    const before = doc.querySelectorAll('#chatBody .msg-row').length;
    const input = doc.getElementById('input');
    input.value = text;
    doc.getElementById('btnSend').click();
    // 注意：必须排除正在打字的占位行，否则它会被计入消息数导致等待提前结束
    const ok = await waitFor(
      () => !doc.getElementById('typingRow') && doc.querySelectorAll('#chatBody .msg-row').length >= before + 2,
      10000,
      `回复「${text}」`
    );
    const rows = [...doc.querySelectorAll('#chatBody .msg-row')];
    const last = rows[rows.length - 1];
    console.log(
      `      [诊断] before=${before} after=${rows.length} 耗时=${Date.now() - t0}ms sendDisabled=${doc.getElementById('btnSend').disabled}`
    );
    return { ok, content: last && last.querySelector('.bubble') ? last.querySelector('.bubble').textContent : '' };
  }

  const r1 = await send('怎么申请退款');
  console.log(`   ${r1.ok && r1.content.includes('退款') ? '✅' : '❌'} 咨询退款 → 回复含退款流程：${r1.ok ? '是' : '否'}`);
  console.log(`      回复摘要：${r1.content.slice(0, 60).replace(/\n/g, ' ')}…`);

  const r2 = await send('20261016123456');
  console.log(`   ${r2.ok ? '✅' : '❌'} 提供订单号 → 触发业务查询：${r2.content.slice(0, 40).replace(/\n/g, ' ')}…`);

  const r3 = await send('帮我转人工');
  const hasTicket = r3.content.includes('工单号');
  console.log(`   ${r3.ok && hasTicket ? '✅' : '❌'} 要求转人工 → 生成工单：${hasTicket ? '是' : '否'}`);

  // 3. 调试面板
  const dbg = doc.getElementById('btnDebug');
  dbg.click();
  await sleep(200);
  const chips = doc.querySelectorAll('#chatBody .chip').length;
  console.log(`   ${chips > 0 ? '✅' : '❌'} 调试面板展示意图/置信度标签：${chips} 个`);

  // 4. 设置面板可打开
  doc.getElementById('btnSetting').click();
  await sleep(200);
  const modalOpen = window.getComputedStyle(doc.getElementById('settingModal')).display !== 'none';
  console.log(`   ${modalOpen ? '✅' : '❌'} 设置面板可正常打开`);

  // 5. 数据确实落到了 localStorage
  const keys = Object.keys(window.localStorage).filter((k) => k.startsWith('ssa_db_'));
  console.log(`   ${keys.length ? '✅' : '❌'} 数据持久化：${keys.join(', ')}`);

  dom.window.close();
  const ok = okBoot && r1.ok && r2.ok && r3.ok && hasTicket && chips > 0 && modalOpen && keys.length > 0;
  return { errors, ok };
}

/* ==================== 管理后台 ==================== */
async function testAdmin() {
  console.log('\n──────── 管理后台（admin.html）────────');
  const errors = [];
  const dom = await JSDOM.fromURL(BASE + '/admin.html', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: makeConsole(errors, 'admin'),
    beforeParse(window) {
      window.HTMLCanvasElement.prototype.getContext = mockCanvasContext;
      window.confirm = () => true;
      window.alert = () => {};
    },
  });
  const { window } = dom;
  const doc = window.document;

  // 0. 等脚本就绪（HTML 是静态的，但事件绑定要等 admin.js 执行完）
  await waitFor(() => window.Config && window.Store && window.FAQ, 8000, '后台脚本就绪');

  // 1. 登录页存在
  const hasLogin = !!doc.getElementById('loginView');
  console.log(`   ${hasLogin ? '✅' : '❌'} 登录页渲染`);

  // 2. 错误口令
  doc.getElementById('passInput').value = 'wrong';
  doc.getElementById('btnLogin').click();
  await sleep(200);
  const errShown = doc.getElementById('loginErr').textContent.length > 0;
  console.log(`   ${errShown ? '✅' : '❌'} 错误口令被拒绝`);

  // 3. 正确口令
  doc.getElementById('passInput').value = 'admin2026';
  doc.getElementById('btnLogin').click();
  const okLogin = await waitFor(
    () => window.getComputedStyle(doc.getElementById('adminView')).display !== 'none',
    8000,
    '登录进入'
  );
  console.log(`   ${okLogin ? '✅' : '❌'} 正确口令进入后台`);

  // 4. 统计卡片
  const okStats = await waitFor(() => doc.querySelectorAll('#statGrid .stat-card').length >= 6, 8000, '统计卡片');
  console.log(`   ${okStats ? '✅' : '❌'} 统计卡片渲染：${doc.querySelectorAll('#statGrid .stat-card').length} 张`);

  // 5. 生成演示数据
  doc.getElementById('btnSeed').click();
  const okSeed = await waitFor(() => Number(doc.getElementById('pageMeta').textContent.match(/(\d+) 个会话/)?.[1] || 0) > 0, 25000, '演示数据');
  const meta = doc.getElementById('pageMeta').textContent;
  console.log(`   ${okSeed ? '✅' : '❌'} 演示数据生成：${meta.split('·').slice(0, 2).join('·').trim()}`);

  // 6. 切到对话记录
  doc.querySelector('.nav-item[data-tab="sessions"]').click();
  await sleep(400);
  const sessionCount = doc.querySelectorAll('#sessionList .replay-item').length;
  console.log(`   ${sessionCount > 0 ? '✅' : '❌'} 会话列表：${sessionCount} 条`);

  // 7. 点开第一条看回放
  if (sessionCount > 0) {
    doc.querySelector('#sessionList .replay-item').click();
    await sleep(400);
    const bubbles = doc.querySelectorAll('#sessionDetail .msg-row').length;
    console.log(`   ${bubbles > 0 ? '✅' : '❌'} 对话回放：${bubbles} 条消息`);
  }

  // 8. 各 Tab 切换不报错
  for (const tab of ['tickets', 'feedback', 'knowledge', 'settings']) {
    doc.querySelector(`.nav-item[data-tab="${tab}"]`).click();
    await sleep(250);
    const visible = doc.getElementById('tab-' + tab).style.display !== 'none';
    console.log(`   ${visible ? '✅' : '❌'} Tab「${tab}」切换正常`);
  }

  dom.window.close();
  return { errors, ok: okLogin && okStats && okSeed };
}

/* ==================== 主流程 ==================== */
(async () => {
  console.log('\n════════════ 浏览器级冒烟测试 ════════════');
  const chat = await testChat();
  const admin = await testAdmin();

  const allErrors = [...chat.errors, ...admin.errors];
  console.log('\n──────── 运行时错误 ────────');
  if (allErrors.length === 0) {
    console.log('   ✅ 无 console.error / 未捕获异常');
  } else {
    allErrors.slice(0, 20).forEach((e) => console.log('   ❌ ' + e));
  }

  const ok = chat.ok && admin.ok && allErrors.length === 0;
  console.log(`\n${ok ? '✅ 浏览器冒烟测试通过' : '❌ 存在问题，请检查上方输出'}\n`);
  process.exit(ok ? 0 : 1);
})();
