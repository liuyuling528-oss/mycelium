/* ============================================================================
 * ui.js — 右侧 HTML 面板与游戏状态的桥接
 *
 * 面板用真实 DOM 而不是 canvas 文字：列表、下拉框、滚动条、按钮禁用态
 * 这些交给浏览器处理，既好看又省下大量绘图代码。
 * 每帧重绘 DOM 太浪费，所以节流到约 10Hz。
 * ==========================================================================*/
var UI = (function () {
  'use strict';

  var C, state, el = {}, upRows = {}, geneRows = {}, abRows = {}, msRows = {}, strainRows = {};
  var logBuf = [], seenSoils = {}, acc = 0, lastAgLocked = null, lastStructSig = '', lastTreeSig = '';
  var KEY = 'mycelium_save_v1';
  var SEEDKEY = 'mycelium_seed_v1';
  /* 槽位 key。特意和 KEY 分开命名空间，避免和自动存档撞车 ——
   * 上一版只有一个 key，「读取」读的就是被自动存档覆盖过的当前局。 */
  var SLOTN = 3;
  function slotKey(n) { return 'mycelium_slot_' + n + '_v1'; }

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
  /* 速率文案。⚠ 符号必须跟着数值走，不能写死 '+'。
   *
   * 曾经是 `return '+' + fmt(n) + '/s'` —— 只要速率变负（水分扣完维持费、
   * 或者网络大面积铺远壤土），面板就会显示 **`+-1.20/s`** 这种怪东西。
   * 现在有三种速率都可能为负，所以符号统一在这里出：
   *   · 正：+0.45/s    · 零：0.00/s（不写成 +0.00，那看起来像"有产出"）
   *   · 负：-1.20/s
   * 另外 fmt() 里的 toFixed 会把 ±0.001 显示成 "±0.00"，
   * 「+0.00」看着像有产出、「-0.00」更是莫名其妙，
   * 所以小于 0.005（即四舍五入到两位小数会变成 0.00 的一切值）
   * 一律按零处理，输出裸的 `0.00/s`。 */
  function rate(n) {
    n = Number(n) || 0;
    if (Math.abs(n) < 0.005) return '0.00/s';
    return (n > 0 ? '+' : '') + fmt(n) + '/s';
  }
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
     'autoGrowRow', 'autoGrowLabel', 'autoRuleRow', 'ruleMaxDist', 'ruleMinYield', 'ruleHint',
     'upgrades', 'prestigeCard', 'pText', 'pBar', 'pHint', 'pBtn',
     'geneCard', 'genes', 'geneLeft', 'log', 'seedTxt',
     'strainCard', 'strains', 'strainSlots', 'strainHint',
     'abilities', 'eventLine', 'milestones', 'msCount',
     'trunkCount', 'structRow', 'structHint', 'trunkCap',
     'treeCount', 'treeHint', 'topsoilRow',
     'btnSave', 'btnNew', 'slotList', 'saveHint', 'toast',
     'choiceOverlay', 'choiceCards', 'choiceHint'].forEach(function (id) { el[id] = document.getElementById(id); });

    el.seedTxt.textContent = '种子 ' + state.seed;

    buildPolicies();
    buildAutoRules();
    buildAbilities();
    buildUpgrades();
    buildMilestones();
    buildGenes();
    buildStrains();

    el.policy.addEventListener('change', function () {
      state.policy = el.policy.value;
      pushLog('扩张策略改为「' + currentPolicyName() + '」');
    });
    el.autoGrow.addEventListener('change', function () {
      state.autoGrow = el.autoGrow.checked;
    });
    el.pBtn.addEventListener('click', doPrestige);
    /* 三选一：事件委托，卡片是 innerHTML 重建的。 */
    if (el.choiceCards) {
      el.choiceCards.addEventListener('click', function (ev) {
        var b = ev.target;
        while (b && b !== el.choiceCards && !b.getAttribute('data-key')) b = b.parentNode;
        if (!b || b === el.choiceCards) return;
        pickChoice(b.getAttribute('data-key'));
      });
    }
    /* 读档时如果存档里有没选完的卡，立刻把弹窗恢复出来 ——
     * 否则玩家会带着一个「看不见的待选状态」继续玩，
     * 而下一次转生会把那张卡直接覆盖掉（奖励蒸发）。 */
    if (state.pendingChoice) showChoice();
    el.btnSave.addEventListener('click', function () { game.save(false); });
    /* 按钮语义（三个入口各司其职，别再混在一起）：
     *   开始新游戏 —— 彻底重来：基因/知识/转生全清（有 confirm 拦截）
     *   保存       —— 手动写自动存档（一般不用点，关页面会自动存）
     *   槽位卡片    —— 存/读/删 三个槽的快照
     * 「重开一局（保留基因）」并进「开始新游戏」的第二个参数，
     * 不再单独占一个按钮 —— 上一版两个按钮名字太像，玩家分不清。 */
    el.btnNew.addEventListener('click', function () { game.newGame(false); });

    /* 槽位按钮用**事件委托**：列表是 innerHTML 重建的，
     * 逐个 addEventListener 会在每次 renderSlots 后丢失。
     * 一次绑在容器上，重建多少次都不受影响。 */
    if (el.slotList) {
      el.slotList.addEventListener('click', function (ev) {
        var b = ev.target;
        if (!b || b.tagName !== 'BUTTON') return;
        var act = b.getAttribute('data-act');
        var n = parseInt(b.getAttribute('data-slot'), 10);
        if (act === 'save') {
          /* 覆盖已有档要确认 —— 槽是玩家唯一的后悔药，别让它一键没了。 */
          var exists = game.readSlot(n);
          if (exists && !confirm('覆盖槽 ' + n + '？\n（原有内容会被替换）')) return;
          game.saveToSlot(n);
        } else if (act === 'load') {
          game.loadFromSlot(n);
        } else if (act === 'del') {
          if (confirm('删除槽 ' + n + ' 的存档？无法撤销')) game.clearSlot(n);
        }
      });
    }
    /* 点「保存」按钮时把槽位展开 —— 玩家的意图就是「我要存到哪一糟」，
     * 直接给他看槽位，省掉一次「咦，怎么只有自动存档」的困惑。 */
    if (el.btnSave) {
      el.btnSave.addEventListener('click', function () { toggleSlots(true); });
    }
    renderSlots();

    /* 结构模式按钮：三选一，当前模式高亮。
     * 用 data-mode + 统一回调，避免为每个按钮各写一段。 */
    if (el.trunkCap) el.trunkCap.textContent = C.TRUNK.maxTrunk;
    if (el.structRow) {
      Array.prototype.forEach.call(el.structRow.querySelectorAll('button'), function (b) {
        b.addEventListener('click', function () {
          if (window.MYC.setStructMode) window.MYC.setStructMode(b.getAttribute('data-mode'));
          syncStructButtons();
        });
      });
      syncStructButtons();
      if (window.MYC.setStructMode) window.MYC.setStructMode('none');
    }

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

  /* 结构模式按钮的高亮同步。模式存在 scene 上（那里才有点击处理），
   * 这里只负责把 UI 状态跟它对齐。 */
  function currentStructMode() {
    var s = game.scene;    // main.js 里 game.scene = phaserGame.scene.getScene('World')
    return (s && s.structMode) ? s.structMode : 'none';
  }

  function syncStructButtons() {
    if (!el.structRow) return;
    var cur = currentStructMode();
    Array.prototype.forEach.call(el.structRow.querySelectorAll('button'), function (b) {
      var on = b.getAttribute('data-mode') === cur;
      b.classList.toggle('on', on);
    });
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

  /* ---- 自动蔓延的两条选址规则 ------------------------------------------
   * 用下拉框而不是数字输入：可选项就是配置里的 steps，玩家不会选出
   * 一个「跑不动」或「过拟合」的怪值，也不需要校验非法输入。 */
  function buildAutoRules() {
    var byKey = {};
    C.AUTORULE.forEach(function (r) { byKey[r.key] = r; });

    var md = byKey.maxDist;
    md.steps.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = v === 0 ? '距离：不限' : ('距离 ≤ ' + v + ' 格');
      el.ruleMaxDist.appendChild(o);
    });

    var my = byKey.minYield;
    my.steps.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = v === 0 ? '产出：不限' : ('产出 ≥ ' + v);
      el.ruleMinYield.appendChild(o);
    });

    el.ruleMaxDist.value = state.ruleMaxDist || 0;
    el.ruleMinYield.value = state.ruleMinYield || 0;

    el.ruleMaxDist.addEventListener('change', function () {
      state.ruleMaxDist = Number(el.ruleMaxDist.value) || 0;
      updateRuleHint();
      pushLog(state.ruleMaxDist
        ? ('自动蔓延：只连离核 ' + state.ruleMaxDist + ' 格以内的')
        : '自动蔓延：距离不限');
    });
    el.ruleMinYield.addEventListener('change', function () {
      state.ruleMinYield = Number(el.ruleMinYield.value) || 0;
      updateRuleHint();
      pushLog(state.ruleMinYield
        ? ('自动蔓延：不连产出低于 ' + state.ruleMinYield + ' 的格子')
        : '自动蔓延：产出不限');
    });
    updateRuleHint();
  }

  function updateRuleHint() {
    if (!el.ruleHint) return;
    var d = state.ruleMaxDist || 0, y = state.ruleMinYield || 0;
    if (!d && !y) {
      el.ruleHint.textContent = '两条规则都不限 —— 自动蔓延会按上面的倾向铺满所有够得到的地方。';
    } else {
      el.ruleHint.textContent =
        '自动蔓延当前只会' + (d ? ('在 ' + d + ' 格以内') : '在任意距离') +
        (y ? ('、且产出 ≥ ' + y + ' 的格子') : '') + '。手动点击不受这两条限制。';
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

  /* ------------------------------------------------------------- 菌株 */
  /* 菌株是「Build 层」：同一套经营方式，带不同菌株结果差得很远
   * （headless_sim E 组实测 1.38 倍，双槽共振再 +65%）。
   * 所以这张卡的重点是让玩家**一眼看出「我装了什么、还剩几个槽」**，
   * 而不是把 4 个菌株的乘区数字都堆上来。 */
  function buildStrains() {
    C.STRAIN.list.forEach(function (s) {
      var row = document.createElement('div');
      row.className = 'item strain';
      var n = document.createElement('div');
      n.className = 'n';
      n.textContent = s.name;
      var d = document.createElement('div');
      d.className = 'd';
      /* desc 说「换来什么」，hint 说「怎么玩」—— 两句都留着，
       * 只写一句玩家会看不懂「我该配什么」。 */
      d.textContent = s.desc;
      if (s.hint) {
        var h = document.createElement('span');
        h.className = 'hint strain-hint';
        h.textContent = s.hint;
        d.appendChild(h);
      }
      var b = document.createElement('button');
      b.className = 'buy tiny';
      b.addEventListener('click', function () {
        var r = window.MYC.Sim.equipStrain(state, s.key);
        if (r.ok) {
          var on = r.equipped.indexOf(s.key) >= 0;
          pushLog((on ? '装上菌株「' : '卸下菌株「') + s.name + '」');
          toast(on ? ('已装上 ' + s.name) : ('已卸下 ' + s.name));
          /* 菌株改了乘区 → 必须让世界场景重算一次，
           * 否则画面上「拥堵 / 产量」的数字要等下一帧才跟上。 */
          window.MYC.game.dirty = true;
        } else {
          toast(r.reason);
        }
      });
      row.appendChild(n); row.appendChild(d); row.appendChild(b);
      el.strains.appendChild(row);
      strainRows[s.key] = { row: row, btn: b, def: s };
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
    // 换图了：场景里的地形缓存、已探明数、镜头全都要重来
    var sc = window.MYC.game.scene;
    if (sc && sc.onMapChanged) sc.onMapChanged();
    window.MYC.game.save(true);
    /* 弹三选一。**必须在 doPrestige 之后** —— 卡池里的地图卡要基于
     * 刚换好的世界算下一档尺寸。 */
    if (state.pendingChoice) showChoice();
  }

  /* ------------------------------------------------------------ 转生抉择
   * Roguelike 三选一的界面。这是全局唯一的**阻塞式**交互：
   * 没选完不能继续玩，所以它的开/关都必须和 state.pendingChoice 严格同步 ——
   * 只靠 DOM 的 .hidden 判断会出现「存档里还有卡、但界面没弹」的错位。
   * 真相永远在 state.pendingChoice 里。 */
  var KIND_LABEL = { strain: '菌株', map: '地图', genes: '基因点' };

  /* 把一张卡翻译成「标题 / 说明 / 代价」三段。
   * 代价那行是这个系统的灵魂 —— 三选一的意义就在于让玩家看见亏什么。 */
  function cardText(card) {
    if (card.type === 'strain') {
      var s = null;
      C.STRAIN.list.forEach(function (x) { if (x.key === card.key) s = x; });
      if (!s) return { name: card.key, desc: '', cost: '' };
      /* 菌株配置里没有单独的「代价」字段（收益与代价混在 desc 里）。
       * 这里用 hint 当补充说明，desc 原样用。 */
      return { name: s.name, desc: s.hint || s.desc, cost: s.desc };
    }
    if (card.type === 'map') {
      return {
        name: '世界扩大一档',
        desc: '地图变成 ' + card.nextW + '×' + card.nextH +
              '（当前 ' + state.mapW + '×' + state.mapH + '）',
        cost: '更大的地图要铺更久才填得满'
      };
    }
    return {
      name: '+' + card.amount + ' 基因点',
      desc: '立刻到手，可以直接买天赋',
      cost: '不改变玩法，只是数值'
    };
  }

  function showChoice() {
    renderChoice();
    if (el.choiceOverlay) el.choiceOverlay.classList.remove('hidden');
  }
  function hideChoice() {
    if (el.choiceOverlay) el.choiceOverlay.classList.add('hidden');
  }

  function renderChoice() {
    var pc = state.pendingChoice;
    if (!pc || !el.choiceCards) { hideChoice(); return; }
    el.choiceHint.textContent =
      '第 ' + pc.forPrestige + ' 次转生 —— 挑一样带进新的世界（只能选一个）';
    el.choiceCards.innerHTML = pc.cards.map(function (c) {
      var t = cardText(c);
      return '<button class="choice-card ' + esc(c.type) + '" data-key="' + esc(c.key) + '">' +
               '<span class="cc-kind">' + esc(KIND_LABEL[c.type] || c.type) + '</span>' +
               '<span class="cc-name">' + esc(t.name) + '</span>' +
               '<span class="cc-desc">' + esc(t.desc) + '</span>' +
               (t.cost ? '<span class="cc-cost">' + esc(t.cost) + '</span>' : '') +
             '</button>';
    }).join('');
  }

  /* 选一张卡。用事件委托（卡片是 innerHTML 重建的）。 */
  function pickChoice(key) {
    var r = window.MYC.Sim.applyChoice(state, key);
    if (!r.ok) { toast(r.reason); return; }
    var c = r.card, t = cardText(c);
    pushLog('抉择：' + (KIND_LABEL[c.type] || c.type) + ' → ' + t.name +
            (c.note ? '（' + c.note + '）' : ''));
    toast('获得了「' + t.name + '」');
    /* 地图卡会换掉整张地图 → 场景缓存必须重来 */
    if (c.type === 'map') {
      var sc = window.MYC.game.scene;
      if (sc && sc.onMapChanged) sc.onMapChanged();
      pushLog('世界扩大到 ' + state.mapW + '×' + state.mapH);
    }
    hideChoice();
    window.MYC.game.save(true);
    UI.update(0, window.MYC.game);
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

  /* ------------------------------------------------------------ 存档槽列表
   * 平时收起，点「保存」/「读取」所在的存档卡片时展开 —— 面板本来就长，
   * 常驻三行槽位会把它撑得更长。收起时按钮文案是「显示存档槽」。
   *
   * 每个槽显示：菌丝格数 / 本局时长 / 存档时间（相对）。这三个数字足够
   * 让玩家认出「哪个是我上一局」，比只写「槽 1」有用得多。 */
  var slotsOpen = false;
  function agoText(ts) {
    if (!ts) return '';
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function renderSlots() {
    if (!el.slotList) return;
    /* 顺手把「重开一局」的入口也放进来 —— 它和槽位是同一类操作，
     * 分两处放玩家找不到。 */
    var html = '';
    for (var n = 1; n <= SLOTN; n++) {
      var m = window.MYC.game && window.MYC.game.readSlot ? window.MYC.game.readSlot(n) : null;
      if (m) {
        html += '<div class="slot" data-slot="' + n + '">'
          + '<div class="slot-title">槽 <b>' + n + '</b></div>'
          + '<div class="slot-sub">菌丝 ' + m.nodes + ' 格　' + clk(m.t)
          + '　' + esc(agoText(m.savedAt)) + (m.prestiges ? '　转生 ' + m.prestiges : '')
          + '</div>'
          + '<div class="slot-btns">'
          + '<button class="tiny" data-act="load" data-slot="' + n + '">读取</button>'
          + '<button class="tiny" data-act="save" data-slot="' + n + '">覆盖</button>'
          + '<button class="tiny" data-act="del" data-slot="' + n + '">删除</button>'
          + '</div></div>';
      } else {
        html += '<div class="slot empty" data-slot="' + n + '">'
          + '<div class="slot-title">槽 <b>' + n + '</b></div>'
          + '<div class="slot-sub">空</div>'
          + '<div class="slot-btns">'
          + '<button class="tiny" data-act="save" data-slot="' + n + '">存入</button>'
          + '</div></div>';
      }
    }
    el.slotList.innerHTML = html;
    el.slotList.style.display = slotsOpen ? 'flex' : 'none';
  }

  function toggleSlots(on) {
    slotsOpen = on == null ? !slotsOpen : !!on;
    renderSlots();
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
    /* 水分速率显示**净值**：产出减去维持费。
     * 维持费是后期的主要支出，藏在「产出」里会让玩家看不懂水为什么涨不上去
     * （设计教训：面板上的信号必须直接指向该做的决策）。
     * 碰到缓冲线时标红 —— 那就是「该买水分效率 / 该少练几个远处节点」的时刻。 */
    var mCost = state.maintainCost || 0;
    var netWater = rt.water - mCost;
    el.rWater.textContent = rate(netWater) + (mCost > 0 ? '（维持 -' + mCost.toFixed(1) + '）' : '');
    el.rWater.classList.toggle('warn', !!state.maintainPressure);
    /* 壤土递减汇总。放在水行正下方，因为它扣的正是水 ——
     * 上一版这块只报「基准 0.12」，远处几十格在偷偷倒扣却看不到，
     * 玩家因此以为机制没生效（实测反馈「为啥不显示实际产量」）。
     *
     * 【为什么 nc===0 时改成隐藏，而不是显示「尚未触发」】
     * 上一版留了一行「近核区，尚未触发（第 5 格起归零）」常驻在面板上。
     * 实测看开局截图才发现：新玩家开局只有 1 格，离归零线还远，
     * 这一行既解释不了任何正在发生的事，又占着一整行的位置 ——
     * 是**纯噪音**，还让人以为"有个机制我没用上"。
     * 所以规矩改成：**只有真的扣了水才显示**。
     * 一旦有格子越过归零线，这行立刻出现并报负数 —— 该看见时一定看得见。 */
    if (el.topsoilRow) {
      var nc = state.topsoilCells || 0;
      var no = state.topsoilOffset || 0;
      var TF = C.TOPSOIL_FALLOFF;
      if (!TF || !TF.soils || TF.soils.length === 0 || nc === 0) {
        el.topsoilRow.className = 'topsoil hide';
        el.topsoilRow.textContent = '';
      } else {
        /* ⚠ 这里**不能**出现任何「+」——就算未来 offset 真的算出正值也别加。
         * 本行的语义是「被壤土递减扣掉的水」，它只会是 0 或负数；
         * 写成 `(no > 0 ? '+' : '')` 会留一条永不执行却极易被误读的分支
         * （实测反馈「咋显示是变成往上加」时，第一嫌疑就是这行）。
         * 直接交给 toFixed 决定符号：负号跟着数值走，正数不存在。 */
        el.topsoilRow.className = 'topsoil';
        el.topsoilRow.innerHTML = '壤土递减 <b>' + nc + '</b> 格　<b class="neg">'
          + no.toFixed(2) + '/s</b>（越远扣得越多）';
      }
    }
    el.vNutrient.textContent = fmt(state.res.nutrient);
    el.rNutrient.textContent = rate(rt.nutrient);
    el.vSpore.textContent = fmt(state.res.spore);
    el.rSpore.textContent = rate(rt.spore);

    el.sNodes.textContent = state.nodes.length;
    el.sDist.textContent = state.maxDist;
    el.sLost.textContent = (state.lostTotal > 0 ? fmt(state.lostTotal) + ' 累计' : '无');
    el.sRun.textContent = clk(state.t);

    /* 结构配额：这是本机制最需要「一直被看见」的数字 ——
     * 上限少到必须取舍，所以玩家得随时知道还剩几格。 */
    if (el.trunkCount) {
      var tUsed = window.MYC.Sim.trunkCount(state);
      var cUsed = window.MYC.Sim.confluenceCount(state);
      el.trunkCount.textContent = '主干 ' + tUsed + '/' + C.TRUNK.maxTrunk +
                                 '　汇流 ' + cUsed + '/' + C.TRUNK.maxConfluence;
      /* 提示里的「还剩 N 格」要跟着配额走，否则用掉一格后提示还说着旧数字。
       * 只在计数变化时重算 —— 跟 autoGrow 用同一套 memo 思路。 */
      var sig = tUsed + ',' + cUsed;
      if (sig !== lastStructSig) {
        lastStructSig = sig;
        if (window.MYC.setStructMode) window.MYC.setStructMode(currentStructMode());
      }
    }

    /* 树木：显示「几棵树、长到哪一档、几棵被压住」。
     * 用 memo 只在变化时重写 —— 每 0.1s 重写 innerHTML 会打断文本选择，
     * 而且和结构配额一样，它是给玩家「扫一眼」用的状态，不需要逐帧刷新。 */
    if (el.treeCount) {
      var tSum = 0, tStageSum = 0, tAncient = 0, tStalled = 0, tAura = 0, tBestName = '';
      for (var ti = 1; ti < state.nodes.length; ti++) {
        var tn = state.nodes[ti];
        if (!window.MYC.Sim.isTree(tn)) continue;
        tSum++;
        var tsi = window.MYC.Sim.treeStateOf(state, tn);
        tStageSum += tsi.stage;
        if (tsi.stage >= 2) { tAncient++; tBestName = '古树'; }
        else if (tsi.stalled) tStalled++;
      }
      /* 光环覆盖数 = 被古树罩着的普通菌丝数，直接体现「影响周围」兑现了多少 */
      for (var ai = 1; ai < state.nodes.length; ai++) {
        if (window.MYC.Sim.isTree(state.nodes[ai])) continue;
        if (window.MYC.Sim.underOldTreeAura(state, state.nodes[ai])) tAura++;
      }
      var tSig = tSum + ',' + tAncient + ',' + tStalled + ',' + tAura + ',' +
                 (tSum ? Math.round(tStageSum / tSum * 100) : 0);
      if (tSig !== lastTreeSig) {
        lastTreeSig = tSig;
        el.treeCount.textContent = tSum
          ? (tSum + ' 棵　古树 ' + tAncient + ' 棵' + (tStalled ? '　被压住 ' + tStalled + ' 棵' : ''))
          : '还没有树';
        if (!tSum) {
          el.treeHint.textContent = '在「树根」格上长一格菌丝，它就是一棵树苗 —— ' +
                                    '之后它会自己长大，不用花资源，只花时间。';
        } else if (tAncient > 0) {
          el.treeHint.textContent = '有 ' + tAncient + ' 棵古树，光环正笼罩着 ' + tAura +
                                    ' 格菌丝（每格 +25% 产出）。';
        } else if (tStalled > 0) {
          el.treeHint.textContent = '⚠ 有 ' + tStalled + ' 棵被周围菌丝压住了成长 —— ' +
                                    '拔掉它附近几格就能恢复。';
        } else {
          el.treeHint.textContent = '树正在长 —— 平均已到第 ' +
                                    (tStageSum / tSum).toFixed(1) + ' 档（2 档 = 古树）。';
        }
      }
    }

    // 自动蔓延开关：m10「感知」解锁前是灰的，并明确告诉玩家怎么解锁。
    // 用 memo 避免每 0.1s 重写一次 label。
    var agLocked = !state.milestones.m10;
    if (agLocked !== lastAgLocked) {
      lastAgLocked = agLocked;
      el.autoGrow.disabled = agLocked;
      el.autoGrowRow.classList.toggle('off', agLocked);
      /* 规则只作用于自动蔓延，所以解锁前它们没有意义 ——
       * 一起灰掉，避免玩家调了半天却看不到任何效果。 */
      if (el.ruleMaxDist) el.ruleMaxDist.disabled = agLocked;
      if (el.ruleMinYield) el.ruleMinYield.disabled = agLocked;
      if (el.autoRuleRow) el.autoRuleRow.classList.toggle('off', agLocked);
      el.autoGrowLabel.innerHTML = agLocked
        ? '自动蔓延<span class="hint" style="display:inline">（未解锁 —— 连上 4 种特殊基质，且菌丝达到 ' +
          C.GROW.autoUnlockNodes + ' 格）</span>'
        : '自动蔓延<span class="hint" style="display:inline">（关掉则只靠你手动点）</span>';
      if (agLocked) el.autoGrow.checked = false;
      else el.autoGrow.checked = state.autoGrow;
    }

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

    // 菌株：解锁（40 格）之前整张卡不出现 —— 免得开局就让人 4 选 1 犯难
    var sInfo = window.MYC.Sim.strainInfo(state);
    el.strainCard.classList.toggle('hidden', !sInfo.unlocked);
    if (sInfo.unlocked) {
      el.strainSlots.textContent = '槽位 ' + sInfo.equipped.length + '/' + sInfo.slots;
      var full = sInfo.equipped.length >= sInfo.slots;
      C.STRAIN.list.forEach(function (s) {
        var r = strainRows[s.key];
        if (!r) return;
        var on = sInfo.equipped.indexOf(s.key) >= 0;
        r.btn.textContent = on ? '卸下' : '装上';
        r.btn.classList.toggle('on', on);
        /* 槽位满了之后，未装备的按钮置灰但**不隐藏** ——
         * 玩家要能看见「还有哪些选择」，才知道该卸谁。 */
        r.btn.disabled = !on && full;
        r.row.classList.toggle('on', on);
      });
      el.strainHint.textContent = full
        ? '槽位已满。想换别的菌株，先卸掉一个。'
        : '还剩 ' + (sInfo.slots - sInfo.equipped.length) + ' 个空槽位。菌株是 Build 选择，转生后保留。';
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
      // 用 r.cfg（= 建面板时存下来的那个技能配置），不是 a.cfg ——
      // ABILITIES 的条目里没有 cfg 字段，cd 就在条目本身上（见 config.js）。
      // 写成 a.cfg.cd 平时不报错，只在「已解锁且正在冷却」时炸掉 UI 刷新。
      r.bar.style.width = (unlocked && cd > 0) ? (cd / r.cfg.cd * 100).toFixed(0) + '%' : '0%';
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
      if (e.kind === 'gnat' || e.kind === 'blight') return;
      parts.push((e.kind === 'rain' ? '降雨带' : '孢子季') + ' ' + Math.ceil(e.ttl) + 's');
    });
    var gn = window.MYC.Sim.countGnats(state);
    if (gn) parts.push('害虫 ×' + gn + '（点它驱除）');
    var bl = window.MYC.Sim.countBlights(state);
    if (bl) parts.push('⚠ 菌瘟 ×' + bl + '（会扩散！把邻居练到比它高，围死就熄灭）');
    el.eventLine.textContent = parts.length ? ('事件：' + parts.join('　·　')) : '';

    // 通知：新事件 / 新里程碑（由 sim 塞进 state.newEvents / newMilestones）
    if (state.newEvents && state.newEvents.length) {
      state.newEvents.forEach(function (e) {
        if (e.kind === 'gnat') {
          pushLog('⚠ 害虫出现，占据了一格菌丝（点地图上的红点驱除）');
          toast('害虫出现 —— 点地图上的红点驱除');
        } else if (e.kind === 'blight') {
          pushLog('⚠ 菌瘟出现！会沿菌丝扩散，只感染 Lv' + C.BLIGHT.maxLevel +
                  ' 及以下的菌丝（无法净化 —— 把邻居练到比它等级高，' +
                  '连续 ' + C.BLIGHT.failLimit + ' 个周期传不出去就熄灭）');
          toast('菌瘟出现 —— 比它高的菌丝能挡住它，围死 ' + C.BLIGHT.failLimit + ' 个周期就熄灭');
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

  /* 第一次探明某种基质时提示一下，让探索有反馈。
   * 全部见过后直接短路 —— 地图变大之后，每 0.1s 扫一遍全图就是纯浪费。 */
  var seenAllSoils = false;
  function scanDiscoveries() {
    if (seenAllSoils) return;
    for (var i = 0; i < state.grid.length; i++) {
      var c = state.grid[i];
      if (!c.known || seenSoils[c.soil]) continue;
      seenSoils[c.soil] = 1;
      if (c.soil !== 'soil' && c.soil !== 'core') {
        var s = C.SOILS[c.soil];
        pushLog('发现 ' + s.name + '：' + describe(s));
      }
    }
    var all = true;
    for (var k in C.SOILS) {
      if (k !== 'soil' && k !== 'core' && !seenSoils[k]) { all = false; break; }
    }
    if (all) seenAllSoils = true;
  }

  /* 描述一种基质的产出（发现提示用）。
   *
   * ⚠ 不能直接读 s.yield.water —— 那是**不含壤土递减的基准值**。
   *   壤土近处 0.12 起步、第 5 格归零、第 41 格起倒扣到 -1.05，
   *   直接报「水 +0.12/s」就是在骗玩家（也会让递减机制看起来没生效）。
   *   所以壤土这里写「基准 + 距离规则」，并给两个锚点数字。 */
  function describe(s) {
    var out = [];
    var F = C.TOPSOIL_FALLOFF;
    var isFall = F && F.soils && F.soils.indexOf(s.key) >= 0 && F.resource === 'water';
    if (s.yield.water) {
      if (isFall) {
        var zero = F.base / F.slope;                       // 归零距离（dist）
        var floorYield = F.base - F.limit;                  // 产出地板
        out.push('水 ' + s.yield.water + '/s（近核，离核越远越少：'
                 + '第 ' + (zero + 1) + ' 格归零、第 ' + (F.limit / F.slope + 1)
                 + ' 格起 ' + floorYield.toFixed(2) + '/s）');
      } else {
        out.push('水 +' + s.yield.water + '/s');
      }
    }
    if (s.yield.nutrient) out.push('养分 +' + s.yield.nutrient + '/s');
    if (s.yield.spore) out.push('孢子 +' + s.yield.spore + '/s');
    return out.join('，');
  }

  /* 供外部调用：把已保存的进度重新挂到面板上。
   *
   * 【为什么这里是「直接落值」而不是「把 memo 置空」】
   * 自动蔓延开关的刷新靠 `lastAgLocked` 这个 memo 做增量
   * （见 update() 里的 `if (agLocked !== lastAgLocked)`）。
   * 早先这里只写 `lastAgLocked = null`，指望下一次 update 重算 ——
   * 那是个**假值哨兵陷阱**：重置成一个存档恰好未解锁 m10 时，
   * 下一次比较是 `false !== null` → 成立，于是分支进去做了
   * `lastAgLocked = false` 就退出，**重算代码根本没被执行到**
   * （赋值块在同一分支内，而且用的是刚换掉的旧 state）。
   * 表现：载入旧存档 / 测试重置后，开关的灰化状态与文案残留上一局的。
   * 所以 rebind 必须**按新 state 亲自算一遍并落值**，
   * 让 memo 与真实状态对齐 —— 这样 null 无论何时都不会成为「看起来已初始化」的坑。 */
  function rebind(newState) {
    state = newState;
    window.MYC.game.state = newState;
    seenSoils = {};
    /* 直接按新 state 算好并写进 DOM，再同步 memo，不留「等下次刷新」的窗口 */
    var agLocked = !newState.milestones.m10;
    lastAgLocked = agLocked;
    el.autoGrow.disabled = agLocked;
    el.autoGrowRow.classList.toggle('off', agLocked);
    if (el.ruleMaxDist) el.ruleMaxDist.disabled = agLocked;
    if (el.ruleMinYield) el.ruleMinYield.disabled = agLocked;
    if (el.autoRuleRow) el.autoRuleRow.classList.toggle('off', agLocked);
    el.autoGrowLabel.innerHTML = agLocked
      ? '自动蔓延<span class="hint" style="display:inline">（未解锁 —— 连上 4 种特殊基质，且菌丝达到 ' +
        C.GROW.autoUnlockNodes + ' 格）</span>'
      : '自动蔓延<span class="hint" style="display:inline">（关掉则只靠你手动点）</span>';
    el.autoGrow.checked = agLocked ? false : !!newState.autoGrow;
    el.policy.value = newState.policy;
    updatePolicyHint();
    /* 自动蔓延的两条规则同样要按新 state 落值 ——
     * 与上面开关是同一类坑：载入存档后下拉框若留着上一局的选择，
     * 玩家看到的规则与实际生效的规则就分家了。 */
    if (el.ruleMaxDist) el.ruleMaxDist.value = newState.ruleMaxDist || 0;
    if (el.ruleMinYield) el.ruleMinYield.value = newState.ruleMinYield || 0;
    updateRuleHint();
    lastStructSig = '';                          // 结构配额同理，下一帧强制重算
    lastTreeSig = '';                            // 树木摘要同理
    el.seedTxt.textContent = '种子 ' + newState.seed;
    /* 换局（读档 / 新游戏）后，三选一弹窗要跟着新存档走。
     * 少了这一句就会出现：在 A 局转生 → 弹窗还开着 → 去读 B 局的档 →
     * 弹窗还挂在屏幕上，但点下去会作用在 B 局（甚至报「卡不在候选里」）。 */
    if (newState.pendingChoice) showChoice(); else hideChoice();
  }

  return {
    init: init, update: update, toast: toast, pushLog: pushLog, rebind: rebind,
    renderSlots: renderSlots, toggleSlots: toggleSlots,
    KEY: KEY, SEEDKEY: SEEDKEY, SLOTN: SLOTN, slotKey: slotKey, fmt: fmt
  };
})();
