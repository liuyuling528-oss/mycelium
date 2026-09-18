"""跑浏览器端自测：起 http 服务 -> Chrome headless --dump-dom -> 抓报告。
用法：python run_autotest.py [端口]
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
ROOT = os.path.dirname(ROOT)            # tools/ 的上一层 = 项目根
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8329

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PROFILE = os.path.join(ROOT, "tools", "_chromeprofile_" + str(PORT))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass


def serve():
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), Handler)
    httpd.serve_forever()


t = threading.Thread(target=serve, daemon=True)
t.start()
time.sleep(1.0)

url = "http://127.0.0.1:%d/index.html?autotest=1" % PORT
cmd = [
    CHROME, "--headless=new", "--disable-gpu",
    "--no-first-run", "--no-default-browser-check",
    "--user-data-dir=" + PROFILE,
    "--window-size=1340,900",
    "--virtual-time-budget=90000",
    "--dump-dom", url,
]

print("跑自测: " + url, flush=True)
out = subprocess.run(cmd, capture_output=True, timeout=240)
dom = out.stdout.decode("utf-8", "replace")

m = re.search(r'<pre id="autotest-report">(.*?)</pre>', dom, re.S)
if not m:
    print("!! 没找到 autotest-report。DOM 长度 = %d" % len(dom))
    with open(os.path.join(ROOT, "tools", "_dump_fail.html"), "w", encoding="utf-8") as f:
        f.write(dom)
    sys.exit(2)

report = m.group(1)
report = (report.replace("&lt;", "<").replace("&gt;", ">")
                .replace("&amp;", "&").replace("&quot;", '"'))

rp = os.path.join(ROOT, "tools", "_autotest_report.txt")
with open(rp, "w", encoding="utf-8") as f:
    f.write(report)

fails = [ln for ln in report.splitlines() if ln.strip().startswith("FAIL")]
summary = [ln for ln in report.splitlines() if "SUMMARY" in ln or "ERRORS" in ln]
print("\n".join(summary))
print("FAIL 行数 = %d" % len(fails))
for ln in fails[:40]:
    print(ln)
print("完整报告: " + rp)
