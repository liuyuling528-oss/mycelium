/* 对比「线性维持费」与「超线性维持费」在实战下的差别。
 *
 * 核心问题：线性时，维持费只关心「等级总和」—— 10 个 Lv1 节点
 * 和 1 个 Lv10 节点成本完全相同。于是玩家没有任何理由「集中深耕」，
 * 最优解永远是「把等级摊到最多节点上」，因为这样更抗降级
 * （降级一次只损失 1 级，而摊薄后每个节点都掉得起）。
 *
 * 超线性（等级^1.5 / ^2）时，高等级变贵，于是「练一个 Lv10」
 * 和「练十个 Lv1」有真实价差 —— 深耕需要理由，也得付代价。
 *
 * 跑法：node tools/probe_maint_curve.js
 */
'use strict';
var Sim = require('../src/sim.js');
var CONFIG = require('../src/config.js');

var K = CONFIG.MAINT.costPerLevel;

function costLinear(lv) { return lv * K; }
function costPow15(lv) { return Math.pow(lv, 1.5) * K; }
function costQuad(lv) { return lv * lv * K * 0.1; }   // 归一化到 Lv10 ≈ 10K

console.log('=== 1. 单节点成本曲线（K = ' + K + '）===');
console.log('等级 |   线性   |  ^1.5    |  ^2(归一)');
for (var lv = 0; lv <= 10; lv++) {
  console.log('  Lv' + String(lv).padEnd(2) +
              ' | ' + costLinear(lv).toFixed(1).padStart(8) +
              ' | ' + costPow15(lv).toFixed(1).padStart(8) +
              ' | ' + costQuad(lv).toFixed(1).padStart(9));
}

/* 关键指标：同样「等级总和 = 100」，集中 vs 摊薄的成本比 */
console.log('\n=== 2. 同样等级总和 100，集中深耕 vs 摊薄，成本比 ===');
console.log('（线性时比值恒为 1.00 —— 这就是问题所在：摊薄没有代价）');
[
  { name: '10 个 Lv10（集中）',   levels: Array(10).fill(10) },
  { name: '20 个 Lv5（中）',     levels: Array(20).fill(5)  },
  { name: '50 个 Lv2（摊薄）',   levels: Array(50).fill(2)  },
  { name: '100 个 Lv1（极摊）',  levels: Array(100).fill(1) }
].forEach(function (c) {
  var lin = c.levels.reduce(function (a, l) { return a + costLinear(l); }, 0);
  var p15 = c.levels.reduce(function (a, l) { return a + costPow15(l); }, 0);
  var quad = c.levels.reduce(function (a, l) { return a + costQuad(l); }, 0);
  console.log('  ' + c.name.padEnd(18) +
              ' 线性 ' + lin.toFixed(0).padStart(7) +
              ' | ^1.5 ' + p15.toFixed(0).padStart(7) +
              ' | ^2 ' + quad.toFixed(0).padStart(7));
});
console.log('  ↑ 看「线性」那一列：全是 1000，完全一样。');
console.log('    而 ^1.5 列：集中 3162 vs 摊薄 1000 —— 深耕贵 3.2 倍，取舍出现了。');

/* 用真实网络规模算一遍实际压力 */
console.log('\n=== 3. 真实网络下：同样养分预算能练出的分布 ===');
var st = Sim.newGame(20260918, {}, {});
st.res.water = 1e6;
var placed = [];
for (var i = 1; i <= 30; i++) { placed.push([i, 0]); }
placed.forEach(function (p) {
  var g = st.grid[(st.core.y + p[1]) * st.mapW + (st.core.x + p[0])];
  if (g) g.soil = 'litter';
  Sim.growAt(st, st.core.x + p[0], st.core.y + p[1]);
});
Sim.rebuildNetwork(st);
var n = st.nodes.length - 1;
console.log('  网络规模：' + n + ' 个可练节点');
console.log('  （养分预算固定，比较两种分配方式的总维持费）');
[
  { name: '集中：3 个 Lv10', alloc: function (i) { return i < 3 ? 10 : 0; } },
  { name: '中：6 个 Lv5',   alloc: function (i) { return i < 6 ? 5 : 0; } },
  { name: '摊薄：30 个 Lv1', alloc: function (i) { return 1; } }
].forEach(function (c) {
  var lin = 0, p15 = 0;
  st.nodes.forEach(function (nd, idx) {
    if (idx === 0) return;
    var lvl = c.alloc(idx - 1);
    lin += costLinear(lvl); p15 += costPow15(lvl);
  });
  var sum = 0;
  st.nodes.forEach(function (nd, idx) { if (idx > 0) sum += c.alloc(idx - 1); });
  console.log('  ' + c.name.padEnd(16) + ' 等级总和 ' + String(sum).padStart(3) +
              ' → 线性 ' + lin.toFixed(0).padStart(7) +
              ' | ^1.5 ' + p15.toFixed(0).padStart(7));
});
