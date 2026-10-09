/* ============================================================================
 * textures.js — 程序化像素贴图
 *
 * 独立游戏质感的来源：所有地表与实体都是真正的像素画，而不是纯色块。
 * 贴图全部在运行时生成（无素材文件），画进 Phaser 的 Canvas 纹理，
 * 用 NEAREST 采样保持像素边缘锐利。
 *
 * 【像素密度随转生提升 —— 转生的可见回报之一】
 *   从 1×1（孢子眼里的纯色世界，即贴图化之前的观感）开始，
 *   每转生一次 +1 像素，到 16×16 封顶（第 15 次转生）：
 *   转生 k 次 → (k+1)×(k+1)，k = 0..15。
 * 地表贴图直接按目标密度程序化生成（图案坐标做了密度无关的归一化，
 * 所以密度越高、同一片地表的细节越丰富，而不是换了一张图）；
 * 实体贴图（树/核心/菌落/害虫/菌瘟）来自手绘的 16×16 母版，
 * 低密度时中心最近邻采样 —— 是同一幅画的「更粗糙的版本」。
 *
 * 转生后由 WorldScene 检测档位变化并调用 build() 重建整套贴图。
 * ==========================================================================*/
var TEX = (function () {
  'use strict';

  var MAX_DENSITY = 16;

  /* 转生次数 → 密度：从 1×1 起步，每次转生 +1，16×16 封顶（第 15 次转生） */
  function tierOf(prestiges) {
    var p = prestiges || 0;
    return Math.min(p, MAX_DENSITY - 1);
  }
  function densityFor(prestiges) { return tierOf(prestiges) + 1; }

  var N = 1;                     // 当前密度（build 时更新）
  var currentTier = -1;

  /* ---- 小工具 ------------------------------------------------------- */
  function css(c) {
    var r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }
  function shade(c, k) {
    var r = Math.min(255, Math.max(0, ((c >> 16) & 255) * k)) | 0;
    var g = Math.min(255, Math.max(0, ((c >> 8) & 255) * k)) | 0;
    var b = Math.min(255, Math.max(0, (c & 255) * k)) | 0;
    return (r << 16) | (g << 8) | b;
  }

  /* ---- 实体母版（16×16 手绘，'.' = 透明）---------------------------- */
  var MASTERS = {
    core: { pal: { a: 0x8a6a2a, b: 0xc99a3e, c: 0xe8bc63, d: 0xffe9a8, e: 0xfff6d8 },
      art: [
        '................',
        '.......aa.......',
        '......abba......',
        '.....abccba.....',
        '....abcdcba.....',
        '...abcdeedcba...',
        '...abcdeedcba...',
        '...abcdeedcba...',
        '....abdcdba.....',
        '.....abccba.....',
        '......abba......',
        '.......aa.......',
        '................',
        '................',
        '................',
        '................'
      ] },
    myco: { pal: { a: 0x8d987f, b: 0xc8d2bd, c: 0xf2f7ea },
      art: [
        '................',
        '................',
        '.....abba.......',
        '....abbbba......',
        '...abbbcba......',
        '..abbccccba.....',
        '..abcccccba.....',
        '.abcccccccbba...',
        '.abccccccccba...',
        '.abcccccccba....',
        '..abccccbba.....',
        '...abbbbba......',
        '....abba........',
        '................',
        '................',
        '................'
      ] },
    tree0: { pal: { b: 0xa8d877, c: 0x7ab648, d: 0x6a8a4a, e: 0x4a6a38 },
      art: [
        '................',
        '................',
        '................',
        '................',
        '................',
        '.....cb.........',
        '....cbbb.c......',
        '.....bb.cbc.....',
        '......cbbc......',
        '.......dc.......',
        '......edc.......',
        '.......dc.......',
        '.......c........',
        '................',
        '................',
        '................'
      ] },
    tree1: { pal: { a: 0x4a7a52, b: 0x8fd48a, c: 0xb8e89a, d: 0x6a4a2a, e: 0x4a3218 },
      art: [
        '................',
        '................',
        '.....abba.......',
        '....abbbba......',
        '...abbbbbbba....',
        '..abbcbbbcbba...',
        '..abbcbbbcbba...',
        '..abbbbbbbbba...',
        '...abbbbbba.....',
        '....acccca......',
        '.....acca.......',
        '......dd........',
        '......dd........',
        '.....edd........',
        '................',
        '................'
      ] },
    tree2: { pal: { a: 0x7a8a3a, b: 0xd9e86a, c: 0xf0f0a0, d: 0x5a3a1a, e: 0x3a2410 },
      art: [
        '................',
        '......abba......',
        '....aabbbbaa....',
        '...abbcbbbba....',
        '..abbcbbbbbba...',
        '..abbbbbbbbbba..',
        '.abbcbbbbbbbbba.',
        '.abbbbbbbbbbcba.',
        '.abbbbbbbbbba...',
        '..abbbbbbbbba...',
        '...aabbbbaa.....',
        '.....acda.......',
        '......cd........',
        '......cd........',
        '.....ecd........',
        '................'
      ] },
    colony: { pal: { a: 0xffffff, b: 0xd0d0d0 },
      art: [
        '................',
        '................',
        '.....aaaaaa.....',
        '....abbbbbba....',
        '...abb....bba...',
        '..ab........ba..',
        '..ab........ba..',
        '.ab..........ba.',
        '.ab..........ba.',
        '.ab..........ba.',
        '..ab........ba..',
        '..ab........ba..',
        '...abb....bba...',
        '....abbbbbba....',
        '.....aaaaaa.....',
        '................'
      ] },
    gnat: { pal: { a: 0x4a180c, b: 0x8a3820, c: 0xc85638, d: 0xffb08a },
      art: [
        '................',
        '................',
        '................',
        '......aa........',
        '.....abba.......',
        '....aabbaa......',
        '...aaccccaa.....',
        '..aaccdccaa.....',
        '..aaccdccaa.....',
        '...aaccccaa.....',
        '....aabbaa......',
        '.....abba.......',
        '......aa........',
        '................',
        '................',
        '................'
      ] },
    blight: { pal: { a: 0x2c1745, b: 0x6b3fa0, c: 0xa97bd6 },
      art: [
        '................',
        '................',
        '....aa..........',
        '...abba..aa.....',
        '..abbba.abba....',
        '..abcbbabba.....',
        '.abbcbbaabba....',
        '.abcbbbbbba.....',
        '.abbbcbbcba.....',
        '..abcbbba.......',
        '...abbba........',
        '....aaa.........',
        '................',
        '................',
        '................',
        '................'
      ] }
  };

  /* 把母版画成 N×N（中心最近邻采样，N≤16 时是「更粗糙的同一幅画」）。
   * 采样点带 0.5 偏移取格心：N=1 时正落在母版正中心，实体缩成
   * 「一个有代表性的色点」而不是透明。中心若是透明（比如菌落是空心环），
   * 就近搜索最近的不透明像素 —— 保证 1×1 档实体仍然可见。 */
  function drawMaster(ctx, def, n) {
    var art = def.art, pal = def.pal;
    for (var y = 0; y < n; y++) {
      var sy = Math.min(15, Math.max(0, Math.floor((y + 0.5) * 16 / n)));
      for (var x = 0; x < n; x++) {
        var sx = Math.min(15, Math.max(0, Math.floor((x + 0.5) * 16 / n)));
        var ch = art[sy][sx];
        if (ch === '.' || !pal[ch]) {
          /* 就近搜索：半径 1 起步逐圈外扩，找最近的不透明像素 */
          var found = null;
          for (var r = 1; r <= 8 && !found; r++) {
            for (var dy = -r; dy <= r && !found; dy++) {
              for (var dx = -r; dx <= r && !found; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                var yy = sy + dy, xx = sx + dx;
                if (yy < 0 || yy > 15 || xx < 0 || xx > 15) continue;
                var c2 = art[yy][xx];
                if (c2 !== '.' && pal[c2]) found = pal[c2];
              }
            }
          }
          if (!found) continue;
          ctx.fillStyle = css(found);
          ctx.fillRect(x, y, 1, 1);
          continue;
        }
        ctx.fillStyle = css(pal[ch]);
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  /* ---- 地表生成器（按密度直接生成，图案坐标密度无关）----------------
   * 每种地表 3 个变体（种子不同），格子里用坐标哈希挑变体，
   * 再叠加每格亮度抖动 —— 大片同种地表不会像贴瓷砖。 */
  var GROUND_BASE = {
    soil:   0x3B3227,
    litter: 0x5C4526,
    wood:   0x3A2718,
    vein:   0x1D4B63,
    root:   0x27522F,
    rock:   0x2b2b31,
    unknown: 0x070907
  };

  function genGround(type, n, variant) {
    var base = GROUND_BASE[type];
    var seed = 1000 + variant * 7919;
    var px = [];
    var walk = null;

    if (type === 'root') {
      /* 根系脉络：一条随机游走的根须，暗线 + 亮边 */
      walk = [];
      var rr = RNG.makeRng(seed ^ 0x5eed);
      var wx = (rr() * n) | 0, wy = (rr() * n) | 0;
      for (var s = 0; s < n * 3; s++) {
        walk.push([wx, wy]);
        wx = Math.max(0, Math.min(n - 1, wx + ((rr() * 3) | 0) - 1));
        wy = Math.max(0, Math.min(n - 1, wy + ((rr() * 3) | 0) - 1));
      }
    }

    for (var y = 0; y < n; y++) {
      var row = new Array(n);
      for (var x = 0; x < n; x++) {
        var fu = x / n, fv = y / n;
        var h = RNG.hash2(x, y, seed);
        var noise = RNG.fbm(fu * 4, fv * 4, seed, 3);
        var c = base;

        if (type === 'soil') {
          c = shade(base, 0.90 + noise * 0.24);
          if (h > 0.94) c = shade(base, 1.28);          // 砂砾亮点
          else if (h < 0.045) c = shade(base, 0.72);    // 小石子暗点
        } else if (type === 'litter') {
          c = shade(base, 0.92 + noise * 0.20);
          if (h > 0.90) c = shade(base, 1.38);          // 碎叶亮片
          else if (h < 0.06) c = shade(base, 0.70);
          if (RNG.fbm(fu * 7, fv * 7, seed + 31, 2) > 0.63) c = shade(base, 1.14);
        } else if (type === 'wood') {
          /* 竖向木纹：x 方向高频、y 方向低频的噪声拉成条纹 */
          var grain = RNG.fbm(fu * 9, fv * 1.6, seed, 2);
          c = shade(base, 0.84 + grain * 0.42);
          if (grain > 0.60) c = shade(base, 1.30);      // 木质亮纹
          if (h > 0.965) c = shade(base, 0.55);         // 纵裂
        } else if (type === 'vein') {
          /* 水波：y 方向的波纹带，波峰提亮成青色高光 */
          var ripple = Math.sin((fv * 5.2 + RNG.fbm(fu * 3, fv * 3, seed, 2) * 1.6) * Math.PI);
          c = shade(base, 0.86 + noise * 0.22);
          if (ripple > 0.45) c = shade(base, 1.42);
          if (h > 0.972) c = 0x5ec8e8;                  // 水面闪光
          if (noise < 0.34) c = shade(base, 0.72);      // 深水
        } else if (type === 'root') {
          c = shade(base, 0.92 + noise * 0.18);
        } else if (type === 'rock') {
          c = shade(base, 0.92 + noise * 0.16);
        } else { // unknown
          c = shade(base, 0.92 + noise * 0.16);
        }
        row[x] = c;
      }
      px.push(row);
    }

    /* 地表特征笔触（在噪声底上叠加结构性纹理） */
    if (type === 'root' && walk) {
      for (var i = 0; i < walk.length; i++) {
        var wx2 = walk[i][0], wy2 = walk[i][1];
        px[wy2][wx2] = shade(base, 0.55);               // 根须暗线
        if (i % 3 === 0 && wy2 > 0) px[wy2 - 1][wx2] = shade(base, 1.35);
      }
    }
    if (type === 'rock') {
      var rc = RNG.makeRng(seed ^ 0xc2a1);
      for (var cr = 0; cr < 2; cr++) {                  // 两条裂缝（随机游走）
        var cx = (rc() * n) | 0, cy = 0;
        for (var step = 0; step < n; step++) {
          px[cy][cx] = shade(base, 0.55);
          cx = Math.max(0, Math.min(n - 1, cx + ((rc() * 3) | 0) - 1));
          cy = Math.min(n - 1, cy + 1);
        }
      }
      for (var e2 = 0; e2 < n; e2++) {                  // 边缘描一圈暗 + 内圈亮（石块棱角）
        px[0][e2] = px[n - 1][e2] = shade(base, 0.62);
        px[e2][0] = px[e2][n - 1] = shade(base, 0.62);
        if (n >= 8) {
          px[1][e2] = shade(px[1][e2], 1.25);
          px[e2][1] = shade(px[e2][1], 1.25);
        }
      }
    }

    return px;
  }

  /* ---- 贴图构建 ------------------------------------------------------ */
  /* 生成/重建当前密度档的全部贴图。重复调用会先移除旧贴图（转生换档时用）。 */
  function build(scene, tier) {
    if (tier === currentTier && scene.textures.exists('t_unknown')) return;
    currentTier = tier;
    N = tier + 1;

    var types = ['soil', 'litter', 'wood', 'vein', 'root', 'rock', 'unknown'];
    for (var i = 0; i < types.length; i++) {
      var type = types[i];
      var variants = (type === 'unknown') ? 1 : 3;
      for (var v = 0; v < variants; v++) {
        var key = groundKey(type, v);
        if (scene.textures.exists(key)) scene.textures.remove(key);
        var tex = scene.textures.createCanvas(key, N, N);
        var ctx = tex.getContext();
        var pixels = genGround(type, N, v);
        for (var yy = 0; yy < N; yy++) {
          for (var xx = 0; xx < N; xx++) {
            ctx.fillStyle = css(pixels[yy][xx]);
            ctx.fillRect(xx, yy, 1, 1);
          }
        }
        tex.refresh();
        tex.setFilter(Phaser.Textures.FilterMode.NEAREST);
      }
    }

    for (var m in MASTERS) {
      var key2 = 't_' + m;
      if (scene.textures.exists(key2)) scene.textures.remove(key2);
      var tex2 = scene.textures.createCanvas(key2, N, N);
      drawMaster(tex2.getContext(), MASTERS[m], N);
      tex2.refresh();
      tex2.setFilter(Phaser.Textures.FilterMode.NEAREST);
    }
  }

  function groundKey(type, variant) {
    return 't_' + type + (type === 'unknown' ? '' : ('_' + variant));
  }

  return {
    tierOf: tierOf,
    densityFor: densityFor,
    build: build,
    groundKey: groundKey,
    get N() { return N; },
    MASTER_KEYS: Object.keys(MASTERS).map(function (k) { return 't_' + k; }),
    /* 内部能力，仅供 tools/_texture_preview.html 这类调参页面直接画贴图用 */
    _gen: genGround,
    _masters: MASTERS,
    _drawMaster: drawMaster
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = TEX; }
else { window.MYC = window.MYC || {}; window.MYC.TEX = TEX; }
