/* 调参工具：评估自动蔓延解锁门槛（CONFIG.GROW.autoUnlockNodes）。
 *
 * 用法：
 *   node tools/tune_unlock.js              # 默认扫 0,60,80,100,120,150,200
 *   node tools/tune_unlock.js 250,300,400  # 指定候选门槛
 *   node tools/tune_unlock.js 250 --order  # 加看「解锁 vs 首次转生」的先后
 *
 * 模型：一个「中庸玩家」（1 次/秒点击、按顺序升级、回应事件、能转生就转生），
 * 记录每个门槛下：解锁发生在第几秒、转生几次、终局菌丝规模。
 * 门槛的意义：N 之前玩家只能手动点，N 之后才能挂机 ——
 * 所以「解锁时间」就是前期手点的时长上限；而转生数告诉你长期代价。
 * 当前 250 的依据：≤250 转生数全 5.0（零代价），300 开始曲线陡增。 */
'use strict';
const path = require('path');
const root = path.join(__dirname, '..');
const CONFIG = require(path.join(root, 'src', 'config.js'));
const Sim = require(path.join(root, 'src', 'sim.js'));

const SEEDS = [12345, 777, 20260917, 424242];
const DURATION = 1800, DT = 0.25;
const PRIORITY = ['autoGrow', 'growth', 'hydration', 'absorption', 'capacity', 'transport'];

function runOnce(seed, clicksPerSec) {
  const state = Sim.newGame(seed, {}, {});
  state.policy = 'nearest';
  let unlockT = null, firstPrT = null, prestiges = 0, lastNodes = 0;
  let clickTimer = 0;
  const clickInterval = clicksPerSec > 0 ? 1 / clicksPerSec : Infinity;

  for (let t = 0; t < DURATION; t += DT) {
    Sim.tick(state, DT);
    if (unlockT == null && state.autoGrow) unlockT = t;
    if (firstPrT == null && state.prestiges > 0) firstPrT = t;

    if (clickInterval !== Infinity) {
      clickTimer += DT;
      while (clickTimer >= clickInterval) {
        clickTimer -= clickInterval;
        const best = Sim.bestCandidate(state);
        if (!best || best.cost > state.res.water) break;
        if (!Sim.growAt(state, best.x, best.y).ok) break;
      }
    }

    for (const k of PRIORITY) Sim.buyUpgrade(state, k);

    for (let i = state.events.length - 1; i >= 0; i--) {
      const e = state.events[i];
      if (e.kind === 'gnat') Sim.removeGnat(state, e.nodeId);
      else if (e.kind === 'blight') Sim.removeBlight(state, e.nodeId);
    }

    if (Sim.canPrestige(state)) { if (Sim.doPrestige(state).ok) prestiges++; }
    lastNodes = state.nodes.length;
  }
  return { unlockT, firstPrT, prestiges, nodes: lastNodes };
}

/* ---- 主入口 ------------------------------------------------------------- */
const args = process.argv.slice(2);
const orderMode = args.includes('--order');
const Ns = (args.find(a => a !== '--order') || '0,60,80,100,120,150,200,250,300,400,500')
  .split(',').map(Number);

if (orderMode) {
  // 检查「解锁 vs 首次转生」的先后：若玩家能先转生，解锁进度会被清零重爬
  const N = Ns[0];
  CONFIG.GROW.autoUnlockNodes = N;
  console.log(`N=${N}  解锁 vs 第一次转生的先后（进度存 counters 时不该出现倒扣重爬）：`);
  for (let i = 0; i < SEEDS.length; i++) {
    const r = runOnce(SEEDS[i], 1);
    const u = r.unlockT == null ? '未解锁' : Math.round(r.unlockT) + 's';
    const p = r.firstPrT == null ? '未转生' : Math.round(r.firstPrT) + 's';
    console.log(`  种子 ${SEEDS[i]}: 解锁 ${u} | 首次转生 ${p} | 转生 ${r.prestiges} 次`);
  }
} else {
  console.log(`模拟 ${DURATION}s × ${SEEDS.length} 种子 × 步长 ${DT}s   （1 次/秒点击 + 回应事件）\n`);
  for (const N of Ns) {
    CONFIG.GROW.autoUnlockNodes = N;
    const rows = SEEDS.map(s => runOnce(s, 1));
    const unlocked = rows.filter(r => r.unlockT != null);
    const avgUnlock = unlocked.length
      ? unlocked.reduce((a, r) => a + r.unlockT, 0) / unlocked.length : NaN;
    const avgPr = rows.reduce((a, r) => a + r.prestiges, 0) / rows.length;
    const avgNodes = rows.reduce((a, r) => a + r.nodes, 0) / rows.length;
    const fmt = rows.map(r => (r.unlockT == null ? '✗' : Math.round(r.unlockT))).join('/');
    console.log(`N=${String(N).padStart(3)}  解锁: ${fmt}s` +
      (unlocked.length ? `  (均 ${Math.round(avgUnlock)}s ≈ ${Math.round(avgUnlock / 60)} 分)` : '') +
      `  | 转生 ${avgPr.toFixed(1)}  终局菌丝 ${avgNodes.toFixed(0)} 格`);
  }
}
