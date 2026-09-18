"""诊断线上内容到底是什么版本、缺什么。
用法：python diag_online.py
"""
import time
import urllib.request

BASE = "https://liuyuling528-oss.github.io/mycelium"
cb = str(int(time.time()))


def get(path):
    url = "%s/%s?cb=%s" % (BASE, path, cb)
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, r.headers.get("Last-Modified"), r.read()
    except Exception as e:
        return None, None, str(e).encode()


# 1) 线上 sim.js 里所有出现的 "settle" / "MAINT" / "maintain" 片段
st, lm, body = get("src/sim.js")
txt = body.decode("utf-8", "replace")
print("=== src/sim.js ===")
print("status=%s  Last-Modified=%s  len=%d" % (st, lm, len(txt)))
for kw in ["settleMaintenance", "MAINT", "maintain", "computeFlow(state, dt)",
           "tickEvents(state, dt)", "围死熄灭", "failLimit"]:
    print("  %-28s 出现 %d 次" % (kw, txt.count(kw)))

# print first 200 chars to see if it looks like real source
print("  开头 120 字符: " + repr(txt[:120]))

print()
print("=== src/config.js ===")
st2, lm2, body2 = get("src/config.js")
t2 = body2.decode("utf-8", "replace")
print("status=%s  Last-Modified=%s  len=%d" % (st2, lm2, len(t2)))
for kw in ["MAINT", "costPerLevel", "BLIGHT", "NODE_UP"]:
    print("  %-28s 出现 %d 次" % (kw, t2.count(kw)))
print("  开头 120 字符: " + repr(t2[:120]))

# 2) 看看是不是路径整体错了 —— 试几个可能的入口
print()
print("=== 探测其他可能入口 ===")
for path in ["", "index.html", "mycelium/", "mycelium/index.html"]:
    u = BASE + "/" + path if path else BASE
    req = urllib.request.Request(u + "?cb=" + cb, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            print("  %-24s -> %s  %d 字节  %s" % (path or "(根)", r.status, len(r.read()),
                                                  r.headers.get("Content-Type")))
    except Exception as e:
        print("  %-24s -> ERR %s" % (path or "(根)", e))
