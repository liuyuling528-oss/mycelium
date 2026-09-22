"""截一张运行中的游戏界面，用来肉眼核对右侧面板的排版与数字。
用法：python shot.py [端口] [宽] [高] [查询串]
例：  python shot.py 8342 1400 1000 "?slots=1"   # 展开存档槽再截
截图落在 tools/_shot.png
"""
import os
import subprocess
import sys
import threading
import time
import http.server
import socketserver

ROOT = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(ROOT)
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8342
W = sys.argv[2] if len(sys.argv) > 2 else "1400"
H = sys.argv[3] if len(sys.argv) > 3 else "1000"
QUERY = sys.argv[4] if len(sys.argv) > 4 else ""
# ?slots=1 / ?strains=1 / ?choice=1 依赖 load 之后 700ms 的注入，虚拟时间预算要留够
WAIT = "60000" if ("slots" in QUERY or "strains" in QUERY or "choice" in QUERY) else "45000"

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PROFILE = os.path.join(ROOT, "tools", "_chromeprofile_shot_" + str(PORT))
OUT = os.path.join(ROOT, "tools", "_shot.png")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass


def serve():
    # 必须多线程：单线程下页面并发抓 7~8 个脚本时会有请求被搁置，
    # Chrome 判为失败 → 某个脚本没执行 → UI 未定义 → 截图截到空白页面。
    # 详见 run_autotest.py 里同名注释与 DEVELOPMENT.md 的排查记录。
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler)
    httpd.daemon_threads = True
    httpd.serve_forever()


threading.Thread(target=serve, daemon=True).start()
time.sleep(1.0)

url = "http://127.0.0.1:%d/index.html%s" % (PORT, QUERY)
if os.path.exists(OUT):
    os.remove(OUT)

cmd = [
    CHROME, "--headless=new", "--disable-gpu",
    "--no-first-run", "--no-default-browser-check",
    "--disable-application-cache", "--disk-cache-size=1",
    "--media-cache-size=1", "--incognito",
    "--user-data-dir=" + PROFILE,
    "--window-size=%s,%s" % (W, H),
    "--virtual-time-budget=" + WAIT,
    "--screenshot=" + OUT,
    url,
]

print("截图: " + url, flush=True)
subprocess.run(cmd, capture_output=True, timeout=180)
if os.path.exists(OUT):
    print("OK " + OUT + " %d bytes" % os.path.getsize(OUT))
else:
    print("!! 截图失败")
    sys.exit(2)
