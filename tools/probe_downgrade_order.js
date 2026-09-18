/* 验证「缺水时离核心越远越先降级」是否真的成立。
 *
 * 为什么要单独验证：downgradeOrder 用的 nd.dist 是 BFS 跳数（沿菌丝网络到核心），
 * 不是欧氏直线距离。两者在绕路/贴边生长时会不一致。
 * 光看代码不算验证 —— 这里造一个网络、把水抽干、逐级记录谁掉了。
 *
 * 跑法：node tools/probe_downgrade_order.js
 */
'use strict';
var Sim = require('../src/sim.js');
var CONFIG = require('../src/config.js');

function buildRun(shape) {
  var st = Sim.newGame(20260918, {}, {});
  st.res.water = 1e6;                    // 铺路阶段不缺水，先把形状搭出来
  var core = st.core;
  var placed = [];
  shape.forEach(function (p) {
    var x = core.x + p[0], y = core.y + p[1];
    var g = st.grid[y * st.mapW + x];
    if (g) g.soil = 'litter';           // 给它点产出，别是岩石
    var r = Sim.growAt(st, x, y);
    if (!r || r.ok === false) { console.log('  生长失败 @', x, y, r && r.reason); return; }
    placed.push(st.nodeAt[y * st.mapW + x]);
  });
  // 全部练到 Lv5
  placed.forEach(function (id) {
    var nd = st.nodes[id];
    if (nd) { nd.level = 5; nd.pinned = false; }
  });
  Sim.rebuildNetwork(st);
  return st;
}

/* 一条向右的直线（最干净：BFS 跳数 == 欧氏距离） */
var LINE = [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0]];

console.log('=== 用例 1：笔直向右 7 格，全部 Lv5 ===');
var st = buildRun(LINE);
console.log('节点数', st.nodes.length, '（含核心）');
st.nodes.forEach(function (n, i) {
  if (i === 0) return;
  console.log('  节点', n.id, '格', n.x + ',' + n.y, 'BFS dist=' + n.dist,
              '等级=' + n.level);
});

/* 看降级顺序（不实际降，只看排序） */
var order = Sim.downgradeOrder(st);
console.log('降级顺序（先降的在前）:');
order.forEach(function (n, i) {
  console.log('  ' + (i + 1) + '. 节点' + n.id + ' dist=' + n.dist + ' Lv' + n.level);
});

/* 真的抽干水，看谁先掉 */
console.log('\n=== 用例 2：抽干水，观察前若干次降级落在哪些节点 ===');
var st2 = buildRun(LINE);
st2.res.water = 0;
var before = st2.nodes.map(function (n) { return n.level; });
var firstDrops = [];
for (var t = 0; t < 600; t++) {
  var d = Sim.settleMaintenance(st2, 1 / 30);
  if (d > 0) {
    // 找出这一 tick 是谁掉了
    st2.nodes.forEach(function (n, i) {
      if (before[i] > n.level) {
        if (firstDrops.length < 12) {
          firstDrops.push('tick' + t + ' 节点' + n.id + '(dist=' + n.dist + ') Lv' +
                          before[i] + '→' + n.level);
        }
      }
    });
    before = st2.nodes.map(function (n) { return n.level; });
  }
}
firstDrops.forEach(function (s) { console.log('  ' + s); });

/* 拐弯的网络：验证用的是 BFS 跳数而不是直线距离 */
console.log('\n=== 用例 3：L 形绕路。比较 BFS 跳数 vs 欧氏直线距离 ===');
var LSHAPE = [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [6, 1], [6, 2], [6, 3]];
var st3 = buildRun(LSHAPE);
console.log('节点 | 坐标 | BFS跳数 | 欧氏距离 | 该先降谁');
st3.nodes.forEach(function (n, i) {
  if (i === 0) return;
  var dx = n.x - st3.core.x, dy = n.y - st3.core.y;
  var eu = Math.sqrt(dx * dx + dy * dy);
  console.log('  节点' + n.id + ' | ' + n.x + ',' + n.y + ' | ' + n.dist +
              ' | ' + eu.toFixed(2) + ' |');
});
console.log('降级顺序:');
Sim.downgradeOrder(st3).forEach(function (n, i) {
  console.log('  ' + (i + 1) + '. 节点' + n.id + ' BFS=' + n.dist + ' Lv' + n.level);
});

/* 锁定是否被尊重 */
console.log('\n=== 用例 4：锁定最远的节点，看它是否被排到最后 ===');
var st4 = buildRun(LINE);
var farId = st4.nodes[st4.nodes.length - 1].id;
Sim.togglePin(st4, farId);
console.log('锁定节点', farId, '(dist=' + st4.nodes[farId].dist + ')');
console.log('降级顺序:');
Sim.downgradeOrder(st4).forEach(function (n, i) {
  console.log('  ' + (i + 1) + '. 节点' + n.id + ' dist=' + n.dist +
              (n.pinned ? ' [锁定]' : ''));
});

/* 核心自己是否会被降级 / 各种极端情况 */
console.log('\n=== 用例 5：核心免疫 + 极端情况 ===');
var st5 = buildRun(LINE);
var coreNode = st5.nodes[0];
coreNode.level = 9;                          // 故意给核心一个高等级
console.log('核心等级=' + coreNode.level + ' dist=' + coreNode.dist);
var ord5 = Sim.downgradeOrder(st5);
console.log('降级序列里是否含核心:',
            ord5.some(function (n) { return n.id === 0; }) ? '是（BUG）' : '否（正确）');
var beforeCore = coreNode.level;
st5.res.water = 0;
for (var t2 = 0; t2 < 3000; t2++) Sim.settleMaintenance(st5, 1 / 30);
console.log('抽干 100 秒后，核心等级=' + coreNode.level +
            '（应为 ' + beforeCore + ' 不变）');
var allZero = st5.nodes.every(function (n) { return n.level === 0 || n.id === 0; });
console.log('其余节点是否全降到 0:', allZero ? '是' : '否');
console.log('节点数是否守恒（绝不摧毁节点）:', st5.nodes.length);
console.log('最终水量是否非负:', st5.res.water >= 0 ? '是' : '否（BUG: ' + st5.res.water + '）');

/* 一个节点都没练时的短路 */
console.log('\n=== 用例 6：零等级零成本短路 ===');
var st6 = Sim.newGame(20260918, {}, {});
st6.res.water = 500;
var ret = Sim.settleMaintenance(st6, 1);
console.log('全零级时返回', ret, '；maintainCost=' + st6.maintainCost,
            '；水量=' + st6.res.water + '（应保持 500）');
