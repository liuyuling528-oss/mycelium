/* 临时实验：评估自动蔓延解锁的节点门槛。用完即删。
 *
 * 对每个候选门槛 N，模拟一个「中庸玩家」（1 次/秒点击、按顺序升级、回应事件），
 * 记录：解锁发生在第几秒、30 分钟内转生几次、终局菌丝规模。
 * 门槛的意义：N 之前玩家只能手动点，N 之后才能挂机 ——
 * 所以「解锁时间」就是前期手点的时长上限。 */
'use strict';
const path = require('path');
const root = path.join('C:', 'Users', 'yicai', 'Desktop', 'mycelium-idle');
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

  const N = process.argv[2] ? Number(process.argv[2].split(',')[0]) : 250;
  CONFIG.GROW.autoUnlockNodes = N;
  const rows = SEEDS.map(s => runOnce(s, 1));
  console.log(`N=${N}  解锁 vs 第一次转生的先后顺序：`);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const u = r.unlockT == null ? '未解锁' : Math.round(r.unlockT) + 's';
    const p = r.firstPrT == null ? '未转生' : Math.round(r.firstPrT) + 's';
    const order = (r.unlockT != null && r.firstPrT != null)
      ? (r.unlockT < r.firstPrT ? '解锁在前 ✓' : '⚠ 先转生了（解锁进度清零重来）')
      : '';
    console.log(`  种子 ${SEEDS[i]}: 解锁 ${u} | 首次转生 ${p} | ${order} | 转生 ${r.prestiges} 次`);
  }
