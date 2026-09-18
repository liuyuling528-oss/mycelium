/* 确认「练满一网络」需要多少养分、后期养分产量多少。
 * 这决定了维持费该以什么为基准 —— 是压「满级」还是压「中间层」。
 *
 * 用法：node tools/probe_nutrient.js [秒数]
 */
'use strict';
var path = require('path');
var Sim = require(path.join(__dirname, '..', 'src', 'sim.js'));
var CONFIG = require(path.join(__dirname, '..', 'src', 'config.js'));

var DURATION = Number(process.argv[2]) || 1800;
var DT = 0.25;

/* 把 N 个节点练到 Lv L 需要多少养分 */
function costToLevel(N, L) {
  var per = 0;
  for (var i = 0; i < L; i++) per += CONFIG.NODE_UP.baseCost * Math.pow(CONFIG.NODE_UP.costGrowth, i);
  return per * N;
}

console.log('=== 练满一网络需要的累计养分（纯节点强化，不含全局升级）===');
console.log('  节点数   练到Lv5        练到Lv8         练到Lv10');
[100, 300, 500, 641].forEach(function (N) {
  console.log('  ' + String(N).padStart(5) +
    '  ' + String(Math.round(costToLevel(N, 5))).padStart(12) +
    '  ' + String(Math.round(costToLevel(N, 8))).padStart(13) +
    '  ' + String(Math.round(costToLevel(N, 10))).padStart(13));
});

console.log('\n=== 后期养分产量（不练节点，全部养分都在累积）===');
var st = Sim.newGame(12345, {}, {});
st.policy = 'nearest';
var clickTimer = 0, nextMark = 0;
var marks = [];
for (var t = 0; t < DURATION; t += DT) {
  Sim.tick(st, DT);
  clickTimer += DT;
  while (clickTimer >= 1.0) {
    clickTimer -= 1.0;
    var b = Sim.bestCandidate(st);
    if (!b || b.cost > st.res.water) break;
    if (!Sim.growAt(st, b.x, b.y).ok) break;
  }
  // 只买扩张必需的，养分全省着 —— 这样量到的是「可用养分产出」
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

  if (t >= nextMark) {
    nextMark += 600;
    marks.push({
      t: t, nodes: st.nodes.length,
      cur: st.res.nutrient, total: st.total.nutrient,
      water: st.res.water
    });
  }
}
console.log('   t(s)   节点      当前养分        累计养分    累计水');
marks.forEach(function (m) {
  console.log('  ' + String(m.t).padStart(5) + '  ' + String(m.nodes).padStart(5) +
    '  ' + String(Math.round(m.cur)).padStart(12) +
    '  ' + String(Math.round(m.total)).padStart(13) +
    '  ' + String(Math.round(m.water)).padStart(10));
});
var last = marks[marks.length - 1];
console.log('\n结论：累计养分 ' + Math.round(last.total) +
  ' vs 练满 641 节点到 Lv10 需要 ' + Math.round(costToLevel(641, 10)) +
  '（前者' + (last.total >= costToLevel(641, 10) ? '够' : '不够') + '）');
console.log('      练满 641 节点到 Lv5 需要 ' + Math.round(costToLevel(641, 5)) +
  '（' + (last.total >= costToLevel(641, 5) ? '够' : '不够') + '）');
