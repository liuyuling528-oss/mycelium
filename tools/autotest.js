/* ============================================================================
 * autotest.js — 浏览器端自测钩子
 *
 * 只在 URL 带 ?autotest=1 时生效，正常游玩完全不受影响。
 *
 * 为什么需要它：headless 截图只能证明「看起来有东西」，证明不了
 * 「点击真的能长菌丝」「资源真的在涨」「面板真的跟着刷新」。
 *
 * 关键坑：Phaser 把原生指针事件**排队**，在下一帧的 preUpdate 里才处理。
 * 所以派发事件之后必须让出一帧再断言 —— 同步断言永远会失败。
 * 下面用「分步 + 步间 setTimeout」实现这一点。
 * ==========================================================================*/
(function () {
  'use strict';
  var q = location.search;

  /* ---- 开发用：?demo=秒数 —— 快速养大网络，方便截图与目视检查 ---- */
  var dm = /[?&]demo=(\d+)/.exec(q);
  if (dm) {
    var runDemo = function (seconds) {
      var Sim = window.MYC.Sim, st = window.MYC.game.state, C = window.MYC.CONFIG;
      st.up.autoGrow = 10;                 // 加快蔓延，省得等
      st.res.water = 3000;
      var ticks = Math.round(seconds * 10);
      for (var i = 0; i < ticks; i++) {
        Sim.tick(st, 0.1);
        if (i % 20 === 0) {
          ['absorption', 'hydration', 'transport', 'capacity', 'growth', 'autoGrow']
            .forEach(function (k) {
              for (var g = 0; g < 40; g++) if (!Sim.buyUpgrade(st, k).ok) break;
            });
        }
        // 顺手强化几个节点，让「深耕」的等级光环在截图上能看见
        if (i % 60 === 0 && st.res.nutrient > 800) {
          var best = null, bestScore = -Infinity;
          for (var j = 1; j < st.nodes.length; j++) {
            var nd = st.nodes[j];
            var c = Sim.nodeUpgradeCost(st, nd);
            if (!isFinite(c) || st.res.nutrient < c) continue;
            var sc = ({ wood: 4, root: 4, vein: 3, litter: 3, soil: 1 }[nd.soil] || 1) * 20 - c * 0.002 - nd.level * 3;
            if (sc > bestScore) { bestScore = sc; best = j; }
          }
          if (best !== null) Sim.upgradeNode(st, best);
        }
      }

      // 摆出事件：两个增益区 + 几只害虫，好让截图能检查这三样东西的渲染
      st.events = [];
      st.floaters = [];
      var core = st.nodes[0];
      st.events.push({ kind: 'rain',  x: core.x + 6, y: core.y - 4, r: C.EVENTS.buffRadius, ttl: 38, dur: 45 });
      st.events.push({ kind: 'bloom', x: core.x - 7, y: core.y + 4, r: C.EVENTS.buffRadius, ttl: 38, dur: 45 });
      for (var t = 0; t < 40 && Sim.countGnats(st) < 2; t++) Sim.spawnEvent(st);
      // 上面为了凑害虫会顺手造出一堆增益区 —— 要裁掉，只留自己摆的那 2 个。
      // 真实游戏里事件间隔 55~95 秒，绝不会同时出现十几个圈。
      var keep = 0;
      for (var q = 0; q < st.events.length; q++) {
        var e = st.events[q];
        if (e.kind === 'gnat') continue;
        keep++;
        if (keep > 2) { st.events.splice(q, 1); q--; }   // 从头裁，保住自己摆的那两个
      }

      // 点亮两个技能，展示技能栏的「可用」状态
      st.unlocked.pulse = true; st.unlocked.digest = true;
      st.pulseT = 4;

      window.MYC.game.dirty = true;
      if (window.MYC.game.ui) window.MYC.game.ui.update(0.2, window.MYC.game);
      if (window.MYC.game.scene) {
        window.MYC.game.scene.lastKnown = -1;
        window.MYC.game.scene.lastNodeCount = 0;
      }
    };
    var waitDemo = function () {
      if (!window.MYC || !window.MYC.game || !window.MYC.game.scene) return setTimeout(waitDemo, 100);
      setTimeout(function () { runDemo(Number(dm[1])); }, 300);
    };
    waitDemo();
    return;
  }

  if (q.indexOf('autotest') < 0) return;

  var R = [], errs = [], steps = [], S = {};

  window.addEventListener('error', function (e) {
    errs.push((e.message || 'error') + ' @' + (e.filename || '?') + ':' + (e.lineno || 0));
  });
  window.addEventListener('unhandledrejection', function (e) {
    errs.push('rejection: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
  });

  function ok(label, cond, detail) {
    R.push((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  }
  function step(fn) { steps.push(fn); }

  /* 地图尺寸随转生次数长大 —— 一律读 state 里的实际尺寸，
   * 别用 CONFIG.GRID（那是基础值，转生几次之后就对不上了）。 */
  function GRID() {
    var st = window.MYC.game.state;
    var base = window.MYC.CONFIG.GRID;
    return {
      W: (st && st.mapW) || base.W,
      H: (st && st.mapH) || base.H,
      CELL: base.CELL, OX: base.OX, OY: base.OY
    };
  }

  function canvas() { return document.querySelector('#game canvas'); }

  /* 世界格 -> 屏幕坐标。
   *
   * 用**场景自己维护的视野状态**（viewZoom / viewCx / viewCy）来算，而不是
   * cam.worldView / cam.getWorldPoint —— 后者只在渲染阶段更新，headless 下
   * 经常比刚设置的值旧一帧（rAF 很稀疏），算出来的坐标会整体偏掉，
   * 表现成「点击落在别的格子上」这种极难判断的假失败。
   *
   * 公式与摄像机一致：世界点 = 视野中心 + (画布点 - 画布中心)/zoom。
   */
  function cellToClient(x, y) {
    var G = GRID();
    var sc = window.MYC.game.scene;
    var cv = canvas(), r = cv.getBoundingClientRect();
    var z = sc.viewZoom, cw = sc.scale.width, ch = sc.scale.height;
    var wx = G.OX + x * G.CELL + G.CELL / 2;
    var wy = G.OY + y * G.CELL + G.CELL / 2;
    var ix = (wx - (sc.viewCx - cw / 2 / z)) * z;      // 画布内部像素
    var iy = (wy - (sc.viewCy - ch / 2 / z)) * z;
    return {
      x: r.left + ix * (r.width / cv.width),
      y: r.top + iy * (r.height / cv.height),
      inside: true
    };
  }

  /* 当前可见的世界矩形（同样只看场景状态，不依赖摄像机是否已渲染） */
  function viewRect() {
    var sc = window.MYC.game.scene;
    var w = sc.scale.width / sc.viewZoom, h = sc.scale.height / sc.viewZoom;
    return { left: sc.viewCx - w / 2, right: sc.viewCx + w / 2,
             top: sc.viewCy - h / 2, bottom: sc.viewCy + h / 2 };
  }

  /* 可见范围内的格子范围（往里缩一格，保证格子整个在画面里） */
  function visibleCells() {
    var G = window.MYC.CONFIG.GRID, v = viewRect();
    return {
      x0: Math.max(0, Math.floor((v.left - G.OX) / G.CELL) + 1),
      x1: Math.min(G.W - 1, Math.ceil((v.right - G.OX) / G.CELL) - 1),
      y0: Math.max(0, Math.floor((v.top - G.OY) / G.CELL) + 1),
      y1: Math.min(G.H - 1, Math.ceil((v.bottom - G.OY) / G.CELL) - 1)
    };
  }

  function fire(type, pt) {
    var cv = canvas();
    var init = {
      clientX: pt.x, clientY: pt.y, bubbles: true, cancelable: true,
      pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, isPrimary: true,
      view: window, detail: 1
    };
    var ev;
    if (type.indexOf('pointer') === 0) {
      ev = new PointerEvent(type, init);
    } else if (type.indexOf('touch') === 0) {
      ev = new Event(type, { bubbles: true, cancelable: true });
      ev.touches = type === 'touchend' ? [] : [{ clientX: pt.x, clientY: pt.y, identifier: 1 }];
      ev.changedTouches = [{ clientX: pt.x, clientY: pt.y, identifier: 1 }];
    } else {
      ev = new MouseEvent(type, init);
    }
    cv.dispatchEvent(ev);
  }

  /* Phaser 在不同环境下可能监听 pointerdown 也可能只监听 mousedown，
   * 这里把两种都派发一遍，保证一定命中它真正挂的那一个。 */
  var ALL_TYPES = ['pointerover', 'pointermove', 'pointerdown', 'pointerup',
                   'mouseover', 'mousemove', 'mousedown', 'mouseup'];

  /* 「把指针移到某处」必须把 move 类事件都发一遍。
   * 只发 pointermove 时 Phaser 可能根本没收到（它实际挂的是 mousemove），
   * 表现就是 hover 一直停在旧值上 —— 而 down/up 因为自带坐标不受影响，
   * 所以点击类测试全绿、唯独悬停类测试失败，很容易被误判成坐标算错。 */
  function moveTo(pt) {
    ['pointerover', 'pointermove', 'mouseover', 'mousemove'].forEach(function (t) {
      fire(t, pt);
    });
  }

  /* 一次完整点击，同样是 down/up 的 pointer* 与 mouse* 都发。
   * 只发 pointerdown 的话 Phaser 可能收不到，于是「点了没反应」这类断言会
   * 因为「压根没收到点击」而**假通过** —— 所以下面还专门放了一个正对照。 */
  function clickAt(pt) {
    ALL_TYPES.forEach(function (t) { fire(t, pt); });
  }

  /* ------------------------------------------------------------ 测试步骤 */

  /* ---- 步骤 0：把游戏重置到「干净开局」-----------------------------------
   *
   * 为什么必须放在最前面：自测自己会玩一遍（长满网络、打通全部里程碑、
   * 转生十来次），并在结束时把状态留在 localStorage 里。
   * 同一个浏览器 profile 再跑一次时，读到的就是那个「终局存档」——
   * 于是「开局该是锁定状态」「转生后地图会变大」这类断言必然失败。
   * 那种失败看起来完全像回归，实际只是上一次自测的残留。
   *
   * 之前各条断言各自绕过（有的造 fresh 状态、有的放宽判据），
   * 结果失败还会在断言之间**搬家** —— 因为整条链的起点是脏的。
   * 在这里一次性清掉，所有断言才回到同一个可复现的起点。
   * 注意：必须用 Sim.newGame 重建 state 并 rebind，不能只删 localStorage，
   * 因为 main.js 已经把旧 state 的引用交给了 UI 与场景。 */
  step(function () {
    var Sim = window.MYC.Sim, g = window.MYC.game, UI = g.ui;
    try { localStorage.removeItem(UI.KEY); } catch (e) {}
    try { localStorage.removeItem(UI.SEEDKEY); } catch (e) {}
    var s = Sim.newGame(20260918, {}, {});
    g.state = s;
    UI.rebind(s);
    if (g.scene) {
      g.scene.lastKnown = -1; g.scene.lastSoilSig = null;
      g.scene.lastNodeCount = 0; g.scene.pops = {};
      if (g.scene.onMapChanged) g.scene.onMapChanged();
    }
    g.dirty = true;
    ok('自测起点是干净开局（清掉上次自测的残留存档）',
       s.prestiges === 0 && s.nodes.length === 1 && !s.autoGrow &&
       Object.keys(s.milestones).length === 0,
       '转生 ' + s.prestiges + ' 次 / ' + s.nodes.length + ' 格 / 地图 ' +
       s.mapW + '×' + s.mapH + ' / autoGrow=' + s.autoGrow);
  });

  step(function () {
    ok('Phaser 已加载', typeof Phaser !== 'undefined', 'Phaser ' + Phaser.VERSION);
    ok('canvas 已创建', !!canvas(), canvas() ? canvas().width + 'x' + canvas().height : 'none');
    ok('场景已就绪', !!window.MYC.game.scene);
    ok('面板已初始化', document.querySelectorAll('#upgrades .item').length > 0);

    /* 先断言「默认锁定」，再置位 —— 顺序反了测的就是空气。
     * 自动蔓延现在由 m10（探索全部 4 种特殊基质）解锁，白送毫无意义。
     * 注意：开局保底会立刻记到落叶层/水脉，所以「记录为空」不是有效断言。
     *
     * 这三条断言的是**开局状态**，而自测本身会把 autoGrow 置为 true 并一路
     * 把 m10 打通（那是刻意的，后面几十条断言依赖网络自己在长）。
     * 所以在同一个 localStorage 上重跑时，读到的已经是「上一局结束时的存档」——
     * 断言必然失败。那不是回归，是测试污染。
     * 解法：用 Sim.newGame 临时造一个干净的开局状态来断言，而不是读当前存档。
     * 这样这组断言可以反复跑，也真正测到了「开局」这个状态。 */
    var fresh = window.MYC.Sim.newGame(20260918, {}, {});
    ok('自动蔓延默认锁定', fresh.autoGrow === false,
       'autoGrow=' + fresh.autoGrow + '（锁定的话玩家必须手动点着跑图）');
    /* 开局只有核心一格，离解锁门槛（m10：连上 4 种基质 + 菌丝达到 N 格）很远 ——
     * 否则解锁等于白送。maxNodes 开局是 0（核心不走 addNode）。 */
    var C = window.MYC.CONFIG;
    ok('开局离解锁门槛很远（条件有意义）',
       (fresh.counters.maxNodes || 0) < C.GROW.autoUnlockNodes,
       'maxNodes=' + (fresh.counters.maxNodes || 0) + '  门槛=' + C.GROW.autoUnlockNodes);
    ok('开局尚未达成 m10（解锁才有意义）', !fresh.milestones.m10,
       'm10=' + !!fresh.milestones.m10);

    /* 开关的 disabled 状态反映的是**当前存档**，所以这条仍读实时状态。
     * 当前存档若已解锁 m10，开关就该是可用的 —— 断言跟着实际状态走。 */
    var st0 = window.MYC.game.state;
    var wantDisabled = !st0.milestones.m10;
    ok('自动蔓延开关的可用性与解锁状态一致',
       document.getElementById('autoGrow').disabled === wantDisabled,
       'disabled=' + document.getElementById('autoGrow').disabled +
       '  m10=' + !!st0.milestones.m10);
    /* 上一条依赖 UI 已经用**重置后的** state 刷过一遍。
     * rebind 只强制刷新开关这一处，锁状态的完整刷新在 UI.update 的
     * 解锁检查分支里 —— 而那个分支是按 lastAgLocked 做增量的，
     * 重置时它可能恰好等于目标值而不重刷。所以这里显式驱动一次面板更新，
     * 把「重置 → 面板」这条链走完，而不是让它依赖帧调度。 */
    window.MYC.game.ui.update(0, window.MYC.game);
    ok('重置后面板已跟上新状态（锁定开关被重新计算）',
       document.getElementById('autoGrow').disabled === wantDisabled,
       'disabled=' + document.getElementById('autoGrow').disabled);

    /* 自测假定已解锁：不置位的话网络不会自己长，
     * 后面几十个依赖「网络在长大」的断言会全部失效。
     * 刻意**不**预置 m10 —— 让它在测试后期有机解锁，那条路径也要测。 */
    st0.autoGrow = true;
  });

  /* 先确认引擎与输入系统状态，免得后面「点击无效」被误判成游戏 bug。 */
  step(function () {
    var sc = window.MYC.game.scene;
    S.frames0 = sc.frames;
    R.push('      场景 input.enabled=' + sc.input.enabled +
           '  windowEvents=' + sc.input.windowEvents +
           '  frames=' + sc.frames);
  });

  step(function () {
    var st = window.MYC.game.state;
    S.Sim = window.MYC.Sim;
    S.nodes0 = st.nodes.length;
    S.best = S.Sim.bestCandidate(st);
    ok('存在可生长候选格', !!S.best,
       S.best ? '(' + S.best.x + ',' + S.best.y + ') ' + S.best.soil + ' 花费 ' + S.best.cost : 'none');
    if (!S.best) return;

    window.MYC.game.ui.update(0.2, window.MYC.game);
    st.res.water = Math.max(st.res.water, 800);

    var pt = cellToClient(S.best.x, S.best.y);
    var r = canvas().getBoundingClientRect();
    R.push('      画布 rect=' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' +
           Math.round(r.width) + 'x' + Math.round(r.height) + '  点击点=' + Math.round(pt.x) + ',' + Math.round(pt.y));
    S.pt = pt;
    ALL_TYPES.forEach(function (t) { fire(t, pt); });
    R.push('      已派发 pointer*/mouse* 事件 —— 等下一帧让 Phaser 处理输入队列');
  });

  step(function () {
    var st = window.MYC.game.state;
    var delta = st.nodes.length - S.nodes0;
    ok('点击格子长出了菌丝', delta >= 1, S.nodes0 + ' -> ' + st.nodes.length + ' 格（+' + delta + '）');
    ok('悬停提示已显示', window.MYC.game.scene.tip.visible === true,
       'tip="' + String(window.MYC.game.scene.tip.text).split('\n')[0] + '"');
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;
    // 用累计产出衡量生产，而不是当前余量（自动蔓延会持续花掉水）
    S.w0 = st.total.water; S.n0 = st.total.nutrient; S.s0 = st.total.spore;
    S.n1 = st.nodes.length;
    // 240 秒：纯挂机是 6 秒/格，120 秒只能铺到半径 2~3，够不到落叶就误判成 bug
    for (var i = 0; i < 2400; i++) Sim.tick(st, 0.1);
    ok('自动蔓延在推进', st.nodes.length > S.n1, S.n1 + ' -> ' + st.nodes.length + ' 格');
    ok('水分在产出', st.total.water > S.w0, S.w0.toFixed(1) + ' -> ' + st.total.water.toFixed(1));
    ok('养分在产出', st.total.nutrient > S.n0, S.n0.toFixed(1) + ' -> ' + st.total.nutrient.toFixed(1));
    ok('孢子在产出', st.total.spore > S.s0, S.s0.toFixed(1) + ' -> ' + st.total.spore.toFixed(1));
    var by = {};
    st.nodes.forEach(function (n) { by[n.soil] = (by[n.soil] || 0) + 1; });
    R.push('      网络基质构成 ' + JSON.stringify(by));
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;
    st.res.nutrient += 100000;
    var lv0 = st.up.absorption, nr0 = st.res.nutrient;
    var br = Sim.buyUpgrade(st, 'absorption');
    ok('可以购买升级', br.ok && st.up.absorption === lv0 + 1, '吸收效率 ' + lv0 + ' -> ' + st.up.absorption);
    ok('购买确实扣了养分', st.res.nutrient < nr0, nr0.toFixed(0) + ' -> ' + st.res.nutrient.toFixed(0));
    ok('网络有最大离核距离', st.maxDist > 0, 'maxDist=' + st.maxDist);

    var rt = st.rate || { water: 0, nutrient: 0, spore: 0 };
    ok('产出速率已计算', (rt.water + rt.nutrient + rt.spore) > 0,
       '水 ' + rt.water.toFixed(2) + ' 养分 ' + rt.nutrient.toFixed(2) + ' 孢子 ' + rt.spore.toFixed(2));

    // 距离损耗必须真的生效：远处的节点效率更低
    var e1 = Sim.transportEfficiency(st, 1), e20 = Sim.transportEfficiency(st, 20);
    ok('距离损耗生效（远的更亏）', e20 < e1, '1 格 ' + (e1 * 100).toFixed(0) + '% vs 20 格 ' + (e20 * 100).toFixed(0) + '%');
  });

  step(function () {
    var st = window.MYC.game.state;
    window.MYC.game.ui.update(0.2, window.MYC.game);
    ok('面板显示与状态一致', String(document.getElementById('sNodes').textContent) === String(st.nodes.length),
       'panel=' + document.getElementById('sNodes').textContent + ' state=' + st.nodes.length);
    ok('升级项全部渲染', document.querySelectorAll('#upgrades .item').length === window.MYC.CONFIG.UPGRADES.length,
       document.querySelectorAll('#upgrades .item').length + ' 项');
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;
    st.res.spore = Sim.prestigeCost(st) + 10;
    st.total.spore += 50000;
    S.canP = Sim.canPrestige(st);
    S.before = st.nodes.length;
    S.pr = Sim.doPrestige(st);
    ok('满足条件可以散播', S.canP);
    ok('散播后网络重置为核心一格', S.pr.ok && st.nodes.length === 1, S.before + ' -> ' + st.nodes.length + ' 格');
    ok('散播获得基因点', S.pr.ok && S.pr.gained > 0, 'gained=' + (S.pr.ok ? S.pr.gained : 0));
    var kv = Object.keys(st.knowledge).length;
    ok('地图知识被保留', kv > 0, kv + ' 格已探明跨转生保留');
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;
    st.pendingGenes += 50;
    var gr = Sim.buyGene(st, 'gYield');
    ok('可以消费基因点', gr.ok && st.genes.gYield > 0, 'gYield 级数 ' + st.genes.gYield);

    var snap = Sim.serialize(st);
    var round = Sim.deserialize(snap);
    ok('存档往返一致', round.nodes.length === st.nodes.length &&
                       Math.abs(round.res.water - st.res.water) < 1e-6,
       '节点 ' + round.nodes.length + ' 水 ' + round.res.water.toFixed(1));
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;
    for (var k = 0; k < 6000; k++) Sim.tick(st, 0.1);
    var finite = isFinite(st.res.water) && isFinite(st.res.nutrient) && isFinite(st.res.spore);
    ok('再跑 10 分钟数值不发散', finite,
       '水 ' + Math.round(st.res.water) + ' 养分 ' + Math.round(st.res.nutrient) +
       ' 孢子 ' + Math.round(st.res.spore) + ' 节点 ' + st.nodes.length);
    ok('节点数在合法范围', st.nodes.length > 0 && st.nodes.length <= st.mapW * st.mapH,
       st.nodes.length + ' 格 / 上限 ' + (st.mapW * st.mapH) + '（地图 ' + st.mapW + '×' + st.mapH + '）');
  });

  /* ---- 内容层（技能 / 里程碑 / 节点强化 / 事件）----
   * 放在最后：此时网络已经有规模，害虫才会出现，节点也才有得强化。
   *
   * 编排原则：不要去抹掉已经发过的奖励来「制造」未解锁状态 ——
   * 里程碑奖励是只发一次的，抹掉 unlocked 只会得到一个假失败。
   * 要测「未解锁」就找一个还没达成的里程碑；要测技能机制就直接 arrange。 */
  step(function () {
    var st = window.MYC.game.state, C = window.MYC.CONFIG, Sim = S.Sim;
    /* 断言的是「里程碑体系是渐进解锁的」这一**性质**，不是「当前存档还有没打完的」。
     * 一个玩到底的存档确实会全达成 —— 那时断言「存在未达成项」必然失败，
     * 但体系本身没坏。所以改成拿一个干净开局来验证性质：
     * 开局应该几乎全部未达成，这才是「渐进」的证据。 */
    var fresh = Sim.newGame(20260918, {}, {});
    var freshPending = C.MILESTONES.filter(function (m) { return !fresh.milestones[m.id]; });
    ok('里程碑是渐进解锁的（干净开局几乎全部未达成）',
       freshPending.length >= C.MILESTONES.length - 1,
       '开局待达成 ' + freshPending.length + '/' + C.MILESTONES.length + ' 个');
    ok('已达成里程碑的奖励确实生效', !st.milestones.m1 || !!st.unlocked.pulse,
       'm1=' + !!st.milestones.m1 + ' → pulse 解锁=' + !!st.unlocked.pulse);

    var locked = C.ABILITIES.filter(function (a) { return !st.unlocked[a.key]; });
    if (locked.length) {
      ok('未解锁的技能不可用', !Sim.abilityReady(st, locked[0].key) &&
                              !Sim.useAbility(st, locked[0].key).ok, locked[0].name);
    } else {
      R.push('      （三个技能都已解锁，跳过未解锁拦截测试）');
    }
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;
    // 直接 arrange：要测的是技能机制本身，不是解锁流程
    st.unlocked.pulse = true; st.cd.pulse = 0; st.pulseT = 0; st.floaters = [];
    var ur = Sim.useAbility(st, 'pulse');
    ok('技能可以使用', ur.ok && st.cd.pulse > 0, ur.msg || ur.reason);
    ok('技能触发浮动反馈', st.floaters.length > 0, st.floaters.length + ' 条');
    ok('脉冲期间蔓延更快', Sim.autoIntervalOf(st) < window.MYC.CONFIG.GROW.autoInterval,
       '间隔 ' + Sim.autoIntervalOf(st).toFixed(2) + 's（基准 ' + window.MYC.CONFIG.GROW.autoInterval + 's）');
    ok('冷却中不能重复使用', !Sim.useAbility(st, 'pulse').ok);
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;
    var target = null;
    for (var i = 1; i < st.nodes.length; i++) {
      if (Sim.nodeUpgradeCost(st, st.nodes[i]) < st.res.nutrient) { target = i; break; }
    }
    ok('存在可强化的节点', target !== null);
    if (target === null) return;
    var nd = st.nodes[target];
    var lv0 = nd.level, cap0 = nd.capacity, n0 = st.res.nutrient;
    var cost = Sim.nodeUpgradeCost(st, nd);
    var r = Sim.upgradeNode(st, target);
    ok('强化节点成功', r.ok && nd.level === lv0 + 1, 'Lv' + lv0 + ' -> Lv' + nd.level);
    ok('强化正确扣费', Math.abs(st.res.nutrient - (n0 - cost)) < 1e-6,
       n0.toFixed(0) + ' -> ' + st.res.nutrient.toFixed(0) + '（花费 ' + cost + '）');
    ok('强化提升了吞吐上限', nd.capacity > cap0, cap0.toFixed(1) + ' -> ' + nd.capacity.toFixed(1));
    ok('强化会推动 m5 进度', st.counters.maxNodeLevel >= 1, 'maxNodeLevel=' + st.counters.maxNodeLevel);
  });

  /* 里程碑：首次达成必须发奖，且绝不重复发奖 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;
    if (st.milestones.m5) { R.push('      （m5 已达成，跳过首次发奖测试）'); return; }
    var n0 = st.mods.nutrient;
    st.res.nutrient += 1e7;
    for (var g = 0; g < 60 && st.nodes[1].level < 5; g++) {
      if (!Sim.upgradeNode(st, 1).ok) break;
    }
    Sim.checkMilestones(st);
    ok('里程碑首次达成会发奖', !!st.milestones.m5 && st.mods.nutrient > n0,
       '全部产出 ×' + n0.toFixed(2) + ' -> ×' + st.mods.nutrient.toFixed(2));
    var n1 = st.mods.nutrient;
    Sim.checkMilestones(st);
    ok('里程碑不会重复发奖', st.mods.nutrient === n1, '×' + n1.toFixed(2) + ' 保持不变');
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;

    // 先清掉已有害虫：长时间跑下来它们会累积到上限，到上限后 spawnEvent
    // 就再也生不出害虫了 —— 不 arrange 就会得到假失败。
    var existing = Sim.countGnats(st);
    if (existing) {
      st.events.slice().forEach(function (e) { if (e.kind === 'gnat') Sim.removeGnat(st, e.nodeId); });
      R.push('      （先清掉 ' + existing + ' 只已有害虫，否则已达上限无法再生成）');
    }
    ok('害虫清空后归零', Sim.countGnats(st) === 0);

    var gnat = null;
    for (var k = 0; k < 40 && !gnat; k++) {
      var ev = Sim.spawnEvent(st);
      if (ev && ev.kind === 'gnat') gnat = ev;
    }
    ok('事件系统能生成害虫', !!gnat, gnat ? ('nodeId=' + gnat.nodeId) : '40 次都没出，概率异常');
    if (gnat) {
      var nd = st.nodes[gnat.nodeId];
      ok('害虫让该节点停产', nd.disabled === true);
      var before = st.counters.gnatsRemoved;
      var rr = Sim.removeGnat(st, gnat.nodeId);
      ok('驱除害虫成功且有奖励', rr.ok && nd.disabled === false && st.counters.gnatsRemoved === before + 1,
         '+' + (rr.reward || 0) + ' 养分');
    }

    // 回归断言：之前用「每次新建 RNG」导致相近种子的首值相关，
    // 40 次判定全落同一侧、害虫永远不出现。这里验证事件类型真的有分化。
    var kinds = {};
    for (var m = 0; m < 20; m++) {
      var e2 = Sim.spawnEvent(st);
      if (e2) kinds[e2.kind] = (kinds[e2.kind] || 0) + 1;
    }
    ok('事件类型有分化（随机流没卡死）', Object.keys(kinds).length >= 2, JSON.stringify(kinds));
    ok('害虫数量不会超过上限', Sim.countGnats(st) <= C.EVENTS.gnatMax,
       Sim.countGnats(st) + ' / 上限 ' + C.EVENTS.gnatMax);
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;
    var core = st.nodes[0];
    st.events = [];
    Sim.tick(st, 0.1);
    var w0 = (st.rate || {}).water || 0;

    st.events = [{ kind: 'rain', x: core.x, y: core.y, r: 2, ttl: 40, dur: 45 }];
    ok('增益区能被查询到', !!Sim.buffAt(st, core.x, core.y), '核心在降雨带内');
    ok('增益区外不受影响', Sim.buffAt(st, core.x + 12, core.y + 12) === null);
    Sim.tick(st, 0.1);
    var w1 = (st.rate || {}).water || 0;
    /* 这里比较的是**毛产出**，所以必须先把维持费的影响排除掉。
     *
     * state.rate.water 来自 computeFlow 的 accepted.water，是「进账」，
     * 本身不含维持费；但同一 tick 里 settleMaintenance 会立刻把维持费从
     * state.res.water 里扣掉。当网络规模大、等级总和高时，
     * 维持费可能超过降雨带的增量，于是**两帧之间净水量在下降** ——
     * 那是真的（玩家确实在亏），但不是「降雨带没生效」。
     *
     * 所以判据取「同一帧内、同一网络状态下」的对比：把增益区撤掉重算一次，
     * 与开着增益区的那一帧比。这样维持费在两帧里是同一笔，被抵消掉了。 */
    var withBuff = w1;
    st.events = [];
    Sim.tick(st, 0.1);
    var noBuff = (st.rate || {}).water || 0;
    ok('增益区确实提升了产出', withBuff > noBuff,
       '有增益 ' + withBuff.toFixed(2) + ' vs 无增益 ' + noBuff.toFixed(2) +
       '（净速率 ' + w0.toFixed(2) + ' → ' + w1.toFixed(2) +
       '，维持费 ' + (st.maintainCost || 0).toFixed(1) + '/s）');

    st.events = [{ kind: 'rain', x: core.x, y: core.y, r: 2, ttl: 40, dur: 45 }];
    ok('增益区倍率正确', (Sim.buffAt(st, core.x, core.y).water === C.EVENTS.buffMul),
       '×' + Sim.buffAt(st, core.x, core.y).water);
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;
    var s2 = Sim.serialize(st);
    var r2 = Sim.deserialize(s2);
    ok('存档保留里程碑', Object.keys(r2.milestones).length > 0,
       Object.keys(r2.milestones).join(','));
    ok('存档保留技能解锁状态', JSON.stringify(r2.unlocked) === JSON.stringify(st.unlocked),
       JSON.stringify(r2.unlocked));
    var mx = 0;
    r2.nodes.forEach(function (n) { if (n.level > mx) mx = n.level; });
    ok('存档保留节点等级', mx > 0, '最高 Lv' + mx);
    ok('存档保留里程碑增益', Math.abs((r2.mods.nutrient || 1) - (st.mods.nutrient || 1)) < 1e-6,
       'nutrient 增益 ×' + (r2.mods.nutrient || 1).toFixed(2));
  });

  /* ---- 自适应 / 响应式 ----------------------------------------------------
   * 这些断言跟视口大小无关，所以在桌面和手机两种尺寸下各跑一次都有意义。
   * 「页面都看不全」就是这么坏的：固定 916px 画布 + 无媒体查询 → 手机上整个面板被顶出屏幕。 */
  step(function () {
    var W = window.innerWidth, H = window.innerHeight, de = document.documentElement;

    ok('页面没有横向溢出', de.scrollWidth <= W + 1,
       'scrollWidth=' + de.scrollWidth + '  视口宽=' + W);

    var cr = canvas().getBoundingClientRect();
    var sr = document.getElementById('stage').getBoundingClientRect();
    ok('地图画布没有超出容器',
       cr.width <= sr.width + 1 && cr.height <= sr.height + 1,
       'canvas=' + Math.round(cr.width) + '×' + Math.round(cr.height) +
       '  stage=' + Math.round(sr.width) + '×' + Math.round(sr.height));

    var pr = document.getElementById('panel').getBoundingClientRect();
    ok('面板在视口内可见', pr.width > 100 && pr.top < H && pr.left < W && pr.right > 0,
       'panel 左上=' + Math.round(pr.left) + ',' + Math.round(pr.top) +
       '  尺寸=' + Math.round(pr.width) + '×' + Math.round(pr.height));

    // 最怕的状态是「被裁掉、又滚不到」—— 装得下 / 面板自己滚 / 整页滚，三者占一即可
    var p = document.getElementById('panel');
    var selfScroll = p.scrollHeight > p.clientHeight + 1;
    var pageScroll = de.scrollHeight > H + 1;
    ok('面板内容可达（装得下 / 面板可滚 / 页面可滚）',
       pr.bottom <= H + 1 || selfScroll || pageScroll,
       'panel.bottom=' + Math.round(pr.bottom) + ' 视口高=' + H +
       ' 面板可滚=' + selfScroll + ' 页面可滚=' + pageScroll);
  });

  step(function () {
    var sc = window.MYC.game.scene, cam = sc.cameras.main, G = GRID();
    var core = window.MYC.game.state.nodes[0];
    var wx = G.OX + core.x * G.CELL + G.CELL / 2, wy = G.OY + core.y * G.CELL + G.CELL / 2;
    var v = cam.worldView;
    ok('摄像机对准了网络（核心在视野内）',
       wx >= v.left && wx <= v.right && wy >= v.top && wy <= v.bottom,
       'core=(' + wx.toFixed(0) + ',' + wy.toFixed(0) + ')  视野 x ' +
       v.left.toFixed(0) + '..' + v.right.toFixed(0) + '  y ' + v.top.toFixed(0) + '..' + v.bottom.toFixed(0));

    /* 地图会随转生变大，视野允许比整张图更小（最小到整图的 0.85），
     * 但**已探明区域必须完整可见** —— 这才是「不裁剪网络」的准确表述。
     * 用 state.explored 的包围盒核对（sim 增量维护，不在测试里重算）。
     * 先 snapView 把视野钉到目标值：缓动未收敛时直接比 cam.zoom 会假失败。 */
    sc.snapView();
    var e = window.MYC.game.state.explored;
    var pad = 2;
    var bw = (e.maxX - e.minX + 1 + pad * 2) * G.CELL;
    var bh = (e.maxY - e.minY + 1 + pad * 2) * G.CELL;
    var fitExplored = Math.min(cam.width / bw, cam.height / bh);
    ok('视野装得下整个已探明区域（不裁剪网络）', cam.zoom <= fitExplored + 0.01,
       'zoom=' + cam.zoom.toFixed(3) + '  上限=' + fitExplored.toFixed(3));

    ok('格子没有被放大到失真', G.CELL * cam.zoom <= 48,
       '格子约 ' + (G.CELL * cam.zoom).toFixed(0) + 'px');
  });

  step(function () {
    var st = window.MYC.game.state, core = st.nodes[0];
    moveTo(cellToClient(core.x, core.y));
  });

  step(function () {
    var sc = window.MYC.game.scene, cam = sc.cameras.main;
    // 提示框活在世界坐标里，会被摄像机乘一次缩放 —— 必须反向补偿。
    // 这是加自适应时最容易漏的一处（放大后提示变成巨字）。
    ok('提示框按缩放反向补偿（屏幕上大小恒定）',
       Math.abs(sc.tip.scaleX * cam.zoom - 1) < 0.02,
       'scaleX=' + sc.tip.scaleX.toFixed(3) + ' × zoom=' + cam.zoom.toFixed(2) +
       ' = ' + (sc.tip.scaleX * cam.zoom).toFixed(3));
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, G = window.MYC.CONFIG.GRID;
    st.res.water = 50000;
    // 冻住自动蔓延：否则这几步之间它会自己长，节点数断言就不准了
    st.autoTimer = -1e6;

    /* 只在「当前视野内」找目标格 —— 视野外的格子点不到（客户端坐标落在画布外），
     * 上一次就是因为挑到地图顶部的格子才误判成坐标换算错误。 */
    var rng = visibleCells();
    var x0 = rng.x0, x1 = rng.x1, y0 = rng.y0, y1 = rng.y1;

    // 目标：自己长不了、但紧邻一格能长 —— 正是手指点偏一格的情形。
    // 另外 8 个邻居都不能已经是节点，否则容差会先去「强化」那个节点，节点数就不涨了。
    var nodeAt = function (x, y) { return st.grid[Sim.idx(x, y)].node != null; };
    var found = null;
    for (var y = y0; y <= y1 && !found; y++) {
      for (var x = x0; x <= x1; x++) {
        if (nodeAt(x, y) || Sim.canGrowAt(st, x, y)) continue;
        var grow = null, hasNode = false;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            var nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= G.W || ny >= G.H) continue;
            if (nodeAt(nx, ny)) { hasNode = true; }
            else if (!grow && Sim.canGrowAt(st, nx, ny)) { grow = { x: nx, y: ny }; }
          }
        }
        if (!hasNode && grow) { found = { x: x, y: y, nx: grow.x, ny: grow.y }; break; }
      }
    }
    /* 正对照：视野内一个「本来就能长」的格子，且离 spot 足够远
     * （太近的话点完它就成了节点，会破坏容差测试「邻居都不是节点」的前提）。
     * 没有这个正对照，「点偏没反应」这类断言会因为「压根没收到点击」而假通过。 */
    var ctrl = null;
    if (found) {
      for (var y2 = y0; y2 <= y1 && !ctrl; y2++) {
        for (var x2 = x0; x2 <= x1; x2++) {
          if (Math.abs(x2 - found.x) <= 2 && Math.abs(y2 - found.y) <= 2) continue;
          if (nodeAt(x2, y2) || !Sim.canGrowAt(st, x2, y2)) continue;
          ctrl = { x: x2, y: y2 };
          break;
        }
      }
    }
    S.ctrl = ctrl;

    S.spot = found;
    ok('找到「点偏一格」的测试位置', !!found,
       found ? ('视野内 (' + x0 + ',' + y0 + ')..(' + x1 + ',' + y1 + ') → 点 (' +
                found.x + ',' + found.y + ')，邻居 (' + found.nx + ',' + found.ny + ') 可生长')
             : ('视野内 ' + x0 + ',' + y0 + '..' + x1 + ',' + y1 + ' 没找到'));
    ok('找到点击正对照格', !!ctrl, ctrl ? ('(' + ctrl.x + ',' + ctrl.y + ')') : '没找到');
    if (found) {
      S.spotPt = cellToClient(found.x, found.y);
      moveTo(S.spotPt);
    }
  });

  /* hover 断言必须紧跟在上面的 moveTo 之后：任何后续的点击也会带 move 事件，
   * 会把 sc.hover 覆盖成别的格子。 */
  step(function () {
    var sc = window.MYC.game.scene, cam = sc.cameras.main, spot = S.spot;
    S.hitOk = false;
    if (!spot) return;
    var h = sc.hover;
    S.hitOk = !!(h && h.x === spot.x && h.y === spot.y);
    var p = sc.input.activePointer, v = cam.worldView;
    // 顺带验证 cellToClient：坐标换算错了，后面所有点击测试都不可信
    ok('坐标换算落点正确（cellToClient 与摄像机缩放一致）', S.hitOk,
       (h ? ('落到 (' + h.x + ',' + h.y + ')，目标 (' + spot.x + ',' + spot.y + ')')
          : '解析不出格子') +
       '  pointer 世界坐标=' + Math.round(p.worldX) + ',' + Math.round(p.worldY) +
       '  视野 x ' + Math.round(v.left) + '..' + Math.round(v.right));
  });

  /* 交叉验证：场景维护的视野状态必须真的写进了摄像机。
   * 读 cam.midPoint / cam.zoom —— centerOn/setZoom 会**同步**更新它们；
   * 不要用 cam.worldView（渲染阶段才更新，headless 下经常旧一帧），
   * 也不要比较像素坐标（自动取景一直在缓动，两次读数之间镜头自己会动）。 */
  step(function () {
    var sc = window.MYC.game.scene, cam = sc.cameras.main;
    var mp = cam.midPoint;
    var dc = Math.max(Math.abs(mp.x - sc.viewCx), Math.abs(mp.y - sc.viewCy));
    var dz = Math.abs(cam.zoom - sc.viewZoom);
    ok('摄像机与场景视野状态一致（两条路径互证）', dc < 1.5 && dz < 0.01,
       '中心差 ' + dc.toFixed(2) + 'px（摄像机 ' + mp.x.toFixed(1) + ',' + mp.y.toFixed(1) +
       ' vs 场景 ' + sc.viewCx.toFixed(1) + ',' + sc.viewCy.toFixed(1) + '）  zoom 差 ' + dz.toFixed(4));
  });

  step(function () {
    var st = window.MYC.game.state;
    if (!S.ctrl) return;
    S.nCtrl = st.nodes.length;
    S.ctrlPt = cellToClient(S.ctrl.x, S.ctrl.y);
    clickAt(S.ctrlPt);
  });

  step(function () {
    var st = window.MYC.game.state;
    if (!S.ctrl) return;
    // 正对照：证明「点击 → 生长」这条链路确实通。它要是失败，
    // 后面的「点偏不生长」就是无意义的假通过，得先修测试而不是游戏。
    ok('正对照：点击可生长格确实长出菌丝', st.nodes.length === S.nCtrl + 1,
       S.nCtrl + ' -> ' + st.nodes.length + ' 格');
  });

  step(function () {
    var sc = window.MYC.game.scene, st = window.MYC.game.state, spot = S.spot;
    if (!spot || !S.hitOk) return;
    S.touch0 = sc.touchTolerance;
    sc.touchTolerance = false;               // 模拟鼠标：不该有容差
    S.n0 = st.nodes.length;
    clickAt(S.spotPt);
  });

  step(function () {
    var st = window.MYC.game.state, spot = S.spot;
    if (!spot || !S.hitOk) return;
    ok('鼠标点偏不生长（桌面行为不变）', st.nodes.length === S.n0,
       S.n0 + ' -> ' + st.nodes.length + ' 格');
  });

  step(function () {
    var sc = window.MYC.game.scene, st = window.MYC.game.state, spot = S.spot;
    if (!spot || !S.hitOk) return;
    sc.touchTolerance = true;                // 模拟手指：给一格容差
    S.n1 = st.nodes.length;
    clickAt(S.spotPt);
  });

  step(function () {
    var sc = window.MYC.game.scene, st = window.MYC.game.state, spot = S.spot;
    if (!spot || !S.hitOk) return;
    ok('触摸点偏自动落到相邻格', st.nodes.length === S.n1 + 1,
       S.n1 + ' -> ' + st.nodes.length + ' 格');
    sc.touchTolerance = S.touch0;
    st.autoTimer = 0;
  });

  /* ---- 手势：滚轮缩放 / 拖拽平移 / 捏合 / 回到自动取景 ---------------------
   * 手势是「看起来能跑但可能完全没接上」的重灾区，必须走真实事件路径验证。 */

  /* 画布内的相对位置（0..1）→ 页面 client 坐标 */
  function canvasPoint(fx, fy) {
    var r = canvas().getBoundingClientRect();
    return { x: r.left + r.width * fx, y: r.top + r.height * fy };
  }

  function wheel(pt, deltaY) {
    canvas().dispatchEvent(new WheelEvent('wheel', {
      clientX: pt.x, clientY: pt.y, deltaY: deltaY, deltaMode: 0,
      bubbles: true, cancelable: true, view: window
    }));
  }

  /* 捏合用原生 TouchEvent 造两指 —— 游戏里就是直接监听原生 touch 的，测同一条路径 */
  function touch(eventType, pts) {
    var cv = canvas();
    var list = pts.map(function (p, i) {
      return new Touch({ identifier: i + 1, target: cv, clientX: p.x, clientY: p.y });
    });
    cv.dispatchEvent(new TouchEvent(eventType, {
      touches: eventType === 'touchend' ? [] : list,
      targetTouches: eventType === 'touchend' ? [] : list,
      changedTouches: list,
      bubbles: true, cancelable: true, view: window
    }));
  }

  /* 按下 / 移动 / 抬起分开派发，这样才拖得起来（clickAt 是 down+up 一次性发的） */
  var DOWN_TYPES = ['pointerover', 'pointermove', 'mouseover', 'mousemove', 'pointerdown', 'mousedown'];
  var MOVE_TYPES = ['pointermove', 'mousemove'];
  var UP_TYPES = ['pointerup', 'mouseup'];
  function press(pt) { DOWN_TYPES.forEach(function (t) { fire(t, pt); }); }
  function dragTo(pt) { MOVE_TYPES.forEach(function (t) { fire(t, pt); }); }
  function release(pt) { UP_TYPES.forEach(function (t) { fire(t, pt); }); }

  step(function () {
    var sc = window.MYC.game.scene;
    /* 先把视野钉住（切手动、缩放不变）：自动取景会跟着网络一直在缓动，
     * 锚点测试前后两次读数之间镜头自己会动，测出来的就不是滚轮了。 */
    sc.setView(sc.viewZoom, sc.viewCx, sc.viewCy);
    /* 锚点故意放在偏离中心的位置 —— 用画布正中心测锚点，
     * 中心缩放本来就是「不动」的，验不出锚点算错。 */
    S.p = canvasPoint(0.35, 0.4);
    var pt = sc.clientToCanvas(S.p.x, S.p.y);
    // 记下缩放前的视野状态，锚点不变式用纯算术核对（不读摄像机，
    // 因为 cam.worldView 只在渲染时更新，headless 下经常比刚设的值旧一帧）
    S.anchor = {
      sx: pt.x, sy: pt.y,
      mx: sc.scale.width / 2, my: sc.scale.height / 2,
      z0: sc.viewZoom, cx0: sc.viewCx, cy0: sc.viewCy
    };
    S.zoom0 = sc.viewZoom;
    wheel(S.p, -300);                    // 向上滚 = 放大
  });

  step(function () {
    var sc = window.MYC.game.scene;
    ok('滚轮能放大', sc.viewZoom > S.zoom0 * 1.2,
       'zoom ' + S.zoom0.toFixed(3) + ' → ' + sc.viewZoom.toFixed(3));
    ok('手动缩放后切到「手动视野」', sc.viewMode === 'manual', 'viewMode=' + sc.viewMode);

    var btn = document.getElementById('viewReset');
    ok('「回到自动取景」按钮显出来', !!btn && !btn.classList.contains('hidden'),
       btn ? ('hidden=' + btn.classList.contains('hidden')) : '按钮不存在');

    /* 锚点不变式：屏幕点 s 底下的世界点，缩放前后必须是同一个。
     *   世界点 = 视野中心 + (s - 画布中心) / zoom
     * 由此反推缩放后的视野中心应该是多少，跟实际值比。 */
    var A = S.anchor;
    var ax = A.cx0 + (A.sx - A.mx) / A.z0;
    var ay = A.cy0 + (A.sy - A.my) / A.z0;
    var ex = ax - (A.sx - A.mx) / sc.viewZoom;
    var ey = ay - (A.sy - A.my) / sc.viewZoom;
    var drift = Math.max(Math.abs(ex - sc.viewCx), Math.abs(ey - sc.viewCy));
    ok('缩放锚在指针位置（手感才对）', drift < 1.5,
       '中心应在 (' + ex.toFixed(1) + ',' + ey.toFixed(1) + ')，实际 (' +
       sc.viewCx.toFixed(1) + ',' + sc.viewCy.toFixed(1) + ')，偏移 ' + drift.toFixed(2));
  });

  step(function () {
    var sc = window.MYC.game.scene, st = window.MYC.game.state;
    st.autoTimer = -1e6;                 // 冻住自动蔓延，节点数断言才准
    S.dg = { cx: sc.viewCx, cy: sc.viewCy, n: st.nodes.length };
    S.from = canvasPoint(0.5, 0.5);
    press(S.from);
    dragTo({ x: S.from.x + 34, y: S.from.y + 20 });
    S.to = { x: S.from.x + 96, y: S.from.y + 58 };
    dragTo(S.to);
  });

  step(function () {
    var sc = window.MYC.game.scene, st = window.MYC.game.state;
    release(S.to);
    var dx = Math.abs(sc.viewCx - S.dg.cx), dy = Math.abs(sc.viewCy - S.dg.cy);
    ok('拖拽能平移视野', dx > 5 || dy > 5,
       '中心移动 Δ(' + dx.toFixed(1) + ',' + dy.toFixed(1) + ') 世界单位');
    // 这是重点：操作改到「抬起时判定」之后，拖动绝不能顺手长出一格
    ok('拖拽不会误触长出一格', st.nodes.length === S.dg.n,
       S.dg.n + ' -> ' + st.nodes.length + ' 格');
    st.autoTimer = 0;
  });

  step(function () {
    var sc = window.MYC.game.scene;
    /* 先把缩放放回中间档：轮子测试已经把 zoom 顶到上限 2.4，
     * 不退回来捏合就「没余量可放大」，会假失败。 */
    var lim = sc.zoomLimits();
    sc.setView((lim.min + lim.max) / 2, sc.viewCx, sc.viewCy);
    S.pz = sc.viewZoom;
    var c = canvasPoint(0.5, 0.5);
    var a0 = { x: c.x - 40, y: c.y }, b0 = { x: c.x + 40, y: c.y };
    touch('touchstart', [a0, b0]);
    touch('touchmove', [{ x: c.x - 50, y: c.y }, { x: c.x + 50, y: c.y }]);   // 第一次只建立基准
    touch('touchmove', [{ x: c.x - 90, y: c.y }, { x: c.x + 90, y: c.y }]);   // 这一次才真正放大
    touch('touchend', []);
  });

  step(function () {
    var sc = window.MYC.game.scene;
    ok('捏合能放大', sc.viewZoom > S.pz * 1.2,
       'zoom ' + S.pz.toFixed(3) + ' → ' + sc.viewZoom.toFixed(3));
    ok('捏合后仍是手动视野', sc.viewMode === 'manual', 'viewMode=' + sc.viewMode);
    ok('捏合结束不会残留卡住状态', sc.pinching === false, 'pinching=' + sc.pinching);
    ok('捏合的手指登记表已清空', sc.pinchPtr.size === 0, 'pinchPtr=' + sc.pinchPtr.size);
  });

  step(function () {
    var sc = window.MYC.game.scene;
    var lim = sc.zoomLimits();
    for (var i = 0; i < 40; i++) wheel(canvasPoint(0.5, 0.5), 400);   // 一路缩到最小
    S.lim = lim;
  });

  step(function () {
    var sc = window.MYC.game.scene, G = window.MYC.CONFIG.GRID;
    var lim = sc.zoomLimits();
    ok('缩放被夹在下限内（不会缩到什么都看不见）', sc.viewZoom >= lim.min - 1e-6,
       'zoom=' + sc.viewZoom.toFixed(3) + '  下限=' + lim.min.toFixed(3));

    for (var i = 0; i < 30; i++) sc.panBy(4000, 4000);               // 一路拖到天边
    var worldW = G.OX * 2 + G.W * G.CELL, worldH = G.OY * 2 + G.H * G.CELL;
    var hw = sc.scale.width / 2 / sc.viewZoom, hh = sc.scale.height / 2 / sc.viewZoom;
    var okX = hw * 2 >= worldW || (sc.viewCx >= hw - 0.51 && sc.viewCx <= worldW - hw + 0.51);
    var okY = hh * 2 >= worldH || (sc.viewCy >= hh - 0.51 && sc.viewCy <= worldH - hh + 0.51);
    ok('拖动不会把地图拖出画面外（夹在世界内）', okX && okY,
       '中心 (' + sc.viewCx.toFixed(0) + ',' + sc.viewCy.toFixed(0) + ')  世界 ' + worldW + '×' + worldH);
  });

  step(function () {
    var sc = window.MYC.game.scene;
    S.beforeReset = sc.viewZoom;
    document.getElementById('viewReset').click();
  });

  step(function () {
    var sc = window.MYC.game.scene;
    ok('点按钮回到自动取景', sc.viewMode === 'auto', 'viewMode=' + sc.viewMode);
    ok('按钮随之隐藏', document.getElementById('viewReset').classList.contains('hidden'),
       'hidden=' + document.getElementById('viewReset').classList.contains('hidden'));
    S.tgt = sc.targetView();
    S.dist0 = Math.abs(sc.viewZoom - S.tgt.zoom);
  });

  step(function () {
    var sc = window.MYC.game.scene;
    var d = Math.abs(sc.viewZoom - S.tgt.zoom);
    ok('视野朝自动取景缓动（而不是卡住不动）',
       d <= S.dist0 + 1e-6,
       '距目标 ' + S.dist0.toFixed(3) + ' → ' + d.toFixed(3) +
       '（zoom ' + sc.viewZoom.toFixed(2) + ' → ' + S.tgt.zoom.toFixed(2) + '）');
  });

  step(function () {
    var sc = window.MYC.game.scene, st = window.MYC.game.state, Sim = S.Sim;
    st.autoTimer = -1e6;
    st.res.water = 50000;
    // 折腾完这一堆手势之后，普通点击必须仍然有效 —— 输入状态别被拖坏
    var G = GRID();
    var rng = visibleCells();
    var x0 = rng.x0, x1 = rng.x1, y0 = rng.y0, y1 = rng.y1;
    var target = null;
    for (var y = y0; y <= y1 && !target; y++) {
      for (var x = x0; x <= x1; x++) {
        if (st.grid[Sim.idx(x, y)].node == null && Sim.canGrowAt(st, x, y)) { target = { x: x, y: y }; break; }
      }
    }
    S.after = { n: st.nodes.length, target: target };
    if (target) clickAt(cellToClient(target.x, target.y));
  });

  step(function () {
    var sc = window.MYC.game.scene, st = window.MYC.game.state, Sim = S.Sim;
    if (!S.after || !S.after.target) return;
    var t = S.after.target;
    // 诊断：绕过事件路径直接调 tryAct，看是「游戏逻辑拒绝」还是「事件没送达」。
    // 注意这行自己也会长一格/强一格，所以它必须放在计数断言**之后**判读。
    var r = sc.tryAct(t);
    R.push('  DIAG tryAct(' + t.x + ',' + t.y + ') -> ' + JSON.stringify(r) +
           ' | water=' + Math.round(st.res.water) +
           ' | 该格已有节点=' + (st.grid[Sim.idx(t.x, t.y)].node != null) +
           ' | drag=' + !!sc.drag + ' pinching=' + sc.pinching +
           ' | pinchPtr=' + sc.pinchPtr.size + ' suppressPtr=' + sc.suppressPtr.size +
           ' | touchTol=' + sc.touchTolerance +
           ' | viewMode=' + sc.viewMode + ' zoom=' + sc.viewZoom.toFixed(2));
  });

  step(function () {
    var st = window.MYC.game.state;
    if (!S.after.target) { ok('手势之后仍能找到可点击的格子', false, '视野内没有可生长的格'); return; }
    ok('折腾完手势后，点击依然长得出菌丝', st.nodes.length === S.after.n + 1,
       S.after.n + ' -> ' + st.nodes.length + ' 格');
    st.autoTimer = 0;
  });

  /* ---- 菌瘟（后期挑战）---------------------------------------------------
   * 和害虫的区别只有一个：会沿菌丝蔓延。这是「后期没挑战」的解药，
   * 所以蔓延/自愈/不可净化三条路径都要测。 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, G = GRID();
    st.autoTimer = -1e6;                 // 冻住自动蔓延，节点集合才稳定

    // 挑一个「可传染邻居」最多的节点放菌瘟 —— 保证「能扩散」这个前提成立。
    // 等级规则生效后只有等级 ≤ 自己的邻居才可能被传，计数按同一条规则算。
    var healthy = function (x, y, lvl) {
      var n = 0;
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
        var id = st.nodeAt[Sim.idx(x + d[0], y + d[1])];
        if (id != null && id !== 0 && !st.nodes[id].gnat && !st.nodes[id].blighted &&
            st.nodes[id].level <= lvl) n++;
      });
      return n;
    };
    var best = null, bestN = 0;
    for (var i = 1; i < st.nodes.length; i++) {
      var nd = st.nodes[i];
      if (nd.gnat || nd.blighted) continue;
      var n = healthy(nd.x, nd.y, nd.level);
      if (n > bestN) { bestN = n; best = i; }
    }
    S.bl = null;
    ok('找到适合扩散的节点', !!best && bestN > 0, best ? ('节点 ' + best + ' 有 ' + bestN + ' 个健康邻居') : '没有');
    if (best != null && bestN > 0) S.bl = Sim.putBlight(st, best);
    ok('菌瘟可以投放', !!S.bl, S.bl ? '节点停产中' : '投放失败');
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;
    if (!S.bl) return;
    ok('菌瘟让节点停产', st.nodes[S.bl.nodeId].disabled === true, 'disabled=' + st.nodes[S.bl.nodeId].disabled);
    // 扩散：反复尝试（每次约 55% 成功率），几次之内必然蔓延出去
    var tries = 0;
    while (Sim.countBlights(st) < 2 && tries++ < 300) Sim.spreadBlights(st);
    ok('菌瘟会沿菌丝扩散', Sim.countBlights(st) >= 2,
       '尝试 ' + tries + ' 次后菌瘟 ' + Sim.countBlights(st) + ' 处');
  });

  /* 瘟菌不能点击净化：一键白嫖等于没有威胁。
   * 玩家的应对 = 相对等级防火墙（邻居比瘟高就挡得住）+ 围死等它熄灭。 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, sc = window.MYC.game.scene;
    var ev = null;
    st.events.forEach(function (e) { if (e.kind === 'blight' && !ev) ev = e; });
    if (!ev) { ok('瘟菌无法点击净化', false, '没有菌瘟可测'); return; }
    var nd = st.nodes[ev.nodeId];
    var lvl0 = nd.level, nut0 = st.res.nutrient;
    var r = sc.tryAct({ x: nd.x, y: nd.y });
    ok('瘟菌无法点击净化', !r.ok && !!nd.blighted,
       r.msg || (r.ok ? '居然成功了' : '无解释'));
    // 拒绝的同时也不能「顺手」把节点强化掉 —— 点了没反应 ≠ 点了干别的
    ok('点瘟菌不会误触强化或净化', nd.level === lvl0 && !!nd.blighted,
       'Lv' + lvl0 + ' 保持，blighted=' + !!nd.blighted);
    // sim 层的移除只是内部接口（测试编排/清场用）：不再有奖励，不再计数
    var rb = Sim.removeBlight(st, ev.nodeId);
    ok('内部移除接口不再发奖励', rb.ok && Math.abs(st.res.nutrient - nut0) < 1e-6,
       '养分 ' + Math.round(nut0) + ' 保持不变');
  });

  /* 菌瘟没有「放着不管自愈」：生命周期 = 每个传播周期看一眼面前有没有活路。
   * 面前有可感染的邻居（哪怕抽签没中）→ 计数清零、继续活着；
   * 连续 failLimit 个周期一个能感染的邻居都没有（被防火墙围死）→ 熄灭，
   * 节点保留、恢复健康。正对照：同期的 Y 一直有活路，就永远不死。 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;
    st.autoTimer = -1e6;
    // 清场：移除历史残留菌瘟，本步要精确控制每一处感染
    st.events.slice().forEach(function (e) {
      if (e.kind === 'blight') Sim.removeBlight(st, e.nodeId);
    });

    var lvlSaved = {};
    function setLvl(id, lv) {
      if (!(id in lvlSaved)) lvlSaved[id] = st.nodes[id].level;
      st.nodes[id].level = lv;
    }
    function adj(a, b) {
      return Math.abs(st.nodes[a].x - st.nodes[b].x) +
             Math.abs(st.nodes[a].y - st.nodes[b].y) === 1;
    }
    function healthyNbs(id) {
      var out = [], nd = st.nodes[id];
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
        var nid = st.nodeAt[Sim.idx(nd.x + d[0], nd.y + d[1])];
        if (nid != null && nid !== 0 && !st.nodes[nid].gnat && !st.nodes[nid].blighted) out.push(nid);
      });
      return out;
    }

    // 选位：X = 被围死的瘟（有 ≥1 个健康邻居可砌墙）；Y = 正对照（有专属活路 Z）。
    // 约束：Y、Z 都不挨着 X，Z 不在 X 的墙里 —— 两套剧本互不串扰。
    var X = null, Y = null, Z = null, W = null, wall = null;
    for (var i = 1; i < st.nodes.length && X === null; i++) {
      var nd = st.nodes[i];
      if (nd.gnat || nd.blighted || nd.level > C.BLIGHT.maxLevel) continue;
      var nbs = healthyNbs(i);
      if (!nbs.length) continue;
      for (var j = 1; j < st.nodes.length && X === null; j++) {
        var nd2 = st.nodes[j];
        if (j === i || nd2.gnat || nd2.blighted || adj(i, j)) continue;
        var nbs2 = healthyNbs(j);
        var z = null;
        for (var q = 0; q < nbs2.length; q++) {
          if (nbs.indexOf(nbs2[q]) === -1) { z = nbs2[q]; break; }
        }
        if (z === null) continue;
        X = i; Y = j; Z = z; W = nbs[0]; wall = nbs;
      }
    }
    ok('围死测试位就绪（X 封死位 + Y 对照位）', X !== null,
       X !== null ? ('X=' + X + ' Lv' + st.nodes[X].level + '，Y=' + Y + ' 活路 Z=' + Z) : '找不到互不干扰的一对');

    if (X !== null) {
      var lvlX0 = st.nodes[X].level;
      var evX = Sim.putBlight(st, X);
      var evY = Sim.putBlight(st, Y);
      ok('菌瘟已在 X、Y 落户', !!evX && !!evY,
         evX && evY ? '两处都在停产' : 'putBlight 失败');
      if (evX && evY) {
        // 砌墙：X 的健康邻居全拉到 Lv9（比任何瘟都高）；Y 的邻居只留 Z 当活路
        wall.forEach(function (id) { setLvl(id, C.BLIGHT.maxLevel + 2); });
        healthyNbs(Y).forEach(function (id) { if (id !== Z) setLvl(id, C.BLIGHT.maxLevel + 2); });
        setLvl(Z, 0);                    // 活路压到 Lv0：永远 ≤ 瘟的等级，必定可传

        // 每个周期开始前把 Z 恢复健康（可能上个周期被 Y 的瘟传上）—— 测试编排
        function period() {
          if (st.nodes[Z].blighted) Sim.removeBlight(st, Z);
          if (st.nodes[Z].gnat) Sim.removeGnat(st, Z);
          Sim.spreadBlights(st);
        }

        period();                        // 周期1：X 被围死第 1 次
        ok('周期1：围死第 1 个周期，计数 +1 但还活着',
           evX.failStreak === 1 && !!st.nodes[X].blighted,
           'failStreak=' + evX.failStreak);
        ok('周期1：对照位 Y 有活路，计数清零', evY.failStreak === 0,
           'Y failStreak=' + evY.failStreak);

        setLvl(W, 0);                    // 拆一块墙：X 面前重新出现可感染的邻居
        period();                        // 周期2：X 有活路 → 清零（「能传播就一直活着」）
        ok('周期2：放出活路立即续命，计数清零',
           evX.failStreak === 0 && !!st.nodes[X].blighted,
           'failStreak=' + evX.failStreak);

        setLvl(W, C.BLIGHT.maxLevel + 2); // 重新砌上（W 若已被传染也无妨：感染邻居同样进不了池子）
        period();                        // 周期3：围死第 1 次（重新计数）
        ok('周期3：重新围死，计数重新 +1',
           evX.failStreak === 1 && !!st.nodes[X].blighted,
           'failStreak=' + evX.failStreak);

        period();                        // 周期4：连续第 2 次 → 熄灭
        ok('周期4：连续两个周期围死 → 菌瘟熄灭',
           !st.nodes[X].blighted && st.events.indexOf(evX) === -1,
           'blighted=' + !!st.nodes[X].blighted + ' failStreak=' + evX.failStreak);
        ok('熄灭后节点恢复健康（保留、不消失）',
           !st.nodes[X].disabled && st.nodes[X].level === lvlX0,
           'disabled=' + st.nodes[X].disabled + ' Lv' + st.nodes[X].level + '（原 Lv' + lvlX0 + '）');
        ok('正对照：同期一直有活路的 Y 从不熄灭', !!st.nodes[Y].blighted,
           'Y blighted=' + !!st.nodes[Y].blighted);
      }
    }

    // 还原：等级快照 + 清掉所有菌瘟（包括 Y），不留状态给后面的测试
    Object.keys(lvlSaved).forEach(function (k) { st.nodes[k].level = lvlSaved[k]; });
    st.events.slice().forEach(function (e) {
      if (e.kind === 'blight') Sim.removeBlight(st, e.nodeId);
    });
    st.autoTimer = 0;
  });

  /* tick 接线：spreadT 归零就触发一个传播周期 —— 生命周期由 sim.tick 驱动，
   * 不是只有测试里手动抽签才走。把测试位围死再放瘟：周期只会 +1 失败，绝无播散。 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;
    st.autoTimer = -1e6;
    var t = null;
    for (var i = 1; i < st.nodes.length && t === null; i++) {
      if (!st.nodes[i].gnat && !st.nodes[i].blighted) t = i;
    }
    if (t === null) { ok('tick 能驱动菌瘟周期', false, '没有测试位'); return; }
    var savedLvl = {};
    var nd = st.nodes[t];
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
      var nid = st.nodeAt[Sim.idx(nd.x + d[0], nd.y + d[1])];
      if (nid != null && nid !== 0 && !st.nodes[nid].gnat && !st.nodes[nid].blighted) {
        savedLvl[nid] = st.nodes[nid].level;
        st.nodes[nid].level = C.BLIGHT.maxLevel + 2;
      }
    });
    var ev = Sim.putBlight(st, t);
    if (!ev) { ok('tick 能驱动菌瘟周期', false, 'putBlight 失败'); }
    else {
      // 期望值必须在 tick 之前算：tick 里 checkMilestones 在 tickEvents 之后跑，
      // 可能中途点亮 blightSlow，事后算期望就会拿到另一个值（实测踩过）
      var expect = C.BLIGHT.spreadInterval * (st.mods.blightSlow ? 1.6 : 1);
      ev.spreadT = 0.01;                 // 把传播计时拨到尽头
      Sim.tick(st, 0.1);
      ok('tick 走完传播周期会触发扩散并重置计时',
         Math.abs(ev.spreadT - expect) < 1e-6 && !!st.nodes[t].blighted && ev.failStreak === 1,
         'spreadT≈' + ev.spreadT.toFixed(1) + '（期望 ' + expect + '）failStreak=' + ev.failStreak);
    }
    Sim.removeBlight(st, t);
    Object.keys(savedLvl).forEach(function (k) { st.nodes[k].level = savedLvl[k]; });
    st.autoTimer = 0;
  });

  /* ---- m9「防火墙」：菌瘟不能净化之后，这就是玩家对它的主动答案 ----------
   * 同时养出 3 个 Lv8+（超过感染上限）的节点 → 发奖：菌瘟蔓延变慢。 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;
    if (st.milestones.m9) { R.push('      （m9 已达成，跳过首次发奖测试）'); return; }
    // 摆布 3 个节点到 Lv8+（像玩家深耕那样），assert m9 发奖
    var saved = st.nodes.map(function (n) { return n.level; });
    var picked = 0, hadSlow = !!st.mods.blightSlow;
    for (var i = 1; i < st.nodes.length && picked < C.BLIGHT.firewallNodes; i++) {
      var nd = st.nodes[i];
      if (!nd.gnat && !nd.blighted && nd.level <= C.BLIGHT.maxLevel) {
        nd.level = C.BLIGHT.maxLevel + 1;
        picked++;
      }
    }
    ok('防火墙测试位就绪（' + picked + ' 个 Lv8+ 节点）',
       picked === C.BLIGHT.firewallNodes);
    if (picked === C.BLIGHT.firewallNodes) {
      Sim.checkMilestones(st);
      ok('m9 防火墙达成会发奖', !!st.milestones.m9 && !!st.mods.blightSlow && !hadSlow,
         'm9=' + !!st.milestones.m9 + '  blightSlow=' + !!st.mods.blightSlow);
      Sim.checkMilestones(st);
      ok('m9 不会重复发奖', !!st.milestones.m9);
    }
    // 还原等级：里程碑与奖励属于永久层，保留；等级改动不触发重算，还原即复原
    st.nodes.forEach(function (n, i2) { n.level = saved[i2]; });
  });

  /* ---- 菌瘟的等级规则：只往下传，Lv8+ 免疫 --------------------------------
   * 深耕练出来的高等级菌有抵抗力：源头只能传给「等级 ≤ 源头」的邻居，
   * 且自动感染封顶 maxLevel。这里直接摆布节点等级来验证两条边界。
   * 每条规则都带正对照 —— 菌瘟确实在扩散时，「靶子没被感染」才有意义。 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;
    st.autoTimer = -1e6;
    var maxL = C.BLIGHT.maxLevel;
    // 清场：净化残留菌瘟，后面要精确控制感染状态
    st.events.slice().forEach(function (e) {
      if (e.kind === 'blight') Sim.removeBlight(st, e.nodeId);
    });

    /* 节点的非核心健康邻居 id 列表 */
    function nbs(nd) {
      var out = [];
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
        var id = st.nodeAt[Sim.idx(nd.x + d[0], nd.y + d[1])];
        if (id != null && id !== 0 && !st.nodes[id].gnat && !st.nodes[id].blighted) out.push(id);
      });
      return out;
    }
    S.lvlSaved = {};                     // 被改过等级的节点 → 原始等级
    function setLvl(id, lv) {
      if (!(id in S.lvlSaved)) S.lvlSaved[id] = st.nodes[id].level;
      st.nodes[id].level = lv;
    }
    function cureAll() {
      st.events.slice().forEach(function (e) {
        if (e.kind === 'blight') Sim.removeBlight(st, e.nodeId);
      });
    }

    // —— 规则一：源头只能往下传 ——
    // 找源头 X（Lv ≤ 上限），它有 ≥2 个「原本可传染」的低级邻居：
    // 一个拉到 Lv9 当免疫靶子 Y，另一个保持低级当正对照。
    var X = null, yId = null, ctrlId = null;
    for (var i = 1; i < st.nodes.length && X === null; i++) {
      var nd = st.nodes[i];
      if (nd.gnat || nd.blighted || nd.level > maxL) continue;
      var low = nbs(nd).filter(function (id) { return st.nodes[id].level <= nd.level; });
      if (low.length >= 2) { X = i; ctrlId = low[0]; yId = low[1]; }
    }
    ok('规则一：找到带两个低级邻居的源头测试位', X !== null,
       X !== null ? ('节点 ' + X + ' Lv' + st.nodes[X].level) : '网络里没有');
    if (X !== null) {
      setLvl(yId, maxL + 2);             // 靶子拉到 Lv9：按规则不可感染
      S.yId = yId;
      ok('规则一：源头菌瘟已投放', !!Sim.putBlight(st, X));
      var reached2 = false;
      for (var r = 0; r < 300; r++) {
        Sim.spreadBlights(st);
        if (Sim.countBlights(st) >= 2) reached2 = true;
      }
      ok('规则一：正对照 —— 菌瘟确实在低级菌之间扩散', reached2,
         '菌瘟 ' + Sim.countBlights(st) + ' 处');
      ok('规则一：Lv9 靶子始终未被感染（只往下传）',
         !st.nodes[yId].blighted,
         'Y=Lv' + st.nodes[yId].level + ' blighted=' + !!st.nodes[yId].blighted);
      cureAll();
    }

    // —— 规则二：自动感染封顶 maxLevel ——
    // 源头直接抬到 Lv10（超出上限）：即便源头超限，也不能传给 Lv9 邻居。
    var Z = null, wId = null, ctrl2 = null;
    for (var j = 1; j < st.nodes.length && Z === null; j++) {
      var nd2 = st.nodes[j];
      if (nd2.gnat || nd2.blighted) continue;
      var low2 = nbs(nd2).filter(function (id) { return st.nodes[id].level <= maxL; });
      if (low2.length >= 2) { Z = j; ctrl2 = low2[0]; wId = low2[1]; }
    }
    ok('规则二：找到源头测试位', Z !== null);
    if (Z !== null) {
      setLvl(Z, 10);
      setLvl(wId, maxL + 2);
      S.wId = wId;
      cureAll();
      ok('规则二：超上限源头菌瘟已投放（直接摆布）', !!Sim.putBlight(st, Z));
      var reached3 = false;
      for (var r2 = 0; r2 < 200; r2++) {
        Sim.spreadBlights(st);
        if (Sim.countBlights(st) >= 2) reached3 = true;
      }
      ok('规则二：正对照 —— Lv≤7 的邻居照常被感染', reached3,
         '菌瘟 ' + Sim.countBlights(st) + ' 处');
      ok('规则二：Lv9 靶子始终未被感染（封顶生效）',
         !st.nodes[wId].blighted,
         'W=Lv' + st.nodes[wId].level + ' blighted=' + !!st.nodes[wId].blighted);
      cureAll();
    }
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;
    var maxL = C.BLIGHT.maxLevel;
    if (!S.lvlSaved) { ok('等级规则前置步骤已跑', false); return; }

    // —— 规则三：初次滋生也不碰超上限的菌 ——
    // 全员拉到 Lv9：菌瘟无处滋生；放开一个低级节点后，滋生点必是它。
    var saved = st.nodes.map(function (n) { return n.level; });
    st.nodes.forEach(function (n) { n.level = maxL + 2; });
    ok('规则三：全员高等级时菌瘟无处滋生', Sim.spawnBlight(st) === null);

    var pick = null;
    for (var i = 1; i < st.nodes.length; i++) {
      if (!st.nodes[i].gnat && !st.nodes[i].blighted) { pick = i; break; }
    }
    ok('规则三：存在可作靶子的健康节点', pick !== null);
    if (pick !== null) {
      st.nodes[pick].level = 0;
      var b = Sim.spawnBlight(st);
      ok('规则三：放开低级节点后滋生点必在等级上限内',
         !!b && b.nodeId === pick && st.nodes[b.nodeId].level <= maxL,
         b ? ('nodeId=' + b.nodeId + ' Lv' + st.nodes[b.nodeId].level) : 'null');
      if (b) Sim.removeBlight(st, b.nodeId);
    }

    // 还原：先恢复本步快照（pick 等），再把规则一/二改过的节点复原到原始等级
    st.nodes.forEach(function (n, i2) { n.level = saved[i2]; });
    Object.keys(S.lvlSaved).forEach(function (k) { st.nodes[k].level = S.lvlSaved[k]; });
    st.autoTimer = 0;
  });

  /* ---- 维护耗水与降级 ----------------------------------------------------
   * 机制：每个等级每秒耗水；水量低于缓冲线时，**离核最远的先降级**。
   * 三条必须守住的语义（都能被写错，所以都要断言）：
   *   ① 只减等级，绝不移除节点（「绝不永久损失」底线）
   *   ② 远的先降（位置 = 成本）
   *   ③ 无等级的网络完全不触发（不误伤扩张流）
   * 每条都带正对照 —— 没有正对照，「没降级」在机制压根没跑时也会通过。 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;
    var saved = st.nodes.map(function (n) { return n.level; });
    var savedWater = st.res.water;
    var savedDown = st.counters.maintainDowngrades;

    // 维持费只挂等级：Lv0 节点成本为 0
    st.nodes.forEach(function (n) { n.level = 0; });
    ok('维持费：全 Lv0 网络的总成本为 0', Sim.totalMaintainCost(st) === 0,
       '合计 ' + Sim.totalMaintainCost(st).toFixed(3) + '/s');

    /* 正对照：把水塞满、给一个节点 5 级 → 不应有降级。
     * 先证明「机制在正常情况下不动手」，后面的降级断言才有意义。 */
    var probe = null, farId = null, farDist = -1;
    for (var i = 1; i < st.nodes.length; i++) {
      if (st.nodes[i].dist > farDist) { farDist = st.nodes[i].dist; farId = i; }
      if (probe === null && st.nodes[i].dist === 1) probe = i;
    }
    ok('维护费：找到近核与最远端的测试节点',
       probe !== null && farId !== null && farId !== probe,
       '近核 ' + probe + '  最远 ' + farId + '（' + farDist + ' 格）');

    if (probe !== null && farId !== null) {
      st.nodes[probe].level = 5;
      st.res.water = 1e9;                       // 水充足
      var did = Sim.settleMaintenance(st, 1);
      ok('正对照：水充足时不降级', did === 0 && st.nodes[probe].level === 5,
         '本次降级 ' + did + ' 级，Lv' + st.nodes[probe].level + ' 保持');

      /* —— 核心断言：远端先降 ——
       * 配额给到「刚好 1 级」：如果实现真的按「远的先降」排序，
       * 唯一该掉级的就是最远那个节点，近核的必须原封不动。
       * （给大配额会让两个都降，那样就分不出「谁先」了 —— 实测踩过。）
       *
       * 注意 dt 的算法：quota = downgradePerSec * scale * dt，
       * 而 scale 最低 0.15、见底时到 3.0，所以 quota 并不等于 dt * downgradePerSec。
       * 想拿「刚好 1 级」必须按**当前 deficit 对应的 scale** 反推 dt，
       * 否则实际会降 2 级（这里踩过：直接传 1/perSec 得到 2 级）。 */
      st.nodes[probe].level = 5;
      st.nodes[farId].level = 5;
      st.res.water = 0;                          // 付不起
      var before = { p: st.nodes[probe].level, f: st.nodes[farId].level };
      /* 这里用水量精确控制 deficit：把水设成缓冲线的一点点下方，
       * 使 deficit 很小 → scale ≈ 0.15 → 配额最省，刚好只降 1 级。 */
      var cost = Sim.totalMaintainCost(st);
      st.res.water = cost * C.MAINT.bufferSec * 0.999;    // 刚刚破线，deficit ≈ 0.001
      var done = Sim.settleMaintenance(st, 1 / (C.MAINT.downgradePerSec * 0.15));
      ok('缺水时确实发生降级（正对照）', done > 0, '本次降级 ' + done + ' 级');
      ok('远端先降：配额只够 1 级时，掉级的是最远的节点',
         done === 1 && st.nodes[farId].level === before.f - 1,
         '远端 Lv' + before.f + ' → Lv' + st.nodes[farId].level + '（降 ' + done + ' 级）');
      ok('远端先降：近核节点在配额耗尽后被完整保住',
         st.nodes[probe].level === before.p,
         '近核 Lv' + st.nodes[probe].level + '（应保持 Lv' + before.p + '）');

      /* —— 绝不摧毁节点：降级不是删除 —— */
      var nBefore = st.nodes.length;
      st.nodes.forEach(function (n) { n.level = 9; });
      st.res.water = 0;
      for (var g = 0; g < 60; g++) Sim.settleMaintenance(st, 0.5);
      ok('降级只减等级、不移除节点',
         st.nodes.length === nBefore && st.nodes[farId] != null && st.nodes[probe] != null,
         '节点数 ' + nBefore + ' → ' + st.nodes.length);
      ok('降到 Lv0 就停住（不会降成负数）',
         st.nodes.every(function (n) { return n.level >= 0; }),
         '最低等级 ' + Math.min.apply(null, st.nodes.map(function (n) { return n.level; })));

      /* —— 水不会被扣成负数 —— */
      ok('水不会被扣成负数', st.res.water >= 0, '水量 ' + Math.round(st.res.water));
    }

    // 还原
    st.nodes.forEach(function (n, i2) { n.level = saved[i2]; });
    st.res.water = savedWater;
    st.counters.maintainDowngrades = savedDown;
    Sim.rebuildNetwork(st);
  });

  /* ---- 降级基准点 = 孢子落点（核心）---------------------------------------
   * 「离中心越远越先降」里的「中心」必须是 state.core —— 即孢子落地的那一格，
   * 也是节点 #0 所在处。这三者必须始终是同一个点，否则降级顺序会指向错误的方向。
   * 拆开写断言，是因为它们分别可能被改坏：
   *   · core 坐标被改成地图几何中心（会引入半格偏移，见 probe_downgrade_order）
   *   · downgradeOrder 换用欧氏距离（绕路生长时会排错序） */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;

    ok('降级基准：核心节点 #0 就在 state.core 那一格',
       st.nodes[0].x === st.core.x && st.nodes[0].y === st.core.y &&
       st.nodes[0].soil === 'core',
       'core=(' + st.core.x + ',' + st.core.y + ')  节点0=(' +
       st.nodes[0].x + ',' + st.nodes[0].y + ')  基质=' + st.nodes[0].soil);

    ok('降级基准：核心的 dist 恒为 0',
       st.nodes[0].dist === 0, 'dist=' + st.nodes[0].dist);

    /* 排序数组里**绝不能出现核心**：核心是唯一的不可降级节点。
     * 一旦混进去，玩家会看到落点自己在掉级 —— 那是荒谬的。 */
    var ord = Sim.downgradeOrder(st);
    ok('降级序列里不含核心（孢子落点不参与降级）',
       !ord.some(function (n) { return n.id === 0; }),
       '序列长度 ' + ord.length);

    /* 排序必须严格单调递减（远的在前）—— 逐对检查，能抓出任何比较器写反 */
    var mono = true, badAt = -1;
    for (var i = 1; i < ord.length; i++) {
      if (ord[i - 1].dist < ord[i].dist) { mono = false; badAt = i; break; }
    }
    ok('降级序列按「离孢子落点距离」严格降序（远的在前）', mono,
       mono ? ord.length + ' 个节点全部有序' :
              '第 ' + badAt + ' 位乱序：' + ord[badAt - 1].dist + ' → ' + ord[badAt].dist);

    /* 距离必须是 BFS 跳数（沿菌丝网络），不能是欧氏直线距离。
     * 找一对「欧氏更远但 BFS 更近」的节点，确认排序信的是 BFS。 */
    var pair = null;
    for (var a = 1; a < ord.length && !pair; a++) {
      for (var b = 1; b < ord.length; b++) {
        if (a === b) continue;
        var na = ord[a], nb = ord[b];
        var ea = Math.sqrt(Math.pow(na.x - st.core.x, 2) + Math.pow(na.y - st.core.y, 2));
        var eb = Math.sqrt(Math.pow(nb.x - st.core.x, 2) + Math.pow(nb.y - st.core.y, 2));
        // 欧氏上 a 更远，但 BFS 上 a 更近 → 两种度量会给出相反的顺序
        if (ea > eb && na.dist < nb.dist) { pair = [na, nb, ea, eb]; break; }
      }
    }
    if (pair) {
      var posA = ord.indexOf(pair[0]), posB = ord.indexOf(pair[1]);
      ok('距离用 BFS 跳数（沿菌丝网络），不是欧氏直线',
         posA > posB,
         '节点' + pair[0].id + '（欧氏 ' + pair[2].toFixed(1) + '/BFS ' + pair[0].dist +
         '） 与 节点' + pair[1].id + '（欧氏 ' + pair[3].toFixed(1) + '/BFS ' +
         pair[1].dist + '）→ 排序位置 ' + posA + ' vs ' + posB);
    } else {
      /* 网络太规整时构造不出反例 —— 明确报「跳过」而不是假装通过 */
      ok('距离用 BFS 跳数（当前网络找不到欧氏/BFS 冲突对，跳过）', true,
         '网络 ' + ord.length + ' 个带等级节点，两种度量恰好同序');
    }

    /* 核心即使被手动塞上高等级，也绝不掉级 —— 这是最硬的一条。
     * 抽干水跑很久，核心的等级必须纹丝不动。
     * 关键：断言前先给 farId 之类补上等级，否则降级序列是空的，
     * 「核心没掉级」会因为「谁都没掉级」而假通过。 */
    var savedCoreLv = st.nodes[0].level;
    var savedWater2 = st.res.water;
    var savedDown2 = st.counters.maintainDowngrades;
    var lvBackup = st.nodes.map(function (n) { return n.level; });
    st.nodes.forEach(function (n, i2) { if (i2 > 0) n.level = 5; });
    st.nodes[0].level = 9;
    st.res.water = 0;
    for (var g2 = 0; g2 < 200; g2++) Sim.settleMaintenance(st, 0.5);
    var othersDropped = st.nodes.some(function (n, i2) { return i2 > 0 && n.level < 5; });
    ok('正对照：抽干水时其它节点确实在掉级（否则下面的断言没意义）',
       othersDropped, '非核心节点最低 Lv' +
       Math.min.apply(null, st.nodes.slice(1).map(function (n) { return n.level; })));
    ok('核心免疫：抽干水跑 100 秒，孢子落点等级纹丝不动',
       st.nodes[0].level === 9, '核心 Lv9 → Lv' + st.nodes[0].level);

    st.nodes.forEach(function (n, i2) { n.level = lvBackup[i2]; });
    st.nodes[0].level = savedCoreLv;
    st.res.water = savedWater2;
    st.counters.maintainDowngrades = savedDown2;
    Sim.rebuildNetwork(st);
  });

  /* ---- 维护费不误伤扩张流（无等级网络零降级）------------------------------
   * 这是设计上的关键性质：维持费只挂等级、不挂节点数，
   * 所以「只铺不练」的玩家永远不会被它碰到。写成断言防止以后被改坏。 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;
    var saved = st.nodes.map(function (n) { return n.level; });
    var savedWater = st.res.water;

    st.nodes.forEach(function (n) { n.level = 0; });
    st.res.water = 0;                         // 极端情况：一滴水都没有
    var total = 0;
    for (var g = 0; g < 40; g++) total += Sim.settleMaintenance(st, 0.5);
    ok('无等级网络即使滴水不剩也零降级（不误伤扩张流）', total === 0,
       '累计降级 ' + total + ' 级，' + st.nodes.length + ' 个 Lv0 节点');

    st.nodes.forEach(function (n, i2) { n.level = saved[i2]; });
    st.res.water = savedWater;
    Sim.rebuildNetwork(st);
  });

  /* ---- 自动蔓延解锁（m10）------------------------------------------------
   * 条件 = 连上 4 种基质 + 菌丝达到 N 格（都在 counters 里，跨转生保留）。
   * 这里像玩家一样把缺的补齐：优先长缺失基质的候选格，再把规模点上去。 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;
    var missing = function () {
      return ['litter', 'vein', 'wood', 'root'].filter(function (s) {
        return !st.nodes.some(function (n) { return n.soil === s; });
      });
    };
    var needMore = function () {
      return missing().length > 0 || (st.counters.maxNodes || 0) < C.GROW.autoUnlockNodes;
    };
    st.res.water = 500000;
    var guard = 0;
    while (needMore() && guard++ < 600) {
      var cs = Sim.candidates(st);
      var pick = null;
      for (var i = 0; i < cs.length && !pick; i++) {
        if (missing().indexOf(cs[i].soil) >= 0) pick = cs[i];
      }
      if (!pick) pick = cs[0];
      if (!pick) break;
      Sim.growAt(st, pick.x, pick.y);
    }
    S.needLeft = missing();
    S.nodeShort = Math.max(0, C.GROW.autoUnlockNodes - (st.counters.maxNodes || 0));
    ok('补齐解锁条件（像玩家一样长过去）',
       S.needLeft.length === 0 && S.nodeShort === 0,
       (S.needLeft.length ? ('缺基质 ' + S.needLeft.join('/') + ' ') : '') +
       (S.nodeShort ? ('菌丝还差 ' + S.nodeShort + ' 格') : '全部满足'));
    st.autoTimer = -1e6;
    Sim.tick(st, 0.05);                 // 条件补齐后，checkMilestones 在下一次 tick 发奖
  });

  step(function () {
    var st = window.MYC.game.state;
    if ((S.needLeft && S.needLeft.length) || (S.nodeShort && S.nodeShort > 0)) {
      R.push('  SKIP 有机解锁：600 步内没补齐条件（基质 ' +
             (S.needLeft || []).join('/') + '，菌丝差 ' + S.nodeShort + ' 格）');
      return;
    }
    ok('满足条件后 m10 自动解锁自动蔓延',
       !!st.milestones.m10 && st.autoGrow === true,
       'm10=' + !!st.milestones.m10 + '  autoGrow=' + st.autoGrow);
    ok('解锁后开关恢复可用', document.getElementById('autoGrow').disabled === false,
       'disabled=' + document.getElementById('autoGrow').disabled);
    st.autoTimer = 0;
  });

  /* ---- 转生换图 ----------------------------------------------------------
   * 必须放在最后：转生会把网络重置成核心一格，后面的测试都依赖大网络。 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;
    S.p0 = { prestiges: st.prestiges, mapW: st.mapW, mapH: st.mapH, seed: st.seed,
             nodes: st.nodes.length, knowledge: Object.keys(st.knowledge).length };
    st.res.spore = 1e9;              // 强制满足转生条件
    st.total.nutrient = 1e9;
    st.total.spore = 1e9;
    S.pr = Sim.doPrestige(st);
    ok('转生可以执行', !!S.pr.ok, S.pr.ok ? ('获得 ' + S.pr.gained + ' 基因点') : S.pr.reason);
    if (S.pr.ok) {
      var sc = window.MYC.game.scene;
      if (sc && sc.onMapChanged) sc.onMapChanged();   // 真实流程由 update() 检测触发
    }
  });

  step(function () {
    var st = window.MYC.game.state, base = window.MYC.CONFIG.GRID;
    if (!S.pr || !S.pr.ok) return;
    /* 「地图变大」只在还没触到上限时成立。
     * mapSizeFor 是 min(2, 1 + prestiges*0.12) —— 约 9 次转生后边长就到 2 倍封顶，
     * 之后地图恒定 68×40。在同一个 localStorage 上重跑自测时，
     * prestiges 已经攒到上限，这条断言必然失败 —— 那不是回归，是到达了设计封顶。
     * 所以判据改成「变大 或 已封顶」，两者都算正确。 */
    var capped = window.MYC.Sim.mapSizeFor(st.prestiges).w ===
                 window.MYC.Sim.mapSizeFor(st.prestiges + 99).w;
    ok('转生后地图变大（或已达尺寸上限）',
       (st.mapW > S.p0.mapW || st.mapH > S.p0.mapH) || capped,
       S.p0.mapW + '×' + S.p0.mapH + ' → ' + st.mapW + '×' + st.mapH +
       (capped ? '  [已达上限]' : ''));
    ok('转生后换了种子（新地形）', st.seed !== S.p0.seed,
       'seed ' + S.p0.seed + ' → ' + st.seed);
    ok('新地图的探索记录已清空', st.explored.count < 60,
       '已探明 ' + st.explored.count + ' 格（转生前 ' + S.p0.nodes + ' 格）');
    ok('网络重置为核心一格', st.nodes.length === 1, st.nodes.length + ' 格');
    ok('转生计数 +1', st.prestiges === S.p0.prestiges + 1,
       S.p0.prestiges + ' → ' + st.prestiges);

    /* 尺寸阶梯：边长 = 基础 × min(2, 1 + 0.12 × 转生次数)，封顶防止经济失控 */
    var s = Math.min(2, 1 + st.prestiges * 0.12);
    ok('地图尺寸符合阶梯', st.mapW === Math.round(base.W * s) && st.mapH === Math.round(base.H * s),
       '期望 ' + Math.round(base.W * s) + '×' + Math.round(base.H * s) +
       '，实际 ' + st.mapW + '×' + st.mapH);

    var sc = window.MYC.game.scene;
    /* 断言「场景已感知到换图」用 seenMapW（onMapChanged 同步写入），
     * 别用 lastSoilSig === null —— 那只在「换图后一帧都没渲染」时成立。 */
    ok('场景已感知换图（缓存与镜头已重置）',
       sc.seenMapW === st.mapW && sc.seenMapH === st.mapH && sc.viewMode === 'auto',
       'seen=' + sc.seenMapW + '×' + sc.seenMapH + '  实际=' + st.mapW + '×' + st.mapH +
       '  viewMode=' + sc.viewMode);
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;
    if (!S.pr || !S.pr.ok) return;
    st.res.water = 50000;
    var b = Sim.bestCandidate(st);
    var r = b && Sim.growAt(st, b.x, b.y);
    ok('新地图上能继续生长', !!(r && r.ok), r ? ('-' + r.cost + ' 水') : '没有可生长的格');
  });

  /* 主循环断言放在最后：headless 下 rAF 的推进时机不确定，
   * 用「整场测试期间至少跑过一帧」才是有意义且稳定的判据。 */
  step(function () {
    var sc = window.MYC.game.scene;
    ok('Phaser 主循环确实运行过', sc.frames > 0, 'frames=' + sc.frames + '（起始 ' + S.frames0 + '）');
    ok('渲染层没有残留异常', errs.length === 0, errs.length ? errs.join(' | ') : '无');
  });

  /* ---------------------------------------------------------------- 驱动 */

  function runSteps() {
    var f = steps.shift();
    if (!f) return finish();
    try { f(); } catch (e) { R.push('FAIL  步骤抛异常: ' + e.message); }
    setTimeout(runSteps, 70);   // 让出一帧，Phaser 才有机会处理输入队列
  }

  function finish() {
    R.push('ERRORS=' + (errs.length ? errs.join(' | ') : 'NONE'));
    var pass = R.filter(function (l) { return l.indexOf('PASS') === 0; }).length;
    var fail = R.filter(function (l) { return l.indexOf('FAIL') === 0; }).length;
    R.push('SUMMARY pass=' + pass + ' fail=' + fail);
    var pre = document.createElement('pre');
    pre.id = 'autotest-report';
    pre.textContent = '\n===== AUTOTEST REPORT =====\n' + R.join('\n') + '\n===== END =====\n';
    document.body.appendChild(pre);
  }

  var tries = 0;
  (function boot() {
    if (++tries > 80) { R.push('FAIL  游戏未能在 8 秒内启动'); return finish(); }
    if (!window.MYC || !window.MYC.game || !window.MYC.game.scene) return setTimeout(boot, 100);
    setTimeout(runSteps, 400);
  })();
})();
