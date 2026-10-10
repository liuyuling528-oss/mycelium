/* ============================================================================
 * ambient.js — 动效层：让世界「活」起来的环境粒子
 *
 * 全部用 graphics 逐帧绘制（无 Text/无 Sprite，对象是轻量数据），
 * 粒子总量硬封顶，性能不随网络规模失控：
 *   · 环境孢子：已探明区域里缓缓漂浮的微光，密度随网络规模（上限 48）
 *   · 增益区粒子：rain 飘落 / bloom 荧光 / flush 上升气泡，每区 ≤10
 *   · 核心喷发：核心持续冒出的上升渐陨光点（≤14）
 *   · 转生扩散环：换档/换图时从核心荡开的光环（纯表现，不参与逻辑）
 *
 * 粒子全部是世界坐标（与 screenToWorldView 同一套换算由 WorldScene 提供），
 * 只在 fxGfx 一层画，不遮挡节点与连线。
 * ==========================================================================*/
var AMB = (function () {
  'use strict';

  var MAX_MOTES = 48;
  var MAX_CORE = 14;
  var MAX_ZONE_PER = 10;

  function create() {
    return {
      motes: [],        // 环境孢子 {x,y,vx,vy,ph,r,c}
      coreP: [],        // 核心喷发 {x,y,vy,life,max,r}
      zoneP: [],        // 增益区粒子 {zx,y, x,y,vx,vy,life,max,r,c,kind}
      rings: [],        // 转生扩散环 {t0}
      motesSynced: 0    // 上次按网络规模调整粒子数的节点数
    };
  }

  /* 网络规模变化时增减环境孢子（只增不减到下限，避免闪断） */
  function syncMotes(a, st, rnd) {
    var want = Math.min(MAX_MOTES, Math.floor(st.nodes.length / 6) + 6);
    if (st.nodes.length === a.motesSynced) return;
    a.motesSynced = st.nodes.length;
    while (a.motes.length > want) a.motes.pop();
    while (a.motes.length < want) {
      var nd = st.nodes[(rnd() * st.nodes.length) | 0];
      a.motes.push({
        x: nd.x + (rnd() - 0.5) * 3,
        y: nd.y + (rnd() - 0.5) * 3,
        vx: (rnd() - 0.5) * 0.22,
        vy: (rnd() - 0.5) * 0.22 - 0.04,
        ph: rnd() * Math.PI * 2,
        r: 0.9 + rnd() * 1.4,
        c: rnd()
      });
    }
  }

  /* 每帧驱动 + 绘制。g = fxGfx；W2S(worldX, worldY) -> {x,y} 屏幕像素；
   * dt 秒；time 毫秒；CELL 格的屏幕像素尺寸 */
  function draw(a, g, st, dt, time, W2S, CELL) {
    var rnd = Math.random;

    /* ---- 环境孢子 ---- */
    syncMotes(a, st, rnd);
    for (var i = 0; i < a.motes.length; i++) {
      var m = a.motes[i];
      m.x += m.vx * dt; m.y += m.vy * dt;
      /* 越界（漂出已探明区太远）就从某个节点重新安置，而不是堆积在边缘 */
      var nd = st.nodes[(rnd() * st.nodes.length) | 0];
      if (m.x < -2 || m.y < -2 || m.x > st.mapW + 2 || m.y > st.mapH + 2) {
        m.x = nd.x + (rnd() - 0.5) * 3; m.y = nd.y + (rnd() - 0.5) * 3;
      }
      var tw = 0.5 + 0.5 * Math.sin(time / 700 + m.ph);
      var p = W2S(m.x, m.y);
      if (!p) continue;
      g.fillStyle(m.c > 0.5 ? 0xf2f7ea : 0xc8e8d0, 0.10 + 0.22 * tw);
      g.fillCircle(p.x, p.y, m.r * (CELL / 26));
    }

    /* ---- 核心喷发 ---- */
    if (a.coreP.length < MAX_CORE && rnd() < dt * 3.2) {
      var core = st.nodes[0];
      a.coreP.push({
        x: core.x + (rnd() - 0.5) * 0.6,
        y: core.y + (rnd() - 0.5) * 0.4,
        vy: -(0.25 + rnd() * 0.3),
        life: 0, max: 1.4 + rnd() * 0.8,
        r: 1 + rnd() * 1.6
      });
    }
    for (var j = a.coreP.length - 1; j >= 0; j--) {
      var q = a.coreP[j];
      q.life += dt; q.y += q.vy * dt;
      if (q.life >= q.max) { a.coreP.splice(j, 1); continue; }
      var k = 1 - q.life / q.max;
      var pq = W2S(q.x, q.y);
      if (!pq) continue;
      g.fillStyle(0xffd98a, 0.34 * k);
      g.fillCircle(pq.x, pq.y, q.r * (CELL / 26) * (0.6 + 0.4 * k));
    }

    /* ---- 增益区粒子 ---- */
    var zones = [];
    for (var z = 0; z < st.events.length; z++) {
      var e = st.events[z];
      if (e.kind === 'rain' || e.kind === 'bloom' || e.kind === 'flush' || e.kind === 'spore') zones.push(e);
    }
    /* 粒子按区配额补齐 / 多余的裁掉 */
    while (a.zoneP.length > zones.length * MAX_ZONE_PER) a.zoneP.pop();
    for (var zi = 0; zi < zones.length; zi++) {
      var zn = zones[zi];
      var mine = 0;
      for (var c2 = 0; c2 < a.zoneP.length; c2++) if (a.zoneP[c2].zx === zn) mine++;
      if (mine < MAX_ZONE_PER && rnd() < dt * 8) {
        var ang = rnd() * Math.PI * 2;
        var rad = Math.sqrt(rnd()) * zn.radius;
        var col = zn.kind === 'rain' ? 0x5ec8e8 : zn.kind === 'flush' ? 0xe8b45e : 0xd977c0;
        a.zoneP.push({
          zx: zn,
          x: zn.x + Math.cos(ang) * rad,
          y: zn.y + Math.sin(ang) * rad,
          vx: zn.kind === 'rain' ? 0 : (rnd() - 0.5) * 0.3,
          vy: zn.kind === 'rain' ? 1.1 + rnd() * 0.8 : zn.kind === 'flush' ? -(0.4 + rnd() * 0.4) : (rnd() - 0.5) * 0.24,
          life: 0, max: 1.6 + rnd() * 1.4, r: 0.8 + rnd() * 1.2, c: col
        });
      }
    }
    for (var w = a.zoneP.length - 1; w >= 0; w--) {
      var pz = a.zoneP[w];
      if (zones.indexOf(pz.zx) < 0) { a.zoneP.splice(w, 1); continue; }   // 区过期了
      pz.life += dt; pz.x += pz.vx * dt; pz.y += pz.vy * dt;
      /* 雨滴落出区底就消失；其它飘出圈也逐渐回收 */
      if (pz.life >= pz.max) { a.zoneP.splice(w, 1); continue; }
      var kk = 1 - pz.life / pz.max;
      var pp = W2S(pz.x, pz.y);
      if (!pp) continue;
      g.fillStyle(pz.c, 0.30 * kk);
      g.fillCircle(pp.x, pp.y, pz.r * (CELL / 26));
    }

    /* ---- 转生扩散环 ---- */
    for (var r2 = a.rings.length - 1; r2 >= 0; r2--) {
      var rg = a.rings[r2];
      var age = (time - rg.t0) / 900;
      if (age >= 1) { a.rings.splice(r2, 1); continue; }
      if (age < 0) { a.rings.splice(r2, 1); continue; }   // 时钟倒挂（虚拟时间快进等）直接丢弃
      var pc = W2S(rg.x, rg.y);
      if (!pc) continue;
      var ease = 1 - Math.pow(1 - age, 2.2);
      g.lineStyle(2.4, rg.c != null ? rg.c : 0xffe9a8, 0.55 * (1 - age));
      g.strokeCircle(pc.x, pc.y, CELL * (0.6 + ease * 7));
    }
  }

  return { create: create, draw: draw };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = AMB; }
else { window.MYC = window.MYC || {}; window.MYC.AMB = AMB; }
