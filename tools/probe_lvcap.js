/* 为什么节点等级卡在 Lv7 上不去？（与维护费无关，k=0 也一样）
 * 假设：养分不够买 Lv8 的升级费。
 * 用法：node tools/probe_lvcap.js
 */
'use strict';
var path = require('path');
var Sim = require(path.join(__dirname, '..', 'src', 'sim.js'));

var st = Sim.newGame(12345, {}, {});
st.policy = 'nearest';
console.log('NODE_UP: base=' + Sim.nodeUpgradeCost(st, { level: 0 }) + ' 起');
console.log('单节点升级成本序列：');
var seq = [];
for (var L = 0; L <= 10; L++) {
  seq.push('Lv' + (L + 1) + '=' + Math.round(26 * Math.pow(1.72, L)));
}
console.log('  ' + seq.join('  '));
console.log('  把 1 个节点练到 Lv8 需要累计养分 = ' +
  [0, 1, 2, 3, 4, 5, 6, 7].reduce(function (a, L) { return a + 26 * Math.pow(1.72, L); }, 0).toFixed(0));
console.log('  把 1 个节点练到 Lv10 需要累计养分 = ' +
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].reduce(function (a, L) { return a + 26 * Math.pow(1.72, L); }, 0).toFixed(0));

// 实际跑一局，看养分累积到多少
var DT = 0.25, t = 0, clickTimer = 0;
var marks = [300, 600, 900, 1200, 1500, 1800];
var mi = 0;
while (t < 1800) {
  Sim.tick(st, DT); t += DT;
  clickTimer += DT;
  while (clickTimer >= 1) {
    clickTimer -= 1;
    var b = Sim.bestCandidate(st);
    if (!b || b.cost > st.res.water) break;
    if (!Sim.growAt(st, b.x, b.y).ok) break;
  }
  var prio = ['autoGrow', 'growth', 'hydration', 'absorption', 'capacity', 'transport'];
  for (var p = 0; p < prio.length; p++) {
    var g = 0;
    while (g++ < 200) {
      var c = Sim.upgradeCost(st, prio[p]);
      if (!isFinite(c) || st.res.nutrient < c) break;
      if (!Sim.buyUpgrade(st, prio[p]).ok) break;
    }
  }
  if (st.nodes.length >= 250) st.autoGrow = true;
  if (mi < marks.length && t >= marks[mi]) {
    var mx = 0, sum = 0;
    for (var i = 0; i < st.nodes.length; i++) { var L = st.nodes[i].level || 0; sum += L; if (L > mx) mx = L; }
    console.log('  t=' + marks[mi] + 's  当前养分 ' + Math.round(st.res.nutrient) +
      '  累计养分 ' + Math.round(st.total.nutrient) +
      '  maxLv=' + mx + '  avgLv=' + (sum / Math.max(1, st.nodes.length)).toFixed(2) +
      '  升级花费=' + JSON.stringify(st.up));
    mi++;
  }
}
console.log('\n结论：看「当前养分」相对「练到 Lv8 需要的累计养分」，就知道卡在哪。');
