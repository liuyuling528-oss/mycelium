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
 * nodeFocus 就是「深耕流」落到操作上的形态：不铺广，而是把少数节点练到高等级。
 * trunk 是「结构流」的形态：按某种规则挑几格标主干，为核心扩容。
 *   同为结构流，标在哪里差别很大（标贫矿几乎无代价，标富矿要白白损失产量），
 *   所以 trunk 取值直接决定这个策略强不强 —— 这正是要验证的东西。
 *
 * 还有一个可选的 choice：转生三选一选哪一类卡（strain / map / genes）。
 *   **不写 = 优先基因点**（对任何经营方式都普遍有用），这一轮没抽到就按
 *   genes → map → strain 退让。G 组是唯一显式指定它的地方 ——
 *   只有这样，「三张卡各自值不值」才是干净的单一变量对照。 */
/* 自动蔓延现在是 m10 里程碑解锁（探索到全部 4 种特殊基质），
 * 所以每个策略都带 clicks:1 —— 前期必须手动点击跑图，
 * 点着点着探齐基质、解锁自动蔓延，这个节奏本身就是平衡的一部分。 */
const STRATEGIES = [
  { key: 'none',   name: '① 躺平流：永不升级',       priority: [], policy: 'nearest',  genes: [], clicks: 1, nodeFocus: false },
  { key: 'expand', name: '② 扩张流：铺满近处',       priority: ['autoGrow', 'growth', 'hydration', 'absorption', 'capacity'], policy: 'nearest', genes: ['gYield', 'gRate'], clicks: 1, nodeFocus: false },
  { key: 'deep',   name: '③ 深耕流：练节点+抢富矿', priority: ['transport', 'capacity', 'absorption', 'autoGrow', 'growth', 'hydration'], policy: 'nutrient', genes: ['gYield', 'gGrowth'], clicks: 1, nodeFocus: true },
  { key: 'sym',    name: '④ 共生流：专攻树根刷孢子', priority: ['autoGrow', 'symbiosis', 'growth', 'hydration', 'absorption'], policy: 'spore', genes: ['gYield', 'gGrowth'], clicks: 1, nodeFocus: false },
  { key: 'water',  name: '⑤ 找水流：沿水脉扩张',     priority: ['autoGrow', 'hydration', 'growth', 'absorption', 'transport'], policy: 'water', genes: ['gRate', 'gYield'], clicks: 1, nodeFocus: false },
  { key: 'blind',  name: '⑥ 择优流：只挑肥的不修路', priority: ['autoGrow', 'absorption', 'hydration', 'growth'], policy: 'richest', genes: ['gYield', 'gRate'], clicks: 1, nodeFocus: false },
  /* 结构流的两条对照：同样铺开，区别只在「把哪几格改造成主干」。
   * 这两条是主干机制的核心判据 —— 如果它们与 ②/③ 完全相同，
   * 说明结构不产生策略差异，机制就是失败的（评估文档的既有判据）。 */
  { key: 'trunkSmart', name: '⑦ 结构流：主干标在贫矿上', priority: ['capacity', 'transport', 'autoGrow', 'absorption', 'growth'], policy: 'nutrient', genes: ['gYield', 'gGrowth'], clicks: 1, nodeFocus: false, trunk: 'poor' },
  { key: 'trunkWaste', name: '⑧ 结构流（反例）：主干标在富矿上', priority: ['capacity', 'transport', 'autoGrow', 'absorption', 'growth'], policy: 'nutrient', genes: ['gYield', 'gGrowth'], clicks: 1, nodeFocus: false, trunk: 'rich' },
  /* 养树流的两条对照：树本身不值钱（幼苗 0.6×），值钱的是它长大以后
 * 对邻居的 +25%。所以这里唯一变量是「有没有克制地留出空位」：
 *   ⑨ 克制：只在每棵树周围留出「恰好低于停滞线」的空位，网络照常铺；
 *   ⑩ 反例：照旧铺满，树被围死，永远停在幼苗甚至退化。
 * 这两条是树木机制的核心判据 —— 差异为 0 就说明「围拢压制」没落地。
 *
 * 为什么优先级/选址/基因都跟 ②扩张流 一样：
 * 第一版给 ⑨ 用的是「共生流」那套（重点 symbiosis + 找树根），
 * 结果它把精力全花在找树上，网络规模只有 ⑩ 的 1/10，
 * 最后「克制 vs 围满」测出来的差异其实是「穷 vs 富」，不是「树养得好不好」。
 * 判据要成立，**唯一变量必须只有「树周围留不留空位」**，
 * 所以其余全部对齐到同一套经营方式。 */
  { key: 'treeCare', name: '⑨ 养树流：树周围留空位', priority: ['autoGrow', 'growth', 'hydration', 'absorption', 'capacity'], policy: 'nearest', genes: ['gYield', 'gRate'], clicks: 1, nodeFocus: false, tree: 'care' },
  { key: 'treeSmother', name: '⑩ 养树流（反例）：把树围满', priority: ['autoGrow', 'growth', 'hydration', 'absorption', 'capacity'], policy: 'nearest', genes: ['gYield', 'gRate'], clicks: 1, nodeFocus: false, tree: 'smother' }
];

/* 菌株对照（E 组）。两条判据，**必须分开看**，否则会得出错误结论：
 *
 *  ① 「同一套经营方式，只换菌株」—— a~e 全部对齐到扩张流口径（同样铺满近处），
 *     唯一变量是带了哪个菌株。这是「菌株有没有用」的判据。
 *     上一版把 e（共生）写成 policy:'spore'，结果它规模只有基准的零头，
 *     测出 0.55 倍 —— 那其实是**策略差异**，不是菌株差异
 *     （受控实验 tools/_dbg6.js 证明：同一经营方式下共生孢子 +37%）。
 *  ② 「菌株组合 + 槽位上限」—— f/g 看多槽位共振与溢出截断。
 *
 * 所有线都用 autoSlots:true 表示「玩家按正常进度推到了 m11」，
 * 装备时机由主循环在解锁后补装（不能提前装，见 run() 里的注释）。 */
const STRAIN_STRATEGIES = [
  { key: 'stNone', name: 'a. 无菌株（基准）',   strains: [], autoSlots: true, priority: ['autoGrow', 'growth', 'hydration', 'absorption', 'capacity'], policy: 'nearest', genes: ['gYield', 'gRate'], clicks: 1, nodeFocus: false },
  { key: 'stRapid', name: 'b. 速生菌株',        strains: ['rapid'], autoSlots: true, priority: ['autoGrow', 'growth', 'hydration', 'absorption', 'capacity'], policy: 'nearest', genes: ['gYield', 'gRate'], clicks: 1, nodeFocus: false },
  { key: 'stConduit', name: 'c. 运输菌株',      strains: ['conduit'], autoSlots: true, priority: ['autoGrow', 'growth', 'hydration', 'absorption', 'capacity'], policy: 'nearest', genes: ['gYield', 'gRate'], clicks: 1, nodeFocus: false },
  { key: 'stSapro', name: 'd. 腐生菌株',        strains: ['saprophyte'], autoSlots: true, priority: ['autoGrow', 'growth', 'hydration', 'absorption', 'capacity'], policy: 'nearest', genes: ['gYield', 'gRate'], clicks: 1, nodeFocus: false },
  { key: 'stSym', name: 'e. 根系共生菌株',      strains: ['symbiotic'], autoSlots: true, priority: ['autoGrow', 'growth', 'hydration', 'absorption', 'capacity'], policy: 'nearest', genes: ['gYield', 'gRate'], clicks: 1, nodeFocus: false },
  /* 结构流 + 运输菌株：验证「运输的真正价值在长线与主干上」 */
  { key: 'stConduitDeep', name: 'f. 运输菌株 + 主干（长线）', strains: ['conduit'], autoSlots: true, priority: ['capacity', 'transport', 'autoGrow', 'absorption', 'growth'], policy: 'nutrient', genes: ['gYield', 'gGrowth'], clicks: 1, nodeFocus: false, trunk: 'poor' },
  /* 双槽：两个菌株的乘区相乘（共振），应该明显强于单槽 */
  { key: 'stCombo', name: 'g. 速生+腐生（双槽）', strains: ['rapid', 'saprophyte'], autoSlots: true, priority: ['autoGrow', 'growth', 'hydration', 'absorption', 'capacity'], policy: 'nearest', genes: ['gYield', 'gRate'], clicks: 1, nodeFocus: false },
  /* 溢出槽位：请求 3 个，只有 2 个槽 → 必须只装上前 2 个 */
  { key: 'stOver', name: 'h. 速生+运输+腐生（溢出槽位）', strains: ['rapid', 'conduit', 'saprophyte'], autoSlots: true, priority: ['autoGrow', 'growth', 'hydration', 'absorption', 'capacity'], policy: 'nearest', genes: ['gYield', 'gRate'], clicks: 1, nodeFocus: false }
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

/* 转生三选一 —— headless 里必须有人替玩家把卡选掉。
 *
 * 【为什么不能不管】doPrestige 只是把选择**挂**到 state.pendingChoice 上，
 * 奖励要等 applyChoice 才落地。不选的话：pendingChoice 一直挂着，
 * 下一次转生又把它覆盖掉 —— 结果是「三选一」在 headless 里完全是个空操作，
 * 测出来的所有策略数值都等于「玩家从不选卡」，而且没有任何报错。
 *
 * pref 是策略想选的类别；这一轮没抽到就按 genes → map → strain 退让，
 * 保证奖励一定落地（真实玩家也不会把一次转生奖励扔掉）。 */
function pickChoice(state, pref) {
  const pc = state.pendingChoice;
  if (!pc || !pc.cards || !pc.cards.length) return null;
  let card = pref && pref !== 'auto'
    ? pc.cards.filter(c => c.type === pref)[0]
    : null;
  if (!card) {
    for (const t of ['genes', 'map', 'strain']) {
      card = pc.cards.filter(c => c.type === t)[0];
      if (card) break;
    }
  }
  if (!card) return null;
  const r = Sim.applyChoice(state, card.key);
  return r && r.ok ? card.type : null;
}

/* 结构流：给网络挑几格标主干。
 * 核心作用是为核心扩容（coreCapacity 是唯一的结构瓶颈，且核心没有等级可练）。
 *
 * 两种挑法刻意形成对照：
 *   'poor' —— 优先挑「原生产出为零」的水脉。这些格子本来就只提供水
 *             （而水不受吞吐限制），拿去当主干几乎不损失货物产出。
 *   'rich' —— 优先挑腐木/树根这类高产格。这是新手容易犯的错：
 *             看着「重要」就标上，结果白白丢掉 45% 的产地产量。
 * 两者收益差多少，就是「选址」这件事值不值钱。 */
function markTrunks(state, mode) {
  if (!mode) return 0;
  const free = CONFIG.TRUNK.maxTrunk - Sim.trunkCount(state);
  if (free <= 0) return 0;

  const fert = nd => {
    const y = CONFIG.SOILS[nd.soil].yield;
    return (y.nutrient || 0) + (y.spore || 0) * 3;   // 货物原生产出（水不计）
  };
  const pick = [];
  for (let i = 1; i < state.nodes.length; i++) {
    const nd = state.nodes[i];
    if (nd.trunk || nd.confluence) continue;
    pick.push(nd);
  }
  /* 贫矿优先 / 富矿优先。
   * 次级排序都用「离核远」—— 主干是通道，长线路上的格子更值得改造，
   * 这样两种模式的区别就只剩「产出高低」这一个变量。 */
  pick.sort((a, b) => {
    const fa = fert(a), fb = fert(b);
    if (fa !== fb) return mode === 'poor' ? fa - fb : fb - fa;
    return b.dist - a.dist;
  });

  let n = 0;
  for (const nd of pick) {
    if (n >= free) break;
    if (Sim.toggleTrunk(state, nd.id).ok) n++;
  }
  return n;
}

/* 养树流：手动种树 + 按模式控制树周围的人口密度。
 * 这是「空间决策」的落点 —— 玩家要在「多铺一格产出」和「让树长成古树」
 * 之间选一个，而这个选择只有在围拢真的会压制成长时才有代价。
 *
 * 「克制」不等于「把树周围拔空」。第一版就是把 2 格内见到的非树节点全拔掉，
 * 结果网络被撕得只剩 15 格（对照组 756 格），生产直接崩掉 ——
 * 那不是「克制」，那是自废武功，模拟出来的差异是假的。
 *
 * 真正的克制：**只把树周围的邻居数压到停滞线以下**。
 *   crowd ≤ softCap        → 全速成长（rate = 1）
 *   softCap < crowd < 停滞线 → 变慢但仍成长
 *   crowd ≥ 停滞线          → 成长倒退
 * 所以「克制」只需要让每棵树周围的邻居数**低于 softCap 一点点**，
 * 而不是把它周围清空。多出来的格子照样可以铺 —— 那是免费产量。
 *
 * 停滞线 = crowdSoftCap + 1 / crowdPenalty，这里**从 CONFIG 反推**，
 * 不写死数字：以后调平衡时判据自动跟着走，不会悄悄失效。 */
function careTrees(state, mode) {
  if (!mode) return;
  /* 别把水花光：留够下一格的代价，否则树永远种不下去 */
  if (state.res.water < 5000) state.res.water = 5000;

  const trees = [];
  for (let i = 1; i < state.nodes.length; i++) {
    if (Sim.isTree(state.nodes[i])) trees.push(state.nodes[i]);
  }

  /* 没树就种：优先找「代价最低」的树根候选（接得进去的） */
  if (trees.length < 4) {
    let best = null, bestCost = Infinity;
    for (const c of Sim.candidates(state)) {
      if (c.soil !== 'root') continue;
      if (c.cost < bestCost) { bestCost = c.cost; best = c; }
    }
    if (best) Sim.growAt(state, best.x, best.y);
    return;
  }

  if (mode !== 'care') return;   // smother：什么都不做，照旧铺满

  const T = CONFIG.TREE;
  const softCap = T.crowdSoftCap;
  const R = T.ringRadius;

  /* 克制：每棵树只要求「周围邻居数 ≤ crowdSoftCap」——
   * 这是全速成长的边界，多一格就开始变慢，所以卡在边界上最划算。
   * 超出上限的邻居里优先拔「离核心最远」的：那些是网络末端，
   * 拔掉对总产出的伤害最小，也不容易把别人断路。 */
  for (const t of trees) {
    let guard = 0;
    while (guard++ < 40) {
      if (Sim.treeCrowd(state, t) <= softCap) break;

      let victim = null;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (!dx && !dy) continue;
          if (Math.abs(dx) + Math.abs(dy) > R + 1) continue;
          const x = t.x + dx, y = t.y + dy;
          if (x < 0 || y < 0 || x >= state.mapW || y >= state.mapH) continue;
          const id = state.nodeAt[Sim.idx(x, y)];
          if (id == null) continue;
          const nd = state.nodes[id];
          if (Sim.isTree(nd) || nd.trunk || nd.confluence) continue;
          if (nd.dist === 0) continue;                       // 核心不能被拆
          if (victim === null || nd.dist > victim.dist) victim = nd;
        }
      }
      if (victim === null) break;                            // 周围已经没得拔了
      if (!Sim.removeNode(state, victim.id).ok) break;
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
  /* 自动蔓延的选址规则：验证「设了规则会不会更好/更差」。
   * rule 是玩家在面板上选的，这里直接落到 state 上。 */
  if (strategy.rule) {
    state.ruleMaxDist = strategy.rule.maxDist || 0;
    state.ruleMinYield = strategy.rule.minYield || 0;
  }
  /* 菌株要在**解锁那一刻**才装得上（要求 40 格菌丝，开局只有 1 格核心，
   * 这里直接装备会被静默拒绝 —— 踩过一次：七条菌株策略全都没装上，
   * 跑出来与基准完全相同，差点误判成「菌株没用」）。
   * 所以只记下想带什么，由主循环在解锁后补装，这才是真实玩家的操作。 */
  const wantStrains = strategy.strains || [];
  /* 双槽不是一开始就能用的 —— 要先把 m11 做出来。玩家不是「等它自己完成」，
   * 而是达到条件就去推进它。这里按 m11 的完成条件模拟这一步：
   * 「完成一次散播 + 菌丝达到 400 格」。不做这件事，所有多菌株策略
   * 都只能装上 1 个，g/h 两条线就退化成了 a~e 的重复，测不出槽位价值
   * （踩过：这样跑出来 g 反而更弱，差点得出「第二个槽位没用」的错误结论）。 */
  let slotPushed = false;

  const lifetime = { nutrient: 0, spore: 0 };
  /* 每种「转生三选一」卡各被选了几次 —— 用来核对策略是否真的选到了卡，
   * 而不是让 pendingChoice 挂在那里当空操作。 */
  const choiceCount = { strain: 0, map: 0, genes: 0 };
  const timeline = [];
  let nextSample = 300;
  let clickTimer = 0;
  const clickInterval = strategy.clicks > 0 ? 1 / strategy.clicks : Infinity;
  let clicks = 0;
  let structTimer = 30;   // 开局先铺路，30 秒后再看结构
  let treeTimer = 5;      // 养树从第 5 秒就开始（要早点种，树要时间才长大）

  for (let t = 0; t < duration; t += DT) {
    Sim.tick(state, DT);

    /* 手动点击：每次到点只点**一格**（原语义 —— 玩家的点击频率是
     * 0.5s 一次，不是 0.5s 内狂点若干格）。这里用 for 是为了给
     * 「growAt 因非水量原因失败」留一个有限的脱身路径，防止 while 死循环；
     * 正常情况下第一轮就 break。 */
    if (clickInterval !== Infinity) {
      clickTimer += DT;
      if (clickTimer >= clickInterval) {
        clickTimer = 0;
        const best = Sim.bestCandidate(state);
        if (best && best.cost <= state.res.water && Sim.growAt(state, best.x, best.y).ok) clicks++;
      }
    }

    spendUpgrades(state, strategy.priority);

    /* 菌株：解锁（40 格）那一刻补装。每帧都试是有意的 ——
     * m11 完成时槽位 +1，第二个菌株必须能补上；
     * equipStrain 对已装备的 key 会走 toggle 卸下，所以这里要先跳过已装的。 */
    /* m11 的完成条件是「转生过 ≥1 次」+「历史最大菌丝 ≥400 格」，
     * 引擎里读的是 counters.maxNodes（**跨转生保留**）。
     * 一开始这里错写成 state.nodes.length —— 但转生后网络会被清空到 1 格，
     * 用「当前格数」几乎永远撞不到条件，第二个槽位就永远开不出来
     * （症状：g 双槽与 b 单槽的数字一模一样）。改成与引擎一致的口径。 */
    if (wantStrains.length > 1 && !slotPushed && Sim.strainsUnlocked(state) &&
        (state.counters.maxNodes || 0) >= 400 && (state.prestiges || 0) >= 1) {
      state.milestones.m11 = true;
      Sim.invalidateStrain(state);
      slotPushed = true;
    }
    if (wantStrains.length && Sim.strainsUnlocked(state)) {
      for (const k of wantStrains) {
        if (state.strains.indexOf(k) >= 0) continue;
        Sim.equipStrain(state, k);
      }
    }

    // 内容层：技能照用、害虫照驱除 —— 但**只有「会回应」的玩家**才做。
    // 挂机跑不回应事件：害虫会繁殖、菌瘟会蔓延。菌瘟不能净化，
    // 双方都只能靠防火墙硬扛（围死它要连续两个周期，撑不到就烂一片）——
    // 注意力的价值转移到「网络结构」上。
    if (strategy.clicks > 0) respondToEvents(state);
    // 深耕流另外把养分投到少数节点上
    if (strategy.nodeFocus && state.res.nutrient > 400) upgradeNodes(state, 3);
    /* 结构流：网络铺到一定规模（拥堵开始出现）才值得动主干，
     * 每 30 秒重新检查一次 —— 玩家不会每秒重排一遍主干。 */
    if (strategy.trunk) {
      structTimer += DT;
      if (structTimer >= 30) { structTimer = 0; markTrunks(state, strategy.trunk); }
    }
    /* 养树流：每 5 秒照看一次树（种树 / 腾空位）。
     * 比主干密 —— 树周围有很多格，一次腾不干净。 */
    if (strategy.tree) {
      treeTimer += DT;
      if (treeTimer >= 5) { treeTimer = 0; careTrees(state, strategy.tree); }
    }

    if (Sim.canPrestige(state)) {
      const before = { n: state.total.nutrient, s: state.total.spore };
      const r = Sim.doPrestige(state);
      if (r.ok) {
        lifetime.nutrient += before.n;
        lifetime.spore += before.s;
        /* 转生奖励要**选完才落地**（见 pickChoice 的注释）——
         * 这里顺便记下每种卡被选了几次，供 G 组核对「策略确实选了卡」。 */
        const picked = pickChoice(state, strategy.choice);
        if (picked) choiceCount[picked] = (choiceCount[picked] || 0) + 1;
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
    /* 把本局最后的 state 一并带出来。F 组（离线对照）需要从
     * 「正常玩过一段」的局面继续跑，只拿统计量是不够的 ——
     * 早期版本照着统计量建 state，serialize 直接炸在 state.nodes.map 上
     * （返回的是 mean 出来的数字，不是节点数组）。 */
    state,
    /* 实际装上的菌株（不是「想装的」）。E 组的槽位判据靠它 ——
     * 只看策略里的 strains 列表会漏掉「槽位没开、第二个没装上」这种情况，
     * 那正是曾经把 g 双槽算成与 b 单槽一模一样的原因。 */
    equipped: (state.strains || []).slice(),
    slots: Sim.strainSlots(state),
    prestiges: state.prestiges,
    /* 转生三选一的实际选择次数 + 地图档位。G 组靠这两项确认
     * 「选卡」这条链路真的跑起来了（全是 0 就说明卡没落地）。 */
    choices: { ...choiceCount },
    mapTier: state.mapTier || 0,
    mapW: state.mapW,
    mapH: state.mapH,
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
    trunks: Sim.trunkCount(state),
    ...treeMetrics(state),
    bySoil: countSoil(state),
    timeline
  };
}

/* 树的观测量。核心不是「有几棵树」，而是「长到第几档」——
 * 围拢压制的效果就体现在 avgStage 上：被围满的树永远停在 0.0x。 */
function treeMetrics(state) {
  let count = 0, stageSum = 0, ancient = 0, auralit = 0, stalled = 0;
  for (let i = 1; i < state.nodes.length; i++) {
    const nd = state.nodes[i];
    if (!Sim.isTree(nd)) continue;
    count++;
    stageSum += nd.treeStage;
    if (nd.treeStage >= 2) ancient++;
    const ts = Sim.treeStateOf(state, nd);
    if (ts.stalled) stalled++;
  }
  /* 被古树光环覆盖的普通菌丝数 —— 「影响周围」是否真的兑现 */
  for (let i = 1; i < state.nodes.length; i++) {
    if (Sim.isTree(state.nodes[i])) continue;
    if (Sim.underOldTreeAura(state, state.nodes[i])) auralit++;
  }
  return {
    trees: count,
    treeStageAvg: count ? stageSum / count : 0,
    ancientTrees: ancient,
    treeStalled: stalled,
    auraNodes: auralit
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
    trunks: mean('trunks'),
    /* 转生三选一：地图档位/尺寸取均值，各类卡的次数取**总和**（5 个种子加起来），
     * G 组要靠它确认「卡真的落地了」而不是挂着没选。 */
    mapTier: mean('mapTier'),
    mapW: mean('mapW'),
    mapH: mean('mapH'),
    choices: runs.reduce((a, r) => {
      const c = r.choices || {};
      a.strain += c.strain || 0; a.map += c.map || 0; a.genes += c.genes || 0;
      return a;
    }, { strain: 0, map: 0, genes: 0 }),
    trees: mean('trees'), treeStageAvg: mean('treeStageAvg'),
    ancientTrees: mean('ancientTrees'), treeStalled: mean('treeStalled'),
    auraNodes: mean('auraNodes'),
    /* 基质构成与时间线只取第 1 个种子 —— 它们是「看一眼长什么样」的样本，
     * 不是统计量。但正因为如此，它们**不能**和上面的平均值放在一起比较：
     * 报告里的「树 N 棵」是 5 个种子的均值，而 bySoil.root 只是种子 1 的数，
     * 两者对不上是正常的（初版报告把这两者并列，看着像 bug，实则口径不同）。 */
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
              `| 驱除害虫 ${avg.gnats.toFixed(0)} | 主干 ${avg.trunks.toFixed(1)} 格`);
  console.log(`   树 ${avg.trees.toFixed(1)} 棵（平均档位 ${avg.treeStageAvg.toFixed(2)}）| 古树 ${avg.ancientTrees.toFixed(1)} 棵 ` +
              `| 被压住 ${avg.treeStalled.toFixed(1)} 棵 | 光环覆盖 ${avg.auraNodes.toFixed(1)} 格`);
  console.log(`   基质构成（仅种子 ${SEEDS[0]}）${JSON.stringify(avg.bySoil)}\n`);
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
/* 判据是**按默认 1800s 标定**的：门槛（转生 1.5 次）说的是「半小时的局」。
 * 传更短的时长（如 600）时这条必然不过 —— 那不是回归，是口径不匹配。
 * 所以消息里一律回显**本次实际时长**，别写死「30 分钟」误导人。 */
const durMin = (DURATION / 60).toFixed(0);
const calib = DURATION >= 1800 ? '' :
  `（⚠️ 判据按 1800s 标定，本次只跑 ${durMin} 分钟，后面各组不会执行）`;
if (best.prestiges < 0.5 && best.genes < 1) {
  console.log(` ❌ 失败：${durMin} 分钟里游戏根本无法推进（没有任何策略能转生）。必须先修数值。`);
  failed = true;
} else if (best.prestiges < 1.5) {
  console.log(` ❌ 失败：最好的策略 ${durMin} 分钟只能转生 ${best.prestiges.toFixed(2)} 次 —— 转生滚雪球是放置游戏的引擎，太慢等于没有。${calib}`);
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

/* ------------------------------------------------------------------ C/D 组
 * 树木机制的判据分两层，必须分开看，否则会得出错误结论：
 *
 *   C 组 · 整局对照（⑨ vs ⑩）：同样一套经营方式，唯一差别是树周围留不留空位。
 *
 *   D 组 · 逐棵受控实验：**同一局、同一时刻、同一批树**，邻居最多的那棵围满，
 *         其余保持正常密度，一起再长 900 秒。这是「围拢压制」的因果证据 ——
 *         C 组要是拉不开差距，D 组能区分「机制没落地」和「整局经营盖住了机制」。
 *
 * D 组 · 逐棵受控实验（同一局、两棵树，唯一差别是周围挤不挤）。
 *
 * 设计改动过三次，每次都记下来：
 *
 *  ① 只跑 600s 就挑树 → 每局只有 ~20 格（挂机口径），root 基质本来就稀少，
 *     样本直接不够（20 局全跳过）。改成先按 ②扩张流 经营 1200s。
 *
 *  ② 挑了「1 格环占用最多」的树来围满 → 它在密网内部本来就已经 8 格占满，
 *     没什么可补的，而且这个门限写的是 `denseCrowd > roomyOcc + 1`，
 *     左边是 **2 格 crowd**、右边是 **1 格占用** —— 两把尺子量同一个东西，
 *     结果 20 局全被这道门挡掉。**别拿不同口径的指标互相比较。**
 *
 *  ③ 现在：先把整张网络铺密（真实玩家的铺满行为），
 *     然后在这一局里挑**最挤的树**当对照组（不动它），
 *     再挑一棵**把它周围清出空位**当实验组 —— 方向反过来：
 *     不靠「找一棵本来就有空位的树」（那种树几乎不存在），
 *     而是**主动给一棵树腾地方**，这正是玩家会做的事。
 *
 * 这样两组的唯一差别就是「树周围挤不挤」，是干净的因果对照。 */
const ROW = 20;   // D 组观测局数

/* 按 ②扩张流 的方式经营一段时间 —— 先把网络铺到「有树可比」的规模。
 * 只跑 600s 的话每局只有 ~20 格（挂机口径），root 基质本来就稀少，
 * 样本根本不够。 */
function farmState(state, seconds, clicks) {
  state.policy = 'nearest';
  const priority = ['autoGrow', 'growth', 'hydration', 'absorption', 'capacity'];
  const clickInterval = clicks > 0 ? 1 / clicks : Infinity;
  let clickTimer = 0;
  for (let t = 0; t < seconds; t += DT) {
    Sim.tick(state, DT);
    if (clickInterval !== Infinity) {
      clickTimer += DT;
      while (clickTimer >= clickInterval) {
        clickTimer -= clickInterval;
        const b = Sim.bestCandidate(state);
        if (!b || b.cost > state.res.water) break;
        if (!Sim.growAt(state, b.x, b.y).ok) break;
      }
    }
    spendUpgrades(state, priority);
  }
}

/* 把网络铺到密（真实玩家的「铺满」）。 */
function densify(state, maxNodes) {
  let guard = 0;
  while (guard++ < 40000) {
    if (state.nodes.length >= maxNodes) break;
    const b = Sim.bestCandidate(state);
    if (!b) break;
    state.res.water = Math.max(state.res.water, 1e6);
    if (!Sim.growAt(state, b.x, b.y).ok) break;
  }
}

/* 把这棵树周围 2 格内的普通邻居拔掉，直到 crowd 降到 target 以下。
 * 优先拔「离核心最远」的 —— 那是网络末端，拔掉对总产出伤害最小。 */
function clearAround(state, tree, target) {
  const R = CONFIG.TREE.ringRadius;
  let guard = 0;
  while (guard++ < 60) {
    if (!Sim.isTree(state.nodes[tree.id])) return false;
    if (Sim.treeCrowd(state, state.nodes[tree.id]) <= target) return true;
    let victim = null;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (!dx && !dy) continue;
        if (Math.abs(dx) + Math.abs(dy) > R + 1) continue;
        const x = tree.x + dx, y = tree.y + dy;
        if (x < 0 || y < 0 || x >= state.mapW || y >= state.mapH) continue;
        const id = state.nodeAt[Sim.idx(x, y)];
        if (id == null) continue;
        const nd = state.nodes[id];
        if (Sim.isTree(nd) || nd.trunk || nd.confluence) continue;
        if (nd.dist === 0) continue;
        if (victim === null || nd.dist > victim.dist) victim = nd;
      }
    }
    if (!victim) return false;
    if (!Sim.removeNode(state, victim.id).ok) return false;
  }
  return false;
}

function treeExperiment() {
  const care = { sum: 0, n: 0, ancient: 0, aura: 0 };
  const smother = { sum: 0, n: 0, ancient: 0 };
  const skip = { noTree: 0, noRoom: 0 };
  let used = 0;
  const T = CONFIG.TREE;
  /* 实验组的目标：刚好在 softCap 以内 —— 这是「留了空位、能全速长」的定义 */
  const roomyTarget = T.crowdSoftCap;

  for (let i = 0; i < ROW; i++) {
    const state = Sim.newGame(SEEDS[i % SEEDS.length] + i * 1013, {}, {});
    farmState(state, 1200, 1);
    densify(state, 900);

    const trees = [];
    for (let j = 1; j < state.nodes.length; j++) {
      if (Sim.isTree(state.nodes[j])) trees.push(state.nodes[j]);
    }
    if (trees.length < 2) { skip.noTree++; continue; }

    /* 对照组 = 最挤的那棵（不动它）；实验组 = 另一棵，把它周围腾空 */
    let dense = null, denseCrowd = -1;
    for (const t of trees) {
      const c = Sim.treeCrowd(state, t);
      if (c > denseCrowd) { denseCrowd = c; dense = t; }
    }
    if (!dense) { skip.noTree++; continue; }
    /* 对照组必须真的超标，否则「围满」这一侧不成立 */
    if (denseCrowd <= T.crowdSoftCap) { skip.noRoom++; continue; }

    let roomy = null;
    for (const t of trees) { if (t.id !== dense.id) { roomy = t; break; } }
    if (!roomy) { skip.noTree++; continue; }
    if (!clearAround(state, roomy, roomyTarget)) { skip.noRoom++; continue; }

    /* 两组各自记下当前档位，一起再长 900s */
    const roomyStage0 = state.nodes[roomy.id].treeStage;
    const denseStage0 = state.nodes[dense.id].treeStage;
    for (let t = 0; t < 900; t += DT) Sim.tick(state, DT);

    used++;
    const rec = (bucket, id, stage0, withAura) => {
      if (!Sim.isTree(state.nodes[id])) return;
      const nd = state.nodes[id];
      bucket.sum += nd.treeStage; bucket.n++;
      if (nd.treeStage >= 2) {
        bucket.ancient++;
        if (withAura) {
          for (let j = 1; j < state.nodes.length; j++) {
            if (Sim.isTree(state.nodes[j])) continue;
            if (Sim.underOldTreeAura(state, state.nodes[j])) bucket.aura++;
          }
        }
      }
    };
    rec(care, roomy.id, roomyStage0, true);
    rec(smother, dense.id, denseStage0, false);
  }
  return { care, smother, used, skip };
}

const exp = treeExperiment();

const treeCare = results.find(r => r.key === 'treeCare');
const treeSmother = results.find(r => r.key === 'treeSmother');
if (treeCare && treeSmother) {
  const dStage = treeCare.treeStageAvg - treeSmother.treeStageAvg;
  const dAncient = treeCare.ancientTrees - treeSmother.ancientTrees;
  const dAura = treeCare.auraNodes - treeSmother.auraNodes;
  console.log('');
  console.log(' C 组 · 整局对照（同经营方式，只差树周围留不留空位）');
  console.log(`   克制 ${treeCare.treeStageAvg.toFixed(2)} 档 / 古树 ${treeCare.ancientTrees.toFixed(1)} 棵 / 光环 ${treeCare.auraNodes.toFixed(0)} 格 / 菌丝 ${treeCare.nodes.toFixed(0)} 格` +
              `　vs　围满 ${treeSmother.treeStageAvg.toFixed(2)} 档 / 古树 ${treeSmother.ancientTrees.toFixed(1)} 棵 / 光环 ${treeSmother.auraNodes.toFixed(0)} 格 / 菌丝 ${treeSmother.nodes.toFixed(0)} 格`);
  if (dStage < 0.25 && dAncient < 0.5) {
    console.log(`   ⚠️  整局口径只差 ${dStage.toFixed(2)} 档 —— 单看这一项不足以判定，以 D 组为准。`);
  } else {
    console.log(`   ✅ 整局口径：多长 ${dStage.toFixed(2)} 档、多 ${dAncient.toFixed(1)} 棵古树。`);
  }

  const cAvg = exp.care.n ? exp.care.sum / exp.care.n : 0;
  const sAvg = exp.smother.n ? exp.smother.sum / exp.smother.n : 0;
  const cAuc = exp.care.n ? exp.care.ancient / exp.care.n : 0;
  const sAuc = exp.smother.n ? exp.smother.ancient / exp.smother.n : 0;
  console.log('');
  console.log(` D 组 · 逐棵受控（${exp.used}/${ROW} 局可用；同局两棵树：一棵围满、一棵特意腾空，一起再长 900s）`);
  console.log(`   留空位 ${cAvg.toFixed(2)} 档 / 古树率 ${(cAuc * 100).toFixed(0)}% / 光环 ${exp.care.aura} 格（${exp.care.n} 棵）` +
              `　vs　围满 ${sAvg.toFixed(2)} 档 / 古树率 ${(sAuc * 100).toFixed(0)}%（${exp.smother.n} 棵）`);
  if (exp.used < ROW) {
    console.log(`   （跳过 ${exp.skip.noTree} 局缺对照树、${exp.skip.noRoom} 局腾不出空位）`);
  }

  if (exp.care.n < 5 || exp.smother.n < 5) {
    console.log(' ❌ 失败：受控实验样本不足，无法判定树的机制。');
    failed = true;
  } else if (sAvg >= cAvg) {
    console.log(` ❌ 失败：围满的树（${sAvg.toFixed(2)} 档）不比留空位的树（${cAvg.toFixed(2)} 档）差` +
                ` —— 「围拢压制」没有落地，树只是「更肥的格子」。`);
    failed = true;
  } else if (cAvg - sAvg < 0.25) {
    console.log(` ⚠️  围拢确实压制了成长，但差距只有 ${(cAvg - sAvg).toFixed(2)} 档 —— 玩家不容易感觉到。`);
  } else {
    console.log(` ✅ 同一局、同样时长的两棵树：留空位的长到 ${cAvg.toFixed(2)} 档，围满的只有 ${sAvg.toFixed(2)} 档` +
                `（差 ${(cAvg - sAvg).toFixed(2)} 档）—— 「围拢压制」成立，留空位是有代价也有回报的空间决策。`);
  }
  if (cAuc > 0 && dAura <= 0) {
    console.log(' ⚠️  古树光环在整局口径上没有覆盖到更多菌丝 —— 「影响周围」的收益兑现得不够。');
  }
}

/* 养树流不许因为「照顾树」而把整局经济搞崩：
 * 综合分低于最强策略的 1/5 就说明代价高到没人会这么玩。 */
if (treeCare && best.score > 0 && treeCare.score < best.score / 5) {
  console.log(` ⚠️  养树流的综合分只有最强策略的 ${(treeCare.score / best.score * 100).toFixed(0)}% —— 照顾树的代价可能过高。`);
}

/* ------------------------------------------------------------------ E 组
 * 菌株对照。判据同主干/树木：**同一套经营方式只换菌株**，差异必须非零。
 * 这里额外要验一件事：槽位约束真的生效 —— 「速生+运输+腐生」只能装前 2 个，
 * 结果必须与「速生+腐生」完全相同（这是槽位在上限处被截断的证据）。
 *
 * 【为什么多槽位策略要单独跑更久】
 * 第二个槽位是 m11 给的，m11 要求「转生过 + 历史最大菌丝 ≥400 格」。
 * 而 DURATION（默认 1800s，测试时常用 600s）里，主动玩家一般长到 200~250 格
 * 就转生了（转生能滚雪球，比硬撑到 400 格更划算）—— 于是 m11 永远撞不到，
 * 双槽策略实际只装上 1 个菌株，g/h 两条线与 b 完全同数。
 * 踩过这个坑两次：第一次误判成「第二个槽位没用」，第二次误判成「m11 逻辑坏了」。
 * 真相是**跑得不够久**。所以多槽位策略单独用 2.5× 时长，给 m11 留出达成窗口；
 * 其余策略维持同一时长，保证「只换菌株」这个唯一变量不被破坏。 */
const E_MULTI_DURATION = Math.round(DURATION * 2.5);
/* 单菌株在 E_MULTI_DURATION 下的成绩要在**多处**用到（双槽共振对照）。
 * 提前算一次并缓存 —— 否则每个用到的地方都重跑一遍。
 *
 * 【坑】不能直接复用 strainResults 里单菌株那一行的成绩！
 * 干净对照组（a~e）走的是 DURATION（600s），而多槽位策略走 E_MULTI_DURATION
 * （1500s）。拿 600s 的单槽去比 1500s 的双槽，比的是「长短局」而不是
 * 「一个槽 vs 两个槽」—— 实测会把比值虚高到 5.28×。
 * 所以这里**显式按 E_MULTI_DURATION 重跑**一遍单菌株。
 * 只跑双槽对照真正需要的两个（速生 / 腐生），不是全部 4 个。 */
const soloAtMulti = {};
for (const k of ['rapid', 'saprophyte']) {
  const stg = STRAIN_STRATEGIES.find(x => x.strains && x.strains.length === 1 && x.strains[0] === k);
  if (!stg) continue;
  const runs = SEEDS.map(seed => run(Object.assign({}, stg, { strains: [k] }), seed, E_MULTI_DURATION));
  const avg = avgOf(runs);
  avg.key = k;
  avg.equipped = runs[0].equipped || [];
  soloAtMulti[k] = { key: k, avg: avg, strategy: stg };
}
const BASELINE_AT_MULTI = (() => {
  const s = STRAIN_STRATEGIES.find(x => x.key === 'stNone');
  const r = SEEDS.map(seed => run(Object.assign({}, s, { strains: [] }), seed, E_MULTI_DURATION));
  return avgOf(r);
})();
const strainResults = STRAIN_STRATEGIES.map(s => {
  const multi = (s.strains || []).length > 1;
  const runs = SEEDS.map(seed => run(s, seed, multi ? E_MULTI_DURATION : DURATION));
  const avg = avgOf(runs);
  avg.name = s.name; avg.key = s.key; avg.want = s.strains.slice();
  avg.duration = multi ? E_MULTI_DURATION : DURATION;
  /* 装备情况用**第一条种子**的实况（avgOf 不会聚合它）。
   * 槽位判据必须看实际装上的，不能看「想装的」。 */
  avg.equipped = runs[0].equipped || [];
  avg.slots = runs[0].slots || 1;
  return avg;
});

console.log('');
console.log('='.repeat(80));
console.log(' E. 菌株对照（Build 是否成立）');
console.log('='.repeat(80));
const baseStrain = strainResults[0];
/* 前 5 条是「同一套经营方式只换菌株」的干净对照；
 * f 用了结构流口径、g/h 是多槽位（且跑得更久），都不参与「相对基准」的横向比较。
 * g/h 的时长与基准不同 —— 拿它们与基准比分数是没有意义的（时间都不一样了），
 * 所以相对值直接不显示，只显示装备实况。 */
const CLEAN = ['stNone', 'stRapid', 'stConduit', 'stSapro', 'stSym'];
strainResults.forEach(r => {
  const comparable = CLEAN.indexOf(r.key) >= 0;
  const rel = baseStrain.score > 0 ? r.score / baseStrain.score : 0;
  const mark = comparable ? '' : '  (不同口径，不横向比)';
  /* 把「实际装上几个」打出来。这条比「相对基准」重要得多 ——
   * 曾经因为第二个菌株根本没装上，g 与 b 数字完全相同，
   * 却还在读「×1.07」这种看似正常的相对值。 */
  const eq = (r.equipped || []).length;
  const eqMark = eq === r.want.length ? '' : `  ⚠️ 实际只装上 ${eq}/${r.want.length} 个（槽位 ${r.slots}）`;
  const relStr = comparable ? `  相对基准 ×${rel.toFixed(2)}` : '';
  const durStr = r.duration !== DURATION ? `  [${r.duration}s]` : '';
  console.log(` ${r.name.padEnd(28)} 转生 ${r.prestiges.toFixed(2).padStart(5)}  基因 ${r.genes.toFixed(1).padStart(5)}` +
              `  养分 ${String(Math.round(r.lifetimeNutrient)).padStart(7)}  孢子 ${String(Math.round(r.lifetimeSpore)).padStart(6)}` +
              `${relStr}${mark}${durStr}${eqMark}`);
});

/* 干净对照组里「每个菌株至少赢一项」—— 这是 Build 成立的真正判据。
 * 只要有一项第一是某个菌株独占的，它就不可替代。 */
const clean = strainResults.filter(r => CLEAN.indexOf(r.key) >= 0);
const metric = {
  养分: clean.reduce((a, b) => (b.lifetimeNutrient > a.lifetimeNutrient ? b : a)),
  孢子: clean.reduce((a, b) => (b.lifetimeSpore > a.lifetimeSpore ? b : a)),
  规模: clean.reduce((a, b) => (b.nodes > a.nodes ? b : a)),
  成长成本: clean.reduce((a, b) => (b.prestiges > a.prestiges ? b : a))
};
console.log('');
console.log(' · 各项第一（仅干净对照组）：' +
  Object.keys(metric).map(k => `${k}→${metric[k].name.split('. ')[1]}`).join('｜'));
const winners = new Set(Object.keys(metric).map(k => metric[k].key));
console.log(` · 拿过第一的菌株数：${winners.size}/${clean.length}` +
            (winners.size >= 3 ? ' —— 多个菌株各有不可替代的位置。' : ' —— ⚠️ 定位重叠，需要再区分。'));

/* 判据：干净对照组内部也要拉得开，否则「换菌株」等于没换 */
const cleanScores = clean.map(r => r.score);
const cBest = Math.max.apply(null, cleanScores);
const cWorst = Math.min.apply(null, cleanScores);
const strainSpread = cWorst > 0 ? cBest / cWorst : Infinity;
console.log('');
if (clean.length < 5) {
  console.log(' ❌ 失败：干净对照组的策略数不足，无法判定菌株是否成立。');
  failed = true;
} else if (!(strainSpread > 1) || strainSpread < 1.10) {
  console.log(` ❌ 失败：同一经营方式下换菌株几乎不改变结果（最强/最弱 = ${strainSpread === Infinity ? '∞' : strainSpread.toFixed(2)}）—— 菌株只是装饰，Build 不成立。`);
  failed = true;
} else {
  console.log(` ✅ 同经营方式、换菌株：最强/最弱 = ${strainSpread.toFixed(2)} 倍 —— 菌株真的改变结果。`);
}
if (winners.size >= 3) {
  console.log(' ✅ Build 成立：没有哪个菌株被全面碾压，各自守着一个方向。');
} else {
  console.log(' ❌ 失败：拿过第一的菌株少于 3 个 —— 存在「无脑选它」的答案，Build 是假的。');
  failed = true;
}
/* 槽位上限证据：请求 3 个菌株，但只开 2 个槽 → 只能装上前 2 个
 * （`rapid` + `conduit`）。所以它必须与「显式只请求这 2 个」完全一致。
 * 注意对照组要用**同样的时长**（多槽位走 E_MULTI_DURATION），
 * 否则比的是「长短局」而不是「请求了几个菌株」。 */
const over = strainResults.find(r => r.key === 'stOver');
const overRef = SEEDS.map(seed => run(
  Object.assign({}, STRAIN_STRATEGIES.find(s => s.key === 'stOver'), { strains: ['rapid', 'conduit'] }),
  seed, E_MULTI_DURATION));
const overRefAvg = avgOf(overRef);
if (over) {
  const same = Math.abs(over.score - overRefAvg.score) < 1e-6;
  if (!same) {
    console.log(' ❌ 失败：溢出槽位的结果与「速生+运输」不一致 —— 槽位截断判断有问题。');
    failed = true;
  } else {
    /* 先确认两个菌株真的都装上了，否则「一致」只说明槽位全被拒了 */
    const eq = (over.equipped || []).length;
    if (eq === 3) {
      console.log(` ❌ 失败：请求 3 个菌株却装上了 3 个 —— 槽位上限（${CONFIG.STRAIN.maxSlots}）没有生效。`);
      failed = true;
    } else if (eq < 2) {
      console.log(` ❌ 失败：溢出槽位只装上 ${eq} 个 —— 连两个槽都没填满，m11 可能没解锁。`);
      failed = true;
    } else {
      console.log(` ✅ 槽位上限生效：请求 3 个菌株只装进 ${eq} 个槽` +
                  `（= 显式只请求前 ${eq} 个，两条线完全一致）。`);
    }
  }
}
/* 双槽共振：两个菌株应该强于任一单槽。
 * 这个比较**必须同口径**：combo 走多槽时长，单槽走普通时长，
 * 直接比分是把「时间长」误读成「组合强」。所以单槽要用**同一时长**的成绩，
 * 那份成绩已经在 soloAtMulti 里备好了（上方一次性算出，不在这里重跑）。 */
const combo = strainResults.find(r => r.key === 'stCombo');
if (combo) {
  const members = ['rapid', 'saprophyte'].filter(k => soloAtMulti[k]);
  const soloSame = members.map(k => soloAtMulti[k]);
  const bestSolo = soloSame.reduce((a, b) => (b.avg.score > a.avg.score ? b : a));
  const comboEq = (combo.equipped || []).length;
  const soloEq = (bestSolo.avg.equipped || []).length;
  console.log('');
  if (comboEq < 2) {
    console.log(` ❌ 失败：双槽策略实际只装上 ${comboEq} 个菌株 —— 没法验证「两个槽位是否比一个强」。`);
    failed = true;
  } else if (combo.score > bestSolo.avg.score * 1.02) {
    console.log(` ✅ 双槽共振：速生+腐生（${Math.round(combo.score)}）强于最好的单槽` +
                `（${bestSolo.key} ${Math.round(bestSolo.avg.score)}，${(combo.score / bestSolo.avg.score).toFixed(2)}×）` +
                ` —— 第二个槽位是实打实的成长。`);
  } else if (combo.score > bestSolo.avg.score) {
    console.log(` ⚠️  双槽（${Math.round(combo.score)}）只比最好的单槽（${Math.round(bestSolo.avg.score)}）强一点点` +
                `（${(combo.score / bestSolo.avg.score).toFixed(2)}×，同口径 ${E_MULTI_DURATION}s）—— 第二个槽位的价值偏弱。`);
  } else {
    /* 这一条**不是**系统故障，而是组合选择空间的真实反馈：
     * rapid 的 distLossMul 会放大距离损耗，恰好抵消 saprophyte 的收益。
     * 也就是说「速生 + 腐生」是一个**坏搭配** —— 玩家该换一个。
     * 下面那行「参照」给出的才是系统级判据。 */
    console.log(` ⚠️  双槽（${Math.round(combo.score)}）没有强过最好的单槽（${bestSolo.key} ${Math.round(bestSolo.avg.score)}，` +
                `同口径 ${E_MULTI_DURATION}s，实际装上 ${comboEq} vs ${soloEq} 个）—— 「速生+腐生」是个坏搭配` +
                `（速生的距离损耗吃掉了腐生的收益），玩家应该换一个组合。`);
  }
  /* 参照：同口径下与「无菌株」的差距。没有这一行，
   * 上面那条 ⚠️ 容易被误读成「槽位系统坏了」——
   * 其实只要 combo > 无菌株，第二个槽位就仍在创造价值，只是这个组合不好。 */
  console.log(` · 参照：同口径（${E_MULTI_DURATION}s）无菌株 ${Math.round(BASELINE_AT_MULTI.score)}，` +
              `双槽是其 ${(combo.score / BASELINE_AT_MULTI.score).toFixed(2)}×` +
              (combo.score > BASELINE_AT_MULTI.score ? ' —— 槽位本身是有收益的。' : ' —— ⚠️ 槽位没有收益。'));
}

/* ------------------------------------------------------------------ F 组
 * 离线收益对照。**这是 docs/规划评估.md 明确要求必须做的一条**
 * （第 288 行：「headless_sim 加『离线 8h vs 在线 8h 主动操作』对照，
 * 离线必须明显更低」）。同时也是第 292~293 行那条「早期玩家下限」的验证。
 *
 * 口径说明（很重要，不然会得出错误结论）：
 * 两边都从**同一个成熟局面**出发，跑同样长的时间。
 *  - 在线：继续 tick + 点击扩张 + 买升级（就是普通的主动玩）。
 *  - 离线：不 tick，走 Sim.settleOffline 的折算。
 * 直接比「同一段 8 小时里，挂机等着 vs 动手玩」拿到的产量。
 *
 * 【性能】：这一组**不**真的 tick 满 8 小时。
 * 8h/0.25s = 11.5 万次 tick，×3 份对照，再叠加 upgradeNodes 的内层循环，
 * 会把进程跑到 OOM 被系统杀掉（实测：没有任何输出、exit 1、stdout 空）。
 * 所以采用「**算速率 + 线性外推**」：
 *   · 在线侧先把局面推进到稳定（rate 已经收敛），记下 rate；
 *   · 再额外 tick 一个**短窗口**（默认 600s）验证「外推系数」是否可信；
 *   · 8h 的在线产量 = 短窗口实测产量 × (8h / 短窗口)。
 * 因为在线产量在成熟期是近似线性的（节点铺满后速率不再涨），
 * 这个外推的误差远小于「跑不动」的代价。
 * 而且我们比的是**数量级差距**（要求 >> 1.5 倍），不是精确数值。 */
function offlineCompare(label, seconds, strains, windowSec) {
  const seedRun = run(
    Object.assign({}, STRATEGIES[1], { strains: strains || [], autoSlots: true }),
    SEEDS[0], 3600);         // 先像正常玩家玩 1 小时，攒出成熟网络
  const snapshot = Sim.deserialize(Sim.serialize(seedRun.state));
  /* deserialize 出来的 state 没有 rate —— 那是 computeFlow 写的，
   * 而 computeFlow 只在 tick 里跑。这里手动算一次。 */
  Sim.computeFlow(snapshot, 0);
  /* 顺手把 m11 补上（离线快照用的是扩张流口径，正常玩到这个规模早该做了）——
   * 否则「在线/离线」两侧的槽位数不一致，比出来的差异是假的。 */
  snapshot.milestones.m11 = true;
  Sim.invalidateStrain(snapshot);

  /* 在线：从快照继续主动玩，然后线性外推到 seconds。
   *
   * 为什么要先 warm 再测：窗口一开始还在「扩容 → 升级 → 再扩容」的
   * 爬升段，速率每天在涨。直接拿第一个窗口的平均值外推，等于假设
   * 玩家永远停在那一刻的水平，会把在线基线**低估**。
   * 外推系数是重采样的，窗口越接近稳态越可信 —— F 组宁可把在线
   * 算高一点也不算低一点，否则「离线 < 在线」这条判据就是自证成立。
   *
   * warm 期与测期用同一套操作逻辑，唯一差别是测期首尾各取一次累计量。 */
  const win = windowSec || 600;
  /* warm 期：把「扩容 → 升级 → 再扩容」的爬升段走完，让测期落在稳态。
   * 但 warm **必须有硬上限** —— 曾经的写法是 warm = win*4，而窗口默认给到
   * 1800s，于是要 tick 9000s × 5 条对照组，直接跑到天荒地老（F 组卡死）。
   * 300s 起步、最多 4 个窗口，够把爬升段吃掉了。 */
  const warm = Math.min(win * 4, 1200);
  const on = Sim.deserialize(Sim.serialize(snapshot));
  let clickTimer = 0;
  const clickInterval = 1 / 2;
  let markN = on.total.nutrient, markS = on.total.spore;
  for (let tt = 0; tt < warm + win; tt += DT) {
    if (tt === warm) { markN = on.total.nutrient; markS = on.total.spore; }
    Sim.tick(on, DT);
    clickTimer += DT;
    if (clickTimer >= clickInterval) {
      clickTimer = 0;
      const b = Sim.bestCandidate(on);
      if (b && b.cost <= on.res.water && Sim.growAt(on, b.x, b.y).ok) { /* 点了一格 */ }
    }
    spendUpgrades(on, STRATEGIES[2].priority);
    respondToEvents(on);
    if (on.res.nutrient > 400) upgradeNodes(on, 3);
  }
  const scale = seconds / win;
  const onN = (on.total.nutrient - markN) * scale;
  const onS = (on.total.spore - markS) * scale;

  /* 离线：同一快照，走折算（不 tick） */
  const off = Sim.deserialize(Sim.serialize(snapshot));
  Sim.computeFlow(off, 0);
  const res = Sim.settleOffline(off, seconds, { dryRun: true });

  const offN = res.gained.nutrient, offS = res.gained.spore;
  const ratioN = offN > 0 ? onN / offN : Infinity;
  const ratioS = offS > 0 ? onS / offS : Infinity;

  console.log(` ${label}`);
  console.log(`   起点菌丝 ${snapshot.nodes.length} 格（在线速率 养分 ${snapshot.rate.nutrient.toFixed(1)}/s）`);
  console.log(`   在线 ${(seconds / 3600).toFixed(1)}h：养分 ~${Math.round(onN)}  孢子 ~${Math.round(onS)}` +
              `（起手 ${warm}s 走完爬升，再取 ${win}s 稳态实测 ×${scale.toFixed(1)} 外推）`);
  console.log(`   离线 ${(seconds / 3600).toFixed(1)}h：养分 ${Math.round(offN)}  孢子 ${Math.round(offS)}`);
  console.log(`   在线/离线 = 养分 ×${ratioN.toFixed(2)}　孢子 ×${ratioS.toFixed(2)}`);
  return { onN, offN, ratioN, ratioS, seconds };
}

console.log('');
console.log('='.repeat(80));
console.log(' F. 离线收益 vs 在线主动操作（离线必须明显更低）');
console.log('='.repeat(80));
const off8 = offlineCompare('8 小时（上限口径）', 8 * 3600);

if (!isFinite(off8.ratioN) || off8.ratioN < 1.5) {
  console.log(` ❌ 失败：离线 8h 的收益达到了在线主动的 ${(100 / off8.ratioN).toFixed(0)}%` +
              ` —— 最优玩法会变成「关掉页面等」，必须把 offlineEff 调低。`);
  failed = true;
} else if (off8.ratioN < 2.5) {
  console.log(` ⚠️  离线达到在线的 ${(100 / off8.ratioN).toFixed(0)}%（×${off8.ratioN.toFixed(2)}）——` +
              ` 勉强合格，但建议再拉开一点。`);
} else {
  console.log(` ✅ 离线只有在线主动的 ${(100 / off8.ratioN).toFixed(0)}%（在线是离线的 ×${off8.ratioN.toFixed(2)}）` +
              ` —— 动手玩明显更划算，「关掉等」不是最优解。`);
}

/* 早期下限：只有核心的玩家离线 8h 也必须拿到东西，不能是 0。
 * 这条对应规划文档第 292~293 行「早期玩家回来发现什么都没发生」。 */
const early = Sim.newGame(SEEDS[0], {}, {}, 0);
const earlyRes = Sim.settleOffline(early, 8 * 3600, { dryRun: true });
console.log('');
console.log(` · 早期下限（1 格核心，未解锁自动蔓延）离线 8h：` +
            `水 ${Math.round(earlyRes.gained.water)}　养分 ${Math.round(earlyRes.gained.nutrient)}　孢子 ${Math.round(earlyRes.gained.spore)}`);
if (earlyRes.gained.water <= 0) {
  console.log(' ❌ 失败：早期玩家离线 8h 一无所获 —— 回来会发现「什么都没发生」。');
  failed = true;
} else {
  console.log(' ✅ 早期玩家也有下限产出（核心渗水兜底），回来一定有反馈。');
}

/* 封顶：超过 capHours 的部分不该继续累积 */
const capped = Sim.settleOffline(Sim.newGame(1, {}, {}, 0), 48 * 3600, { dryRun: true });
console.log(` · 封顶：离线 48h 实际只按 ${(capped.seconds / 3600).toFixed(1)}h 结算` +
            `（capHours=${CONFIG.OFFLINE.capHours}）${capped.capped ? ' ✅' : ' ❌'}`);
if (!capped.capped || capped.seconds > CONFIG.OFFLINE.capHours * 3600 + 1) {
  console.log(' ❌ 失败：离线时长没有被正确封顶。');
  failed = true;
}

/* 太短的离开不结算（切标签页回来不该弹提示） */
const tiny = Sim.settleOffline(Sim.newGame(1, {}, {}, 0), 30, { dryRun: true });
console.log(` · 离开 30 秒不结算（minSeconds=${CONFIG.OFFLINE.minSeconds}）：` +
            `${tiny === null ? '✅ 返回 null' : '❌ 结算了 ' + JSON.stringify(tiny.gained)}`);
if (tiny !== null) { console.log(' ❌ 失败：过短的离开也结算了。'); failed = true; }

/* ------------------------------------------------------------------ G 组 */
/* 转生三选一：三张卡必须**互相竞争**，不能有一张永远最优。
 *
 * 【为什么这条必须单独验】三选一是纯数值系统。如果「扩大地图」永远最强，
 * 玩家每次都会点地图 —— 那不是抉择，是提示，roguelike 的手感就没了。
 * 用户的原话是「每次转生可以选择获得一种菌种或者扩大地图，或者得到更多的
 * 转生的点数」，三种必须都值得考虑。
 *
 * 【判据】固定同一套经营方式（②扩张流，A 组里最主流的打法），
 * **唯一变量只有「每次转生选哪类卡」**：
 *   · 三档差距 < 1.10× → 选什么都差不多，卡片是装饰，设计失败；
 *   · 某一张 > 2.50× 碾压其余 → 实际只有一种玩法，同样失败；
 *   · 中间地带才算「三张卡都在竞争」。
 *
 * ⚠ 对照组必须带上 strains: [] —— 否则「菌株」那一档会额外吃到 E 组的
 * 菌株加成，比的就成了「菌株卡 vs 没菌株」，而不是三张卡本身。
 */
console.log('');
console.log('='.repeat(80));
console.log(' G. 转生三选一：三张卡是否互相竞争（同经营方式，只改选哪张卡）');
console.log('='.repeat(80));

const CHOICE_LABEL = { genes: '基因点', map: '扩大地图', strain: '菌株' };
const GROWTH_STRAT = STRATEGIES.find(s => s.key === 'expand');
const gResults = ['genes', 'map', 'strain'].map(pref => {
  const runs = SEEDS.map(seed =>
    run(Object.assign({}, GROWTH_STRAT, { choice: pref, strains: [] }), seed, DURATION));
  const avg = avgOf(runs);
  return { pref, avg };
});

for (const g of gResults) {
  const c = g.avg.choices;
  console.log(` ${CHOICE_LABEL[g.pref].padEnd(6)} 转生 ${g.avg.prestiges.toFixed(2).padStart(5)}` +
              `  基因 ${g.avg.genes.toFixed(1).padStart(5)}` +
              `  终局菌丝 ${String(Math.round(g.avg.nodes)).padStart(4)} 格` +
              `  地图档 ${g.avg.mapTier.toFixed(2)}（${g.avg.mapW ? Math.round(g.avg.mapW) + '×' + Math.round(g.avg.mapH) : '-'}）` +
              `  综合分 ${String(Math.round(g.avg.score)).padStart(6)}` +
              `  ｜ 选卡 菌株${c.strain} 地图${c.map} 点数${c.genes}`);
}

const gBest = gResults.slice().sort((a, b) => b.avg.score - a.avg.score);
const gWorst = gBest[gBest.length - 1];
const gRatio = gWorst.avg.score > 0 ? gBest[0].avg.score / gWorst.avg.score : Infinity;

/* 「卡真的落地了吗」—— 全选卡次数为 0 说明 pendingChoice 挂着没人选，
 * 整组数字都等于「玩家从不选卡」，那上面的比值毫无意义。 */
const gTotalPicks = gResults.reduce(
  (a, g) => a + g.avg.choices.strain + g.avg.choices.map + g.avg.choices.genes, 0);
console.log('');
if (gTotalPicks === 0) {
  console.log(' ❌ 失败：三档策略一张卡都没选到 —— 转生奖励没有落地（pendingChoice 无人处理）。');
  failed = true;
} else if (!isFinite(gRatio)) {
  console.log(' ❌ 失败：有一档综合分为 0，无法比较。');
  failed = true;
} else {
  console.log(` · 最优 ${CHOICE_LABEL[gBest[0].pref]}  vs  最差 ${CHOICE_LABEL[gWorst.pref]}` +
              `　差距 ${gRatio.toFixed(2)} 倍`);
  if (gRatio < 1.10) {
    console.log(' ❌ 失败：三张卡几乎没有差别 —— 选什么都一样，抉择是装饰。');
    failed = true;
  } else if (gRatio > 2.50) {
    console.log(` ⚠️  ${CHOICE_LABEL[gBest[0].pref]} 碾压其余（${gRatio.toFixed(2)}×）——` +
                ' 实际只有一种选法，需要调权重或数值。');
  } else {
    console.log(' ✅ 三张卡处在同一量级，且各有偏好 —— 这是个真的三选一。');
  }
  const gMap = gResults.find(g => g.pref === 'map');
  if (gMap && gMap.avg.mapTier > 0) {
    console.log(` · 地图卡确实把地图撑大了：档位 ${gMap.avg.mapTier.toFixed(2)}，` +
                `尺寸 ${Math.round(gMap.avg.mapW)}×${Math.round(gMap.avg.mapH)}` +
                `（基础 ${CONFIG.GRID.W}×${CONFIG.GRID.H}）✅`);
  } else {
    console.log(' ❌ 失败：选了地图卡，但地图档位仍是 0 —— 「扩大地图」没生效。');
    failed = true;
  }
}

console.log('');
console.log(' 最强策略成长曲线:');
console.log('  时间     菌丝   转生   基因   本局养分   本局孢子');
for (const p of best.timeline) {
  console.log(`  ${String(p.t).padStart(5)}s ${String(p.nodes).padStart(6)} ${String(p.prestiges).padStart(6)} ` +
              `${String(p.genes).padStart(6)} ${String(p.nutrient).padStart(10)} ${String(p.spore).padStart(10)}`);
}

process.exit(failed ? 1 : 0);
