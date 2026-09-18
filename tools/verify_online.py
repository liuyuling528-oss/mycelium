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
check("config 的 costPerLevel = 0.25", "costPerLevel: 0.25" in cfg,
      "（旧版是 0.02 或完全缺失）")
check("config 的 bufferSec = 40", "bufferSec: 40" in cfg)
check("config 导出 MAINT", "MAINT: MAINT" in cfg)

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
