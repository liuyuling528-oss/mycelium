# -*- coding: utf-8 -*-
"""验证线上 Pages 是否部署了「前线拉锯」：查标记 + md5 比对"""
import hashlib
import os
import time
import urllib.request

BASE = "https://liuyuling528-oss.github.io/mycelium"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CB = str(int(time.time()))
FILES = ["index.html", "src/config.js", "src/sim.js", "src/ui.js",
         "src/scenes/WorldScene.js", "style.css"]
MARKERS = {
    "index.html": ["menu-side", "menu-title"],
    "src/config.js": ["FRONTIER"],
    "src/sim.js": ["frontierBattle", "enemyHp"],
    "src/ui.js": ["sFrontier"],
    "src/scenes/WorldScene.js": ["drawFrontierEvents"],
}

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


for f in FILES:
    url = "%s/%s?cb=%s" % (BASE, f, CB)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=25) as r:
            online = r.read()
        text = online.decode("utf-8", "replace")
        with open(os.path.join(ROOT, f), "rb") as fh:
            local = fh.read()
        same = hashlib.md5(online).hexdigest() == hashlib.md5(local).hexdigest()
        marks = MARKERS.get(f, [])
        miss = [m for m in marks if m not in text]
        if marks:
            check("标记 %s" % f, not miss,
                  "缺 %s" % miss if miss else "%d/%d" % (len(marks), len(marks)))
        check("md5 %s" % f, same,
              "" if same else "线上与本地不一致（%d vs %d 字节）" % (len(online), len(local)))
    except Exception as e:
        check("拉取 %s" % f, False, str(e))

print("RESULT ok=%d fail=%d" % (ok, fail))
