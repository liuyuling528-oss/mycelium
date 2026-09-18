# -*- coding: utf-8 -*-
"""轮3上线验证：线上文件应包含新生命周期参数/文案，且不再有 recoverT/自愈。"""
import sys, time, urllib.request

BASE = "https://liuyuling528-oss.github.io/mycelium/"

def get(path):
    req = urllib.request.Request(BASE + path, headers={
        "User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")

deadline = time.time() + 300
while True:
    try:
        cfg = get("src/config.js")
        if "failLimit: 2" in cfg and "recoverT" not in cfg:
            sim = get("src/sim.js")
            ui = get("src/ui.js")
            ws = get("src/scenes/WorldScene.js")
            checks = {
                "config 新参数(spreadInterval/failLimit/无recoverT)":
                    "spreadInterval: 21" in cfg and "failLimit: 2" in cfg and "recoverT" not in cfg,
                "sim 快照遍历+围死判定":
                    "state.events.slice()" in sim and "failLimit" in sim,
                "sim 无自愈": "recoverT" not in sim,
                "ui 围死文案(无自愈)": "围死" in ui and "自愈" not in ui,
                "WorldScene 新提示(无recoverT)":
                    "围死" in ws and "recoverT" not in ws,
            }
            bad = [k for k, v in checks.items() if not v]
            if not bad:
                print("ONLINE OK")
                for k in checks:
                    print("  PASS", k)
                sys.exit(0)
            print("部分文件未更新:", bad)
        else:
            print("config 仍是旧版，等待部署...")
    except Exception as e:
        print("抓取失败:", e)
    if time.time() >= deadline:
        print("ONLINE VERIFY TIMEOUT")
        sys.exit(1)
    time.sleep(30)
