"""真·线上代码验证：把线上 src/ 与 index.html 拉下来，搭成一个本地站点，
再用 Chrome headless 跑同一套自测（?autotest=1）。
这样验证的是**线上实际部署的代码**，而不是本地工作区。

用法：python verify_online_run.py
"""
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import http.server
import socketserver
import urllib.request

BASE = "https://liuyuling528-oss.github.io/mycelium"
ROOT = r"C:\Users\yicai\Desktop\mycelium-idle"
STAGE = os.path.join(ROOT, "tools", "_online_stage")
PORT = 8341
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

FILES = ["index.html", "style.css",
         "vendor/phaser.min.js",
         "src/config.js", "src/rng.js", "src/sim.js", "src/ui.js",
         "src/main.js", "src/scenes/WorldScene.js", "tools/autotest.js"]

# 1) 清空并重建 staging 目录，拉线上文件
if os.path.isdir(STAGE):
    shutil.rmtree(STAGE)
os.makedirs(os.path.join(STAGE, "src", "scenes"), exist_ok=True)
os.makedirs(os.path.join(STAGE, "vendor"), exist_ok=True)
os.makedirs(os.path.join(STAGE, "tools"), exist_ok=True)

cb = str(int(time.time()))
got = 0
for f in FILES:
    url = "%s/%s?cb=%s" % (BASE, f, cb)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
        dst = os.path.join(STAGE, f.replace("/", os.sep))
        with open(dst, "wb") as fh:
            fh.write(data)
        got += 1
        print("拉取 OK  %-30s %d 字节" % (f, len(data)))
    except Exception as e:
        print("拉取失败 %-30s %s" % (f, e))

print("\n共拉取 %d/%d 个文件" % (got, len(FILES)))
if got < len(FILES):
    print("!! 文件不全，后续自测可能假失败")
print()

# 2) 起本地服务指向 staging
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STAGE, **kw)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
time.sleep(1.0)

# 3) 跑自测
url = "http://127.0.0.1:%d/index.html?autotest=1" % PORT
prof = os.path.join(ROOT, "tools", "_chromeprofile_onlinerun")
cmd = [CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
       "--no-default-browser-check", "--user-data-dir=" + prof,
       "--window-size=1340,900", "--virtual-time-budget=90000",
       "--dump-dom", url]
print("跑线上代码的自测: " + url)
out = subprocess.run(cmd, capture_output=True, timeout=300)
dom = out.stdout.decode("utf-8", "replace")

m = re.search(r'<pre id="autotest-report">(.*?)</pre>', dom, re.S)
if not m:
    print("!! 没抓到自测报告（DOM %d 字节）" % len(dom))
    sys.exit(2)

rep = (m.group(1).replace("&lt;", "<").replace("&gt;", ">")
       .replace("&amp;", "&").replace("&quot;", '"'))
with open(os.path.join(ROOT, "tools", "_online_run_report.txt"), "w", encoding="utf-8") as f:
    f.write(rep)

for ln in rep.splitlines():
    if "SUMMARY" in ln or "ERRORS" in ln:
        print(ln)
fails = [ln for ln in rep.splitlines() if ln.strip().startswith("FAIL")]
print("FAIL 数 = %d" % len(fails))
for ln in fails[:20]:
    print(ln)
print("报告: tools/_online_run_report.txt")
