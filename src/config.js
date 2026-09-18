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
    autoDecay: 0.86,        // 每级 ×0.86
    /* 自动蔓延解锁的节点门槛（m10「感知」= 历史上连上 4 种特殊基质 + 节点数达到这个规模）。
     * 250 是拿平衡模拟跑出来的：200→250 转生数完全不受影响（5.0 次），
     * 300 开始曲线陡增（解锁 12 分钟、种子方差大），500 有种子 30 分钟都解不了。 */
    autoUnlockNodes: 250
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

  /* ---- 菌瘟（后期挑战）-------------------------------------------------
   * 和害虫的区别：害虫是「随机冒出来」，菌瘟会**沿着菌丝蔓延** ——
   * 边缘不管，它就一路往核心爬，晚处理一次要多赔好几格产能。
   *
   * 生命周期（没有无条件自愈）：
   *   · 每 spreadInterval 秒尝试传播一次；
   *   · **传得出去就一直活着**，一直烂下去 —— 瘟不会自己好；
   *   · **连续 failLimit 个周期一个邻居都传不进去（被围死）→ 熄灭**：
   *     节点保留、恢复健康，相当于烧掉这一片保住整体 —— 绝不永久损失。
   *
   * 等级规则：感染只往「等级 ≤ 源头」的邻居菌丝传 —— 换句话说，
   * **把周边菌丝练到比瘟的等级高，就能挡住它**。围死它，两个周期后熄灭。
   * 自动滋生封顶 maxLevel：Lv8+ 的菌永远不会成为新的滋生点（终极防火墙）。
   *
   * **不能手动净化**：点一下就消掉还倒贴奖励，菌瘟就不配叫威胁了。
   * 玩家的应对 = 看清它几级 → 把去路上的菌丝练得比它高 → 围死 → 等熄灭。
   *
   * 一定规模后才出现（minNodes），前期保持安宁；数量封顶，永远不会掏空网络。 */
  var BLIGHT = {
    minNodes: 32,          // 网络到这个规模才可能出现
    spawnChance: 0.45,     // 事件判定时抽中菌瘟的概率（抽不中就走增益区）
    maxCount: 8,           // 同时最多几处
    maxLevel: 7,           // 自动滋生的最高宿主等级（瘟的等级 = 宿主等级）
    firewallNodes: 3,      // m9「防火墙」要求的 Lv8+ 节点数量
    spreadInterval: 21,    // 每处菌瘟每隔几秒尝试传播一次
    spreadChance: 0.55,    // 扩散成功率（随转生次数小幅上调）
    failLimit: 2           // 连续几个周期一个邻居都传不进去 → 熄灭
  };

  /* ---- 维护耗水（菌丝的「维持费」）------------------------------------
   * 解决的真问题：水是**唯一只管生长**的资源（growCost 是水的唯一支出），
   * 而地图 34×20=680 格、可长格约 641 —— 实测 5 分钟就铺满了。
   * 铺满之后水产量 500~770/s 全部沉在池子里，20 分钟涨到 82 万，
   * 水彻底失去意义（实测数据见 tools/probe_water*.js）。
   *
   * 设计要点：
   *   ① 维持费**只挂在等级上**，不挂节点数。
   *      挂节点数会变成「扩张惩罚」，和「扩张永远有收益」的基本盘冲突；
   *      只挂等级则维持费天然随「投入的深度」增长 —— 这正是我们要的取舍。
   *   ② 缺水时**先降级、不摧毁节点**（绝不永久损失）——
   *      降级是「付不起」的结果，不是系统无条件给的惩罚。
   *   ③ **远的先降**：把「位置」变成硬约束 —— 想维持远处的富矿，
   *      就得沿路多留水，于是「就近深耕」和「往远处铺」成了两条真路。
   *
   * costPerLevel 的取值是扫出来的（tools/probe_maintain.js）：
   * 太大 → 防火墙自己掉级、m9 永远做不成；太小 → 对后期水量毫无影响。
   * 扫描结果（1800s / 3 种子 / 就近练到 Lv10）：
   *   k=0    终局水量 147 万（现状，水完全失去意义）
   *   k=0.25 终局水量  69 万，**零降级** ← 采用
   *   k=0.40 终局水量  23 万，零降级
   *   k=0.70 开始悬崖式降级（掉 3327 次、平均等级 5.11→3.67）
   * 0.70 那个悬崖说明「靠 k 去贴降级临界点」是脆的（对玩家收入水平过于敏感），
   * 所以取 0.25 这个温和值，把「什么时候开始降」交给 bufferSec 控制。
   * 另一条重要性质：不练节点的纯扩张流在**任何 k 下都零降级**
   * （维持费只挂等级），所以它精准打击深耕流、不误伤扩张流。
   */
  var MAINT = {
    costPerLevel: 0.25,    // 每个等级每秒耗水（Lv10 节点 = 2.5/s）
    /* 缓冲：水量低于「总维持费 × 这个秒数」就开始降级。
     * 不给缓冲会变成「一进水就疯狂降级」，等级来回跳很难看。
     * 40 秒 = 留出让玩家反应（少铺几格 / 买水分效率 / 练近处）的窗口。 */
    bufferSec: 40,
    /* 每秒最多降几级。封顶是为了让它「渐进」，不要一帧之内整片网络崩掉，
     * 同时给玩家一个可感知的节奏：掉级是慢慢发生的，来得及救。 */
    downgradePerSec: 3
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
    { id: 'm8', name: '循环', need: '完成一次散播',          reward: '+3 基因点' },
    { id: 'm9', name: '防火墙', need: '同时拥有 3 个 Lv8+ 的菌丝节点（超过滋生上限，任何菌瘟都爬不上来）', reward: '菌瘟蔓延速度降低' },
    { id: 'm10', name: '感知', need: '菌丝达到 250 格且连上 4 种特殊基质', reward: '解锁「自动蔓延」' }
  ];

  return {
    GRID: GRID, SOILS: SOILS, GEN: GEN, START: START,
    SPORE_METABOLISM: SPORE_METABOLISM,
    GROW: GROW, TRANSPORT: TRANSPORT, UPGRADES: UPGRADES,
    PRESTIGE: PRESTIGE, GENES: GENES, POLICIES: POLICIES,
    NODE_UP: NODE_UP, ABILITIES: ABILITIES, EVENTS: EVENTS, BLIGHT: BLIGHT,
    MAINT: MAINT,
    MILESTONES: MILESTONES
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = CONFIG; }
else { window.MYC = window.MYC || {}; window.MYC.CONFIG = CONFIG; }
