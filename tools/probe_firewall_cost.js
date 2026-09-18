/* ============================================================================
 * probe_firewall_cost.js — 防火墙（N 个 Lv(免疫线) 节点）在平方维持费下可行吗？
 *
 * 【为什么要这个探针】
 * 免疫线定在 Lv7、维持费改成平方之后，有一个必须回答的设计问题：
 *   玩家在后期到底**养得起**几个 Lv7？养不起 N 个，m9「防火墙」就是永远
 *   达不成的里程碑 —— 免疫线成了画饼，比没有还糟。
 *
 * 探针把账算清楚：
 *   ① 后期水**产量速率**是多少（用带升级的正常玩家跑，不是零升级挂机）；
 *   ② 一个 Lv7 每秒吃 100 水、N 个合计占水产量几成；
 *   ③ 练出 N 个 Lv7 要花多少养分；
 *   ④ 免疫线设在 5 / 6 / 7 的可行性对照。
 *
 * 关键：水产量速率不能读 counters（没有这个字段），也不能靠零升级挂机
 * （节点数会长不起来）。做法是「跑一个正常玩家，记录水量的一阶差分」，
 * 在水量不缺水（未触发降级）的窗口里取差分峰值 —— 那就是产量速率。
 *
 * 用法：node tools/probe_firewall_cost.js
 * ==========================================================================*/
'use strict';
var path = require('path');
var Sim = require(path.join(__dirname, '..', 'src', 'sim.js'));
var CONFIG = require(path.join(__dirname, '..', 'src', 'config.js'));

var SIM_SECONDS = 1800, DT = 0.25;
var SEEDS = [12345, 777, 20260917, 424242, 88888];
var N = CONFIG.BLIGHT.firewallNodes;          // 防火墙需要的节点数

/* 后期水产量速率：水量差分。
 * 只在「没有发生降级」的 tick 上取样，否则水量被降级救回来，
 * 差分就变成负数或噪声，测不出真实产量。 */
function waterRate() {
  var best = 0, samples = [], noUp = function () { return false; };
  for (var s = 0; s < SEEDS.length; s++) {
    var st = Sim.newGame(SEEDS[s], {}, {});
    st.autoGrow = true; st.milestones.m10 = true;      // 让它能长起来
    var prev = st.res.water, prevDg = st.counters.maintainDowngrades || 0;
    for (var t = 0; t < SIM_SECONDS; t += DT) {
      Sim.tick(st, DT);
      var dg = st.counters.maintainDowngrades || 0;
      var rate = (st.res.water - prev) / DT;
      if (dg === prevDg && t > SIM_SECONDS * 0.5 && rate > 0) samples.push(rate);
      prev = st.res.water; prevDg = dg;
    }
  }
  samples.sort(function (a, b) { return a - b; });
  if (!samples.length) return { peak: 0, p90: 0, median: 0, n: 0 };
  return {
    peak: samples[samples.length - 1],
    p90: samples[Math.floor(samples.length * 0.90)],
    median: samples[Math.floor(samples.length * 0.50)],
    n: samples.length
  };
}

function maintAt(lv) { return lv * lv * CONFIG.MAINT.costPerLevel; }

function upgradeCostTo(level) {
  var c = 0;
  for (var lv = 1; lv < level; lv++) c += Math.round(CONFIG.NODE_UP.baseCost * Math.pow(CONFIG.NODE_UP.costGrowth, lv));
  return c;
}

console.log('=== 免疫线（防火墙）成本核算 ===');
console.log('免疫线 immuneLevel =', CONFIG.BLIGHT.immuneLevel,
            '｜防火墙需节点数 firewallNodes =', N);
console.log('维持费 = 等级' + CONFIG.MAINT.exponent + ' × ' + CONFIG.MAINT.costPerLevel.toFixed(4));
console.log('曲线：', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (lv) {
  return 'Lv' + lv + '=' + maintAt(lv).toFixed(1);
}).join('  '), '/s');
console.log('');

var wr = waterRate();
console.log('后期水产量速率（5 种子 / 30min / 正常玩家，非降级 tick 差分）：');
console.log('  中位 ' + wr.median.toFixed(1) + '/s   90分位 ' + wr.p90.toFixed(1) + '/s   峰值 ' + wr.peak.toFixed(1) + '/s');
console.log('  （' + wr.n + ' 个采样点）');
console.log('');

console.log('=== 方案对照：免疫线设在几，防火墙养得起吗 ===');
console.log('  免疫线  单点维持   ' + N + '点维持   占中位水产量   单点升级费   ' + N + '点升级费');
[5, 6, 7].forEach(function (line) {
  var per = maintAt(line), total = per * N;
  var share = wr.median > 0 ? (total / wr.median * 100) : NaN;
  var up = upgradeCostTo(line), upN = up * N;
  console.log('  Lv' + line +
    '     ' + per.toFixed(1).padStart(7) +
    '   ' + total.toFixed(0).padStart(8) +
    '   ' + (isNaN(share) ? '  n/a' : share.toFixed(0) + '%').padStart(11) +
    '   ' + up.toLocaleString('en-US').padStart(10) +
    '   ' + upN.toLocaleString('en-US').padStart(11));
});
console.log('');
console.log('判读：占水产量 > 100% = 永远养不起（里程碑不可能达成）');
console.log('      60~90% = 养得起但极挤，要牺牲其余全部等级');
console.log('      < 50%  = 有余量，是「舍得投入就能做到」的选择');
