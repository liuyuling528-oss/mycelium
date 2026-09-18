/* ============================================================================
 * probe_water_rate.js — 后期「水产量速率」到底是多少？
 *
 * 【为什么需要这个】
 * 定维持费系数时用的是「后期水产量 ≈ 554/s」这个数，但它是怎么测的
 * 已经不记得了，而它直接决定「能养多少等级」、也就是整个取舍成不成立。
 * 这个探针用**三种口径**分别测，把数字钉死：
 *
 *   口径 A：零升级纯挂机
 *     不买任何升级、不升级节点 —— 测「地图自然产出」的天花板。
 *   口径 B：正常玩家（买升级 + 自动蔓延）
 *     这才是玩家真实的水收入。**定平衡应该用这个数**。
 *   口径 C：口径 B + 把养分也投进节点（深耕玩家）
 *
 * 三种口径的差值本身就是信息：如果 A 远小于 B，说明「水收入主要来自升级
 * 而不是铺地图」，那么维持费该按 B 标定，否则会高估土地的承载量。
 *
 * 测法：水量一阶差分 / dt，只在**未发生降级**的 tick 取样
 * （降级会把水补回来，污染差分）。取后半程稳态窗口。
 *
 * 用法：node tools/probe_water_rate.js
 * ==========================================================================*/
'use strict';
var path = require('path');
var Sim = require(path.join(__dirname, '..', 'src', 'sim.js'));
var CONFIG = require(path.join(__dirname, '..', 'src', 'config.js'));

var SIM_SECONDS = 1800, DT = 0.25;
var SEEDS = [12345, 777, 20260917, 424242, 88888];

/* 稳定地花掉养分买全局升级（按性价比顺序） */
function spendUpgrades(state, priority) {
  for (var i = 0; i < priority.length; i++) {
    var g = 0;
    while (g++ < 500) {
      var cost = Sim.upgradeCost(state, priority[i]);
      if (!isFinite(cost) || state.res.nutrient < cost) break;
      if (!Sim.buyUpgrade(state, priority[i]).ok) break;
    }
  }
}

/* 把养分投进节点（深耕）*/
function upgradeNodes(state, n, level) {
  var done = 0;
  while (done < n) {
    var best = null, bestScore = -1;
    for (var i = 1; i < state.nodes.length; i++) {
      var nd = state.nodes[i];
      if (!nd || nd.level !== level) continue;     // 只在指定等级层里挑
      if (!isFinite(Sim.upgradeNodeCost(state, nd))) continue;
      var sc = 1 / (1 + nd.dist);                   // 近核优先
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    if (best === null) break;
    if (!Sim.upgradeNode(state, best).ok) break;
    done++;
  }
  return done;
}

function measure(label, opts) {
  var all = [];
  for (var s = 0; s < SEEDS.length; s++) {
    var st = Sim.newGame(SEEDS[s], {}, {});
    if (opts.autoGrow) { st.autoGrow = true; st.milestones.m10 = true; }
    var prev = st.res.water, prevDg = st.counters.maintainDowngrades || 0;
    for (var t = 0; t < SIM_SECONDS; t += DT) {
      Sim.tick(st, DT);
      if (opts.buy) spendUpgrades(st, opts.buy);
      if (opts.focus && st.res.nutrient > 400) upgradeNodes(st, opts.focus, opts.focusLevel);
      var dg = st.counters.maintainDowngrades || 0;
      var rate = (st.res.water - prev) / DT;
      /* 只看后半程 + 非降级 tick + 正增益 */
      if (dg === prevDg && t > SIM_SECONDS * 0.5 && rate > 0) all.push(rate);
      prev = st.res.water; prevDg = dg;
    }
    if (s === 0) {
      var maxLv = 0;
      for (var j = 0; j < st.nodes.length; j++) if (st.nodes[j].level > maxLv) maxLv = st.nodes[j].level;
      process.stdout.write('    种子' + SEEDS[s] + ' 终局：节点 ' + st.nodes.length +
        '｜水 ' + st.res.water.toFixed(0) + '｜最高等级 ' + maxLv +
        '｜维护费 ' + (st.maintainCost || 0).toFixed(0) + '/s\n');
    }
  }
  all.sort(function (a, b) { return a - b; });
  var med = all.length ? all[Math.floor(all.length * 0.5)] : 0;
  var p90 = all.length ? all[Math.floor(all.length * 0.9)] : 0;
  var peak = all.length ? all[all.length - 1] : 0;
  console.log('  ' + label);
  console.log('    中位 ' + med.toFixed(1) + '/s   90分位 ' + p90.toFixed(1) +
              '/s   峰值 ' + peak.toFixed(1) + '/s   (' + all.length + ' 采样)');
  return { med: med, p90: p90, peak: peak };
}

console.log('=== 后期水产量速率：三种口径对照 ===');
console.log('（' + SIM_SECONDS + 's / 5 种子，水量差分，仅取未降级 tick、后半程）');
console.log('');

console.log('[A] 零升级纯挂机（不买升级、不升节点）');
var a = measure('', { autoGrow: true });
console.log('');

console.log('[B] 正常玩家：买全局升级 + 自动蔓延');
var b = measure('', { autoGrow: true, buy: ['hydration', 'growth', 'absorption', 'transport', 'capacity'] });
console.log('');

console.log('[C] 深耕玩家：B + 养分投节点（Lv1 起练）');
var c = measure('', { autoGrow: true, buy: ['hydration', 'growth', 'absorption'], focus: 3, focusLevel: 1 });
console.log('');

var per = CONFIG.MAINT.costPerLevel, n = CONFIG.BLIGHT.firewallNodes, line = CONFIG.BLIGHT.immuneLevel;
var fwCost = line * line * per * n;
console.log('=== 结论：防火墙（' + n + ' 个 Lv' + line + '）要 ' + fwCost.toFixed(0) + '/s 维持费 ===');
[['A 挂机', a], ['B 正常', b], ['C 深耕', c]].forEach(function (p) {
  console.log('  占 ' + p[0] + ' 水产量： ' + (fwCost / p[1].med * 100).toFixed(0) + '%（中位）　' +
              (fwCost / p[1].p90 * 100).toFixed(0) + '%（90分位）　' +
              (fwCost / p[1].peak * 100).toFixed(0) + '%（峰值）');
});
console.log('');
console.log('判读：> 100% 永远养不起；60~90% 极挤；< 50% 有余量。');
