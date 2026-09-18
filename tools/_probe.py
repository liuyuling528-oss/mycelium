import urllib.request
try:
    r = urllib.request.urlopen("http://127.0.0.1:8491/index.html", timeout=5)
    print("8491 alive, status", r.status)
except Exception as e:
    print("8491 dead:", e)
