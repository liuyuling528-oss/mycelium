"""验证线上版本：拉取线上 index.html / src/*.js，断言维护费机制已生效。
用法：python verify_online.py
"""
import re
import sys
import time
import urllib.request

BASE = "https://liuyuling528-oss.github.io/mycelium"
FILES = ["index.html", "style.css", "src/config.js", "src/sim.js",
         "src/ui.js", "src/scenes/WorldScene.js"]

# GitHub Pages 走 CDN，刚 push 完可能还是旧缓存。
# 加时间戳参数绕过缓存（Pages 会把 query 忽略掉，但 CDN 键会变）。
CACHEBUST = str(int(time.time()))

ok = 0
fail = 0


def check(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("PASS  %s  %s" % (name, extra))
    else:
        fail += 1
        print("FAIL  %s  %s" % (name, extra))


texts = {}
for f in FILES:
    url = "%s/%s?cb=%s" % (BASE, f, CACHEBUST)
    try:
        # 只加时间戳 + 普通 UA，**不要**带 Cache-Control / Pragma:
        # 实测带上 no-cache 反而会命中 GitHub Pages CDN 的一层陈旧缓存，
        # 拉到的是旧版内容（同一时刻另一个不带该头的脚本拿到的是新版）。
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=25) as r:
            texts[f] = r.read().decode("utf-8", "replace")
        print("拉取 OK  %s  (%d 字节)" % (f, len(texts[f])))
    except Exception as e:
        texts[f] = ""
        print("拉取失败 %s : %s" % (f, e))

cfg = texts["src/config.js"]
sim = texts["src/sim.js"]
ui = texts["src/ui.js"]
ws = texts["src/scenes/WorldScene.js"]
css = texts["style.css"]

check("config 有 MAINT 配置块", "MAINT" in cfg and "costPerLevel" in cfg)
# 标定锚点：K = 100/49 让 Lv7 恰好 = 100/s。
# 曾写成 "costPerLevel: 0.25" —— 那是更早一版的值，早就对不上了，
# 等于这条检查一直在误报，顺手修掉。
check("config 的 costPerLevel 是 100/49（Lv7 = 100/s 的锚点）",
      "costPerLevel: 100 / 49" in cfg, "（旧版是 0.25 或 0.02）")
check("config 导出 MAINT", "MAINT: MAINT" in cfg)

# 降级触发条件：水见底（<= 0）才开始。
# 旧版是「水量低于 维持费 × bufferSec(40s)」的缓冲线 ——
# 那条会让玩家在水还是正数时掉级，已删除。
check("sim 的降级触发条件是「水见底」",
      "state.res.water <= 0" in sim)
# 注意别用裸的 "bufferSec" 做判断 —— 代码注释里**故意**留着历史说明
# （「旧版是 维持费 × bufferSec(40s)」），裸串匹配会误报。
# 要查的是「字段真的没了」：config 里不该再有 `bufferSec:` 这个键，
# sim 里不该再引用 `MAINT.bufferSec`。
check("config 里已没有 bufferSec 字段", "bufferSec:" not in cfg)
check("sim 里已不引用 MAINT.bufferSec", "MAINT.bufferSec" not in sim)

check("sim 有 settleMaintenance", "function settleMaintenance" in sim)
check("sim 有降级排序（远端优先）", "downgradeOrder" in sim)
check("sim 挂进了主循环", "settleMaintenance(state, dt)" in sim)
check("sim 导出了维护接口",
      "totalMaintainCost: totalMaintainCost" in sim and "maintainCostOf" in sim)
check("sim 不再有死代码 maintainBuffer",
      "function maintainBuffer" not in sim)

check("ui 显示维持费", "maintainCost" in ui)
check("ui 有告警样式切换", "maintainPressure" in ui)
check("css 有 .rate.warn", ".rate.warn" in css)

check("tooltip 显示维持耗水", "维持耗水" in ws)

check("index.html 可访问且有游戏容器",
      len(texts["index.html"]) > 500 and "vWater" in texts["index.html"])

print("\nSUMMARY pass=%d fail=%d" % (ok, fail))
sys.exit(1 if fail else 0)
