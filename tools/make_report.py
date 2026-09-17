# -*- coding: utf-8 -*-
"""从 DOM dump 里抽出自测报告存成正式报告文件，并清掉临时文件。"""
import os, re, glob

# 项目根目录 = 本文件所在目录的上一级。别写死绝对路径，
# 否则别人 clone 下来这个脚本直接就跑不了。
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOM = os.path.join(ROOT, "tools", "dom.txt")
REPORT = os.path.join(ROOT, "tools", "autotest_report.txt")

if os.path.exists(DOM):
    raw = open(DOM, encoding="utf-8", errors="replace").read()
    m = re.search(r"===== AUTOTEST REPORT =====(.*?)===== END =====", raw, re.S)
    if m:
        body = (m.group(1).replace("&gt;", ">").replace("&lt;", "<")
                            .replace("&amp;", "&").replace("&quot;", '"'))
        open(REPORT, "w", encoding="utf-8").write(
            "菌丝 Mycelium — 浏览器端端到端自测报告\n"
            "（tools/autotest.js 生成，通过真实指针事件驱动 Phaser 输入链路）\n"
            "命令：chrome --headless=new --virtual-time-budget=50000 "
            '--dump-dom "http://127.0.0.1:8321/index.html?autotest=1"\n'
            + "=" * 64 + "\n" + body.strip() + "\n")
        tail = [l for l in body.splitlines() if l.startswith("SUMMARY") or l.startswith("ERRORS")]
        print("report written: " + " | ".join(tail))
    else:
        print("!! report pattern not found in dom.txt")

for pat in ("tools/dom.txt", "tools/dom_file.txt", "tools/dom_*.txt"):
    for p in glob.glob(os.path.join(ROOT, pat.replace("/", os.sep))):
        try:
            os.remove(p)
            print("removed " + os.path.basename(p))
        except Exception as e:
            print("could not remove %s (%s)" % (p, e))
