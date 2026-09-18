/* 验证「全网络满级」到底可不可能，以及多高维持费才能压住它。
 *
 * 关键指标：
 *   - 达到 Lv8+ 的节点数占比（用户明确要求：绝不能全是 8 级以上）
 *   - 平均等级
 *   - 稳态水量（应该停在一个有限值，而不是无界增长）
 *
 * 用法：node tools/probe_ceil.js [秒数]
 */
'use strict';
var path = require('path');
var Sim = require(path.join(__dirname, '..', 'src', 'sim.js'));
var CONFIG = require(path.join(__dirname, '..', 'src', 'config.js'));

var DURATION = Number(process.argv[2]) || 2400;
var DT = 0.25;
var SEEDS = [12345, 777, 20260917];

/* 一个「最大化深耕」的玩家：所有养分优先喂节点，且尽量往高练。
 * 这是最坏情况 —— 如果连他都练不出满级网络，机制就算成功。 */
function run(seed, duration, k) {
  var st = Sim.newGame(seed, {}, {});
  st.policy = 'nearest';
  CONFIG.MAINT.costPerLevel = k;

  var clickTimer = 0;
  var marks = [];
  var nextMark = 0;
  var maxDowngrades = 0;

  for (var t = 0; t < duration; t += DT) {
    Sim.tick(st, DT);

    clickTimer += DT;
    while (clickTimer >= 1.0) {
      clickTimer -= 1.0;
      var b = Sim.bestCandidate(st);
      if (!b || b.cost > st.res.water) break;
      if (!Sim.growAt(st, b.x, b.y).ok) break;
    }

    // 只买维持网络必需的升级，其余养分全省下来练节点
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

    /* 深耕：把养分**全花光**在节点上（真实玩家不会攒着不用）。
     * 早期版本每个 tick 只升 1 级，练级速度根本追不上降级配额（每秒 3 级），
     * 于是量出来的「等级总和」其实是探针的练级速度，不是机制的上限（假象）。
     * 这里改成每 tick 反复升直到养分不够 —— 这才是「想练满」的真实行为。 */
    for (var guard = 0; guard < 5000; guard++) {
      var best = null, bs = -Infinity;
      for (var i = 1; i < st.nodes.length; i++) {
        var nd = st.nodes[i];
        if (nd.level >= 10) continue;
        var cost2 = Sim.nodeUpgradeCost(st, nd);
        if (!isFinite(cost2) || st.res.nutrient < cost2) continue;
        // 优先练近核的（这是「最会维持」的策略），其次优先便宜的低等级节点
        var s = -nd.dist * 3 - cost2 * 0.001;
        if (s > bs) { bs = s; best = i; }
      }
      if (best === null) break;
      if (!Sim.upgradeNode(st, best).ok) break;
    }

    if (st.counters.maintainDowngrades > maxDowngrades) maxDowngrades = st.counters.maintainDowngrades;

    if (t >= nextMark) {
      nextMark += 600;
      var hi = 0, sum = 0, n = st.nodes.length;
      for (var j = 0; j < n; j++) {
        var L = st.nodes[j].level || 0;
        if (L > CONFIG.BLIGHT.maxLevel) hi++;   // Lv8+
        sum += L;
      }
      marks.push({
        t: t, nodes: n, hiRatio: hi / Math.max(1, n), avg: sum / Math.max(1, n),
        water: st.res.water, down: maxDowngrades
      });
    }
  }
  return { marks: marks, final: marks[marks.length - 1], down: maxDowngrades,
           m9: !!st.milestones.m9 };
}

function avg(a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; }

console.log('「可维持的等级总和」验证   时长 ' + DURATION + 's   种子 ' + SEEDS.length + ' 个');
console.log('玩家类型：所有养分优先练节点（只管练，不管养不养得起）\n');
console.log('   k      等级总和   应≈554/k   平均等级   Lv8+占比   稳态水量   累计降级   m9');
var KS = [0, 1.0, 3.0, 6.0, 12.0];
KS.forEach(function (k) {
  var runs = SEEDS.map(function (s) { return run(s, DURATION, k); });
  var f = runs.map(function (r) { return r.final; });
  var lvSum = avg(f.map(function (x) { return x.avg * x.nodes; }));
  console.log('  ' + k.toFixed(2).padStart(5) +
    '  ' + String(Math.round(lvSum)).padStart(8) +
    '  ' + String(Math.round(554 / (k || 1))).padStart(9) +
    '  ' + avg(f.map(function (x) { return x.avg; })).toFixed(2).padStart(9) +
    '  ' + (avg(f.map(function (x) { return x.hiRatio; })) * 100).toFixed(1).padStart(7) + '%' +
    '  ' + String(Math.round(avg(f.map(function (x) { return x.water; })))).padStart(9) +
    '  ' + String(Math.round(avg(runs.map(function (r) { return r.down; })))).padStart(8) +
    '  ' + String(runs.filter(function (r) { return r.m9; }).length + '/' + runs.length).padStart(4));
});

// 各 k 下的成长曲线（用第一个种子）
console.log('\n--- 各 k 的成长曲线（种子 ' + SEEDS[0] + '）---');
KS.forEach(function (k) {
  var r = run(SEEDS[0], DURATION, k);
  console.log(' k=' + k.toFixed(2) + '  ' + r.marks.map(function (m) {
    return m.t + 's:节点' + m.nodes + ' Lv8+占' + (m.hiRatio * 100).toFixed(0) + '% 均' + m.avg.toFixed(1);
  }).join(' | '));
});
