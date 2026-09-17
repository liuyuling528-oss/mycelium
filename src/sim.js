/* ============================================================================
 * 菌丝 Mycelium — 核心模拟层（纯逻辑，不含任何渲染）
 *
 * 三层资源链：水 → 支撑菌丝生长；养分 → 买升级；孢子 → 散播转生。
 *
 * 网络的灵魂在 computeFlow()：
 *   每个节点的产出必须沿「到核心的最短路径」逐跳运回，
 *   每一跳都有吞吐上限，超出部分直接损失。
 *   于是「资源在远处」和「路太窄」同时成为问题 ——
 *   玩家必须决定：是加粗现有路径，还是另开一条绕行路线分流。
 *   这正是真实黏菌求解网络最优化的行为。
 * ==========================================================================*/
var Sim = (function () {
  'use strict';

  var CONFIG = (typeof module !== 'undefined' && module.exports) ? require('./config.js') : window.MYC.CONFIG;
  var RNG    = (typeof module !== 'undefined' && module.exports) ? require('./rng.js')    : window.MYC.RNG;

  var SOILS = CONFIG.SOILS, GRID = CONFIG.GRID;

  /* ---------------------------------------------------------------- 工具 */
  function idx(x, y) { return y * GRID.W + x; }
  function inBounds(x, y) { return x >= 0 && y >= 0 && x < GRID.W && y < GRID.H; }

  function emptyVec() { return { water: 0, nutrient: 0, spore: 0 }; }
  function addVec(a, b) { a.water += b.water; a.nutrient += b.nutrient; a.spore += b.spore; return a; }
  function sumVec(v) { return v.water + v.nutrient + v.spore; }
  function scaleVec(v, k) { return { water: v.water * k, nutrient: v.nutrient * k, spore: v.spore * k }; }

  /* ------------------------------------------------------------ 新开一局 */
  function newGame(seed, genes, knowledge) {
    var state = {
      seed: seed >>> 0,
      t: 0,                        // 本局已过秒数
      res: { water: 0, nutrient: 0, spore: 0 },
      total: { water: 0, nutrient: 0, spore: 0 },
      lostTotal: 0,                // 因吞吐不足而浪费的量（给玩家看的诊断）
      grid: [],
      nodes: [],
      nodeAt: [],
      byDist: [],
      maxDist: 0,
      core: { x: (GRID.W >> 1), y: (GRID.H >> 1) },
      up: {},
      genes: genes || {},
      knowledge: knowledge || {},  // 已探明格子，跨转生保留
      policy: 'nearest',
      autoGrow: true,
      autoTimer: 0,
      prestiges: 0,
      runs: [],                    // 每局的成绩
      log: [],

      /* ---- 内容层（技能 / 事件 / 里程碑）---- */
      cd: {},                      // 技能冷却剩余秒数
      unlocked: {},                // 已解锁的技能
      pulseT: 0,                   // 「菌丝脉冲」剩余时间
      events: [],                  // 地图上的事件（增益区 / 害虫）
      nextEventAt: CONFIG.EVENTS.firstAt,
      milestones: {},              // 已完成的里程碑 id
      mods: { water: 1, nutrient: 1, spore: 1 },
      counters: { gnatsRemoved: 0, maxNodeLevel: 0 },
      floaters: []                 // 浮动数字，供渲染层消费
    };
    CONFIG.UPGRADES.forEach(function (u) { state.up[u.key] = 0; });
    CONFIG.GENES.forEach(function (g) { if (state.genes[g.key] == null) state.genes[g.key] = 0; });

    generateMap(state);
    state.res.water = CONFIG.START.water + state.genes.gWater * 150;

    // 核心：第一颗菌丝节点
    var coreNode = makeNode(state, state.core.x, state.core.y, 'core', 0);
    state.nodes = [coreNode];
    state.nodeAt[idx(state.core.x, state.core.y)] = 0;
    rebuildNetwork(state);
    reveal(state);
    return state;
  }

  /* ------------------------------------------------------------ 地图生成 */
  function generateMap(state) {
    var rnd = RNG.makeRng(state.seed);
    var i, x, y;

    for (y = 0; y < GRID.H; y++) {
      for (x = 0; x < GRID.W; x++) {
        state.grid[idx(x, y)] = { x: x, y: y, soil: 'soil', known: false, node: null };
      }
    }

    // 落叶层的丰度用噪声铺，形成自然的斑块
    for (y = 0; y < GRID.H; y++) {
      for (x = 0; x < GRID.W; x++) {
        var n = RNG.fbm(x * CONFIG.GEN.noiseScale, y * CONFIG.GEN.noiseScale, state.seed, 3);
        state.grid[idx(x, y)].soil = (n > CONFIG.GEN.litterThreshold) ? 'litter' : 'soil';
      }
    }

    // 岩石簇：障碍物就是空间取舍的来源
    for (i = 0; i < CONFIG.GEN.rockClusters; i++) {
      var cx = Math.floor(rnd() * GRID.W), cy = Math.floor(rnd() * GRID.H);
      var n = Math.max(1, Math.round(CONFIG.GEN.rockClusterSize * (0.5 + rnd())));
      var rx = cx, ry = cy;
      for (var k = 0; k < n; k++) {
        if (inBounds(rx, ry)) state.grid[idx(rx, ry)].soil = 'rock';
        rx += Math.round(rnd() * 2 - 1);
        ry += Math.round(rnd() * 2 - 1);
      }
    }

    // 水脉按「河流」走，细细长长，值得为之绕路
    for (i = 0; i < CONFIG.GEN.veinRivers; i++) {
      var vx = Math.floor(rnd() * GRID.W), vy = Math.floor(rnd() * GRID.H);
      var ax = rnd() * 2 - 1, ay = rnd() * 2 - 1;
      for (var s = 0; s < CONFIG.GEN.veinLength; s++) {
        var w = CONFIG.GEN.veinWidth;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            if (rnd() > w / 3) continue;
            if (inBounds(vx + dx, vy + dy)) state.grid[idx(vx + dx, vy + dy)].soil = 'vein';
          }
        }
        if (inBounds(vx, vy)) state.grid[idx(vx, vy)].soil = 'vein';
        ax += (rnd() * 2 - 1) * 0.35; ay += (rnd() * 2 - 1) * 0.35;
        vx += Math.round(ax); vy += Math.round(ay);
        if (!inBounds(vx, vy)) { vx = Math.max(0, Math.min(GRID.W - 1, vx)); vy = Math.max(0, Math.min(GRID.H - 1, vy)); }
      }
    }

    // 腐木与树根：成团出现，是高价值目标
    placeBlobs(state, rnd, 'wood', CONFIG.GEN.woodBlobs, CONFIG.GEN.woodBlobSize);
    placeBlobs(state, rnd, 'root', CONFIG.GEN.rootBlobs, CONFIG.GEN.rootBlobSize);

    // 核心周围保证是软的，别一开局就被岩石封死
    var cx0 = state.core.x, cy0 = state.core.y;
    for (y = cy0 - 2; y <= cy0 + 2; y++) {
      for (x = cx0 - 2; x <= cx0 + 2; x++) {
        if (inBounds(x, y) && state.grid[idx(x, y)].soil === 'rock') state.grid[idx(x, y)].soil = 'soil';
      }
    }

    /* 开局保底：核心周围 2~3.5 格处固定放几块落叶和水脉。
     * 噪声尺度约 9 格，所以完全可能开局落在一整片只有水的贫瘠壤土上，
     * 玩家两分钟拿不到一点养分就会直接退出。
     * 半径必须收紧：挂机蔓延是 6 秒一格，太远的保底块前期够不到。
     * 方向随机，所以每张图仍然不同。 */
    [{ soil: 'litter', n: 5 }, { soil: 'vein', n: 2 }].forEach(function (p) {
      for (var k = 0; k < p.n; k++) {
        var ang = rnd() * Math.PI * 2;
        var rad = 2 + rnd() * 1.5;
        var px = Math.round(cx0 + Math.cos(ang) * rad);
        var py = Math.round(cy0 + Math.sin(ang) * rad);
        if (inBounds(px, py) && state.grid[idx(px, py)].soil !== 'core') {
          state.grid[idx(px, py)].soil = p.soil;
        }
      }
    });

    state.grid[idx(cx0, cy0)].soil = 'core';

    // 记录初始核心位置，供转生后重建
    for (i = 0; i < state.grid.length; i++) state.grid[i].node = null;
  }

  function placeBlobs(state, rnd, soil, count, avgSize) {
    for (var i = 0; i < count; i++) {
      var cx = Math.floor(rnd() * GRID.W), cy = Math.floor(rnd() * GRID.H);
      var n = Math.max(1, Math.round(avgSize * (0.5 + rnd())));
      var x = cx, y = cy;
      for (var k = 0; k < n; k++) {
        if (inBounds(x, y) && state.grid[idx(x, y)].soil !== 'core') {
          state.grid[idx(x, y)].soil = soil;
        }
        x += Math.round(rnd() * 2 - 1);
        y += Math.round(rnd() * 2 - 1);
      }
    }
  }

  /* ----------------------------------------------------------- 节点与网络 */
  function makeNode(state, x, y, soil, id) {
    return {
      // id 必须显式传入或等于「即将被 push 的下标」。
      // 早期版本在转生重建网络时用了 state.nodes.length，而当时数组还没被换掉，
      // 于是核心节点拿到了 263 这种越界 id，rebuildNetwork 直接崩。
      id: (id == null) ? state.nodes.length : id,
      x: x, y: y,
      soil: soil,
      level: 0,            // 强化等级：提升本节点产出与吞吐
      disabled: false,     // 被害虫占据时停止产出
      gnat: null,          // 占据它的害虫（null 表示没有）
      dist: 0,
      next: -1,
      inboxW: 0, inboxN: 0, inboxS: 0,
      prod: emptyVec(),
      through: emptyVec(),
      capacity: 0,
      cargo: 0,
      reached: 0
    };
  }

  /* BFS 建最短路：每个节点记录 dist 与朝向核心的 next 指针 */
  function rebuildNetwork(state) {
    invalidateCands(state);   // 网络形状变了：候选集、离核距离全部作废
    var i;
    for (i = 0; i < state.nodes.length; i++) {
      state.nodes[i].dist = -1;
      state.nodes[i].next = -1;
    }
    var core = state.nodes[0];
    core.dist = 0;
    var queue = [core.id], head = 0;
    var nodeAt = state.nodeAt;

    while (head < queue.length) {
      var cur = state.nodes[queue[head++]];
      var nb = neighbours(cur.x, cur.y);
      for (i = 0; i < nb.length; i++) {
        var nid = nodeAt[idx(nb[i][0], nb[i][1])];
        if (nid == null) continue;
        var nn = state.nodes[nid];
        if (nn.dist !== -1) continue;
        nn.dist = cur.dist + 1;
        nn.next = cur.id;
        queue.push(nn.id);
      }
    }

    // 按距离分组，运输时从最远端往回推
    state.maxDist = 0;
    for (i = 0; i < state.nodes.length; i++) state.maxDist = Math.max(state.maxDist, state.nodes[i].dist);
    state.byDist = [];
    for (i = 0; i <= state.maxDist; i++) state.byDist.push([]);
    for (i = 0; i < state.nodes.length; i++) {
      var d = state.nodes[i].dist;
      if (d >= 0) state.byDist[d].push(state.nodes[i].id);
    }
    recomputeCapacity(state);
  }

  function neighbours(x, y) {
    var out = [];
    if (x > 0) out.push([x - 1, y]);
    if (x < GRID.W - 1) out.push([x + 1, y]);
    if (y > 0) out.push([x, y - 1]);
    if (y < GRID.H - 1) out.push([x, y + 1]);
    return out;
  }

  function recomputeCapacity(state) {
    var k = 1 + CONFIG.TRANSPORT.capacityPerLevel * state.up.capacity;
    var cap = CONFIG.TRANSPORT.baseCapacity * k;
    var coreCap = CONFIG.TRANSPORT.coreCapacity * k;
    for (var i = 0; i < state.nodes.length; i++) {
      var n = state.nodes[i];
      // 强化等级也加粗这根菌丝，所以深耕流靠少量节点也能扛住吞吐
      var lvl = 1 + CONFIG.NODE_UP.capPerLevel * n.level;
      n.capacity = (i === 0 ? coreCap : cap) * lvl;
    }
  }

  /* 自动扩张间隔：基准很慢，靠「蔓延速度」升级递减。
   * 之所以不做成「先解锁自动扩张」，是因为那会造成死锁 ——
   * 升级要养分、养分要节点、节点又要自动扩张。现在网络永远会自己长，
   * 只是早期很慢，于是「手动点」成为前期的主要动力。 */
  function autoIntervalOf(state) {
    var base = CONFIG.GROW.autoInterval * Math.pow(CONFIG.GROW.autoDecay, state.up.autoGrow);
    // 「菌丝脉冲」期间蔓延提速 4 倍
    if (state.pulseT > 0) base *= 0.25;
    return base;
  }

  /* 距离损耗：越远越不划算，这是「近的低产 vs 远的高产」那个取舍的来源 */
  function transportEfficiency(state, dist) {
    var loss = CONFIG.TRANSPORT.distLoss *
               Math.pow(CONFIG.TRANSPORT.transportDecay, state.up.transport);
    return 1 / (1 + dist * loss);
  }

  function prodMultiplier(state) {
    return (1 + 0.12 * state.genes.gYield);
  }

  /* 某个格子的原始产出（不含离核损耗）。
   * 写进调用方给的对象 —— computeFlow 每帧对每个节点都调一次，
   * 不复用的话一帧就是几百次对象分配，GC 会成为主要开销。 */
  function cellYieldInto(state, soil, out) {
    var base = SOILS[soil].yield || {};
    out.water    = (base.water    || 0) * (1 + 0.18 * state.up.hydration);
    out.nutrient = (base.nutrient || 0) * (1 + 0.18 * state.up.absorption);
    out.spore    = (base.spore    || 0) * (1 + 0.18 * state.up.symbiosis);
    var m = prodMultiplier(state);
    out.water *= m; out.nutrient *= m; out.spore *= m;
    return out;
  }

  function cellYield(state, soil) {
    return cellYieldInto(state, soil, emptyVec());
  }

  /* 生长水耗：基质基础价 × 距离加价 × 生长效率折扣 */
  function growCostAt(state, x, y, distToCore) {
    var soil = state.grid[idx(x, y)].soil;
    var base = SOILS[soil].growCost;
    var dist = (distToCore == null) ? 1 : distToCore;
    var cost = base * (1 + CONFIG.GROW.distCost * dist);
    cost *= Math.pow(0.93, state.up.growth);
    cost *= Math.pow(0.94, state.genes.gGrowth);
    return Math.max(1, Math.round(cost));
  }

  /* 候选格：所有与网络相邻、可生长、尚未占用的格子。
   *
   * 这里加了缓存，原因很实际：渲染层每帧要读两次（候选点 + 推荐格），
   * 鼠标每次 pointermove 还要再读一次；网络一大，每帧就是几百次对象分配
   * 加几百个临时字符串，GC 会变成主要开销。
   *
   * 失效时机（缺一不可）：
   *   · rebuildNetwork —— 网络形状变了（长格子 / 转生 / 读档）
   *   · 买「生长效率」升级、gGrowth 基因 —— 生长成本系数变了
   * 节点强化不影响候选集也不影响成本，所以不用失效。
   *
   * 返回的数组**只读**：调用方不许改它（现有调用方都只读）。
   */
  function invalidateCands(state) { state._cands = null; }

  function candidates(state) {
    if (state._cands) return state._cands;
    var seen = {}, out = [];
    for (var i = 0; i < state.nodes.length; i++) {
      var nd = state.nodes[i], nb = neighbours(nd.x, nd.y);
      for (var k = 0; k < nb.length; k++) {
        var x = nb[k][0], y = nb[k][1], key = x + ',' + y;
        if (seen[key]) continue;
        if (state.nodeAt[idx(x, y)] != null) continue;
        if (SOILS[state.grid[idx(x, y)].soil].solid) continue;
        seen[key] = 1;
        var dist = nd.dist + 1;
        out.push({ x: x, y: y, dist: dist, soil: state.grid[idx(x, y)].soil, cost: growCostAt(state, x, y, dist) });
      }
    }
    state._cands = out;
    return out;
  }

  function canGrowAt(state, x, y) {
    var cs = candidates(state);
    for (var i = 0; i < cs.length; i++) if (cs[i].x === x && cs[i].y === y) return cs[i];
    return null;
  }

  /* 手动生长：立即生效，玩家的一次空间决策 */
  function growAt(state, x, y) {
    var c = canGrowAt(state, x, y);
    if (!c) return { ok: false, reason: '不相邻，菌丝还够不到' };
    if (state.res.water < c.cost) return { ok: false, reason: '水分不足，需要 ' + c.cost };
    state.res.water -= c.cost;
    addNode(state, x, y, c.soil);
    return { ok: true, cost: c.cost };
  }

  function addNode(state, x, y, soil) {
    var nd = makeNode(state, x, y, soil);
    state.nodes.push(nd);
    state.nodeAt[idx(x, y)] = nd.id;
    state.grid[idx(x, y)].node = nd.id;
    rebuildNetwork(state);
    reveal(state);
    return nd;
  }

  /* --------------------------------------------------------- 自动蔓延策略 */
  /* 按所选策略给候选打分。所有策略都用「加权求和」而不是只认一种资源 ——
   * 早期版本「找水脉」给落叶打负分，于是永远不种落叶、零养分把自己锁死。
   * 现在每个策略只是权重不同，仍然会顺手拿别的东西。                          */
  function scoreCandidate(state, c, policy) {
    var y = SOILS[c.soil].yield || {};
    var w;
    switch (policy) {
      case 'water':    w = { water: 6, nutrient: 1, spore: 2 };  break;
      case 'nutrient': w = { water: 1, nutrient: 4, spore: 2 };  break;
      case 'spore':    w = { water: 1, nutrient: 1, spore: 20 }; break;
      case 'richest':  w = { water: 1, nutrient: 2, spore: 6 };  break;
      case 'nearest':
      default:         w = { water: 1, nutrient: 1, spore: 2 };  break;
    }
    var base = (y.water || 0) * w.water
             + (y.nutrient || 0) * w.nutrient
             + (y.spore || 0) * w.spore;
    // 距离惩罚让策略不至于为了远处的肥肉把水耗光；
    // 「就近蔓延」把距离权重放大，于是它铺得最广。
    var distWeight = (policy === 'nearest') ? 0.35 : 0.05;
    return base - c.dist * distWeight - c.cost * 0.01;
  }

  function autoStep(state) {
    if (!state.autoGrow) return null;
    var best = bestCandidate(state);
    if (!best || best.cost > state.res.water) return null;
    state.res.water -= best.cost;
    addNode(state, best.x, best.y, best.soil);
    return best;
  }

  /* 当前策略下最值得长的格子。渲染层用它高亮「推荐格」，玩家手动点它即可 —— 
   * 也是手动操作能比自动更快的原因（自动只能按同一套评分走，玩家可以越过它）。 */
  function bestCandidate(state, policy) {
    var cs = candidates(state);
    var pol = policy || state.policy;
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < cs.length; i++) {
      var s = scoreCandidate(state, cs[i], pol);
      if (s > bestScore) { bestScore = s; best = cs[i]; }
    }
    return best;
  }

  /* ------------------------------------------------------------- 感知范围 */
  function reveal(state) {
    // 基础半径 2：已探明区域要比网络大一圈，玩家才有空间提前规划往哪长。
    // 半径 1 时可见区刚好贴着网络边缘，等于没有前瞻。
    var r = 2 + state.up.sight;
    for (var i = 0; i < state.nodes.length; i++) {
      var nd = state.nodes[i];
      for (var dy = -r; dy <= r; dy++) {
        for (var dx = -r; dx <= r; dx++) {
          var x = nd.x + dx, y = nd.y + dy;
          if (!inBounds(x, y)) continue;
          // 用欧氏距离而不是曼哈顿距离，探明区域是圆形而不是菱形
          if (Math.sqrt(dx * dx + dy * dy) > r + 0.5) continue;
          state.grid[idx(x, y)].known = true;
          state.knowledge[x + ',' + y] = 1;
        }
      }
    }
  }

  /* ------------------------------------------------------- 产出与运输核心 */
  /* 每帧复用的临时向量。computeFlow 对每个节点都要算一次产出，
   * 不复用的话 200 个节点一帧就是上千次对象分配，GC 会成为主要开销。
   * 只在 computeFlow 内部作中间值用，绝不跨帧保留引用。 */
  var _raw = emptyVec();

  function computeFlow(state, dt) {
    var i, d, nd;

    // 1) 每个节点的产出（已含离核损耗）
    var met = CONFIG.SPORE_METABOLISM * (1 + 0.18 * state.up.symbiosis) * prodMultiplier(state);
    var mods = state.mods || { water: 1, nutrient: 1, spore: 1 };
    for (i = 0; i < state.nodes.length; i++) {
      nd = state.nodes[i];

      // prod / through 每帧都写，直接复用节点上的对象，不重新分配
      var prod = nd.prod || (nd.prod = emptyVec());

      if (nd.soil === 'core') {
        _raw.water = state.seepRate || CONFIG.START.seep;
        _raw.nutrient = 0; _raw.spore = 0;
      } else {
        cellYieldInto(state, nd.soil, _raw);
      }
      // 网络代谢：每个节点都产一点孢子，所以规模本身就是孢子来源，
      // 树根只是加速器。这样扩张永远有收益。
      _raw.spore += met;

      // 强化等级：这是「深耕流」落到单个节点上的收益
      var lvlMul = 1 + CONFIG.NODE_UP.yieldPerLevel * nd.level;
      _raw.water    *= mods.water    * lvlMul;
      _raw.nutrient *= mods.nutrient * lvlMul;
      _raw.spore    *= mods.spore    * lvlMul;

      // 降雨带 / 孢子季：站进增益区就多产，鼓励「追着事件扩张」
      var bf = buffAt(state, nd.x, nd.y);
      if (bf) {
        _raw.water *= bf.water; _raw.nutrient *= bf.nutrient; _raw.spore *= bf.spore;
      }

      // 被害虫占据的节点停产 —— 这就是「必须回应」的压力来源
      if (nd.disabled) { _raw.water = 0; _raw.nutrient = 0; _raw.spore = 0; }

      var eff = transportEfficiency(state, Math.max(0, nd.dist));
      prod.water = _raw.water * eff;
      prod.nutrient = _raw.nutrient * eff;
      prod.spore = _raw.spore * eff;
      nd.inboxW = 0; nd.inboxN = 0; nd.inboxS = 0;
    }

    // 2) 从最远端往核心逐跳推送
    //
    // 关键设计：吞吐上限只约束「有价值货物」（养分 + 孢子），水不受限。
    // 早期版本对三者共用一条带宽，结果高产的 98 个水脉把带宽全占满，
    // 养分和孢子运不回来 —— 扩张反而饿死了自己。
    // 现在水作为生长介质自由流动，拥堵只发生在真正的货物上，
    // 于是「拥堵损耗」是一个干净的信号：该升级「菌丝加粗」了。
    var accepted = emptyVec();
    for (d = state.maxDist; d >= 0; d--) {
      var list = state.byDist[d];
      for (i = 0; i < list.length; i++) {
        nd = state.nodes[list[i]];

        var wTot = nd.prod.water + nd.inboxW;
        var nTot = nd.prod.nutrient + nd.inboxN;
        var sTot = nd.prod.spore + nd.inboxS;

        var cargo = nTot + sTot;
        var cap = nd.capacity;
        // 软上限：超载部分只有一部分能挤过去。既不会像硬上限那样
        // 让扩张失去意义，又让超载明显不划算，「菌丝加粗」因此有价值。
        var pass = (cargo <= cap) ? cargo
                                  : cap + (cargo - cap) * CONFIG.TRANSPORT.overflowPass;
        var k = cargo > 0 ? pass / cargo : 0;
        state.lostTotal += (cargo - pass);

        var outN = nTot * k, outS = sTot * k;
        var thr = nd.through || (nd.through = emptyVec());
        thr.water = wTot; thr.nutrient = outN; thr.spore = outS;
        nd.cargo = cargo;
        nd.cargoPass = pass;

        if (nd.next >= 0) {
          var nx = state.nodes[nd.next];
          nx.inboxW += wTot;
          nx.inboxN += outN;
          nx.inboxS += outS;
        } else {
          accepted.water += wTot;
          accepted.nutrient += outN;
          accepted.spore += outS;
        }
      }
    }

    // 3) 结算
    state.res.water    += accepted.water * dt;
    state.res.nutrient += accepted.nutrient * dt;
    state.res.spore    += accepted.spore * dt;
    state.total.water    += accepted.water * dt;
    state.total.nutrient += accepted.nutrient * dt;
    state.total.spore    += accepted.spore * dt;
    // rate 也是每帧都写的，复用
    var rate = state.rate || (state.rate = emptyVec());
    rate.water = accepted.water; rate.nutrient = accepted.nutrient; rate.spore = accepted.spore;
    return accepted;
  }

  /* ---------------------------------------------------------------- 主循环 */
  function tick(state, dt) {
    state.t += dt;
    state.seepRate = CONFIG.START.seep + state.genes.gRate * 0.4;

    // 技能冷却与「菌丝脉冲」计时
    for (var k in state.cd) if (state.cd[k] > 0) state.cd[k] = Math.max(0, state.cd[k] - dt);
    if (state.pulseT > 0) state.pulseT = Math.max(0, state.pulseT - dt);

    computeFlow(state, dt);

    // 自动蔓延
    var interval = autoIntervalOf(state);
    state.autoTimer += dt;
    while (state.autoTimer >= interval) {
      state.autoTimer -= interval;
      if (!autoStep(state)) { state.autoTimer = 0; break; }
    }

    // 内容层
    tickEvents(state, dt);
    state.newMilestones = checkMilestones(state);

    // 浮动数字寿命（渲染层消费，sim 只负责计时）
    for (var i = state.floaters.length - 1; i >= 0; i--) {
      state.floaters[i].t -= dt;
      if (state.floaters[i].t <= 0) state.floaters.splice(i, 1);
    }
    return state;
  }

  /* =====================================================================
   * 内容层：节点强化 / 主动技能 / 地图事件 / 里程碑
   *
   * 这一层解决的是「点完格子只能干等」的问题：
   *   节点强化 —— 让「点击」有两个用途（长新格子 / 强化老格子）
   *   主动技能 —— 手上随时有事做，并制造「攒时机 → 一波爆发」的节奏
   *   地图事件 —— 有东西出现在地图上需要你回应
   *   里程碑   —— 给目标，并且渐进解锁（一开局全摆在眼前 = 内容多但很平）
   * ===================================================================*/

  function pushFloater(state, x, y, text, kind) {
    state.floaters.push({ x: x, y: y, text: text, kind: kind || 'water', t: 1.7 });
    if (state.floaters.length > 40) state.floaters.shift();
  }

  /* ---- 节点强化 ------------------------------------------------------ */
  function nodeUpgradeCost(state, nd) {
    if (!nd || nd.level >= CONFIG.NODE_UP.maxLevel) return Infinity;
    return Math.round(CONFIG.NODE_UP.baseCost * Math.pow(CONFIG.NODE_UP.costGrowth, nd.level));
  }

  function upgradeNode(state, nodeId) {
    var nd = state.nodes[nodeId];
    if (!nd) return { ok: false, reason: '这里没有菌丝' };
    var cost = nodeUpgradeCost(state, nd);
    if (!isFinite(cost)) return { ok: false, reason: '这个节点已满级' };
    if (state.res.nutrient < cost) return { ok: false, reason: '养分不足，需要 ' + cost };
    state.res.nutrient -= cost;
    nd.level += 1;
    if (nd.level > state.counters.maxNodeLevel) state.counters.maxNodeLevel = nd.level;
    recomputeCapacity(state);
    pushFloater(state, nd.x, nd.y, 'Lv' + nd.level, 'nutrient');
    return { ok: true, cost: cost, level: nd.level };
  }

  /* 某格子落在哪个增益区里（没有则返回 null） */
  function buffAt(state, x, y) {
    var evs = state.events;
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (e.kind === 'gnat') continue;
      var dx = e.x - x, dy = e.y - y;
      if (dx * dx + dy * dy <= e.r * e.r) {
        var m = CONFIG.EVENTS.buffMul;
        return (e.kind === 'rain')
          ? { water: m, nutrient: 1, spore: 1 }
          : { water: 1, nutrient: 1, spore: m };
      }
    }
    return null;
  }

  /* ---- 主动技能 ------------------------------------------------------ */
  function abilityCfg(key) {
    for (var i = 0; i < CONFIG.ABILITIES.length; i++) {
      if (CONFIG.ABILITIES[i].key === key) return CONFIG.ABILITIES[i];
    }
    return null;
  }

  function abilityReady(state, key) {
    return !!state.unlocked[key] && (state.cd[key] || 0) <= 0;
  }

  function useAbility(state, key) {
    var cfg = abilityCfg(key);
    if (!cfg) return { ok: false, reason: '没有这个技能' };
    if (!state.unlocked[key]) return { ok: false, reason: '尚未解锁' };
    if ((state.cd[key] || 0) > 0) return { ok: false, reason: '冷却中，还剩 ' + Math.ceil(state.cd[key]) + ' 秒' };

    var msg;
    if (key === 'pulse') {
      state.pulseT = 8;
      msg = '菌丝脉冲 —— 蔓延速度 ×4，持续 8 秒';
      pushFloater(state, state.core.x, state.core.y, '脉冲!', 'water');
    } else if (key === 'digest') {
      // 立刻结算 30 秒的养分产出，给一个「大数字」的爽点
      var rt = state.rate || { nutrient: 0 };
      var gainN = Math.max(30, Math.round(rt.nutrient * 30 * state.mods.nutrient));
      state.res.nutrient += gainN;
      state.total.nutrient += gainN;
      msg = '酶解 —— 立刻结算 +' + gainN + ' 养分';
      pushFloater(state, state.core.x, state.core.y, '+' + gainN, 'nutrient');
    } else {
      var gainS = Math.max(5, Math.round(state.nodes.length * 1.5));
      state.res.spore += gainS;
      state.total.spore += gainS;
      msg = '孢子爆 —— +' + gainS + ' 孢子';
      pushFloater(state, state.core.x, state.core.y, '+' + gainS, 'spore');
    }
    state.cd[key] = cfg.cd;
    return { ok: true, msg: msg };
  }

  /* ---- 地图事件 ------------------------------------------------------ */
  /* 连续随机流：必须跨调用保持状态。
   * 早期版本每次事件都新建 RNG（makeRng(seed + n)），而 mulberry32 对相近种子的
   * 第一个输出高度相关 —— 实测 40 次事件判定全部落在同一侧，害虫永远不出现，
   * 但代码看起来完全正常。这个 bug 是浏览器自测抓出来的，肉眼查不出来。 */
  function stateRng(state) {
    state.rngA = ((state.rngA == null ? state.seed : state.rngA) + 0x6D2B79F5) >>> 0;
    var t = state.rngA;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function countGnats(state) {
    var n = 0;
    for (var i = 0; i < state.events.length; i++) if (state.events[i].kind === 'gnat') n++;
    return n;
  }

  function freeNodeIds(state) {
    var out = [];
    for (var i = 1; i < state.nodes.length; i++) if (!state.nodes[i].gnat) out.push(i);
    return out;
  }

  function putGnat(state, nodeId) {
    var nd = state.nodes[nodeId];
    if (!nd || nd.gnat) return null;
    var g = { kind: 'gnat', nodeId: nodeId, spawnT: CONFIG.EVENTS.gnatInterval };
    nd.gnat = g;
    nd.disabled = true;
    state.events.push(g);
    return g;
  }

  function spawnEvent(state) {
    var cfg = CONFIG.EVENTS;
    var ev = null;

    // 害虫：只在网络有规模后出现，开局就被骚扰很烦人
    if (state.nodes.length >= 20 && countGnats(state) < cfg.gnatMax && stateRng(state) < 0.4) {
      var pool = freeNodeIds(state);
      if (pool.length) ev = putGnat(state, pool[Math.floor(stateRng(state) * pool.length)]);
    }

    if (!ev) {
      // 增益区：落在网络外侧的空地上，鼓励「往外扩张去吃掉它」
      var anchor = state.nodes[Math.floor(stateRng(state) * state.nodes.length)] || state.nodes[0];
      var ang = stateRng(state) * Math.PI * 2, rad = 3 + stateRng(state) * 5;
      var x = Math.max(0, Math.min(GRID.W - 1, Math.round(anchor.x + Math.cos(ang) * rad)));
      var y = Math.max(0, Math.min(GRID.H - 1, Math.round(anchor.y + Math.sin(ang) * rad)));
      ev = {
        kind: stateRng(state) < 0.5 ? 'rain' : 'bloom',
        x: x, y: y, r: cfg.buffRadius,
        ttl: cfg.buffDur, dur: cfg.buffDur
      };
      state.events.push(ev);
    }

    // 交给渲染层/面板做提示，sim 自己不知道 UI 的存在
    if (!state.newEvents) state.newEvents = [];
    state.newEvents.push(ev);
    return ev;
  }

  function tickEvents(state, dt) {
    var cfg = CONFIG.EVENTS, i, e;

    for (i = state.events.length - 1; i >= 0; i--) {
      e = state.events[i];
      if (e.kind === 'gnat') {
        // 不处理就会繁殖，但上限只有 3 只，且只「停产」不摧毁节点。
        // 所以放任不管的代价是产能下降，而不是资产损失。
        e.spawnT -= dt;
        if (e.spawnT <= 0) {
          e.spawnT = cfg.gnatInterval * (state.mods.gnatSlow ? 2 : 1);
          if (countGnats(state) < cfg.gnatMax) {
            var pool = freeNodeIds(state);
            if (pool.length) putGnat(state, pool[Math.floor(stateRng(state) * pool.length)]);
          }
        }
      } else {
        e.ttl -= dt;
        if (e.ttl <= 0) state.events.splice(i, 1);
      }
    }

    if (state.t >= state.nextEventAt) {
      spawnEvent(state);
      state.nextEventAt = state.t + cfg.intervalMin +
                          stateRng(state) * (cfg.intervalMax - cfg.intervalMin);
    }
  }

  function removeGnat(state, nodeId) {
    var nd = state.nodes[nodeId];
    if (!nd || !nd.gnat) return { ok: false, reason: '这里没有害虫' };
    for (var i = 0; i < state.events.length; i++) {
      if (state.events[i] === nd.gnat) { state.events.splice(i, 1); break; }
    }
    nd.gnat = null;
    nd.disabled = false;
    state.counters.gnatsRemoved += 1;
    state.res.nutrient += CONFIG.EVENTS.gnatReward;
    state.total.nutrient += CONFIG.EVENTS.gnatReward;
    pushFloater(state, nd.x, nd.y, '+' + CONFIG.EVENTS.gnatReward, 'nutrient');
    return { ok: true, reward: CONFIG.EVENTS.gnatReward };
  }

  /* ---- 里程碑（永久成就层，跨转生保留）-------------------------------- */
  function checkMilestones(state) {
    var done = [], i, m, ok;
    var hasSoil = function (s) {
      for (var k = 0; k < state.nodes.length; k++) if (state.nodes[k].soil === s) return true;
      return false;
    };
    var M = CONFIG.MILESTONES;
    for (i = 0; i < M.length; i++) {
      m = M[i];
      if (state.milestones[m.id]) continue;
      ok = false;
      if (m.id === 'm1') ok = state.nodes.length >= 12;
      else if (m.id === 'm2') ok = hasSoil('vein');
      else if (m.id === 'm3') ok = hasSoil('wood');
      else if (m.id === 'm4') ok = hasSoil('root');
      else if (m.id === 'm5') ok = state.counters.maxNodeLevel >= 5;
      else if (m.id === 'm6') ok = state.nodes.length >= 60;
      else if (m.id === 'm7') ok = state.counters.gnatsRemoved >= 5;
      else if (m.id === 'm8') ok = state.prestiges >= 1;
      if (!ok) continue;

      state.milestones[m.id] = true;
      applyMilestoneReward(state, m.id);
      done.push(m);
    }
    return done;
  }

  function applyMilestoneReward(state, id) {
    switch (id) {
      case 'm1': state.unlocked.pulse = true; state.res.water += 300; break;
      case 'm2': state.mods.water *= 1.25; break;
      case 'm3': state.unlocked.digest = true; break;
      case 'm4': state.unlocked.sporulate = true; break;
      case 'm5':
        state.mods.water *= 1.10; state.mods.nutrient *= 1.10; state.mods.spore *= 1.10;
        break;
      case 'm6': state.pendingGenes = (state.pendingGenes || 0) + 2; break;
      case 'm7': state.mods.gnatSlow = true; break;
      case 'm8': state.pendingGenes = (state.pendingGenes || 0) + 3; break;
    }
  }

  /* ---------------------------------------------------------------- 升级 */
  function upgradeCost(state, key) {
    var u = null;
    for (var i = 0; i < CONFIG.UPGRADES.length; i++) if (CONFIG.UPGRADES[i].key === key) u = CONFIG.UPGRADES[i];
    if (!u) return Infinity;
    var lv = state.up[key] || 0;
    if (u.max != null && lv >= u.max) return Infinity;
    return Math.round(u.base * Math.pow(u.growth, lv));
  }

  function buyUpgrade(state, key) {
    var u = null;
    for (var i = 0; i < CONFIG.UPGRADES.length; i++) if (CONFIG.UPGRADES[i].key === key) u = CONFIG.UPGRADES[i];
    if (!u) return { ok: false, reason: '没有这项' };
    var lv = state.up[key] || 0;
    if (u.max != null && lv >= u.max) return { ok: false, reason: '已满级' };
    var cost = upgradeCost(state, key);
    if (state.res.nutrient < cost) return { ok: false, reason: '养分不足，需要 ' + cost };
    state.res.nutrient -= cost;
    state.up[key] = lv + 1;
    recomputeCapacity(state);
    reveal(state);
    if (key === 'transport' || key === 'capacity' || key === 'sight') rebuildNetwork(state);
    /* 生长效率只改候选格的「价格」不改网络，但候选缓存里存着价格，必须失效 */
    else if (key === 'growth') invalidateCands(state);
    return { ok: true };
  }

  /* ------------------------------------------------------- 散播孢子（转生）*/
  function prestigeCost(state) {
    return Math.round(CONFIG.PRESTIGE.firstCost * Math.pow(CONFIG.PRESTIGE.costGrowth, state.prestiges));
  }

  function geneGain(state) {
    return Math.floor(state.total.nutrient / CONFIG.PRESTIGE.geneDivisorNutrient)
         + Math.floor(state.total.spore / CONFIG.PRESTIGE.geneDivisorSpore);
  }

  function canPrestige(state) {
    return state.res.spore >= prestigeCost(state) && geneGain(state) > 0;
  }

  /* 散播：重置网络与资源，但保留地图知识，并换取基因点 */
  function doPrestige(state) {
    if (!canPrestige(state)) return { ok: false, reason: '孢子不足' };
    var gained = geneGain(state);
    var record = {
      run: state.prestiges + 1,
      seconds: Math.round(state.t),
      stage: state.nodes.length,
      nutrient: Math.round(state.total.nutrient),
      spore: Math.round(state.total.spore),
      genes: gained
    };
    state.runs.push(record);

    state.prestiges += 1;
    state.res = { water: CONFIG.START.water + state.genes.gWater * 150,
                  nutrient: 0, spore: 0 };
    state.total = { water: 0, nutrient: 0, spore: 0 };
    state.lostTotal = 0;
    state.t = 0;
    state.autoTimer = 0;

    // 技能与地图事件是「本局」的东西，转生后重来。
    // 但已解锁的技能、已完成的里程碑、里程碑带来的增益属于永久成就层，保留 ——
    // 否则每转生一次都要重新解锁技能，非常烦人。
    state.cd = {};
    state.pulseT = 0;
    state.events = [];
    state.nextEventAt = CONFIG.EVENTS.firstAt;
    state.floaters = [];

    // 重建网络：只留核心。必须先清空 state.nodes，否则 makeNode 会拿到旧长度当 id。
    for (var i = 0; i < state.grid.length; i++) state.grid[i].node = null;
    state.nodes = [];
    state.nodeAt = [];
    var coreNode = makeNode(state, state.core.x, state.core.y, 'core', 0);
    state.nodes = [coreNode];
    state.nodeAt[idx(state.core.x, state.core.y)] = 0;

    // 基因点兑现
    state.pendingGenes = (state.pendingGenes || 0) + gained;

    // 地图知识保留，重新标 known
    for (var key in state.knowledge) {
      var p = key.split(','), x = +p[0], y = +p[1];
      if (inBounds(x, y)) state.grid[idx(x, y)].known = true;
    }
    rebuildNetwork(state);
    reveal(state);
    state.lastRecord = record;
    return { ok: true, gained: gained, record: record };
  }

  function geneCost(state, key) {
    var g = null;
    for (var i = 0; i < CONFIG.GENES.length; i++) if (CONFIG.GENES[i].key === key) g = CONFIG.GENES[i];
    if (!g) return Infinity;
    return Math.round(g.base * Math.pow(g.growth, state.genes[key] || 0));
  }

  function buyGene(state, key) {
    var cost = geneCost(state, key);
    if ((state.pendingGenes || 0) < cost) return { ok: false, reason: '基因点不足' };
    state.pendingGenes -= cost;
    state.genes[key] = (state.genes[key] || 0) + 1;
    recomputeCapacity(state);
    /* gGrowth 改变生长成本 → 候选缓存里的价格作废 */
    if (key === 'gGrowth') invalidateCands(state);
    return { ok: true };
  }

  /* ---------------------------------------------------------------- 存档 */
  function serialize(state) {
    return JSON.stringify({
      v: 2,
      seed: state.seed,
      res: state.res, total: state.total, t: state.t,
      up: state.up, genes: state.genes, knowledge: state.knowledge,
      policy: state.policy, autoGrow: state.autoGrow,
      prestiges: state.prestiges, runs: state.runs,
      pendingGenes: state.pendingGenes || 0,
      // 内容层：技能解锁、冷却、里程碑、增益、计数
      cd: state.cd, unlocked: state.unlocked, pulseT: state.pulseT,
      milestones: state.milestones, mods: state.mods, counters: state.counters,
      nextEventAt: state.nextEventAt,
      nodes: state.nodes.map(function (n) { return [n.x, n.y, n.soil, n.level]; })
    });
  }

  function deserialize(json) {
    var d = JSON.parse(json);
    var state = newGame(d.seed, d.genes, d.knowledge);
    state.up = d.up; state.res = d.res; state.total = d.total; state.t = d.t;
    state.policy = d.policy; state.autoGrow = d.autoGrow;
    state.prestiges = d.prestiges; state.runs = d.runs || [];
    state.pendingGenes = d.pendingGenes || 0;
    state.cd = d.cd || {};
    state.unlocked = d.unlocked || {};
    state.pulseT = d.pulseT || 0;
    state.milestones = d.milestones || {};
    if (d.mods) state.mods = d.mods;
    if (d.counters) state.counters = d.counters;
    if (d.nextEventAt != null) state.nextEventAt = d.nextEventAt;

    state.nodes = []; state.nodeAt = [];
    for (var i = 0; i < state.grid.length; i++) state.grid[i].node = null;
    d.nodes.forEach(function (n, i) {
      var nd = makeNode(state, n[0], n[1], n[2], i);
      nd.level = n[3] || 0;
      state.nodes.push(nd);
      state.nodeAt[idx(n[0], n[1])] = i;
      state.grid[idx(n[0], n[1])].node = i;
    });
    rebuildNetwork(state);
    reveal(state);
    return state;
  }

  /* -------------------------------------------------------------- 统计 */
  function stats(state) {
    var bySoil = {}, lost = 0;
    for (var i = 0; i < state.nodes.length; i++) {
      bySoil[state.nodes[i].soil] = (bySoil[state.nodes[i].soil] || 0) + 1;
    }
    return {
      nodes: state.nodes.length,
      maxDist: state.maxDist,
      bySoil: bySoil,
      lost: lost,
      rate: state.rate || emptyVec()
    };
  }

  return {
    newGame: newGame, tick: tick, growAt: growAt, canGrowAt: canGrowAt,
    candidates: candidates, growCostAt: growCostAt, cellYield: cellYield,
    transportEfficiency: transportEfficiency,
    upgradeCost: upgradeCost, buyUpgrade: buyUpgrade,
    prestigeCost: prestigeCost, geneGain: geneGain, canPrestige: canPrestige, doPrestige: doPrestige,
    geneCost: geneCost, buyGene: buyGene,
    serialize: serialize, deserialize: deserialize,
    stats: stats, idx: idx, rebuildNetwork: rebuildNetwork, autoStep: autoStep,
    bestCandidate: bestCandidate, autoIntervalOf: autoIntervalOf,
    // 内容层
    nodeUpgradeCost: nodeUpgradeCost, upgradeNode: upgradeNode,
    abilityReady: abilityReady, useAbility: useAbility, abilityCfg: abilityCfg,
    spawnEvent: spawnEvent, removeGnat: removeGnat, buffAt: buffAt,
    countGnats: countGnats, checkMilestones: checkMilestones,
    pushFloater: pushFloater,
    cellYieldOf: function (state, soil) { return cellYield(state, soil); }
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = Sim; }
else { window.MYC = window.MYC || {}; window.MYC.Sim = Sim; }
