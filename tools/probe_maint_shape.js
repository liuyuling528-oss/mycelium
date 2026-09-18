/* 找维持费的合适曲线形状。
 *
 * 出发点：升级成本是 26 × 1.72^level（指数），维持费却曾是 level × 6（线性）。
 * 两者脱节导致「高等级几乎不收维持费」。
 *
 * 候选方案：
 *   A 线性     lv × K                     ← 现状，摊薄无代价
 *   B 幂 1.5   lv^1.5 × K
 *   C 幂 2     lv^2 × K/10
 *   D 指数     1.72^lv × K0（与升级成本同形，维持费 = 升级成本的固定比例）
 *
 * 判据（三个都要看）：
 *   ① 集中 vs 摊薄的成本比 —— 要明显 > 1，深耕才有代价
 *   ② Lv10 的维持费要「付得起但心疼」—— 不能高到永远养不起
 *   ③ 要和升级成本的增长形状**大致平行**，否则曲线某段会失效
 */
'use strict';
var CONFIG = require('../src/config.js');
var UP = CONFIG.NODE_UP;

console.log('=== 升级成本 vs 各方案维持费（每秒）===');
console.log('等级 |  升级成本  | A线性 | B ^1.5 | C ^2  | D 指数');
var rows = [];
for (var lv = 1; lv <= 10; lv++) {
  var upCost = Math.round(UP.baseCost * Math.pow(UP.costGrowth, lv - 1));
  var A = lv * 6;
  var B = Math.pow(lv, 1.5) * 6;
  var C = lv * lv * 0.6;
  var D = Math.pow(1.72, lv) * 2;
  rows.push({ lv: lv, up: upCost, A: A, B: B, C: C, D: D });
  console.log('  Lv' + String(lv).padEnd(2) +
    ' | ' + String(upCost).padStart(9) +
    ' | ' + A.toFixed(0).padStart(5) +
    ' | ' + B.toFixed(0).padStart(6) +
    ' | ' + C.toFixed(0).padStart(5) +
    ' | ' + D.toFixed(1).padStart(6));
}

/* 判据①：同样等级总和 100，集中 vs 摊薄的成本比 */
console.log('\n=== ① 集中 vs 摊薄（等级总和都是 100）===');
var dists = [
  { name: '10 × Lv10', n: 10, lv: 10 },
  { name: '20 × Lv5',  n: 20, lv: 5  },
  { name: '50 × Lv2',  n: 50, lv: 2  },
  { name: '100 × Lv1', n: 100, lv: 1 }
];
var fns = {
  A: function (l) { return l * 6; },
  B: function (l) { return Math.pow(l, 1.5) * 6; },
  C: function (l) { return l * l * 0.6; },
  D: function (l) { return Math.pow(1.72, l) * 2; }
};
console.log('分布          |   A线性   |  B ^1.5   |   C ^2    |  D 指数');
dists.forEach(function (d) {
  var vals = ['A', 'B', 'C', 'D'].map(function (k) {
    return (fns[k](d.lv) * d.n).toFixed(0);
  });
  console.log('  ' + d.name.padEnd(12) + ' | ' +
    vals.map(function (v) { return v.padStart(8); }).join('  |'));
});
console.log('\n  集中/摊薄 比值（>1.5 才有意义）：');
['A', 'B', 'C', 'D'].forEach(function (k) {
  var cen = fns[k](10) * 10, thin = fns[k](1) * 100;
  console.log('    ' + k + ': ' + (cen / thin).toFixed(2) + '×' +
              (cen / thin > 1.5 ? '  ✅' : '  ❌ 摊薄无代价'));
});

/* 判据②：以「后期水产量 554/s」为预算，能养住的等级总和 */
console.log('\n=== ② 水产量 554/s 能养住的等级总和 ===');
var WATER = 554;
['A', 'B', 'C', 'D'].forEach(function (k) {
  // 二分找最大的「N 个 Lv10 节点」可持续数量
  var best = 0;
  for (var n = 1; n <= 500; n++) {
    if (fns[k](10) * n <= WATER) best = n; else break;
  }
  var sum10 = best * 10;
  // 换算成「全部练到 Lv3」能养多少个
  var n3 = 0;
  for (var m = 1; m <= 2000; m++) {
    if (fns[k](3) * m <= WATER) n3 = m; else break;
  }
  console.log('  ' + k + ': 可养 ' + String(best).padStart(3) + ' 个 Lv10（等级和 ' +
    String(sum10).padStart(4) + '）或 ' + String(n3).padStart(4) + ' 个 Lv3（等级和 ' +
    String(n3 * 3).padStart(4) + '）');
});

console.log('\n=== ③ 与升级成本曲线的平行度 ===');
console.log('  Lv1→Lv10 升级成本增长 ' + (rows[9].up / rows[0].up).toFixed(0) + ' 倍');
['A', 'B', 'C', 'D'].forEach(function (k) {
  var grow = rows[9][k] / rows[0][k];
  console.log('  维持费 ' + k + ' 增长 ' + grow.toFixed(1) + ' 倍' +
              (grow > 5 ? '  ✅ 有梯度' : '  ❌ 太平'));
});
