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

      this.input.on('pointermove', (p) => this.onMove(p));
      this.input.on('pointerdown', (p) => this.onClick(p));

      this.cameras.main.setBackgroundColor('#060806');
    }

    // ---------------------------------------------------------------- 输入
    cellFromPointer(p) {
      var gx = Math.floor((p.worldX - GRID.OX) / GRID.CELL);
      var gy = Math.floor((p.worldY - GRID.OY) / GRID.CELL);
      if (gx < 0 || gy < 0 || gx >= GRID.W || gy >= GRID.H) return null;
      return { x: gx, y: gy };
    }

    onMove(p) {
      var c = this.cellFromPointer(p);
      this.hover = c;
      var st = window.MYC.game.state;
      if (!c || !st) { this.tip.setVisible(false); return; }

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
        if (nd.gnat) {
          lines.push('⚠ 害虫占据中 —— 此格完全停产');
          lines.push('点击驱除，奖励 +' + C.EVENTS.gnatReward + ' 养分');
        } else if (nd.id === 0) {
          lines.push('核心 —— 整张网络都从它出发');
        } else {
          lines.push('菌丝 Lv' + nd.level + '　离核 ' + nd.dist + ' 格');
          if (nd.cargo > 0) lines.push('货物流量 ' + nd.cargo.toFixed(1) + '/s');
          var uc = Sim.nodeUpgradeCost(st, nd);
          lines.push(isFinite(uc)
            ? ('点击强化：' + uc + ' 养分 → Lv' + (nd.level + 1))
            : '这个节点已满级');
        }
      }
      this.showTip(p, lines.join('\n'));
    }

    showTip(p, text) {
      this.tip.setText(text).setPosition(p.worldX + 14, p.worldY + 12).setVisible(true);
      if (this.tip.x + this.tip.width > this.scale.width - 4) this.tip.x = p.worldX - this.tip.width - 12;
      if (this.tip.y + this.tip.height > this.scale.height - 4) this.tip.y = p.worldY - this.tip.height - 12;
    }

    onClick(p) {
      var c = this.cellFromPointer(p);
      var game = window.MYC.game;
      var st = game.state;
      if (!c || !st) return;

      var cell = st.grid[Sim.idx(c.x, c.y)];

      // 点已有菌丝 —— 这一格「不空」，于是点击有了第二种用途
      if (cell.node != null) {
        var nd = st.nodes[cell.node];

        if (nd.gnat) {                       // 有虫 → 驱除
          var rr = Sim.removeGnat(st, nd.id);
          if (rr.ok) {
            game.dirty = true;
            if (game.ui) { game.ui.pushLog('驱除害虫，+' + rr.reward + ' 养分'); game.ui.toast('害虫已驱除'); }
          } else if (game.ui) game.ui.toast(rr.reason);
          return;
        }
        if (nd.id === 0) {                   // 核心不可强化
          if (game.ui) game.ui.toast('核心是整张网络的根，不需要强化');
          return;
        }
        var r = Sim.upgradeNode(st, nd.id);
        if (r.ok) {
          game.dirty = true;
          if (game.ui) game.ui.pushLog(C.SOILS[nd.soil].name + ' 强化到 Lv' + r.level + '（-' + r.cost + ' 养分）');
        } else if (game.ui) {
          game.ui.toast(r.reason);
        }
        return;
      }

      var g = Sim.growAt(st, c.x, c.y);
      if (g.ok) {
        game.dirty = true;
        if (game.ui) game.ui.pushLog('蔓延一格（-' + g.cost + ' 水）');
      } else if (game.ui) {
        game.ui.toast(g.reason);
      }
    }

    // ---------------------------------------------------------------- 循环
    update(time, delta) {
      var game = window.MYC.game;
      var st = game.state;
      if (!st) return;
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
        if (e.kind === 'gnat') continue;
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

    /* 害虫：压在节点上的红色标记，闪烁提醒 —— 它是唯一「必须回应」的东西 */
    drawGnats(st, time) {
      var g = this.gnatGfx;
      g.clear();
      if (!st.events.length) return;
      var pulse = 0.5 + 0.5 * Math.sin(time / 180);
      for (var i = 0; i < st.events.length; i++) {
        var e = st.events[i];
        if (e.kind !== 'gnat') continue;
        var nd = st.nodes[e.nodeId];
        if (!nd) continue;
        var x = centerX(nd.x), y = centerY(nd.y), c = GRID.CELL;
        g.fillStyle(0xd0503a, 0.16 + 0.16 * pulse).fillCircle(x, y, c * 0.80);
        g.fillStyle(0x7a2a1c, 1).fillCircle(x, y, c * 0.34);
        g.fillStyle(0xe86a4a, 1).fillCircle(x, y, c * 0.20);
        g.lineStyle(2, 0xffb08a, 0.45 + 0.45 * pulse).strokeCircle(x, y, c * 0.46);
      }
    }

    /* 浮动数字：升级、酶解、孢子爆、驱虫都要有明确反馈。
     * 用对象池 + tween，别每次 new Text（会一直产生垃圾）。 */
    drawFloaters(st) {
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
         .setAlpha(1).setScale(1).setVisible(true);
        this.tweens.add({
          targets: t, y: t.y - 28, alpha: 0,
          duration: 1150, ease: 'Cubic.easeOut',
          onComplete: () => {
            t.setVisible(false);
            this.floatPool.push(t);
          }
        });
      }
    }

    // ---------------------------------------------------------------- 绘制
    drawSoil(st) {
      var known = 0;
      for (var i = 0; i < st.grid.length; i++) if (st.grid[i].known) known++;
      if (known === this.lastKnown) return;
      this.lastKnown = known;

      var g = this.soilGfx, cell = GRID.CELL;
      g.clear();
      for (var y = 0; y < GRID.H; y++) {
        for (var x = 0; x < GRID.W; x++) {
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
      for (var x2 = 0; x2 <= GRID.W; x2++) {
        var lx = GRID.OX + x2 * cell;
        g.beginPath(); g.moveTo(lx, GRID.OY); g.lineTo(lx, GRID.OY + GRID.H * cell); g.strokePath();
      }
      for (var y2 = 0; y2 <= GRID.H; y2++) {
        var ly = GRID.OY + y2 * cell;
        g.beginPath(); g.moveTo(GRID.OX, ly); g.lineTo(GRID.OX + GRID.W * cell, ly); g.strokePath();
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
