/* ============================================================================
 * WorldScene — 地图渲染与交互
 *
 * 必须写成 class extends Phaser.Scene。
 * 早期版本用普通对象字面量传给 Phaser，结果 Phaser 只把它当配置对象，
 * 自定义方法（drawSoil 等）没有挂到场景实例上，create() 里的输入监听、
 * graphics、悬停提示统统失效 —— 表现就是「点击地图完全没反应」。
 *
 * 渲染分三层，各自按需重绘：
 *   soilGfx  土壤（只在「已探明格子数」变化时重绘，680 格不该每帧重画）
 *   netGfx   菌丝网络与连线（每帧重绘，节点有生长弹出效果）
 *   flowGfx  沿路径流动的养分光点（用相位算位置，不需要粒子池）
 * ==========================================================================*/
(function () {
  'use strict';

  var C = window.MYC.CONFIG;
  var GRID = C.GRID;

  var COL = {
    unknown:  0x070907,
    gridLine: 0x141a14,
    myco:     0xf2f7ea,
    edge:     0xa8c99a,
    water:    0x5ec8e8,
    nutrient: 0xe8b45e,
    spore:    0xd977c0,
    candOk:   0x9fd08a,
    candNo:   0x4a5548,
    best:     0xffe9a8,
    core:     0xffd98a,
    rock:     0x2b2b31
  };

  /* 世界尺寸（游戏坐标）—— **随转生次数变化**，所以是方法不是常量。
   * 转生会当场换一张更大的图，缓存的尺寸立刻就是错的。 */
  function mapSize() {
    var st = window.MYC.game && window.MYC.game.state;
    return { w: (st && st.mapW) || GRID.W, h: (st && st.mapH) || GRID.H };
  }
  function worldW() { return GRID.OX * 2 + mapSize().w * GRID.CELL; }
  function worldH() { return GRID.OY * 2 + mapSize().h * GRID.CELL; }

  /* 当前可见的世界矩形（按场景自己维护的视野状态算，不读渲染阶段才更新的 worldView） */
  function viewRect() {
    var sc = window.MYC.game.scene;
    var z = sc.viewZoom || 1;
    var w = (sc.scale.width || worldW()) / z;
    var h = (sc.scale.height || worldH()) / z;
    return { left: sc.viewCx - w / 2, right: sc.viewCx + w / 2,
             top: sc.viewCy - h / 2, bottom: sc.viewCy + h / 2 };
  }

  /* 格子的屏幕尺寸上限（CSS px）：防止开局那几个格子被放大成马赛克。
   * 下限是「视野不小于已探明区域 ×0.85」（见 zoomLimits），不裁掉网络。 */
  var CELL_MAX_CSS = 46;

  function clampCenter(c, view, world) {
    if (view >= world) return world / 2;
    var half = view / 2;
    return Math.max(half, Math.min(world - half, c));
  }

  function cellPx(x) { return GRID.OX + x * GRID.CELL; }
  function cellPy(y) { return GRID.OY + y * GRID.CELL; }
  function centerX(x) { return cellPx(x) + GRID.CELL / 2; }
  function centerY(y) { return cellPy(y) + GRID.CELL / 2; }

  /* 每个格子稳定的颜色扰动，让土壤不像一整块死板的色板 */
  function soilShade(soilKey, x, y, seed) {
    var base = C.SOILS[soilKey].color;
    var j = 1 + (RNG.hash2(x, y, seed) - 0.5) * 0.30;
    var r = Math.min(255, Math.max(0, ((base >> 16) & 255) * j)) | 0;
    var g = Math.min(255, Math.max(0, ((base >> 8) & 255) * j)) | 0;
    var b = Math.min(255, Math.max(0, (base & 255) * j)) | 0;
    return (r << 16) | (g << 8) | b;
  }

  /* 用流量最大的那一项决定光点颜色 */
  function flowColor(v) {
    if (v.spore > v.nutrient && v.spore > v.water) return COL.spore;
    if (v.nutrient >= v.water) return COL.nutrient;
    return COL.water;
  }

  class WorldScene extends Phaser.Scene {
    constructor() {
      super('World');
      this.pops = {};            // nodeId -> 生长弹出强度
      this.hover = null;
    }

    create() {
      this.soilGfx = this.add.graphics();
      this.buffGfx = this.add.graphics();     // 事件增益区，压在网络下面
      this.candGfx = this.add.graphics();
      this.netGfx = this.add.graphics();
      this.flowGfx = this.add.graphics();
      this.gnatGfx = this.add.graphics();     // 害虫，盖在最上面才显眼

      this.lastKnown = -1;
      this.lastNodeCount = 0;
      this.autoSave = 0;
      this.frames = 0;           // 供自测判断主循环是否真的在跑
      this.floatPool = [];       // 浮动数字的对象池，避免每次 new Text

      this.tip = this.add.text(0, 0, '', {
        fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
        fontSize: '12px',
        color: '#e6ede2',
        backgroundColor: '#0d120d',
        padding: { x: 7, y: 5 }
      }).setDepth(50).setVisible(false);

      this.input.on('pointerdown', (p) => this.onDown(p));
      this.input.on('pointermove', (p) => this.onMove(p));
      this.input.on('pointerup', (p) => this.onUp(p));
      this.input.on('wheel', (p, objs, dx, dy) => this.onWheel(p, dy));

      /* 捏合缩放走原生 touch 事件，不依赖 Phaser 的多指指针管理：
       * 两指的触摸序列在不同环境下映射不一致，自己算两指距离最稳，也最好测。 */
      var cv = this.sys.game.canvas;
      cv.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
      cv.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
      cv.addEventListener('touchend', (e) => this.onTouchEnd(e));
      cv.addEventListener('touchcancel', (e) => this.onTouchEnd(e));

      this.cameras.main.setBackgroundColor('#060806');

      /* 自适应视野：画布尺寸随容器变（Scale.RESIZE），
       * 这里负责把世界按合适的缩放摆进画布。 */
      this.viewZoom = 1;
      this.viewCx = worldW() / 2;
      this.viewCy = worldH() / 2;
      /* 'auto'   跟着网络自动取景（默认，缓动）
       * 'manual' 用户自己缩放过/拖过，镜头交还给用户。
       * 一旦手动操作就必须停掉自动取景 —— 否则每帧的自动缓动会立刻把用户的操作顶回去，
       * 用起来像「镜头在跟你抢」。 */
      this.viewMode = 'auto';
      this.drag = null;           // 单指/鼠标拖拽状态
      this.pinch = null;          // 捏合过程中的上一帧参考值
      this.pinching = false;
      /* 捏合过程中按下的手指，它们的 pointerup 一律不算点击。
       * 关键：**不能用「时间窗」做这件事** —— 冷却走的是游戏时间，
       * rAF 一停（标签页切后台、headless 下帧稀疏）时间就不走了，
       * 400ms 的窗口永远不过期，用户回来之后怎么点都没反应（实测踩过）。 */
      this.pinchPtr = new Set();      // 捏合期间处于按下状态的指针
      this.suppressPtr = new Set();   // 等待其 pointerup 的被抑制指针
      this.dragSlop = 6;          // 位移超过这么多像素才算拖拽，而不是点击

      this.scale.on('resize', () => this.snapView(), this);
      this.snapView();

      /* 「回到自动取景」按钮：只在手动模式下显出来 */
      this.viewResetBtn = document.getElementById('viewReset');
      if (this.viewResetBtn) {
        this.viewResetBtn.addEventListener('click', () => this.resetView());
      }
      this.syncViewBtn();
      this.onMapChanged();      // 顺带初始化 seenMapW/H（也把各缓存归零）

      /* 手机上报「点了但没生效」多半是格子太小点偏了。
       * 触摸时给一点容差：精确格没东西可做，就找邻近一格。 */
      this.touchTolerance = this.sys.game.device.input.touch === true;
    }

    /* ------------------------------------------------------------ 视野自适应
     * 目标：已探明的区域 + 一点余量刚好铺满画布，同时
     *   · 不超过 CELL_MAX_CSS（否则开局几个格子撑满屏幕，很怪）
     *   · 不低于「已探明区域 ×0.85」的缩放（绝不裁掉网络的任何部分）
     */
    targetView() {
      var st = window.MYC.game.state;
      var m = mapSize();
      // 容器刚挂上时可能还是 0×0，退回世界尺寸，免得算出 NaN 缩放
      var availW = this.scale.width || worldW();
      var availH = this.scale.height || worldH();

      /* 已探明包围盒由 sim 的 reveal() 增量维护（state.explored），
       * 这里**绝不**全图扫描 —— 大地图上那是每帧几千次循环。 */
      var e = st.explored;
      var minX, maxX, minY, maxY;
      if (e && e.count > 0) {
        minX = e.minX; maxX = e.maxX; minY = e.minY; maxY = e.maxY;
      } else {
        minX = maxX = st.core.x;
        minY = maxY = st.core.y;
      }

      var pad = 2;
      var bw = (maxX - minX + 1 + pad * 2) * GRID.CELL;
      var bh = (maxY - minY + 1 + pad * 2) * GRID.CELL;
      var cx = (minX + maxX + 1) / 2 * GRID.CELL + GRID.OX;
      var cy = (minY + maxY + 1) / 2 * GRID.CELL + GRID.OY;

      // 画布可能被 CSS 缩放过（Fit 模式下），换算成真实的屏幕像素
      var ratio = (this.scale.displaySize.width / this.scale.width) || 1;

      var worldPxW = worldW(), worldPxH = worldH();
      var whole = Math.min(availW / worldPxW, availH / worldPxH); // 整张地图刚好装下
      var z = Math.min(availW / bw, availH / bh);                 // 装下「已探明 + 余量」
      z = Math.min(z, CELL_MAX_CSS / (GRID.CELL * ratio));
      /* 下限是「已探明区域装得下」（不裁网络），但允许比整张地图更小 ——
       * 地图现在会随转生变大，「必须看到整张图」会让后期格子小到没法点。 */
      z = Math.max(z, whole * 0.85);

      var viewW = availW / z, viewH = availH / z;
      return {
        zoom: z,
        cx: clampCenter(cx, viewW, worldPxW),
        cy: clampCenter(cy, viewH, worldPxH)
      };
    }

    /* 把缓动值对齐到目标（窗口尺寸变化时立刻跟上，不要看到漂移） */
    snapView() {
      if (this.viewMode === 'manual') {
        // 画布尺寸变了 → 合法范围也变了，把手动视野重新夹一遍（别把地图拖到画面外）
        this.setView(this.viewZoom, this.viewCx, this.viewCy);
        return;
      }
      var t = this.targetView();
      this.viewZoom = t.zoom;
      this.viewCx = t.cx;
      this.viewCy = t.cy;
      this.applyView();
    }

    applyView() {
      var cam = this.cameras.main;
      cam.setZoom(this.viewZoom);
      cam.centerOn(this.viewCx, this.viewCy);
    }

    /* --------------------------------------------------------------- 手动视野
     * 缩放范围：下限比「整张地图刚好装下」再放一点（方便看全局），
     * 上限约每格 2.4 倍（≈62px）—— 再大就只剩几个格子，没有意义。
     * 中心始终夹在世界内：拖动不能把地图拖出画面外就找不回来了。
     */
    zoomLimits() {
      var availW = this.scale.width || worldW();
      var availH = this.scale.height || worldH();
      var ww = worldW(), wh = worldH();
      var whole = Math.min(availW / ww, availH / wh);
      var ratio = (this.scale.displaySize.width / this.scale.width) || 1;
      return { min: whole * 0.85, max: Math.max(whole, 2.4 / ratio) };
    }

    setView(zoom, cx, cy) {
      var lim = this.zoomLimits();
      var availW = this.scale.width || worldW();
      var availH = this.scale.height || worldH();
      var z = Phaser.Math.Clamp(zoom, lim.min, lim.max);
      this.viewMode = 'manual';
      this.viewZoom = z;
      this.viewCx = clampCenter(cx, availW / z, worldW());
      this.viewCy = clampCenter(cy, availH / z, worldH());
      this.applyView();
      this.syncViewBtn();
    }

    /* 画布内部像素 → 世界坐标 */
    /* 画布内部像素 → 世界坐标。
     * 与 screenToWorldView 同一套换算 —— **不要**读 cam.worldView，
     * 那是渲染阶段才写的，缩放/拖动进行中会拿到旧一帧的值，
     * 滚轮和捏合的锚点就会飘（实测一次偏 30+ 世界单位）。 */
    toWorld(sx, sy) {
      return this.screenToWorldView(sx, sy);
    }

    /* 以屏幕上某点为锚点缩放：该点下面的世界坐标保持不动，手感才对 */
    zoomAtScreen(f, sx, sy) {
      var a = this.toWorld(sx, sy);
      var lim = this.zoomLimits();
      var z1 = Phaser.Math.Clamp(this.viewZoom * f, lim.min, lim.max);
      if (Math.abs(z1 - this.viewZoom) < 1e-6) return false;
      var k = this.viewZoom / z1;
      this.setView(z1, a.x + (this.viewCx - a.x) * k, a.y + (this.viewCy - a.y) * k);
      this.noteManual();
      return true;
    }

    /* 拖动平移：屏幕位移换算成世界位移，方向相反 */
    panBy(dxPx, dyPx) {
      var z = this.viewZoom || 1;
      this.setView(z, this.viewCx - dxPx / z, this.viewCy - dyPx / z);
    }

    /* 切到手动视野时提示一次 —— 否则用户会以为镜头「坏了，不跟着网络了」 */
    noteManual() {
      if (this.manualHinted) return;
      this.manualHinted = true;
      if (window.MYC.game.ui) {
        window.MYC.game.ui.toast('已切到手动视野，点右上角 ⟲ 回到自动取景');
      }
    }

    resetView() {
      this.viewMode = 'auto';
      this.syncViewBtn();
      if (window.MYC.game.ui) window.MYC.game.ui.toast('已回到自动取景');
    }

    syncViewBtn() {
      if (this.viewResetBtn) {
        this.viewResetBtn.classList.toggle('hidden', this.viewMode !== 'manual');
      }
    }

    /* DOM client 坐标 → 画布内部像素（自己算，不依赖 Phaser 的换算） */
    clientToCanvas(cx, cy) {
      var cv = this.sys.game.canvas, r = cv.getBoundingClientRect();
      return {
        x: (cx - r.left) * ((this.scale.width || r.width) / (r.width || 1)),
        y: (cy - r.top) * ((this.scale.height || r.height) / (r.height || 1))
      };
    }

    /* 每帧朝目标缓动。不直接跳变：网络扩张时视野缓缓拉开，观感好得多。
     * 手动模式下完全不碰镜头 —— 否则用户刚拖到的位置下一帧就被自动取景拽回去。 */
    easeView() {
      if (this.viewMode === 'manual') return;
      var t = this.targetView();
      var k = 0.12;
      this.viewZoom += (t.zoom - this.viewZoom) * k;
      this.viewCx += (t.cx - this.viewCx) * k;
      this.viewCy += (t.cy - this.viewCy) * k;
      this.applyView();
    }

    // ---------------------------------------------------------------- 输入
    /* 屏幕（画布内部像素）→ 世界坐标。
     *
     * 这里刻意**不**用 p.worldX / cam.worldView：那两个值由 Phaser 在渲染阶段
     * 写入，缩放或拖动进行中时读到的是旧一帧的矩阵，快速操作时点击会飘到
     * 别的格子上。场景自己的 viewZoom / viewCx / viewCy 是权威来源，
     * 每次手势都同步更新，永远和画面一致。
     */
    screenToWorldView(sx, sy) {
      var z = this.viewZoom || 1;
      var w = (this.scale.width || worldW()) / z;
      var h = (this.scale.height || worldH()) / z;
      return { x: this.viewCx - w / 2 + sx / z, y: this.viewCy - h / 2 + sy / z };
    }

    cellFromWorld(w) {
      var m = mapSize();
      var gx = Math.floor((w.x - GRID.OX) / GRID.CELL);
      var gy = Math.floor((w.y - GRID.OY) / GRID.CELL);
      if (gx < 0 || gy < 0 || gx >= m.w || gy >= m.h) return null;
      return { x: gx, y: gy };
    }

    cellFromPointer(p) {
      return this.cellFromWorld(this.screenToWorldView(p.x, p.y));
    }

    /* ---------------------------------------------------------------- 手势
     * 单指 / 鼠标：拖 = 平移，点 = 操作。
     * 「操作」必须放在**抬起**时判定 —— 如果按下就执行，拖动一下就会顺手长出一格。
     * 判定标准：位移不超过 dragSlop、没参与过捏合。
     */
    onDown(p) {
      // 这根手指是在捏合过程中按下的：它的抬起一律不算点击
      if (this.pinching) { this.pinchPtr.add(p.id); this.drag = null; return; }
      // 记下「按下的那一格」：抬起时按同一格执行。
      // 拖动过程中镜头会动，用抬起时的坐标去算会飘到旁边的格上。
      this.downCell = this.cellFromPointer(p);
      this.drag = {
        pointer: p, sx: p.x, sy: p.y, lx: p.x, ly: p.y,
        moved: 0
      };
    }

    onMove(p) {
      // 捏合期间镜头由原生 touch 处理器独占，这里别插手
      if (this.pinching) {
        this.drag = null; this.hover = null; this.tip.setVisible(false);
        return;
      }

      var d = this.drag;
      if (d && d.pointer === p) {
        var dx = p.x - d.lx, dy = p.y - d.ly;
        d.lx = p.x; d.ly = p.y;
        d.moved = Math.max(d.moved, Math.abs(p.x - d.sx), Math.abs(p.y - d.sy));
        if (d.moved > this.dragSlop) {
          this.panBy(dx, dy);
          this.hover = null;
          this.tip.setVisible(false);
          this.noteManual();
          return;
        }
      }
      this.showHover(p);
    }

    onUp(p) {
      var d = this.drag;
      this.drag = null;
      // 捏合期间按下/按住的手指：只清除标记，绝不当成点击
      if (this.suppressPtr.has(p.id)) { this.suppressPtr.delete(p.id); return; }
      if (!d || d.pointer !== p) return;
      if (d.moved > this.dragSlop) return;
      this.tapAt(this.downCell);
    }

    /* 滚轮缩放，以指针位置为锚点 */
    onWheel(p, dy) {
      if (!dy) return;
      var f = Math.pow(1.0018, -dy);               // 向上滚 = 放大
      if (this.zoomAtScreen(f, p.x, p.y)) this.noteManual();
    }

    /* ---- 捏合缩放 / 双指平移（原生 touch，理由见 create 里的注释）---- */
    onTouchStart(e) {
      if (e.touches.length < 2) return;
      this.pinching = true;
      this.pinch = null;
      this.drag = null;
      this.hover = null;
      this.tip.setVisible(false);
      // 现在按着的每根手指都算「捏合的手指」，它们的 up 都不作数
      var ps = this.input.manager.pointers || [];
      for (var i = 0; i < ps.length; i++) {
        if (ps[i].isDown) this.pinchPtr.add(ps[i].id);
      }
      if (e.cancelable) e.preventDefault();
    }

    onTouchMove(e) {
      if (e.touches.length < 2) return;
      if (e.cancelable) e.preventDefault();        // 别让浏览器去滚页面 / 缩页面
      var a = this.clientToCanvas(e.touches[0].clientX, e.touches[0].clientY);
      var b = this.clientToCanvas(e.touches[1].clientX, e.touches[1].clientY);
      var d = Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (!this.pinch) { this.pinch = { d: d, mx: mx, my: my }; return; }

      // 先按两指中点的位移平移，再按两指距离的变化缩放 —— 这是捏合的标准手感
      var moved = false;
      if (Math.abs(mx - this.pinch.mx) > 0.5 || Math.abs(my - this.pinch.my) > 0.5) {
        this.panBy(mx - this.pinch.mx, my - this.pinch.my);
        moved = true;
      }
      if (this.pinch.d > 4) {
        var f = d / this.pinch.d;
        if (Math.abs(f - 1) > 0.005) { this.zoomAtScreen(f, mx, my); moved = true; }
      }
      this.pinch.d = d; this.pinch.mx = mx; this.pinch.my = my;
      if (moved) this.noteManual();
    }

    onTouchEnd(e) {
      if (!this.pinching) return;
      if (e.touches.length >= 2) return;           // 还有两根以上，捏合继续
      this.pinching = false;
      this.pinch = null;
      // 这几个指针的 up 事件还没来（或刚来过），先记下来拦住
      var self = this;
      this.pinchPtr.forEach(function (id) { self.suppressPtr.add(id); });
      this.pinchPtr.clear();
    }

    /* 悬停提示（鼠标才看得见；手指挡着的地方不需要）。
     * pointermove 一秒能来上百次，所以同一格上只更新位置、不重建文本 ——
     * 否则每帧都在拼字符串 + 触发布局。 */
    showHover(p) {
      var w = this.screenToWorldView(p.x, p.y);
      var c = this.cellFromWorld(w);
      this.hover = c;
      var st = window.MYC.game.state;
      if (!c || !st) { this.tip.setVisible(false); this.hoverKey = ''; return; }

      var key = c.x + ',' + c.y;
      if (key === this.hoverKey && this.tip.visible) {
        this.tipP.x = w.x; this.tipP.y = w.y;      // 提示跟着指针走
        this.layoutTip();
        return;
      }
      this.hoverKey = key;

      var cell = st.grid[Sim.idx(c.x, c.y)];
      if (!cell.known) {
        this.showTip(p, '未探明 —— 让菌丝蔓延过去才能感知');
        return;
      }

      var soil = C.SOILS[cell.soil];
      var lines = [soil.name];
      if (soil.yield.water) lines.push('水 +' + soil.yield.water.toFixed(2) + '/s');
      if (soil.yield.nutrient) lines.push('养分 +' + soil.yield.nutrient.toFixed(2) + '/s');
      if (soil.yield.spore) lines.push('孢子 +' + soil.yield.spore.toFixed(2) + '/s');
      if (soil.solid) lines.push('无法生长');

      var cand = Sim.canGrowAt(st, c.x, c.y);
      if (cand) {
        lines.push('生长水耗 ' + cand.cost + '　离核 ' + cand.dist + ' 格');
        lines.push('运输效率 ' + (Sim.transportEfficiency(st, cand.dist) * 100).toFixed(0) + '%');
        var bf = Sim.buffAt(st, c.x, c.y);
        if (bf) {
          lines.push('★ 落在' + (bf.water > 1 ? '降雨带' : '孢子季') + '内，产出 ×' + C.EVENTS.buffMul);
        }
      } else if (cell.node != null) {
        var nd = st.nodes[cell.node];
        if (nd.blighted) {
          // 等级规则：绝对免疫线（Lv immuneLevel+）+ 源头只往下传（相对比较）。
          // 高位显示免疫的原因，而不是「防火墙是相对等级」那句老话。
          var blCap = Math.min(nd.level, C.BLIGHT.maxLevel);
          lines.push('⚠ 菌瘟蔓延中 —— 此格停产');
          lines.push('无法净化 —— 只能传给 Lv' + blCap + ' 及以下的邻居，比它高就挡得住');
          lines.push('约 ' + Math.ceil(nd.blighted.spreadT) + 's 后尝试传播；传得出去就一直烂下去');
          lines.push('连续 ' + C.BLIGHT.failLimit + ' 个周期被围死就熄灭，节点恢复健康');
        } else if (nd.gnat) {
          lines.push('⚠ 害虫占据中 —— 此格完全停产');
          lines.push('点击驱除，奖励 +' + C.EVENTS.gnatReward + ' 养分');
        } else if (nd.id === 0) {
          lines.push('核心 —— 整张网络都从它出发');
        } else {
          lines.push('菌丝 Lv' + nd.level + '　离核 ' + nd.dist + ' 格');
          /* 免疫线：这是玩家唯一能「练到就安全」的确定性承诺，
           * 所以必须在节点面板上给出精确等级，而不是含糊的「等级够高」。 */
          if (nd.level >= C.BLIGHT.immuneLevel) {
            lines.push('★ 已到免疫线 —— 菌瘟滋生不到、也传不进来');
          } else {
            lines.push('距免疫线还差 ' + (C.BLIGHT.immuneLevel - nd.level) + ' 级（练到 Lv' + C.BLIGHT.immuneLevel + ' 菌瘟就啃不动）');
          }
          if (nd.cargo > 0) lines.push('货物流量 ' + nd.cargo.toFixed(1) + '/s');
          /* 维持费：等级越高这项越大。写出来玩家才能算清
           * 「再多练一级」的真实代价 —— 不写的话降级会显得莫名其妙。 */
          var mc = Sim.maintainCostOf(st, nd);
          if (mc > 0) {
            lines.push('维持耗水 ' + mc.toFixed(2) + '/s（缺水时离核远的先掉级）');
          }
          var uc = Sim.nodeUpgradeCost(st, nd);
          lines.push(isFinite(uc)
            ? ('点击强化：' + uc + ' 养分 → Lv' + (nd.level + 1))
            : '这个节点已满级');
        }
      }
      this.showTip(w, lines.join('\n'));
    }

    /* 转生换图后由 UI / update() 的尺寸检测调用：
     * 地图尺寸/地形全变了，缓存与镜头都得重来。 */
    onMapChanged() {
      this.seenMapW = mapSize().w;
      this.seenMapH = mapSize().h;
      this.lastKnown = -1;
      this.lastSoilSig = null;
      this.lastNodeCount = 0;
      this.pops = {};
      this.hover = null;
      this.hoverKey = '';
      this.tip.setVisible(false);
      /* 新地图从自动取景开始 —— 镜头重新跟着网络走，不然玩家面对的是
         上一张图留下的视野，可能正对着一片空地。 */
      this.viewMode = 'auto';
      this.syncViewBtn();
    }

    showTip(w, text) {
      if (!this.tipP) this.tipP = { x: 0, y: 0 };
      this.tipP.x = w.x; this.tipP.y = w.y;
      this.tipText = text;
      this.tip.setVisible(true);
      this.layoutTip();
    }

    /* 提示框活在「世界」坐标系里，摄像机会把整个世界乘上缩放 ——
     * 所以要反过来缩 1/zoom，否则一放大提示就跟着变成巨字。
     * 缩放是缓动的、每帧都在变，所以布局**必须每帧重算**：
     * 只在 showTip 里算一次的话，一次放大动画就能把比例带偏（实测 0.93 而不是 1.0）。 */
    layoutTip() {
      if (!this.tip.visible || !this.tipP) return;
      // 同样只用场景自己的视野状态算边界 —— 不读渲染阶段才更新的 worldView
      var z = this.viewZoom || 1;
      var wv = (this.scale.width || worldW()) / z;
      var hv = (this.scale.height || worldH()) / z;
      var L = this.viewCx - wv / 2, T = this.viewCy - hv / 2;
      var R = L + wv, B = T + hv;
      if (this.tip.text !== this.tipText) this.tip.setText(this.tipText);
      this.tip.setScale(1 / z);
      var w = this.tip.width / z, h = this.tip.height / z;
      var off = 12 / z;
      var x = this.tipP.x + off, y = this.tipP.y + off;
      if (x + w > R) x = this.tipP.x - w - off;
      if (y + h > B) y = this.tipP.y - h - off;
      if (x < L) x = L;
      if (y < T) y = T;
      this.tip.setPosition(x, y);
    }

    /* 在某一格执行「点击」。返回 { ok, msg }：
     * ok=true 表示确实做了事；msg 是给玩家看的一句话（成功时的提示 / 失败时的原因）。
     * 抽出来是为了让触摸容差能依次试邻近格，同时保证只弹一次提示。 */
    tryAct(c) {
      var game = window.MYC.game;
      var st = game.state;
      var cell = st.grid[Sim.idx(c.x, c.y)];

      // 点已有菌丝 —— 这一格「不空」，于是点击有了第二种用途
      if (cell.node != null) {
        var nd = st.nodes[cell.node];

        if (nd.blighted) {                   // 菌瘟：不能净化 —— 应对靠围死与等级
          // 拒绝而不是顺手强化：点了没反应才是真的没写清楚
          return { ok: false, msg: '菌瘟净化不了 —— 把周边菌丝练到比它等级高，围死它 ' +
                  C.BLIGHT.failLimit + ' 个周期它就熄灭' };
        }
        if (nd.gnat) {                       // 有虫 → 驱除
          var rr = Sim.removeGnat(st, nd.id);
          if (rr.ok) {
            game.dirty = true;
            if (game.ui) game.ui.pushLog('驱除害虫，+' + rr.reward + ' 养分');
            return { ok: true, msg: '害虫已驱除' };
          }
          return { ok: false, msg: rr.reason };
        }
        if (nd.id === 0) {                   // 核心不可强化
          return { ok: false, msg: '核心是整张网络的根，不需要强化' };
        }
        var r = Sim.upgradeNode(st, nd.id);
        if (r.ok) {
          game.dirty = true;
          if (game.ui) game.ui.pushLog(C.SOILS[nd.soil].name + ' 强化到 Lv' + r.level + '（-' + r.cost + ' 养分）');
          return { ok: true, msg: '' };
        }
        return { ok: false, msg: r.reason };
      }

      var g = Sim.growAt(st, c.x, c.y);
      if (g.ok) {
        game.dirty = true;
        if (game.ui) game.ui.pushLog('蔓延一格（-' + g.cost + ' 水）');
        return { ok: true, msg: '' };
      }
      return { ok: false, msg: g.reason };
    }

    /* 在某一格执行一次「点击」。由 onUp 在确认是点击（而非拖拽/捏合）后调用，
     * 所以这里拿的是**按下那一格**的坐标，不是抬起坐标。 */
    tapAt(c) {
      var game = window.MYC.game;
      var st = game.state;
      if (!c || !st) return;

      var r = this.tryAct(c);
      if (r.ok) { if (game.ui && r.msg) game.ui.toast(r.msg); return; }

      /* 小屏上格子只有十几像素，手指点偏一格太常见了。
       * 触摸设备就按距离从近到远试一圈邻居 —— 鼠标不需要这层容差。 */
      if (this.touchTolerance) {
        var ring = [];
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            var tx = c.x + dx, ty = c.y + dy;
            var mp = mapSize();
            if (tx < 0 || ty < 0 || tx >= mp.w || ty >= mp.h) continue;
            ring.push({ x: tx, y: ty, d: dx * dx + dy * dy });
          }
        }
        ring.sort(function (a, b) { return a.d - b.d; });
        for (var i = 0; i < ring.length; i++) {
          var t = this.tryAct(ring[i]);
          if (t.ok) { if (game.ui && t.msg) game.ui.toast(t.msg); return; }
        }
      }
      if (game.ui) game.ui.toast(r.msg);
    }

    // ---------------------------------------------------------------- 循环
    update(time, delta) {
      var game = window.MYC.game;
      var st = game.state;
      if (!st) return;

      /* 转生会当场换一张（更大的）图：尺寸一变，地形缓存/已探明数/镜头全部重来。
       * 自己检测而不是指望 UI 记得通知 —— 读档、换种子这些路径同样会换图。 */
      if (st.mapW !== this.seenMapW || st.mapH !== this.seenMapH) {
        this.seenMapW = st.mapW; this.seenMapH = st.mapH;
        this.onMapChanged();
      }

      var dt = Math.min(delta / 1000, 0.25);
      this.frames++;

      Sim.tick(st, dt);

      this.autoSave += dt;
      if (this.autoSave > 15) { this.autoSave = 0; if (game.save) game.save(true); }

      // 新长出的节点弹一下 —— 「生长」的手感来源
      if (st.nodes.length !== this.lastNodeCount) {
        for (var i = this.lastNodeCount; i < st.nodes.length; i++) this.pops[i] = 1;
        this.lastNodeCount = st.nodes.length;
        game.dirty = true;
      }
      for (var k in this.pops) {
        this.pops[k] -= dt * 2.6;
        if (this.pops[k] <= 0) delete this.pops[k];
      }

      this.easeView();          // 视野跟着网络一起长，先更新再画
      this.layoutTip();         // 缩放变了，提示框的位置和反缩也要跟着重算

      this.drawSoil(st);
      this.drawBuff(st, time);
      this.drawCandidates(st);
      this.drawNetwork(st, time);
      this.drawFlow(st, time);
      this.drawGnats(st, time);
      this.drawFloaters(st);

      if (game.ui) game.ui.update(dt, game);
    }

    /* 事件增益区：降雨带（蓝）/ 孢子季（紫）。
     * 半透明大圆 + 呼吸边，快结束时加一圈闪烁提示，让你知道该抓紧了。 */
    drawBuff(st, time) {
      var g = this.buffGfx;
      g.clear();
      var pulse = 0.5 + 0.5 * Math.sin(time / 420);
      for (var i = 0; i < st.events.length; i++) {
        var e = st.events[i];
        if (e.kind === 'gnat' || e.kind === 'blight') continue;
        var col = (e.kind === 'rain') ? COL.water : COL.spore;
        var x = centerX(e.x), y = centerY(e.y), r = e.r * GRID.CELL;
        g.fillStyle(col, 0.09 + 0.05 * pulse);
        g.fillCircle(x, y, r);
        g.lineStyle(1.5, col, 0.32 + 0.34 * pulse);
        g.strokeCircle(x, y, r);
        if (e.ttl < 6) {
          g.lineStyle(2, col, 0.4 + 0.5 * Math.abs(Math.sin(time / 120)));
          g.strokeCircle(x, y, r * 0.82);
        }
      }
    }

    /* 害虫（红）与菌瘟（紫）：压在节点上的标记 —— 它们是唯二「必须回应」的东西。
     * 菌瘟会蔓延，所以加一圈**扩散倒计时环**：环走完它就往外爬一格。
     * 紧迫感必须来自可见的信息，而不是凭空觉得慌。 */
    drawGnats(st, time) {
      var g = this.gnatGfx;
      g.clear();
      if (!st.events.length) return;
      var pulse = 0.5 + 0.5 * Math.sin(time / 180);
      for (var i = 0; i < st.events.length; i++) {
        var e = st.events[i];
        if (e.kind === 'gnat') {
          var nd = st.nodes[e.nodeId];
          if (!nd) continue;
          var x = centerX(nd.x), y = centerY(nd.y), c = GRID.CELL;
          g.fillStyle(0xd0503a, 0.16 + 0.16 * pulse).fillCircle(x, y, c * 0.80);
          g.fillStyle(0x7a2a1c, 1).fillCircle(x, y, c * 0.34);
          g.fillStyle(0xe86a4a, 1).fillCircle(x, y, c * 0.20);
          g.lineStyle(2, 0xffb08a, 0.45 + 0.45 * pulse).strokeCircle(x, y, c * 0.46);
        } else if (e.kind === 'blight') {
          var bnd = st.nodes[e.nodeId];
          if (!bnd) continue;
          var bx = centerX(bnd.x), by = centerY(bnd.y), bc = GRID.CELL;
          var cfgB = C.BLIGHT;
          g.fillStyle(0x6b3fa0, 0.18 + 0.16 * pulse).fillCircle(bx, by, bc * 0.86);
          g.fillStyle(0x2c1745, 1).fillCircle(bx, by, bc * 0.36);
          g.fillStyle(0xa97bd6, 1).fillCircle(bx, by, bc * 0.19);
          // 扩散倒计时环：走满一圈就尝试往外爬一格
          var prog = 1 - Math.max(0, e.spreadT) / (cfgB.spreadInterval * (st.mods.blightSlow ? 1.6 : 1));
          g.lineStyle(1, 0xd0a8ff, 0.22).strokeCircle(bx, by, bc * 0.55);
          g.lineStyle(2.2, 0xd0a8ff, 0.9).beginPath();
          g.arc(bx, by, bc * 0.55, -Math.PI / 2, -Math.PI / 2 + Math.min(1, prog) * Math.PI * 2);
          g.strokePath();
        }
      }
    }

    /* 浮动数字：升级、酶解、孢子爆、驱虫都要有明确反馈。
     * 用对象池 + tween，别每次 new Text（会一直产生垃圾）。
     * 和提示框同理，字号与上浮距离都要按缩放反向补偿，屏幕上的观感才稳定。 */
    drawFloaters(st) {
      var z = this.cameras.main.zoom || 1;
      while (st.floaters.length) {
        var f = st.floaters.shift();
        var t = this.floatPool.pop();
        if (!t) {
          t = this.add.text(0, 0, '', {
            fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
            fontSize: '13px', fontStyle: 'bold', color: '#ffffff'
          }).setDepth(60).setOrigin(0.5);
        }
        var col = f.kind === 'nutrient' ? '#e8b45e' : (f.kind === 'spore' ? '#d977c0' : '#5ec8e8');
        t.setText(f.text).setColor(col)
         .setPosition(centerX(f.x), centerY(f.y))
         .setAlpha(1).setScale(1 / z).setVisible(true);
        this.tweens.add({
          targets: t, y: t.y - 28 / z, alpha: 0,
          duration: 1150, ease: 'Cubic.easeOut',
          onComplete: () => {
            t.setVisible(false);
            this.floatPool.push(t);
          }
        });
      }
    }

    // ---------------------------------------------------------------- 绘制
    /* 土壤层：只在「可见范围或已探明数」变化时重绘，且**只画可见窗口**。
     * 早期版本每次都全图重画 —— 34×20 没问题，地图随转生长大之后
     * 一万多个 fillRect 会造成明显的掉帧。 */
    drawSoil(st) {
      var m = mapSize();
      var v = viewRect();
      var pad = 1;
      var x0 = Math.max(0, Math.floor((v.left - GRID.OX) / GRID.CELL) - pad);
      var x1 = Math.min(m.w - 1, Math.ceil((v.right - GRID.OX) / GRID.CELL) + pad);
      var y0 = Math.max(0, Math.floor((v.top - GRID.OY) / GRID.CELL) - pad);
      var y1 = Math.min(m.h - 1, Math.ceil((v.bottom - GRID.OY) / GRID.CELL) + pad);
      var sig = x0 + ',' + y0 + ',' + x1 + ',' + y1 + ',' + st.explored.count;
      if (sig === this.lastSoilSig) return;
      this.lastSoilSig = sig;

      var g = this.soilGfx, cell = GRID.CELL;
      g.clear();
      for (var y = y0; y <= y1; y++) {
        for (var x = x0; x <= x1; x++) {
          var c = st.grid[Sim.idx(x, y)];
          var px = cellPx(x), py = cellPy(y);
          if (!c.known) {
            g.fillStyle(COL.unknown, 1);
          } else if (c.soil === 'rock') {
            g.fillStyle(COL.rock, 1);
          } else {
            g.fillStyle(soilShade(c.soil, x, y, st.seed), 1);
          }
          g.fillRect(px, py, cell, cell);
          if (c.known && c.soil === 'rock') {
            g.lineStyle(1, 0x3a3a42, 1).strokeRect(px + 2, py + 2, cell - 4, cell - 4);
          }
        }
      }
      g.lineStyle(1, COL.gridLine, 0.55);
      for (var x2 = x0; x2 <= x1 + 1; x2++) {
        var lx = GRID.OX + x2 * cell;
        g.beginPath(); g.moveTo(lx, GRID.OY + y0 * cell); g.lineTo(lx, GRID.OY + (y1 + 1) * cell); g.strokePath();
      }
      for (var y2 = y0; y2 <= y1 + 1; y2++) {
        var ly = GRID.OY + y2 * cell;
        g.beginPath(); g.moveTo(GRID.OX + x0 * cell, ly); g.lineTo(GRID.OX + (x1 + 1) * cell, ly); g.strokePath();
      }
    }

    /* 候选格提示。
     * 早期版本给每个候选格都描一圈边框，网络一大就有上百个描边，
     * 整个画面直接糊成一片白 —— 只能改成「小圆点 + 只强调一个推荐格」。 */
    drawCandidates(st) {
      var g = this.candGfx;
      g.clear();
      var cs = Sim.candidates(st);
      var best = Sim.bestCandidate(st);
      var pulse = 0.5 + 0.5 * Math.sin(this.time.now / 320);

      for (var i = 0; i < cs.length; i++) {
        var c = cs[i];
        if (st.res.water < c.cost) continue;          // 买不起就不提示
        g.fillStyle(COL.candOk, 0.34);
        g.fillCircle(centerX(c.x), centerY(c.y), 1.7);
      }

      if (best) {
        g.lineStyle(1.5, COL.best, 0.35 + 0.45 * pulse);
        g.strokeRect(cellPx(best.x) + 3, cellPy(best.y) + 3, GRID.CELL - 6, GRID.CELL - 6);
      }
      if (this.hover) {
        g.lineStyle(1.5, 0xffffff, 0.30);
        g.strokeRect(cellPx(this.hover.x) + 0.5, cellPy(this.hover.y) + 0.5, GRID.CELL - 1, GRID.CELL - 1);
      }
    }

    drawNetwork(st, time) {
      var g = this.netGfx;
      g.clear();

      // 连线：每个节点连到它的下一跳，整体向核心收拢成一棵树。
      // 保持纤细 —— 菌丝是丝，不是管子；画粗了会糊成一片。
      g.lineStyle(1.6, COL.edge, 0.34);
      for (var i = 1; i < st.nodes.length; i++) {
        var nd = st.nodes[i];
        if (nd.next < 0) continue;
        var p = st.nodes[nd.next];
        g.beginPath();
        g.moveTo(centerX(nd.x), centerY(nd.y));
        g.lineTo(centerX(p.x), centerY(p.y));
        g.strokePath();
      }

      var R = GRID.CELL * 0.30;
      for (var j = 0; j < st.nodes.length; j++) {
        var n = st.nodes[j];
        var pop = this.pops[n.id] || 0;
        var r = R * (1 + pop * 0.55);
        var x = centerX(n.x), y = centerY(n.y);

        if (n.id === 0) {
          var glow = 0.5 + 0.5 * Math.sin(time / 520);
          g.fillStyle(COL.core, 0.12 + 0.10 * glow).fillCircle(x, y, r * 2.4);
          g.fillStyle(COL.core, 1).fillCircle(x, y, r * 1.1);
        } else {
          if (pop > 0) g.fillStyle(COL.myco, 0.26 * pop).fillCircle(x, y, r * 2.0);
          // 节点颜色偏向它产出的资源，一眼能看出网络的资源分布
          var c0 = C.SOILS[n.soil].color;
          var tint = (((c0 >> 16 & 255) * 0.42 + 236 * 0.58) | 0) << 16
                   | (((c0 >> 8 & 255) * 0.42 + 242 * 0.58) | 0) << 8
                   | (((c0 & 255) * 0.42 + 230 * 0.58) | 0);
          g.fillStyle(tint, 1).fillCircle(x, y, r * 0.52);
          // 强化等级：套一圈暖色光环，等级越高越亮越大 —— 一眼看出深耕在哪
          if (n.level > 0) {
            var lv = Math.min(n.level, 10);
            g.lineStyle(1.4, COL.best, 0.26 + lv * 0.05);
            g.strokeCircle(x, y, r * (0.95 + lv * 0.055));
          }
        }
      }
    }

    /* 沿路径流动的养分光点。
     * 不建粒子池，用相位算位置：每帧一次计算，零对象分配。 */
    drawFlow(st, time) {
      var g = this.flowGfx;
      g.clear();
      var t = time / 1000;
      var drawn = 0;

      for (var i = 1; i < st.nodes.length && drawn < 420; i++) {
        var nd = st.nodes[i];
        if (nd.next < 0) continue;
        var cargo = (nd.through.nutrient || 0) + (nd.through.spore || 0)
                  + (nd.through.water || 0) * 0.08;
        if (cargo < 0.2) continue;

        var speed = Math.min(1.6, 0.28 + cargo * 0.02);
        var phase = ((t * speed) + nd.id * 0.37) % 1;
        if (phase < 0) phase += 1;
        var p = st.nodes[nd.next];
        var x = centerX(nd.x) + (centerX(p.x) - centerX(nd.x)) * phase;
        var y = centerY(nd.y) + (centerY(p.y) - centerY(nd.y)) * phase;

        g.fillStyle(flowColor(nd.through), 0.85);
        g.fillCircle(x, y, Math.min(2.4, 0.9 + cargo * 0.012));
        drawn++;
      }
    }
  }

  window.MYC.WorldScene = WorldScene;
})();
