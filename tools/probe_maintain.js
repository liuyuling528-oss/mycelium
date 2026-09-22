/* ============================================================================
 * 维护耗水 + 远端优先降级：参数扫描
 *
 * 要回答的问题（按重要性排序）：
 *   1. k（每级每秒耗水）取多少，后期水量才会被压到合理区间？
 *   2. 降级会不会把 m9「同时 3 个 Lv8+ 节点」变成不可能？（防火墙会自己掉级）
 *   3. 会不会把「深耕流」压死 —— 练节点变成负收益，最优解变成不练？
 *   4. 前 5 分钟（水还没富余时）会不会被维持费拖死？
 *
 * 用法：node tools/probe_maintain.js [秒数]
 * ==========================================================================*/
'use strict';
var path = require('path');
var Sim = require(path.join(__dirname, '..', 'src', 'sim.js'));
var CONFIG = require(path.join(__dirname, '..', 'src', 'config.js'));

var DURATION = Number(process.argv[2]) || 1800;
var DT = 0.25;
var SEEDS = [12345, 777, 20260917];

/* ---- 策略：是否练节点 + 练到什么程度 ---- */
function makePlayer(opts) {
  return {
    policy: 'nearest',
    nodeFocus: !!opts.nodeFocus,
    target: opts.target || 0,        // 练节点时，目标等级上限
    priority: opts.priority || ['autoGrow', 'growth', 'hydration', 'absorption', 'capacity', 'transport']
  };
}

function spendUpgrades(state, priority, reserve) {
  for (var pi = 0; pi < priority.length; pi++) {
    var g = 0;
    while (g++ < 200) {
      var c = Sim.upgradeCost(state, priority[pi]);
      if (!isFinite(c) || state.res.nutrient < c) break;
      if (Sim.buyUpgrade(state, priority[pi]).ok) { /* continue */ } else break;
    }
  }
}

function trainNodes(state, target, budget) {
  var done = 0;
  for (var guard = 0; guard < 40 && done < budget; guard++) {
    var best = null, bs = -Infinity;
    for (var i = 1; i < state.nodes.length; i++) {
      var nd = state.nodes[i];
      if (nd.level >= target) continue;
      var cost = Sim.nodeUpgradeCost(state, nd);
      if (!isFinite(cost) || state.res.nutrient < cost) continue;
      // 越靠近核心越优先练：这样高等级节点能稳定维持
      var s = -nd.dist * 2 - cost * 0.01;
      if (s > bs) { bs = s; best = i; }
    }
    if (best === null) break;
    if (!Sim.upgradeNode(state, best).ok) break;
    done++;
  }
  return done;
}

function run(player, seed, duration, maintK) {
  var state = Sim.newGame(seed, {}, {});
  state.policy = player.policy;
  CONFIG.MAINT.costPerLevel = maintK;      // 扫描用：直接改配置

  var samples = [];
  var nextSample = 0;
  var clickTimer = 0;
  var dipped = 0;                          // 水见底（maintainPressure）的 tick 数
  var downgrades = 0;
  var minWater = Infinity;
  var maxFwLv = 0;

  for (var t = 0; t < duration; t += DT) {
    var lvBefore = {};
    Sim.tick(state, DT);
    if (state.counters.maintainDowngrades != null) {
      downgrades = state.counters.maintainDowngrades;
    }
    if (state.maintainPressure) dipped++;

    clickTimer += DT;
    while (clickTimer >= 1.0) {
      clickTimer -= 1.0;
      var best = Sim.bestCandidate(state);
      if (!best || best.cost > state.res.water) break;
      if (!Sim.growAt(state, best.x, best.y).ok) break;
    }
    spendUpgrades(state, player.priority, 0);
    if (state.nodes.length >= 250) state.autoGrow = true;
    if (player.nodeFocus && state.res.nutrient > 200) trainNodes(state, player.target, 3);

    if (state.res.water < minWater) minWater = state.res.water;

    if (t >= nextSample) {
      nextSample += 300;
      var fw = 0, mx = 0, sum = 0, sumDist = 0, n = 0;
      for (var i = 0; i < state.nodes.length; i++) {
        var L = state.nodes[i].level || 0;
        if (L > 7) fw++;
        if (L > mx) mx = L;
        sum += L; sumDist += L * (state.nodes[i].dist || 0); n++;
      }
      if (mx > maxFwLv) maxFwLv = mx;
      samples.push({
        t: t, water: state.res.water, nodes: state.nodes.length,
        maxLv: mx, fw: fw, avgLv: sum / Math.max(1, n),
        avgLvDist: sum > 0 ? sumDist / sum : 0,
        nutrient: state.res.nutrient, down: downgrades
      });
    }
  }
  return {
    seed: seed, samples: samples, downgrades: downgrades,
    maxFwLv: maxFwLv, minWater: minWater,
    finalWater: state.res.water, nodes: state.nodes.length,
    // m9 达成过吗？（同一时刻 3 个 Lv8+）
    m9: !!state.milestones.m9
  };
}

function avg(a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; }

/* --------------------------------------------------------------- 扫描 */
var KS = [0, 0.10, 0.25, 0.40, 0.70, 1.00];
console.log('维护耗水参数扫描   时长 ' + DURATION + 's   种子 ' + SEEDS.join(','));
console.log('策略：nearest 铺满 + 就近练节点到 Lv' + '(见列)\n');
console.log('说明：k=0 是现状基准\n');
console.log('  k     终局水量     终局节点  maxLv  防火墙Lv8+  m9达成  累计降级  最低水量  平均等级  平均离核距离');
for (var ki = 0; ki < KS.length; ki++) {
  var k = KS[ki];
  var runs = SEEDS.map(function (s) {
    return run(makePlayer({ nodeFocus: true, target: 10 }), s, DURATION, k);
  });
  var last = runs.map(function (r) { return r.samples[r.samples.length - 1]; });
  console.log('  ' + k.toFixed(2).padStart(5) +
    '  ' + String(Math.round(avg(runs.map(function (r) { return r.finalWater; })))).padStart(10) +
    '  ' + String(Math.round(avg(runs.map(function (r) { return r.nodes; })))).padStart(8) +
    '  ' + String(Math.max.apply(null, runs.map(function (r) { return r.maxFwLv; }))).padStart(5) +
    '  ' + String(Math.round(avg(last.map(function (l) { return l.fw; })))).padStart(9) +
    '  ' + String(runs.filter(function (r) { return r.m9; }).length + '/' + runs.length).padStart(6) +
    '  ' + String(Math.round(avg(runs.map(function (r) { return r.downgrades; })))).padStart(8) +
    '  ' + String(Math.round(avg(runs.map(function (r) { return r.minWater; })))).padStart(8) +
    '  ' + avg(last.map(function (l) { return l.avgLv; })).toFixed(2).padStart(7) +
    '  ' + avg(last.map(function (l) { return l.avgLvDist; })).toFixed(1).padStart(8));
}

/* 第二张表：不练节点的玩家（纯扩张）——维护费应该几乎不影响他 */
console.log('\n对照：纯扩张流（不练节点），看维护费会不会误伤他们');
console.log('  k     终局水量     终局节点  累计降级');
for (var kj = 0; kj < KS.length; kj++) {
  var k2 = KS[kj];
  var cr = SEEDS.map(function (s) {
    return run(makePlayer({ nodeFocus: false }), s, DURATION, k2);
  });
  console.log('  ' + k2.toFixed(2).padStart(5) +
    '  ' + String(Math.round(avg(cr.map(function (r) { return r.finalWater; })))).padStart(10) +
    '  ' + String(Math.round(avg(cr.map(function (r) { return r.nodes; })))).padStart(8) +
    '  ' + String(Math.round(avg(cr.map(function (r) { return r.downgrades; })))).padStart(8));
}
