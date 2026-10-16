/**
 * eval-retrieval.js — 检索器离线评估
 * 用「标准问法 + 口语化变体」做正例，用「无关问题」做负例，
 * 输出 Top1 准确率、召回率、误召回率。
 * 运行：node test/eval-retrieval.js
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

/** 与 agent.js 的 FAQ_HIT_THRESHOLD 保持一致 */
const THRESHOLD = 0.45;

function evalSet(cases, label) {
  let top1 = 0, recalled = 0;
  const fails = [];
  cases.forEach(([q, expect]) => {
    const h = FAQ.search(q, 1)[0];
    if (!h) { fails.push([q, '无命中', 0]); return; }
    if (h.score >= THRESHOLD) recalled++;
    if (h.item.id === expect) top1++;
    else fails.push([q, `${h.item.id}(${h.score.toFixed(2)})`, h.coverage]);
  });
  console.log(`${label}：共 ${cases.length} 条  Top1 ${top1}/${cases.length} (${((top1 / cases.length) * 100).toFixed(1)}%)  过阈值召回 ${recalled}/${cases.length} (${((recalled / cases.length) * 100).toFixed(1)}%)`);
  fails.forEach(([q, got, cov]) => console.log(`     ✗ "${q}" → ${got}  cov=${typeof cov === 'number' ? cov.toFixed(2) : '-'}`));
}

console.log('\n════════════ 检索器离线评估 ════════════\n');
evalSet(DS.buildStandard(FAQ), '标准问法（q + aliases）');
console.log('');
evalSet(DS.COLLOQUIAL, '口语化变体（真实用户输入）');

console.log('\n无关问题拦截（期望全部 score < ' + THRESHOLD + '）：');
let blocked = 0;
DS.NEGATIVE.forEach((q) => {
  const h = FAQ.search(q, 1)[0];
  const s = h ? h.score : 0;
  const ok = s < THRESHOLD;
  if (ok) blocked++;
  console.log(`  ${ok ? '✅' : '⚠️ '} "${q}" → ${h ? h.item.id + ' ' + s.toFixed(2) : '无命中'}`);
});
console.log(`\n拦截率：${blocked}/${DS.NEGATIVE.length} = ${((blocked / DS.NEGATIVE.length) * 100).toFixed(1)}%\n`);
