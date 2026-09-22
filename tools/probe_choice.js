/**
 * probe_choice.js —— 只跑「转生三选一」那组对照，快速取证。
 *
 * 【为什么需要它】G 组在 headless_sim.js 的最末尾，而它前面的
 * C/D/E/F 组要跑十几分钟。调完三选一的权重想复看一眼结论时，
 * 等全套跑完完全不划算 —— 这个脚本把 G 组那段**原样**搬到 C/D 之前执行，
 * 跑完就退出。
 *
 * 【为什么不是另写一套近似实现】它直接读 headless_sim.js 的源码、
 * 按锚点切出 G 组代码块再拼接，用的是**同一个 run() / avgOf() / STRATEGIES** ——
 * 所以数字和正式 G 组一致，不会出现「探针说一套、正式报表说另一套」。
 * 代价是依赖 headless_sim.js 里两个注释锚点和一行 tailMark，
 * 那几处注释被改动时这里会「定位失败」并退出 2（不会静默给出错数字）。
 *
 * 用法：node tools/probe_choice.js [时长秒，默认 600]
 *
 * 判据（见 DEVELOPMENT.md「G 组判据」）：
 *   最优/最差 < 1.10× → 三张卡是装饰；> 2.50× → 实际只有一种选法。
 */
var fs = require('fs');
var path = require('path');
var { spawnSync } = require('child_process');

var SIM_SRC = path.join(__dirname, 'headless_sim.js');
var GEN = path.join(__dirname, '_choice_gen.js');

var src = fs.readFileSync(SIM_SRC, 'utf8');

/* 锚点（headless_sim.js 里如果改了这几行，这里会报「定位失败」） */
var G_MARK = '/* ------------------------------------------------------------------ G 组 */';
var CD_MARK = '/* ------------------------------------------------------------------ C/D 组';
var TAIL_MARK = "console.log(' 最强策略成长曲线:');";

var gStart = src.indexOf(G_MARK);
var cdStart = src.indexOf(CD_MARK);
var gEnd = src.indexOf(TAIL_MARK, gStart);

if (gStart < 0 || cdStart < 0 || gEnd < 0 || gEnd <= gStart) {
  console.error('定位失败：headless_sim.js 里的 G 组锚点找不到了。'
    + ' gStart=' + gStart + ' cdStart=' + cdStart + ' gEnd=' + gEnd);
  console.error('（这个脚本靠注释锚点切代码块。改过那几行注释的话，'
    + '请同步更新本文件顶部的 G_MARK / CD_MARK / TAIL_MARK。）');
  process.exit(2);
}

/* G 组依赖的东西都在 C/D 之前就已定义（SEEDS / STRATEGIES / run / avgOf /
 * DURATION / CONFIG / failed），所以把块挪到 cdStart 处可以直接跑。 */
var gBlock = src.slice(gStart, gEnd);
var generated = src.slice(0, cdStart) + '\n' + gBlock
  + '\nprocess.exit(failed ? 1 : 0);\n';
fs.writeFileSync(GEN, generated, 'utf8');

var seconds = process.argv[2] || '600';
var r = spawnSync(process.execPath, [GEN, String(seconds)], {
  encoding: 'utf8', maxBuffer: 8e7, timeout: 900000
});
process.stdout.write(r.stdout || '');
if (r.stderr) process.stderr.write(r.stderr);
console.log('EXIT=' + r.status);
process.exit(r.status === null ? 3 : r.status);
