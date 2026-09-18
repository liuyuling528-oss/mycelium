/* ============================================================================
 * 离线平衡模拟（Node 直接跑，不需要浏览器）
 *
 * 存在的意义：
 *   上一版游戏的致命缺陷是「玩家所有决策对结果没有影响」。
 *   所以这里用对照实验验证两件事：
 *     A. 不同策略是否真的产出不同结果？      （策略有意义）
 *     B. 主动点击是否比纯挂机更强？          （注意力有价值）
 *   如果都不成立，说明设计失败，必须先改数值，不要急着写渲染层。
 *
 * 用法： node tools/headless_sim.js [模拟秒数]
 * ==========================================================================*/
'use strict';

const path = require('path');
const Sim = require(path.join(__dirname, '..', 'src', 'sim.js'));
const CONFIG = require(path.join(__dirname, '..', 'src', 'config.js'));

const DURATION = Number(process.argv[2]) || 1800;
const DT = 0.25;

/* 策略 = 升级优先级 + 扩张选址策略 + 基因点偏向 + 点击频率 + 是否强化节点
 * nodeFocus 就是「深耕流」落到操作上的形态：不铺广，而是把少数节点练到高等级。 */
/* 自动蔓延现在是 m10 里程碑解锁（探索到全部 4 种特殊基质），
 * 所以每个策略都带 clicks:1 —— 前期必须手动点击跑图，
 * 点着点着探齐基质、解锁自动蔓延，这个节奏本身就是平衡的一部分。 */
const STRATEGIES = [
  { key: 'none',   name: '① 躺平流：永不升级',       priority: [], policy: 'nearest',  genes: [], clicks: 1, nodeFocus: false },
  { key: 'expand', name: '② 扩张流：铺满近处',       priority: ['autoGrow', 'growth', 'hydration', 'absorption', 'capacity'], policy: 'nearest', genes: ['gYield', 'gRate'], clicks: 1, nodeFocus: false },
  { key: 'deep',   name: '③ 深耕流：练节点+抢富矿', priority: ['transport', 'capacity', 'absorption', 'autoGrow', 'growth', 'hydration'], policy: 'nutrient', genes: ['gYield', 'gGrowth'], clicks: 1, nodeFocus: true },
  { key: 'sym',    name: '④ 共生流：专攻树根刷孢子', priority: ['autoGrow', 'symbiosis', 'growth', 'hydration', 'absorption'], policy: 'spore', genes: ['gYield', 'gGrowth'], clicks: 1, nodeFocus: false },
  { key: 'water',  name: '⑤ 找水流：沿水脉扩张',     priority: ['autoGrow', 'hydration', 'growth', 'absorption', 'transport'], policy: 'water', genes: ['gRate', 'gYield'], clicks: 1, nodeFocus: false },
  { key: 'blind',  name: '⑥ 择优流：只挑肥的不修路', priority: ['autoGrow', 'absorption', 'hydration', 'growth'], policy: 'richest', genes: ['gYield', 'gRate'], clicks: 1, nodeFocus: false }
];

/* 一个「会回应」的玩家：技能一好就用，害虫立刻驱除。
 * 菌瘟**不能手动净化** —— 主动玩家对菌瘟的答案是防火墙（把节点练到比瘟高一级），
 * 那由 nodeFocus 落地；模拟里不再有「点掉瘟」这条捷径。 */
function respondToEvents(state) {
  for (const a of CONFIG.ABILITIES) {
    if (Sim.abilityReady(state, a.key)) Sim.useAbility(state, a.key);
  }
  for (let i = state.events.length - 1; i >= 0; i--) {
    const e = state.events[i];
    if (e.kind === 'gnat') Sim.removeGnat(state, e.nodeId);
  }
}

/* 深耕：把养分投到少数高价值节点上，而不是无限铺格子 */
function upgradeNodes(state, budget) {
  const weight = { wood: 4, root: 4, vein: 3, litter: 3, soil: 1, core: 0 };
  let done = 0;
  for (let guard = 0; guard < 300 && done < budget; guard++) {
    let best = null, bestScore = -Infinity;
    for (let i = 1; i < state.nodes.length; i++) {
      const nd = state.nodes[i];
      const cost = Sim.nodeUpgradeCost(state, nd);
      if (!isFinite(cost) || state.res.nutrient < cost) continue;
      const s = (weight[nd.soil] || 1) * 20 - cost * 0.002 - nd.level * 3;
      if (s > bestScore) { bestScore = s; best = i; }
    }
    if (best === null) break;
    if (!Sim.upgradeNode(state, best).ok) break;
    done++;
  }
  return done;
}

function spendUpgrades(state, priority) {
  for (const key of priority) {
    let guard = 0;
    while (guard++ < 500) {
      const cost = Sim.upgradeCost(state, key);
      if (!isFinite(cost) || state.res.nutrient < cost) break;
      if (!Sim.buyUpgrade(state, key).ok) break;
    }
  }
}

function spendGenes(state, priority) {
  for (const key of priority) {
    let guard = 0;
    while (guard++ < 500) {
      const cost = Sim.geneCost(state, key);
      if (!isFinite(cost) || (state.pendingGenes || 0) < cost) break;
      if (!Sim.buyGene(state, key).ok) break;
    }
  }
}

function run(strategy, seed, duration) {
  const state = Sim.newGame(seed, {}, {});
  state.policy = strategy.policy;
  /* B 组对照（主动 vs 挂机）两边都先解锁自动蔓延 ——
   * 否则挂机那边连一格都长不出来，比的就不是「注意力」而是「能不能玩」。 */
  if (strategy.autoOn) {
    state.autoGrow = true;
    state.milestones.m10 = true;
  }

  const lifetime = { nutrient: 0, spore: 0 };
  const timeline = [];
  let nextSample = 300;
  let clickTimer = 0;
  const clickInterval = strategy.clicks > 0 ? 1 / strategy.clicks : Infinity;
  let clicks = 0;

  for (let t = 0; t < duration; t += DT) {
    Sim.tick(state, DT);

    // 玩家手动点击：按当前策略挑最值得的格子，能点就点
    if (clickInterval !== Infinity) {
      clickTimer += DT;
      while (clickTimer >= clickInterval) {
        clickTimer -= clickInterval;
        const best = Sim.bestCandidate(state);
        if (!best || best.cost > state.res.water) break;
        const r = Sim.growAt(state, best.x, best.y);
        if (!r.ok) break;
        clicks++;
      }
    }

    spendUpgrades(state, strategy.priority);

    // 内容层：技能照用、害虫照驱除 —— 但**只有「会回应」的玩家**才做。
    // 挂机跑不回应事件：害虫会繁殖、菌瘟会蔓延。菌瘟不能净化，
    // 双方都只能靠防火墙硬扛（围死它要连续两个周期，撑不到就烂一片）——
    // 注意力的价值转移到「网络结构」上。
    if (strategy.clicks > 0) respondToEvents(state);
    // 深耕流另外把养分投到少数节点上
    if (strategy.nodeFocus && state.res.nutrient > 400) upgradeNodes(state, 3);

    if (Sim.canPrestige(state)) {
      const before = { n: state.total.nutrient, s: state.total.spore };
      const r = Sim.doPrestige(state);
      if (r.ok) {
        lifetime.nutrient += before.n;
        lifetime.spore += before.s;
        spendGenes(state, strategy.genes);
      }
    }

    if (t >= nextSample) {
      timeline.push({
        t: Math.round(t), nodes: state.nodes.length, prestiges: state.prestiges,
        genes: totalGenes(state), nutrient: Math.round(state.total.nutrient),
        spore: Math.round(state.total.spore)
      });
      nextSample += 300;
    }
  }

  return {
    prestiges: state.prestiges,
    genes: totalGenes(state),
    nodes: state.nodes.length,
    maxDist: state.maxDist,
    clicks,
    milestones: Object.keys(state.milestones).length,
    gnats: state.counters.gnatsRemoved,
    maxNodeLevel: state.counters.maxNodeLevel,
    activeGnats: Sim.countGnats(state),
    lifetimeNutrient: Math.round(lifetime.nutrient + state.total.nutrient),
    lifetimeSpore: Math.round(lifetime.spore + state.total.spore),
    wasted: Math.round(state.lostTotal),
    bySoil: countSoil(state),
    timeline
  };
}

function totalGenes(state) {
  return Object.values(state.genes).reduce((a, b) => a + b, 0) + (state.pendingGenes || 0);
}

function countSoil(state) {
  const out = {};
  for (const n of state.nodes) out[n.soil] = (out[n.soil] || 0) + 1;
  return out;
}

/* 放置游戏的成败就是「转生滚雪球的速度」 */
function score(r) { return r.prestiges * 1000 + r.genes * 100 + r.lifetimeNutrient / 100; }

function avgOf(runs) {
  const n = runs.length;
  const mean = k => runs.reduce((a, r) => a + r[k], 0) / n;
  const avg = {
    prestiges: mean('prestiges'), genes: mean('genes'), nodes: mean('nodes'),
    lifetimeNutrient: mean('lifetimeNutrient'), lifetimeSpore: mean('lifetimeSpore'),
    wasted: mean('wasted'), clicks: mean('clicks'),
    milestones: mean('milestones'), gnats: mean('gnats'), maxNodeLevel: mean('maxNodeLevel'),
    bySoil: runs[0].bySoil, timeline: runs[0].timeline
  };
  avg.score = score(avg);   // 忘了算这个会让「主动/挂机」比值永远变成 ∞
  return avg;
}

/* ------------------------------------------------------------------ 跑 */
const SEEDS = [12345, 777, 20260917, 424242, 88888];
console.log('模拟时长 ' + DURATION + 's   种子 ' + SEEDS.join(', ') + '   步长 ' + DT + 's\n');

const results = [];
for (const s of STRATEGIES) {
  const runs = SEEDS.map(seed => run(s, seed, DURATION));
  const avg = avgOf(runs);
  avg.name = s.name; avg.key = s.key; avg.score = score(avg);
  results.push(avg);

  console.log(s.name);
  console.log(`   转生 ${avg.prestiges.toFixed(2)} | 基因点 ${avg.genes.toFixed(1)} | 终局菌丝 ${avg.nodes.toFixed(0)} 格 ` +
              `| 累计养分 ${Math.round(avg.lifetimeNutrient)} | 累计孢子 ${Math.round(avg.lifetimeSpore)} ` +
              `| 拥堵浪费 ${Math.round(avg.wasted)}`);
  console.log(`   里程碑 ${avg.milestones.toFixed(1)}/${CONFIG.MILESTONES.length} | 最高节点等级 ${avg.maxNodeLevel.toFixed(1)} ` +
              `| 驱除害虫 ${avg.gnats.toFixed(0)}`);
  console.log(`   基质构成 ${JSON.stringify(avg.bySoil)}\n`);
}

results.sort((a, b) => b.score - a.score);
console.log('='.repeat(80));
console.log(' A. 策略排名（按转生滚雪球速度）');
console.log('='.repeat(80));
results.forEach((r, i) => {
  console.log(` ${i + 1}. ${r.name.padEnd(30)} 转生 ${r.prestiges.toFixed(2).padStart(6)}  基因 ${r.genes.toFixed(1).padStart(6)}  综合分 ${String(Math.round(r.score)).padStart(6)}`);
});

const best = results[0], worst = results[results.length - 1];
const ratio = worst.score > 0 ? best.score / worst.score : Infinity;

console.log('');
console.log('='.repeat(80));
console.log(' B. 主动点击 vs 纯挂机（同策略，看注意力是否值钱）');
console.log('='.repeat(80));
/* B 组对照：两边都解锁自动蔓延，唯一变量是「会不会动手」——
 * 挂机 clicks:0（也不回应事件），主动 clicks:2。 */
const activeStrategy = Object.assign({}, STRATEGIES[2], { clicks: 2, autoOn: true });
const idleStrategy   = Object.assign({}, STRATEGIES[2], { clicks: 0, autoOn: true });
const idleAvg = avgOf(SEEDS.map(s => run(idleStrategy, s, DURATION)));
const actAvg  = avgOf(SEEDS.map(s => run(activeStrategy, s, DURATION)));
console.log(` 纯挂机  : 转生 ${idleAvg.prestiges.toFixed(2)}  基因 ${idleAvg.genes.toFixed(1)}  菌丝 ${idleAvg.nodes.toFixed(0)} 格  点击 ${idleAvg.clicks.toFixed(0)}`);
console.log(` 主动点击: 转生 ${actAvg.prestiges.toFixed(2)}  基因 ${actAvg.genes.toFixed(1)}  菌丝 ${actAvg.nodes.toFixed(0)} 格  点击 ${actAvg.clicks.toFixed(0)}`);
const clickRatio = idleAvg.score > 0 ? actAvg.score / idleAvg.score : Infinity;
console.log(` 主动/挂机 收益比 = ${clickRatio === Infinity ? '∞' : clickRatio.toFixed(2)}`);

console.log('');
console.log('='.repeat(80));
console.log(' 结论');
console.log('='.repeat(80));

let failed = false;
if (best.prestiges < 0.5 && best.genes < 1) {
  console.log(' ❌ 失败：游戏根本无法推进（没有任何策略能转生）。必须先修数值。');
  failed = true;
} else if (best.prestiges < 1.5) {
  console.log(` ❌ 失败：最好的策略 30 分钟只能转生 ${best.prestiges.toFixed(2)} 次 —— 转生滚雪球是放置游戏的引擎，太慢等于没有。`);
  failed = true;
} else if (ratio < 1.5) {
  console.log(` ❌ 失败：最强与最弱策略只差 ${ratio.toFixed(2)} 倍 —— 玩家的决策不影响结果。`);
  failed = true;
} else if (ratio < 3) {
  console.log(` ⚠️  策略差异 ${ratio.toFixed(2)} 倍，够用但还能再拉开。`);
} else {
  console.log(` ✅ 策略差异 ${ratio.toFixed(2)} 倍 —— 决策是有意义的。`);
}

if (idleAvg.prestiges > 0 && idleAvg.score === 0) {
  console.log(' ⚠️  纯挂机综合分为 0，挂机路线可能走不通。');
  failed = true;
} else if (clickRatio !== Infinity && clickRatio < 1.15) {
  console.log(' ⚠️  主动点击与纯挂机几乎没差别 —— 放置游戏可以接受，但手感会平。');
} else if (clickRatio !== Infinity) {
  console.log(` ✅ 主动点击收益是挂机的 ${clickRatio.toFixed(2)} 倍 —— 注意力有价值。`);
}

/* 拥堵损耗占比：太高说明吞吐上限设得和「扩张有收益」冲突了 */
const wasteRatio = best.lifetimeNutrient > 0 ? best.wasted / (best.wasted + best.lifetimeNutrient) : 0;
console.log(` · 拥堵损耗占产出 ${(wasteRatio * 100).toFixed(1)}%（应保持在低位，它是升级信号而不是惩罚）`);

console.log('');
console.log(' 最强策略成长曲线:');
console.log('  时间     菌丝   转生   基因   本局养分   本局孢子');
for (const p of best.timeline) {
  console.log(`  ${String(p.t).padStart(5)}s ${String(p.nodes).padStart(6)} ${String(p.prestiges).padStart(6)} ` +
              `${String(p.genes).padStart(6)} ${String(p.nutrient).padStart(10)} ${String(p.spore).padStart(10)}`);
}

process.exit(failed ? 1 : 0);
