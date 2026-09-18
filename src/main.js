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

  /* ---- 状态：能读到存档就续上，否则开新局 ---- */
  var state, resumed = false;
  try {
    var raw = localStorage.getItem(UI.KEY);
    if (raw) { state = Sim.deserialize(raw); resumed = true; }
  } catch (e) {
    console.warn('存档损坏，已开新局', e);
    try { localStorage.removeItem(UI.KEY); } catch (e2) {}
  }
  if (!state) state = Sim.newGame(storedSeed(), {}, {});

  var game = {
    state: state,
    dirty: true,
    scene: null,
    ui: null,

    shake: function () {
      if (this.scene) this.scene.cameras.main.shake(420, 0.007);
    },

    save: function (silent) {
      try {
        localStorage.setItem(UI.KEY, Sim.serialize(this.state));
        localStorage.setItem(UI.SEEDKEY, String(this.state.seed));
        if (!silent) UI.toast('已保存到浏览器本地');
      } catch (e) {
        if (!silent) UI.toast('保存失败：' + e.message);
      }
    },

    load: function () {
      var raw = localStorage.getItem(UI.KEY);
      if (!raw) { UI.toast('没有找到存档'); return; }
      try {
        var s = Sim.deserialize(raw);
        this.state = s;
        UI.rebind(s);
        if (this.scene) { this.scene.lastKnown = -1; this.scene.lastSoilSig = null; this.scene.lastNodeCount = 0; this.scene.pops = {}; }
        this.dirty = true;
        UI.toast('已读取存档');
      } catch (e) {
        UI.toast('存档损坏：' + e.message);
      }
    },

    /* 换一张地图重开。基因保留（相当于重来一次但底子还在）。 */
    newSeed: function () {
      if (!confirm('换一张新地图并重开这一局？\n（永久基因会保留）')) return;
      var s = Sim.newGame(randomSeed(), this.state.genes, {});
      this.state = s;
      UI.rebind(s);
      if (this.scene) { this.scene.lastKnown = -1; this.scene.lastSoilSig = null; this.scene.lastNodeCount = 0; this.scene.pops = {}; }
      this.dirty = true;
      UI.pushLog('新地图已生成，种子 ' + s.seed);
      this.save(true);
    }
  };
  window.MYC.game = game;

  /* ---- 面板先挂上，Phaser 随后启动 ---- */
  UI.init(game);
  game.ui = UI;
  UI.pushLog(resumed ? '已读取上次的进度' : '一粒孢子落在土壤里……');
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
