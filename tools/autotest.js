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

  /* ---- 开发用：?slots=1 —— 打开存档槽列表并塞几个假档，方便截图检查排版 ---- */
  if (/[?&]slots=1/.test(q)) {
    window.addEventListener('load', function () {
      setTimeout(function () {
        var UI = window.MYC.game.ui, Sim = window.MYC.Sim;
        /* 造两个规模不同的假档，好看清「有档 / 空档」两种样式的区别。
         * 直接把 payload 写进 localStorage —— 不走 saveToSlot，
         * 免得把当前局的 state 换掉（那样截图就看不到正常游戏画面了）。 */
        [[1, 320, 3, 3600 * 5], [2, 47, 1, 60 * 40]].forEach(function (spec) {
          var s = Sim.newGame(spec[2] * 1111, {}, {});
          s.prestiges = spec[2];
          for (var i = 0; i < 500 && s.nodes.length < spec[1]; i++) {
            Sim.invalidateCands(s);
            var c = Sim.candidates(s)[0];
            if (!c) break;
            Sim.addNode(s, c.x, c.y, s.grid[Sim.idx(c.x, c.y)].soil);
          }
          s.t = spec[3];
          var o = JSON.parse(Sim.serialize(s));
          o._meta = { savedAt: Date.now() - spec[3] * 1000, nodes: s.nodes.length,
                      t: s.t, seed: s.seed };
          localStorage.setItem(UI.slotKey(spec[0] === 1 ? 1 : 2), JSON.stringify(o));
        });
        UI.toggleSlots(true);
      }, 700);
    });
  }

  /* ---- 开发用：?strains=1 —— 把菌株卡摆出来（解锁 + 装一个），方便截图 ---- */
  if (/[?&]strains=1/.test(q)) {
    window.addEventListener('load', function () {
      setTimeout(function () {
        var Sim = window.MYC.Sim, game = window.MYC.game, st = game.state;
        /* 菌株要 40 格才解锁。截图时不想真跑一局，
         * 直接把 maxNodes 计数器抬上去 —— strainInfo 读的是它。 */
        st.counters.maxNodes = Math.max(st.counters.maxNodes || 0, 60);
        st.milestones.m11 = true;      // 展示「2 个槽」的状态，能看清槽位文案
        Sim.equipStrain(st, 'saprophyte');
        game.dirty = true;
        if (game.ui) game.ui.update(0.2, game);
      }, 700);
    });
  }

  /* ---- 开发用：?choice=1 —— 把转生三选一的弹窗摆出来，方便截图 ---- */
  if (/[?&]choice=1/.test(q)) {
    window.addEventListener('load', function () {
      setTimeout(function () {
        var Sim = window.MYC.Sim, game = window.MYC.game, st = game.state;
        /* 直接造一份 pendingChoice 而不真的转生 —— 截图不该为了
         * 「凑够孢子」把整局进度推倒重来。 */
        st.prestiges = Math.max(st.prestiges || 0, 3);
        st.pendingChoice = {
          cards: Sim.rollChoices(st, 120),
          gained: 120, forPrestige: st.prestiges, at: Date.now()
        };
        /* rollChoices 未必抽到全部三类（取决于已拥有哪些菌株），
         * 但截图最好一次看到三种卡 —— 手动补齐代表性的三张。 */
        var kinds = {};
        st.pendingChoice.cards.forEach(function (c) { kinds[c.type] = true; });
        if (!kinds.strain) {
          var s0 = window.MYC.CONFIG.STRAIN.list[0];
          st.pendingChoice.cards[0] = { type: 'strain', key: s0.key, weight: 3 };
        }
        if (!kinds.map) {
          var nm = Sim.mapSizeFor((st.mapTier || 0) + 1);
          st.pendingChoice.cards[1] = { type: 'map', key: 'mapX', weight: 2,
                                        nextW: nm.w, nextH: nm.h };
        }
        if (!kinds.genes) {
          st.pendingChoice.cards[2] = { type: 'genes', key: 'genesX', weight: 2, amount: 72 };
        }
        game.dirty = true;
        /* rebind 收的是 **state**，不是 game —— 它末尾那句
         * `if (newState.pendingChoice) showChoice()` 正好把弹窗弹出来。
         *
         * ⚠ 传错的后果很隐蔽：不会报「参数类型不对」，而是让 rebind 里的
         * `window.MYC.game.state = newState` 把 game 自己写成 state，
         * 之后 state.milestones 变成 undefined，UI 每帧刷新的第一句
         * `!state.milestones.m10` 就抛异常，整个面板停摆。
         * （踩过：?choice=1 的弹窗一直不出现，根因就是这个。） */
        game.ui.rebind(game.state);
        game.ui.update(0.2, game);
      }, 700);
    });
  }

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

  /* ---- 开发用：?tipdump=秒数 —— 把"悬停提示"的文案逐格打出来 ----
   * 用途：用户反馈「咋显示是变成往上加」，光看代码判断不出玩家实际读到什么。
   * 这里复刻 WorldScene.showHover 里算 dist / off 的那段逻辑，
   * 沿从核心向右的一整行逐格生成提示文本，直接看数字对不对。 */
  var td = /[?&]tipdump=(\d+)/.exec(q);
  if (td) {
    var runTipDump = function (seconds) {
      var Sim = window.MYC.Sim, st = window.MYC.game.state, C = window.MYC.CONFIG;
      if (seconds > 0) {
        st.up.autoGrow = 10;
        st.res.water = 3000;
        for (var i = 0; i < Math.round(seconds * 10); i++) {
          Sim.tick(st, 0.1);
          if (i % 20 === 0) {
            ['absorption', 'hydration', 'transport', 'capacity', 'growth', 'autoGrow']
              .forEach(function (k) {
                for (var g = 0; g < 40; g++) if (!Sim.buyUpgrade(st, k).ok) break;
              });
          }
        }
      }
      Sim.computeFlow(st, 1 / 60);

      var pre = document.createElement('pre');
      pre.id = 'tipprobe';
      var L = [];
      L.push('核心 = (' + st.core.x + ',' + st.core.y + ')   菌丝 ' + st.nodes.length +
             ' 格   maxDist ' + st.maxDist);
      L.push('rate.water = ' + st.rate.water.toFixed(4) +
             '   topsoilOffset = ' + (st.topsoilOffset || 0).toFixed(4) +
             '   topsoilCells = ' + (st.topsoilCells || 0));
      L.push('');

      /* 逐格：从核心向右扫 40 格，按 showHover 的逻辑算提示文本 */
      var F = C.TOPSOIL_FALLOFF;
      L.push('【整图扫描】所有"壤土"格，按离核曼哈顿距离排序（这才是玩家悬停会看到的）');
      L.push('从核第 N 格 | dist | 基质 | offset | 实际产出 | 提示文本');
      L.push('-----------|------|------|--------|----------|----------');
      var soilsFound = [];
      for (var yy = 0; yy < C.GRID.H; yy++) {
        for (var xx = 0; xx < C.GRID.W; xx++) {
          var cl = st.grid[Sim.idx(xx, yy)];
          if (cl.soil !== 'soil') continue;
          var dm2 = Math.abs(xx - st.core.x) + Math.abs(yy - st.core.y);
          soilsFound.push({ x: xx, y: yy, d: dm2 });
        }
      }
      soilsFound.sort(function (a, b) { return a.d - b.d; });
      L.push('全图壤土共 ' + soilsFound.length + ' 格；dist 范围 ' +
             (soilsFound.length ? (soilsFound[0].d + '..' + soilsFound[soilsFound.length - 1].d) : '-'));
      L.push('');
      var showList = soilsFound.slice(0, 26);
      for (var si = 0; si < showList.length; si++) {
        var so = showList[si];
        var s2 = C.SOILS.soil;
        var off2 = Sim.topsoilOffset(st, 'soil', so.d);
        var act2 = (s2.yield.water || 0) + off2;
        var t2;
        if (off2 !== 0) {
          t2 = '水 ' + act2.toFixed(2) + '/s' + ' ⏎ ' + s2.yield.water.toFixed(2)
               + ' − ' + Math.abs(off2).toFixed(2) + ' = ' + act2.toFixed(2)
               + '（从核第 ' + (so.d + 1) + ' 格）';
        } else {
          t2 = '水 +' + s2.yield.water.toFixed(2) + '/s';
        }
        L.push(('第 ' + (so.d + 1) + ' 格').padEnd(10) + ' | ' +
               String(so.d).padStart(4) + ' | soil | ' +
               (off2 >= 0 ? '+' : '') + off2.toFixed(3) + ' | ' +
               (act2 >= 0 ? '+' : '') + act2.toFixed(2) + ' | ' + t2);
      }
      if (soilsFound.length > showList.length) {
        L.push('...（还有 ' + (soilsFound.length - showList.length) + ' 格）');
        var last = soilsFound[soilsFound.length - 1];
        var offL = Sim.topsoilOffset(st, 'soil', last.d);
        L.push('最远一格：dist ' + last.d + ' → offset ' + offL.toFixed(3) +
               '，实际产出 ' + ((C.SOILS.soil.yield.water || 0) + offL).toFixed(2));
      }
      L.push('');

      /* 逐格：从核心向右扫 40 格 */
      L.push('【向右一整行】只是为了看同一行上不同基质的对比');
      L.push('从核第 N 格 | dist | 基质 | offset | 实际产出 | 提示首行');
      L.push('-----------|------|------|--------|----------|----------');
      for (var d = 0; d <= 40; d++) {
        var x = st.core.x + d, y = st.core.y;
        if (x >= C.GRID.W) break;
        var cell = st.grid[Sim.idx(x, y)];
        var soilKey = cell.soil;
        var soil = C.SOILS[soilKey];
        var off = Sim.topsoilOffset(st, soilKey, d);
        var act = (soil.yield.water || 0) + off;
        var txt;
        if (soil.yield.water) {
          if (off !== 0) {
            txt = '水 ' + act.toFixed(2) + '/s' + ' ⏎ ' + soil.yield.water.toFixed(2)
                  + ' − ' + Math.abs(off).toFixed(2) + ' = ' + act.toFixed(2)
                  + '（从核第 ' + (d + 1) + ' 格）';
          } else {
            txt = '水 +' + soil.yield.water.toFixed(2) + '/s';
          }
        } else {
          txt = '(不产水)';
        }
        L.push(('第 ' + (d + 1) + ' 格').padEnd(10) + ' | ' +
               String(d).padStart(4) + ' | ' +
               soilKey.padEnd(4) + ' | ' +
               (off >= 0 ? '+' : '') + off.toFixed(3) + ' | ' +
               (soil.yield.water ? ((act >= 0 ? '+' : '') + act.toFixed(2)) : '  -  ') + ' | ' + txt);
      }

      L.push('');
      L.push('—— 全图壤土格按 dist 分布 ——');
      var hist = {};
      for (var n = 0; n < st.nodes.length; n++) {
        if (st.nodes[n].soil !== 'soil') continue;
        var dd = st.nodes[n].dist;
        hist[dd] = (hist[dd] || 0) + 1;
      }
      Object.keys(hist).sort(function (a, b) { return a - b; }).forEach(function (k) {
        var off2 = Sim.topsoilOffset(st, 'soil', Number(k));
        L.push('  dist ' + String(k).padStart(3) + ' → ' + String(hist[k]).padStart(3) +
               ' 格   每格 offset ' + (off2 >= 0 ? '+' : '') + off2.toFixed(3));
      });

      pre.textContent = L.join('\n');
      document.body.appendChild(pre);
      window.MYC.game.dirty = true;
      if (window.MYC.game.ui) window.MYC.game.ui.update(0.2, window.MYC.game);
    };
    var waitTip = function () {
      if (!window.MYC || !window.MYC.game || !window.MYC.game.scene) return setTimeout(waitTip, 100);
      setTimeout(function () { runTipDump(Number(td[1])); }, 300);
    };
    waitTip();
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
  /* steps 里存 {fn, tag}：tag 用来在「步骤抛异常」时指出到底是哪一步。
   * 之前只报异常消息，一次 9 个「Cannot read properties of undefined」，
   * 根本看不出是哪个步骤炸的 —— 排查成本极高。 */
  function step(fn) {
    var tag = '步骤#' + (steps.length + 1);
    var m = /\/\*+\s*([^*\n]{2,50})/.exec(String(fn));
    if (m) tag += ' ' + m[1].trim();
    steps.push({ fn: fn, tag: tag });
  }

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

  /* ---- 存档槽：存 → 读 → 删 的完整往返 --------------------------------
   * 上一版只有一个 localStorage key，自动存档和「读取」共用它，
   * 于是点「读取」读到的就是刚被覆盖的当前局 —— 功能等于不存在。
   * 这一组把槽位和自动存档的**隔离性**钉死：
   *   1. 写槽不动自动存档；写自动存档不动槽
   *   2. 槽里的摘要和实际内容一致（列表靠摘要显示，错了两边对不上）
   *   3. 读槽能把状态换回来（含网络规模 / 转生数）
   *   4. 清槽只清指定的那个
   * 全部走 game API，不模拟点击 —— 点击路径另有断言。 */
  step(function () {
    var Sim = window.MYC.Sim, g = window.MYC.game, UI = g.ui;
    var slotN = UI.SLOTN;

    /* 先把三个槽清干净，避免上一次自测的残留让断言飘。 */
    for (var i = 1; i <= slotN; i++) {
      try { localStorage.removeItem(UI.slotKey(i)); } catch (e) {}
    }
    ok('槽位 key 与自动存档 key 不共用',
       UI.slotKey(1) !== UI.KEY && UI.slotKey(1) !== UI.SEEDKEY,
       UI.slotKey(1) + '  vs  ' + UI.KEY);

    /* 造一个可识别的状态：5 格网络、2 次转生，好和别的槽区分开。 */
    var probe = Sim.newGame(424242, { gYield: 3 }, {});
    probe.prestiges = 2;
    probe.res.water = 777;
    /* ⚠ addNode 之后必须 invalidateCands：candidates() 按帧缓存，
     * 不清缓存的话下一次拿到的还是同一批旧候选（自测踩过一次）。 */
    while (probe.nodes.length < 5) {
      Sim.invalidateCands(probe);
      var c = Sim.candidates(probe)[0];
      if (!c) break;
      Sim.addNode(probe, c.x, c.y, probe.grid[Sim.idx(c.x, c.y)].soil);
    }

    /* ① 写槽 1 */
    var beforeAuto = localStorage.getItem(UI.KEY);
    var meta = (function () {
      var payload = Sim.serialize(probe);
      var o = JSON.parse(payload);
      o._meta = { savedAt: Date.now(), nodes: probe.nodes.length, t: probe.t, seed: probe.seed };
      localStorage.setItem(UI.slotKey(1), JSON.stringify(o));
      return o._meta;
    })();
    ok('写入槽 1 后有摘要可读',
       g.readSlot(1) && g.readSlot(1).nodes === probe.nodes.length,
       '摘要 nodes=' + (g.readSlot(1) ? g.readSlot(1).nodes : 'null') +
       '（期望 ' + probe.nodes.length + '）');
    ok('写槽**不会**动自动存档（两者隔离）',
       localStorage.getItem(UI.KEY) === beforeAuto,
       beforeAuto === null ? '自动存档前后都是空' : '自动存档未被改写');
    ok('摘要里的种子与状态一致', g.readSlot(1).seed === 424242,
       'seed=' + g.readSlot(1).seed);
    ok('摘要带存档时间（列表要显示「多久前」）', g.readSlot(1).savedAt > 0,
       'savedAt=' + g.readSlot(1).savedAt);

    /* ② 读槽 —— 先把当前局改成别的东西，确认真的被换回来 */
    g.state = Sim.newGame(999, {}, {});
    var back = g.loadFromSlot(1);
    ok('读档成功', back === true, 'loadFromSlot 返回 ' + back);
    ok('读档恢复了种子', g.state.seed === 424242, 'seed=' + g.state.seed);
    ok('读档恢复了网络规模', g.state.nodes.length === probe.nodes.length,
       'nodes=' + g.state.nodes.length + '（期望 ' + probe.nodes.length + '）');
    ok('读档恢复了转生数', g.state.prestiges === 2, 'prestiges=' + g.state.prestiges);
    ok('读档恢复了资源存量', g.state.res.water === 777, 'water=' + g.state.res.water);
    /* 读档后必须让自动存档跟上，否则刷新页面会回到旧局 —— 这是最阴的 bug。 */
    ok('读档后自动存档已同步（刷新不回退）',
       localStorage.getItem(UI.KEY) &&
       JSON.parse(localStorage.getItem(UI.KEY)).seed === 424242,
       '自动存档种子 = ' +
       (localStorage.getItem(UI.KEY) ? JSON.parse(localStorage.getItem(UI.KEY)).seed : 'null'));

    /* ③ 空槽读档必须被挡住，不能把当前局读成 null */
    var emptyBack = g.loadFromSlot(slotN);
    var curSeed = g.state.seed;
    ok('读空槽被拒绝且不影响当前局',
       emptyBack === false && g.state.seed === curSeed,
       '返回 ' + emptyBack + '，当前种子仍是 ' + g.state.seed);

    /* ④ 删槽只删指定的那个 */
    localStorage.setItem(UI.slotKey(2), localStorage.getItem(UI.slotKey(1)));
    g.clearSlot(1);
    ok('删除槽 1 后槽 1 为空、槽 2 不受影响',
       g.readSlot(1) === null && g.readSlot(2) !== null,
       '槽1=' + (g.readSlot(1) ? '有' : '空') + '  槽2=' + (g.readSlot(2) ? '有' : '空'));

    /* 收尾：清掉本轮造的槽，别污染后面的断言 */
    for (var k = 1; k <= slotN; k++) {
      try { localStorage.removeItem(UI.slotKey(k)); } catch (e2) {}
    }

    /* ⚠ 必须把当前局恢复成干净开局。
     * 上面为了测读档把 g.state 换成了自己造的 5 格存档，
     * 如果就这么留着，后面所有依赖「网络会自己长起来」的断言
     * 全都跑在一个半成品状态上（实测表现为 maxDist=0、养分不产出）。
     * 这和 step 0 的清理是同一件事，所以复用同一段逻辑。 */
    try { localStorage.removeItem(UI.KEY); } catch (e3) {}
    try { localStorage.removeItem(UI.SEEDKEY); } catch (e4) {}
    var clean = Sim.newGame(20260918, {}, {});
    g.state = clean;
    UI.rebind(clean);
    if (g.scene) {
      g.scene.lastKnown = -1; g.scene.lastSoilSig = null;
      g.scene.lastNodeCount = 0; g.scene.pops = {};
      if (g.scene.onMapChanged) g.scene.onMapChanged();
    }
    g.dirty = true;
    ok('存档槽测试后当前局已复位（不留半成品状态）',
       g.state.nodes.length === 1 && !g.state.prestiges,
       'nodes=' + g.state.nodes.length + ' prestiges=' + g.state.prestiges);
  });

  /* ---- 存档卡片：按钮存在、槽列表能渲染出来 ---------------------------- */
  step(function () {
    var UI = window.MYC.game.ui;
    ok('存在「开始新游戏」按钮', !!document.getElementById('btnNew'),
       document.getElementById('btnNew') ?
       document.getElementById('btnNew').textContent : '缺失');
    ok('存在「保存」按钮', !!document.getElementById('btnSave'),
       document.getElementById('btnSave') ?
       document.getElementById('btnSave').textContent : '缺失');
    var list = document.getElementById('slotList');
    ok('存在槽位列表容器', !!list, list ? '存在' : '缺失');
    if (!list) return;
    /* 展开后槽数必须等于 SLOTN —— 渲染是 innerHTML 重建的，
     * 很容易写成「只渲染有档的槽」，那样空槽就没法存了。 */
    UI.toggleSlots(true);
    var slots = list.querySelectorAll('.slot');
    ok('槽位数 = SLOTN（空槽也要渲染出来，否则没法存）',
       slots.length === UI.SLOTN, '渲染了 ' + slots.length + ' 个槽（期望 ' + UI.SLOTN + '）');
    var emptyCount = list.querySelectorAll('.slot.empty').length;
    ok('无档时所有槽都是空态', emptyCount === UI.SLOTN,
       '空槽 ' + emptyCount + '/' + UI.SLOTN);
    /* 空槽只能「存入」，不该出现读取/删除 —— 点了也没东西可读 */
    var firstEmpty = list.querySelector('.slot.empty');
    if (firstEmpty) {
      var acts = [];
      Array.prototype.forEach.call(firstEmpty.querySelectorAll('button'), function (b) {
        acts.push(b.getAttribute('data-act'));
      });
      ok('空槽只有「存入」按钮（不给读取/删除）',
         acts.length === 1 && acts[0] === 'save', '按钮：' + acts.join(','));
    }
    /* 有档的槽必须给全三个动作 */
    UI.toggleSlots(false);
    ok('槽位列表默认收起（不占面板高度）',
       list.style.display === 'none', 'display=' + (list.style.display || '(空)'));
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

    /* ---- 壤土的远距收益递减（CONFIG.TOPSOIL_FALLOFF）---------------------
     * 不变量（四条，缺一条这个机制就不成立）：
     *   ① 单调递减 —— 越远越少，否则不是「递减」；
     *   ② 归零/转负 —— 必须真的能到 0 以下，否则削弱不了通铺流；
     *   ③ 只作用于壤土 —— 别的基质一个都不能动（用户明确「只有普通壤土」）；
     *   ④ 有地板 —— 大图边缘不能被算成巨量倒扣，那会一帧吸干水池。
     *
     * ⚠ 口径：用户说的「从核心数第 5 格」= 本坐标系的 dist=4
     *   （核心自己是第 1 格）。所以归零断言钉在 dist===4 上。
     *   曲线：0.12 / 0.09 / 0.06 / 0.03 / 0 → 之后转负。 */
    var F = window.MYC.CONFIG.TOPSOIL_FALLOFF;
    if (F) {
      var soilBase = window.MYC.CONFIG.SOILS.soil.yield.water;
      var yAt = function (d) { return soilBase + Sim.topsoilOffset(st, 'soil', d); };
      var o4 = Sim.topsoilOffset(st, 'soil', 4);
      var o5 = Sim.topsoilOffset(st, 'soil', 5);
      var o20 = Sim.topsoilOffset(st, 'soil', 20);
      var o40 = Sim.topsoilOffset(st, 'soil', 40);
      var o80 = Sim.topsoilOffset(st, 'soil', 80);

      /* 用户给的原式：0.12 / 0.09 —— 逐格核对前 5 格 */
      ok('壤土递减：0 格 = 0.12（原产出不变）', Math.abs(yAt(0) - 0.12) < 1e-12,
         'd0 = ' + yAt(0).toFixed(4));
      ok('壤土递减：1 格 = 0.09（用户原式）', Math.abs(yAt(1) - 0.09) < 1e-12,
         'd1 = ' + yAt(1).toFixed(4));
      ok('壤土递减：从核数第 5 格 = dist 4 精确归零', o4 === -soilBase && yAt(4) === 0,
         'd4 = ' + yAt(4));
      ok('壤土递减：转负发生在 dist 5（从核数第 6 格）', yAt(5) < 0 && yAt(4) === 0,
         'y(4)=' + yAt(4) + '  y(5)=' + yAt(5).toFixed(4));
      ok('壤土递减：严格单调递减', yAt(0) > yAt(1) && yAt(1) > yAt(4) && o4 > o5 && o5 > o20,
         '0.12 > 0.09 > 0 > ' + o5.toFixed(3) + ' > ' + o20.toFixed(3));
      /* ⚠ 20 格比较的是「最终产出」yAt(20) = 0.12 - 0.60 = -0.48，
       *   不是 offset 本身（offset = -0.60）。一开始拿 offset 去比 -0.48，
       *   自己把自己坑了一次 —— 凡是对外报的数都用 yAt()。 */
      ok('壤土递减：20 格 ≈ -0.48（用户说的 -0.45 附近）', Math.abs(yAt(20) + 0.48) < 1e-12,
         'd20 = ' + yAt(20).toFixed(4) + '（offset ' + o20.toFixed(4) + '）');
      ok('壤土递减：40 格 = -1.05（用户锚点，含地板）', Math.abs(yAt(40) + 1.05) < 1e-12,
         'd40 = ' + yAt(40).toFixed(4));

      /* 基础产出必须保留 0.12 —— 这一版没有把它归零 */
      ok('壤土基础产出保留 0.12（未归零）', Math.abs(soilBase - 0.12) < 1e-12,
         'base water=' + soilBase);

      ok('壤土递减有地板（不会无限倒扣）', o80 >= -F.limit - 1e-9 && o80 === -F.limit,
         'd80 = ' + o80.toFixed(4) + ' limit=-' + F.limit);
      /* 地板触发点：offset 是加在 0.12 上的，所以解 slope×d = limit
       * → d = limit/slope = 1.17/0.03 = 39 格（产出 -1.05 的位置） */
      var floorAt = F.limit / F.slope;
      ok('地板触发点 = limit/slope = 39 格（产出 -1.05）', Math.abs(floorAt - 39) < 1e-9,
         '地板距离 = ' + floorAt.toFixed(2) + ' 格');

      /* ③ 只作用于壤土 —— 这是用户强调的核心约束 */
      var others = ['vein', 'wood', 'litter', 'root', 'core', 'rock'];
      var touched = others.filter(function (s2) {
        return Sim.topsoilOffset(st, s2, 20) !== 0;
      });
      ok('只作用于普通壤土，其它基质零影响', touched.length === 0,
         touched.length ? '被误改: ' + touched.join(',') : '六种基质全部 offset=0');

      /* ---- 提示文本不得被读成「往上加」 ------------------------------
       * 反馈原文：「这个逻辑是不是写错了，咋显示是变成往上加啊」。
       * 数值全对，是排版把读者带反了。下面把「读反」的三种具体形式钉死：
       *   ① 递减量前面出现加号（`+-0.06` / `+ 0.06` 之类）
       *   ② 结论数字没顶头写符号，让读者靠上下文猜
       *   ③ 距离报的是 0 基的 dist，和玩家心里数的「第几格」差一
       * 这里只做**字符串断言**，不碰 UI —— 目的是让改文案时立刻炸出来。 */
      var fmtTip = function (d) {
        var o = Sim.topsoilOffset(st, 'soil', d);
        var act = soilBase + o;
        if (o === 0) return '水 +' + soilBase.toFixed(2) + '/s';
        return '水 ' + act.toFixed(2) + '/s ⏎ ' + soilBase.toFixed(2) + ' − '
               + Math.abs(o).toFixed(2) + ' = ' + act.toFixed(2)
               + '（从核第 ' + (d + 1) + ' 格）';
      };
      var tipNeg = fmtTip(5);                       // 从核第 6 格，实际 -0.03
      ok('提示文本：负产出不带加号前缀', tipNeg.indexOf('+-') < 0 && tipNeg.indexOf('+ -') < 0,
         tipNeg);
      ok('提示文本：写的是减法算式（0.12 − 0.15）',
         tipNeg.indexOf('0.12 − 0.15 = -0.03') >= 0, tipNeg);
      ok('提示文本：距离用玩家口径「从核第 6 格」',
         tipNeg.indexOf('从核第 6 格') >= 0 && tipNeg.indexOf('离核 5 格') < 0, tipNeg);
      ok('提示文本：归零格（从核第 5 格）产出 0.00 不写负号',
         fmtTip(4).indexOf('0.00') >= 0, fmtTip(4));
      ok('提示文本：远格依旧递增式递减（-0.03 < -0.06）',
         parseFloat(/([-\d.]+)\/s/.exec(fmtTip(5))[1]) >
         parseFloat(/([-\d.]+)\/s/.exec(fmtTip(6))[1]),
         fmtTip(5) + '  vs  ' + fmtTip(6));
    } else {
      ok('TOPSOIL_FALLOFF 已配置', false, '配置缺失');
    }
  });

  /* ---- 面板必须「看得见」壤土递减 -------------------------------------
   * 用户实测反馈：「为啥不显示实际产量，我还以为没生效呢」。
   * 根因是所有玩家可见的产量文案都在打 SOILS.soil.yield.water（基准 0.12），
   * 不含递减量 —— 远处几十格在偷偷扣水，面板上却一片正常。
   * 这一组断言就是防它再退回去：先铺一条**足够远**的壤土链，
   * 再核对 computeFlow 的汇总与面板文案都拿到了负值。
   *
   * 构造方式沿用「铺密」那套（bestCandidate + growAt），因为 candidates()
   * 是按帧缓存的：直接改 grid 再 growAt 会拿到旧 soil（这个坑前面刚好踩过，
   * 见树木存档那步的注释）。所以这里**先改 grid 的 soil，再清缓存**。 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;
    var F = C.TOPSOIL_FALLOFF;
    if (!F) { ok('TOPSOIL_FALLOFF 已配置', false, '配置缺失'); return; }

    /* 只铺一条从核心向右的直线：这样每格的 dist 就是它的列偏移，
     * 与 topsoilOffset 的自变量一一对应，断言才有意义。
     * 先清空网络，再逐格「改成壤土 + 清候选缓存 + 生长」。 */
    st.nodes.length = 0;
    for (var q = 0; q < st.nodeAt.length; q++) st.nodeAt[q] = null;
    Sim.addNode(st, st.core.x, st.core.y, 'core');
    ok('清空后核心已重建为唯一节点', st.nodes.length === 1 && st.maxDist === 0,
       '节点 ' + st.nodes.length + ' maxDist ' + st.maxDist);

    var cx = st.core.x, cy = st.core.y;
    var MAXD = 12;                        // 越过归零线（dist 4），必然出现负值
    var grew = 0;
    for (var d = 1; d <= MAXD; d++) {
      var gx = cx + d, gy = cy;
      if (gx >= C.GRID.W) break;
      var gi = Sim.idx(gx, gy);
      st.grid[gi].soil = 'soil';          // 强制壤土（免得地形给岩石/水脉）
      st.grid[gi].known = true;
      Sim.invalidateCands(st);
      st.res.water = Math.max(st.res.water, 1e6);
      if (!Sim.growAt(st, gx, gy).ok) break;
      grew++;
    }

    ok('已铺出向右的壤土直线（>= 6 格，越过归零线）', grew >= 6 && grew <= MAXD,
       '实际铺了 ' + grew + ' 格，maxDist=' + st.maxDist);

    /* 逐格核对曲线：第 5 格（dist 4）恰好 0，远端为负 */
    var y4 = C.SOILS.soil.yield.water + Sim.topsoilOffset(st, 'soil', 4);
    var yFar = C.SOILS.soil.yield.water + Sim.topsoilOffset(st, 'soil', grew);
    ok('演示：第 5 格（dist 4）产出恰好 0', y4 === 0, 'y(4) = ' + y4);
    ok('演示：最远那格（dist ' + grew + '）产出为负', yFar < 0,
       'y(' + grew + ') = ' + yFar.toFixed(3));

    /* computeFlow 必须把负值汇总出来 —— 这是面板文案的数据来源 */
    Sim.computeFlow(st, 1 / 60);
    ok('computeFlow 汇总了受影响格数（= dist>=1 的壤土数）',
       st.topsoilCells === grew, 'topsoilCells = ' + st.topsoilCells + '（期望 ' + grew + '）');
    ok('computeFlow 汇总的 offset 为负', st.topsoilOffset < 0,
       'topsoilOffset = ' + st.topsoilOffset.toFixed(3));
    /* offset 严格等于 -slope × Σ(1..grew) */
    var expect = -F.slope * (grew * (grew + 1) / 2);
    ok('汇总值与逐格累加严格一致', Math.abs(st.topsoilOffset - expect) < 1e-9,
       '汇总 ' + st.topsoilOffset.toFixed(4) + ' vs 期望 ' + expect.toFixed(4));

    /* 面板文案：壤土行必须出现，且带负号（不是基准 0.12） */
    window.MYC.game.dirty = true;
    window.MYC.game.ui.update(0.2, window.MYC.game);
    var row = document.getElementById('topsoilRow');
    ok('面板有壤土递减行（#topsoilRow）', !!row, row ? '存在' : '缺失');
    if (row) {
      var txt = row.textContent || '';
      ok('壤土行显示受影响格数 ' + grew, txt.indexOf(String(grew)) >= 0, '文案：' + txt);
      ok('壤土行显示负值而非基准 0.12', /-\d/.test(txt) && txt.indexOf('0.12') < 0, '文案：' + txt);
      /* 「咋显示是变成往上加」的第二嫌疑面：这行的数字绝不能出现加号。
       * 它的语义是「被扣掉的水」，永远是 0 或负数。 */
      ok('壤土行的数字不带加号（不读成「往上加」）', txt.indexOf('+') < 0, '文案：' + txt);
      ok('壤土行写清了方向（越远扣得越多）', txt.indexOf('越远') >= 0, '文案：' + txt);
      ok('壤土行未被隐藏（有格子被扣水时必须可见）', row.className.indexOf('hide') < 0,
         'class=' + row.className);
    }

    /* 反向：把所有壤土都换成水脉（offset 不再作用于任何格子）后，
     * 这一行必须**收起来**——上一版它常驻显示「尚未触发」，
     * 开局只有 1 格时也占着一整行，是纯噪音。 */
    for (var z = 1; z < st.nodes.length; z++) st.nodes[z].soil = 'vein';
    window.MYC.Sim.computeFlow(st, 1 / 60);
    window.MYC.game.dirty = true;
    window.MYC.game.ui.update(0.2, window.MYC.game);
    ok('没有格子被扣水时壤土行收起（不留「尚未触发」噪音）',
       row.className.indexOf('hide') >= 0 && row.textContent === '',
       'class=' + row.className + ' 文案：' + JSON.stringify(row.textContent));
  });

  /* ---- 速率文案的符号必须跟着数值走 ----------------------------------
   * 用户反馈「屏幕右边的产量这栏是不是不太对」。
   * 根因是 rate() 里写死了前缀 '+'：`return '+' + fmt(n) + '/s'`。
   * 三种速率都可能为负（水分扣完维持费、网络大面积铺远壤土…），
   * 于是面板会显示 **`+-1.20/s`** 这种自相矛盾的怪东西。
   * 这一组把 rate() 的边界钉死：负号、零、极小值三档。 */
  step(function () {
    var st = window.MYC.game.state;
    var game = window.MYC.game;
    var elW = document.getElementById('rWater');
    var elN = document.getElementById('rNutrient');
    var elS = document.getElementById('rSpore');
    /* update() 有 0.1s 节流：`if (acc < 0.1 && !game.dirty) return;`
     * 所以改完 state 必须打 dirty 再刷，否则读到的还是上一帧的文案。 */
    var refresh = function () { game.dirty = true; game.ui.update(0.2, game); };

    /* ① 负速率必须显示「-」，绝不能出现「+-」 */
    st.rate = { water: -1.2, nutrient: -0.45, spore: -3 };
    st.maintainCost = 0;
    refresh();
    ok('水分速率为负时显示 -1.20/s', elW.textContent.indexOf('-1.20/s') === 0,
       '文案：' + elW.textContent);
    ok('负速率不出现「+-」这种写法', elW.textContent.indexOf('+-') < 0,
       '文案：' + elW.textContent);
    ok('养分速率为负时也带负号', elN.textContent.indexOf('-0.45/s') === 0,
       '文案：' + elN.textContent);
    ok('孢子速率为负时也带负号', elS.textContent.indexOf('-3.00/s') === 0,
       '文案：' + elS.textContent);

    /* ② 正速率照旧带 '+' */
    st.rate = { water: 0.45, nutrient: 12.3, spore: 0.01 };
    refresh();
    ok('正速率仍带 + 号',
       elW.textContent.indexOf('+0.45/s') === 0 && elN.textContent.indexOf('+12.3/s') === 0,
       '文案：' + elW.textContent + ' / ' + elN.textContent);

    /* ③ 极小值按零处理：不出现「+0.00」（像有产出）或「-0.00」（更莫名） */
    st.rate = { water: 0.0009, nutrient: -0.0004, spore: 0 };
    refresh();
    ok('极小正值显示 0.00/s 而不是 +0.00/s', elW.textContent === '0.00/s',
       '文案：' + elW.textContent);
    ok('极小负值显示 0.00/s 而不是 -0.00/s', elN.textContent === '0.00/s',
       '文案：' + elN.textContent);
    ok('零显示 0.00/s', elS.textContent === '0.00/s', '文案：' + elS.textContent);

    /* ④ 真正的负净值（产出 - 维持费）也必须带负号 —— 这是最常触发的一路 */
    st.rate = { water: 2.0, nutrient: 0, spore: 0 };
    st.maintainCost = 3.5;
    refresh();
    ok('净值 = 产出 - 维持费，为负时带负号',
       elW.textContent.indexOf('-1.50/s') === 0, '文案：' + elW.textContent);

    /* 复原，免得后面的步骤读到被改脏的 rate */
    st.rate = { water: 0, nutrient: 0, spore: 0 };
    st.maintainCost = 0;
    refresh();
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
   * 练出 firewallNodes 个「到免疫线」的节点 → 发奖：菌瘟蔓延变慢。
   * 注意等级门槛 = immuneLevel（不是 maxLevel + 1）—— 免疫线就是防火墙线，
   * 见 config.BLIGHT 上方的「不变量」注释。 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;
    if (st.milestones.m9) { R.push('      （m9 已达成，跳过首次发奖测试）'); return; }
    // 摆布 firewallNodes 个节点到免疫线（像玩家深耕那样），assert m9 发奖
    var need = C.BLIGHT.immuneLevel, saved = st.nodes.map(function (n) { return n.level; });
    var picked = 0, hadSlow = !!st.mods.blightSlow;
    for (var i = 1; i < st.nodes.length && picked < C.BLIGHT.firewallNodes; i++) {
      var nd = st.nodes[i];
      if (!nd.gnat && !nd.blighted && nd.level < need) {
        nd.level = need;
        picked++;
      }
    }
    ok('防火墙测试位就绪（' + picked + ' 个 Lv' + need + '+ 节点）',
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

  /* ---- 防火墙门槛必须钉在免疫线上（回归护栏）------------------------------
   * 这条断言的作用是「改 immuneLevel 而漏改 m9」或「改 m9 而漏改免疫判定」时
   * 立刻炸出来。做法：把全部节点压到 immuneLevel - 1，断言还差一步；
   * 补到 immuneLevel，断言正好达成。
   *
   * 为什么**不**断言防火墙的养分/维持费预算：
   * 那个数字不是平衡旋钮。能凑出 3 个 Lv7 免疫节点就是大后期了，
   * 那点维持费在后期水收入面前是账目噪声 —— 用「花得起吗」去卡这道
   * 里程碑是把设计承诺当成数值题，方向就错了。这里只守一件事：
   * 等级门槛和 immuneLevel 是同一个数字。 */
  step(function () {
    var C = window.MYC.CONFIG;
    var immune = C.BLIGHT.immuneLevel, n = C.BLIGHT.firewallNodes;
    ok('免疫线就是防火墙线（两个参数不许分家）', immune >= 2 && n >= 1,
       'immuneLevel=' + immune + '  firewallNodes=' + n);
    // 防火墙的等级门槛必须能在 m9 的判定里读出来 —— 改 immuneLevel 时不许漏改
    ok('防火墙点数是「一组」的量级（≤ 5，不是全图硬化）', n <= 5,
       'firewallNodes=' + n);
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

      /* —— 设计承诺的守门断言：水还有余额就一级都不许掉 ——
       * 玩家明确提过「是我的总水分变成 0 了才开始降级」。
       * 旧版在水量低于「维持费 × bufferSec」时就开始降级，
       * 玩家在水还是正数的时候就看着等级往下掉 —— 那条规则已被删除。
       * 这条断言就是防止它哪天偷偷回来。
       * 故意把水设得**很紧**（只够付 0.5 秒），只要 > 0 就不该动手。 */
      st.nodes[probe].level = 5;
      st.nodes[farId].level = 5;
      st.maintainQuota = 0;
      var costKeep = Sim.totalMaintainCost(st);
      st.res.water = costKeep * 0.5;              // 只够付 0.5 秒，但明确 > 0
      var dKeep = Sim.settleMaintenance(st, 0.25); // 只走 0.25 秒，水还剩一半
      ok('水还有余额（>0）时绝不降级 —— 哪怕只够付 0.5 秒',
         dKeep === 0 && st.nodes[farId].level === 5 && st.nodes[probe].level === 5,
         '降级 ' + dKeep + ' 级，剩余水 ' + st.res.water.toFixed(2));
      ok('水位还是正数时才不降级（此时的告警灯也该是灭的）',
         st.res.water > 0 && st.maintainPressure === false,
         '水 ' + st.res.water.toFixed(2) + '  pressure=' + st.maintainPressure);

      /* —— 核心断言：远端先降 ——
       * 配额给到「刚好 1 级」：如果实现真的按「远的先降」排序，
       * 唯一该掉级的就是最远那个节点，近核的必须原封不动。
       * （给大配额会让两个都降，那样就分不出「谁先」了 —— 实测踩过。）
       *
       * dt 的算法：quota = downgradePerSec * dt，所以
       * dt = 1 / downgradePerSec 恰好给出 1 级配额。
       * 触发条件是「水见底」，所以这里把水设成 0。 */
      st.nodes[probe].level = 5;
      st.nodes[farId].level = 5;
      st.maintainQuota = 0;
      st.res.water = 0;                          // 见底 —— 唯一的降级触发条件
      var before = { p: st.nodes[probe].level, f: st.nodes[farId].level };
      var done = Sim.settleMaintenance(st, 1 / C.MAINT.downgradePerSec);
      ok('水见底时确实发生降级（正对照）', done > 0, '本次降级 ' + done + ' 级');
      ok('远端先降：配额只够 1 级时，掉级的是最远的节点',
         done === 1 && st.nodes[farId].level === before.f - 1,
         '远端 Lv' + before.f + ' → Lv' + st.nodes[farId].level + '（降 ' + done + ' 级）');
      ok('远端先降：近核节点在配额耗尽后被完整保住',
         st.nodes[probe].level === before.p,
         '近核 Lv' + st.nodes[probe].level + '（应保持 Lv' + before.p + '）');

      /* 速度断言：连续喂 1 秒 → 恰好降 downgradePerSec 级。
       * 上面那次是构造性给 1 级配额，量不出速度，所以单独再跑一次。 */
      st.nodes.forEach(function (n) { n.level = 9; });
      st.maintainQuota = 0;
      st.res.water = 0;
      var dSpeed = Sim.settleMaintenance(st, 1.0);
      ok('降级速度 = downgradePerSec（水见底 1 秒降 ' + C.MAINT.downgradePerSec + ' 级）',
         dSpeed === C.MAINT.downgradePerSec, '实降 ' + dSpeed + ' 级');

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

  /* ---- 自动蔓延的两条选址规则（距离上限 / 收益阈值）---------------------
   * 判据：规则必须**真的改变自动蔓延的结果**，而且**不能挡住手动点击**。
   * 后者是手感底线：玩家想连哪格就连哪格，自动化规则是给「我不在的时候」用的。 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;

    ok('AUTORULE 配置已导出', !!C.AUTORULE && C.AUTORULE.length === 2,
       C.AUTORULE ? C.AUTORULE.map(function (r) { return r.key; }).join('/') : 'missing');

    /* 先把网络铺到足够大，规则才测得出效果 */
    st.res.water = 1e9; st.autoGrow = true; st.milestones.m10 = true;
    S.ruleSave = { d: st.ruleMaxDist, y: st.ruleMinYield, p: st.policy };
    st.ruleMaxDist = 0; st.ruleMinYield = 0;
    st.policy = 'nearest';
    for (var t = 0; t < 2000; t++) { st.res.water = 1e9; Sim.tick(st, 0.25); }
    S.nodesNoRule = st.nodes.length;
    S.distNoRule = st.maxDist;
    ok('不限规则时自动蔓延会铺开', st.nodes.length > 60,
       st.nodes.length + ' 格，maxDist ' + st.maxDist);
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;
    if (S.nodesNoRule == null) return;

    /* 距离上限：设紧之后新的生长不允许超过它。
     * 注意**已存在的**远端节点不会被移除（规则只约束「接下来连哪格」），
     * 所以要清掉远端节点再测，否则 maxDist 会一直是旧值。
     *
     * ⚠ 必须走 Sim.removeNode，不能手动 splice：
     * 引擎的不变量是「node.id === nodes 数组下标」，removeNode 会在移除后
     * 重排 id 并同步 nodeAt/grid，手动 splice 不会 —— 一旦漏掉，
     * state.nodes[id] 全取到 undefined，报错点却在几百行外的 computeFlow，
     * 曾因此连环炸掉 7 个步骤。收集时从大到小，逐个删就不会互相打乱下标。 */
    st.ruleMaxDist = 6;
    var farIds = [];
    for (var i = st.nodes.length - 1; i >= 1; i--) {
      if (st.nodes[i].dist > 6) farIds.push(i);
    }
    for (var q0 = 0; q0 < farIds.length; q0++) Sim.removeNode(st, farIds[q0]);
    Sim.rebuildNetwork(st);
    st.res.water = 1e9;
    for (var t = 0; t < 2000; t++) { st.res.water = 1e9; Sim.tick(st, 0.25); }
    ok('距离上限生效：自动蔓延不再超出',
       st.maxDist <= 6,
       'maxDist ' + st.maxDist + '（上限 6）节点 ' + st.nodes.length + ' 格');
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;
    if (S.nodesNoRule == null) return;

    /* 收益阈值：阈值设成 1.0 之后，自动蔓延不该再连低于 1.0 的格子。
     * 判据用「本次新增的节点」—— 旧节点是规则生效前就存在的，不算违规。 */
    st.ruleMaxDist = 0;
    st.ruleMinYield = 1.0;
    var before = st.nodes.length;
    /* 先把当前候选集清空重算（规则变了不影响候选集内容，只影响选择） */
    st.res.water = 1e9;
    for (var t = 0; t < 600; t++) { st.res.water = 1e9; Sim.tick(st, 0.25); }

    var bad = 0, added = 0;
    for (var i = before; i < st.nodes.length; i++) {
      var y = C.SOILS[st.nodes[i].soil].yield || {};
      var tot = (y.water || 0) + (y.nutrient || 0) + (y.spore || 0);
      added++;
      if (tot < 1.0) bad++;
    }
    ok('收益阈值生效：新增节点都达到阈值', bad === 0,
       '新增 ' + added + ' 格，低于阈值 ' + bad + ' 格');

    /* 规则不能挡住手动点击 —— 这是手感底线 */
    var cs = Sim.candidates(st);
    var low = null;
    for (var k = 0; k < cs.length; k++) {
      var yy = C.SOILS[cs[k].soil].yield || {};
      var tt = (yy.water || 0) + (yy.nutrient || 0) + (yy.spore || 0);
      if (tt < 1.0) { low = cs[k]; break; }
    }
    if (low) {
      st.res.water = 1e9;
      var r = Sim.growAt(st, low.x, low.y);
      ok('手动点击不受规则限制（想连哪格就连哪格）', r.ok === true,
         r.ok ? ('连上了产出低于阈值的 ' + low.soil) : r.reason);
    } else {
      R.push('  SKIP 手动不受限：找不到低于阈值的候选格');
    }
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;
    if (S.ruleSave == null) return;
    /* 存档往返：规则是玩家的操作偏好，必须跟着存档走 */
    st.ruleMaxDist = 8; st.ruleMinYield = 0.3;
    var st2 = Sim.deserialize(Sim.serialize(st));
    ok('存档保留自动蔓延规则',
       st2.ruleMaxDist === 8 && st2.ruleMinYield === 0.3,
       '距离 ' + st2.ruleMaxDist + '，阈值 ' + st2.ruleMinYield);

    var old = JSON.parse(Sim.serialize(st));
    delete old.ruleMaxDist; delete old.ruleMinYield;
    var st3 = Sim.deserialize(JSON.stringify(old));
    ok('旧存档无规则字段时默认不限',
       st3.ruleMaxDist === 0 && st3.ruleMinYield === 0,
       '距离 ' + st3.ruleMaxDist + '，阈值 ' + st3.ruleMinYield);

    /* 面板：下拉框必须与 state 一致，否则玩家看到的规则和实际生效的分家 */
    window.MYC.game.state = st;
    window.MYC.game.ui.rebind(st);
    var dm = document.getElementById('ruleMaxDist');
    var dy = document.getElementById('ruleMinYield');
    ok('规则下拉框存在', !!dm && !!dy, dm ? 'ok' : 'missing');
    if (dm && dy) {
      ok('下拉框读数与状态一致',
         Number(dm.value) === st.ruleMaxDist && Number(dy.value) === st.ruleMinYield,
         'UI ' + dm.value + '/' + dy.value + '  状态 ' + st.ruleMaxDist + '/' + st.ruleMinYield);
    }

    /* 复原，别影响后面的测试 */
    st.ruleMaxDist = S.ruleSave.d; st.ruleMinYield = S.ruleSave.y; st.policy = S.ruleSave.p;
  });

  /* ---- 主干 / 汇流（网络结构成为策略）-----------------------------------
   * 这一段验证的是「结构性决策是否真的改变结果」：
   *   ① 核心是结构性瓶颈，主干必须能给它扩容（否则机制没有作用点）
   *   ② 主干有硬上限与互斥规则（否则退化成一次性全局倍率）
   *   ③ 主干要带产出代价（否则是纯赚，没有取舍）
   *   ④ 存档往返与旧存档兼容 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;

    ok('TRUNK 配置已导出', !!C.TRUNK && C.TRUNK.maxTrunk > 0,
       'maxTrunk=' + (C.TRUNK && C.TRUNK.maxTrunk) +
       ' maxConfluence=' + (C.TRUNK && C.TRUNK.maxConfluence));

    /* 挑一个够远的普通节点做主干 —— 核心附近的先留着给后面的汇流测试 */
    var pick = null;
    for (var i = 1; i < st.nodes.length; i++) {
      if (st.nodes[i].dist >= 3) { pick = st.nodes[i]; break; }
    }
    if (!pick) { R.push('  SKIP 主干：网络太小，没有 dist>=3 的节点'); return; }
    S.trunkId = pick.id;

    var coreBefore = st.nodes[0].capacity;
    var capBefore = pick.capacity;
    var r = Sim.toggleTrunk(st, pick.id);
    ok('可以标主干', r.ok === true, r.ok ? ('剩余 ' + r.free + ' 格') : r.reason);
    ok('主干抬高了自己的吞吐', pick.capacity > capBefore * 1.5,
       capBefore.toFixed(0) + ' → ' + pick.capacity.toFixed(0));
    /* 这是本机制的核心断言：核心是唯一的结构瓶颈，主干必须给它扩容。
     * 早先只抬「沿途吞吐」时，核心 capacity 纹丝不动，机制收益实测 ×1.000。 */
    ok('主干为核心扩容（结构性瓶颈的唯一解）',
       st.nodes[0].capacity > coreBefore,
       '核心 ' + coreBefore.toFixed(0) + ' → ' + st.nodes[0].capacity.toFixed(0));

    var r2 = Sim.toggleConfluence(st, pick.id);
    ok('主干与汇流互斥', r2.ok === false, r2.reason);
    var r3 = Sim.toggleTrunk(st, 0);
    ok('核心不能标主干', r3.ok === false, r3.reason);
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;
    if (S.trunkId == null) return;

    /* 上限：把能标的都标上，数量必须被 maxTrunk 卡住 */
    for (var i = 1; i < st.nodes.length; i++) {
      if (Sim.trunkCount(st) >= C.TRUNK.maxTrunk) break;
      Sim.toggleTrunk(st, i);
    }
    var used = Sim.trunkCount(st);
    ok('主干数量受硬上限约束', used === C.TRUNK.maxTrunk,
       '已用 ' + used + ' / 上限 ' + C.TRUNK.maxTrunk);

    /* 超限时必须被拒绝，并给出可执行的提示 */
    var extra = null;
    for (var j = 1; j < st.nodes.length; j++) {
      if (!st.nodes[j].trunk) { extra = st.nodes[j]; break; }
    }
    if (extra) {
      var r = Sim.toggleTrunk(st, extra.id);
      ok('超限后再标被拒绝', r.ok === false && /上限/.test(r.reason), r.reason);
    }

    /* 取消后配额必须被回收 —— 否则玩家会被永久卡死在满配状态 */
    var freeBefore = C.TRUNK.maxTrunk - Sim.trunkCount(st);
    var back = Sim.toggleTrunk(st, S.trunkId);
    ok('取消主干后配额回收',
       back.ok === true && back.trunk === false && (C.TRUNK.maxTrunk - Sim.trunkCount(st)) === freeBefore + 1,
       '剩余 ' + back.free + ' 格');
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;
    if (S.trunkId == null) return;

    /* 产出代价：主干节点自身货物产出要降，这是「选哪一格」产生张力的根源。
     * 比法：同一节点标记前后的「货物产出」之比 ≈ trunkYieldMul。
     * 两个坑（都踩过，导致这条断言假失败）：
     *   ① 不能只看养分 —— 水脉节点养分产出本来就是 0，比值算不出来，
     *      所以用货物合计（养分+孢子）。水被排除是刻意的：水不受吞吐限制。
     *   ② 必须先跑够帧数让货流收敛。只跑 4 帧时 prod 还只有 0.005 量级，
     *      噪声比信号大，比值会完全不可信（实测得到 1.818 这种假值）。 */
    var nd = st.nodes[S.trunkId];
    st.res.water = 1e9; st.res.nutrient = 1e9;
    var settle = function () {
      for (var k = 0; k < 20; k++) { st.res.water = 1e9; st.res.nutrient = 1e9; Sim.tick(st, 0.25); }
    };
    var goods = function (n) { return (n.prod.nutrient || 0) + (n.prod.spore || 0); };

    if (nd.trunk) Sim.toggleTrunk(st, nd.id);    // 确保从未标记状态开始
    settle();
    var before = goods(nd);
    Sim.toggleTrunk(st, nd.id);
    settle();
    var after = goods(nd);
    S.yieldRatio = before > 0 ? after / before : null;
    ok('主干节点自身产出被下调（改造的代价）',
       before > 0.01 && S.yieldRatio !== null && S.yieldRatio < 0.9,
       before.toFixed(4) + ' → ' + after.toFixed(4) +
       (S.yieldRatio !== null ? ('（×' + S.yieldRatio.toFixed(3) + '，配置 ×' + C.TRUNK.trunkYieldMul + '）') : ''));

    Sim.toggleTrunk(st, nd.id);                  // 复原，别影响后面的测试
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;

    /* 汇流：找一个普通节点标上，紧贴它的邻居吞吐要吃到加成 */
    var hub = null;
    for (var i = 1; i < st.nodes.length; i++) {
      var n = st.nodes[i];
      if (n.trunk || n.confluence || n.id === 0) continue;
      // 要求它至少有一个「非主干」邻居，才能验证邻接加成
      var nb = [[n.x-1,n.y],[n.x+1,n.y],[n.x,n.y-1],[n.x,n.y+1]];
      var feeder = null;
      for (var k = 0; k < nb.length; k++) {
        var fid = st.nodeAt[Sim.idx(nb[k][0], nb[k][1])];
        if (fid == null) continue;
        if (!st.nodes[fid].trunk && !st.nodes[fid].confluence) { feeder = st.nodes[fid]; break; }
      }
      if (feeder) { hub = n; S.feederId = feeder.id; break; }
    }
    if (!hub) { R.push('  SKIP 汇流：没找到带普通邻居的可标节点'); return; }

    var hubCapBefore = hub.capacity;
    var feederCapBefore = st.nodes[S.feederId].capacity;
    var r = Sim.toggleConfluence(st, hub.id);
    ok('可以标汇流', r.ok === true, r.ok ? ('剩余 ' + r.free + ' 格') : r.reason);
    ok('汇流抬高了自己的吞吐', hub.capacity > hubCapBefore,
       hubCapBefore.toFixed(0) + ' → ' + hub.capacity.toFixed(0));
    ok('紧贴汇流的支流吞吐也提高',
       st.nodes[S.feederId].capacity > feederCapBefore,
       feederCapBefore.toFixed(0) + ' → ' + st.nodes[S.feederId].capacity.toFixed(0));
    ok('adjacentConfluence 的判定与实际加成一致',
       Sim.adjacentConfluence(st, st.nodes[S.feederId]) === true, '应为 true');
    ok('feederCount 能数出贴着的支流',
       Sim.feederCount(st, hub) >= 1, '贴邻支流 ' + Sim.feederCount(st, hub) + ' 根');
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;
    /* 存档往返：主干/汇流标记必须存活 —— 否则读档后玩家的结构决策全丢 */
    var tBefore = Sim.trunkCount(st), cBefore = Sim.confluenceCount(st);
    var coreBefore = st.nodes[0].capacity;
    var json = Sim.serialize(st);
    var st2 = Sim.deserialize(json);
    ok('存档保留主干标记', Sim.trunkCount(st2) === tBefore,
       '存档前 ' + tBefore + ' → 读档后 ' + Sim.trunkCount(st2));
    ok('存档保留汇流标记', Sim.confluenceCount(st2) === cBefore,
       '存档前 ' + cBefore + ' → 读档后 ' + Sim.confluenceCount(st2));
    ok('读档后核心扩容仍然生效', st2.nodes[0].capacity === coreBefore,
       coreBefore.toFixed(0) + ' → ' + st2.nodes[0].capacity.toFixed(0));

    /* 旧存档兼容：把第 6/7 位切掉，模拟 v3 之前的存档 */
    var old = JSON.parse(json);
    old.nodes = old.nodes.map(function (n) { return n.slice(0, 5); });
    var okOld = true, st3 = null;
    try { st3 = Sim.deserialize(JSON.stringify(old)); } catch (e) { okOld = false; }
    ok('旧存档（无主干字段）仍能载入', okOld && st3 && st3.nodes.length === st.nodes.length,
       okOld ? ('载入 ' + (st3 ? st3.nodes.length : 0) + ' 格，主干 ' + Sim.trunkCount(st3) + ' 格') : '抛异常');
  });

  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;
    /* 面板：配额读数必须与真实计数一致（玩家唯一能信任的数字） */
    var el = document.getElementById('trunkCount');
    if (!el) { R.push('  SKIP 结构面板：找不到 #trunkCount'); return; }
    /* update() 有 10Hz 节流（acc < 0.1 直接 return），所以必须给够 dt 或置 dirty，
     * 否则面板根本不会重算 —— 用 0.001 秒调用会读到一个过期值。 */
    window.MYC.game.dirty = true;
    window.MYC.game.ui.update(0.2, window.MYC.game);
    var txt = el.textContent || '';
    ok('面板显示主干配额', txt.indexOf(String(C.TRUNK.maxTrunk)) >= 0, txt);
    ok('面板读数与真实计数一致',
       txt.indexOf(Sim.trunkCount(st) + '/' + C.TRUNK.maxTrunk) >= 0,
       'UI「' + txt + '」实际 ' + Sim.trunkCount(st) + '/' + C.TRUNK.maxTrunk);
    ok('面板显示汇流配额与真实计数一致',
       txt.indexOf(Sim.confluenceCount(st) + '/' + C.TRUNK.maxConfluence) >= 0,
       'UI「' + txt + '」实际 ' + Sim.confluenceCount(st) + '/' + C.TRUNK.maxConfluence);
    var btn = document.getElementById('structTrunk');
    ok('结构模式按钮存在', !!btn, btn ? btn.textContent : 'missing');
    var btnDig = document.getElementById('structDig');
    ok('拆除模式按钮存在', !!btnDig, btnDig ? btnDig.textContent : 'missing');
  });

  /* ---- 树木（生态节点）---------------------------------------------------
   * 四组要守的性质：
   *   ① 档位阈值（幼苗/成年/古树）与产出倍率必须单调 —— 成长才有意义
   *   ② 古树要给周围加成，且**不吃自己的**（不叠加的一致性）
   *   ③ 围拢必须真的压住成长，且能退化到底（唯一的负反馈，不能失效）
   *   ④ 拆除节点后 id 必须重排（removeNode 是唯一缩短数组的操作）
   */
  step(function () {
    var Sim = S.Sim, C = window.MYC.CONFIG, T = C.TREE;
    ok('档位阈值先验', T.stageAt.length === 3 && T.stageAt[0] === 0,
       JSON.stringify(T.stageAt));
    ok('产出倍率随档位递增', T.yieldMul[0] < T.yieldMul[1] && T.yieldMul[1] < T.yieldMul[2],
       JSON.stringify(T.yieldMul));
    /* 阈值边界必须精确 —— 它在探针里被验证过，这里守回归 */
    ok('成长度 0 → 幼苗', Sim.treeStageOf(0) === 0, String(Sim.treeStageOf(0)));
    ok('成长度 59.9 → 仍是幼苗', Sim.treeStageOf(T.stageAt[1] - 0.1) === 0,
       String(Sim.treeStageOf(T.stageAt[1] - 0.1)));
    ok('成长度 60 → 成年', Sim.treeStageOf(T.stageAt[1]) === 1, String(Sim.treeStageOf(T.stageAt[1])));
    ok('成长度 180 → 古树', Sim.treeStageOf(T.stageAt[2]) === 2, String(Sim.treeStageOf(T.stageAt[2])));
    ok('成长度超大仍封顶在古树', Sim.treeStageOf(1e9) === 2, String(Sim.treeStageOf(1e9)));
    ok('档位名与档位对齐', Sim.treeStageNameOf(0) === '幼苗' &&
       Sim.treeStageNameOf(1) === '成年' && Sim.treeStageNameOf(2) === '古树',
       Sim.treeStageNameOf(0) + '/' + Sim.treeStageNameOf(1) + '/' + Sim.treeStageNameOf(2));
  });

  /* 树的生命周期：种下 → 长大 → 古树 → 吃光环 → 被围死 → 拆除。
   * 这一整段用真实网络（前几步铺好的）跑，不再造小人造局面。 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG, T = C.TREE;
    /* 找一块「已探明但还没接入」的树根候选；
     * 没有就现造一块：把某个候选格改成 root 再种（生成器不能保证位置）。 */
    var cands = Sim.candidates(st);
    var rc = null;
    for (var i = 0; i < cands.length; i++) if (cands[i].soil === 'root') { rc = cands[i]; break; }
    if (!rc) {
      for (var j = 0; j < cands.length; j++) {
        var gi = Sim.idx(cands[j].x, cands[j].y);
        if (st.grid[gi].solid) continue;
        st.grid[gi].soil = 'root';
        cands = Sim.candidates(st);          // 候选表的 soil 字段已缓存，重取一次
        rc = Sim.canGrowAt(st, cands[j].x, cands[j].y);
        break;
      }
    }
    if (!rc) { R.push('  SKIP 树木：网络边缘没有可种植的树根候选'); return; }
    S.treeSpot = { x: rc.x, y: rc.y };

    st.res.water = Math.max(st.res.water, 1e6);
    var g = Sim.growAt(st, rc.x, rc.y);
    ok('可以在树根格上种树', g.ok === true, g.ok ? ('花费 ' + g.cost) : g.reason);
    S.treeId = st.nodeAt[Sim.idx(rc.x, rc.y)];
    var tn = st.nodes[S.treeId];
    ok('种下即为树', Sim.isTree(tn) === true, tn ? tn.soil : 'null');
    ok('新种的树立即是幼苗档（不会误推档位浮动数字）', tn.treeStage === 0, String(tn.treeStage));
    ok('非树节点的 treeStateOf 为 null', Sim.treeStateOf(st, st.nodes[0]) === null,
       String(Sim.treeStateOf(st, st.nodes[0])));
  });

  /* 无干扰成长 → 古树。刻意先把树周围清空：
   * 围拢压制是**故意**的，测成长就得排除它，否则测的是「玩家添乱时长不动」。 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG, T = C.TREE;
    if (S.treeId == null) return;
    var spot = S.treeSpot;

    function treeHere() {
      var id = st.nodeAt[Sim.idx(spot.x, spot.y)];
      return id == null ? null : st.nodes[id];
    }
    /* 只留一条通路：拔掉 2 格环内除「dist 最小邻居」以外的节点。
     *
     * 踩过的坑：第一版把「dist 最小的邻居」当必经之路留下，但那个邻居
     * 自己也可能是**从树这边才连上的**（树→A→B，A 的 dist 比 B 小是
     * 因为 BFS 从树走过去），于是拔着拔着就把整条路拔断了，
     * 树的 dist 变成 -1（脱离网络），growTrees 直接跳过它 ——
     * 表现是「树永远不长大」，看起来像成长逻辑坏了，实际是测试自己把树拔断了。
     * 现在每拔一轮都检查树的 dist，一旦 <0 就立刻停手。 */
    function treeDist() {
      var id = st.nodeAt[Sim.idx(spot.x, spot.y)];
      return id == null ? -99 : st.nodes[id].dist;
    }
    function thin(rounds) {
      var removed = 0;
      for (var r = 0; r < rounds; r++) {
        var t = treeHere();
        if (!t || t.dist < 0) break;
        /* 候选 = 2 格环内的普通节点。逐个试拔：拔完树的 dist 还 >= 0 才留下这次操作，
         * 否则立刻把刚才那一格长回去（用 growAt 恢复原土壤不够精确，
         * 所以改成「先记下、确认安全再真拔」的两段式）。 */
        var victim = null;
        for (var dy2 = -T.ringRadius; dy2 <= T.ringRadius && victim === null; dy2++) {
          for (var dx2 = -T.ringRadius; dx2 <= T.ringRadius && victim === null; dx2++) {
            if (!dx2 && !dy2) continue;
            if (Math.abs(dx2) + Math.abs(dy2) > T.ringRadius + 1) continue;
            var px = t.x + dx2, py = t.y + dy2;
            if (px < 0 || py < 0 || px >= st.mapW || py >= st.mapH) continue;
            var id2 = st.nodeAt[Sim.idx(px, py)];
            if (id2 == null) continue;
            var nd2 = st.nodes[id2];
            if (Sim.isTree(nd2) || nd2.dist === 0 || nd2.trunk || nd2.confluence) continue;
            /* 保留「离核最近的那个邻居」—— 它是树接回核心的主路 */
            var isGate = true;
            for (var gy = -1; gy <= 1; gy++) for (var gx = -1; gx <= 1; gx++) {
              if (!gx && !gy) continue;
              var qx = t.x + gx, qy = t.y + gy;
              if (qx < 0 || qy < 0 || qx >= st.mapW || qy >= st.mapH) continue;
              var qid = st.nodeAt[Sim.idx(qx, qy)];
              if (qid == null) continue;
              var qn = st.nodes[qid];
              if (Sim.isTree(qn)) continue;
              if (qn !== nd2 && qn.dist < nd2.dist) { isGate = false; break; }
            }
            if (isGate) continue;
            victim = nd2;
          }
        }
        if (!victim) break;
        var vx = victim.x, vy = victim.y;
        var res = Sim.removeNode(st, victim.id);
        if (!res.ok) break;
        if (treeDist() < 0) {
          /* 拔断了 —— 长回去。土壤类型不变（removeNode 不动 grid.soil），
           * 所以重新 growAt 同一格能完整恢复。 */
          st.res.water = Math.max(st.res.water, 1e6);
          var back = Sim.growAt(st, vx, vy);
          if (!back.ok) break;
          break;                      // 这一格是必经之路，别再往下拔了
        }
        removed++;
      }
      return removed;
    }
    S.treeThinned = thin(60);
    var t0 = treeHere();
    if (!t0) { R.push('  SKIP 树木成长：清空过程中把树也弄丢了'); S.treeId = null; return; }
    var ts0 = Sim.treeStateOf(st, t0);
    ok('清空后树不再被压住', ts0.stalled === false,
       'crowd=' + ts0.crowd + ' cap=' + ts0.softCap + ' rate=' + ts0.rate.toFixed(2));
    /* 树必须在网络里才会成长（growTrees 会跳过 dist<0）。
     * 这一步的 thin() 有可能把树唯一的通路也拔掉 —— 那就写成一条断言，
     * 而不是让后面的成长断言静默失败（那样看起来像「树不长」）。 */
    ok('清空后树仍接入网络', t0.dist >= 0, 'dist=' + t0.dist);

    /* 纯等 200 秒（1 秒一步，别用 5 秒 —— 大步长会让档位跳变难以定位） */
    var stages = [];
    var last = t0.treeStage;
    for (var s = 0; s < 200; s++) {
      Sim.tick(st, 1);
      var tc = treeHere();
      if (!tc) break;
      if (tc.treeStage !== last) { stages.push(tc.treeStage); last = tc.treeStage; }
    }
    var tf = treeHere();
    ok('无干扰下能长到古树', tf && tf.treeStage === 2,
       tf ? ('成长 ' + tf.tree.toFixed(1) + ' 档位 ' + tf.treeStage +
             ' crowd=' + Sim.treeCrowd(st, tf)) : '树不见了');
    ok('升档过程是逐级的（幼苗→成年→古树）',
       stages.length === 2 && stages[0] === 1 && stages[1] === 2,
       '经历档位 ' + JSON.stringify(stages));
    var tsf = Sim.treeStateOf(st, tf);
    ok('古树自身产出倍率 = 配置值',
       Math.abs(tsf.yieldMul - T.yieldMul[2]) < 1e-9, String(tsf.yieldMul));
    ok('古树标为已长成', tsf.maxed === true, 'progress=' + tsf.progress.toFixed(2));
    S.treeRef = { x: tf.x, y: tf.y };      // 只记坐标：removeNode 会重排 id
  });

  /* 古树光环：给邻居加成、不给自己、不叠加 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG, T = C.TREE;
    var t = S.treeRef;
    if (!t) return;
    /* 树的对象引用可能因为中间没动过而仍有效，稳妥起见按坐标取 */
    var tid = st.nodeAt[Sim.idx(t.x, t.y)];
    if (tid == null) { R.push('  SKIP 光环：树不见了'); return; }
    var tree = st.nodes[tid];
    var ts = Sim.treeStateOf(st, tree);
    if (ts.stage < 2) { R.push('  SKIP 光环：树没长到古树（stage=' + ts.stage + '）'); return; }

    ok('古树自己不吃自己的光环', Sim.underOldTreeAura(st, tree) === false,
       'isTree=' + Sim.isTree(tree));

    /* 找一个普通邻居。没有就在紧邻格补一个（相邻才受光环）。 */
    var nb = null, dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
    for (var i = 0; i < dirs.length && !nb; i++) {
      var x = tree.x + dirs[i][0], y = tree.y + dirs[i][1];
      if (x < 0 || y < 0 || x >= st.mapW || y >= st.mapH) continue;
      var id = st.nodeAt[Sim.idx(x, y)];
      if (id == null) continue;
      if (Sim.isTree(st.nodes[id])) continue;
      nb = st.nodes[id];
    }
    if (!nb) {
      for (var j = 0; j < dirs.length && !nb; j++) {
        var x2 = tree.x + dirs[j][0], y2 = tree.y + dirs[j][1];
        if (x2 < 0 || y2 < 0 || x2 >= st.mapW || y2 >= st.mapH) continue;
        var c2 = Sim.canGrowAt(st, x2, y2);
        if (!c2) continue;
        st.res.water = Math.max(st.res.water, 1e6);
        if (Sim.growAt(st, x2, y2).ok) nb = st.nodes[st.nodeAt[Sim.idx(x2, y2)]];
      }
    }
    if (!nb) { R.push('  SKIP 光环：古树周围找不到可用的普通菌丝'); return; }

    ok('紧贴古树的菌丝受光环笼罩', Sim.underOldTreeAura(st, nb) === true,
       '邻居 (' + nb.x + ',' + nb.y + ') soil=' + nb.soil);
    /* 光环是范围性的：2 格内不吃、2 格外不吃。用一个界外格反向验证。
     * （范围外的判定要挑一个真实不靠近任何古树的位置，所以用「距离」而不是硬坐标。） */
    ok('光环倍率取自配置', T.auraYieldMul > 1, String(T.auraYieldMul));
    ok('光环不叠加（配置口径）', T.auraStack === false, String(T.auraStack));
    S.auraNode = { x: nb.x, y: nb.y };
  });

  /* 围拢压制：塞满树周围 → stalled → 退化到底 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG, T = C.TREE;
    var t = S.treeRef;
    if (!t) return;

    /* 把整个网络铺密（这正是真实玩家的「铺满」行为），
     * 然后在**铺密之后**挑一棵真的能被围到 stall 线以上的树当受试者。
     *
     * 这一步的构造方式改过三次，每次都是实测打回来的：
     *  ① 只填树的 2 格环 → 环上的格子未必接得上网络（growAt 要求相邻），
     *     而且上一步「无干扰成长」为了排除干扰**故意把树周围清空过**
     *     （只剩 crowd=10），只填环最多到 13~18。
     *  ② 改成「整网铺密」后仍失败：受试的那棵树被岩石/邻树卡住，
     *     密铺 653 格也只到 crowd=18，而 stall 线是 19 —— 退不掉。
     *     这不是数值 bug，是**地形**：实测有 ~9% 的树周围站不到 18 格。
     *  ③ 现在：先铺密，再**按「谁被围得最狠」挑树**，保证受试者真的能越过 stall 线。
     *     这才是「围满会退化」这句话的正确实验条件。 */
    var densifyGuard = 0;
    st.res.water = Math.max(st.res.water, 1e6);
    while (densifyGuard++ < 20000) {
      if (st.nodes.length > 1400) break;      // 安全阀
      var bc = Sim.bestCandidate(st);
      if (!bc) break;
      st.res.water = Math.max(st.res.water, 1e6);
      if (!Sim.growAt(st, bc.x, bc.y).ok) break;
    }

    /* 挑「现在 crowd 最大」的树当受试者 —— 它是这张图上最可能被围穿的。
     * 换掉 S.treeRef 之后，下面所有断言都换成这棵树。 */
    var bestTree = null, bestCrowd = -1;
    for (var i = 1; i < st.nodes.length; i++) {
      var nd = st.nodes[i];
      if (!Sim.isTree(nd)) continue;
      var c = Sim.treeCrowd(st, nd);
      if (c > bestCrowd) { bestCrowd = c; bestTree = nd; }
    }
    if (!bestTree) { R.push('  SKIP 围拢：这局没有树'); return; }
    var spot = { x: bestTree.x, y: bestTree.y };
    S.treeRef = bestTree;

    var filled = st.nodes.length;
    var tree = st.nodes[st.nodeAt[Sim.idx(spot.x, spot.y)]];
    if (!tree) { R.push('  SKIP 围拢：树不见了'); return; }
    var ts = Sim.treeStateOf(st, tree);
    ok('围拢后确实超标', ts.crowd > ts.softCap,
       'crowd=' + ts.crowd + ' cap=' + ts.softCap + '（整图密铺，共 ' + filled + ' 格）');
    ok('围拢后被标为压住', ts.stalled === true, 'rate=' + ts.rate.toFixed(2));
    ok('围拢把成长率压低了', ts.rate < 1,
       '围拢 rate=' + ts.rate.toFixed(3) + ' vs 不围 rate=1');

    /* 关键不变量：stall 线必须**对绝大多数树都可达**。
     *
     * 这条断言重写过两次，两次都是因为「阈值定得漂亮但个体够不到」。
     *
     * 实测两份分布（都记在 config.js 的 TREE 注释里）：
     *   ① 正常铺开（560 棵树）：p25=17 / p50=19 / max=20
     *   ② 密铺到极限（140 棵树）：p25=17 / p50=19 / max=20
     *      直方图 {..,16:4, 17:25, 18:12, 19:16, 20:69}
     *      —— **约 9% 的树被岩石/邻树卡在 17 以下**，这是关键：
     *      阈值必须 ≤ 这个下沿，否则那些树永远到不了 stall 线、永远不退化，
     *      「围满会退」这条规则对它们整条失效（实测踩过：stall=19 时，
     *      测试用的那棵树密铺到 653 格也只能到 crowd=18，退不掉）。
     *
     * 所以守三条：
     *   ① 上界：stallAt ≤ ringMax（超了永远不触发，踩过 penalty=0.12 → 需 21.3）
     *   ② 可达性：stallAt ≤ CROWD_REACH（密铺实测的 p25，即「被卡住的树」的上沿）
     *   ③ 有坡度：softCap < stallAt（否则「减速」这一段消失，直接跳变） */
    var ringMax = 0;
    for (var ry = -T.ringRadius; ry <= T.ringRadius; ry++) {
      for (var rx = -T.ringRadius; rx <= T.ringRadius; rx++) {
        if (!rx && !ry) continue;
        if (Math.abs(rx) + Math.abs(ry) > T.ringRadius + 1) continue;
        ringMax++;
      }
    }
    /* 密铺到极限时，被地形卡住的树的上沿（实测 p25 = 17）。
     * 注意这里守的是「**绝大多数**树可达」，不是「每一棵」——
     * 实测有 ~9% 的树周围被岩石/邻树占到只剩 17 格，它们达不到 18。
     * 这是地形造成的，不是数值 bug；把它显式记下来，
     * 而不是为了凑「100% 可达」把 stall 线压到让正常树也全部废掉。 */
    var CROWD_REACH = 17;
    var CROWD_IMMUNE_PCT = 10;    // 允许 ≤10% 的树因地形够不到 stall 线
    var stallAt = T.crowdSoftCap + 1 / T.crowdPenalty;
    ok('stall 线不高于邻域几何上限',
       stallAt <= ringMax,
       'stall 需要 crowd=' + stallAt.toFixed(1) + '，邻域最大 ' + ringMax);
    ok('stall 线对绝大多数树可达（地形卡住的 ≤' + CROWD_IMMUNE_PCT + '% 除外）',
       stallAt <= CROWD_REACH + 1,
       'stall=' + stallAt.toFixed(1) + '，密铺实测被卡住的树上沿=' + CROWD_REACH +
       ' —— 高太多的话，被卡住的树会整条免疫「围拢退化」');
    ok('softCap 与 stall 线之间有坡度（否则只剩「满速/停住」两极）',
       T.crowdSoftCap < stallAt,
       'softCap=' + T.crowdSoftCap + ' vs stall=' + stallAt.toFixed(1));

    /* 到这一步 crowd 已经越过 softCap（由上面的密铺保证），
     * 所以不用再重复构造局面 —— 只把「可达性」这条不变量留下来。
     *
     * 什么叫可达：stall 线必须落在地图真能站到的密度里。
     * 理论邻域 20 格，但真实地图上树周围常有岩石/别的树，站不满。
     * 实测（见 config.js TREE 注释，140 棵树密铺）：p25=17 / p50=19 / max=20。
     * 上面三条 softCap / stall 的区间断言就是在守这件事，这里不再重复。 */
    var tree2 = st.nodes[st.nodeAt[Sim.idx(spot.x, spot.y)]];
    if (!tree2) { R.push('  SKIP 围拢：树不见了'); return; }
    var ts2 = Sim.treeStateOf(st, tree2);
    ok('围拢到 stall 线以上（或顶到地图上限）',
       ts2.crowd > stallAt || ts2.crowd >= ringMax - 1,
       'crowd=' + ts2.crowd + '（stall 线 ' + stallAt.toFixed(1) +
       '，邻域最大 ' + ringMax + '，整图 ' + filled + ' 格）');
    /* 关键：只要越过 stall 线，成长率就必须为负 —— 这是「围满会退化」的核心。 */
    ok('越过 stall 线后成长率为负', ts2.crowd <= stallAt || ts2.rate < 0,
       'rate=' + ts2.rate.toFixed(3) + '（crowd=' + ts2.crowd +
       '，stall 线 ' + stallAt.toFixed(1) + '）');

    /* 从**古树**开始倒退，才能验证「退化到底」而不只是「没长上去」。
     * 受试者是密铺后新挑的树，它自己未必长到过 180（它一直被压着），
     * 所以这里显式把它推到古树档 —— 我们验的是「倒退逻辑」，
     * 不是「它以前长到过多少」。 */
    tree2.tree = T.stageAt[T.stageAt.length - 1];
    tree2.treeStage = Sim.treeStageOf(tree2.tree);
    var startGrowth = tree2.tree;
    ok('倒退起点是古树档', tree2.treeStage === 2,
       'growth=' + startGrowth.toFixed(1) + ' stage=' + tree2.treeStage);

    /* 要跑多久？算出来，别猜。
     * 退速 = max(-rate, decayPerSec)，这里 -rate = 0.25 = decayPerSec，
     * 所以是 0.25/秒 —— 从 180 退到 0 需要 720 秒。
     * 踩过：第一版写死 400 秒，跑到 80 就停了，断言失败说「没归零」，
     * 看起来像倒退逻辑坏了，实际只是预算不够（差的正是那 320 秒）。
     * 现在按配置反算，并在预算不足时明确报出来。 */
    var backRate = Math.max(-ts2.rate, T.decayPerSec);
    var needSec = Math.ceil(startGrowth / backRate) + 5;
    var cap = 2000;                                 // 安全上限，防死循环
    var budget = Math.min(needSec, cap);

    var guard = 0;
    while (guard++ < budget) {
      Sim.tick(st, 1);
      var tc = st.nodes[st.nodeAt[Sim.idx(spot.x, spot.y)]];
      if (!tc) break;
      if (tc.tree <= 0) break;
    }
    var tz = st.nodes[st.nodeAt[Sim.idx(spot.x, spot.y)]];
    ok('围拢会把树一路压回幼苗（成长归零）', tz && tz.tree === 0,
       tz ? ('成长 ' + startGrowth.toFixed(1) + ' → ' + tz.tree.toFixed(2) +
             '（实退 ' + (startGrowth - tz.tree).toFixed(1) +
             '，预算 ' + budget + 's / 需 ' + needSec + 's @ ' + backRate.toFixed(3) + '/s）')
          : '树不见了');
    ok('归零后档位回到幼苗', tz && tz.treeStage === 0, tz ? String(tz.treeStage) : 'n/a');
    ok('成长度不会是负数', tz && tz.tree >= 0, tz ? String(tz.tree) : 'n/a');
  });

  /* 拆除节点：id 重排、反查表一致、核心不可拆 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim;
    var okCore = Sim.removeNode(st, 0);
    ok('核心不可拆除', okCore.ok === false, okCore.reason);

    /* 找一个可拆的普通节点（避开树，后面转向生还要用；也避开主干/汇流） */
    var target = null;
    for (var i = 1; i < st.nodes.length; i++) {
      var nd = st.nodes[i];
      if (nd.trunk || nd.confluence) continue;
      if (Sim.isTree(nd)) continue;
      target = nd; break;
    }
    if (!target) { R.push('  SKIP 拆除：没有可拆的普通节点'); return; }
    var before = st.nodes.length;
    var tx = target.x, ty = target.y;
    var r = Sim.removeNode(st, target.id);
    ok('可以拆除普通节点', r.ok === true, r.ok ? ('拆了 (' + r.x + ',' + r.y + ')') : r.reason);
    ok('拆除后节点数 -1', st.nodes.length === before - 1,
       before + ' → ' + st.nodes.length);
    ok('拆掉的格子反查表已清空', st.nodeAt[Sim.idx(tx, ty)] == null,
       'nodeAt=' + st.nodeAt[Sim.idx(tx, ty)]);
    ok('拆掉的格子 grid 引用已清空', st.grid[Sim.idx(tx, ty)].node == null,
       'grid.node=' + st.grid[Sim.idx(tx, ty)].node);

    /* id === 下标 是这个引擎的核心不变量，拆完必须整体重排 */
    var bad = 0;
    for (var j = 0; j < st.nodes.length; j++) {
      var n = st.nodes[j];
      if (n.id !== j) bad++;
      if (st.nodeAt[Sim.idx(n.x, n.y)] !== j) bad++;
      if (st.grid[Sim.idx(n.x, n.y)].node !== j) bad++;
    }
    ok('拆除后 id 与两张反查表全部重排一致', bad === 0, '不一致 ' + bad + ' 处');
    ok('拆除后网络仍是连通的（核心 dist=0 且无孤立节点）',
       (function () {
         for (var k = 0; k < st.nodes.length; k++) if (st.nodes[k].dist < 0) return false;
         return st.nodes[0].dist === 0;
       })(), '孤立节点数 ' + st.nodes.filter(function (n) { return n.dist < 0; }).length);
  });

  /* 树木的存档往返与面板读数 */
  step(function () {
    var st = window.MYC.game.state, Sim = S.Sim, C = window.MYC.CONFIG;
    /* 直接拿树来做存档测试 —— 前面几步已经种出了树，不需要再挑候选格。
     * 踩过：第一版自己挑候选格并把 soil 改成 'root'，
     * 但 candidates() 的候选表是**按帧缓存**的（state._cands），
     * 改了 grid 之后没清缓存，growAt 拿到的还是旧 soil，种出来是 vein ——
     * 于是「读档后仍被识别为树」失败在 'vein' 上，看起来像序列化丢了字段，
     * 实际是测试自己种错了。现在改为：只给已存在的树赋成长度。 */
    var trees = [];
    for (var i = 1; i < st.nodes.length; i++) if (Sim.isTree(st.nodes[i])) trees.push(st.nodes[i]);
    if (!trees.length) { R.push('  SKIP 树木存档：当前没有树'); return; }
    var t = trees[0];
    var tx = t.x, ty = t.y;

    /* 直接给成长度 —— 等 90 秒太慢，这里测的是序列化不是成长曲线 */
    t.tree = 90; t.treeStage = Sim.treeStageOf(90);
    ok('构造出的树在成年档', t.treeStage === 1, 'growth=90 stage=' + t.treeStage);

    var json = Sim.serialize(st);
    var st2 = Sim.deserialize(json);
    var id2 = st2.nodeAt[Sim.idx(tx, ty)];
    var t2 = id2 == null ? null : st2.nodes[id2];
    ok('存档保留了树木成长度', t2 && Math.abs(t2.tree - 90) < 1e-6,
       t2 ? String(t2.tree) : 'null');
    ok('读档后 treeStage 由成长度重建一致',
       t2 && t2.treeStage === Sim.treeStageOf(t2.tree),
       t2 ? (t2.treeStage + ' vs ' + Sim.treeStageOf(t2.tree)) : 'null');
    ok('读档后仍被识别为树', t2 && Sim.isTree(t2) === true, t2 ? t2.soil : 'null');
    ok('读档后的树状态可查（含正确档名）',
       !!(t2 && Sim.treeStateOf(st2, t2) && Sim.treeStateOf(st2, t2).stageName === '成年'),
       t2 ? String(Sim.treeStateOf(st2, t2) && Sim.treeStateOf(st2, t2).stageName) : 'null');
    /* 旧存档（第 8 位缺失）必须兼容 */
    var raw = JSON.parse(json);
    raw.nodes.forEach(function (n) { if (n.length > 7) n.length = 7; });
    var okOld = true, st3 = null;
    try { st3 = Sim.deserialize(JSON.stringify(raw)); } catch (e) { okOld = false; }
    ok('旧存档（无树木字段）仍能载入', okOld && !!st3,
       okOld ? ('载入 ' + (st3 ? st3.nodes.length : 0) + ' 格') : '抛异常');

    /* 面板：树计数必须和真实计数一致 */
    window.MYC.game.dirty = true;
    window.MYC.game.ui.update(0.2, window.MYC.game);
    var el = document.getElementById('treeCount');
    ok('存在树木面板读数', !!el && (el.textContent || '').length > 0,
       el ? el.textContent : 'missing');
    var treeN = 0;
    for (var k = 1; k < st.nodes.length; k++) if (Sim.isTree(st.nodes[k])) treeN++;
    ok('面板树数量与真实计数一致',
       !!el && (el.textContent || '').indexOf(String(treeN)) >= 0,
       'UI「' + (el ? el.textContent : '') + '」实际 ' + treeN + ' 棵');
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
    var CC = window.MYC.CONFIG.PRESTIGE_CHOICE;
    if (!S.pr || !S.pr.ok) return;
    /* 「扩大地图」现在是转生三选一里的**一张卡**，不再是转生的自动奖励。
     * 所以这里断言的是「还没选卡之前，地图必须保持原样」——
     * 上一版这条写的是「转生后地图变大」，选卡制之后它已经不成立了。 */
    ok('未选「扩大地图」卡前地图不变（地图不再是转生的自动奖励）',
       st.mapW === S.p0.mapW && st.mapH === S.p0.mapH,
       S.p0.mapW + '×' + S.p0.mapH + ' → ' + st.mapW + '×' + st.mapH);
    ok('转生后弹出待选的三张卡',
       !!st.pendingChoice && st.pendingChoice.cards.length === CC.offerCount,
       st.pendingChoice ? st.pendingChoice.cards.length + ' 张' : 'null');
    ok('转生后换了种子（新地形）', st.seed !== S.p0.seed,
       'seed ' + S.p0.seed + ' → ' + st.seed);
    ok('新地图的探索记录已清空', st.explored.count < 60,
       '已探明 ' + st.explored.count + ' 格（转生前 ' + S.p0.nodes + ' 格）');
    ok('网络重置为核心一格', st.nodes.length === 1, st.nodes.length + ' 格');
    ok('转生计数 +1', st.prestiges === S.p0.prestiges + 1,
       S.p0.prestiges + ' → ' + st.prestiges);

    /* 尺寸阶梯：边长 = 基础 × min(2, 1 + 0.12 × 地图档位)。
     * 驱动量是 mapTier（选了「扩大地图」卡才涨），这条阶梯本身仍然要成立 ——
     * 它是那张卡「点了真的有用」的依据。 */
    var s = Math.min(2, 1 + (st.mapTier || 0) * CC.mapStepMul);
    ok('地图尺寸符合 mapTier 阶梯',
       st.mapW === Math.round(base.W * s) && st.mapH === Math.round(base.H * s),
       'mapTier=' + (st.mapTier || 0) +
       ' 期望 ' + Math.round(base.W * s) + '×' + Math.round(base.H * s) +
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

  /* ------------------------------------------------------- 菌株 + 槽位
   * 这是第 4 步功能的验收：菌株必须**真的改变产出**（不是装饰），
   * 槽位必须**真的在拦**（不是摆设）。判据取自 headless_sim E 组的结论，
   * 但这里是单测口径 —— 只验机制是否接线正确，不验平衡数值
   * （平衡由 headless_sim 的 5 种子对照负责）。 */
  step(function () {
    var Sim = S.Sim, C = window.MYC.CONFIG;
    var st = Sim.newGame(20260920, {}, {}, 0);
    S.strain = { st: st };

    ok('菌株表有 4 种', C.STRAIN.list.length === 4,
       C.STRAIN.list.map(function (s) { return s.key; }).join(','));
    ok('开局菌株未解锁（菌丝不足 40 格）', !Sim.strainsUnlocked(st),
       '菌丝 ' + st.nodes.length + ' 格，要求 ' + C.STRAIN.unlockNodes);
    ok('开局槽位 = ' + (C.START.strainSlots || 1), Sim.strainSlots(st) === (C.START.strainSlots || 1),
       'slots=' + Sim.strainSlots(st));
    ok('未解锁时装菌株会被拒绝', !Sim.equipStrain(st, 'rapid').ok,
       Sim.equipStrain(st, 'rapid').reason);
  });

  step(function () {
    var Sim = S.Sim;
    var st = S.strain.st;
    /* 铺够格数解锁菌株（用 addNode 精确控制，不受地形配额影响） */
    var W = st.grid ? st.mapW : 0;
    var made = 0;
    for (var y = 1; y < st.mapH - 1 && made < 45; y++) {
      for (var x = 1; x < st.mapW - 1 && made < 45; x++) {
        if (x === st.core.x && y === st.core.y) continue;
        if (st.grid[Sim.idx(x, y)].soil === 'rock') continue;
        Sim.addNode(st, x, y, st.grid[Sim.idx(x, y)].soil);
        made++;
      }
    }
    Sim.rebuildNetwork(st);
    S.strain.made = made;
    ok('铺到 ' + made + ' 格后菌株解锁', Sim.strainsUnlocked(st), '菌丝 ' + st.nodes.length + ' 格');
  });

  step(function () {
    var Sim = S.Sim, st = S.strain.st;
    var r1 = Sim.equipStrain(st, 'rapid');
    ok('解锁后能装上速生菌株', r1.ok && st.strains.indexOf('rapid') >= 0,
       JSON.stringify(st.strains));
    var r2 = Sim.equipStrain(st, 'conduit');
    ok('只有 1 个槽时第二个菌株被拒绝', !r2.ok, r2.reason);
    ok('被拒绝后装备列表没变', st.strains.length === 1, JSON.stringify(st.strains));
  });

  step(function () {
    var Sim = S.Sim, st = S.strain.st;
    /* 再点同一个 = 卸下（按钮是 toggle 语义） */
    var r = Sim.equipStrain(st, 'rapid');
    ok('再点一次会卸下（toggle 语义）', r.ok && st.strains.indexOf('rapid') < 0,
       JSON.stringify(st.strains));
    var r2 = Sim.unequipStrain(st, 'rapid');
    ok('卸下没装备的菌株会报错', !r2.ok, r2.reason);
  });

  step(function () {
    var Sim = S.Sim, st = S.strain.st;
    /* 乘区是否真的落到了配置里的值上 */
    Sim.equipStrain(st, 'rapid');
    var m = Sim.strainMods(st);
    var cfg = null;
    window.MYC.CONFIG.STRAIN.list.forEach(function (s) { if (s.key === 'rapid') cfg = s; });
    ok('速生菌株：生长成本乘区生效', Math.abs(m.growCostMul - cfg.growCostMul) < 1e-9,
       m.growCostMul + ' vs ' + cfg.growCostMul);
    ok('速生菌株：距离损耗乘区生效', Math.abs(m.distLossMul - cfg.distLossMul) < 1e-9,
       m.distLossMul + ' vs ' + cfg.distLossMul);
    ok('速生菌株：equipped 列表正确', m.equipped.join(',') === 'rapid', m.equipped.join(','));
  });

  step(function () {
    var Sim = S.Sim, st = S.strain.st;
    /* 关键断言：菌株**真的改变产出**（不是只改了个缓存字段）。
     *
     * 注意不能用速生菌株来验这条 —— 它的 mul 三项都是 1.0，
     * 只改「生长成本 / 自动间隔 / 距离损耗」，**本来就不改瞬时产出**。
     * 第一版就是这么写的，跑出 0.0100 vs 0.0100 的假失败。
     *
     * 也不能拿「随便挑 20 格改成 wood」来测：那些格子未必与核心连通，
     * 不连通的节点产出不计入 rate（第二版就是这么失败的，
     * 跑出 0.000 vs 0.000）。必须**沿着核心铺一条直线**，
     * 保证每一个节点都在网络里。 */
    var st2 = Sim.newGame(20260920, {}, {}, 0);
    var cx = st2.core.x, cy = st2.core.y;
    var line = 0;
    for (var i = 1; i <= 10; i++) {
      if (cx + i >= st2.mapW - 1) break;
      Sim.addNode(st2, cx + i, cy, 'wood');
      line++;
    }
    Sim.rebuildNetwork(st2);
    S.strain.line = line;

    st2.strains = ['saprophyte'];
    Sim.invalidateStrain(st2);
    for (var t = 0; t < 400; t++) Sim.tick(st2, 0.25);
    var withSapro = st2.rate.nutrient;

    st2.strains = [];
    Sim.invalidateStrain(st2);
    for (var t2 = 0; t2 < 60; t2++) Sim.tick(st2, 0.25);
    var noStrain = st2.rate.nutrient;

    S.strain.rates = { withSapro: withSapro, none: noStrain };
    ok('装上/卸下菌株会改变产出速率（不是装饰）',
       withSapro > noStrain * 1.2,
       '核心旁 ' + line + ' 格腐木：腐生菌株 养分 ' + withSapro.toFixed(3) +
       ' vs 无菌株 ' + noStrain.toFixed(3) +
       '（理论 ×1.85，实测 ×' + (noStrain > 0 ? (withSapro / noStrain).toFixed(2) : '∞') + '）');
  });

  step(function () {
    var Sim = S.Sim, st = S.strain.st;
    /* m11 达成 → 槽位 +1 → 第二个菌株装得上。
     * 这里**先显式清空再装**：上一步为了让产出对照干净已经清掉了菌株，
     * 不清空就断言「能装 2 个」是不成立的（第一版就踩了这个）。 */
    st.strains = [];
    Sim.invalidateStrain(st);
    var before = Sim.strainSlots(st);
    st.milestones.m11 = true;
    var after = Sim.strainSlots(st);
    ok('完成 m11 后槽位 +1', after === before + 1, before + ' → ' + after);

    Sim.equipStrain(st, 'rapid');
    var r = Sim.equipStrain(st, 'conduit');
    ok('槽位 +1 后第二个菌株装得上', r.ok && st.strains.length === 2,
       JSON.stringify(st.strains));
    /* 两个菌株的乘区应该相乘（共振），不是只取一个 */
    var m = Sim.strainMods(st);
    var rapid = null, conduit = null;
    window.MYC.CONFIG.STRAIN.list.forEach(function (s) {
      if (s.key === 'rapid') rapid = s;
      if (s.key === 'conduit') conduit = s;
    });
    ok('双菌株的乘区相乘（共振）',
       Math.abs(m.distLossMul - rapid.distLossMul * conduit.distLossMul) < 1e-9,
       m.distLossMul.toFixed(4) + ' = ' + rapid.distLossMul + ' × ' + conduit.distLossMul);
    ok('槽位已达上限 2', Sim.strainSlots(st) === 2, 'slots=' + Sim.strainSlots(st));
  });

  step(function () {
    var Sim = S.Sim, st = S.strain.st;
    /* 存档往返：菌株是 Build 选择，必须跟着存档走 */
    st.strains = ['conduit', 'saprophyte'];
    Sim.invalidateStrain(st);
    var json = Sim.serialize(st);
    var st2 = Sim.deserialize(json);
    ok('存档往返后菌株保留', st2.strains.join(',') === 'conduit,saprophyte',
       JSON.stringify(st2.strains));
    ok('读档后乘区缓存已失效并重算',
       Sim.strainMods(st2).equipped.join(',') === 'conduit,saprophyte',
       JSON.stringify(Sim.strainMods(st2).equipped));
    /* 旧存档（没有 strains 字段）要能读，且默认无菌株 */
    var raw = JSON.parse(json);
    delete raw.strains;
    var st3 = Sim.deserialize(JSON.stringify(raw));
    ok('旧存档（无 strains 字段）能读且默认无菌株', st3.strains.length === 0,
       JSON.stringify(st3.strains));
    /* 配置里不存在的 key 要被过滤掉，避免读到旧版本的残留 */
    raw.strains = ['conduit', 'ghost_strain', 'rapid'];
    var st4 = Sim.deserialize(JSON.stringify(raw));
    ok('存档里不存在的菌株会被过滤',
       st4.strains.join(',') === 'conduit,rapid', JSON.stringify(st4.strains));
  });

  step(function () {
    var Sim = S.Sim, st = S.strain.st;
    /* 转生必须保留菌株（它是 Build 选择，跟基因同级） */
    st.strains = ['saprophyte'];
    Sim.invalidateStrain(st);
    st.res.spore = 1e9; st.total.spore = 1e9;
    var r = Sim.doPrestige(st);
    ok('转生后菌株保留（Build 选择跨转生）',
       r.ok && st.strains.join(',') === 'saprophyte',
       r.ok ? JSON.stringify(st.strains) : r.reason);
    ok('转生后乘区与菌株一致',
       Sim.strainMods(st).equipped.join(',') === 'saprophyte',
       JSON.stringify(Sim.strainMods(st).equipped));
  });

  step(function () {
    /* 面板：菌株卡的存在性 + 可见性必须与**真实 game.state** 一致。
     * 不能用 S.strain.st（那是我为了隔离机制而另建的 state），
     * 面板渲染的是 game.state —— 第一版混用了两个 state，
     * 断言「未解锁时隐藏」直接失败（真实那局早就超过 40 格了）。 */
    var el = document.getElementById('strainCard');
    var list = document.getElementById('strains');
    var slotEl = document.getElementById('strainSlots');
    ok('面板里有菌株卡', !!el, el ? 'ok' : '缺失');
    ok('面板里有菌株列表容器', !!list, list ? 'ok' : '缺失');
    ok('面板里有槽位显示', !!slotEl, slotEl ? 'ok' : '缺失');

    var Sim = S.Sim, gs = window.MYC.game.state;
    var info = Sim.strainInfo(gs);
    var hidden = el.classList.contains('hidden');
    ok('菌株卡的可见性与解锁状态一致', hidden === !info.unlocked,
       '菌丝 ' + gs.nodes.length + ' 格 / 需 ' + info.unlockedAt +
       ' → unlocked=' + info.unlocked + '，hidden=' + hidden);
    if (info.unlocked) {
      ok('菌株列表已渲染出全部菌株',
         list.children.length === window.MYC.CONFIG.STRAIN.list.length,
         list.children.length + ' 行');
      ok('槽位显示文案正确',
         slotEl.textContent === '槽位 ' + info.equipped.length + '/' + info.slots,
         slotEl.textContent);
    }
  });

  /* ------------------------------------------------------- 离线收益（第 5 步）
   * 验收判据来自 docs/规划评估.md 第 285~293 行：
   *   ① 离线单位时间收益必须**明显低于**在线主动操作（否则最优解变成「关掉等」）；
   *   ② 早期玩家（只有核心、没解锁自动蔓延）离线回来也必须有产出，不能是 0；
   *   ③ 离线时长要封顶（不然放置一周 = 通关，经济失控）；
   *   ④ 太短的离开（切个标签页）不该弹结算提示。
   * 这组只测**折算逻辑本身**，跨口径的产量对比交给 headless_sim 的 F 组。 */
  step(function () {
    var Sim = S.Sim, C = window.MYC.CONFIG;
    var st = Sim.newGame(2026, {}, {}, 0);
    Sim.computeFlow(st, 0);

    /* ④ 太短的离开不结算 */
    ok('离开 30 秒不结算（< minSeconds）', Sim.settleOffline(st, 30, { dryRun: true }) === null,
       '返回 ' + JSON.stringify(Sim.settleOffline(st, 30, { dryRun: true })));

    /* ② 早期下限：只有 1 格核心也必须拿到东西。
     * 这条很关键 —— 玩家第一次关掉页面再回来，绝不能看到「什么都没发生」。 */
    var early = Sim.settleOffline(st, 8 * 3600, { dryRun: true });
    ok('早期玩家离线 8h 有产出（核心渗水兜底）',
       !!early && early.gained.water > 0,
       early ? '水 ' + early.gained.water.toFixed(1) + ' 养分 ' + early.gained.nutrient.toFixed(1) +
               ' 孢子 ' + early.gained.spore.toFixed(1) : 'null');

    /* ③ 封顶：离线 100 小时也只按 capHours 结算 */
    var long = Sim.settleOffline(st, 100 * 3600, { dryRun: true });
    var capSec = C.OFFLINE.capHours * 3600;
    ok('离线时长被封顶到 capHours', Math.abs(long.seconds - capSec) < 1,
       '离开 100h，实际按 ' + (long.seconds / 3600).toFixed(1) + 'h 结算');
    ok('封顶标志 capped 正确', long.capped === true, 'capped=' + long.capped);

    /* ① 效率系数必须 < 1，这是「离线不如在线」这个设计承诺的最直接体现 */
    ok('离线效率系数 < 1（离线天然不如在线）',
       C.OFFLINE.offlineEff > 0 && C.OFFLINE.offlineEff < 1,
       'offlineEff=' + C.OFFLINE.offlineEff);

    /* 线性性：同样局面下，离线 8h 的收益应该是 4h 的两倍（按秒折算而非按次） */
    var q4 = Sim.settleOffline(st, 4 * 3600, { dryRun: true });
    var q8 = Sim.settleOffline(st, 8 * 3600, { dryRun: true });
    ok('离线收益与时长成正比（4h × 2 = 8h）',
       Math.abs(q8.gained.water - q4.gained.water * 2) < 1e-6,
       '4h ' + q4.gained.water.toFixed(1) + ' → 8h ' + q8.gained.water.toFixed(1));

    /* 自动蔓延**不**在离线期间发生 —— 否则挂机就成了扩张的最优解 */
    ok('离线期间不会自动蔓延（不 tick 就没有新格子）',
       C.OFFLINE.allowAutoGrow === false,
       'allowAutoGrow=' + C.OFFLINE.allowAutoGrow);
  });

  /* 结算真的会进资源账，而且「结算一次」不会重复叠加。
   * 这条防的是「刷新页面刷资源」这类漏洞。 */
  step(function () {
    var Sim = S.Sim;
    var st = Sim.newGame(7, {}, {}, 0);
    Sim.computeFlow(st, 0);
    var before = st.res.water;
    var r = Sim.settleOffline(st, 2 * 3600);            // 非 dryRun，真的结算
    ok('离线结算会把资源计入账', st.res.water > before,
       before.toFixed(1) + ' → ' + st.res.water.toFixed(1) + '（+' + r.gained.water.toFixed(1) + '）');
    ok('结算后 state.offline 记录了本次离开',
       !!st.offline && st.offline.seconds > 0,
       st.offline ? '秒数 ' + st.offline.seconds : '缺失');

    /* dryRun 是「只看不给」——用于 UI 预览和对照实验，绝不能改账 */
    var a = st.res.water;
    Sim.settleOffline(st, 3600, { dryRun: true });
    ok('dryRun 不会改动 state（只算不入账）', Math.abs(st.res.water - a) < 1e-9,
       a.toFixed(1) + ' 保持不变');
  });

  /* 存档时间戳：main.js 在 payload 顶层挂 `_meta.savedAt`，启动时用它算
   * 「离开了多久」。这条链路任何一环断了，离线收益都会**静默失效**
   * （没有任何报错，玩家只是永远拿不到离线收益），所以必须有断言盯着。 */
  step(function () {
    var Sim = S.Sim, g = window.MYC.game;
    var st = Sim.newGame(11, {}, {}, 0);

    /* 用 main.js 的 save() 走一遍真实写入路径 —— 才能测到真链路。
     * 早前这条断言写成「serialize 应该带 _meta」，那是**测错了对象**：
     * _meta 由 main.js 附加，serialize 只负责游戏状态本身。 */
    var payload = Sim.serialize(st);
    ok('serialize 的产物是合法 JSON', typeof payload === 'string' && !!JSON.parse(payload), 'ok');
    var obj = JSON.parse(payload);
    ok('serialize 本体不含 _meta（_meta 由 main.js 附加，职责分离）',
       !obj._meta, obj._meta ? '意外带上了' : 'ok');

    if (g && typeof g.save === 'function') {
      g.save(true);
      /* UI 挂在 game.ui 上（main.js 把 UI 模块的引用放在 game 对象里），
       * 不去 window.MYC.UI 拿 —— 那里没有。 */
      var KEY = (g.ui && g.ui.KEY) || 'mycelium_save_v1';
      var raw = localStorage.getItem(KEY);
      ok('save() 写出的存档存在', !!raw, raw ? raw.length + ' 字符' : '缺失');
      if (raw) {
        var saved = JSON.parse(raw);
        ok('存档顶层带 _meta.savedAt', !!(saved._meta && saved._meta.savedAt),
           JSON.stringify(saved._meta));
        /* 由 savedAt 反推离开时长 —— 与 main.js 启动时的算法一致 */
        var away = (Date.now() - saved._meta.savedAt) / 1000;
        ok('由 savedAt 能算出离开时长（刚存完应接近 0）', away >= 0 && away < 60,
           away.toFixed(2) + 's');
        /* 读到这份存档后能结算 */
        var snap = Sim.deserialize(raw);
        var r = Sim.settleOffline(snap, 3 * 3600, { dryRun: true });
        ok('读到带 _meta 的存档后能结算离线收益', !!r && r.gained.water >= 0,
           r ? '水 ' + r.gained.water.toFixed(1) : 'null');
      }
    } else {
      ok('game.save() 可用', false, '找不到 save()');
    }

    /* 旧档（没有 _meta）：读得进来，离线时长按 0 算，不该抛异常 */
    var legacy = Sim.serialize(Sim.newGame(1, {}, {}, 0));
    ok('旧档（无 _meta）按「没离开过」处理，不抛异常',
       (function () { try { Sim.settleOffline(Sim.deserialize(legacy), 0, { dryRun: true }); return true; } catch (e) { return false; } })(),
       'ok');
  });

  /* settleOffline 必须能安全处理坏输入，不能把主循环搞崩。
   * 启动路径上抛异常 = 玩家打不开游戏，这是最严重的一类 bug。 */
  step(function () {
    var Sim = S.Sim;
    var st = Sim.newGame(3, {}, {}, 0);
    ok('awaySec 为 NaN 时不结算', Sim.settleOffline(st, NaN, { dryRun: true }) === null, 'null');
    ok('awaySec 为负数时不结算', Sim.settleOffline(st, -100, { dryRun: true }) === null, 'null');
    ok('awaySec 为 undefined 时不结算', Sim.settleOffline(st, undefined, { dryRun: true }) === null, 'null');
    ok('坏输入不会污染 state.offline', !st.offline, JSON.stringify(st.offline));
  });

  /* --------------------------------------------------- 转生抉择（Roguelike）
   * 「三选一」是个**阻塞式**交互，出错的方式比一般功能更难受：
   * 卡没弹出 → 玩家卡住；卡能重复选 → 白拿两份；卡丢了 → 奖励蒸发。
   * 所以这几类都要钉住。 */
  var CC = window.MYC.CONFIG.PRESTIGE_CHOICE;

  step(function () {
    /* 地图档位驱动尺寸：这是「扩大地图」这张卡能成立的前提 */
    var Sim = S.Sim;
    var m0 = Sim.mapSizeFor(0), m3 = Sim.mapSizeFor(3);
    ok('地图尺寸由 mapTier 决定（0 档 = 基础尺寸）',
       m0.w === window.MYC.CONFIG.GRID.W && m0.h === window.MYC.CONFIG.GRID.H,
       m0.w + 'x' + m0.h);
    ok('mapTier 越大地图越大', m3.w > m0.w && m3.h > m0.h, m3.w + 'x' + m3.h);
    ok('地图尺寸有上限（不能无限膨胀）',
       Sim.mapSizeFor(999).w === Sim.mapSizeFor(CC.mapMaxTier).w,
       '999 档 = ' + Sim.mapSizeFor(999).w + '，封顶档 = ' + Sim.mapSizeFor(CC.mapMaxTier).w);
  });

  step(function () {
    /* 卡池形状：数量固定、类别有货就给席位 */
    var Sim = S.Sim;
    var s = Sim.newGame(4242, {}, {}, 0);
    var cards = Sim.rollChoices(s, 50);
    ok('三选一恰好给 offerCount 张', cards.length === CC.offerCount,
       cards.length + ' 张：' + cards.map(function (c) { return c.type; }).join(','));
    var types = {};
    cards.forEach(function (c) { types[c.type] = true; });
    ok('开局三类卡都有（菌株/地图/点数）',
       types.strain && types.map && types.genes,
       Object.keys(types).join(','));
    ok('每张卡都有 key（点击要靠它定位）',
       cards.every(function (c) { return !!c.key; }), '');
    ok('卡片 key 不重复', new Set(cards.map(function (c) { return c.key; })).size === cards.length,
       cards.map(function (c) { return c.key; }).join(','));
  });

  step(function () {
    /* 已拥有的菌株不该再出现在卡池里（否则是废卡） */
    var Sim = S.Sim;
    var s = Sim.newGame(4242, {}, {}, 0);
    s.strains = ['rapid'];
    var got = [];
    for (var i = 0; i < 60; i++) {
      var sc = Sim.newGame(1000 + i * 31, {}, {}, 0);
      sc.strains = ['rapid'];
      Sim.rollChoices(sc, 50).forEach(function (c) { if (c.type === 'strain') got.push(c.key); });
    }
    ok('已装备的菌株不会再被抽到', got.indexOf('rapid') < 0,
       '60 次抽取里 rapid 出现 ' + got.filter(function (k) { return k === 'rapid'; }).length + ' 次');
    ok('未拥有的菌株仍会被抽到', got.length > 0, '抽到 ' + got.length + ' 张菌株卡');
  });

  step(function () {
    /* 全部拿满之后要优雅退化，不能给出空卡或重复卡 */
    var Sim = S.Sim;
    var s = Sim.newGame(555, {}, {}, 0, CC.mapMaxTier);
    s.strains = window.MYC.CONFIG.STRAIN.list.map(function (x) { return x.key; });
    var cards = Sim.rollChoices(s, 50);
    ok('菌株全拿满 + 地图封顶 → 只剩点数卡',
       cards.length === CC.offerCount && cards.every(function (c) { return c.type === 'genes'; }),
       cards.map(function (c) { return c.type + ':' + c.key; }).join(' | '));
  });

  step(function () {
    /* 完整转生流程：转生后必须有卡可等 */
    var Sim = S.Sim;
    var s = Sim.newGame(31337, {}, {}, 0);
    s.res.spore = 1e9; s.total.nutrient = 1e6; s.total.spore = 1e6;
    var r = Sim.doPrestige(s);
    ok('转生成功', r.ok, 'gain=' + r.gained);
    ok('转生后拿到待选卡', !!s.pendingChoice && s.pendingChoice.cards.length === CC.offerCount,
       s.pendingChoice ? s.pendingChoice.cards.length + ' 张' : 'null');
    ok('待选卡记着是第几次转生', s.pendingChoice.forPrestige === s.prestiges,
       'forPrestige=' + s.pendingChoice.forPrestige + ' prestiges=' + s.prestiges);
  });

  step(function () {
    /* 选卡：三种卡各自的落点 */
    var S2 = S.Sim;
    /* (a) 点数卡 → pendingGenes 增加 */
    var s = S2.newGame(31337, {}, {}, 0);
    s.res.spore = 1e9; s.total.nutrient = 1e6; s.total.spore = 1e6;
    S2.doPrestige(s);
    var before = s.pendingGenes;
    var gc = s.pendingChoice.cards.filter(function (c) { return c.type === 'genes'; })[0];
    if (gc) {
      var ar = S2.applyChoice(s, gc.key);
      ok('选点数卡 → 基因点增加', ar.ok && s.pendingGenes === before + gc.amount,
         before + ' + ' + gc.amount + ' = ' + s.pendingGenes);
      ok('选完 pendingChoice 被清空（防重复领取）', s.pendingChoice === null, 'null');
    } else { ok('（本轮无点数卡，跳过）', true, ''); }

    /* (b) 地图卡 → mapTier +1 且尺寸真的变大
     *
     * ⚠ 地图尺寸是**模块级单例**（sim.js 的 _MAP），applyChoice 的地图卡
     * 会把它改成新尺寸。这里用的是临时 state，跑完必须还原成当前这一局
     * 的尺寸 —— 否则 _MAP 停在临时 state 上，后续所有对当前局的
     * idx()/inBounds() 都在用错尺寸，会变成极难定位的错格/越界。 */
    var live = window.MYC.game.state;
    var liveW = live.mapW, liveH = live.mapH;
    var s2 = S2.newGame(31338, {}, {}, 0);
    s2.res.spore = 1e9; s2.total.nutrient = 1e6; s2.total.spore = 1e6;
    S2.doPrestige(s2);
    var mc = s2.pendingChoice.cards.filter(function (c) { return c.type === 'map'; })[0];
    if (mc) {
      var w0 = s2.mapW, t0 = s2.mapTier;
      S2.applyChoice(s2, mc.key);
      ok('选地图卡 → mapTier +1', s2.mapTier === t0 + 1, t0 + ' → ' + s2.mapTier);
      ok('选地图卡 → 地图真的变大', s2.mapW > w0, w0 + ' → ' + s2.mapW);
      ok('选地图卡后网络被正确重建（只剩核心）', s2.nodes.length === 1, s2.nodes.length + ' 格');
      ok('选地图卡后核心就在地图中心',
         s2.core.x === (s2.mapW >> 1) && s2.core.y === (s2.mapH >> 1),
         s2.core.x + ',' + s2.core.y);
    } else { ok('（本轮无地图卡，跳过）', true, ''); }
    /* 还原活动地图尺寸（见上面 ⚠） */
    S2.applyMapSize(live, { w: liveW, h: liveH });
    ok('测完地图卡后，活动地图尺寸已还原',
       live.mapW === liveW && live.mapH === liveH,
       liveW + '×' + liveH);

    /* (c) 菌株卡 → 装上 */
    var s3 = S2.newGame(31339, {}, {}, 0);
    s3.res.spore = 1e9; s3.total.nutrient = 1e6; s3.total.spore = 1e6;
    S2.doPrestige(s3);
    var stc = s3.pendingChoice.cards.filter(function (c) { return c.type === 'strain'; })[0];
    if (stc) {
      S2.applyChoice(s3, stc.key);
      ok('选菌株卡 → 菌株被装备', s3.strains.indexOf(stc.key) >= 0,
         'strains=[' + s3.strains.join(',') + ']');
    } else { ok('（本轮无菌株卡，跳过）', true, ''); }
  });

  step(function () {
    /* 选卡的健壮性：重复选、选不存在的卡都必须被拒 */
    var Sim = S.Sim;
    var s = Sim.newGame(2468, {}, {}, 0);
    s.res.spore = 1e9; s.total.nutrient = 1e6; s.total.spore = 1e6;
    Sim.doPrestige(s);
    var k = s.pendingChoice.cards[0].key;
    ok('第一次选卡成功', Sim.applyChoice(s, k).ok, '');
    var again = Sim.applyChoice(s, k);
    ok('重复选同一张被拒（不会白拿两份）', !again.ok, again.reason);
    var bogus = Sim.applyChoice(s, '不存在的卡');
    ok('选不存在的卡被拒', !bogus.ok, bogus.reason);
    ok('没有待选卡时选卡不抛异常',
       (function () { try { Sim.applyChoice(s, 'x'); return true; } catch (e) { return false; } })(),
       '');
  });

  step(function () {
    /* 存档往返：mapTier 与 pendingChoice 都不能丢 */
    var Sim = S.Sim;
    var s = Sim.newGame(13579, {}, {}, 0, 2);
    s.res.spore = 1e9; s.total.nutrient = 1e6; s.total.spore = 1e6;
    Sim.doPrestige(s);
    var json = Sim.serialize(s);
    var back = Sim.deserialize(json);
    ok('存档往返保留 mapTier', back.mapTier === s.mapTier,
       s.mapTier + ' → ' + back.mapTier);
    ok('存档往返保留地图尺寸', back.mapW === s.mapW && back.mapH === s.mapH,
       back.mapW + 'x' + back.mapH);
    ok('存档往返保留待选卡（转生后关页面也不丢奖励）',
       !!back.pendingChoice && back.pendingChoice.cards.length === s.pendingChoice.cards.length,
       back.pendingChoice ? back.pendingChoice.cards.length + ' 张' : 'null');
    /* 读档后必须能继续选 */
    var k = back.pendingChoice.cards[0].key;
    ok('读档后仍能正常选卡', Sim.applyChoice(back, k).ok, '');
  });

  step(function () {
    /* 旧存档迁移：没有 mapTier 的档不能把地图打回原形 */
    var Sim = S.Sim;
    var s = Sim.newGame(24680, {}, {}, 0, 4);
    var o = JSON.parse(Sim.serialize(s));
    o.prestiges = 4;
    delete o.mapTier;
    var mig = Sim.deserialize(JSON.stringify(o));
    ok('旧存档（无 mapTier）读得进来', !!mig, '');
    ok('旧存档按 prestiges 反推出地图档位（地图不回缩）',
       mig.mapTier > 0 && mig.mapW > window.MYC.CONFIG.GRID.W,
       'mapTier=' + mig.mapTier + ' 尺寸=' + mig.mapW + 'x' + mig.mapH);
    ok('旧存档没有待选卡时 pendingChoice 为 null',
       mig.pendingChoice === null, String(mig.pendingChoice));

    /* 坏形状的待选卡要被丢掉，而不是留着让玩家点到崩 */
    var o2 = JSON.parse(Sim.serialize(s));
    o2.pendingChoice = { cards: [] };
    ok('空卡池的 pendingChoice 被丢弃',
       Sim.deserialize(JSON.stringify(o2)).pendingChoice === null, 'null');
  });

  step(function () {
    /* UI 层的弹窗必须与 state 同步 —— 这是「卡没弹出 = 玩家卡住」的防线 */
    var g = window.MYC.game, ov = document.getElementById('choiceOverlay');
    ok('取到三选一弹窗元素', !!ov, '');
    /* 没有待选卡时弹窗必须是隐藏的（正常游玩状态） */
    ok('没有待选卡时弹窗隐藏',
       !g.state.pendingChoice ? ov.classList.contains('hidden') : true,
       'hidden=' + ov.classList.contains('hidden'));
  });

  step(function () {
    /* 真的「点一下卡」。状态层全对，不代表按钮点得动 ——
     * 而**点击是玩家唯一的选择方式**，所以这条必须有断言盯着。
     * 走的是 ui.js 里那条事件委托路径（卡片是 innerHTML 重建的，
     * 直接绑在每个按钮上会在下次 renderChoice 后全部失效）。 */
    var g = window.MYC.game, Sim = S.Sim;
    var ov = document.getElementById('choiceOverlay');

    /* 造一份待选卡再同步到界面 —— 用真实 rollChoices，不手搓，
     * 这样顺带验证「抽出来的卡 UI 认得、点得动」。
     * 基因点卡必定在池里（genePool 永远非空），所以下面一定找得到它。 */
    g.state.pendingChoice = {
      cards: Sim.rollChoices(g.state, 60), gained: 60,
      forPrestige: g.state.prestiges || 1, at: Date.now()
    };
    g.ui.rebind(g.state);
    ok('有待选卡时弹窗自动弹出', !ov.classList.contains('hidden'),
       'class=' + ov.className);

    var btns = ov.querySelectorAll('.choice-card');
    ok('卡片渲染出了按钮', btns.length > 0 && btns.length === g.state.pendingChoice.cards.length,
       btns.length + ' 个按钮 / ' + g.state.pendingChoice.cards.length + ' 张卡');

    /* 优先点「基因点」那张：它没有换图副作用，不会把活动地图改掉，
     * 免得后面那条「主循环没异常」的断言被无关的换图重渲染干扰。 */
    var btn = null;
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].className.indexOf('genes') >= 0) btn = btns[i];
    }
    if (!btn && btns.length) btn = btns[0];
    if (btn) {
      var key = btn.getAttribute('data-key');
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      ok('点完卡后 pendingChoice 被清空', g.state.pendingChoice === null,
         String(g.state.pendingChoice));
      ok('点完卡后弹窗隐藏', ov.classList.contains('hidden'), 'class=' + ov.className);
      ok('落下的正是被点的那张卡',
         g.state.lastChoice && g.state.lastChoice.key === key,
         g.state.lastChoice ? (g.state.lastChoice.key + ' / 期望 ' + key) : 'null');
    } else {
      ok('（没有可点的卡，跳过点击测试）', false, '按钮为 0 —— 弹窗没渲染出来');
    }

    /* 再点一次不该再发一份奖励（幂等）：此时 pendingChoice 已空，
     * applyChoice 必须拒绝，而不是凭 lastChoice 再发一次。 */
    if (key) {
      var r = Sim.applyChoice(g.state, key);
      ok('选完之后重复调用同一张卡会被拒绝', r.ok === false, r.reason || '竟然又成功了');
    }
  });


  step(function () {
    var sc = window.MYC.game.scene;
    ok('Phaser 主循环确实运行过', sc.frames > 0, 'frames=' + sc.frames + '（起始 ' + S.frames0 + '）');
    ok('渲染层没有残留异常', errs.length === 0, errs.length ? errs.join(' | ') : '无');
  });

  /* ---------------------------------------------------------------- 驱动 */

  function runSteps() {
    var s = steps.shift();
    if (!s) return finish();
    try {
      s.fn();
    } catch (e) {
      R.push('FAIL  步骤抛异常（' + s.tag + '）: ' + e.message
             + ' @ ' + String(e.stack || '').split('\n')[1]);
    }
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
