/* ============================================================================
 * probe_negative.js —— 测「多远之后就是负收益」
 *
 * 用户在问一件事：**收益-成本 什么时候由正转负。**
 * 这里的定义必须写清楚，否则「负收益」可以指三件完全不同的事：
 *
 *   A. 生长水耗回收期 —— 连这一格花的本钱，靠它自己的产出要多少秒回本。
 *      只在「水稀缺」的前中期成立。
 *
 *   B. 稳态水收支（本探针采用）—— 这一格接进来之后，它自己产的水
 *      能否覆盖「自己的生长摊销 + 自己要交的维持费」：
 *          净水/s = 产出水/s  -  维持费/s  -  生长成本摊销/s
 *
 *   C. 养分/孢子对水的兑换率 —— 更细，暂不测。
 *
 * 用法： node tools/probe_negative.js [回收窗口秒数]
 * ==========================================================================*/
'use strict';

const path = require('path');
const BASE = path.dirname(__dirname);
const C = require(path.join(BASE, 'src', 'config.js'));

const RECOVER_SEC = Number(process.argv[2]) || 60;

function eff(dist, lv) {
  const loss = C.TRANSPORT.distLoss * Math.pow(C.TRANSPORT.transportDecay, lv);
  return 1 / (1 + dist * loss);
}
function maintain(level) { return level * level * C.MAINT.costPerLevel; }
function growCost(soil, dist, up) {
  let c = C.SOILS[soil].growCost * (1 + C.GROW.distCost * dist);
  c *= Math.pow(0.93, (up && up.growth) || 0);
  return Math.max(1, Math.round(c));
}
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
function padL(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }

function netWater(soil, dist, level, up, genes) {
  const base = (C.SOILS[soil].yield || {}).water || 0;
  const hydration = 1 + 0.18 * ((up && up.hydration) || 0);
  const gYield = 1 + 0.12 * ((genes && genes.gYield) || 0);
  const lvl = 1 + C.NODE_UP.yieldPerLevel * level;
  const prod = base * hydration * gYield * lvl * eff(dist, (up && up.transport) || 0);
  const amort = growCost(soil, dist, up) / RECOVER_SEC;
  return { prod, maintain: maintain(level), amort, net: prod - maintain(level) - amort };
}

console.log('================================================================');
console.log(' 多远之后是负收益  ——  生长成本按 ' + RECOVER_SEC + 's 摊销');
console.log('================================================================');

console.log('');
console.log('1. 距离效率（产出乘数，三种资源都乘）');
console.log('');
console.log(' 距离  ' + pad('Lv0', 7) + pad('Lv2', 7) + pad('Lv5', 7) + pad('Lv8', 7) + '逐格边际(Lv0)');
let prev = null;
for (const d of [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20]) {
  const r = [0, 2, 5, 8].map(u => eff(d, u));
  const margin = prev == null ? '—' : ((r[0] - prev) / prev * 100).toFixed(1) + '%';
  console.log('  ' + pad(d, 6) + pad(r[0].toFixed(3), 7) + pad(r[1].toFixed(3), 7) +
    pad(r[2].toFixed(3), 7) + pad(r[3].toFixed(3), 7) + margin);
  prev = r[0];
}

console.log('');
console.log('2. 净水收支 · 裸格子（等级 0）');
['soil', 'vein'].forEach(function (soil) {
  const y = (C.SOILS[soil].yield || {}).water || 0;
  console.log('');
  console.log(' 【' + C.SOILS[soil].name + '】水 +' + y.toFixed(2) + '/s，生长价 ' + C.SOILS[soil].growCost);
  console.log('  距离  ' + pad('生长价', 8) + pad('产出/s', 9) + pad('摊销/s', 9) +
    pad('维持/s', 9) + pad('净水/s', 10) + '判定');
  for (const d of [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20]) {
    const r = netWater(soil, d, 0, {}, {});
    console.log('  ' + pad(d, 6) + pad(growCost(soil, d, {}), 8) + pad(r.prod.toFixed(3), 9) +
      pad(r.amort.toFixed(2), 9) + pad(r.maintain.toFixed(2), 9) +
      pad(r.net.toFixed(3), 10) + (r.net >= 0 ? '正' : '★负'));
  }
});

console.log('');
console.log('3. 关键 · 按等级看水脉的净水阈值（维持费 = 等级²×2.04/s）');
console.log('');
console.log('  等级  ' + pad('维持费/s', 10) + pad('水脉归负的距离', 16) + '说明');
[0, 1, 2, 3, 5, 7, 10].forEach(function (lv) {
  let t = null;
  for (let d = 0; d <= 80; d++) {
    if (netWater('vein', d, lv, {}, {}).net < 0) { t = d; break; }
  }
  console.log('  Lv' + pad(lv, 4) + pad(maintain(lv).toFixed(2), 10) +
    pad(t == null ? '从不归负' : t + ' 格', 16) +
    (lv >= 7 ? '← 免疫线' : ''));
});

console.log('');
console.log('4. 养分 / 孢子：距离阈值与水的对比');
console.log('   维持费只收水，所以养分孢子那边没有这个扣项 → 阈值更远');
console.log('');
[['litter', 0], ['wood', 0], ['root', 0]].forEach(function (p) {
  const soil = p[0];
  const y = C.SOILS[soil].yield || {};
  const res = y.nutrient ? '养分' : '孢子';
  const base = y.nutrient || y.spore || 0;
  let thr = null;
  for (let d = 0; d <= 60; d++) {
    if (base * eff(d, 0) - growCost(soil, d, {}) / RECOVER_SEC < 0) { thr = d; break; }
  }
  console.log('  ' + pad(C.SOILS[soil].name, 10) + res + ' +' + base +
    '/s  ' + pad('生长价 ' + C.SOILS[soil].growCost, 12) +
    '裸格阈值 = ' + (thr == null ? '>60 格' : thr + ' 格'));
});

console.log('');
console.log('5. 若要做成「5 格后必负」，需要多大的惩罚');
console.log('   水脉与壤土各自的产出量级差 8 倍，同一个惩罚不可能同时压住两者');
console.log('');
console.log('  ' + pad('土壤', 12) + pad('5 格产出/s', 13) + pad('5 格需惩罚/s', 15) + '10 格需惩罚/s');
['soil', 'vein'].forEach(function (soil) {
  function need(d) {
    const y = (C.SOILS[soil].yield || {}).water || 0;
    return y * eff(d, 0) - growCost(soil, d, {}) / RECOVER_SEC - maintain(0);
  }
  const n5 = need(5), n10 = need(10);
  const y = (C.SOILS[soil].yield || {}).water || 0;
  console.log('  ' + pad(C.SOILS[soil].name, 12) +
    pad((y * eff(5, 0)).toFixed(3), 13) +
    pad(n5 > 0 ? n5.toFixed(3) : '已为负', 15) +
    (n10 > 0 ? n10.toFixed(3) : '已为负'));
});

console.log('');
console.log('6. 养分/孢子的「负收益」还要额外考虑：它们不发工资，只用来买升级/转生');
console.log('   即使某格养分净收益为负，它仍可能值得连 —— 因为它解锁了水脉或树根。');
console.log('   所以「负收益格」的惩罚不能做成硬禁止，否则会切断通往富矿的路。');
