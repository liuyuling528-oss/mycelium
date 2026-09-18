/* 反推「刚好降 1 级」所需的 dt。
 * quota = downgradePerSec * scale * dt，scale = 0.15 + deficit^2 * 2.85
 * deficit = (buffer - water) / buffer
 */
'use strict';
var Sim = require('../src/sim.js');
var CONFIG = require('../src/config.js');

var st = Sim.newGame(20260918, {}, {});
st.res.water = 1e6;
[[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0]].forEach(function (p) {
  Sim.growAt(st, st.core.x + p[0], st.core.y + p[1]);
});
Sim.rebuildNetwork(st);
st.nodes.forEach(function (n, i) { if (i > 0) n.level = 5; });

var cost = Sim.totalMaintainCost(st);
console.log('节点数', st.nodes.length);
console.log('等级总和  ', st.nodes.reduce(function (a, n) { return a + n.level; }, 0));
console.log('总维持费  ', cost, '/s');
var buffer = cost * CONFIG.MAINT.bufferSec;
console.log('缓冲线    ', buffer, '(bufferSec=' + CONFIG.MAINT.bufferSec + ')');

console.log('\ndeficit → scale → 刚好 1 级所需 dt:');
[0.0001, 0.001, 0.01, 0.05, 0.1, 0.3, 0.5, 1.0].forEach(function (d) {
  var scale = 0.15 + d * d * 2.85;
  var quotaPerSec = CONFIG.MAINT.downgradePerSec * scale;
  console.log('  deficit=' + String(d).padEnd(7) +
              ' scale=' + scale.toFixed(4).padEnd(8) +
              ' 配额=' + quotaPerSec.toFixed(3) + ' 级/秒' +
              ' → dt=' + (1 / quotaPerSec).toFixed(4));
});

console.log('\n实测：水刚好在缓冲线下 0.999×，dt = 1/(perSec*0.15)');
st.nodes.forEach(function (n, i) { if (i > 0) n.level = 5; });
st.res.water = buffer * 0.999;
var deficit = (buffer - st.res.water) / buffer;
var scale = 0.15 + deficit * deficit * 2.85;
console.log('  deficit=' + deficit.toFixed(6), ' scale=' + scale.toFixed(6));
var dt = 1 / (CONFIG.MAINT.downgradePerSec * 0.15);
var quota = CONFIG.MAINT.downgradePerSec * scale * dt;
console.log('  dt=' + dt.toFixed(4), ' 实际配额=' + quota.toFixed(4), ' 级');
var before = st.nodes.map(function (n) { return n.level; });
var done = Sim.settleMaintenance(st, dt);
console.log('  实际降级 =', done, '级');
st.nodes.forEach(function (n, i) {
  if (i > 0 && before[i] !== n.level) {
    console.log('   节点' + n.id + ' dist=' + n.dist + ' Lv' + before[i] + '→' + n.level);
  }
});

console.log('\n换个思路：直接把 dt 设成能产生 <1 的配额，看降不降');
st.nodes.forEach(function (n, i) { if (i > 0) n.level = 5; });
st.res.water = buffer * 0.999;
console.log('  配额 = 0.9 时 dt =', (0.9 / (CONFIG.MAINT.downgradePerSec * 0.15)).toFixed(4));
st.nodes.forEach(function (n, i) { if (i > 0) n.level = 5; });
st.res.water = buffer * 0.999;
var d2 = Sim.settleMaintenance(st, 0.9 / (CONFIG.MAINT.downgradePerSec * 0.15));
console.log('  → 降级', d2, '级');
