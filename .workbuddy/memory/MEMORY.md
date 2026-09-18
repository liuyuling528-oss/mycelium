# MEMORY — 菌丝 Mycelium 项目约定

## 项目定位

用 **Phaser 3.80** 做的增量放置游戏，题材是**菌根网络 / 黏菌**（真实的 "Wood Wide Web"）。
从 Excel VBA 版本转过来的 —— VBA 没有实时循环、画不了粒子、OnMouseMove 也受限，
做交互式游戏束手束脚。引擎选 Phaser 是因为它可以在这里**被浏览器真实跑起来验证**。

位置：`C:\Users\yicai\Desktop\mycelium-idle`

## 硬性约定

1. **数值全部集中在 `src/config.js`**。不要在 sim.js 里散落魔法数字。
2. **`src/sim.js` 必须保持纯逻辑、零渲染依赖** —— Node 要能直接 `require` 它跑离线模拟。
   浏览器/Node 双跑的写法：文件开头 `typeof module !== 'undefined' ? require(...) : window.MYC.X`。
3. **Phaser 场景必须写 `class extends Phaser.Scene`**。
   用普通对象字面量传进 `scene: [...]`，Phaser 只当它是配置对象，自定义方法不会挂到实例上 ——
   表现是「点击地图完全没反应」，而且不报错，极难查。
4. **改数值后必须先跑 `node tools/headless_sim.js 1800`**，再动渲染层。
5. **`tools/autotest.js` 只在 `?autotest=1` 时生效**，不要让它影响正常游玩。

## 内容层（2026-09 追加：用户反馈「只能点地块然后等他生长，很无聊」）

用户这句话点到了我上一轮的盲区：**我只解决了「决策有没有后果」，没解决「手上有没有事做」。**
当时全部动词只有两个 —— 生长、购买。点完就只剩等。

补的四层内容（都在 `src/sim.js` 的「内容层」段 + `src/config.js` 的
`NODE_UP / ABILITIES / EVENTS / MILESTONES`）：

| 系统 | 解决的毛病 |
|---|---|
| **节点强化**（点已有菌丝 = 强化） | 点格子原本「点哪儿由地形决定」，现在点击有两个用途 |
| **主动技能 1/2/3**（带冷却） | 等待期间手上没事做 |
| **地图事件**（降雨带/孢子季/害虫） | 有东西出现在地图上需要回应 |
| **里程碑 8 条**（渐进解锁） | 没有目标；且一开局全摆在眼前 = 内容多但很平 |

### 事件必须全部是「正面或中性」的
害虫只让节点**停产**、点掉还给养分奖励，**绝不摧毁节点**。
放置游戏玩家一定会离开，惩罚性设计会造成「回来一看全毁了」而直接劝退。

### 里程碑是永久成就层，跨转生保留
否则每转生一次都要重新解锁技能，非常烦人。技能解锁、里程碑、里程碑增益都持久化。

## 平衡设计的关键决定（都是实测逼出来的）

- **拥堵用软上限**：`pass = cap + (cargo-cap) * 0.30`。
  硬上限会让「扩张 = 没收益」，与增量游戏的根本冲突，实测浪费率 94%。
- **水不占运输带宽**：只有养分+孢子受吞吐约束。
  早期版本三者共用带宽，98 个高产水脉把带宽全占满，养分和孢子运不回来，扩张反而饿死自己。
- **孢子 = 网络规模**（每节点 0.010/s 代谢）+ 树根加速。保证扩张永远有收益。
- **开局保底**：核心周围 2~3.5 格固定放 5 块落叶 + 2 块水脉。
  噪声尺度约 9 格，否则可能整片开局区域只有水，玩家两分钟拿不到养分直接退出。
- **感知基础半径 = 2**：半径 1 时可见区刚好贴着网络边缘，等于没有前瞻。
- **节点强化成本增速 1.72**：设成 1.55 时「把养分全砸节点」能碾压所有其他路线（强 3.3 倍），
  **最优解唯一等于又变回无聊**。增速必须快过收益增速，才让全局升级与之竞争。
- **事件 RNG 必须用跨调用保持状态的连续流**。原先每次事件都 `makeRng(seed + n)`，
  而 **mulberry32 对相近种子的第一个输出高度相关** → 40 次判定全落同一侧、**害虫永远不出现**，
  但代码看起来完全正常。这是浏览器自测的「事件类型有分化」断言抓出来的，肉眼查不出来。

## 验证链路（这个项目最重要的部分）

```
node tools/headless_sim.js 1800        # 6 策略 × 5 种子的对照模拟
  → 判据：策略差异 > 3 倍、主动点击/纯挂机 > 1.15 倍
  → 差异为 0 就是设计失败，改数值，别写渲染

python -m http.server 8321
chrome --headless=new --virtual-time-budget=45000 \
       --dump-dom "http://127.0.0.1:8321/index.html?autotest=1"
  → 28 项断言，含真实指针事件点击地图
  → ?demo=秒数 快速养大网络，方便截图
```

**为什么必须有对照模拟**：上一版 Excel 游戏做了 25 项测试全绿，
但全是「不崩、能跑、数值不发散」的工程正确性，**没有一项验证「玩家决策是否影响结果」**，
结果花不花钱最终停在同一关。教训：**做游戏先跑「不同策略 → 结果是否有差异」，差异为 0 即设计失败。**

## 环境坑

- Bash 工具在本机不可用 → 一律用 PowerShell，输出重定向到文件再 Read。
- Chrome 在 `C:\Program Files\Google\Chrome\Application\chrome.exe`（Edge 也有）。
  **agent-browser 没装**，直接用 chrome headless 就够，不用下载 500MB。
- 截图/自测**每次都要用新的 `--user-data-dir`**，否则会命中旧缓存和旧 localStorage。
- **Phaser 把原生指针事件排队，下一帧才处理** → 派发事件后同步断言必然失败。
- **这个环境里光派发 `pointerdown` 不够**，Phaser 可能只监听 `mousedown`；自测里两种都发。
- `Compress-Archive` 在这台机器上静默失败 → 打包用 Python `zipfile`。

## 已发布到 GitHub（2026-09-17）

**https://github.com/liuyuling528-oss/mycelium** —— public，默认分支 `main`。
用本机已注册的 SSH 密钥推送（`git@github.com:...`），没装 gh CLI、也没用 token。

- **`.workbuddy/` 被 `.gitignore` 排除**：那是 AI 协作会话的过程记忆，不属于项目源码，
  不该随公开仓库发布。里面的结论都已整理进 README。
- **`tools/make_report.py` 原先把本机绝对路径写死**，已改成脚本相对路径。
  —— publish 之前必须扫一遍硬编码路径，否则别人 clone 下来跑不了。
- 提交信息用中文，且**必须写成 UTF-8 文件再 `git commit -F <file>`**；
  直接放在 PowerShell 命令行参数里会被转码成乱码。
- **推送后的验证 = 全新 clone 到临时目录、用那份副本跑测试**。
  实测 clone 版 `file://` 直接打开 = **56 项断言全过、零 JS 异常**，
  这才算证明「别人拿到手就能玩」，而不只是「我这台机器上能跑」。

### LICENSE：MIT（用户 2026-09-17 选定）
仓库原本 public 但无 LICENSE，等于「保留所有权利」，别人严格来说无权使用。
已加 `LICENSE`（MIT，Copyright (c) 2026 yuling），GitHub 已识别为 `MIT / MIT License`。
README 末尾也加了「许可」一节，并注明内置的 `vendor/phaser.min.js` 是第三方库
Phaser 3.80.1（同样 MIT），随仓库分发是为了双击即离线可玩。

### GitHub Pages 已上线（2026-09-17）
**https://liuyuling528-oss.github.io/mycelium/** —— HTTP 200，线上跑自测 55/55、零异常。

**踩到的坑：`build_type` 被设成了 `workflow`，而仓库里没有任何 workflow → 永久 404。**
症状很有迷惑性：`GET /repos/.../pages` 返回 200、`html_url` / `source` 全对、
`has_pages=true`，但站点永远 404，且 `pages/builds` 为空、Actions 运行数 = 0。
根因是 Pages 源码选了「GitHub Actions」，而这个项目是**零构建静态站**，根本没有 workflow 去部署。

修复（走 API，需要凭据）：
```
PUT /repos/{owner}/{repo}/pages
{"build_type":"legacy","source":{"branch":"main","path":"/"}}   → 204
POST /repos/{owner}/{repo}/pages/builds                          → 201 queued
```
**切完 build_type 不会自动构建**，必须再 `POST /pages/builds` 主动踢一次；
本次构建耗时 38.9 秒，之后站点才 200。构建期间会短暂报
`SSL: UNEXPECTED_EOF_WHILE_READING`（证书在签发），属正常，继续等即可。

topics 已设为：`game, html5-game, idle-game, incremental, javascript, phaser`。
README 顶部加了在线试玩链接。
线上首屏的实拍验证截图**没有提交进仓库**（与 `art/gameplay.png` 重复，属冗余），
只在会话中作为证据出示，避免污染仓库。

## 自适应 / 响应式（2026-09-17 用户反馈「页面都看不全」）

### 当初怎么坏的
三个原因叠加，全是我的疏漏：
1. **`scale: { mode: Phaser.Scale.NONE }`** + 写死的 916×552 → 画布永远这个尺寸。
2. **完全没有媒体查询** → 窄屏下 flex 行挤在一起，`min-width: 330px` 的面板被顶出屏幕。
3. **`height: 100vh`** → 手机上地址栏吃掉几十像素，底部溢出。

症状：手机上**整个右侧面板不可见**（资源和按钮全没了），只能看到画布左边一条。

### 现在怎么做
- 布局：桌面 `display: grid`（`minmax(0,1fr)` + `clamp(310px,29vw,400px)`），
  面板 `overflow-y:auto` + **`min-height: 0`**（不写这条 flex/grid 子项不肯缩，滚动条出不来）。
- 窄屏（`max-width: 900px`）：`#app` 改 `display: block`（不是 grid —— block 才有足够
  容器高度让 sticky 生效），地图 `position: sticky; top: 0`，整页滚动。
  用 `46svh` 而不是 `vh`：地址栏收起时高度不跳。sticky 的地图加了一圈
  `box-shadow: ... 0 0 0 8px var(--bg)`，否则下面滚过去的文字会从圆角处透出来。
- 画布：**`Phaser.Scale.RESIZE`**（不是 FIT）。
  FIT 会把 916px 的缓冲区在宽屏上放大 → 格线发糊；RESIZE 内部像素 == CSS 像素，始终原生清晰。
- 摄像机自动取景（`WorldScene.targetView()`）：对准「已探明区域 + 2 格余量」，
  每帧缓动 0.12。两条硬约束，顺序不能反：
  ```
  z = min(装下已探明区域, 每格≤46px)   // 上限
  z = max(z, 装下整张地图)             // 下限必须最后做，否则会裁掉网络
  ```

### 摄像机数学（Phaser 3 实测）
- `midPoint = (scrollX + width/2, scrollY + height/2)` —— **与 zoom 无关**。
- `worldView = midPoint ± width/(2*zoom)`。
- 所以 `cam.centerOn(cx, cy)` 直接把 (cx,cy) 摆到画面中心，不用管 zoom。
- 反过来「世界 → 画布像素」= `(worldX - worldView.left) * zoom`。

### 加了缩放之后必须一起改的地方
- **提示框和浮动数字要按 `1/zoom` 反向缩放**，否则一放大就变成巨字。
- **提示框的布局必须每帧重算**，不能在 `showTip` 里算一次：缩放是缓动的，
  算一次的话一次放大动画就把比例带偏（实测 `scaleX*zoom` 从 1.0 漂到 0.93）。
  现在 `showTip` 只记锚点，`layoutTip()` 每帧重排 —— 断言从此稳定在 1.000。
- 工具的坐标换算不能再假设「画布 CSS 尺寸 == 内部尺寸」。`autotest.js` 的
  `cellToClient` 改成用 `cam.getWorldPoint(0,0)/(1,0)/(0,1)` **两点标定**求逆映射，
  与 Phaser 内部实现解耦。

### 顺带查出的真 bug
`src/ui.js` 技能冷却条读的是 `a.cfg.cd`，但 `ABILITIES` 的条目里没有 `cfg` 字段
（配置存在 `abRows[key].cfg`，cd 就在条目本身）。写成 `a.cfg.cd` 平时不报错，
**只在「技能已解锁且正在冷却」时才执行到那一行**，一炸就整个 UI 刷新循环断掉。
已改为 `r.cfg.cd`。

### 测试侧的三个坑（都会导致假绿）
1. **`file://` 会把所有脚本错误变成 `Script error. @?:0`**（不透明源），
   没有文件名没有行号。上面那个 ui.js 的 bug 就是这么被藏住的 —— 换 http 才定位到。
   **自测一律走 http。**
2. **Chrome 在 Windows 的窗口最小宽度约 500px**：`--window-size=414` 会被静默夹住，
   `--force-device-scale-factor` 只改渲染密度不改 CSS 视口。
   窄屏要用 `tools/viewport-probe.html`（iframe 有独立视口）才能真测到 390 / 320。
3. **只发 `pointerdown` 可能收不到**：Phaser 在不同环境挂的监听不一样，
   必须 `pointer*` + `mouse*` 都发。否则「点了没反应」的断言会**因为压根没收到点击而假通过**。
   现在自测里加了**正对照**（点一个本来就能长的格子必须长出菌丝）来堵这个洞 ——
   正对照一失败，后面所有「不生长」的断言都不可信。

## 手势：捏合缩放 + 拖拽平移（2026-09-17 应用户要求加的）

### 交互设计
- 点击的判定放在**抬起**时（位移 > 6px 就算拖拽）。按下就执行的话，拖一下就顺手长一格。
- 单指/鼠标拖 = 平移；滚轮 = 以指针为锚点缩放；双指捏合 = 缩放 + 平移。
- **手动操作会停掉自动取景**（`viewMode: 'auto' | 'manual'`），
  否则每帧的自动缓动会把用户刚拖到的位置立刻顶回去。右上角 ⟲ 按钮交还给自动。
- 缩放范围 `[整张地图装下 ×0.85, 每格 2.4 倍]`；平移中心用 `clampCenter` 夹在世界内 —— 拖不丢。

### 实现要点
- **捏合走原生 touch 事件**（`touchstart/move/end` 直接挂在 canvas 上），
  不依赖 Phaser 的多指指针管理 —— 两指序列的映射在各环境下不一致，自己算两指距离最稳。
- **`touch-action: none` 必须加在 canvas 上**：否则单指拖被浏览器当滚页面、
  双指被当浏览器缩放，手势根本收不到（preventDefault 只是兜底）。
- 锚点缩放的数学：`c1 = anchor + (c0 - anchor) * z0/z1`（让锚点下的世界点不动）。
- `zoomLimits()` 里的 ratio = `displaySize.width / scale.width`，Fit 模式下才 ≠1。

### 两个大坑（都实测踩过）

**① 点击定位不能用 `p.worldX` / `cam.worldView`。**
这两个值由 Phaser 在渲染阶段写入，缩放/拖动进行中读到的是**旧一帧**的矩阵，
快速操作时点击会飘到别的格子上（症状：自测里「点击无效」，肉眼看不出）。
现在 `screenToWorldView()` / `cellFromWorld()` 全部用场景自己维护的
`viewZoom / viewCx / viewCy` —— 这是权威来源，每次手势同步更新。
提示框的贴边判断（`layoutTip`）同理，也不能读 worldView。

**② 手势后的「点击冷却」不能用游戏时间。**
最初用 `suppressTapUntil = time.now + 400` 挡捏合结束后的误触，
结果 headless 下帧稀疏、**游戏时间不走**，400ms 的窗口永远不过期，
后面所有点击全部被吞（自测 FAIL，诊断显示「屏蔽还剩 400ms」才定位到）。
正确做法：**按指针登记**（`pinchPtr` / `suppressPtr` 两个 Set），
捏合开始时把按下中的指针记下来，它们的 `pointerup` 只清标记、不当点击。
**教训：凡是「等 X 毫秒」的逻辑，先问一句「X 是什么时钟，它会不会停」。**

### 自测新增（手势相关 13 项）
滚轮缩放、手动模式切换、⟲ 按钮显隐、**缩放锚点不变式**（纯算术核对，
不读摄像机）、拖拽平移、**拖拽不误触**、捏合缩放、指针登记表清空、
缩放下限、平移边界、回到自动取景、缓动、**手势后点击仍有效**。

**测试侧的教训**：`cam.worldView` / `getWorldPoint` 在 headless 下比刚设置的视野
旧一帧，用它算点击坐标会产生「整体偏掉」的假失败。`cellToClient` 已改成
用场景视野状态计算；另留 `cellToClientViaCamera` 做交叉验证（两条路径差 <2px）。
→ **这条后来升级成了硬规则：`toWorld()` 也漏改过，滚轮/捏合锚点飘了 30+ 世界单位。**
  现在 WorldScene 里**任何**世界坐标换算都只走 `screenToWorldView()`（场景状态），
  `cam.worldView` / `getWorldPoint` / `p.worldX` 一律不碰。

## 转生换图（2026-09-18 应用户要求）

每次转生生成一张**全新且更大**的地图：
- 尺寸阶梯：`边长 = 34×20 × min(2, 1 + 0.12 × 转生次数)`，封顶 68×40。
  **必须封顶** —— 孢子收入正比于节点数，地图无上限 = 经济无上限。
- 新种子 = `RNG.hash2(prestiges, 7717, 旧seed) * 2^32 >>> 0`，**确定性推导**。
  不能用 Math.random：headless_sim 靠「同种子 → 同地图序列」比较策略。
  **hash2 返回 [0,1) 浮点，直接 `>>> 0` 永远得 0**（实测：所有玩家转生后同图）。
- 换图代价：knowledge 作废（原本「地图知识跨转生保留」是奖励，图一换就没意义了，
  reward 换成更大的世界）。`doPrestige` 里 `state.knowledge = {}` + explored 重置。
- 地形特征数量按**面积**缩放（`dens = W*H / (基础W*基础H)`），密度不变。
- 实现：`_MAP = {w,h}` 模块级活动地图，`idx/inBounds/neighbours` 读它，
  `newGame/doPrestige/deserialize` 通过 `applyMapSize(state, mapSizeFor(prestiges))` 切换。
  **idx/inBounds/neighbours 从一开始就该读一个可变尺寸，而不是常量** ——
  这样改尺寸几乎零成本（真·无限才需要稀疏存储 + chunk 生成，那是另一个量级）。
- 场景侧 `update()` 检测 `state.mapW/mapH` 变化 → `onMapChanged()`：
  清地形缓存/探索数、镜头交回自动取景。自己检测，不指望 UI 记得通知。
- `drawSoil` 改成**只画可见窗口**（sig = 可视格范围 + 已探明数）——
  大地图上全图重画 1 万多个 fillRect 会掉帧。
- `targetView` 改用 `state.explored` 包围盒（sim 在 `markKnown` 里增量维护），
  不再每帧全图扫描。视野下限从「整张地图装下」改为「整图 ×0.85」——
  地图变大后「必须看到整张图」会让格子小到没法点。

**顺手修的老 bug：`deserialize` 从没把 knowledge 应用回网格** ——
读档后已探明区域整个消失。已加 `applyKnowledge(state)`。

**测试**：+9 项断言（转生可执行、地图变大、种子变化、探索清空、网络重置、
计数 +1、尺寸阶梯、场景缓存重置、新图可生长）。
两个测试坑：① hash2 的浮点返回值；② 转生后镜头一直在缓动，
「静态视野」假设不成立 → 锚点测试要先 `setView` 钉住、互证改读 `cam.midPoint`（同步更新）。

## 菌瘟 —— 后期挑战（2026-09-18 应用户「后期像腹泻」的反馈）

**问题定位**：后期没有威胁、没有取舍，对照模拟里主动/挂机只有 1.36 倍 —— 注意力不值钱。

**机制**（config.BLIGHT）：网络 ≥32 格后出现；从网络**边缘**开始（spawnBlight 在
4 个候选里挑 dist 最大的），**沿相邻菌丝扩散**（spreadBlights：每 spreadInterval=9s
尝试一次，成功率 0.55 + 转生加成）；被感染节点 `disabled`（停产）；点击净化 +90 养分；
**42 秒自愈**（绝不永久损失 —— 这是项目底线，不能破）；数量封顶 8（blightMaxCount：
min(8, 3 + prestiges×1.5)）；核心免疫；与害虫互斥（freeNodeIds/blightableNodeIds 都排除对方）。

**渲染**：紫斑 + **扩散倒计时环**（arc 画 spreadT 进度）—— 紧迫感来自可见信息。
里程碑 m9「净化 12 处」→ `mods.blightSlow`（蔓延间隔 ×1.6）。

**平衡对照的关键改动**：headless_sim 的 `respondToEvents` 改为**只在
`strategy.clicks > 0` 时调用** —— 挂机跑不处理事件，害虫繁殖/菌瘟蔓延的损失
才会体现在对照里。效果：主动/挂机 1.36 → **3.33 倍**（正是用户要的「注意力有价值」）；
策略差异 5.09 → 3.76（仍 >2，合格）。

**测试**：+8 项（投放、停产、扩散、净化、计数、自愈）。
扩散测试的技巧：挑「健康邻居最多」的节点手动 putBlight，保证「能扩散」的前提成立，
再循环调 spreadBlights（每次 55%）直到蔓延出去 —— 不依赖随机运气。

## 自动蔓延解锁（2026-09-18 应用户「挂机白送没意义」的反馈）

`autoStep` 里早就有 `if (!state.autoGrow) return null` 闸门（UI 开关一直用它），
所以改动只是：newGame `autoGrow: false` + 里程碑 m10「感知」解锁。

**m10 条件是「连上」而不是「看到」** —— 这是被测试教育出来的：
第一版写 `discoveredSoils`（markKnown 记录见过的基质），结果某个种子
4 种基质全落在核心初始感知圈（半径 2.5 的圆）里，开局即解锁 = 白送。
「连上」= hasSoil（网络里真有长在该基质上的节点），必须玩家亲手点过去。
注意：开局保底只保证落叶层/水脉**存在**，不保证落在感知圈内，
所以「开局记到哪些基质」是种子相关的，不能当断言；能断言的是
「开局已连上 < 4」（1 个节点不可能连上 4 种，确定性成立）。

- doPrestige 不重置 autoGrow/milestones —— 解锁一次永久有效。
- discoveredSoils 仍在 markKnown 里维护（未来 UI 显示进度可用），
  但不再参与 m10 判定；deserialize 经 applyKnowledge→markKnown 自动恢复。
- UI：`#autoGrowRow/#autoGrowLabel`，锁定时 disabled + 灰化 + 提示解锁条件；
  ui.update 里 memo（lastAgLocked）避免每 0.1s 重写 label。
- headless_sim：6 个策略 clicks:0→1（不点击 + 锁定 = 一格都长不出来，模拟直接死）；
  B 组对照两边显式 autoOn（解锁自动蔓延），唯一变量是 clicks 0 vs 2 + 是否回应事件。
  踩坑：Object.assign 继承 STRATEGIES[2] 会把新的 clicks:1 也带进「纯挂机」，
  必须**显式覆盖 clicks:0**，否则「挂机」其实在以 1 次/秒点击。

结果：主动/挂机 3.33 倍、策略差异 3.73-4.13 倍（判据全过），
后期网络能到 849 格。自测 108 项全过。

## 自动蔓延门槛加规模条件（2026-09-18 用户「至少 200 格」）

m10 条件 = **历史上**连上 4 种特殊基质 + **历史上**菌丝达到 `CONFIG.GROW.autoUnlockNodes`
（定为 250）。进度存 `counters.maxNodes` / `counters.connectedSoils`（addNode 里更新，
跨转生保留；deserialize 从节点列表补算，老存档自动迁移）。

**为什么必须跨转生保留（实测数据）**：若用 `state.nodes.length`（局内），
N=250 时 2/4 种子会先转生（~250-330s）后解锁（~500s+），网络清回 1 格 →
解锁进度清零重爬，体验莫名其妙。进度持久化后总努力不变，只是不被倒扣。

**250 的依据（跑了 0/60/…/500 全曲线，1 次/秒点击）**：
解锁耗时 3 分钟(0) → 5 分钟(200) → 7 分钟(250) → 12 分钟(300) → 20 分钟(400)；
转生数在 ≤250 时全部 5.0（零代价），300 开始终局菌丝腰斩、400 开始伤转生（4.3）。
**教训：我拍脑袋估「200 格要手点半小时」完全错了 —— 水收入随网络快速增长，
1 次/秒点击 5 分钟就能到 200。这种门槛必须跑模拟，不能靠感觉。**
