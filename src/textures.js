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

  /* 元胞自动机平滑：邻域（含自身）取平均，迭代 iterations 轮。
   * keepDir = 'y' 时只沿 y 向平均 —— 木纹这类**方向性纹理**用它消除横向噪点、
   * 保留竖条纹。平滑把「乱七八糟的噪点」收敛成有机的连贯明暗团块。 */
  function caSmooth(f, n, iterations, keepDir) {
    for (var it = 0; it < iterations; it++) {
      var nf = new Array(n);
      for (var y = 0; y < n; y++) {
        nf[y] = new Array(n);
        for (var x = 0; x < n; x++) {
          if (keepDir === 'y') {
            var a = f[y][x];
            var b = f[Math.max(0, y - 1)][x];
            var c2 = f[Math.min(n - 1, y + 1)][x];
            nf[y][x] = (a * 2 + b + c2) / 4;      // 本格权重高一点，条纹不至于被磨平
          } else {
            var sum = 0, cnt = 0;
            for (var dy = -1; dy <= 1; dy++) {
              for (var dx = -1; dx <= 1; dx++) {
                var yy = Math.min(n - 1, Math.max(0, y + dy));
                var xx = Math.min(n - 1, Math.max(0, x + dx));
                sum += f[yy][xx]; cnt++;
              }
            }
            nf[y][x] = sum / cnt;
          }
        }
      }
      f = nf;
    }
    return f;
  }

  /* 平滑会把值域往中间压（多轮平均的必然代价）—— 重新拉伸回 0..1，
   * 色阶才有全幅度。没有这一步，4 档色阶会塌成 1 档「死平」。 */
  function normalizeField(f, n) {
    var mn = Infinity, mx = -Infinity;
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (f[y][x] < mn) mn = f[y][x];
        if (f[y][x] > mx) mx = f[y][x];
      }
    }
    if (mx - mn < 1e-6) return f;
    for (var y2 = 0; y2 < n; y2++) {
      for (var x2 = 0; x2 < n; x2++) f[y2][x2] = (f[y2][x2] - mn) / (mx - mn);
    }
    return f;
  }

  /* 平滑场 → 4 档量化色阶。像素风要的是**有限色阶**：
   * 连续明暗会显得糊，量化后每一档都是清晰可数的颜色块。 */
  function rampShade(base, v) {
    var steps = [0.82, 0.94, 1.06, 1.17];
    var idx = Math.max(0, Math.min(3, (v * 4) | 0));
    return shade(base, steps[idx]);
  }

  function genGround(type, n, variant) {
    var base = GROUND_BASE[type];
    var seed = 1000 + variant * 7919;

    /* ① 原始噪声场（图案坐标密度无关 —— 密度越高同一图案越精细） */
    var f = [];
    for (var y = 0; y < n; y++) {
      var row = new Array(n);
      for (var x = 0; x < n; x++) {
        var fu = x / n, fv = y / n;
        var v;
        if (type === 'wood') {
          v = RNG.fbm(fu * 9, fv * 1.6, seed, 2);                       // 竖向木纹
        } else if (type === 'vein') {
          var ripple = Math.sin((fv * 5.2 + RNG.fbm(fu * 3, fv * 3, seed, 2) * 1.6) * Math.PI);
          v = ripple * 0.5 + 0.5;                                       // 波纹带
        } else if (type === 'litter') {
          v = RNG.fbm(fu * 4, fv * 4, seed, 3);
        } else {
          v = RNG.fbm(fu * 4, fv * 4, seed, 3);
        }
        row[x] = v;
      }
      f.push(row);
    }

    /* ② 元胞自动机平滑（木纹只沿 y 向；其余各向同性 3 轮） */
    f = caSmooth(f, n, type === 'wood' ? 2 : 3, type === 'wood' ? 'y' : null);
    f = normalizeField(f, n);

    /* ③ 场值 → 色阶，再叠**低对比结构特征**（结构性笔触，不是散噪点） */
    var px = [];
    var walk = null;
    if (type === 'root') {
      walk = [];
      var rr = RNG.makeRng(seed ^ 0x5eed);
      var wx = (rr() * n) | 0, wy = (rr() * n) | 0;
      for (var s2 = 0; s2 < n * 3; s2++) {
        walk.push([wx, wy]);
        wx = Math.max(0, Math.min(n - 1, wx + ((rr() * 3) | 0) - 1));
        wy = Math.max(0, Math.min(n - 1, wy + ((rr() * 3) | 0) - 1));
      }
    }
    /* 叶斑的第二张场：高频噪声 + CA 收敛 → 碎叶成「簇」而不是满天星 */
    var fleck = null;
    if (type === 'litter') {
      var ff = [];
      for (var ly = 0; ly < n; ly++) {
        var lrow = new Array(n);
        for (var lx = 0; lx < n; lx++) lrow[lx] = RNG.fbm((lx / n) * 7, (ly / n) * 7, seed + 31, 2);
        ff.push(lrow);
      }
      fleck = caSmooth(ff, n, 2, null);
      fleck = normalizeField(fleck, n);
    }

    for (var y2 = 0; y2 < n; y2++) {
      var prow = new Array(n);
      for (var x2 = 0; x2 < n; x2++) {
        var v2 = f[y2][x2];
        var c = rampShade(base, v2);
        if (type === 'litter' && fleck[y2][x2] > 0.62) c = shade(c, 1.13);   // 叶斑簇
        if (type === 'wood' && v2 > 0.62) c = shade(c, 1.14);                // 木质亮纹
        if (type === 'vein' && v2 > 0.72) c = shade(c, 1.30);                // 波峰高光
        prow[x2] = c;
      }
      px.push(prow);
    }

    /* ④ 结构性笔触（形状特征，保留锐利轮廓） */
    if (type === 'root' && walk) {
      for (var i = 0; i < walk.length; i++) {
        var wx2 = walk[i][0], wy2 = walk[i][1];
        px[wy2][wx2] = shade(base, 0.55);               // 根须暗线
        if (i % 3 === 0 && wy2 > 0) px[wy2 - 1][wx2] = shade(base, 1.30);
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
      for (var e2 = 0; e2 < n; e2++) {                  // 边缘棱角
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
