/* 移动端布局验证：模拟 375×812 视口，检查关键元素位置 */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8124';

function fail(msg) {
  console.log('❌ ' + msg);
  process.exitCode = 1;
}

(async () => {
  const html = await (await fetch(`${BASE}/index.html`)).text();
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    url: `${BASE}/index.html`,
  });

  await new Promise((r) => setTimeout(r, 600));

  const { window } = dom;
  // 模拟 iPhone X 类窄屏，触发 @media (max-width: 640px)
  window.innerWidth = 375;
  window.innerHeight = 812;
  window.dispatchEvent(new window.Event('resize'));

  const doc = window.document;
  await new Promise((r) => setTimeout(r, 100));

  const head = doc.querySelector('.chat-head');
  const title = doc.querySelector('.chat-head h1');
  const actions = doc.querySelector('.head-actions');
  const computed = (el) => window.getComputedStyle(el);

  const headStyle = computed(head);
  const actionsStyle = computed(actions);
  const titleRect = title.getBoundingClientRect();

  console.log('════════════ 移动端布局验证（375×812）════════════');
  console.log(`window.innerWidth: ${window.innerWidth}px`);
  console.log(`头部 flex-wrap: ${headStyle.flexWrap}`);
  console.log(`操作区 width: ${actionsStyle.width}`);
  console.log(`标题实际宽度: ${titleRect.width.toFixed(1)}px`);

  const ok1 = headStyle.flexWrap === 'wrap';
  const ok2 = actionsStyle.width === '100%' || parseFloat(actionsStyle.width) >= 350;
  const ok3 = titleRect.width > 180; // 确保标题没被挤成竖排

  if (!ok1) fail('头部未在移动端换行');
  if (!ok2) fail('操作区未占满整行');
  if (!ok3) fail(`标题区过窄（${titleRect.width.toFixed(1)}px），可能被竖排`);

  if (ok1 && ok2 && ok3) {
    console.log('✅ 移动端头部布局适配通过');
  }

  dom.window.close();
})();
