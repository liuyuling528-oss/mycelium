"""在真实游戏里逐格模拟「悬停提示」的文案，找出现在玩家会看到什么。
思路：不依赖鼠标事件，直接复刻 WorldScene.showHover 里那段算 dist/off 的逻辑，
把核心周围一圈格子的提示文本打出来。
用法：python probe_tip.py [端口]
输出 tools/_tip.txt
"""
import os
import re
import subprocess
import sys
import threading
import time
import http.server
import socketserver

ROOT = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(ROOT)
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8362

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PROFILE = os.path.join(ROOT, "tools", "_chromeprofile_tip_" + str(PORT))
OUT = os.path.join(ROOT, "tools", "_tip.txt")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass


def serve():
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), Handler)
    httpd.serve_forever()


threading.Thread(target=serve, daemon=True).start()
time.sleep(1.0)

url = "http://127.0.0.1:%d/index.html?tipdump=1" % PORT
cmd = [
    CHROME, "--headless=new", "--disable-gpu",
    "--no-first-run", "--no-default-browser-check",
    "--disable-application-cache", "--disk-cache-size=1",
    "--media-cache-size=1", "--incognito",
    "--user-data-dir=" + PROFILE,
    "--window-size=1400,1000",
    "--virtual-time-budget=40000",
    "--dump-dom", url,
]

print("探针: " + url, flush=True)
out = subprocess.run(cmd, capture_output=True, timeout=240)
dom = out.stdout.decode("utf-8", "replace")

m = re.search(r'<pre id="tipprobe">(.*?)</pre>', dom, re.S)
body = m.group(1) if m else "(没跑出 tipprobe —— 检查 src/main.js 是否挂了探针)"
body = (body.replace("&lt;", "<").replace("&gt;", ">")
            .replace("&amp;", "&").replace("&quot;", '"'))

with open(OUT, "w", encoding="utf-8") as f:
    f.write(body)
print("OK " + OUT)
