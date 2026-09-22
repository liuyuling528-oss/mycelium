/* 验一个**关键风险**：降级速度改成固定值之后，「配额」会不会又变成瓶颈，
 * 把 costPerLevel（k）这个旋钮架空？
 *
 * 【为什么要专门验】DEVELOPMENT.md 记着一段历史教训：
 * 早期用固定配额时，等级总和稳定在 ~200 且**几乎不随 k 变化**
 * （k 从 1 涨到 12，累计降级始终 ~4700）—— 因为瓶颈是配额本身，
 * 玩家练 1 级立刻被砍掉，「一练就掉」，k 加多少都没用。
 * 那次之后改成了「按缺水程度缩放」。而现在触发条件换成「水见底」之后，
 * 缩放失去量纲、退回固定速度 —— **必须确认那个老毛病没有回来**。
 *
 * 【判据】给一个固定水收入，让网络从「等级远高于可维持」开始降，
 * 跑到平衡点，看**最终等级总和**：
 *   · 它应该**只由「收入 ÷ k」决定** —— 把降级速度换几档，
 *     平衡点必须几乎不动（速度只影响多快到达，不影响终点）；
 *   · 把 k 翻倍，平衡点应大致腰斩（k 依然是个有效旋钮）。
 * 若换降级速度会明显改变平衡点 → 配额成了瓶颈，设计失败，得回去加缩放。
 *
 * 用法：node tools/probe_maint_equilibrium.js
 * 退出码 0 = 通过。
 */
'use strict';
var path = require('path');
var Sim = require(path.join(__dirname, '..', 'src', 'sim.js'));
var CONFIG = require(path.join(__dirname, '..', 'src', 'config.js'));

var K0 = CONFIG.MAINT.costPerLevel;
var PERSEC0 = CONFIG.MAINT.downgradePerSec;
var INCOME = 554;          // 后期水产量（与 docs/数据总表.md 的口径一致）
var DT = 0.25;
var SECONDS = 1200;        // 够跑到平衡

/* 造一条中等规模的网络，全部拉到高等级（成本远超收入），然后让它降。 */
function build() {
  var st = Sim.newGame(12345, {}, {});
  for (var i = 0; i < 60; i++) {
    var b = Sim.bestCandidate(st);
    if (!b) break;
    st.res.water = 1e9;
    if (!Sim.growAt(st, b.x, b.y).ok) break;
  }
  st.nodes.forEach(function (n) { n.level = 4; });   // 高起点：逼它降
  st.res.water = 0;
  st.counters.maintainDowngrades = 0;
  st.maintainQuota = 0;
  return st;
}

function levelSum(st) {
  var s = 0;
  st.nodes.forEach(function (n) { s += (n.level || 0); });
  return s;
}

function runToEquilibrium(k, perSec) {
  CONFIG.MAINT.costPerLevel = k;
  CONFIG.MAINT.downgradePerSec = perSec;
  var st = build();
  var startSum = levelSum(st);
  for (var t = 0; t < SECONDS; t += DT) {
    st.res.water += INCOME * DT;          // 模拟稳定水收入
    Sim.settleMaintenance(st, DT);
  }
  return {
    start: startSum,
    end: levelSum(st),
    down: st.counters.maintainDowngrades,
    cost: Sim.totalMaintainCost(st),
    water: st.res.water
  };
}

var fails = [];
function ok(label, cond, detail) {
  console.log((cond ? ' PASS  ' : ' FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  if (!cond) fails.push(label);
}

console.log('水收入固定为 ' + INCOME + '/s，网络从全 Lv4 开始降，跑 ' + SECONDS + 's');
console.log('');

console.log('=== 1. 换降级速度：平衡点应当几乎不动 ===');
var speeds = [1, 3, 12];
var results = speeds.map(function (p) {
  var r = runToEquilibrium(K0, p);
  console.log('  降级 ' + String(p).padStart(2) + ' 级/s → 等级总和 ' +
              String(r.start).padStart(4) + ' → ' + String(r.end).padStart(3) +
              '（降级 ' + String(r.down).padStart(5) + ' 次，末态维持费 ' +
              r.cost.toFixed(1) + '/s）');
  return r;
});
var ends = results.map(function (r) { return r.end; });
var spread = Math.max.apply(null, ends) - Math.min.apply(null, ends);
ok('平衡点与降级速度无关（配额不是瓶颈）', spread <= Math.max(2, ends[0] * 0.1),
   '各档终点 ' + ends.join(' / ') + '，极差 ' + spread + ' 级');
ok('平衡点确实远低于起点（机制真的在压）',
   ends[0] < results[0].start / 2,
   '起点 ' + results[0].start + ' → 终点 ' + ends[0]);
ok('平衡点的维持费 ≈ 水收入（这才是「可维持」的定义）',
   results[0].cost <= INCOME * 1.2,
   '维持费 ' + results[0].cost.toFixed(1) + ' vs 收入 ' + INCOME);

console.log('');
console.log('=== 2. 换 k：平衡点应当大致反比变化（k 仍是有效旋钮）===');
var k1 = runToEquilibrium(K0, PERSEC0);
var k2 = runToEquilibrium(K0 * 2, PERSEC0);
var kHalf = runToEquilibrium(K0 / 2, PERSEC0);
console.log('  k × 0.5 → 等级总和 ' + kHalf.end);
console.log('  k × 1   → 等级总和 ' + k1.end + '（基准）');
console.log('  k × 2   → 等级总和 ' + k2.end);
ok('k 翻倍后平衡点明显下降', k2.end < k1.end * 0.8,
   k1.end + ' → ' + k2.end);
ok('k 减半后平衡点明显上升', kHalf.end > k1.end * 1.2,
   k1.end + ' → ' + kHalf.end);
ok('k 变化时平衡点的维持费仍贴着收入',
   Math.abs(k2.cost - INCOME) <= INCOME * 0.25 &&
   Math.abs(kHalf.cost - INCOME) <= INCOME * 0.25,
   'k×2 成本 ' + k2.cost.toFixed(1) + '，k×0.5 成本 ' + kHalf.cost.toFixed(1));

/* 还原，别污染后续（同一进程内 require 的是同一个对象） */
CONFIG.MAINT.costPerLevel = K0;
CONFIG.MAINT.downgradePerSec = PERSEC0;

console.log('');
console.log('='.repeat(66));
if (fails.length) {
  console.log(' ❌ ' + fails.length + ' 条未通过：');
  fails.forEach(function (x) { console.log('    · ' + x); });
  process.exit(1);
}
console.log(' ✅ 配额没有变成瓶颈，costPerLevel 依然是有效旋钮。');
process.exit(0);
