/* 验证「维持费降级」的语义 —— 核心是一条：
 *
 *   **水没见底（> 0）绝不降级；水一变成 0 才开始降级。**
 *
 * 这条是玩家明确提的：「是我的总水分变成 0 了才开始降级」。
 * 旧版在水低于「维持费 × bufferSec(40s)」时就开始降，玩家还在有水的时候
 * 就看着等级往下掉 —— 已废弃。这个探针守着新语义，防止它悄悄退回去。
 *
 * 用法：node tools/probe_downgrade.js
 * 退出码 0 = 全部通过，1 = 有断言失败。
 */
'use strict';
var path = require('path');
var Sim = require(path.join(__dirname, '..', 'src', 'sim.js'));
var CONFIG = require(path.join(__dirname, '..', 'src', 'config.js'));

var fails = [];
function ok(label, cond, detail) {
  console.log((cond ? ' PASS  ' : ' FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  if (!cond) fails.push(label);
}

/* 造一个「有等级、所以有维持费」的局面，并把水设成指定值。 */
function staged(levelNear, levelFar) {
  var st = Sim.newGame(12345, {}, {});
  /* 先长出一条链，好有远近之分 */
  for (var step = 0; step < 12; step++) {
    var b = Sim.bestCandidate(st);
    if (!b) break;
    st.res.water = 1e9;
    if (!Sim.growAt(st, b.x, b.y).ok) break;
  }
  var ids = st.nodes.map(function (n, i) { return i; }).filter(function (i) { return i > 0; });
  var probe = ids[0], far = ids[ids.length - 1];
  st.nodes.forEach(function (n) { n.level = 0; });
  if (levelNear) st.nodes[probe].level = levelNear;
  if (levelFar) st.nodes[far].level = levelFar;
  st.counters.maintainDowngrades = 0;
  st.maintainQuota = 0;
  return { st: st, probe: probe, far: far };
}

function runFor(st, seconds, dt, waterAtStart) {
  if (waterAtStart != null) st.res.water = waterAtStart;
  var down = 0;
  for (var t = 0; t < seconds; t += dt) down += Sim.settleMaintenance(st, dt);
  return down;
}

console.log('=== 1. 水充足：绝不降级 ===');
var a = staged(5, 5);
var costA = Sim.totalMaintainCost(a.st);
var dA = runFor(a.st, 60, 0.25, 1e9);
ok('水充足跑 60s 零降级', dA === 0, '降级 ' + dA + ' 级（维持费 ' + costA.toFixed(1) + '/s）');

console.log('');
console.log('=== 2. 水还是正数：一级都不许掉（关键） ===');
/* 水刚好够付 1 秒维持费 —— 跑 0.5 秒时水位应该还有一半 */
var b = staged(5, 5);
var costB = Sim.totalMaintainCost(b.st);
b.st.res.water = costB * 1.0;
var dB = runFor(b.st, 0.5, 0.25, null);
ok('水够付 1 秒、只跑 0.5 秒 → 零降级',
   dB === 0, '降级 ' + dB + ' 级，剩余水 ' + b.st.res.water.toFixed(1) + '（应 > 0）');
ok('此时水位确实还是正的', b.st.res.water > 0, '水 = ' + b.st.res.water.toFixed(2));

/* 再往后跑，水会自然耗尽 —— 耗尽之前仍然不该降 */
var b2 = staged(5, 5);
var costB2 = Sim.totalMaintainCost(b2.st);
var dBefore = runFor(b2.st, 0.25, 0.25, costB2 * 0.9);   // 只跑了 1 帧，水还剩 0.65s 的量
ok('水还剩 0.65 秒的量 → 这一帧不降级',
   dBefore === 0, '降级 ' + dBefore + ' 级，剩余水 ' + b2.st.res.water.toFixed(2));

console.log('');
console.log('=== 3. 水见底：立刻开始降级（正对照） ===');
var c = staged(5, 5);
var costC = Sim.totalMaintainCost(c.st);
c.st.res.water = 0;
var dC = runFor(c.st, 1.0, 0.25, null);
ok('水为 0 跑 1 秒 → 确实在降级', dC > 0, '降级 ' + dC + ' 级');

console.log('');
console.log('=== 4. 速度是固定的 downgradePerSec（不随时间变化）===');
var e = staged(10, 10);
e.st.res.water = 0;
var first2 = runFor(e.st, 2.0, 0.25, null);
var next2 = runFor(e.st, 2.0, 0.25, null);
var expect = CONFIG.MAINT.downgradePerSec;
ok('第 1 个 2 秒降级量接近 2×perSec',
   Math.abs(first2 - expect * 2) <= 1, first2 + ' 级（期望约 ' + expect * 2 + '）');
ok('第 2 个 2 秒和第 1 个一样多（没有"越缺越快"的爬升）',
   Math.abs(first2 - next2) <= 1, first2 + ' vs ' + next2);
ok('没有留下 dryTime 这种旧字段', e.st.dryTime === undefined,
   'dryTime = ' + e.st.dryTime);

console.log('');
console.log('=== 5. 恢复供水：立刻停止降级 ===');
var f = staged(5, 5);
f.st.res.water = 0;
runFor(f.st, 1.0, 0.25, null);
f.st.res.water = 1e9;
var dAfter = runFor(f.st, 5.0, 0.25, null);
ok('水补回来后不再降级', dAfter === 0, '补水中降级 ' + dAfter + ' 级');
ok('maintainPressure 随之解除', f.st.maintainPressure === false, 'pressure = ' + f.st.maintainPressure);

console.log('');
console.log('=== 6. 水刚恢复一点点（>0）就够停手 ===');
var f2 = staged(5, 5);
f2.st.res.water = 0;
runFor(f2.st, 1.0, 0.25, null);
/* 只补「够付 0.1 秒」的水 —— 只要水位是正的，这一帧就不该降 */
f2.st.res.water = Sim.totalMaintainCost(f2.st) * 0.1;
var dTiny = Sim.settleMaintenance(f2.st, 0.01);
ok('水只有 0.1 秒的量（但 > 0）→ 该帧不降级', dTiny === 0, '降级 ' + dTiny + ' 级');

console.log('');
console.log('=== 7. 全 Lv0：永不降级（不误伤扩张流） ===');
var g = staged(0, 0);
ok('全 Lv0 的维持费为 0', Sim.totalMaintainCost(g.st) === 0, '成本 0');
var dG = runFor(g.st, 60, 0.25, 0);
ok('全 Lv0 且水为 0 也零降级（没有可降的、也不收费）', dG === 0, '降级 ' + dG + ' 级');

console.log('');
console.log('=== 8. 远端先降（位置 = 成本） ===');
var h = staged(5, 5);
h.st.res.water = 0;
/* 只跑 1 秒 = 3 级预算：远端先吃满，近核应基本保住 */
var dH = runFor(h.st, 1.0, 0.25, null);
var nearLv = h.st.nodes[h.probe].level, farLv = h.st.nodes[h.far].level;
ok('远端掉得比近核多', farLv < nearLv && dH > 0,
   '近核 Lv' + nearLv + '  远端 Lv' + farLv + '（共降 ' + dH + ' 级）');

console.log('');
console.log('=== 9. 只降级、绝不删除节点 ===');
var before = h.st.nodes.length;
ok('降级过程中节点数不减', before === h.st.nodes.length, before + ' 格');

console.log('');
console.log('='.repeat(64));
if (fails.length) {
  console.log(' ❌ ' + fails.length + ' 条未通过：');
  fails.forEach(function (x) { console.log('    · ' + x); });
  process.exit(1);
}
console.log(' ✅ 全部通过 —— 「水见底才开始降级」的语义成立。');
process.exit(0);
