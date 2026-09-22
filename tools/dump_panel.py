"""把运行中的界面按 element id 抓一遍文本，用来核对面板数字。
用法：python dump_panel.py [端口]
输出 tools/_panel.txt
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
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8343

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PROFILE = os.path.join(ROOT, "tools", "_chromeprofile_dp_" + str(PORT))
OUT = os.path.join(ROOT, "tools", "_panel.txt")


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

url = "http://127.0.0.1:%d/index.html?panel=1" % PORT
cmd = [
    CHROME, "--headless=new", "--disable-gpu",
    "--no-first-run", "--no-default-browser-check",
    "--disable-application-cache", "--disk-cache-size=1",
    "--media-cache-size=1", "--incognito",
    "--user-data-dir=" + PROFILE,
    "--window-size=1400,1000",
    "--virtual-time-budget=60000",
    "--dump-dom", url,
]

print("抓面板: " + url, flush=True)
out = subprocess.run(cmd, capture_output=True, timeout=240)
dom = out.stdout.decode("utf-8", "replace")

# 面板区整块 HTML
m = re.search(r'<aside id="panel">(.*?)</aside>', dom, re.S)
panel = m.group(1) if m else "(没找到 aside#panel)"

lines = []
lines.append("DOM 长度 = %d" % len(dom))
lines.append("")
lines.append("===== #panel 原文 =====")
lines.append(panel)
lines.append("")
lines.append("===== 关键元素文本 =====")
for eid in ["vWater", "rWater", "topsoilRow", "vNutrient", "rNutrient",
            "vSpore", "rSpore", "sNodes", "sDist", "sLost", "sRun",
            "clock", "trunkCount", "treeCount", "msCount"]:
    m2 = re.search(r'id="%s"[^>]*>(.*?)</' % eid, dom, re.S)
    t = re.sub(r"<[^>]+>", "", m2.group(1)).strip() if m2 else "(缺)"
    lines.append("%-12s = %s" % (eid, t))

with open(OUT, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
print("OK " + OUT)
