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

  /* ---- 当前地图尺寸 ----
   * 地图随转生次数长大（见 mapSizeFor），所以尺寸是 per-run 的，不再是常量。
   * 绝大多数逻辑都是「以 state 为参数的局部计算」，对大小无感知；
   * 真正用到 W/H 的只有 idx / inBounds / neighbours 这几个底层换算 —— 它们读这里。
   * 一个进程同时只有一张活动地图：浏览器只有一份 state；
   * headless_sim 逐个跑策略（串行），newGame / deserialize 会顺手更新它。 */
  var _MAP = { w: GRID.W, h: GRID.H };

  /* 地图随**转生抉择**长大：只有在三选一里选了「扩大地图」才 +1 档。
   *
   * 【为什么不再按 prestiges 自动推导】
   * 原本是 `1 + prestiges * 0.12` —— 每转一次必然更大。
   * 那样「地图」不构成任何决策，玩家不需要为它做任何事。
   * 改成读 `state.mapTier` 之后：
   *   · 想铺满大舞台的玩家会去选地图卡；
   *   · 想深耕小地图（单位密度高、维护费低）的玩家可以不选。
   * 两条路线都成立，这才是选择。
   *
   * 封顶不变：边长最多 2 倍（面积 4 倍，约 68×40）。
   * 孢子收入正比于节点数，地图无上限 = 经济失控。 */
  function mapSizeFor(mapTier) {
    var t = Math.max(0, mapTier || 0);
    var s = Math.min(2, 1 + t * CONFIG.PRESTIGE_CHOICE.mapStepMul);
    return { w: Math.round(GRID.W * s), h: Math.round(GRID.H * s) };
  }

  /* 切换活动地图尺寸。newGame / doPrestige 用。 */
  function applyMapSize(state, m) {
    _MAP.w = m.w; _MAP.h = m.h;
    state.mapW = m.w; state.mapH = m.h;
    state.core = { x: (m.w >> 1), y: (m.h >> 1) };
  }

  /* ---------------------------------------------------------------- 工具 */
  function idx(x, y) { return y * _MAP.w + x; }
  function inBounds(x, y) { return x >= 0 && y >= 0 && x < _MAP.w && y < _MAP.h; }

  function emptyVec() { return { water: 0, nutrient: 0, spore: 0 }; }
  function addVec(a, b) { a.water += b.water; a.nutrient += b.nutrient; a.spore += b.spore; return a; }
  function sumVec(v) { return v.water + v.nutrient + v.spore; }
  function scaleVec(v, k) { return { water: v.water * k, nutrient: v.nutrient * k, spore: v.spore * k }; }

  /* ------------------------------------------------------------ 新开一局 */
  /* mapTier：地图已扩展的档位（0 = 基础尺寸）。由「转生抉择」里的地图卡累加。
   * 老调用方（测试 / 存档迁移）只传 prestiges 也能跑，但地图尺寸**不再**由
   * prestiges 推导 —— 那里现在只记「转了多少次」这个统计量。 */
  function newGame(seed, genes, knowledge, prestiges, mapTier) {
    var m = mapSizeFor(mapTier || 0);
    var state = {
      seed: seed >>> 0,
      mapW: m.w, mapH: m.h,        // 本局地图尺寸（由 mapTier 决定）
      mapTier: mapTier || 0,       // 地图扩展档位（跨转生保留）
      t: 0,                        // 本局已过秒数
      res: { water: 0, nutrient: 0, spore: 0 },
      total: { water: 0, nutrient: 0, spore: 0 },
      lostTotal: 0,                // 因吞吐不足而浪费的量（给玩家看的诊断）
      grid: [],
      nodes: [],
      nodeAt: [],
      byDist: [],
      maxDist: 0,
      core: { x: (m.w >> 1), y: (m.h >> 1) },
      explored: { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, count: 0 },
      discoveredSoils: {},         // 见过的基质类型 —— 「自动蔓延」解锁条件（m10）
      up: {},
      genes: genes || {},
      knowledge: knowledge || {},  // 已探明格子（换图后作废）
      policy: 'nearest',
      /* 自动蔓延**默认锁定**，探索到全部 4 种特殊基质后由里程碑 m10 解锁。
       * 白送的话它毫无意义，前期也少了「跑图找齐基质」这个明确目标。
       * 注意 doPrestige 不重置它 —— 解锁一次永久有效。 */
      autoGrow: false,
      autoTimer: 0,
      /* 自动蔓延的两条选址规则（0 = 不限）。
       * 故意做成**状态**而不是配置常量：它们是玩家的操作偏好，
       * 存进存档、跨转生保留、跨会话保留。 */
      ruleMaxDist: 0,
      ruleMinYield: 0,
      /* 已装备的菌株（key 数组）。开局空 —— 菌株要菌丝达到 STRAIN.unlockNodes
       * 才出现，那时玩家已经建立了对网络的基本认知，才谈得上「选路线」。
       * 故意**跨转生保留**（doPrestige 不重置）：它是 build 选择，
       * 和基因同一层级，每转生重选一次会打断「我在走一条流派」的连续性。 */
      strains: [],
      prestiges: prestiges || 0,
      runs: [],                    // 每局的成绩
      log: [],

      /* 待处理的「转生抉择」。
       * 转生时由 doPrestige 生成一组候选卡放进来，玩家选一张后清空。
       * 为什么做成**状态**而不是直接弹窗：转生可能发生在刷新页面之前，
       * 存进存档才能保证「关掉页面再回来，那张没选的卡还在」。 */
      pendingChoice: null,

      /* ---- 内容层（技能 / 事件 / 里程碑）---- */
      cd: {},                      // 技能冷却剩余秒数
      unlocked: {},                // 已解锁的技能
      pulseT: 0,                   // 「菌丝脉冲」剩余时间
      events: [],                  // 地图上的事件（增益区 / 害虫）
      nextEventAt: CONFIG.EVENTS.firstAt,
      milestones: {},              // 已完成的里程碑 id
      mods: { water: 1, nutrient: 1, spore: 1 },
      counters: { gnatsRemoved: 0, maxNodeLevel: 0, maxNodes: 0, connectedSoils: {} },
      floaters: []                 // 浮动数字，供渲染层消费
    };
    CONFIG.UPGRADES.forEach(function (u) { state.up[u.key] = 0; });
    CONFIG.GENES.forEach(function (g) { if (state.genes[g.key] == null) state.genes[g.key] = 0; });
    applyMapSize(state, m);

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
    var W = _MAP.w, H = _MAP.h;
    /* 特征数量按面积缩放：地图大了，矿脉/岩石/腐木的**密度**不能变稀，
     * 否则大地图就是一片空地，等于惩罚转生多的玩家。 */
    var dens = (W * H) / (GRID.W * GRID.H);

    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        state.grid[idx(x, y)] = { x: x, y: y, soil: 'soil', known: false, node: null };
      }
    }

    // 落叶层的丰度用噪声铺，形成自然的斑块
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        var n = RNG.fbm(x * CONFIG.GEN.noiseScale, y * CONFIG.GEN.noiseScale, state.seed, 3);
        state.grid[idx(x, y)].soil = (n > CONFIG.GEN.litterThreshold) ? 'litter' : 'soil';
      }
    }

    // 岩石簇：障碍物就是空间取舍的来源
    for (i = 0; i < Math.round(CONFIG.GEN.rockClusters * dens); i++) {
      var cx = Math.floor(rnd() * W), cy = Math.floor(rnd() * H);
      var n = Math.max(1, Math.round(CONFIG.GEN.rockClusterSize * (0.5 + rnd())));
      var rx = cx, ry = cy;
      for (var k = 0; k < n; k++) {
        if (inBounds(rx, ry)) state.grid[idx(rx, ry)].soil = 'rock';
        rx += Math.round(rnd() * 2 - 1);
        ry += Math.round(rnd() * 2 - 1);
      }
    }

    // 水脉按「河流」走，细细长长，值得为之绕路
    for (i = 0; i < Math.round(CONFIG.GEN.veinRivers * dens); i++) {
      var vx = Math.floor(rnd() * W), vy = Math.floor(rnd() * H);
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
        if (!inBounds(vx, vy)) { vx = Math.max(0, Math.min(W - 1, vx)); vy = Math.max(0, Math.min(H - 1, vy)); }
      }
    }

    // 腐木与树根：成团出现，是高价值目标
    placeBlobs(state, rnd, 'wood', Math.round(CONFIG.GEN.woodBlobs * dens), CONFIG.GEN.woodBlobSize);
    placeBlobs(state, rnd, 'root', Math.round(CONFIG.GEN.rootBlobs * dens), CONFIG.GEN.rootBlobSize);

    /* 树根额外在核心附近补几块。
     *
     * 为什么必须这么做：树的价值全在「长大」——古树要 180 秒，
     * 而远处（dist 15+）的树根要等玩家修完一条长路才够得着，
     * 出生点旁边十几格的树根本来不及长成就已经转生了。
     * 按现在的地图生成，核心感知圈内几乎从来不含树根（实测 5 个种子里 0 个），
     * 于是「养树」这条路线在真实局面里根本不存在 —— 不是难，是不可达。
     * 在 3~8 格环上补 rootBlobsNear 块，玩家第一分钟就能种下第一棵树。 */
    placeRootsNearCore(state, rnd, CONFIG.GEN.rootBlobsNear);

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
      var cx = Math.floor(rnd() * _MAP.w), cy = Math.floor(rnd() * _MAP.h);
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

  /* 在核心外圈（minR~maxR 的甜甜圈）撒几块树根。
   * 直接就在核心感知圈里的树根不给 —— 那样开局白送一棵树，
   * 缺了「把它接进网络」这一步。要的是「看得见、走两步够得着」。 */
  function placeRootsNearCore(state, rnd, count) {
    if (!count) return;
    var W = _MAP.w, H = _MAP.h;
    var cx = state.core.x, cy = state.core.y;
    for (var i = 0; i < count; i++) {
      for (var tries = 0; tries < 40; tries++) {
        var a = rnd() * Math.PI * 2;
        var r = 3 + rnd() * 5;                       // 3 ~ 8 格
        var x = Math.round(cx + Math.cos(a) * r);
        var y = Math.round(cy + Math.sin(a) * r);
        if (!inBounds(x, y)) continue;
        var g = state.grid[idx(x, y)];
        if (g.soil === 'core' || g.soil === 'rock') continue;
        g.soil = 'root';
        // 顺带长成 2~3 格的小团，不然孤立一格太容易被岩石缝吞掉
        for (var k = 0; k < 2; k++) {
          var nx2 = x + Math.round(rnd() * 2 - 1), ny2 = y + Math.round(rnd() * 2 - 1);
          if (!inBounds(nx2, ny2)) continue;
          var g2 = state.grid[idx(nx2, ny2)];
          if (g2.soil === 'core' || g2.soil === 'rock') continue;
          g2.soil = 'root';
        }
        break;
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
      pinned: false,       // 玩家锁定：缺水降级时排到最后（取舍的出口）
      trunk: false,        // 主干：吞吐被抬高，产量被下调（玩家手动指定）
      confluence: false,   // 汇流：支流在此合流，吞吐略高、产量略降
      /* 树木状态。只有 soil === 'root' 的节点会用到；
       * 但字段统一放在这里，免得每帧到处判 undefined。 */
      tree: 0,             // 成长度（累计成长点，不是档位）
      treeStage: -1,       // 缓存的档位（-1 = 不是树）
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

    /* 不变量守门：整个引擎（含本函数下面）都按 `state.nodes[id]` 当下标用，
     * 所以「id === 数组下标」必须成立。
     *
     * 唯一会破坏它的是「从中间抽掉节点」。正常路径 removeNode 会自己重排，
     * 但任何手写的结构性改动（自测里直接 splice、将来新加的机制）一旦漏掉
     * 重排，state.nodes[id] 就变成 undefined，然后在几百行之外的计算里炸成
     * 「Cannot read properties of undefined (reading 'prod')」——
     * 报错点与真正的原因相隔极远，曾因此一次性带崩 7 个自测步骤。
     *
     * rebuildNetwork 只在「结构变了」时调用（不是每帧），所以这里花 O(n)
     * 兜一道完全划算：发现错位就压实 + 重排，并同步 nodeAt / grid 两张反查表。 */
    var dirty = false;
    for (i = 0; i < state.nodes.length; i++) {
      if (!state.nodes[i] || state.nodes[i].id !== i) { dirty = true; break; }
    }
    if (dirty) {
      var packed = [];
      for (i = 0; i < state.nodes.length; i++) if (state.nodes[i]) packed.push(state.nodes[i]);
      state.nodes = packed;
      for (i = 0; i < state.nodes.length; i++) state.nodes[i].id = i;
      for (i = 0; i < state.grid.length; i++) state.grid[i].node = null;
      state.nodeAt = [];
      for (i = 0; i < state.nodes.length; i++) {
        var mm = state.nodes[i];
        state.nodeAt[idx(mm.x, mm.y)] = i;
        state.grid[idx(mm.x, mm.y)].node = i;
      }
    }

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
    if (x < _MAP.w - 1) out.push([x + 1, y]);
    if (y > 0) out.push([x, y - 1]);
    if (y < _MAP.h - 1) out.push([x, y + 1]);
    return out;
  }

  function recomputeCapacity(state) {
    var k = 1 + CONFIG.TRANSPORT.capacityPerLevel * state.up.capacity;
    /* 菌株吞吐乘区：运输菌株 capMul 1.55 → 整网吞吐 +55%，
     * 这是它「自身产出低但能把远处东西拉回来」的兑现方式。
     * 直接乘在基础吞吐上（而不是只乘主干），否则它只能在有主干时生效，
     * 前期会显得完全没用。 */
    var smCap = strainMods(state).capMul;
    var cap = CONFIG.TRANSPORT.baseCapacity * k * smCap;
    var TR = CONFIG.TRUNK;
    /* 核心吞吐 = 基础 × 加粗升级 × 主干数加成。
     * 核心是唯一的结构性瓶颈（实测：全网络只有 dist=0 会超载，
     * 途中节点负载率长期 <14%），而核心自己没有等级可以练，
     * 所以「怎么给它扩容」必须由玩家在结构上回答 —— 这正是主干的存在理由。 */
    var tCount = 0;
    for (var q = 1; q < state.nodes.length; q++) if (state.nodes[q].trunk) tCount++;
    var coreCap = CONFIG.TRANSPORT.coreCapacity * k * smCap *
                  (1 + TR.coreCapPerTrunk * tCount);
    for (var i = 0; i < state.nodes.length; i++) {
      var n = state.nodes[i];
      // 强化等级也加粗这根菌丝，所以深耕流靠少量节点也能扛住吞吐
      var lvl = 1 + CONFIG.NODE_UP.capPerLevel * n.level;
      var mul = 1;
      // 主干 / 汇流：沿途吞吐也抬（救局部瓶颈），但产量被反向下调。
      // trunkCapMul 是运输菌株的额外加成 —— 它把「主干」这条线变得更值钱。
      if (n.trunk) mul = TR.trunkCapMul * strainMods(state).trunkCapMul;
      else if (n.confluence) mul = TR.confluenceCapMul;

      // 支流贴着汇流节点：吞吐再加成，奖励「把支流停在汇流点旁」的位置感。
      // 只对普通节点生效 —— 主干/汇流自己已经是通道，不再叠加。
      if (!n.trunk && !n.confluence) {
        var nb = neighbours(n.x, n.y);
        for (var j = 0; j < nb.length; j++) {
          var fid = state.nodeAt[idx(nb[j][0], nb[j][1])];
          if (fid == null) continue;
          if (state.nodes[fid].confluence) { mul *= TR.feederAdjMul; break; }
        }
      }
      n.capacity = (i === 0 ? coreCap : cap) * lvl * mul;
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
    // 速生菌株：自动扩张间隔再打折（更快铺）
    base *= strainMods(state).autoSpeedMul;
    return base;
  }

  /* 距离损耗：越远越不划算，这是「近的低产 vs 远的高产」那个取舍的来源。
   * 菌株 distLossMul 缩放这个损耗：运输菌株 0.55 → 远处几乎不打折（补给线可以拉长），
   * 速生菌株 1.35 → 铺出去就亏（逼玩家把网络压在近处）。
   * 这是「改变网络形状」最直接的一个旋钮。 */
  function transportEfficiency(state, dist) {
    var loss = CONFIG.TRANSPORT.distLoss *
               Math.pow(CONFIG.TRANSPORT.transportDecay, state.up.transport) *
               strainMods(state).distLossMul;
    return 1 / (1 + dist * loss);
  }

  /* 壤土的远距收益递减（见 CONFIG.TOPSOIL_FALLOFF）。
   *
   * 与 transportEfficiency 的分工：
   *   · 本函数 = **产地**本身的增减（壤土越远越贫瘠，近处反而更肥）；
   *   · transportEfficiency = **运路**损耗（产出来了但运不回来）。
   * 两者独立相乘，语义不重复。
   *
   * 返回的是「加减量」（不是乘数）—— 因为需求是让产出**归零并转负**，
   * 只有减法做得到。正值表示近处加成，负值表示远处倒扣。
   *
   * ⚠ 口径（改过两次，别再用错的）：
   *   SOILS.soil.yield.water **保持基准 0.12 不变**，本函数只返回 offset，
   *   最终产出 = base + offset。早期版本曾把 base 置 0 让 offset 等于产出，
   *   那个写法已经废弃 —— 所以**不要**再写「offset(5)===0 就是第 5 格归零」。
   *   正确锚点（用户口径「从核第 N 格」 = 下面形参 dist 的 N−1）：
   *     从核第 1 格 dist 0 产出 0.12 → 第 5 格 dist 4 产出 0 → 第 6 格起转负。
   *   即 offset(dist) = −slope × dist，归零点在 dist = base/slope = 4。
   *
   * 只对 TOPSOIL_FALLOFF.soils 列出的基质生效；其它基质一律返回 0（无影响）。 */
  function topsoilOffset(state, soil, dist) {
    var F = CONFIG.TOPSOIL_FALLOFF;
    if (!F || !F.soils || F.soils.indexOf(soil) < 0) return 0;
    /* 就是一条直线：offset(d) = -slope × d
     *   0 格 0.12 → 1 格 0.09 → … → 4 格 0 → 5 格 -0.03
     * 归零点 = base/slope = 0.12/0.03 = 4 格，也就是用户说的
     * 「从核心数第 5 格」。 */
    var off = -F.slope * dist;
    /* 地板：夹住负值，避免大图上边缘算出巨量倒扣把水池一帧吸干。 */
    if (off < -F.limit) off = -F.limit;
    return off;
  }

  function prodMultiplier(state) {
    return (1 + 0.12 * state.genes.gYield) * strainMods(state).globalMul;
  }

  /* ---------------------------------------------------------------- 菌株
   * 已装备菌株的**合并修正**。
   *
   * 【为什么不每帧现算】computeFlow 每帧要读好几次这些系数（每个节点
   * 一次），如果每次都去 `CONFIG.STRAIN.list.find(...)` 那就是几百次
   * 字符串查找 + 对象遍历。改成「装备变化时重算一次，结果挂 state 上」，
   * 热路径只做属性读取。
   *
   * 【失效点】任何改变装备/解锁的地方都要 invalidateStrain()：
   *   equipStrain / unequipStrain / doPrestige / deserialize / 里程碑 m11。
   *
   * 返回的对象是**新建**的，调用方不要长期持有引用（失效后会换新的）。 */
  function strainMods(state) {
    if (state._strainMods) return state._strainMods;
    /* 先把默认值 copy 一份（必须 copy，不能直接改共享对象） */
    var m = {
      globalMul: 1, distLossMul: 1, capMul: 1, growCostMul: 1,
      nodeYieldMul: 1, trunkCapMul: 1, treeRateMul: 1, auraMul: 1,
      treeBondMul: 1, upkeepMul: 1, autoSpeedMul: 1, offTreeMul: 1,
      soilMul: {}, equipped: []
    };
    var cfg = CONFIG.STRAIN;
    if (!cfg || !cfg.list) { state._strainMods = m; return m; }
    var eq = state.strains || [];
    for (var i = 0; i < eq.length; i++) {
      var s = null;
      for (var j = 0; j < cfg.list.length; j++) {
        if (cfg.list[j].key === eq[i]) { s = cfg.list[j]; break; }
      }
      if (!s) continue;
      m.equipped.push(s.key);
      /* 三种资源的乘区分别累计 —— 用乘法叠加（两个 ×1.2 = ×1.44），
       * 这样多槽位是「共振」而不是「相加」，避免了「带上就赚」的平铺。 */
      if (s.mul) {
        m.resWater = (m.resWater == null ? 1 : m.resWater) * (s.mul.water || 1);
        m.resNutrient = (m.resNutrient == null ? 1 : m.resNutrient) * (s.mul.nutrient || 1);
        m.resSpore = (m.resSpore == null ? 1 : m.resSpore) * (s.mul.spore || 1);
      }
      if (s.distLossMul) m.distLossMul *= s.distLossMul;
      if (s.capMul) m.capMul *= s.capMul;
      if (s.growCostMul) m.growCostMul *= s.growCostMul;
      if (s.nodeYieldMul) m.nodeYieldMul *= s.nodeYieldMul;
      if (s.trunkCapMul) m.trunkCapMul *= s.trunkCapMul;
      if (s.treeRateMul) m.treeRateMul *= s.treeRateMul;
      if (s.auraMul) m.auraMul *= s.auraMul;
      if (s.treeBondMul) m.treeBondMul *= s.treeBondMul;
      if (s.upkeepMul) m.upkeepMul *= s.upkeepMul;
      if (s.autoSpeedMul) m.autoSpeedMul *= s.autoSpeedMul;
      if (s.offTreeMul) m.offTreeMul *= s.offTreeMul;
      /* 基质乘区：同一种基质被多个菌株改到时也相乘 */
      if (s.soilMul) {
        for (var k in s.soilMul) {
          if (!Object.prototype.hasOwnProperty.call(s.soilMul, k)) continue;
          m.soilMul[k] = (m.soilMul[k] == null ? 1 : m.soilMul[k]) * s.soilMul[k];
        }
      }
    }
    if (m.resWater == null) m.resWater = 1;
    if (m.resNutrient == null) m.resNutrient = 1;
    if (m.resSpore == null) m.resSpore = 1;
    state._strainMods = m;
    return m;
  }

  /* 装备变化后必须调一次 —— 把缓存丢掉，下次读取时重算。 */
  function invalidateStrain(state) {
    state._strainMods = null;
  }

  /* 资源乘区（按资源类型取）。热路径用。 */
  function strainResMul(state, res) {
    var m = strainMods(state);
    return res === 'water' ? m.resWater : (res === 'nutrient' ? m.resNutrient : m.resSpore);
  }

  function strainCfg(key) {
    var cfg = CONFIG.STRAIN;
    if (!cfg || !cfg.list) return null;
    for (var i = 0; i < cfg.list.length; i++) {
      if (cfg.list[i].key === key) return cfg.list[i];
    }
    return null;
  }

  /* 当前能带几个菌株。初始 START.strainSlots，m11 再加 1。 */
  function strainSlots(state) {
    var n = CONFIG.START.strainSlots || 1;
    if (state && state.milestones && state.milestones.m11) n += 1;
    n += (state && state.genes && state.genes.gStrain) || 0;   // 预留：基因加槽
    return Math.min(CONFIG.STRAIN.maxSlots || n, n);
  }

  /* 菌株解锁了吗（按菌丝格数）。 */
  function strainsUnlocked(state) {
    var cfg = CONFIG.STRAIN;
    if (!cfg) return false;
    return state.nodes.length >= cfg.unlockNodes ||
           (state.counters && (state.counters.maxNodes || 0) >= cfg.unlockNodes);
  }

  function strainInfo(state, key) {
    var cfg = CONFIG.STRAIN;
    if (!cfg || !cfg.list) return { count: 0, slots: 1, unlocked: false, equipped: [] };
    var eq = state.strains || [];
    return {
      count: cfg.list.length,
      slots: strainSlots(state),
      unlocked: strainsUnlocked(state),
      unlockedAt: cfg.unlockNodes,
      maxNodes: (state.counters && state.counters.maxNodes) || 0,
      equipped: eq.slice()
    };
  }

  /* 装备 / 卸下。返回 {ok, reason}。
   * 槽位满了要先卸一个 —— 这就是「取舍」，不要让调用方自动顶掉别的菌株，
   * 那会让玩家不知道自己带了什么。 */
  function equipStrain(state, key) {
    if (!strainsUnlocked(state)) {
      return { ok: false, reason: '菌丝达到 ' + CONFIG.STRAIN.unlockNodes + ' 格才能选择菌株' };
    }
    if (!strainCfg(key)) return { ok: false, reason: '没有这种菌株' };
    state.strains = state.strains || [];
    if (state.strains.indexOf(key) >= 0) {
      /* 再点一次 = 卸下（按钮是 toggle 语义） */
      return unequipStrain(state, key);
    }
    if (state.strains.length >= strainSlots(state)) {
      return { ok: false, reason: '槽位已满（' + strainSlots(state) + ' 个），先卸掉一个' };
    }
    state.strains.push(key);
    invalidateStrain(state);
    return { ok: true, equipped: state.strains.slice() };
  }

  function unequipStrain(state, key) {
    state.strains = state.strains || [];
    var i = state.strains.indexOf(key);
    if (i < 0) return { ok: false, reason: '没有装备这种菌株' };
    state.strains.splice(i, 1);
    invalidateStrain(state);
    return { ok: true, equipped: state.strains.slice() };
  }

  /* 某个格子的原始产出（不含离核损耗）。
   * 写进调用方给的对象 —— computeFlow 每帧对每个节点都调一次，
   * 不复用的话一帧就是几百次对象分配，GC 会成为主要开销。
   *
   * 菌株在这里接入：`soilMul` 改的是**某种基质**（如腐生菌株让腐木 ×1.85），
   * `strainResMul` 改的是**某种资源**（如运输菌株自身产出全 −28%）。
   * 两者都在 up 加成之后、gYield 之前 —— 顺序不影响乘积，但保持固定顺序
   * 便于以后对账。 */
  function cellYieldInto(state, soil, out) {
    var base = SOILS[soil].yield || {};
    var sm = strainMods(state).soilMul;
    var soilMul = sm[soil];
    if (soilMul == null) soilMul = 1;
    out.water    = (base.water    || 0) * (1 + 0.18 * state.up.hydration)  * soilMul;
    out.nutrient = (base.nutrient || 0) * (1 + 0.18 * state.up.absorption) * soilMul;
    out.spore    = (base.spore    || 0) * (1 + 0.18 * state.up.symbiosis)  * soilMul;
    var m = prodMultiplier(state);
    out.water    *= m * strainResMul(state, 'water');
    out.nutrient *= m * strainResMul(state, 'nutrient');
    out.spore    *= m * strainResMul(state, 'spore');
    return out;
  }

  function cellYield(state, soil) {
    return cellYieldInto(state, soil, emptyVec());
  }

  /* 生长水耗：基质基础价 × 距离加价 × 生长效率折扣 × 菌株折扣
   * 速生菌株 growCostMul 0.62 → 铺一格便宜近四成，所以它能「铺得飞快」，
   * 但它的 distLossMul 1.35 让铺出去的格子产出打折 —— 便宜归便宜，不值钱。 */
  function growCostAt(state, x, y, distToCore) {
    var soil = state.grid[idx(x, y)].soil;
    var base = SOILS[soil].growCost;
    var dist = (distToCore == null) ? 1 : distToCore;
    var cost = base * (1 + CONFIG.GROW.distCost * dist);
    cost *= Math.pow(0.93, state.up.growth);
    cost *= Math.pow(0.94, state.genes.gGrowth);
    cost *= strainMods(state).growCostMul;
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
    /* 树苗从这里开始算成长：种下（接入网络）即为「幼苗」。
     * 档位必须在 put 进 nodes 之前定好初值，否则第一帧 growTrees 会
     * 拿 -1 去比档位、误推一个「幼苗」浮动数字出来。 */
    if (soil === 'root') { nd.tree = 0; nd.treeStage = 0; }
    state.nodes.push(nd);
    state.nodeAt[idx(x, y)] = nd.id;
    state.grid[idx(x, y)].node = nd.id;
    // 里程碑进度（m10）：历史最高节点数 + 历史连上过的基质。
    // 放在 counters 里跨转生保留 —— 转生清空网络不该倒扣成就进度。
    if (state.nodes.length > (state.counters.maxNodes || 0)) state.counters.maxNodes = state.nodes.length;
    if (!state.counters.connectedSoils) state.counters.connectedSoils = {};
    if (soil !== 'core') state.counters.connectedSoils[soil] = 1;
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

  /* 自动蔓延走一步。返回 true 表示「这一拍用掉了」，false 表示「暂时走不动」。
   *
   * 注意返回值语义 —— 这里踩过一个隐蔽的坑：
   * 曾经返回 best（对象）或 null，而 tick 里写的是
   *     if (!autoStep(state)) { state.autoTimer = 0; break; }
   * 于是「长了新节点」= 返回真对象 → 循环继续（正确）
   *     「水不够了」  = 返回 null    → 计时器清零（也正确）
   * 但两种情况共用同一个「假值」出口，且计时器被清零后
   * **每帧都会重新尝试一次**（因为 autoTimer += dt 很快又攒够一拍），
   * 白白跑 60 次/秒的 bestCandidate（每次都要重算全部候选格）。
   * 现在改成显式布尔，失败时才清零。 */
  function autoStep(state) {
    if (!state.autoGrow) return false;
    /* 带 autoOnly：玩家设的规则会在这里生效。
     * 如果规则把候选全过滤掉了，best 为 null → 返回 false → 计时器清零，
     * 行为与「水不够」完全一致（自动蔓延暂停，等条件变化）。 */
    var best = bestCandidate(state, null, true);
    if (!best || best.cost > state.res.water) return false;
    state.res.water -= best.cost;
    addNode(state, best.x, best.y, best.soil);
    return true;
  }

  /* 自动蔓延的两条选址规则（见 CONFIG.AUTORULE）。
   * 返回 true 表示这格「允许自动连」。
   *
   * 关键：**只作用于自动蔓延**。玩家手动点击永远不受限 ——
   * 否则「我就想现在连这块地」会被自己的自动化规则挡住，很恼人。
   * 规则是给「我不在的时候」用的，不是给「我正在操作」用的。 */
  function passAutoRule(state, c) {
    var maxD = state.ruleMaxDist || 0;
    if (maxD > 0 && c.dist > maxD) return false;
    var minY = state.ruleMinYield || 0;
    if (minY > 0) {
      var y = SOILS[c.soil].yield || {};
      var v = (y.water || 0) + (y.nutrient || 0) + (y.spore || 0);
      if (v < minY) return false;
    }
    return true;
  }

  /* 当前策略下最值得长的格子。渲染层用它高亮「推荐格」，玩家手动点它即可 —— 
   * 也是手动操作能比自动更快的原因（自动只能按同一套评分走，玩家可以越过它）。
   *
   * autoOnly=true 时应用玩家的自动蔓延规则（见 passAutoRule）。 */
  function bestCandidate(state, policy, autoOnly) {
    var cs = candidates(state);
    var pol = policy || state.policy;
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < cs.length; i++) {
      if (autoOnly && !passAutoRule(state, cs[i])) continue;
      var s = scoreCandidate(state, cs[i], pol);
      if (s > bestScore) { bestScore = s; best = cs[i]; }
    }
    return best;
  }

  /* ------------------------------------------------------------- 感知范围 */
  /* 顺手维护「已探明包围盒」—— 渲染层做视野取景要用，全图扫描太贵。
   * 同时记录见过的基质类型 —— m10「探索到全部 4 种特殊基质」要用，
   * O(1) 查询而不是每次全图扫（checkMilestones 每个 tick 都会跑）。 */
  function markKnown(state, x, y) {
    var c = state.grid[idx(x, y)];
    var e = state.explored;
    if (!c.known) { c.known = true; e.count++; }
    if (x < e.minX) e.minX = x;
    if (x > e.maxX) e.maxX = x;
    if (y < e.minY) e.minY = y;
    if (y > e.maxY) e.maxY = y;
    state.knowledge[x + ',' + y] = 1;
    if (c.soil !== 'soil' && c.soil !== 'core') state.discoveredSoils[c.soil] = 1;
  }

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
          markKnown(state, x, y);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- 树木 */
  /* 规则见 CONFIG.TREE 的注释。要点：树不是「更肥的格子」——
   * 它随连接时长成长，古树给周围加成，而过度围拢会压住它的成长。 */
  function isTree(nd) { return nd && nd.soil === 'root'; }

  /* 成长点 → 档位（0 幼苗 / 1 成年 / 2 古树） */
  function treeStageOf(growth) {
    var at = CONFIG.TREE.stageAt;
    var st = 0;
    for (var i = 1; i < at.length; i++) if (growth >= at[i]) st = i;
    return st;
  }

  var TREE_STAGE_NAME = ['幼苗', '成年', '古树'];

  /* 树周围 2 格内的菌丝数（不含自己）。
   * 它是「过度索取」的度量：围着它的菌丝越多，地下养分被分得越薄。 */
  function treeCrowd(state, nd) {
    var R = CONFIG.TREE.ringRadius;
    var n = 0, x, y, id;
    for (var dy = -R; dy <= R; dy++) {
      for (var dx = -R; dx <= R; dx++) {
        if (!dx && !dy) continue;
        if (Math.abs(dx) + Math.abs(dy) > R + 1) continue;   // 圆一点，别用方框
        x = nd.x + dx; y = nd.y + dy;
        if (x < 0 || y < 0 || x >= _MAP.w || y >= _MAP.h) continue;
        id = state.nodeAt[idx(x, y)];
        if (id != null) n++;
      }
    }
    return n;
  }

  /* 这一格是否被某棵古树的光环覆盖（用于产出加成，也用于 UI 显示）。
   * 返回 true/false —— auraStack 为 false 时不累乘，所以不需要计数。 */
  function underOldTreeAura(state, nd) {
    if (!nd || isTree(nd)) return false;              // 树自己不吃光环
    var R = CONFIG.TREE.ringRadius;
    for (var dy = -R; dy <= R; dy++) {
      for (var dx = -R; dx <= R; dx++) {
        if (!dx && !dy) continue;
        if (Math.abs(dx) + Math.abs(dy) > R + 1) continue;
        var x = nd.x + dx, y = nd.y + dy;
        if (x < 0 || y < 0 || x >= _MAP.w || y >= _MAP.h) continue;
        var id = state.nodeAt[idx(x, y)];
        if (id == null) continue;
        var t = state.nodes[id];
        if (isTree(t) && t.treeStage >= 2) return true;
      }
    }
    return false;
  }

  /* 每帧推进所有树的成长。放进 tick，不放 computeFlow ——
   * computeFlow 只该算流量，改状态会让它变得不可重入。 */
  function growTrees(state, dt) {
    var T = CONFIG.TREE;
    /* 共生菌株的 treeRateMul：整片林子长快 2.2 倍。
     * 这是「把树当核心资产」的直接兑现 —— 普通玩家要等 3 分钟出古树，
     * 共生菌株 80 秒就有，于是「围着树建群落」从长期投资变成当期战力。 */
    var rateMul = strainMods(state).treeRateMul;
    for (var i = 1; i < state.nodes.length; i++) {
      var nd = state.nodes[i];
      if (!isTree(nd)) continue;
      if (nd.dist < 0) continue;                      // 未接入网络（异常态）

      var crowd = treeCrowd(state, nd);
      var over = Math.max(0, crowd - T.crowdSoftCap);
      /* rate = 每秒成长点变化。
       * rate >= 0 → 正常成长（越多菌丝围着越慢）；
       * rate <  0 → 倒退，退速 = min(|rate|, decayPerSec)。
       *
       * 这里踩过一次 min/max 的坑，值得记下来：
       * 第一版写成 `Math.min(-rate, decayPerSec)`，本意是「退速别太猛」
       * —— 但 min 把 |rate| 往下压，rate = -3.9 时退速被压到 0.25/秒，
       * 于是古树被围满后 240 秒只退到 120，**卡在档位线上不动**，
       * 看着像「树被围住后完全没反应」，和「围满会让树退化」的承诺相反。
       * 想要的语义是「退速至少 decayPerSec，且随 over 加快」——
       * 那是对 |rate| 取 **max**，decayPerSec 是**下限**不是上限。 */
      var rate = 1 - over * T.crowdPenalty;
      if (rate >= 0) {
        /* rateMul 只放大正成长，不放大倒退 ——
         * 否则共生菌株在「树被围死」时反而退得更快，与「专精养树」的
         * 承诺相反（玩家会觉得带了它更容易把树养坏）。 */
        nd.tree = Math.min(T.stageAt[T.stageAt.length - 1], nd.tree + rate * rateMul * dt);
      } else {
        var back = Math.max(-rate, T.decayPerSec);     // 每秒退多少，下限 decayPerSec
        nd.tree = Math.max(0, nd.tree - back * dt);
      }

      var st = treeStageOf(nd.tree);
      if (st !== nd.treeStage) {
        nd.treeStage = st;
        /* 档位变化推个浮动数字，玩家能看见「我的树长大了」——
         * 这是养成类反馈的核心，不给反馈等于没有养成。 */
        pushFloater(state, nd.x, nd.y, TREE_STAGE_NAME[st], st > 0 ? 'good' : 'warn');
      }
    }
  }

  /* 该节点当前的树木产出倍率（非树 → 1） */
  function treeYieldMulOf(nd) {
    if (!isTree(nd)) return 1;
    var st = (nd.treeStage == null || nd.treeStage < 0) ? treeStageOf(nd.tree || 0) : nd.treeStage;
    return CONFIG.TREE.yieldMul[Math.min(st, CONFIG.TREE.yieldMul.length - 1)];
  }

  function treeStageNameOf(st) {
    return TREE_STAGE_NAME[Math.max(0, Math.min(st, TREE_STAGE_NAME.length - 1))];
  }

  /* 给 UI 用的一次性快照：树的档位、进度、周围的菌丝数、成长是否被压住。
   * 集中算一次，避免 UI 层自己拼 treeCrowd / treeStageOf 而算错口径。 */
  function treeStateOf(state, nd) {
    if (!isTree(nd)) return null;
    var T = CONFIG.TREE;
    var growth = nd.tree || 0;
    var st = treeStageOf(growth);
    var crowd = treeCrowd(state, nd);
    var over = Math.max(0, crowd - T.crowdSoftCap);
    var top = T.stageAt[T.stageAt.length - 1];
    return {
      growth: growth,
      stage: st,
      stageName: TREE_STAGE_NAME[Math.min(st, TREE_STAGE_NAME.length - 1)],
      crowd: crowd,
      softCap: T.crowdSoftCap,
      over: over,
      rate: 1 - over * T.crowdPenalty,         // 每秒成长点，负数代表倒退
      stalled: over > 0,
      maxed: st >= T.stageAt.length - 1,
      /* 距离下一档还差多少进度（0~1）；已是最高档 → 1 */
      progress: st >= T.stageAt.length - 1
        ? 1
        : (growth - T.stageAt[st]) / (T.stageAt[st + 1] - T.stageAt[st]),
      yieldMul: treeYieldMulOf(nd),
      cap: top
    };
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
    /* 菌株修正取一次放在循环外 —— strainMods 有缓存，但每帧每节点都调一次
     * 仍是白白的函数调用开销。它是「装备变化时重算」的只读快照，
     * 循环内不会再变，所以提出来是安全的。 */
    var sm = strainMods(state);
    /* 壤土递减的全网合计（只看原始加减量，不含等级/树/光环乘区）。
     * 面板要用它显示「壤土一共拖了多少水」—— 玩家在近核处看到
     * 产量正常、却感觉不到远处那几十格在偷偷扣水，所以必须有一个
     * 全局数字把这件事说破。同时记下受影响的格数，便于文案写「N 格」。 */
    var topsoilOff = 0, topsoilCells = 0;
    for (i = 0; i < state.nodes.length; i++) {
      nd = state.nodes[i];

      // prod / through 每帧都写，直接复用节点上的对象，不重新分配
      var prod = nd.prod || (nd.prod = emptyVec());

      if (nd.soil === 'core') {
        _raw.water = state.seepRate || CONFIG.START.seep;
        _raw.nutrient = 0; _raw.spore = 0;
      } else {
        cellYieldInto(state, nd.soil, _raw);
        /* 壤土的远距收益递减：近处加成、远处倒扣、5 格正好归零。
         * 放在 cellYieldInto 之后、等级倍率之前 —— 于是这块加减量
         * 会被等级/树/光环等乘区一起放大，玩家「练这一格」仍然有意义
         * （把负的练得没那么负，把正的练得更正）。
         *
         * 写在 spore 代谢**之前**：壤土只产水，偏移也只加在水上，
         * 不会碰那 0.010 的网络代谢（它是每格固定收益，不该被壤土规则影响）。 */
        var off = topsoilOffset(state, nd.soil, Math.max(0, nd.dist));
        if (off !== 0) {
          if (CONFIG.TOPSOIL_FALLOFF.resource === 'water') _raw.water += off;
          else if (CONFIG.TOPSOIL_FALLOFF.resource === 'nutrient') _raw.nutrient += off;
          else if (CONFIG.TOPSOIL_FALLOFF.resource === 'spore') _raw.spore += off;
          topsoilOff += off; topsoilCells++;
        }
      }
      // 网络代谢：每个节点都产一点孢子，所以规模本身就是孢子来源，
      // 树根只是加速器。这样扩张永远有收益。
      _raw.spore += met;

      // 强化等级：这是「深耕流」落到单个节点上的收益。
      // 腐生菌株的 nodeYieldMul 让它更值钱（鼓励「少而肥」）。
      var lvlMul = 1 + CONFIG.NODE_UP.yieldPerLevel * nd.level * sm.nodeYieldMul;
      _raw.water    *= mods.water    * lvlMul;
      _raw.nutrient *= mods.nutrient * lvlMul;
      _raw.spore    *= mods.spore    * lvlMul;

      /* 树木：自身档位倍率（幼苗 0.6 / 成年 1.0 / 古树 1.6）。
       * 这是「养成」的直接兑现 —— 同一棵树，连上去放着不动，
       * 三分钟后它产的孢子就比刚连上时多一倍多。
       * 共生菌株的 treeBondMul 让「绑在树上的产出」更强。 */
      if (nd.soil === 'root') {
        var tm = treeYieldMulOf(nd) * sm.treeBondMul;
        _raw.water *= tm; _raw.nutrient *= tm; _raw.spore *= tm;
      }
      /* 古树光环：周围 2 格内的**其它**菌丝吃加成。
       * 这是本系统里唯一「靠布局而非数值」的产出来源 ——
       * 想吃到它就得把网络修到古树旁边，而不是把古树本身练高。
       * auraMul 是共生菌株的核心：光环 1.55 倍后，围着古树铺才是正解。 */
      if (underOldTreeAura(state, nd)) {
        var am = CONFIG.TREE.auraYieldMul * sm.auraMul;
        _raw.water    *= am;
        _raw.nutrient *= am;
        _raw.spore    *= am;
      }
      /* 共生菌株的**代价**：离开树（既不是树、也不在古树光环内）
       * 就变弱。这条是「改变网络形状」最强的一笔 ——
       * 玩家会把网络长成一簇簇围着树，而不是均匀铺开。 */
      if (sm.offTreeMul !== 1 && nd.soil !== 'root' && nd.soil !== 'core' &&
          !underOldTreeAura(state, nd)) {
        _raw.water *= sm.offTreeMul; _raw.nutrient *= sm.offTreeMul; _raw.spore *= sm.offTreeMul;
      }

      // 降雨带 / 孢子季：站进增益区就多产，鼓励「追着事件扩张」
      var bf = buffAt(state, nd.x, nd.y);
      if (bf) {
        _raw.water *= bf.water; _raw.nutrient *= bf.nutrient; _raw.spore *= bf.spore;
      }

      // 主干 / 汇流的代价：节点被改造成通道，自身产出下降。
      // 这一项是「选哪一格当主动脉」真正有张力的原因 ——
      // 拿富矿当主干会白白浪费它的高产，玩家得在「运力」和「产地」之间权衡。
      if (nd.trunk) {
        _raw.water *= CONFIG.TRUNK.trunkYieldMul;
        _raw.nutrient *= CONFIG.TRUNK.trunkYieldMul;
        _raw.spore *= CONFIG.TRUNK.trunkYieldMul;
      } else if (nd.confluence) {
        _raw.water *= CONFIG.TRUNK.confluenceYieldMul;
        _raw.nutrient *= CONFIG.TRUNK.confluenceYieldMul;
        _raw.spore *= CONFIG.TRUNK.confluenceYieldMul;
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
    /* 壤土递减汇总：原始量（未乘等级/树/光环）与受影响格数。
     * 面板拿它显示「壤土 N 格 −X/s」—— 这是「机制确实生效了」最直接的证据。 */
    state.topsoilOffset = topsoilOff;
    state.topsoilCells = topsoilCells;
    return accepted;
  }

  /* ------------------------------------------------------- 维护耗水与降级 */
  /* 维持费 = 等级^exponent × costPerLevel（每秒）。
   *
   * 只挂等级不挂节点数：挂节点数会变成「扩张惩罚」（和扩张永远有收益冲突），
   * 只挂等级则维持费正比于「投入的深度」——
   * 练得越狠后期压力越大，这正是「深耕流」该有的代价。
   *
   * **必须超线性**：线性时维持费只看等级总和，「10 个 Lv10」和「100 个 Lv1」
   * 成本完全相同 —— 而摊薄能抗降级（一次掉 1 级且分散），深耕一掉掉一片，
   * 于是理性玩家必然摊平，深耕被系统性惩罚。平方后集中/摊薄 = 10×，
   * 深耕才有真代价。完整推导见 config.MAINT 的注释。 */
  function maintainCostOf(state, nd) {
    var lv = nd.level || 0;
    if (lv <= 0) return 0;
    var e = CONFIG.MAINT.exponent;
    /* exponent 必须 ≥ 1：< 1 会让成本凹向下，「摊薄比深耕还贵」，
     * 整个取舍反了。config 的注释说得很清楚但没人拦得住改参数的人。 */
    if (!(e >= 1)) e = 2;
    /* e = 2 是最常见的情形，直接乘比 Math.pow 快 —— 这个函数每个 tick
     * 会对每个节点调用一次，大地图上就是几千次/秒。 */
    var base = (e === 2) ? lv * lv : Math.pow(lv, e);
    return base * CONFIG.MAINT.costPerLevel;
  }

  function totalMaintainCost(state) {
    var sum = 0;
    for (var i = 0; i < state.nodes.length; i++) sum += maintainCostOf(state, state.nodes[i]);
    /* 菌株维护费乘区。它是「压制过强菌株」的负项：
     * 速生菌株铺得最快，所以它的 upkeepMul 1.10 让「无脑铺满」多付一成水费 ——
     * 铺得越多越明显，正好抵消它铺得快的优势，把玩法推向「快但有选择」。
     * 乘在总费上（不是 per-node），因为要惩罚的是**规模**。 */
    return sum * strainMods(state).upkeepMul;
  }

  /* 降级的候选顺序：**离核最远的先降**。
   * 这是玩家明确要的语义（「离中心远的就先降级」），也把「位置」
   * 从「只是运输损耗」提升成「占着就有成本」—— 想维持远处的富矿，
   * 就得沿路多留水。
   *
   * 顺序（先降谁）：
   *   ① 玩家**没锁定**的节点优先降 —— 这是玩家的取舍出口：
   *      他挑出要紧的节点锁住，其余交给系统按距离砍。
   *   ② 同锁定状态下，远的先降。
   *   ③ 同距离时等级高的先降 —— 一次降级省下的维持费最多，效率最高。
   */
  function downgradeOrder(state) {
    var out = [];
    for (var i = 1; i < state.nodes.length; i++) {          // 跳过核心
      var nd = state.nodes[i];
      if (nd.level > 0 && nd.dist >= 0) out.push(nd);
    }
    out.sort(function (a, b) {
      var al = a.pinned ? 1 : 0, bl = b.pinned ? 1 : 0;
      if (al !== bl) return al - bl;                        // 没锁的先降
      if (b.dist !== a.dist) return b.dist - a.dist;        // 远的优先
      return b.level - a.level;                             // 同距先降高等级
    });
    return out;
  }

  /* 锁定 / 解锁一个节点（玩家的取舍开关）。
   * 锁定的节点排在降级序列最末 —— 只要还有没锁的可降，就不动它。
   * 注意：**锁不是永久免疫**。如果只剩下锁定节点可降（水实在太少），
   * 它照样会掉级 —— 否则「锁住一切」就成了绕开机制的漏洞。 */
  function togglePin(state, nodeId) {
    var nd = state.nodes[nodeId];
    if (!nd) return { ok: false, reason: '这里没有菌丝' };
    if (nd.id === 0) return { ok: false, reason: '核心不能锁定' };
    nd.pinned = !nd.pinned;
    return { ok: true, pinned: nd.pinned };
  }

  function pinnedCount(state) {
    var n = 0;
    for (var i = 1; i < state.nodes.length; i++) if (state.nodes[i].pinned) n++;
    return n;
  }

  /* ----------------------------------------------------- 主干 / 汇流标记 */
  /* 设计要点：这两个标记是**互斥**的（一格不能既是主动脉又是合流口），
   * 且各自有硬上限。上限不是平衡旋钮，是设计承诺 ——
   * 「少到必须取舍」才是这个机制存在的理由，调高它等于把机制删掉。 */
  function trunkCount(state) {
    var n = 0;
    for (var i = 1; i < state.nodes.length; i++) if (state.nodes[i].trunk) n++;
    return n;
  }

  function confluenceCount(state) {
    var n = 0;
    for (var i = 1; i < state.nodes.length; i++) if (state.nodes[i].confluence) n++;
    return n;
  }

  /* 切换主干标记。返回 { ok, trunk, reason } —— UI 与测试都靠 reason 给提示。 */
  function toggleTrunk(state, nodeId) {
    var nd = state.nodes[nodeId];
    if (!nd) return { ok: false, reason: '这里没有菌丝' };
    if (nd.id === 0) return { ok: false, reason: '核心本身就是主干' };
    if (nd.trunk) {                              // 取消：永远允许
      nd.trunk = false;
      recomputeCapacity(state);
      return { ok: true, trunk: false, free: CONFIG.TRUNK.maxTrunk - trunkCount(state) };
    }
    if (nd.confluence) return { ok: false, reason: '它已经是汇流节点了，先取消汇流' };
    var used = trunkCount(state);
    if (used >= CONFIG.TRUNK.maxTrunk) {
      return { ok: false, reason: '主干已达上限 ' + CONFIG.TRUNK.maxTrunk + ' 格，先取消一条' };
    }
    nd.trunk = true;
    recomputeCapacity(state);
    return { ok: true, trunk: true, free: CONFIG.TRUNK.maxTrunk - trunkCount(state) };
  }

  function toggleConfluence(state, nodeId) {
    var nd = state.nodes[nodeId];
    if (!nd) return { ok: false, reason: '这里没有菌丝' };
    if (nd.id === 0) return { ok: false, reason: '核心不用做汇流' };
    if (nd.confluence) {
      nd.confluence = false;
      recomputeCapacity(state);
      return { ok: true, confluence: false, free: CONFIG.TRUNK.maxConfluence - confluenceCount(state) };
    }
    if (nd.trunk) return { ok: false, reason: '它已经是主干节点了，先取消主干' };
    var used = confluenceCount(state);
    if (used >= CONFIG.TRUNK.maxConfluence) {
      return { ok: false, reason: '汇流已达上限 ' + CONFIG.TRUNK.maxConfluence + ' 格，先取消一个' };
    }
    nd.confluence = true;
    recomputeCapacity(state);
    return { ok: true, confluence: true, free: CONFIG.TRUNK.maxConfluence - confluenceCount(state) };
  }

  /* 统计紧贴某个汇流节点的「支流」数量 —— 只用于 UI 提示。 */
  function feederCount(state, nd) {
    if (!nd || !nd.confluence) return 0;
    var n = 0, nb = neighbours(nd.x, nd.y);
    for (var j = 0; j < nb.length; j++) {
      var fid = state.nodeAt[idx(nb[j][0], nb[j][1])];
      if (fid == null) continue;
      var f = state.nodes[fid];
      if (!f.trunk && !f.confluence) n++;
    }
    return n;
  }

  /* 该节点是否吃到「贴着汇流」的加成 —— 用于 UI 显示，与 recomputeCapacity
   * 里的判定必须完全一致，否则玩家看到的数字跟实际吞吐会对不上。 */
  function adjacentConfluence(state, nd) {
    if (!nd || nd.trunk || nd.confluence) return false;
    var nb = neighbours(nd.x, nd.y);
    for (var j = 0; j < nb.length; j++) {
      var fid = state.nodeAt[idx(nb[j][0], nb[j][1])];
      if (fid == null) continue;
      if (state.nodes[fid].confluence) return true;
    }
    return false;
  }

  /* 结算维持费。逻辑：
   *   ① 正常扣水；
   *   ② 水量低于「维持费 × bufferSec」的缓冲线 → 开始降级；
   *   ③ 降级速度**与缺水程度成正比**（见下），远的先降（锁定的最后）；
   *   ④ 水不许变成负数 —— 真见底就归零，缺口由降级补上。
   *
   * 降级**只减等级、绝不移除节点**（守住「绝不永久损失」底线）。
   * 降级的代价不在水里，而在「产出和吞吐掉回上一级」——
   * 所以它读起来是「你维持不起了，撤回一部分投资」，而不是「系统罚你」。
   *
   * 【为什么降级速度要按缺水程度缩放】
   * 早期版本用的是固定配额（每秒固定降 3 级），实测发现一个致命问题：
   * 等级总和稳定在 ~200 且**几乎不随 costPerLevel 变化**
   * （k 从 1 涨到 12，累计降级次数始终 ~4700）——
   * 因为瓶颈不是水量，而是那个固定配额：玩家练 1 级立刻被砍掉，
   * 「一练就掉」，等级永远堆不起来。提高 k 完全无效。
   *
   * 改成按缺水程度缩放后：
   *   · 刚好低于缓冲线 → 极慢地降（几乎察觉不到，玩家有时间反应）
   *   · 严重缺水 → 快速降（真的养不起就干脆利落地收缩）
   * 这样「能维持多少等级」才真正由水收支决定 ——
   * 即由 costPerLevel 决定，k 才成为一个有意义的旋钮。
   */
  /* 核心渗水/秒（含「渗透」基因加成）。
   * 抽成函数是因为它有**两个**调用方：tick 里的每帧刷新，
   * 以及离线结算的「早期下限」。写成两处字面量迟早会不同步 ——
   * 离线那边的下限会悄悄用错值，而且很难测出来。 */
  function coreSeep(state) {
    return CONFIG.START.seep + (state.genes && state.genes.gRate || 0) * 0.4;
  }

  /* ------------------------------------------------------------ 离线收益
   * 从「上次存档的时间戳」算到「现在」，给玩家一段折算后的产出。
   *
   * 这里**不跑模拟**。8 小时 = 28800 秒，按 0.25 秒一步是 11.5 万次 tick，
   * 每次 tick 要遍历所有节点 —— 上万节点时会把页面卡死好几秒。
   * 离线期间没有玩家操作，网络速率本来就是稳定的，
   * 所以直接「瞬时速率 × 时长 × 效率系数」折算，这也是放置游戏的标准做法。
   *
   * 返回 {seconds, capped, gained} 或 null（不足最短时长 / 无配置）。
   * gained 是**实际发放**的三项资源。 */
  function settleOffline(state, awaySec, opts) {
    var cfg = CONFIG.OFFLINE;
    if (!cfg) return null;
    if (!isFinite(awaySec) || awaySec < cfg.minSeconds) return null;

    var capSec = cfg.capHours * 3600;
    var useSec = Math.min(awaySec, capSec);

    /* 结算前先把速率算准 —— 入口是刚读档，state.rate 可能是存档里的旧值
     * （甚至是 undefined）。跑一次零步长的 computeFlow 只算速率不推进时间。
     * 为什么不直接用 state.rate：读档后节点等级/菌株都刚恢复，
     * 缓存里的 rate 属于「上一帧」的，直接用会偏。 */
    computeFlow(state, 0);

    /* 早期下限：玩家还没解锁自动蔓延时，网络不会自己长，
     * 但「核心渗水」一直存在。用 max(当前速率, 核心渗水 × 系数) 兜底，
     * 保证回来永远有反馈 —— 见 config 里 OFFLINE 的第 ② 条约束。
     * 注意水是唯一有「无条件来源」的资源（核心渗水），
     * 养分/孢子没有核心来源，没有下限可给，这也符合直觉：
     * 没铺开就没养分。 */
    var rate = state.rate || { water: 0, nutrient: 0, spore: 0 };
    var floorWater = coreSeep(state) * (cfg.coreFloorMul || 1);

    var eff = cfg.offlineEff;
    var gained = {
      water:    Math.max(rate.water, floorWater) * useSec * eff,
      nutrient: Math.max(rate.nutrient, 0)      * useSec * eff,
      spore:    Math.max(rate.spore, 0)         * useSec * eff
    };

    /* opt.dryRun：只算不发。headless_sim 的对照实验要用它，
     * 免得真发钱把后面的对照跑歪。 */
    if (!opts || !opts.dryRun) {
      state.res.water    += gained.water;
      state.res.nutrient += gained.nutrient;
      state.res.spore    += gained.spore;
      state.total.water    += gained.water;
      state.total.nutrient += gained.nutrient;
      state.total.spore    += gained.spore;
      state.offline = {
        seconds: useSec, capped: awaySec > capSec,
        real: awaySec, gained: gained, at: Date.now()
      };
    }
    return { seconds: useSec, capped: awaySec > capSec, real: awaySec, gained: gained };
  }

  function settleMaintenance(state, dt) {
    var cost = totalMaintainCost(state);
    if (cost <= 0) {
      state.maintainCost = 0; state.maintainPressure = false;
      state.maintainQuota = 0;
      return 0;
    }

    state.maintainCost = cost;
    state.res.water -= cost * dt;

    var buffer = cost * CONFIG.MAINT.bufferSec;
    var downgraded = 0;

    if (state.res.water < buffer) {
      /* 缺水程度 0~1：刚好碰到缓冲线 → 0；水见底 → 1。 */
      var deficit = (buffer - state.res.water) / Math.max(1e-6, buffer);
      if (deficit > 1) deficit = 1;
      /* 缩放系数：最低 0.15（碰到线就开始缓慢收缩，不至于无限期不动），
       * 完全见底时放大到 3 倍基准速度。 */
      var scale = 0.15 + deficit * deficit * 2.85;
      var quota = CONFIG.MAINT.downgradePerSec * scale * dt;

      /* 配额不足 1 级时不能白扔 —— 攒起来。
       *
       * 为什么必须有这个累加器：浏览器以 60fps 跑，单帧 dt ≈ 0.0167。
       * 轻度缺水时 quota ≈ 0.45 * 0.0167 ≈ 0.0075 级/帧，
       * 恒定小于 1 —— 如果直接丢掉，降级永远不会发生，
       * 「碰到缓冲线就开始缓慢收缩」就成了空话（实际表现是彻底卡住不动）。
       * 累积到 1 级再一次性降，等价于「平均每秒降 scale×perSec 级」，
       * 既保住了缓慢的手感，也保住了「确实在收缩」的语义。 */
      state.maintainQuota = (state.maintainQuota || 0) + quota;
      var budget = Math.floor(state.maintainQuota + 1e-9);   // 吸收浮点误差

      var order = downgradeOrder(state);
      /* 预算制循环：`downgraded + 1 <= budget` 而不是 `downgraded < quota`。
       *
       * 差别在配额 < 1 时的行为，非常关键：
       *   budget = 0（轻度缺水）时，若写成 `downgraded < quota`，
       *   第一次判断 0 < 0.45 成立 → 降 1 级 ——
       *   于是**任何非零配额都至少降 1 级**，降级速度在低端被量化成
       *   固定每秒 1 级，缩放完全失效，玩家看到的是「刚开始缺水就猛地掉级」。
       *   改成预算制后：budget=0 一次都不降；budget=1 最多降 1 级。
       *
       * 实测踩过：quota 精确等于 1.0 时旧写法会降 2 级
       * （浮点误差让它算成 1.0000000000000002，撑过了第二次比较）。 */
      for (var i = 0; i < order.length && downgraded + 1 <= budget; i++) {
        var nd = order[i];
        if (nd.level <= 0) continue;
        nd.level -= 1;
        downgraded++;
      }
      state.maintainQuota -= downgraded;
      /* 保护：满级节点全降完了但配额还在攒（没东西可降），
       * 累加器不该无限膨胀 —— 夹在 1 级以内，恢复供水的瞬间
       * 才不会突然雪崩式连降。 */
      if (state.maintainQuota > 1) state.maintainQuota = 1;
      if (downgraded > 0) {
        state.counters.maintainDowngrades = (state.counters.maintainDowngrades || 0) + downgraded;
        recomputeCapacity(state);
      }
    }

    state.maintainPressure = downgraded > 0 || state.res.water < 0;
    /* 水不许变成负数：真见底就归零。
     * 欠账不用「水」结算，它直接体现为下一 tick 仍然在降级 ——
     * 玩家永远看不到负数水量，也永远不会因为一次扣款而瞬间崩掉网络。 */
    if (state.res.water < 0) state.res.water = 0;
    return downgraded;
  }

  /* ------------------------------------------------------------ 拆除节点 */
  /* 玩家主动收缩网络（或腾出树周围的空间）时用。
   *
   * 这是**唯一**会缩短 nodes 数组的操作，所以最容易踩到「id === 下标」
   * 这个不变量（makeNode 的注释里记着早期被它坑过一次）。做法很直白：
   * 物理移除后把所有 id 重排一遍，并同步 nodeAt / grid 两处反查表。
   * 节点总数在几百量级，O(n) 重排完全够用，不值得为它引入空洞与回收池。
   *
   * 核心节点不可拆 —— 拆了整张网络就没了。
   * 主干 / 汇流可以拆，配额会自动退回（计数是现数出来的，没有独立账本）。 */
  function removeNode(state, nodeId) {
    var i = nodeId;
    if (i <= 0 || i >= state.nodes.length) return { ok: false, reason: '没有这个节点' };
    var nd = state.nodes[i];
    if (nd.soil === 'core') return { ok: false, reason: '核心无法拆除' };

    state.nodes.splice(i, 1);
    for (var k = 0; k < state.nodes.length; k++) state.nodes[k].id = k;
    for (var g = 0; g < state.grid.length; g++) state.grid[g].node = null;
    state.nodeAt = [];
    for (var j = 0; j < state.nodes.length; j++) {
      var m = state.nodes[j];
      state.nodeAt[idx(m.x, m.y)] = j;
      state.grid[idx(m.x, m.y)].node = j;
    }
    rebuildNetwork(state);
    reveal(state);
    return { ok: true, x: nd.x, y: nd.y, soil: nd.soil };
  }

  /* ---------------------------------------------------------------- 主循环 */
  function tick(state, dt) {
    state.t += dt;
    state.seepRate = coreSeep(state);

    // 技能冷却与「菌丝脉冲」计时
    for (var k in state.cd) if (state.cd[k] > 0) state.cd[k] = Math.max(0, state.cd[k] - dt);
    if (state.pulseT > 0) state.pulseT = Math.max(0, state.pulseT - dt);

    computeFlow(state, dt);

    // 维护耗水：菌丝的持续成本。缺水时远端先降级（见 settleMaintenance）
    settleMaintenance(state, dt);

    /* 树木成长：放在维护之后、自动蔓延之前。
     * 顺序有意义 —— 自动蔓延可能立刻连上新的树/或把某棵树围得更密，
     * 那要算进下一帧的 crowding，不该让它「刚长出来就被本帧的围拢惩罚」。
     * 注意它必须在 computeFlow **之后**：本帧产出用的是上一帧的档位，
     * 这样同一帧内产出与展现是自洽的（不会出现「产出按新档位算、
     * 但画面上还是旧档位」的抖动）。 */
    growTrees(state, dt);

    // 自动蔓延
    var interval = autoIntervalOf(state);
    state.autoTimer += dt;
    while (state.autoTimer >= interval) {
      if (!autoStep(state)) { state.autoTimer = 0; break; }
      state.autoTimer -= interval;
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
    for (var i = 1; i < state.nodes.length; i++) {
      var nd = state.nodes[i];
      if (!nd.gnat && !nd.blighted) out.push(i);
    }
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
    var cfg = CONFIG.EVENTS, cfgB = CONFIG.BLIGHT;
    var ev = null;

    // 害虫：前期的小麻烦，网络有规模后才出现
    if (state.nodes.length >= 20 && countGnats(state) < cfg.gnatMax && stateRng(state) < 0.4) {
      var pool = freeNodeIds(state);
      if (pool.length) ev = putGnat(state, pool[Math.floor(stateRng(state) * pool.length)]);
    } else if (state.nodes.length >= cfgB.minNodes &&
               countBlights(state) < blightMaxCount(state) &&
               stateRng(state) < cfgB.spawnChance) {
      // 菌瘟：后期的真威胁，会蔓延 —— 这是「后期像腹泻」的解药
      ev = spawnBlight(state);
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
    var cfg = CONFIG.EVENTS, cfgB = CONFIG.BLIGHT, i, e;

    // 快照遍历：spreadBlights 熄灭菌瘟时会 splice 原数组 —— 直接遍历它的话，
    // 一晚熄灭多处会让 events[i] 变 undefined（平衡模拟实测炸过）。
    // 快照里看到已熄灭的事件也无害：spreadBlights 对 !nd.blighted 直接跳过。
    var events = state.events.slice();
    var dead = [];
    for (i = events.length - 1; i >= 0; i--) {
      e = events[i];
      if (!e) continue;
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
      } else if (e.kind === 'blight') {
        // 菌瘟没有无条件自愈：每 spreadInterval 尝试一次传播，
        // 传得出去就一直活着；连续 failLimit 个周期一个邻居都传不进去
        // （被防火墙围死）才熄灭 —— 熄灭判定在 spreadBlights 里做。
        e.spreadT -= dt;
        if (e.spreadT <= 0) {
          e.spreadT = cfgB.spreadInterval * (state.mods.blightSlow ? 1.6 : 1);
          spreadBlights(state);
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

  /* ---- 菌瘟（后期挑战）------------------------------------------------
   * 与害虫的差别只有一个：**会沿着菌丝蔓延**。
   * 害虫随机冒出来，菌瘟从网络边缘往核心爬 —— 于是「先处理哪一处、
   * 要不要放着让它烂」变成了真正的空间决策。
   * 底线不变：被围死就熄灭、节点保留，绝不造成永久损失（见 config.BLIGHT）。 */
  function countBlights(state) {
    var n = 0;
    for (var i = 0; i < state.events.length; i++) if (state.events[i].kind === 'blight') n++;
    return n;
  }

  /* 同时最多几处：随转生次数放宽一点，但封顶 —— 永远不会把网络掏空 */
  function blightMaxCount(state) {
    return Math.min(CONFIG.BLIGHT.maxCount, 3 + Math.floor(state.prestiges * 1.5));
  }

  function blightableNodeIds(state) {
    /* 初次滋生：不会碰 Lv(immuneLevel)+ 的菌 —— 深耕练出来的高等级节点
     * 是安全的（强化 = 产能 + 吞吐 + 抗瘟）。 */
    var maxL = CONFIG.BLIGHT.immuneLevel;
    var out = [];
    for (var i = 1; i < state.nodes.length; i++) {
      var nd = state.nodes[i];
      if (!nd.gnat && !nd.blighted && nd.level < maxL) out.push(i);
    }
    return out;
  }

  function putBlight(state, nodeId) {
    var nd = state.nodes[nodeId];
    if (!nd || nd.blighted || nd.gnat) return null;
    var cfg = CONFIG.BLIGHT;
    var b = { kind: 'blight', nodeId: nodeId, spreadT: cfg.spreadInterval, failStreak: 0 };
    nd.blighted = b;
    nd.disabled = true;
    state.events.push(b);
    return b;
  }

  /* 菌瘟只沿「相邻的健康菌丝」扩散 —— 所以蔓延路径可预判，
   * 玩家看一眼地图就知道它会往哪爬，这是紧迫感的来源。
   *
   * 两条等级规则，叠加生效：
   *   ① 相对规则：Lv N 的菌瘟只能传给「等级 ≤ N」的邻居 ——
   *      **把周边菌丝练到比瘟的等级高，就能挡住它**。
   *   ② 绝对规则：**Lv(immuneLevel)+ 的菌丝完全免疫**，任何菌瘟都传不进去。
   *      这是硬承诺 —— 给深耕一个确定的终点（「练到 7 级就安全了」）。
   * 生命周期：面前一个可感染的邻居都没有 = 被围死，连续 failLimit 个周期
   * 就熄灭（节点保留、恢复健康）；只要还有活路就一直活着烂下去。
   * 注意「抽签没中」不算被围死 —— 它可以传，只是这个周期运气差。 */
  function spreadBlights(state) {
    var cfg = CONFIG.BLIGHT;
    var interval = cfg.spreadInterval * (state.mods.blightSlow ? 1.6 : 1);
    var chance = Math.min(0.85, cfg.spreadChance + state.prestiges * 0.03);
    var maxN = blightMaxCount(state);
    var cap = cfg.maxLevel;
    var immune = cfg.immuneLevel;

    for (var i = state.events.length - 1; i >= 0; i--) {
      var e = state.events[i];
      if (e.kind !== 'blight') continue;
      var nd = state.nodes[e.nodeId];
      if (!nd || !nd.blighted) continue;

      var srcLvl = Math.min(nd.level, cap);
      var nb = neighbours(nd.x, nd.y), pool = [];
      for (var k = 0; k < nb.length; k++) {
        var nid = state.nodeAt[idx(nb[k][0], nb[k][1])];
        if (nid == null || nid === 0) continue;      // 核心免疫：全黑几十秒太惩罚
        var t = state.nodes[nid];
        if (t.gnat || t.blighted) continue;
        if (t.level >= immune) continue;             // 绝对免疫：Lv7+ 传不进去
        if (t.level > srcLvl) continue;              // 比瘟等级高的邻居：挡住去路
        pool.push(nid);
      }

      if (pool.length === 0) {
        // 被围死：面前一个能感染的邻居都没有
        e.failStreak = (e.failStreak || 0) + 1;
        if (e.failStreak >= cfg.failLimit) {
          state.events.splice(i, 1);
          nd.blighted = null;
          nd.disabled = false;
          pushFloater(state, nd.x, nd.y, '熄灭', 'nutrient');
        }
        continue;
      }
      e.failStreak = 0;                              // 还有活路：瘟继续活着

      if (countBlights(state) < maxN && stateRng(state) < chance) {
        var nb2 = putBlight(state, pool[Math.floor(stateRng(state) * pool.length)]);
        if (nb2) e.spreadT = interval;
      }
    }
  }

  function spawnBlight(state) {
    var pool = blightableNodeIds(state);
    if (!pool.length) return null;
    // 偏好离核远的：从网络边缘开始烂，玩家有时间反应
    var best = null, bestDist = -1;
    for (var k = 0; k < 4; k++) {
      var id = pool[Math.floor(stateRng(state) * pool.length)];
      var d = state.nodes[id].dist;
      if (d > bestDist) { bestDist = d; best = id; }
    }
    return best == null ? null : putBlight(state, best);
  }

  /* 移除菌瘟 —— 仅内部接口（测试编排/清场用），**玩家无法手动净化**：
   * 点一下就消掉，菌瘟就不配叫威胁了。
   * 玩家的应对 = 相对等级防火墙（邻居比瘟高就挡得住）+ 围死等它熄灭。 */
  function removeBlight(state, nodeId) {
    var nd = state.nodes[nodeId];
    if (!nd || !nd.blighted) return { ok: false, reason: '这里没有菌瘟' };
    for (var i = 0; i < state.events.length; i++) {
      if (state.events[i] === nd.blighted) { state.events.splice(i, 1); break; }
    }
    nd.blighted = null;
    nd.disabled = false;
    return { ok: true };
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
      else if (m.id === 'm9') {
        /* 「防火墙」：同时养出 firewallNodes 个**达到免疫线**的节点。
         * 等级门槛直接引用 immuneLevel —— 和传染判定是同一个数字
         * （理由见 config.BLIGHT 上方的「不变量」注释）：
         * 练到免疫线，既是免疫，也就是防火墙的一块砖。
         * 菌瘟不能手动净化之后，这就是玩家对菌瘟的主动答案 ——
         * 里程碑奖励（蔓延变慢）也顺理成章：防火墙越强，瘟越爬不动。
         * 注意这里**不做任何「花不花得起」的校验**：能凑出这几个免疫节点
         * 就已经是大后期，维持费不是这道坎的约束（见 config 里的注释）。 */
        var fwLvl = CONFIG.BLIGHT.immuneLevel;
        var fw = 0;
        for (var j = 0; j < state.nodes.length; j++) {
          if (state.nodes[j].level >= fwLvl) fw++;
        }
        ok = fw >= CONFIG.BLIGHT.firewallNodes;
      }
      else if (m.id === 'm10') {
        /* 「连上」而不是「看到」—— 初始感知圈是圆的，运气好的种子
         * 四种基质全在圈里，光靠开局那一次 reveal 就能解锁，等于白送（实测踩过）。
         * 连上必须真的把菌丝长过去，是玩家点出来的，解锁才有分量。
         * 进度读 counters（跨转生保留）：转生清空网络不能倒扣成就进度，
         * 否则玩家在 200 格转生一次就得重爬，体验莫名其妙（实测数据）。
         * 门槛数值见 CONFIG.GROW.autoUnlockNodes 的注释。 */
        var cs = state.counters.connectedSoils || {};
        ok = !!(cs.litter && cs.vein && cs.wood && cs.root) &&
             (state.counters.maxNodes || 0) >= CONFIG.GROW.autoUnlockNodes;
      }
      else if (m.id === 'm11') {
        /* 「完成一次散播且菌丝达到 400 格」。
         * 用 prestiges 而不是 runs —— runs 在旧档里可能是空的，
         * 而 prestiges 是同一件事的更可靠来源（转生过至少一次 = 散播过）。
         * 门槛 400 格比 m10 的 250 高一档，确保「第二个槽位」是
         * 已经玩透一轮的玩家才拿到的第二层深度。
         * 同样读 counters.maxNodes（跨转生保留），转生不清进度。 */
        ok = (state.prestiges || 0) >= 1 && (state.counters.maxNodes || 0) >= 400;
      }
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
      case 'm9': state.mods.blightSlow = true; break;
      case 'm10':
        state.autoGrow = true;
        pushFloater(state, state.core.x, state.core.y, '自动蔓延!', 'spore');
        break;
      case 'm11':
        /* 菌株槽位 +1。strainSlots() 直接读 milestones.m11，
         * 所以这里不需要改任何状态 —— 但要把缓存丢掉，
         * 因为槽位数变了意味着「现在能装第二个菌株」，
         * 任何依赖槽位数的缓存（如 UI 的按钮禁用态）都要重算。 */
        invalidateStrain(state);
        pushFloater(state, state.core.x, state.core.y, '菌株槽位 +1', 'spore');
        break;
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

    /* 换一张新地图：种子从旧地图**确定性**推出。
     * 不能用 Math.random —— headless_sim 靠「同一种子 → 同一张地图序列」
     * 来比较策略，一随机每次跑出来的对照就不可比了。
     * 注意 hash2 返回的是 [0,1) 浮点，必须乘回去再取整 ——
     * 直接 >>>0 会永远得到 0（所有玩家转生后都拿到同一张图，实测踩过）。
     *
     * 【尺寸不再跟着 prestiges 涨】—— 现在由转生抉择里的地图卡决定
     * （见 mapSizeFor 的注释）。这里只负责「换一张同档位的新图」。 */
    state.seed = (RNG.hash2(state.prestiges, 7717, state.seed) * 4294967296) >>> 0;
    applyMapSize(state, mapSizeFor(state.mapTier || 0));
    generateMap(state);
    state.knowledge = {};
    state.explored = { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, count: 0 };

    state.res = { water: CONFIG.START.water + state.genes.gWater * 150,
                  nutrient: 0, spore: 0 };
    state.total = { water: 0, nutrient: 0, spore: 0 };
    state.lostTotal = 0;
    state.t = 0;
    state.autoTimer = 0;

    // 技能与地图事件是「本局」的东西，转生后重来。
    // 但已解锁的技能、已完成的里程碑、里程碑带来的增益属于永久成就层，保留 ——
    // 否则每转生一次都要重新解锁技能，非常烦人。
    // 菌株同理：它是 Build 选择（等同于基因），转生后必须保留，
    // 否则「换策略」就变成了每局重开都要重新点一遍的杂活。
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

    rebuildNetwork(state);
    reveal(state);
    state.lastRecord = record;
    /* 发三选一的卡。放在**世界重置之后** —— 地图卡要基于「刚换好的世界」
     * 算下一档尺寸，先发卡再重置会把新地图又冲掉一遍。 */
    offerChoice(state, gained);
    return { ok: true, gained: gained, record: record };
  }

  /* ============================================================ 转生抉择
   * Roguelike 式的「每次转生三选一」。
   *
   * 【为什么放在 doPrestige 之后而不是里面】
   * doPrestige 已经做完了「重置世界」这件重活。抉择只负责
   * 「在新世界里额外给你一样东西」，两件事分开之后，
   * doPrestige 保持纯粹（不依赖玩家选了什么），也更容易单独测试。
   *
   * 【卡池怎么生成】
   *   1. 菌株卡：从 STRAIN.list 里排除**已经装备/拥有过**的，
   *      再随机取若干张。全都拿过了就不出菌株卡（不会出现废卡）。
   *   2. 地图卡：只要没到上限就一定能出。
   *   3. 点数卡：永远能出（数值按本次转生应得基因点的比例算）。
   *   3 类各按权重抽，凑够 offerCount 张；不足时用点数卡补齐
   *   —— 保证**任何时候都恰好有 offerCount 张可选**，
   *   否则会出现「只有 1 张卡」这种没有选择的选择题。
   *
   * 【随机性与可复现】
   * 用 state.seed 派生的独立 RNG（`makeRng(seed ^ 0x9E3779B9)`）。
   * 不能直接用 Math.random —— headless_sim 靠确定性对照比较策略，
   * 一随机就不可比了（这个坑在转生种子那里踩过一次）。
   */
  function rollChoices(state, gained) {
    var cfg = CONFIG.PRESTIGE_CHOICE;
    var rnd = RNG.makeRng((state.seed ^ 0x9E3779B9) >>> 0);

    /* ---- 菌株卡：排除已拥有的，避免抽到废卡 ---- */
    var owned = {};
    (state.strains || []).forEach(function (k) { owned[k] = true; });
    var availStrains = CONFIG.STRAIN.list.filter(function (s) { return !owned[s.key]; });

    /* ---- 地图卡自己的池子 ---- */
    var mapPool = [];
    if ((state.mapTier || 0) < cfg.mapMaxTier) {
      var nextTier = (state.mapTier || 0) + 1;
      var nm = mapSizeFor(nextTier);
      mapPool.push({
        type: 'map', key: 'map' + nextTier, weight: cfg.weightMap,
        nextW: nm.w, nextH: nm.h
      });
    }

    /* ---- 点数卡（两张不同梯度，让「多给点」内部也有选择） ---- */
    var base = Math.round(gained * cfg.genesPct) + cfg.genesFlat;
    var genePool = [1.0, 0.5].map(function (k, i) {
      return {
        type: 'genes', key: 'genes' + (i + 1), weight: cfg.weightGenes,
        amount: Math.max(1, Math.round(base * k))
      };
    });
    while (genePool.length < cfg.offerCount) {
      var i2 = genePool.length;
      genePool.push({ type: 'genes', key: 'genesFill' + i2, weight: 0,
                      amount: Math.max(1, cfg.genesFlat) });
    }

    /* 【抽卡策略：按类别各保证一席，剩下的按权重补】
     *
     * 为什么不是「把所有卡丢进一个袋子按权重抽」——
     * 实测那样做的时候，开局有 4 个菌株（权重 3×4=12）对 1 张地图卡
     * （权重 2），**地图卡只有 36% 的三选一会包含它**。
     * 也就是玩家想扩大地图时，三分之二的转生根本选不到 ——
     * 那这个「选项」就是假的（存在但摸不着，比没有更让人恼火）。
     *
     * 改成：先给每个**还有货**的类别留一个席位，再把剩余席位按权重分。
     * 这样「菌株 / 地图 / 点数」在任何时候都至少有其一席之地，
     * 玩家永远能选到自己想要的方向；类别内部的**具体哪一张**仍然随机，
     * roguelike 的随机性没丢。 */
    var pools = [];
    if (availStrains.length) {
      pools.push({
        type: 'strain',
        items: availStrains.map(function (s) {
          return { type: 'strain', key: s.key, weight: cfg.weightStrain };
        })
      });
    }
    if (mapPool.length) pools.push({ type: 'map', items: mapPool });
    pools.push({ type: 'genes', items: genePool });

    var picked = [];
    /* 第一轮：每个类别先抽一张（若席位够） */
    var order = pools.slice();
    while (picked.length < cfg.offerCount && order.length) {
      var p = order.shift();
      picked.push(pickOne(p.items, rnd));
    }
    /* 第二轮起：把**所有**还剩东西的池子摊平，按权重补满剩余席位。
     * 摊平会让「菌株」因为条目多而略占优势 —— 这是有意的：
     * 菌株是这套系统的核心吸引力，前期多出现几次能更快建立认知。 */
    var bag = [];
    pools.forEach(function (p) {
      p.items.forEach(function (it) { bag.push(it); });
    });
    /* 排除已经发出去的（同一张卡不该出现两次） */
    picked.forEach(function (pk) {
      for (var b = bag.length - 1; b >= 0; b--) if (bag[b].key === pk.key) bag.splice(b, 1);
    });
    while (picked.length < cfg.offerCount && bag.length) {
      var hit = pickOne(bag, rnd);
      picked.push(hit);
      for (var b2 = bag.length - 1; b2 >= 0; b2--) if (bag[b2].key === hit.key) bag.splice(b2, 1);
    }
    return picked;
  }

  /* 按权重从 items 里挑一个并移除。返回挑中的卡。 */
  function pickOne(items, rnd) {
    var total = items.reduce(function (a, c) { return a + (c.weight || 0); }, 0);
    if (total <= 0) return items.splice(0, 1)[0];
    var r = rnd() * total, acc = 0;
    for (var i = 0; i < items.length; i++) {
      acc += items[i].weight || 0;
      if (r <= acc) return items.splice(i, 1)[0];
    }
    return items.splice(items.length - 1, 1)[0];
  }

  /* 转生时把三选一放进 state，等玩家选。
   * 注意：**必须先重置世界再发卡** —— 否则地图卡的「扩大」要重算两遍世界。 */
  function offerChoice(state, gained) {
    state.pendingChoice = {
      cards: rollChoices(state, gained),
      gained: gained,
      forPrestige: state.prestiges,
      at: Date.now()
    };
    return state.pendingChoice;
  }

  /* 玩家选了一张卡。返回 {ok, card} 或 {ok:false, reason}。
   *
   * 【幂等性】选完立刻清空 pendingChoice —— 否则连点两下就白拿两份。
   * 这也保证 UI 的「选完关弹窗」和引擎状态一致。 */
  function applyChoice(state, key) {
    var pc = state.pendingChoice;
    if (!pc) return { ok: false, reason: '没有待选的卡' };
    var card = null;
    for (var i = 0; i < pc.cards.length; i++) if (pc.cards[i].key === key) card = pc.cards[i];
    if (!card) return { ok: false, reason: '这张卡不在候选里' };

    switch (card.type) {
      case 'strain':
        /* 直接装备。槽位够就装上，不够就只记「拥有」——
         * 但本系统的本意是「拿到就能用」，所以这里走 equipStrain 的
         * 同一个入口，让槽位规则统一生效（满槽时拒绝并告知）。 */
        var eq = equipStrain(state, card.key);
        if (!eq.ok) {
          /* 槽位满了 —— 不吞掉这张卡，改成「已拥有，等玩家自己腾位置」。
           * 直接拒绝会让玩家白白浪费一次转生奖励。 */
          if (state.strains.indexOf(card.key) < 0) state.strains.push(card.key);
          invalidateStrain(state);
          card.note = eq.reason;
        }
        break;
      case 'map':
        state.mapTier = (state.mapTier || 0) + 1;
        /* 立刻换到更大的地图。这会清掉现有网络 —— 但转生刚重置过，
         * 此刻网络里只有核心，所以没有额外损失。 */
        applyMapSize(state, mapSizeFor(state.mapTier));
        generateMap(state);
        state.knowledge = {};
        state.explored = { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, count: 0 };
        for (var g = 0; g < state.grid.length; g++) state.grid[g].node = null;
        state.nodes = [];
        state.nodeAt = [];
        var core2 = makeNode(state, state.core.x, state.core.y, 'core', 0);
        state.nodes = [core2];
        state.nodeAt[idx(state.core.x, state.core.y)] = 0;
        rebuildNetwork(state);
        reveal(state);
        break;
      case 'genes':
        state.pendingGenes = (state.pendingGenes || 0) + card.amount;
        break;
    }

    state.pendingChoice = null;
    state.lastChoice = {
      type: card.type, key: card.key, amount: card.amount,
      strain: card.type === 'strain' ? card.key : null,
      mapTier: state.mapTier || 0, at: Date.now()
    };
    return { ok: true, card: card };
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

  /* 把 knowledge 应用回网格（known 标记 + 探索包围盒）。
   * deserialize 里此前**漏了这一步** —— 读档后已探明区域会整个消失，
   * 玩家看到的是一张只剩核心周围一圈的黑图。 */
  function applyKnowledge(state) {
    for (var key in state.knowledge) {
      var p = key.split(','), x = +p[0], y = +p[1];
      if (!inBounds(x, y)) continue;
      markKnown(state, x, y);
    }
  }

  /* ---------------------------------------------------------------- 存档 */
  function serialize(state) {
    return JSON.stringify({
      v: 3,
      mapW: state.mapW, mapH: state.mapH,
      /* 地图扩展档位。**必须存** —— 它是玩家在三选一里做过的投资，
       * 丢了就变成「选过的地图打回原形」。 */
      mapTier: state.mapTier || 0,
      seed: state.seed,
      res: state.res, total: state.total, t: state.t,
      up: state.up, genes: state.genes, knowledge: state.knowledge,
      policy: state.policy, autoGrow: state.autoGrow,
      ruleMaxDist: state.ruleMaxDist || 0, ruleMinYield: state.ruleMinYield || 0,
      prestiges: state.prestiges, runs: state.runs,
      pendingGenes: state.pendingGenes || 0,
      /* 待选的转生卡。存进存档是为了「转生完就关页面」也不丢 ——
       * 否则玩家回来会发现那张卡没了，奖励直接蒸发。 */
      pendingChoice: state.pendingChoice || null,
      // 内容层：技能解锁、冷却、里程碑、增益、计数
      cd: state.cd, unlocked: state.unlocked, pulseT: state.pulseT,
      milestones: state.milestones, mods: state.mods, counters: state.counters,
      nextEventAt: state.nextEventAt,
      /* 已装备的菌株。它是「Build 选择」，跟 genes 一样跨转生保留，
       * 所以必须存档 —— 否则读档后 Build 就悄悄退回无菌株了。 */
      strains: state.strains || [],
      nodes: state.nodes.map(function (n) {
        /* 第 8 位是树木成长度。只有 root 会用到；为省体积，
         * 非树或零成长的节点写 0 —— 读档时用 !! 守卫即可兼容旧档。 */
        return [n.x, n.y, n.soil, n.level, n.pinned ? 1 : 0, n.trunk ? 1 : 0,
                n.confluence ? 1 : 0, (n.soil === 'root' ? (n.tree || 0) : 0)];
      })
    });
  }

  function deserialize(json) {
    var d = JSON.parse(json);
    /* 地图档位迁移：旧存档没有 mapTier，但它经历过「按 prestiges 自动长大」，
     * 所以用 prestige 次数反推一个近似的档位，避免老玩家读档后地图突然缩小
     * （那会比「没有这个功能」更让人难受）。
     * 反推公式与旧的 mapSizeFor 一致：边长系数 = 1 + prestiges*0.12。
     * 上限取 mapMaxTier —— 反正 mapSizeFor 里还会再封顶一次。 */
    var tier = d.mapTier;
    if (tier == null) {
      var cfgc = CONFIG.PRESTIGE_CHOICE;
      tier = Math.round((d.prestiges || 0));
      if (cfgc) tier = Math.min(cfgc.mapMaxTier, tier);
    }
    var state = newGame(d.seed, d.genes, d.knowledge, d.prestiges || 0, tier);
    state.up = d.up; state.res = d.res; state.total = d.total; state.t = d.t;
    state.policy = d.policy; state.autoGrow = d.autoGrow;
    state.ruleMaxDist = d.ruleMaxDist || 0;      // 旧存档没有 → 不限
    state.ruleMinYield = d.ruleMinYield || 0;
    state.prestiges = d.prestiges; state.runs = d.runs || [];
    state.pendingGenes = d.pendingGenes || 0;
    /* 待选卡：旧存档没有就是 null（正常玩）。有的话要**校验形状** ——
     * 存档可能来自改过配置的版本，卡已经不在池子里了。
     * 校验不过就丢掉，总比让玩家点一张会崩的卡好。 */
    var pc = d.pendingChoice;
    state.pendingChoice = (pc && pc.cards && pc.cards.length) ? pc : null;
    state.cd = d.cd || {};
    state.unlocked = d.unlocked || {};
    state.pulseT = d.pulseT || 0;
    state.milestones = d.milestones || {};
    if (d.mods) state.mods = d.mods;
    if (d.counters) state.counters = d.counters;
    if (d.nextEventAt != null) state.nextEventAt = d.nextEventAt;
    /* 已装备菌株：旧存档没有这个字段 → 空数组（等同于无加成）。
     * 也要过滤掉已经不存在的 key（配置改过之后的存档）。
     * 最后必须 invalidateStrain —— newGame 里已经算过一次缓存，
     * 不失效的话读档后拿到的还是空菌株的乘区（实测踩过）。 */
    state.strains = (d.strains || []).filter(function (k) { return !!strainCfg(k); });
    invalidateStrain(state);
    applyKnowledge(state);   // 读档必须恢复已探明区域（之前一直漏了）

    state.nodes = []; state.nodeAt = [];
    for (var i = 0; i < state.grid.length; i++) state.grid[i].node = null;
    d.nodes.forEach(function (n, i) {
      var nd = makeNode(state, n[0], n[1], n[2], i);
      nd.level = n[3] || 0;
      nd.pinned = !!n[4];        // 旧存档没有第 5 位 → 默认未锁定
      nd.trunk = !!n[5];         // 旧存档没有第 6 位 → 默认非主干
      nd.confluence = !!n[6];    // 旧存档没有第 7 位 → 默认非汇流
      /* 树木成长度：旧存档没有第 8 位 → 当作「刚种下」。
       * treeStage 由成长度推出来，不存档 —— 它是缓存，存了反而可能不一致。 */
      if (nd.soil === 'root') {
        nd.tree = n[7] || 0;
        nd.treeStage = treeStageOf(nd.tree);
      }
      state.nodes.push(nd);
      state.nodeAt[idx(n[0], n[1])] = i;
      state.grid[idx(n[0], n[1])].node = i;
    });
    /* 旧存档没有 maxNodes / connectedSoils：从节点列表补算一遍，
     * 否则老玩家的里程碑进度会从零开始。 */
    if (state.counters.connectedSoils == null) state.counters.connectedSoils = {};
    if (state.counters.maxNodes == null) state.counters.maxNodes = 0;
    state.nodes.forEach(function (n) {
      if (n.soil !== 'core') state.counters.connectedSoils[n.soil] = 1;
    });
    if (state.nodes.length > state.counters.maxNodes) state.counters.maxNodes = state.nodes.length;
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
    removeNode: removeNode,
    mapSizeFor: mapSizeFor,
    /* applyMapSize 必须导出：地图尺寸是**模块级单例**（_MAP），
     * 而 applyChoice 的地图卡会改它。自测为了验证地图卡，会拿一个
     * 临时 state 去选卡 —— 不还原的话，_MAP 就停在临时 state 的尺寸上，
     * 之后对**当前这一局**做 idx()/inBounds() 全用错尺寸，
     * 表现为莫名其妙的越界与错格。所以给测试一个显式的还原入口。 */
    applyMapSize: applyMapSize,
    candidates: candidates, growCostAt: growCostAt, cellYield: cellYield,
    transportEfficiency: transportEfficiency,
    topsoilOffset: topsoilOffset,
    upgradeCost: upgradeCost, buyUpgrade: buyUpgrade,
    prestigeCost: prestigeCost, geneGain: geneGain, canPrestige: canPrestige, doPrestige: doPrestige,
    /* 转生抉择（Roguelike 三选一）。rollChoices 单独导出是为了让
     * headless_sim / autotest 能直接检查「卡池里都有什么」，
     * 不用真的走一遍转生。 */
    rollChoices: rollChoices, offerChoice: offerChoice, applyChoice: applyChoice,
    geneCost: geneCost, buyGene: buyGene,
    serialize: serialize, deserialize: deserialize,
    stats: stats, idx: idx, rebuildNetwork: rebuildNetwork, autoStep: autoStep,
    /* 以下四个是给自测用的底层入口：自测要动手「造一条指定形状的网络」
     * 才能核对曲线与面板文案（公用的 growAt 受地形与配额限制，
     * 铺出来的形状不可控）。invalidateCands 必须一起导出 ——
     * candidates() 按帧缓存，自测改了 grid 的 soil 之后不清缓存，
     * growAt 会拿着旧 soil 种错基质（见 autotest 里树木那步的注释）。 */
    addNode: addNode, computeFlow: computeFlow, invalidateCands: invalidateCands,
    bestCandidate: bestCandidate, autoIntervalOf: autoIntervalOf,
    passAutoRule: passAutoRule,
    // 内容层
    nodeUpgradeCost: nodeUpgradeCost, upgradeNode: upgradeNode,
    abilityReady: abilityReady, useAbility: useAbility, abilityCfg: abilityCfg,
    spawnEvent: spawnEvent, removeGnat: removeGnat, buffAt: buffAt,
    countGnats: countGnats, checkMilestones: checkMilestones,
    // 菌瘟（后期挑战）
    countBlights: countBlights, removeBlight: removeBlight,
    spawnBlight: spawnBlight, spreadBlights: spreadBlights, putBlight: putBlight,
    // 维护耗水
    maintainCostOf: maintainCostOf, totalMaintainCost: totalMaintainCost,
    settleMaintenance: settleMaintenance, downgradeOrder: downgradeOrder,
    togglePin: togglePin, pinnedCount: pinnedCount,
    // 主干 / 汇流（网络结构成为策略）
    toggleTrunk: toggleTrunk, toggleConfluence: toggleConfluence,
    trunkCount: trunkCount, confluenceCount: confluenceCount,
    adjacentConfluence: adjacentConfluence, feederCount: feederCount,
    // 树木（根系生态：随连接时长成长，古树给周围加成）
    isTree: isTree, treeStageOf: treeStageOf, treeStageNameOf: treeStageNameOf,
    treeCrowd: treeCrowd, treeYieldMulOf: treeYieldMulOf,
    underOldTreeAura: underOldTreeAura, treeStateOf: treeStateOf,
    pushFloater: pushFloater,
    // 菌株 + 槽位（Build 层：出核范围 vs 单位产量 vs 树的收益）
    strainMods: strainMods, invalidateStrain: invalidateStrain,
    strainCfg: strainCfg, strainSlots: strainSlots, strainsUnlocked: strainsUnlocked,
    strainInfo: strainInfo, equipStrain: equipStrain, unequipStrain: unequipStrain,
    // 离线收益
    settleOffline: settleOffline, coreSeep: coreSeep,
    cellYieldOf: function (state, soil) { return cellYield(state, soil); }
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = Sim; }
else { window.MYC = window.MYC || {}; window.MYC.Sim = Sim; }
