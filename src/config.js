/* ============================================================================
 * 菌丝 Mycelium — 游戏数据与平衡参数
 * 所有可调数值集中在这里，改这个文件就能调平衡。
 * 调完务必跑： node tools/headless_sim.js
 * ==========================================================================*/
var CONFIG = (function () {
  'use strict';

  /* ---- 地图 ---------------------------------------------------------- */
  var GRID = { W: 34, H: 20, CELL: 26, OX: 16, OY: 16 };

  /* ---- 基质：地图上每块土壤的类型 -------------------------------------
   * yield 是「每秒产出」，最终还要乘运输效率（距离越远越亏）。
   * 配色整体压暗：菌丝是亮色的，土壤必须够暗，网络才读得出来。               */
  var SOILS = {
    core:   { key: 'core',   name: '孢子落点', short: '核心', color: 0xF0C87E,
              yield: {},                       growCost: 0,    solid: false },
    soil:   { key: 'soil',   name: '普通壤土', short: '壤土', color: 0x3B3227,
              yield: { water: 0.12 },          growCost: 8,    solid: false },
    litter: { key: 'litter', name: '落叶层',   short: '落叶', color: 0x5C4526,
              yield: { nutrient: 0.55 },       growCost: 12,   solid: false },
    wood:   { key: 'wood',   name: '腐木',     short: '腐木', color: 0x3A2718,
              yield: { nutrient: 1.80 },       growCost: 22,   solid: false },
    vein:   { key: 'vein',   name: '地下水脉', short: '水脉', color: 0x1D4B63,
              yield: { water: 1.00 },          growCost: 20,   solid: false },
    root:   { key: 'root',   name: '树根',     short: '树根', color: 0x27522F,
              yield: { spore: 0.40 },          growCost: 30,   solid: false },
    rock:   { key: 'rock',   name: '岩块',     short: '岩石', color: 0x22222A,
              yield: {},                       growCost: 0,    solid: true  }
  };

  /* 地图生成比例。稀有度就是取舍的来源。 */
  var GEN = {
    rockClusters: 14,
    rockClusterSize: 5.5,
    woodBlobs: 8,
    woodBlobSize: 3.4,
    rootBlobs: 9,
    rootBlobSize: 3.0,
    veinRivers: 3,
    veinLength: 26,
    veinWidth: 1.4,
    noiseScale: 0.11,
    litterThreshold: 0.50   // 噪声高于此值即为落叶层
  };

  /* ---- 资源 ---------------------------------------------------------- */
  var START = {
    water: 40,
    nutrient: 0,
    spore: 0,
    seep: 0.45              // 核心自身的渗水速率（开局的主要水来源）
  };

  /* 网络代谢：每个菌丝节点都会微量产生孢子。
   * 这样「孢子 = 网络规模」而不是只靠稀有的树根，
   * 保证扩张永远有收益（增量游戏的基本要求），树根则是加速器。 */
  var SPORE_METABOLISM = 0.010;

  /* ---- 生长成本 ------------------------------------------------------ */
  var GROW = {
    distCost: 0.12,         // 每格距离 +12% 水耗
    autoInterval: 6.0,      // 自动扩张基准间隔（秒）
    autoDecay: 0.86         // 每级 ×0.86
  };

  /* ---- 运输 ----------------------------------------------------------
   * 两段式瓶颈，故意让它们在不同阶段发力：
   *   前中期：距离损耗主导 → 「近的低产 vs 远的高产」是核心取舍，
   *           靠「运输效率」升级把远处的富矿变得值得修路。
   *   后期  ：总吞吐封顶 → 网络铺大后核心会堵，靠「菌丝加粗」升级扩吞吐。
   * 吞吐上限不能设低：那样会变成「扩张反而没收益」，与增量游戏相悖。
   * 玩家能在界面上看到「拥堵损耗」，它就是升级加粗的信号。               */
  var TRANSPORT = {
    distLoss: 0.055,        // 每格距离损耗：效率 = 1/(1 + dist * loss)
    transportDecay: 0.88,   // 运输效率升级：loss × 0.88^级
    baseCapacity: 140,      // 单节点每秒货物吞吐（水不受此限）
    coreCapacity: 110,      // 核心吞吐上限
    capacityPerLevel: 0.40, // 每级加粗 +40% 吞吐
    /* 软上限：超过吞吐后不是全部丢掉，而是只有 30% 能挤过去。
     * 硬上限会让「扩张 = 没收益」，与增量游戏的根本冲突；
     * 软上限则让超载明显不划算，从而让「菌丝加粗」成为真有价值的升级，
     * 同时又不会把扩张的收益彻底掐死。
     * 数值定得偏宽：实测若设紧，深耕流把节点练高后会有 1/3 产量白扔，
     * 那种「升级了却被浪费」的手感很差。现在只在极端堆产能时才会告警。 */
    overflowPass: 0.30
  };

  /* ---- 升级树（每项都有真实代价，逼迫取舍）---------------------------- */
  var UPGRADES = [
    { key: 'absorption', name: '吸收效率', desc: '养分产出 +18% / 级', base: 25, growth: 1.34,
      effect: '养分产出 ×(1 + 0.18×级)' },
    { key: 'hydration',  name: '水分效率', desc: '水分产出 +18% / 级', base: 22, growth: 1.32,
      effect: '水分产出 ×(1 + 0.18×级)' },
    { key: 'transport',  name: '运输效率', desc: '距离损耗 -12% / 级', base: 40, growth: 1.34,
      effect: '距离损耗 = 5.5% × 0.88^级' },
    { key: 'capacity',   name: '菌丝加粗', desc: '吞吐上限 +25% / 级', base: 35, growth: 1.34,
      effect: '节点吞吐 ×(1 + 0.25×级)' },
    { key: 'growth',     name: '生长效率', desc: '生长水耗 -7% / 级',  base: 24, growth: 1.32,
      effect: '生长水耗 ×0.93^级' },
    { key: 'symbiosis',  name: '共生深度', desc: '孢子产出 +18% / 级', base: 70, growth: 1.38,
      effect: '孢子产出 ×(1 + 0.18×级)' },
    { key: 'autoGrow',   name: '蔓延速度', desc: '自动扩张间隔 ×0.86 / 级', base: 60, growth: 1.34,
      max: 12, effect: '基准 6.0s 起，每级 ×0.86' },
    { key: 'sight',      name: '感知范围', desc: '可见半径 +1 格 / 级', base: 45, growth: 1.36,
      max: 8, effect: '可见半径 +1 格 / 级' }
  ];

  /* ---- 散播孢子（转生）------------------------------------------------
   * 生物学上黏菌在食物耗尽时会形成子实体并释放孢子。                        */
  var PRESTIGE = {
    firstCost: 700,
    costGrowth: 1.6,
    geneDivisorNutrient: 1500,
    geneDivisorSpore: 150
  };

  /* 基因点天赋（永久，跨转生） */
  var GENES = [
    { key: 'gYield',  name: '丰饶', desc: '所有产出 +12% / 级',   base: 1, growth: 1.6 },
    { key: 'gWater',  name: '蓄水', desc: '初始水 +150 / 级',     base: 1, growth: 1.6 },
    { key: 'gGrowth', name: '速生', desc: '生长水耗 -6% / 级',    base: 2, growth: 1.6 },
    { key: 'gRate',   name: '渗透', desc: '核心渗水 +0.4/s / 级', base: 2, growth: 1.7 }
  ];

  /* ---- 扩张策略：挂机时自动扩张的选址倾向（玩家的策略设置）------------- */
  var POLICIES = [
    { key: 'nearest',  name: '就近蔓延', desc: '优先最便宜的邻格，铺得快' },
    { key: 'richest',  name: '择优蔓延', desc: '优先原始产出最高的邻格' },
    { key: 'water',    name: '找水脉',   desc: '优先水脉，扩张续航强' },
    { key: 'nutrient', name: '找养分',   desc: '优先落叶与腐木，升级快' },
    { key: 'spore',    name: '找树根',   desc: '优先树根，专攻散播' }
  ];

  /* ---- 节点强化 -------------------------------------------------------
   * 让「点击」有两个用途：长新格子 / 强化老格子。
   * 强化是「深耕流」落到操作上的具体形态。                                 */
  var NODE_UP = {
    baseCost: 26,          // 养分
    /* 成本增速刻意设陡（1.72 > 收益增速 1.25 的倒数）：
     * 实测若设成 1.55，玩家把养分全砸节点就能碾压其他所有路线（强 3.3 倍），
     * 「最优解唯一」等于又变回无聊。现在它有明确的边际递减，
     * 全局升级会和它形成竞争。 */
    costGrowth: 1.72,
    maxLevel: 10,
    yieldPerLevel: 0.25,   // 每级 +25% 该节点产出
    capPerLevel: 0.18      // 每级 +18% 该节点吞吐（练节点同时也在加粗）
  };

  /* ---- 主动技能（带冷却）----------------------------------------------
   * 放置游戏最容易变无聊的地方是「没事可做」。技能让手上有事，
   * 并且制造「攒着等时机 → 一波爆发」的节奏感。                            */
  var ABILITIES = [
    { key: 'pulse',     name: '菌丝脉冲', hint: '8 秒内蔓延速度 ×4',        cd: 40, slot: '1' },
    { key: 'digest',    name: '酶解',     hint: '立刻结算 30 秒的养分产出', cd: 55, slot: '2' },
    { key: 'sporulate', name: '孢子爆',   hint: '立刻获得 孢子 = 菌丝数×1.5', cd: 90, slot: '3' }
  ];

  /* ---- 地图事件 -------------------------------------------------------
   * 关键设计：全部是「正面或中性」的。
   * 被忽视只会错过一笔收益，绝不造成永久损失 —— 放置游戏玩家会离开，
   * 惩罚性设计会让「回来一看全毁了」的体验直接劝退。                       */
  var EVENTS = {
    firstAt: 45,           // 第几秒来第一场
    intervalMin: 55,       // 之后间隔随机区间（秒）
    intervalMax: 95,
    buffDur: 45,           // 增益区持续时间
    buffMul: 3.0,          // 增益倍率
    buffRadius: 3.2,       // 增益区半径（格）
    gnatInterval: 15,      // 害虫每隔多少秒繁殖一只
    gnatMax: 3,            // 同时最多几只
    gnatReward: 45         // 驱除一只奖励的养分
  };

  /* ---- 里程碑 ---------------------------------------------------------
   * 渐进解锁。一开局就把所有东西摆在眼前，是「内容很多但很平」的常见死因。   */
  var MILESTONES = [
    { id: 'm1', name: '扎根', need: '网络达到 12 格',        reward: '解锁「菌丝脉冲」+ 300 水分' },
    { id: 'm2', name: '寻水', need: '连上地下水脉',          reward: '水分产出 +25%' },
    { id: 'm3', name: '腐殖', need: '连上腐木',              reward: '解锁「酶解」' },
    { id: 'm4', name: '共生', need: '连上树根',              reward: '解锁「孢子爆」' },
    { id: 'm5', name: '主干', need: '任一节点强化到 5 级',   reward: '全部产出 +10%' },
    { id: 'm6', name: '扩张', need: '网络达到 60 格',        reward: '+2 基因点' },
    { id: 'm7', name: '抗虫', need: '驱除 5 只害虫',         reward: '害虫繁殖速度减半' },
    { id: 'm8', name: '循环', need: '完成一次散播',          reward: '+3 基因点' }
  ];

  return {
    GRID: GRID, SOILS: SOILS, GEN: GEN, START: START,
    SPORE_METABOLISM: SPORE_METABOLISM,
    GROW: GROW, TRANSPORT: TRANSPORT, UPGRADES: UPGRADES,
    PRESTIGE: PRESTIGE, GENES: GENES, POLICIES: POLICIES,
    NODE_UP: NODE_UP, ABILITIES: ABILITIES, EVENTS: EVENTS, MILESTONES: MILESTONES
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = CONFIG; }
else { window.MYC = window.MYC || {}; window.MYC.CONFIG = CONFIG; }
