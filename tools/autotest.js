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

  function canvas() { return document.querySelector('#game canvas'); }

  /* 世界格 -> 屏幕坐标。
   * 不要假设「画布 CSS 尺寸 == 内部尺寸」，也不要假设「摄像机缩放 == 1」——
   * 现在画布是 Scale.RESIZE + 摄像机自适应缩放，这两个假设都不成立，写死比例必然点偏。
   * 这里用 cam.getWorldPoint 做两点标定，先求出「画布像素 -> 世界」的仿射映射再取逆，
   * 于是跟 Phaser 内部的缩放/滚动实现完全解耦。 */
  function cellToClient(x, y) {
    var G = window.MYC.CONFIG.GRID;
    var cam = window.MYC.game.scene.cameras.main;
    var cv = canvas(), r = cv.getBoundingClientRect();
    var o = cam.getWorldPoint(0, 0);
    var ex = cam.getWorldPoint(1, 0);
    var ey = cam.getWorldPoint(0, 1);
    var kx = 1 / (ex.x - o.x);        // 1 画布像素 = 1/kx 个世界单位
    var ky = 1 / (ey.y - o.y);
    var wx = G.OX + x * G.CELL + G.CELL / 2;
    var wy = G.OY + y * G.CELL + G.CELL / 2;
    return {
      x: r.left + (wx - o.x) * kx * (r.width / cv.width),
      y: r.top + (wy - o.y) * ky * (r.height / cv.height),
      inside: true
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

  step(function () {
    ok('Phaser 已加载', typeof Phaser !== 'undefined', 'Phaser ' + Phaser.VERSION);
    ok('canvas 已创建', !!canvas(), canvas() ? canvas().width + 'x' + canvas().height : 'none');
    ok('场景已就绪', !!window.MYC.game.scene);
    ok('面板已初始化', document.querySelectorAll('#upgrades .item').length > 0);
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
    ok('节点数在合法范围', st.nodes.length > 0 && st.nodes.length <= window.MYC.CONFIG.GRID.W * window.MYC.CONFIG.GRID.H,
       st.nodes.length + ' 格 / 上限 ' + (window.MYC.CONFIG.GRID.W * window.MYC.CONFIG.GRID.H));
  });

  /* ---- 内容层（技能 / 里程碑 / 节点强化 / 事件）----
   * 放在最后：此时网络已经有规模，害虫才会出现，节点也才有得强化。
   *
   * 编排原则：不要去抹掉已经发过的奖励来「制造」未解锁状态 ——
   * 里程碑奖励是只发一次的，抹掉 unlocked 只会得到一个假失败。
   * 要测「未解锁」就找一个还没达成的里程碑；要测技能机制就直接 arrange。 */
  step(function () {
    var st = window.MYC.game.state, C = window.MYC.CONFIG, Sim = S.Sim;
    var pending = C.MILESTONES.filter(function (m) { return !st.milestones[m.id]; });
    ok('存在尚未达成的里程碑（渐进解锁有效）', pending.length > 0,
       '待达成 ' + pending.length + ' 个：' + pending.map(function (m) { return m.name; }).join('、'));
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
    ok('增益区确实提升了产出', w1 > w0, '水分速率 ' + w0.toFixed(2) + ' -> ' + w1.toFixed(2));
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
    var sc = window.MYC.game.scene, cam = sc.cameras.main, G = window.MYC.CONFIG.GRID;
    var core = window.MYC.game.state.nodes[0];
    var wx = G.OX + core.x * G.CELL + G.CELL / 2, wy = G.OY + core.y * G.CELL + G.CELL / 2;
    var v = cam.worldView;
    ok('摄像机对准了网络（核心在视野内）',
       wx >= v.left && wx <= v.right && wy >= v.top && wy <= v.bottom,
       'core=(' + wx.toFixed(0) + ',' + wy.toFixed(0) + ')  视野 x ' +
       v.left.toFixed(0) + '..' + v.right.toFixed(0) + '  y ' + v.top.toFixed(0) + '..' + v.bottom.toFixed(0));

    // 缩放的硬下限：绝不能小于「整张地图刚好装下」，否则网络边缘会被裁出画面
    var whole = Math.min(cam.width / (G.OX * 2 + G.W * G.CELL),
                         cam.height / (G.OY * 2 + G.H * G.CELL));
    ok('视野不小于整张地图（不裁剪网络）', cam.zoom >= whole - 0.003,
       'zoom=' + cam.zoom.toFixed(3) + '  下限=' + whole.toFixed(3));

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
    var v = window.MYC.game.scene.cameras.main.worldView;
    var x0 = Math.max(0, Math.floor((v.left - G.OX) / G.CELL) + 1);
    var x1 = Math.min(G.W - 1, Math.ceil((v.right - G.OX) / G.CELL) - 1);
    var y0 = Math.max(0, Math.floor((v.top - G.OY) / G.CELL) + 1);
    var y1 = Math.min(G.H - 1, Math.ceil((v.bottom - G.OY) / G.CELL) - 1);

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
