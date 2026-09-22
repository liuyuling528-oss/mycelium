/* ============================================================================
 * main.js — 启动：Phaser 引导 + 存档管理
 *
 * 全局桥梁都挂在 MYC.game 上：
 *   state  当前游戏状态（纯数据，Sim 负责演算）
 *   dirty  置 true 表示面板需要刷新
 *   scene  WorldScene 实例（用于屏幕震动等表现）
 *   ui     UI 模块（供场景回调提示）
 * ==========================================================================*/
(function () {
  'use strict';

  var Sim = window.MYC.Sim;

  function randomSeed() {
    return (Math.random() * 4294967295) >>> 0;
  }

  function storedSeed() {
    var s = parseInt(localStorage.getItem(UI.SEEDKEY) || '', 10);
    return isFinite(s) && s > 0 ? s : randomSeed();
  }

  /* ---- 槽位存档 --------------------------------------------------------
   * 和「自动存档」的关系：
   *   自动存档（UI.KEY）**永远是当前这一局**，每次保存 / 关页面都会覆盖它。
   *   槽位（UI.slotKey(n)）是玩家手动拍下的快照，不会被自动流程动到。
   * 这样「读取存档」才真的有意义 —— 上一版只有一个 key，
   * 点「读取」读到的就是被自动存档覆盖过的当前局，等于没读。
   *
   * 槽内除了 Sim.serialize 的数据，还存一份**摘要**（summary），
   * 用于在没有加载整局的前提下把槽位列表画出来 —— 列表要能显示
   * 「菌丝多少格 / 玩到多久 / 什么时候存的」，否则玩家不知道读哪个。 */
  function slotMeta(n, raw) {
    if (!raw) return null;
    try {
      var d = JSON.parse(raw);
      var meta = d._meta || {};
      return {
        slot: n,
        savedAt: meta.savedAt || 0,
        nodes: meta.nodes != null ? meta.nodes : 0,
        t: meta.t != null ? meta.t : 0,
        seed: d.seed,
        prestiges: d.prestiges || 0,
        genes: d.genes ? (d.genes.gYield || 0) : 0,
        raw: raw
      };
    } catch (e) { return null; }
  }

  function readSlot(n) {
    try { return slotMeta(n, localStorage.getItem(UI.slotKey(n))); }
    catch (e) { return null; }
  }

  function writeSlot(n, state) {
    var payload = Sim.serialize(state);
    /* 把摘要塞进同一个 JSON 里（多一个 `_meta` 键），
     * 这样读列表时一次 getItem 就够，不用存两份、也不会不同步。
     * deserialize 忽略未知键，所以不需要动 sim.js。 */
    var obj = JSON.parse(payload);
    obj._meta = {
      savedAt: Date.now(),
      nodes: state.nodes.length,
      t: state.t,
      seed: state.seed
    };
    localStorage.setItem(UI.slotKey(n), JSON.stringify(obj));
    return obj._meta;
  }

  function clearSlot(n) {
    try { localStorage.removeItem(UI.slotKey(n)); } catch (e) {}
  }

  /* ---- 状态：能读到存档就续上，否则开新局 ---- */
  var state, resumed = false, offlineResult = null;
  try {
    var raw = localStorage.getItem(UI.KEY);
    if (raw) {
      state = Sim.deserialize(raw);
      resumed = true;
      /* 离线收益：用存档里的「上次保存时间」算离开了多久。
       *
       * 时间戳放在 payload 的 `_meta.savedAt` 里（自动存档和槽位存档
       * 共用同一个约定）。没有 `_meta` 的是旧档（本功能之前存的），
       * 那就**不发离线收益** —— 宁可少发，也不要拿一个编造的时间去发，
       * 否则老玩家一更新就会收到一笔莫名其妙的巨款。 */
      var away = 0;
      try {
        var obj = JSON.parse(raw);
        var savedAt = obj._meta && obj._meta.savedAt;
        if (savedAt) away = (Date.now() - savedAt) / 1000;
      } catch (e2) {}
      offlineResult = Sim.settleOffline(state, away);
    }
  } catch (e) {
    console.warn('存档损坏，已开新局', e);
    try { localStorage.removeItem(UI.KEY); } catch (e2) {}
  }
  if (!state) state = Sim.newGame(storedSeed(), {}, {});

  /* 读档 / 新局之后，场景里那一堆「上一局的缓存」都要清掉，
   * 否则地图会残留旧格子、弹出层会错位。集中成一处，避免漏改。 */
  function resetSceneCache() {
    var sc = game.scene;
    if (!sc) return;
    sc.lastKnown = -1;
    sc.lastSoilSig = null;
    sc.lastNodeCount = 0;
    sc.pops = {};
  }

  var game = {
    state: state,
    dirty: true,
    scene: null,
    ui: null,
    /* 本次启动结算到的离线收益（没结算到就是 null）。
     * UI 在首次 update 时读它弹提示 —— 不能在读档那一刻弹，
     * 那时 DOM 还没挂上，toast / 日志都会丢。 */
    offline: offlineResult,

    shake: function () {
      if (this.scene) this.scene.cameras.main.shake(420, 0.007);
    },

    /* 自动存档：覆盖当前局。silent 用于关页面 / 换局时避免刷提示。
     * 必须带上 `_meta.savedAt` —— 离线收益靠它算「离开了多久」，
     * 丢了时间戳就等于离线功能失效（而且不会有任何报错）。 */
    save: function (silent) {
      try {
        var obj = JSON.parse(Sim.serialize(this.state));
        obj._meta = {
          savedAt: Date.now(),
          nodes: this.state.nodes.length,
          t: this.state.t,
          seed: this.state.seed
        };
        localStorage.setItem(UI.KEY, JSON.stringify(obj));
        localStorage.setItem(UI.SEEDKEY, String(this.state.seed));
        if (!silent) UI.toast('已保存到浏览器本地');
      } catch (e) {
        if (!silent) UI.toast('保存失败：' + e.message);
      }
    },

    /* 读到内存里，不动当前局 —— 供「读取存档」列表和读档共用。 */
    readSlot: readSlot,
    /* 把当前局写进槽 n。 */
    saveToSlot: function (n) {
      try {
        writeSlot(n, this.state);
        UI.renderSlots();
        UI.toast('已存入槽 ' + n);
      } catch (e) {
        UI.toast('存档失败：' + e.message);
      }
    },
    clearSlot: function (n) {
      clearSlot(n);
      UI.renderSlots();
      UI.toast('已删除槽 ' + n);
    },
    /* 从槽 n 读档，替换当前局。 */
    loadFromSlot: function (n) {
      var m = readSlot(n);
      if (!m) { UI.toast('槽 ' + n + ' 是空的'); return false; }
      try {
        var s = Sim.deserialize(m.raw);
        this.state = s;
        UI.rebind(s);
        resetSceneCache();
        this.dirty = true;
        UI.pushLog('已读取槽 ' + n + '（菌丝 ' + s.nodes.length + ' 格）');
        UI.toast('已读取槽 ' + n);
        this.save(true);          // 让自动存档跟上，刷新页面不会回到旧局
        return true;
      } catch (e) {
        UI.toast('存档损坏：' + e.message);
        return false;
      }
    },

    /* 开始新游戏：**彻底重来** —— 基因、知识、转生次数全部清零。
     * 和「重开一局」（保留基因只换地图）是两件事，所以分开两个入口。 */
    newGame: function (keepGenes) {
      var msg = keepGenes
        ? '开新一局？\n（永久基因保留，地图与网络重置）'
        : '开始新游戏？\n（永久基因、知识、转生记录会全部清空，无法撤销）';
      if (!confirm(msg)) return false;
      var genes = keepGenes ? this.state.genes : {};
      var s = Sim.newGame(randomSeed(), genes, {});
      this.state = s;
      UI.rebind(s);
      resetSceneCache();
      this.dirty = true;
      UI.pushLog(keepGenes ? '新一局开始（基因保留）' : '新游戏开始 —— 一切归零');
      this.save(true);
      return true;
    }
  };
  window.MYC.game = game;

  /* ---- 面板先挂上，Phaser 随后启动 ---- */
  UI.init(game);
  game.ui = UI;
  UI.pushLog(resumed ? '已读取上次的进度' : '一粒孢子落在土壤里……');
  /* 离线收益的提示放在这里而不是读档那一刻：那时 DOM 刚挂上、
   * toast 容器还没准备好，提示会静默丢掉。 */
  if (offlineResult) {
    var g = offlineResult.gained;
    var mins = Math.round(offlineResult.seconds / 60);
    var span = mins >= 60 ? (mins / 60).toFixed(1) + ' 小时' : mins + ' 分钟';
    UI.pushLog('离开的 ' + span + ' 里，菌丝自己长了：' +
               UI.fmt(g.nutrient) + ' 养分、' + UI.fmt(g.spore) + ' 孢子' +
               (offlineResult.capped ? '（已按 ' + window.MYC.CONFIG.OFFLINE.capHours + ' 小时封顶）' : ''));
    UI.toast('离线 ' + span + '，收回了 ' + UI.fmt(g.nutrient) + ' 养分');
    /* 结算完立刻存一次：把时间戳刷新到现在。
     * 不刷的话，如果玩家看完就走，下次进来会把同一段时间**再发一次**。 */
    game.save(true);
  }
  UI.pushLog('点击地图上描边的格子开始蔓延菌丝');
  UI.update(0, game);

  /* ---- Phaser ----
   * Scale.RESIZE：画布内部尺寸跟着容器走，具体缩放由 WorldScene 的
   * targetView() 决定。为什么不用 FIT —— FIT 在宽屏上会把 916px 的缓冲区
   * 放大到容器大小，格线和文字都会变糊；RESIZE 始终按原生像素渲染。
   */
  var phaserGame = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#060806',
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: '100%',
      height: '100%'
    },
    render: { antialias: true, roundPixels: true },
    scene: [window.MYC.WorldScene]
  });

  phaserGame.events.once('ready', function () {
    game.scene = phaserGame.scene.getScene('World');
  });

  /* 挂载时容器的尺寸可能还是 0（CSS 还没布局完），刷新一次；
   * 之后 WorldScene 每帧都会重新读 this.scale.width，所以能自愈。 */
  function refreshScale() {
    try { phaserGame.scale.refresh(); if (game.scene) game.scene.snapView(); } catch (e) {}
  }
  window.addEventListener('load', refreshScale);
  window.addEventListener('orientationchange', function () { setTimeout(refreshScale, 250); });
  setTimeout(refreshScale, 0);

  /* 关掉页面时保存一次 */
  window.addEventListener('beforeunload', function () { game.save(true); });
})();
