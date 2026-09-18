/* 算出「可维持的等级总量」这个上限：
 *   水产量 / costPerLevel = 能维持的「等级总和」
 * 玩家的养分足够练出远超这个总和的等级 → 他必须挑节点养。
 *
 * 判据：
 *   a) 等级总和上限要明显小于「把网络练到有意义的等级」所需的总和
 *   b) 但上限本身要够大，让玩家仍能养出一批高等级节点（否则等于禁止深耕）
 *   c) 远近要有差异（远的先降），所以「养近处」和「养远处」代价不同
 *
 * 用法：node tools/probe_cap.js
 */
'use strict';
var path = require('path');
var Sim = require(path.join(__dirname, '..', 'src', 'sim.js'));
var CONFIG = require(path.join(__dirname, '..', 'src', 'config.js'));

/* 先量出后期水产量（用不练节点的玩家，水产量与等级无关） */
function waterIncome(seed, seconds) {
  var st = Sim.newGame(seed, {}, {});
  st.policy = 'nearest';
  var DT = 0.25, clickTimer = 0;
  var samples = [];
  var next = 0;
  for (var t = 0; t < seconds; t += DT) {
    Sim.tick(st, DT);
    clickTimer += DT;
    while (clickTimer >= 1.0) {
      clickTimer -= 1.0;
      var b = Sim.bestCandidate(st);
      if (!b || b.cost > st.res.water) break;
      if (!Sim.growAt(st, b.x, b.y).ok) break;
    }
    var prio = ['autoGrow', 'growth', 'hydration'];
    for (var p = 0; p < prio.length; p++) {
      var g = 0;
      while (g++ < 200) {
        var c = Sim.upgradeCost(st, prio[p]);
        if (!isFinite(c) || st.res.nutrient < c) break;
        if (!Sim.buyUpgrade(st, prio[p]).ok) break;
      }
    }
    if (st.nodes.length >= 250) st.autoGrow = true;
    if (t >= next) {
      next += 300;
      // 净水收入（此时无等级 → 维持费 0）
      samples.push({ t: t, income: (st.rate ? st.rate.water : st.seepRate || 0.45) });
    }
  }
  return samples;
}

var inc = waterIncome(12345, 1800);
var lateIncome = inc[inc.length - 1].income;
console.log('=== 后期水产量（不含维持费）===');
inc.forEach(function (s) {
  console.log('  t=' + String(s.t).padStart(4) + 's   水 ' + s.income.toFixed(0) + '/s');
});
console.log('  取后期稳态值 ≈ ' + lateIncome.toFixed(0) + ' /s\n');

/* 「可维持的等级总和」 = 水产量 / k */
console.log('=== 可维持的等级总和上限（水产量 ÷ k）===');
console.log('  参照：641 节点全练到 Lv5 的总和 = ' + (641 * 5) + '；全 Lv10 = ' + (641 * 10));
console.log('        100 节点全 Lv10 的总和 = ' + (100 * 10) + '；30 个 Lv10 = 300\n');
console.log('     k   等级总和上限   相当于...');
[0.25, 0.6, 1.0, 2.0, 4.0, 8.0].forEach(function (k) {
  var cap = lateIncome / k;
  var desc;
  if (cap >= 641 * 10) desc = '全网络能练满（无约束）';
  else if (cap >= 641 * 5) desc = '能到「全网络 Lv5+」';
  else if (cap >= 641 * 2) desc = '能到「全网络 Lv2 左右」';
  else if (cap >= 300) desc = '约 ' + Math.round(cap / 10) + ' 个 Lv10 节点，或 ' + Math.round(cap / 5) + ' 个 Lv5';
  else if (cap >= 100) desc = '约 ' + Math.round(cap / 10) + ' 个 Lv10 节点（很少）';
  else desc = '约 ' + Math.round(cap / 10) + ' 个 Lv10（几乎养不起）';
  console.log('  ' + k.toFixed(2).padStart(5) + '  ' + String(Math.round(cap)).padStart(11) + '   ' + desc);
});

/* 玩家手上能练出多少「级」？养分预算 ÷ 平均升级成本 */
console.log('\n=== 对照：养分能练出多少级？ ===');
var perLevelAvg = 0, cnt = 0;
for (var L = 0; L < 8; L++) { perLevelAvg += CONFIG.NODE_UP.baseCost * Math.pow(CONFIG.NODE_UP.costGrowth, L); cnt++; }
perLevelAvg = perLevelAvg / cnt;
console.log('  Lv1~Lv8 平均每级成本 ≈ ' + perLevelAvg.toFixed(0) + ' 养分');
console.log('  20 分钟累计养分 48736 → 约可练出 ' + Math.round(48736 / perLevelAvg) + ' 级');
console.log('  这 ' + Math.round(48736 / perLevelAvg) + ' 级撒在 641 个节点上 = 平均 Lv' +
  (48736 / perLevelAvg / 641).toFixed(2));
console.log('  集中到 30 个节点 = 平均 Lv' + (48736 / perLevelAvg / 30).toFixed(1));
console.log('  集中到 10 个节点 = 平均 Lv' + (48736 / perLevelAvg / 10).toFixed(1));
console.log('\n→ 「等级总和上限」只要低于「养分能练出的总级数」，玩家就必须取舍。');
