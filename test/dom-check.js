/**
 * dom-check.js — DOM 绑定静态校验
 * 比对 HTML 中定义的 id 与 JS 中引用的 id，提前发现拼写错误/遗漏元素。
 * 运行：node test/dom-check.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** 运行时动态生成的元素（不在静态 HTML 中），列入白名单 */
const DYNAMIC = new Set([
  'btnClearLocal',   // admin.js 在 renderSettings 中动态插入
  'fbComment', 'fbSubmit', 'fbSkip', 'stars', // chat.js 满意度卡片动态生成
  'typingRow',       // 动态插入的打字动画行
]);

function idsInHtml(file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const set = new Set();
  let m;
  const re = /\bid="([^"]+)"/g;
  while ((m = re.exec(html))) set.add(m[1]);
  return set;
}

function idsInJs(file) {
  const js = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const set = new Set();
  let m;
  const re1 = /\$\('([^']+)'\)/g;
  while ((m = re1.exec(js))) set.add(m[1]);
  const re2 = /getElementById\('([^']+)'\)/g;
  while ((m = re2.exec(js))) set.add(m[1]);
  return set;
}

const PAIRS = [
  { html: 'index.html', js: 'assets/js/chat.js', name: '客服对话端' },
  { html: 'admin.html', js: 'assets/js/admin.js', name: '管理后台' },
];

let bad = 0;
console.log('\n════════════ DOM 绑定校验 ════════════\n');

PAIRS.forEach(({ html, js, name }) => {
  const have = idsInHtml(html);
  const want = idsInJs(js);
  const missing = [...want].filter((id) => !have.has(id) && !DYNAMIC.has(id));
  const unused = [...have].filter((id) => !want.has(id));

  console.log(`${name}（${html} ↔ ${js}）`);
  console.log(`  HTML 定义 ${have.size} 个 id，JS 引用 ${want.size} 个`);
  if (missing.length) {
    bad++;
    console.log(`  ❌ JS 引用了但 HTML 中不存在的 id：${missing.join(', ')}`);
  } else {
    console.log('  ✅ 所有 JS 引用的 id 均存在');
  }
  if (unused.length) console.log(`  ℹ️  HTML 中定义但 JS 未引用（可能由事件委托处理）：${unused.join(', ')}`);
  console.log('');
});

// 校验脚本引用完整性
console.log('脚本引用完整性：');
['index.html', 'admin.html'].forEach((f) => {
  const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const links = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  // data: URI（如内联 SVG favicon）不是本地文件，跳过
  const missing = [...srcs, ...links].filter(
    (s) => !s.startsWith('data:') && !s.startsWith('http') && !fs.existsSync(path.join(ROOT, s))
  );
  if (missing.length) {
    bad++;
    console.log(`  ❌ ${f} 引用了不存在的文件：${missing.join(', ')}`);
  } else {
    console.log(`  ✅ ${f} 的 ${srcs.length} 个脚本 + ${links.length} 个样式全部存在`);
  }
});

console.log(bad === 0 ? '\n✅ DOM 校验通过\n' : `\n❌ 发现 ${bad} 处问题\n`);
process.exit(bad === 0 ? 0 : 1);
