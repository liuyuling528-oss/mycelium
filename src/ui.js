/* ============================================================================
 * ui.js — 右侧 HTML 面板与游戏状态的桥接
 *
 * 面板用真实 DOM 而不是 canvas 文字：列表、下拉框、滚动条、按钮禁用态
 * 这些交给浏览器处理，既好看又省下大量绘图代码。
 * 每帧重绘 DOM 太浪费，所以节流到约 10Hz。
 * ==========================================================================*/
var UI = (function () {
  'use strict';

  var C, state, el = {}, upRows = {}, geneRows = {}, abRows = {}, msRows = {};
  var logBuf = [], seenSoils = {}, acc = 0;
  var KEY = 'mycelium_save_v1';
  var SEEDKEY = 'mycelium_seed_v1';

  /* ------------------------------------------------------------ 数字格式 */
  function fmt(n) {
    n = Number(n) || 0;
    var a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return (n / 1e3).toFixed(1) + 'K';
    if (a >= 100) return String(Math.round(n));
    if (a >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }
  function rate(n) { return '+' + fmt(n) + '/s'; }
  function clk(s) {
    s = Math.max(0, Math.floor(s));
    var m = Math.floor(s / 60);
    return (m < 10 ? '0' : '') + m + ':' + ((s % 60) < 10 ? '0' : '') + (s % 60);
  }

  /* ---------------------------------------------------------------- 构造 */
  function init(game) {
    C = window.MYC.CONFIG;
    state = game.state;

    ['clock', 'vWater', 'rWater', 'vNutrient', 'rNutrient', 'vSpore', 'rSpore',
     'sNodes', 'sDist', 'sLost', 'sRun', 'policy', 'policyHint', 'autoGrow',
     'upgrades', 'prestigeCard', 'pText', 'pBar', 'pHint', 'pBtn',
     'geneCard', 'genes', 'geneLeft', 'log', 'seedTxt',
     'abilities', 'eventLine', 'milestones', 'msCount',
     'btnSave', 'btnLoad', 'btnNew', 'toast'].forEach(function (id) { el[id] = document.getElementById(id); });

    el.seedTxt.textContent = '种子 ' + state.seed;

    buildPolicies();
    buildAbilities();
    buildUpgrades();
    buildMilestones();
    buildGenes();

    el.policy.addEventListener('change', function () {
      state.policy = el.policy.value;
      pushLog('扩张策略改为「' + currentPolicyName() + '」');
    });
    el.autoGrow.addEventListener('change', function () {
      state.autoGrow = el.autoGrow.checked;
    });
    el.pBtn.addEventListener('click', doPrestige);
    el.btnSave.addEventListener('click', function () { game.save(false); });
    el.btnLoad.addEventListener('click', function () { game.load(); });
    el.btnNew.addEventListener('click', function () { game.newSeed(); });

    // 键盘 1 / 2 / 3 放技能 —— 手上随时有事做，是这次加内容的核心目的
    document.addEventListener('keydown', function (ev) {
      if (ev.target && /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) return;
      for (var i = 0; i < C.ABILITIES.length; i++) {
        if (ev.key === C.ABILITIES[i].slot) {
          ev.preventDefault();
          fireAbility(C.ABILITIES[i].key);
          return;
        }
      }
    });

    el.autoGrow.checked = state.autoGrow;
    el.policy.value = state.policy;
    updatePolicyHint();
  }

  /* ---------------------------------------------------------------- 技能 */
  function buildAbilities() {
    C.ABILITIES.forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'ab';
      b.innerHTML =
        '<div class="sl">' + a.slot + '</div>' +
        '<div class="nm"></div>' +
        '<div class="ht">' + a.hint + '</div>' +
        '<div class="cdbar"></div>';
      b.addEventListener('click', function () { fireAbility(a.key); });
      el.abilities.appendChild(b);
      abRows[a.key] = { btn: b, nm: b.querySelector('.nm'), bar: b.querySelector('.cdbar'), cfg: a };
    });
  }

  function fireAbility(key) {
    var r = window.MYC.Sim.useAbility(state, key);
    if (r.ok) {
      pushLog(r.msg);
      window.MYC.game.dirty = true;
      if (key === 'pulse') window.MYC.game.shake(220, 0.004);
    } else {
      toast(r.reason);
    }
  }

  /* ------------------------------------------------------------ 里程碑 */
  function buildMilestones() {
    C.MILESTONES.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'ms';
      row.innerHTML =
        '<div class="tick"></div>' +
        '<div class="txt">' +
          '<div class="nm">' + m.name + ' <span class="need">' + m.need + '</span></div>' +
          '<div class="rw">' + m.reward + '</div>' +
        '</div>';
      el.milestones.appendChild(row);
      msRows[m.id] = row;
    });
  }

  function currentPolicyName() {
    for (var i = 0; i < C.POLICIES.length; i++) if (C.POLICIES[i].key === state.policy) return C.POLICIES[i].name;
    return state.policy;
  }

  function buildPolicies() {
    C.POLICIES.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.key;
      o.textContent = p.name;
      el.policy.appendChild(o);
    });
  }

  function updatePolicyHint() {
    for (var i = 0; i < C.POLICIES.length; i++) {
      if (C.POLICIES[i].key === state.policy) { el.policyHint.textContent = C.POLICIES[i].desc; return; }
    }
  }

  function buildUpgrades() {
    C.UPGRADES.forEach(function (u) {
      var row = document.createElement('div');
      row.className = 'item';
      var n = document.createElement('div');
      n.className = 'n';
      n.innerHTML = u.name + '<span class="lv"></span>';
      var d = document.createElement('div');
      d.className = 'd';
      d.textContent = u.desc;
      var b = document.createElement('button');
      b.className = 'buy tiny';
      b.addEventListener('click', function () {
        var r = window.MYC.Sim.buyUpgrade(state, u.key);
        if (r.ok) pushLog(u.name + ' 升到 ' + state.up[u.key] + ' 级');
        else toast(r.reason);
        window.MYC.game.dirty = true;
      });
      row.appendChild(n); row.appendChild(d); row.appendChild(b);
      el.upgrades.appendChild(row);
      upRows[u.key] = { row: row, lv: n.querySelector('.lv'), btn: b, def: u };
    });
  }

  function buildGenes() {
    C.GENES.forEach(function (g) {
      var row = document.createElement('div');
      row.className = 'item';
      var n = document.createElement('div');
      n.className = 'n';
      n.innerHTML = g.name + '<span class="lv"></span>';
      var d = document.createElement('div');
      d.className = 'd';
      d.textContent = g.desc;
      var b = document.createElement('button');
      b.className = 'buy tiny';
      b.addEventListener('click', function () {
        var r = window.MYC.Sim.buyGene(state, g.key);
        if (r.ok) pushLog('基因「' + g.name + '」升到 ' + state.genes[g.key] + ' 级');
        else toast(r.reason);
        window.MYC.game.dirty = true;
      });
      row.appendChild(n); row.appendChild(d); row.appendChild(b);
      el.genes.appendChild(row);
      geneRows[g.key] = { row: row, lv: n.querySelector('.lv'), btn: b };
    });
  }

  /* ---------------------------------------------------------------- 转生 */
  function doPrestige() {
    if (!window.MYC.Sim.canPrestige(state)) { toast('孢子还不够，再长一会儿'); return; }
    var r = window.MYC.Sim.doPrestige(state);
    if (!r.ok) { toast(r.reason); return; }
    window.MYC.game.shake();
    pushLog('散播孢子！获得 ' + r.gained + ' 基因点（第 ' + r.record.run + ' 次，用了 ' + clk(r.record.seconds) + '）');
    toast('散播孢子成功，获得 ' + r.gained + ' 基因点');
    window.MYC.game.save(true);
  }

  /* ---------------------------------------------------------------- 提示 */
  var toastTimer = null;
  function toast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('on'); }, 1700);
  }

  function pushLog(msg) {
    logBuf.unshift(msg);
    if (logBuf.length > 40) logBuf.pop();
    renderLog();
  }

  function renderLog() {
    if (!el.log) return;
    var html = '';
    for (var i = 0; i < Math.min(12, logBuf.length); i++) html += '<div>' + logBuf[i] + '</div>';
    el.log.innerHTML = html;
  }

  /* ---------------------------------------------------------------- 刷新 */
  function update(dt, game) {
    acc += dt;
    if (acc < 0.1 && !game.dirty) return;
    acc = 0;
    game.dirty = false;

    var rt = state.rate || { water: 0, nutrient: 0, spore: 0 };

    el.clock.textContent = clk(state.t);
    el.vWater.textContent = fmt(state.res.water);
    el.rWater.textContent = rate(rt.water);
    el.vNutrient.textContent = fmt(state.res.nutrient);
    el.rNutrient.textContent = rate(rt.nutrient);
    el.vSpore.textContent = fmt(state.res.spore);
    el.rSpore.textContent = rate(rt.spore);

    el.sNodes.textContent = state.nodes.length;
    el.sDist.textContent = state.maxDist;
    el.sLost.textContent = (state.lostTotal > 0 ? fmt(state.lostTotal) + ' 累计' : '无');
    el.sRun.textContent = clk(state.t);

    // 升级列表
    C.UPGRADES.forEach(function (u) {
      var r = upRows[u.key], lv = state.up[u.key] || 0;
      var maxed = (u.max != null && lv >= u.max);
      var cost = window.MYC.Sim.upgradeCost(state, u.key);
      r.lv.textContent = maxed ? '已满级' : ('Lv ' + lv);
      r.btn.textContent = maxed ? '—' : fmt(cost);
      r.btn.disabled = maxed || state.res.nutrient < cost;
      r.row.classList.toggle('ok', !maxed && state.res.nutrient >= cost);
      r.row.classList.toggle('owned', maxed);
    });

    // 转生
    var cost = window.MYC.Sim.prestigeCost(state);
    var can = window.MYC.Sim.canPrestige(state);
    el.prestigeCard.classList.toggle('hidden', !(state.prestiges > 0 || state.res.spore >= cost * 0.25));
    el.pText.innerHTML = '孢子 ' + fmt(state.res.spore) + ' / ' + fmt(cost);
    el.pBar.style.width = Math.min(100, (state.res.spore / cost) * 100).toFixed(1) + '%';
    var gain = window.MYC.Sim.geneGain(state);
    el.pHint.textContent = can
      ? ('现在散播可得 ' + gain + ' 基因点。菌丝网络会重来，但地图知识保留。')
      : ('再攒 ' + fmt(Math.max(0, cost - state.res.spore)) + ' 孢子就能散播（当前可换 ' + gain + ' 基因点）');
    el.pBtn.disabled = !can;

    // 基因
    var pg = state.pendingGenes || 0;
    var hasGenes = pg > 0 || C.GENES.some(function (g) { return (state.genes[g.key] || 0) > 0; });
    el.geneCard.classList.toggle('hidden', !hasGenes);
    el.geneLeft.textContent = pg > 0 ? ('可用 ' + pg + ' 点') : '';
    if (hasGenes) {
      C.GENES.forEach(function (g) {
        var r = geneRows[g.key], lv = state.genes[g.key] || 0;
        var c = window.MYC.Sim.geneCost(state, g.key);
        r.lv.textContent = 'Lv ' + lv;
        r.btn.textContent = fmt(c) + ' 点';
        r.btn.disabled = pg < c;
        r.row.classList.toggle('ok', pg >= c);
      });
    }

    // 技能：未知锁的按钮要看得见但点不了（渐进解锁）
    C.ABILITIES.forEach(function (a) {
      var r = abRows[a.key];
      var cd = state.cd[a.key] || 0;
      var unlocked = !!state.unlocked[a.key];
      var ready = unlocked && cd <= 0;
      r.btn.disabled = !ready;
      r.btn.classList.toggle('locked', !unlocked);
      r.btn.classList.toggle('ready', ready);
      // 名字只放名字：塞「（未解锁）」会换行成「未解 锁」很难看。
      // 未解锁用按钮变暗 + title 提示表达，解锁方式写在里程碑列表里。
      r.nm.textContent = (unlocked && cd > 0) ? (a.name + ' · ' + Math.ceil(cd) + 's') : a.name;
      r.btn.title = unlocked ? (a.name + '　' + a.hint) : (a.name + '　尚未解锁（见里程碑）');
      r.bar.style.width = (unlocked && cd > 0) ? (cd / a.cfg.cd * 100).toFixed(0) + '%' : '0%';
    });

    // 里程碑
    var doneCount = 0;
    C.MILESTONES.forEach(function (m) {
      var ok = !!state.milestones[m.id];
      if (ok) doneCount++;
      msRows[m.id].classList.toggle('done', ok);
      msRows[m.id].querySelector('.tick').textContent = ok ? '✓' : '';
    });
    el.msCount.textContent = doneCount + ' / ' + C.MILESTONES.length;

    // 事件条
    var parts = [];
    state.events.forEach(function (e) {
      if (e.kind === 'gnat') return;
      parts.push((e.kind === 'rain' ? '降雨带' : '孢子季') + ' ' + Math.ceil(e.ttl) + 's');
    });
    var gn = window.MYC.Sim.countGnats(state);
    if (gn) parts.push('害虫 ×' + gn + '（点它驱除）');
    el.eventLine.textContent = parts.length ? ('事件：' + parts.join('　·　')) : '';

    // 通知：新事件 / 新里程碑（由 sim 塞进 state.newEvents / newMilestones）
    if (state.newEvents && state.newEvents.length) {
      state.newEvents.forEach(function (e) {
        if (e.kind === 'gnat') {
          pushLog('⚠ 害虫出现，占据了一格菌丝（点地图上的红点驱除）');
          toast('害虫出现 —— 点地图上的红点驱除');
        } else if (e.kind === 'rain') {
          pushLog('降雨带出现：区域内水分产出 ×' + C.EVENTS.buffMul);
        } else {
          pushLog('孢子季出现：区域内孢子产出 ×' + C.EVENTS.buffMul);
        }
      });
      state.newEvents = [];
    }
    if (state.newMilestones && state.newMilestones.length) {
      var names = state.newMilestones.map(function (m) { return m.name; });
      state.newMilestones.forEach(function (m) { pushLog('★ 里程碑「' + m.name + '」达成 —— ' + m.reward); });
      toast('里程碑达成：' + names.join('、'));
      state.newMilestones = [];
      window.MYC.game.dirty = true;
    }

    scanDiscoveries();
  }

  /* 第一次探明某种基质时提示一下，让探索有反馈 */
  function scanDiscoveries() {
    for (var i = 0; i < state.grid.length; i++) {
      var c = state.grid[i];
      if (!c.known || seenSoils[c.soil]) continue;
      seenSoils[c.soil] = 1;
      if (c.soil !== 'soil' && c.soil !== 'core') {
        var s = C.SOILS[c.soil];
        pushLog('发现 ' + s.name + '：' + describe(s));
      }
    }
  }

  function describe(s) {
    var out = [];
    if (s.yield.water) out.push('水 +' + s.yield.water + '/s');
    if (s.yield.nutrient) out.push('养分 +' + s.yield.nutrient + '/s');
    if (s.yield.spore) out.push('孢子 +' + s.yield.spore + '/s');
    return out.join('，');
  }

  /* 供外部调用：把已保存的进度重新挂到面板上 */
  function rebind(newState) {
    state = newState;
    window.MYC.game.state = newState;
    seenSoils = {};
    el.autoGrow.checked = newState.autoGrow;
    el.policy.value = newState.policy;
    updatePolicyHint();
    el.seedTxt.textContent = '种子 ' + newState.seed;
  }

  return {
    init: init, update: update, toast: toast, pushLog: pushLog, rebind: rebind,
    KEY: KEY, SEEDKEY: SEEDKEY, fmt: fmt
  };
})();
