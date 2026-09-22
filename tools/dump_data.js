/* ============================================================================
 * dump_data.js —— 把「所有数据」导成一张表
 *
 * 为什么用 Node 而不是正则解析：CONFIG 是**可执行的** JS，
 * 直接 require 拿到的是运行时真实值（例如 100/49 会被算成 2.0408），
 * 正则只能拿到字面量（"100 / 49" 一个字符串），做不了校验也算不了派生量。
 *
 * 输出两份：
 *   docs/数据总表.csv   —— 全部数值参数（给人和 Excel 看）
 *   docs/数据总表.md    —— 同一份数据的 Markdown 版（直接进 git，方便 diff）
 *
 * 用法： node tools/dump_data.js
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = path.dirname(__dirname);
const CONFIG = require(path.join(BASE, 'src', 'config.js'));

/* ---------------------------------------------------------------- 工具 */

// CSV 转义：含逗号/引号/换行的字段必须包起来
function q(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function round(v, n) {
  if (typeof v !== 'number' || !isFinite(v)) return v;
  const m = Math.pow(10, n == null ? 4 : n);
  return Math.round(v * m) / m;
}

/* 数值参数表：分组 → 名称 → 值 → 单位 → 说明
 * 「来源」列写它在 config.js 里的哪个块，方便回溯。 */
const rows = [];
function add(group, name, value, unit, note, src) {
  rows.push({
    group: group,
    name: name,
    value: value,
    unit: unit || '',
    note: note || '',
    src: src || group
  });
}

/* ---------------------------------------------------------- 1. 地图 */
add('地图', 'GRID.W', CONFIG.GRID.W, '格', '初始地图宽', 'GRID');
add('地图', 'GRID.H', CONFIG.GRID.H, '格', '初始地图高', 'GRID');
add('地图', 'GRID.CELL', CONFIG.GRID.CELL, 'px', '每格像素边长', 'GRID');
add('地图', 'GRID.OX', CONFIG.GRID.OX, 'px', '绘制原点 X 偏移', 'GRID');
add('地图', 'GRID.OY', CONFIG.GRID.OY, 'px', '绘制原点 Y 偏移', 'GRID');
add('地图', '初始总格数', CONFIG.GRID.W * CONFIG.GRID.H, '格', 'W×H（派生）', 'GRID');

/* 地图尺寸随转生的增长：mapSizeFor(prestiges) 的规则 */
add('地图', '转生边长增幅', 0.12, '倍/次', '每转生一次边长 +12%', 'sim.mapSizeFor');
add('地图', '转生边长上限', 2.0, '倍', '边长最多 2×（面积 4×）', 'sim.mapSizeFor');
add('地图', '上限对应格数', CONFIG.GRID.W * 2 * CONFIG.GRID.H * 2, '格',
  '68×40（派生，面积是初始 4 倍）', 'sim.mapSizeFor');

/* ------------------------------------------------- 2. 基质（每格产出） */
Object.keys(CONFIG.SOILS).forEach(function (k) {
  const s = CONFIG.SOILS[k];
  const y = s.yield || {};
  const parts = [];
  if (y.water) parts.push('水 ' + y.water);
  if (y.nutrient) parts.push('养分 ' + y.nutrient);
  if (y.spore) parts.push('孢子 ' + y.spore);
  add('基质', s.name + '.' + k, parts.length ? parts.join(' + ') + ' /s' : '无产出',
    '/s', '生长水耗 ' + s.growCost + (s.solid ? '，不可生长' : ''), 'SOILS');
  if (y.water) add('基质产出', s.name + '→水', y.water, '/s/格', '', 'SOILS');
  if (y.nutrient) add('基质产出', s.name + '→养分', y.nutrient, '/s/格', '', 'SOILS');
  if (y.spore) add('基质产出', s.name + '→孢子', y.spore, '/s/格', '', 'SOILS');
  add('基质', s.name + '.growCost', s.growCost, '水', '连这一格的水耗基数', 'SOILS');
});

/* ------------------------------------------------------ 3. 地图生成 */
Object.keys(CONFIG.GEN).forEach(function (k) {
  const v = CONFIG.GEN[k];
  add('地图生成', 'GEN.' + k, v, typeof v === 'number' && v < 1 ? '阈值' : '个/块',
    k === 'rootBlobsNear' ? '核心外圈额外补的树根块（保证养树路线可行）' : '', 'GEN');
});

/* ---------------------------------------------------- 4. 开局与代谢 */
add('开局', 'START.water', CONFIG.START.water, '水', '初始水量', 'START');
add('开局', 'START.nutrient', CONFIG.START.nutrient, '养分', '初始养分', 'START');
add('开局', 'START.spore', CONFIG.START.spore, '孢子', '初始孢子', 'START');
add('开局', 'START.seep', CONFIG.START.seep, '/s', '核心基础渗水', 'START');
add('代谢', 'SPORE_METABOLISM', CONFIG.SPORE_METABOLISM, '/s/格',
  '每个菌丝节点产生的孢子（扩张永远有收益的来源）', 'SPORE_METABOLISM');

/* -------------------------------------------------------- 5. 生长 */
add('生长', 'GROW.distCost', CONFIG.GROW.distCost, '倍/格',
  '每格距离 +12% 水耗', 'GROW');
add('生长', 'GROW.autoInterval', CONFIG.GROW.autoInterval, 's', '自动扩张基准间隔', 'GROW');
add('生长', 'GROW.autoDecay', CONFIG.GROW.autoDecay, '倍/级',
  '蔓延速度每级 ×0.86', 'GROW');
add('生长', 'GROW.autoUnlockNodes', CONFIG.GROW.autoUnlockNodes, '格',
  'm10 解锁自动蔓延所需节点数', 'GROW');
add('生长', '生长效率折扣', Math.pow(0.93, 3), '倍',
  '生长效率 Lv3 时的水耗（×0.93^级，示例值）', 'GROW+UPGRADES');

/* -------------------------------------------------------- 6. 运输 */
add('运输', 'TRANSPORT.distLoss', CONFIG.TRANSPORT.distLoss, '/格',
  '距离损耗系数：效率 = 1/(1+dist×loss)', 'TRANSPORT');
add('运输', 'TRANSPORT.transportDecay', CONFIG.TRANSPORT.transportDecay, '倍/级',
  '运输效率升级：loss × 0.88^级', 'TRANSPORT');
add('运输', 'TRANSPORT.baseCapacity', CONFIG.TRANSPORT.baseCapacity, '货物/s',
  '单节点吞吐基数（水不受限）', 'TRANSPORT');
add('运输', 'TRANSPORT.coreCapacity', CONFIG.TRANSPORT.coreCapacity, '货物/s',
  '核心吞吐基数（唯一结构性瓶颈）', 'TRANSPORT');
add('运输', 'TRANSPORT.capacityPerLevel', CONFIG.TRANSPORT.capacityPerLevel, '倍/级',
  '菌丝加粗每级 +40% 吞吐', 'TRANSPORT');
add('运输', 'TRANSPORT.overflowPass', CONFIG.TRANSPORT.overflowPass, '比例',
  '软上限：超载部分只有 30% 能挤过去', 'TRANSPORT');

/* 距离效率查表（含运输升级的几档） */
[0, 1, 2, 4, 6, 8, 10, 15, 20, 30].forEach(function (d) {
  [0, 2, 5, 8].forEach(function (up) {
    const loss = CONFIG.TRANSPORT.distLoss * Math.pow(CONFIG.TRANSPORT.transportDecay, up);
    const eff = 1 / (1 + d * loss);
    add('距离效率', '距离 ' + d + ' 格 / 运输 Lv' + up, round(eff, 4), '倍',
      '产出乘数（三种资源都乘）', 'TRANSPORT');
  });
});

/* -------------------------------------------- 6.5 壤土距离递减 */
const TF = CONFIG.TOPSOIL_FALLOFF;
if (TF) {
  add('壤土递减', '作用基质', TF.soils.join('/'), '', '只影响普通壤土（用户明确）', 'TOPSOIL_FALLOFF');
  add('壤土递减', '作用资源', TF.resource, '', '壤土只产水', 'TOPSOIL_FALLOFF');
  add('壤土递减', 'base（0 格产出）', TF.base, '/s/格',
    '保留壤土原本的 0.12，不另设', 'TOPSOIL_FALLOFF');
  add('壤土递减', 'slope（每格扣水）', TF.slope, '/s/格',
    '用户原式 0.12-0.09=0.03', 'TOPSOIL_FALLOFF');
  add('壤土递减', '归零距离', TF.base / TF.slope, '格',
    'base/slope=4 格 = 从核心数第 5 格', 'TOPSOIL_FALLOFF');
  add('壤土递减', 'limit（地板）', -TF.limit, '/s/格',
    'offset 下限；产出下限 = limit - base = -1.05', 'TOPSOIL_FALLOFF');
  add('壤土递减', '产出下限', round(TF.base - TF.limit, 6), '水/s/格',
    '用户锚点 -1.05', 'TOPSOIL_FALLOFF');
  add('壤土递减', '地板触发距离', TF.limit / TF.slope, '格',
    'limit/slope=39 格（产出恰好 -1.05）', 'TOPSOIL_FALLOFF');
  add('壤土递减', 'SOILS.soil.yield.water', CONFIG.SOILS.soil.yield.water, '/s/格',
    '保持 0.12 —— 贴核产出不变', 'SOILS');
  /* ⚠ 距离 dist 从 0 起；「从核数第几格」= dist + 1 */
  [0, 1, 2, 3, 4, 5, 9, 19, 20, 38, 39, 60].forEach(function (d) {
    let o = -TF.slope * d;
    if (o < -TF.limit) o = -TF.limit;
    const y = CONFIG.SOILS.soil.yield.water + o;
    add('壤土递减曲线', '从核第 ' + (d + 1) + ' 格（dist ' + d + '）', round(y, 6), '水/s/格',
      d < 4 ? '净产出' : (d === 4 ? '★ 精确归零点' : (o === -TF.limit ? '触地板' : '净消耗')),
      'TOPSOIL_FALLOFF');
  });
}

/* -------------------------------------------------- 7. 主干与汇流 */
add('主干', 'TRUNK.maxTrunk', CONFIG.TRUNK.maxTrunk, '格', '主干硬上限（设计承诺）', 'TRUNK');
add('主干', 'TRUNK.maxConfluence', CONFIG.TRUNK.maxConfluence, '格', '汇流硬上限', 'TRUNK');
add('主干', 'TRUNK.coreCapPerTrunk', CONFIG.TRUNK.coreCapPerTrunk, '倍/根',
  '每根主干给核心 +22% 吞吐', 'TRUNK');
add('主干', '核心满配吞吐', CONFIG.TRANSPORT.coreCapacity *
  (1 + CONFIG.TRUNK.coreCapPerTrunk * CONFIG.TRUNK.maxTrunk), '货物/s',
  '110×(1+1.1)=231（派生）', 'TRUNK');
add('主干', 'TRUNK.trunkCapMul', CONFIG.TRUNK.trunkCapMul, '倍', '主干沿途吞吐 ×2.6', 'TRUNK');
add('主干', 'TRUNK.confluenceCapMul', CONFIG.TRUNK.confluenceCapMul, '倍', '汇流吞吐 ×2.1', 'TRUNK');
add('主干', 'TRUNK.trunkYieldMul', CONFIG.TRUNK.trunkYieldMul, '倍', '主干自身产出 ×0.55', 'TRUNK');
add('主干', 'TRUNK.confluenceYieldMul', CONFIG.TRUNK.confluenceYieldMul, '倍', '汇流自身产出 ×0.75', 'TRUNK');
add('主干', 'TRUNK.feederAdjMul', CONFIG.TRUNK.feederAdjMul, '倍', '贴着汇流的支流吞吐 ×1.35', 'TRUNK');

/* ----------------------------------------------------- 8. 节点强化 */
add('节点强化', 'NODE_UP.baseCost', CONFIG.NODE_UP.baseCost, '养分', 'Lv0→Lv1 成本', 'NODE_UP');
add('节点强化', 'NODE_UP.costGrowth', CONFIG.NODE_UP.costGrowth, '倍/级',
  '每级成本 ×1.72', 'NODE_UP');
add('节点强化', 'NODE_UP.maxLevel', CONFIG.NODE_UP.maxLevel, '级', '节点等级上限', 'NODE_UP');
add('节点强化', 'NODE_UP.yieldPerLevel', CONFIG.NODE_UP.yieldPerLevel, '倍/级',
  '每级产出 +25%', 'NODE_UP');
add('节点强化', 'NODE_UP.capPerLevel', CONFIG.NODE_UP.capPerLevel, '倍/级',
  '每级吞吐 +18%', 'NODE_UP');
(function () {
  let cum = 0;
  for (let lv = 1; lv <= CONFIG.NODE_UP.maxLevel; lv++) {
    const c = Math.round(CONFIG.NODE_UP.baseCost *
      Math.pow(CONFIG.NODE_UP.costGrowth, lv - 1));
    cum += c;
    add('节点成本曲线', 'Lv' + lv, c, '养分',
      '累计 ' + cum + ' 养分；产出 ×' + round(1 + CONFIG.NODE_UP.yieldPerLevel * lv, 2), 'NODE_UP');
  }
})();

/* ------------------------------------------------------- 9. 全局升级 */
CONFIG.UPGRADES.forEach(function (u) {
  add('全局升级', u.name + ' (' + u.key + ')',
    'base ' + u.base + ' / growth ' + u.growth,
    '养分', u.desc + '｜' + u.effect + (u.max ? '｜上限 ' + u.max + ' 级' : ''), 'UPGRADES');
  [0, 1, 3, 5, 10].forEach(function (lv) {
    if (u.max != null && lv > u.max) return;
    const c = Math.round(u.base * Math.pow(u.growth, lv));
    add('升级成本曲线', u.name + ' Lv' + lv, c, '养分', '', 'UPGRADES');
  });
});

/* --------------------------------------------------------- 10. 树木 */
add('树木', 'TREE.stageAt', JSON.stringify(CONFIG.TREE.stageAt), '秒',
  '成长点门槛：幼苗0 / 成年60 / 古树180（按连接时长每秒+1）', 'TREE');
add('树木', 'TREE.yieldMul', JSON.stringify(CONFIG.TREE.yieldMul), '倍',
  '各档产出倍率：0.6 / 1.0 / 1.6', 'TREE');
add('树木', 'TREE.ringRadius', CONFIG.TREE.ringRadius, '格', '围拢统计与光环半径', 'TREE');
add('树木', 'TREE.crowdSoftCap', CONFIG.TREE.crowdSoftCap, '格',
  '此数以内满速成长（低于实测 p25=17）', 'TREE');
add('树木', 'TREE.crowdPenalty', CONFIG.TREE.crowdPenalty, '倍/格', '每超 1 格成长率 -0.5', 'TREE');
add('树木', '停滞线', CONFIG.TREE.crowdSoftCap + 1 / CONFIG.TREE.crowdPenalty, '格',
  'crowd 18 → rate 0.00（派生）', 'TREE');
add('树木', 'TREE.decayPerSec', CONFIG.TREE.decayPerSec, '点/s',
  '倒退速率的**下限**（不是上限）：退速 = max(|rate|, 0.25)', 'TREE');
add('树木', 'TREE.auraYieldMul', CONFIG.TREE.auraYieldMul, '倍', '古树给周围其它菌丝的产出加成', 'TREE');
add('树木', 'TREE.auraStack', CONFIG.TREE.auraStack ? '可叠加' : '不叠加', '',
  '多棵古树覆盖同一格只取一次', 'TREE');

/* 拥挤曲线查表：这是树最核心的一张表 */
[-4, -2, -1, 0, 1, 2, 3, 4].forEach(function (delta) {
  const crowd = CONFIG.TREE.crowdSoftCap + delta;
  if (crowd < 1 || crowd > 25) return;
  const over = Math.max(0, crowd - CONFIG.TREE.crowdSoftCap);
  const rate = 1 - over * CONFIG.TREE.crowdPenalty;
  let action;
  if (rate > 0) action = '成长 ×' + round(rate, 2);
  else if (rate === 0) action = '停滞';
  else action = '倒退 ' + round(Math.max(-rate, CONFIG.TREE.decayPerSec), 2) + ' 点/s';
  add('树的拥挤曲线', 'crowd = ' + crowd, round(rate, 2), '倍', action, 'TREE');
});

/* ----------------------------------------------------- 11. 自动规则 */
CONFIG.AUTORULE.forEach(function (r) {
  add('自动蔓延规则', r.name + ' (' + r.key + ')',
    JSON.stringify(r.steps), '', r.desc, 'AUTORULE');
});

/* --------------------------------------------------------- 12. 策略 */
CONFIG.POLICIES.forEach(function (p) {
  add('扩张策略', p.name + ' (' + p.key + ')', p.desc, '', '', 'POLICIES');
});

/* --------------------------------------------------------- 13. 技能 */
CONFIG.ABILITIES.forEach(function (a) {
  add('主动技能', a.name + ' (' + a.key + ')', 'CD ' + a.cd + 's', '',
    a.hint + '｜快捷键 ' + a.slot, 'ABILITIES');
});

/* --------------------------------------------------------- 14. 事件 */
Object.keys(CONFIG.EVENTS).forEach(function (k) {
  add('地图事件', 'EVENTS.' + k, CONFIG.EVENTS[k], '', '', 'EVENTS');
});

/* --------------------------------------------------------- 15. 菌瘟 */
Object.keys(CONFIG.BLIGHT).forEach(function (k) {
  add('菌瘟', 'BLIGHT.' + k, CONFIG.BLIGHT[k], '',
    k === 'immuneLevel' ? '【不变量】免疫线，三处共用同一个数字' : '', 'BLIGHT');
});

/* ------------------------------------------------------- 16. 维持费 */
add('维持费', 'MAINT.costPerLevel', round(CONFIG.MAINT.costPerLevel, 6), '水/s',
  'K = 100/49，让 Lv7 恰好 = 100/s', 'MAINT');
add('维持费', 'MAINT.exponent', CONFIG.MAINT.exponent, '', '平方曲线（改它必须重标 K）', 'MAINT');
add('维持费', 'MAINT.bufferSec', CONFIG.MAINT.bufferSec, 's',
  '水量低于「总维持费×40s」就开始降级', 'MAINT');
add('维持费', 'MAINT.downgradePerSec', CONFIG.MAINT.downgradePerSec, '级/s', '降级速度上限', 'MAINT');
[1, 2, 3, 5, 7, 10].forEach(function (lv) {
  add('维持费曲线', 'Lv' + lv + ' 单节点', round(lv * lv * CONFIG.MAINT.costPerLevel, 2),
    '水/s', '', 'MAINT');
});
/* 承载力：后期水产量下的可养节点数（config 注释里的实测值） */
[[1, 271], [3, 30], [7, 5], [10, 2]].forEach(function (p) {
  add('维持费承载力', '全 Lv' + p[0] + ' 可养', p[1], '个',
    '后期水产量 ≈554/s 时的实测可养数量', 'probe_maint_shape');
});

/* --------------------------------------------------------- 17. 转生 */
add('转生', 'PRESTIGE.firstCost', CONFIG.PRESTIGE.firstCost, '孢子', '首次转生所需孢子', 'PRESTIGE');
add('转生', 'PRESTIGE.costGrowth', CONFIG.PRESTIGE.costGrowth, '倍/次', '每次转生成本 ×1.6', 'PRESTIGE');
add('转生', 'PRESTIGE.geneDivisorNutrient', CONFIG.PRESTIGE.geneDivisorNutrient, '养分/基因',
  '每 1500 累计养分换 1 基因点', 'PRESTIGE');
add('转生', 'PRESTIGE.geneDivisorSpore', CONFIG.PRESTIGE.geneDivisorSpore, '孢子/基因',
  '每 150 累计孢子换 1 基因点', 'PRESTIGE');
[0, 1, 2, 3, 5, 8, 12].forEach(function (n) {
  add('转生成本曲线', '第 ' + (n + 1) + ' 次转生', Math.round(
    CONFIG.PRESTIGE.firstCost * Math.pow(CONFIG.PRESTIGE.costGrowth, n)), '孢子', '', 'PRESTIGE');
});

/* --------------------------------------------------------- 18. 基因 */
CONFIG.GENES.forEach(function (g) {
  add('基因天赋', g.name + ' (' + g.key + ')', 'base ' + g.base + ' / growth ' + g.growth,
    '基因点', g.desc, 'GENES');
});

/* --------------------------------------------------------- 19. 里程碑 */
CONFIG.MILESTONES.forEach(function (m) {
  add('里程碑', m.id + ' ' + m.name, m.need, '', '奖励：' + m.reward, 'MILESTONES');
});

/* ------------------------------------------------- 20. 产出乘区清单 */
add('产出乘区', '节点等级', '×(1 + 0.25×等级)', '', '最多 ×3.5（Lv10）', 'NODE_UP');
add('产出乘区', '吸收/水分/共生升级', '×(1 + 0.18×等级)', '', '各自独立乘', 'UPGRADES');
add('产出乘区', '丰饶基因', '×(1 + 0.12×等级)', '', '', 'GENES');
add('产出乘区', '树档位', '×0.6 / 1.0 / 1.6', '', '仅对树根格', 'TREE');
add('产出乘区', '古树光环', '×1.25', '', '周围 2 格内的其它菌丝，不叠加', 'TREE');
add('产出乘区', '事件增益区', '×' + CONFIG.EVENTS.buffMul, '', '降雨带乘水、孢子季乘孢子', 'EVENTS');
add('产出乘区', '主干代价', '×0.55', '', '被改造成通道的代价', 'TRUNK');
add('产出乘区', '汇流代价', '×0.75', '', '', 'TRUNK');
add('产出乘区', '距离效率', '×1/(1+dist×0.055×0.88^级)', '', '三种资源都乘', 'TRANSPORT');

/* 理论最大乘区（一个满级腐木 + 古树光环，不含事件与主干罚） */
(function () {
  const max =
    (1 + CONFIG.NODE_UP.yieldPerLevel * CONFIG.NODE_UP.maxLevel) *
    (1 + 0.18 * 10) * (1 + 0.12 * 10) * CONFIG.TREE.auraYieldMul;
  add('产出乘区', '理论叠乘上限（不含事件）', round(max, 2), '倍',
    'Lv10 节点 × 升级 Lv10 × 丰饶 Lv10 × 古树光环', '派生');
})();

/* ------------------------------------------------------------ 输出 */
const HEADER = ['分组', '参数', '值', '单位', '说明', '来源'];

function toCSV() {
  const lines = [HEADER.join(',')];
  rows.forEach(function (r) {
    lines.push([r.group, r.name, r.value, r.unit, r.note, r.src].map(q).join(','));
  });
  return lines.join('\n') + '\n';
}

function toMD() {
  const out = [];
  out.push('# 菌丝 · 数据总表');
  out.push('');
  out.push('自动生成，**不要手改**。改参数请改 `src/config.js`，然后跑 `node tools/dump_data.js`。');
  out.push('');
  out.push('生成时间：' + new Date().toISOString().slice(0, 19).replace('T', ' '));
  out.push('参数总数：' + rows.length);
  out.push('');
  const groups = [];
  rows.forEach(function (r) {
    if (groups.indexOf(r.group) < 0) groups.push(r.group);
  });
  groups.forEach(function (g) {
    const list = rows.filter(function (r) { return r.group === g; });
    out.push('## ' + g + '（' + list.length + '）');
    out.push('');
    out.push('| 参数 | 值 | 单位 | 说明 | 来源 |');
    out.push('|---|---|---|---|---|');
    list.forEach(function (r) {
      out.push('| ' + r.name + ' | ' + String(r.value).replace(/\|/g, '\\|') +
        ' | ' + r.unit + ' | ' + String(r.note).replace(/\|/g, '\\|') +
        ' | ' + r.src + ' |');
    });
    out.push('');
  });
  return out.join('\n');
}

const csvPath = path.join(BASE, 'docs', '数据总表.csv');
const mdPath = path.join(BASE, 'docs', '数据总表.md');
fs.writeFileSync(csvPath, '\ufeff' + toCSV(), 'utf8');
fs.writeFileSync(mdPath, toMD(), 'utf8');

/* 自检：导出行数、分组数、有没有空值漏网 */
const bad = rows.filter(function (r) {
  return r.value == null || r.value === '' || r.name === '';
});
console.log('参数总数 ' + rows.length);
console.log('分组数   ' + new Set(rows.map(function (r) { return r.group; })).size);
console.log('空值行   ' + bad.length);
bad.forEach(function (r) { console.log('   ! ' + r.group + ' / ' + r.name); });
console.log('已写出   ' + csvPath);
console.log('已写出   ' + mdPath);
process.exit(bad.length ? 1 : 0);
