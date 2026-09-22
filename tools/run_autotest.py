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
    # ⚠ 必须用 ThreadingTCPServer。
    # 原来的 TCPServer 是**单线程**的，而浏览器会并发抓 7~8 个脚本
    # （config/rng/sim/WorldScene/ui/main/autotest + phaser）。单线程 server
    # 在同一时刻只能处理一个连接，其余的会被搁置甚至被 Chrome 判为失败：
    # 表现为某个 <script src> 触发一个「空的 error 事件」（message/filename 皆空），
    # 该脚本**从未执行** —— 于是 UI 未定义、main.js 第 20 行抛
    # 「UI is not defined」、game 永远建不起来、autotest 报「游戏未能在 8 秒内启动」。
    # 这是**测试脚手架的 bug**，不是游戏代码的问题。
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler)
    httpd.daemon_threads = True
    httpd.serve_forever()


t = threading.Thread(target=serve, daemon=True)
t.start()
time.sleep(1.0)

url = "http://127.0.0.1:%d/index.html?autotest=1" % PORT
cmd = [
    CHROME, "--headless=new", "--disable-gpu",
    "--no-first-run", "--no-default-browser-check",
    # 禁用磁盘缓存：src/*.js 没有版本号，Chrome 会缓存住改动，
    # 导致自测跑的是上一版代码（曾因此看到过期的 offset 值）。
    "--disable-application-cache", "--disk-cache-size=1",
    "--media-cache-size=1", "--incognito",
    "--user-data-dir=" + PROFILE,
    "--window-size=1340,900",
    "--virtual-time-budget=90000",
    "--dump-dom", url,
]


def run_once(tag):
    """跑一次 Chrome 拿 DOM。

    ⚠ 为什么需要「跑多次」：headless Chrome 在 --incognito + 极小磁盘缓存下，
    偶发会在脚本队列还没跑完时就把 DOM 定型 —— 表现为 src/ui.js 之类的脚本
    **没有执行**（既不是 404、也不报错，只是全局没定义），于是 autotest 报告
    整个缺失，看起来像「游戏启动失败」。
    实测同一份未改动的页面连跑 8 次，7 次正常 1 次如此 —— 是加载竞态，
    不是代码 bug。所以这里对「拿不到报告」自动重试，而不是去改游戏。
    真出问题的页面（语法错、抛异常）会稳定失败，重试救不回来，该报的错照样报。
    """
    profile = PROFILE + "_try" + str(tag)
    c = list(cmd)
    for i, a in enumerate(c):
        if a.startswith("--user-data-dir="):
            c[i] = "--user-data-dir=" + profile
    r = subprocess.run(c, capture_output=True, timeout=240)
    dom = r.stdout.decode("utf-8", "replace")
    m = re.search(r'<pre id="autotest-report">(.*?)</pre>', dom, re.S)
    return m, dom


TRIES = 4
dom = ""
report = None
for attempt in range(1, TRIES + 1):
    print("跑自测（第 %d/%d 次）: %s" % (attempt, TRIES, url), flush=True)
    m, dom = run_once(attempt)
    if m:
        report = m.group(1)
        break
    print("   第 %d 次没拿到报告（DOM 长度 = %d，多半是加载竞态），重试…"
          % (attempt, len(dom)), flush=True)

if report is None:
    print("!! %d 次都没找到 autotest-report。最后一次 DOM 长度 = %d" % (TRIES, len(dom)))
    with open(os.path.join(ROOT, "tools", "_dump_fail.html"), "w", encoding="utf-8") as f:
        f.write(dom)
    sys.exit(2)

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
