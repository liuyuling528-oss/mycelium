/* 敌菌镜像经济探针：实测新经济下敌菌的成长曲线（不是平衡回归，是机制冒烟） */
'use strict';
const path = require('path');
const Sim = require(path.join(__dirname, '..', 'src', 'sim.js'));
const CONFIG = require(path.join(__dirname, '..', 'src', 'config.js'));

function probe(seed, diff, label, grant) {
  const st = Sim.newGame(seed, {}, {}, 0, 0, diff);
  if (grant != null) st.enemyRes = grant;
  const marks = [60, 120, 180, 240, 300, 420, 600];
  let mi = 0;
  const rows = [];
  for (let t = 0; t <= 600; t += 1) {
    if (mi < marks.length && t >= marks[mi]) {
      const en = st.enemy;
      const soils = {};
      if (en) en.cells.forEach(c => {
        const s = st.grid[c[1] * st.mapW + c[0]].soil;
        soils[s] = (soils[s] || 0) + 1;
      });
      rows.push(`t=${t} cells=${en ? en.cells.length : 0} res=${Math.round(st.enemyRes || 0)} ` +
        `spore=${(st.enemySpore || 0).toFixed(1)}(${(st.enemySporeRate || 0).toFixed(2)}/s) ` +
        `soils=${JSON.stringify(soils)}${st.lost ? ' LOST@' + st.lost.at : ''}`);
      mi++;
    }
    Sim.tick(st, 1);
  }
  console.log(`\n== ${label} (seed ${seed}, diff ${diff}, grant ${grant}) ==`);
  rows.forEach(r => console.log('  ' + r));
}

probe(90210, 3, '自测种子·困难', null);
probe(90210, 3, '自测种子·困难+500', 500);
probe(555001, 4, '魔鬼', 500);
probe(555001, 1, '简单', 500);
