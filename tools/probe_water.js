/* 探查：后期水分到底过不过剩、需不需要「维护成本」。
 * 用法：node tools/probe_water.js [秒数]
 *
 * 跑法模仿一个正常玩家：按策略点格子、买升级、驱虫。
 * 每 5 分钟采样一次：水量、水的净流入、节点数、节点等级分布。
 */
'use strict';
var path = require('path');
var Sim = require(path.join(__dirname, '..', 'src', 'sim.js'));

var DURATION = Number(process.argv[2]) || 3600;
var DT = 0.25;

function run(seed, duration) {
  var state = Sim.newGame(seed, {}, {});
  state.policy = 'richiest' in {} ? 'nearest' : 'nearest';
  state.policy = 'nearest';

  var log = [];
  var nextSample = 0;
  var clickTimer = 0;
  var clickInterval = 1.0;              // 1 次/秒点击

  for (var t = 0; t < duration; t += DT) {
    Sim.tick(state, DT);

    clickTimer += DT;
    while (clickTimer >= clickInterval) {
      clickTimer -= clickInterval;
      var best = Sim.bestCandidate(state);
      if (!best || best.cost > state.res.water) break;
      if (!Sim.growAt(state, best.x, best.y).ok) break;
    }

    // 一个正常玩家：能买的升级就买
    var prio = ['autoGrow', 'growth', 'hydration', 'absorption', 'capacity', 'transport'];
    for (var pi = 0; pi < prio.length; pi++) {
      var key = prio[pi], guard = 0;
      while (guard++ < 200) {
        var c = Sim.upgradeCost(state, key);
        if (!isFinite(c) || state.res.nutrient < c) break;
        if (!Sim.buyUpgrade(state, key).ok) break;
      }
    }

    // 解锁自动蔓延（模拟玩家达到门槛）
    if (state.nodes.length >= 250) state.autoGrow = true;

    if (t >= nextSample) {
      nextSample += 300;
      var maxLvl = 0, sumLvl = 0;
      for (var i = 0; i < state.nodes.length; i++) {
        var L = state.nodes[i].level || 0;
        sumLvl += L; if (L > maxLvl) maxLvl = L;
      }
      log.push({
        t: Math.round(t),
        water: Math.round(state.res.water),
        inRate: state.rate ? state.rate.water : 0,      // 水的净流入 /s
        nodes: state.nodes.length,
        maxLvl: maxLvl,
        avgLvl: sumLvl / Math.max(1, state.nodes.length),
        nutrient: Math.round(state.res.nutrient),
        lost: Math.round(state.lostTotal || 0)
      });
    }
  }
  return log;
}

var out = run(12345, DURATION);
console.log('t(s)\twater\twater/s\tnodes\tmaxLv\tavgLv\tnutrient\tlost');
out.forEach(function (r) {
  console.log([r.t, r.water, r.inRate.toFixed(1), r.nodes, r.maxLvl, r.avgLvl.toFixed(2), r.nutrient, r.lost].join('\t'));
});

console.log('\n--- 满级节点维持费推演（Lv10 节点）---');
for (var k = 0.02; k <= 0.201; k += 0.02) {
  var per = 10 * k;
  console.log('k=' + k.toFixed(2) + '/级/秒 → 单个Lv10 ' + per.toFixed(2) +
    '/s；3个防火墙 ' + (per * 3).toFixed(2) + '/s；10个 ' + (per * 10).toFixed(2) + '/s');
}
console.log('\n--- 参考：核心渗水 0.45/s（gRate 每级 +0.4/s）；水脉节点 1.00/s；壤土 0.12/s ---');
