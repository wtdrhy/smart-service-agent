/**
 * smoke.js — 无头逻辑冒烟测试（Node 环境）
 * 验证 FAQ 检索质量与三层意图识别准确率，不依赖浏览器与网络。
 * 运行：node test/smoke.js
 */
const fs = require('fs');
const path = require('path');

/* ---------- 模拟浏览器环境 ---------- */
const mem = {};
global.window = global;
global.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
};
global.performance = { now: () => Number(process.hrtime.bigint() / 1000000n) };
global.crypto = require('crypto').webcrypto;
global.fetch = () => Promise.reject(new Error('TEST_NO_NETWORK'));

const ROOT = path.join(__dirname, '..');
function load(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // 在全局作用域执行，使 window.X = X 挂载到 global
  new Function(code)();
}

['assets/js/config.js', 'assets/js/store.js', 'assets/js/llm.js', 'data/faq.data.js',
 'assets/js/faq.js', 'assets/js/intent.js', 'assets/js/agent.js'].forEach(load);

/* ---------- 测试 ---------- */
const CASES = [
  ['怎么申请退款', 'refund'],
  ['我要退款', 'refund'],
  ['退款什么时候到账', 'refund'],
  ['我的订单还没发货', 'order_query'],
  ['帮我查一下订单', 'order_query'],
  ['订单发票怎么开', 'order_query'],
  ['app一直闪退打不开', 'tech_support'],
  ['登录不上账号怎么办', 'tech_support'],
  ['收不到验证码', 'tech_support'],
  ['支付一直失败', 'tech_support'],
  ['快递到哪了', 'logistics'],
  ['物流一直不动', 'logistics'],
  ['收到货少件了', 'logistics'],
  ['优惠券为什么用不了', 'account'],
  ['怎么注销账号', 'account'],
  ['我要转人工', 'human'],
  ['你们这什么垃圾服务我要投诉', 'complaint'],
  ['你好', 'greeting'],
  // 口语化变体（真实用户输入，考验泛化能力）
  ['我想把买的东西退了', 'refund'],
  ['钱啥时候能退回来', 'refund'],
  ['软件一打开就崩', 'tech_support'],
  ['快递卡住不动了', 'logistics'],
  ['拆开少了个东西', 'logistics'],
  ['券用不上咋回事', 'account'],
  ['地址填错了能改不', 'order_query'],
  ['付款老是报错', 'tech_support'],
];

async function run() {
  console.log('\n================ FAQ 检索质量 ================');
  const retrievalCases = [
    ['怎么退款', 'faq_refund_001'],
    ['app闪退', 'faq_tech_001'],
    ['快递不动了', 'faq_logi_002'],
    ['验证码收不到', 'faq_tech_004'],
    ['七天内能退货吗', 'faq_refund_004'],
    ['这个能退款吗', 'faq_refund_001'],   // 求流程，应命中「怎么申请退款」而非「退款被拒」
    ['退款失败了', 'faq_refund_003'],      // 报故障，应命中排障条目
  ];
  let rTop1 = 0;
  for (const [q, expect] of retrievalCases) {
    const hits = FAQ.search(q, 3);
    const top = hits[0];
    const ok = top && top.item.id === expect;
    if (ok) rTop1++;
    console.log(
      `${ok ? '✅' : '❌'} "${q}"  →  ${top ? top.item.id + ' (' + top.score.toFixed(2) + ')' : '无命中'}` +
      (ok ? '' : `   期望 ${expect}`)
    );
  }
  console.log(`检索 Top1 准确率：${rTop1}/${retrievalCases.length}`);

  console.log('\n================ 意图识别准确率 ================');
  let pass = 0;
  for (const [text, expect] of CASES) {
    const r = await Intent.recognize(text, []);
    const ok = r.intent === expect;
    if (ok) pass++;
    const layers = `规则=${r.layers.rule.intent || '-'} 检索=${r.layers.faq.intent || '-'} 模型=${r.layers.llm.skipped ? 'off' : (r.layers.llm.intent || '-')}`;
    console.log(
      `${ok ? '✅' : '❌'} "${text}"\n     预测=${r.intent}(${r.confidence.toFixed(2)}) 期望=${expect}  ${layers}` +
      (r.needHuman ? `\n     ⚠️ 触发转人工：${r.humanReasons.join('；')}` : '')
    );
  }
  console.log(`\n意图识别准确率：${pass}/${CASES.length} = ${((pass / CASES.length) * 100).toFixed(1)}%`);

  console.log('\n================ 多轮对话 + 槽位填充 ================');
  const s = await Agent.start({ channel: 'test' });
  const script = [
    '你好',
    '我买的东西一直没发货怎么办',
    '20261016123456',
    '这个能退款吗',
    '算了帮我转人工',
  ];
  for (const line of script) {
    const out = await s.handle(line);
    console.log(`\n👤 用户：${line}`);
    console.log(`🤖 ${out.meta.intent.intentText} | 置信 ${out.meta.intent.confidence.toFixed(2)} | 来源 ${out.meta.source} | ${out.meta.latency}ms`);
    console.log(`   ${out.content.split('\n').join('\n   ').slice(0, 320)}`);
  }

  console.log('\n================ 转人工兜底策略 ================');

  // 场景 A：用户明确要求人工
  const sa = await Agent.start({ channel: 'test' });
  const oa = await sa.handle('帮我转人工');
  console.log(`A. 显式要求人工 → 转人工=${!!oa.meta.transferred} 来源=${oa.meta.source} 工单=${oa.meta.ticket ? oa.meta.ticket.reason : '无'}`);

  // 场景 B：完全无法理解的输入，立即转人工
  const sb = await Agent.start({ channel: 'test' });
  const ob = await sb.handle('asdfghjkl 随便打点什么');
  console.log(`B. 完全无法理解   → 转人工=${!!ob.meta.transferred} 置信=${ob.meta.intent.confidence.toFixed(2)}`);

  // 场景 C：连续两轮未能理解（置信度中低），触发兜底
  const sc = await Agent.start({ channel: 'test' });
  const ctx = [
    { role: 'user', content: '嗯……那个东西' },
    { role: 'agent', content: '没太理解', lowConfidence: true },
    { role: 'user', content: '就那个' },
    { role: 'agent', content: '还是没理解', lowConfidence: true },
  ];
  const oc = await Intent.recognize('还是不行啊', ctx);
  console.log(`C. 连续2轮未理解  → 转人工=${oc.needHuman} 原因=${oc.humanReasons.join('；') || '无'}`);

  // 场景 D：负面情绪 + 投诉，必须转人工
  const sd = await Agent.start({ channel: 'test' });
  const od = await sd.handle('你们这什么垃圾服务，我要投诉！');
  console.log(`D. 投诉+负面情绪  → 转人工=${!!od.meta.transferred} 优先级=${od.meta.ticket ? od.meta.ticket.priority : '无'}`);

  // 场景 E：口语化但知识库能命中，不应误转人工
  const se = await Agent.start({ channel: 'test' });
  const oe = await se.handle('券用不上咋回事');
  console.log(`E. 口语化可回答   → 转人工=${!!oe.meta.transferred}（应为 false）置信=${oe.meta.intent.confidence.toFixed(2)}`);

  console.log('\n================ 数据落库校验 ================');
  const sessions = await Store.listSessions(10);
  const messages = await Store.listMessages(s.session.id, 100);
  const tickets = await Store.listTickets(10);
  console.log(`存储模式：${Store.getMode()}`);
  console.log(`会话数：${sessions.length} | 消息数：${messages.length} | 工单数：${tickets.length}`);
  console.log('消息轨迹：');
  messages.forEach((m) => {
    console.log(`  [${m.role}] ${m.intent || '-'} ${m.confidence != null ? Number(m.confidence).toFixed(2) : '-'} (${m.source || '-'}) ${m.content.slice(0, 46).replace(/\n/g, ' ')}`);
  });
  if (tickets.length) {
    console.log('工单：', JSON.stringify({ reason: tickets[0].reason, priority: tickets[0].priority, status: tickets[0].status }, null, 2));
  }

  const okAll = pass >= CASES.length * 0.8;
  console.log(`\n${okAll ? '✅ 冒烟测试通过' : '❌ 准确率不达标，需要调参'}\n`);
  process.exit(okAll ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
