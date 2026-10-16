/**
 * tune.js — 检索超参网格扫描
 * 对「绝对门槛 absFloor × 衰减陡度 power × 命中阈值 threshold」做网格搜索，
 * 用「口语化召回率」与「无关问题拦截率」的加权 F 值选最优组合，避免拍脑袋调参。
 * 运行：node test/tune.js
 */
const fs = require('fs');
const path = require('path');
const DS = require('./dataset.js');

const mem = {};
global.window = global;
global.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
global.performance = { now: () => Date.now() };
global.crypto = require('crypto').webcrypto;
global.fetch = () => Promise.reject(new Error('no-net'));

const ROOT = path.join(__dirname, '..');
['assets/js/config.js', 'data/faq.data.js', 'assets/js/faq.js'].forEach((f) =>
  new Function(fs.readFileSync(path.join(ROOT, f), 'utf8'))()
);

const STANDARD = DS.buildStandard(FAQ);

function metrics(threshold) {
  let stdTop1 = 0, colTop1 = 0, colRecall = 0, blocked = 0;

  STANDARD.forEach(([q, expect]) => {
    const h = FAQ.search(q, 1)[0];
    if (h && h.item.id === expect) stdTop1++;
  });
  DS.COLLOQUIAL.forEach(([q, expect]) => {
    const h = FAQ.search(q, 1)[0];
    if (h && h.item.id === expect) colTop1++;
    if (h && h.score >= threshold) colRecall++;
  });
  DS.NEGATIVE.forEach((q) => {
    const h = FAQ.search(q, 1)[0];
    if (!h || h.score < threshold) blocked++;
  });

  return {
    stdTop1: stdTop1 / STANDARD.length,
    colTop1: colTop1 / DS.COLLOQUIAL.length,
    colRecall: colRecall / DS.COLLOQUIAL.length,
    block: blocked / DS.NEGATIVE.length,
  };
}

const FLOORS = [3.0, 3.5, 4.0, 4.5, 5.0, 6.0];
const POWERS = [1, 1.5, 2, 2.5, 3];
const THRESHOLDS = [0.45, 0.5, 0.55, 0.6];

const rows = [];
for (const th of THRESHOLDS) {
  for (const floor of FLOORS) {
    for (const power of POWERS) {
      FAQ.setTuning({ absFloor: floor, power });
      const m = metrics(th);
      // 综合分：口语召回与无关拦截的调和平均（F1），两者都重要，不能偏废
      const f1 = m.colRecall + m.block > 0
        ? (2 * m.colRecall * m.block) / (m.colRecall + m.block)
        : 0;
      rows.push({ th, floor, power, ...m, f1 });
    }
  }
}

rows.sort((a, b) => b.f1 - a.f1 || b.colTop1 - a.colTop1);

console.log('\n════════════ 超参网格扫描（按 F1 降序，Top 12）════════════\n');
console.log('阈值   门槛  陡度 | 标准Top1  口语Top1  口语召回  无关拦截 |  F1');
console.log('─'.repeat(72));
rows.slice(0, 12).forEach((r) => {
  const pct = (v) => (v * 100).toFixed(1).padStart(6) + '%';
  console.log(
    `${r.th.toFixed(2)}  ${r.floor.toFixed(1).padStart(4)}  ${String(r.power).padStart(4)} | ` +
    `${pct(r.stdTop1)} ${pct(r.colTop1)} ${pct(r.colRecall)} ${pct(r.block)} | ${r.f1.toFixed(4)}`
  );
});

const best = rows[0];
console.log('\n推荐配置：');
console.log(`  absFloor  = ${best.floor}`);
console.log(`  power     = ${best.power}`);
console.log(`  threshold = ${best.th}`);
console.log(`  标准问法 Top1 ${(best.stdTop1 * 100).toFixed(1)}% ｜ 口语 Top1 ${(best.colTop1 * 100).toFixed(1)}% ｜ 口语召回 ${(best.colRecall * 100).toFixed(1)}% ｜ 无关拦截 ${(best.block * 100).toFixed(1)}%`);
console.log('\n将该组合写入 assets/js/faq.js 的 TUNING 与 assets/js/agent.js 的命中阈值即可。\n');
