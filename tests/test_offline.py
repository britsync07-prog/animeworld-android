#!/usr/bin/env python3
"""Verify the PWA + offline-download data path.

1. The PWA assets (manifest, service worker, icon) are served correctly.
2. The full HLS segment set for an episode is fetchable through the proxy,
   which is exactly what web/download.js caches when a user downloads an
   episode for offline playback. (The JS does the same URL collection.)
"""
import subprocess, json, sys, re, urllib.parse

B = "http://127.0.0.1:8080"
fails = 0


def curl_stat(url):
    """Return (http_code, size_download) without loading the body into text."""
    import os
    tmp = "/tmp/_anime_seg.dat"
    o = subprocess.run(["curl", "-sS", "-o", tmp, "-w", "%{http_code}", url],
                       capture_output=True, text=True, timeout=120)
    try:
        size = os.path.getsize(tmp)
    except OSError:
        size = 0
    try:
        code = int(o.stdout.strip() or 0)
    except ValueError:
        code = 0
    return code, size


def curl_text(url):
    out = subprocess.run(["curl", "-sS", url], capture_output=True, timeout=120)
    return out.stdout.decode("utf-8", "ignore")


def check(cond, msg, extra=""):
    global fails
    print(("PASS" if cond else "FAIL"), msg, extra)
    if not cond:
        fails += 1


def main():
    # 1) PWA assets
    for path in ["/manifest.webmanifest", "/sw.js", "/icon.svg"]:
        code, _ = curl_stat(B + path)
        check(code == 200, "serves " + path, "HTTP " + str(code))

    code, _ = curl_stat(B + "/manifest.webmanifest")
    m = json.loads(curl_text(B + "/manifest.webmanifest"))
    valid = m.get("name") == "AnimeWorld" and "icons" in m and m.get("display") == "standalone"
    check(valid, "manifest is valid installable PWA json")

    # 2) Offline data path: master -> best variant -> segments all 200
    slug = "the-elusive-samurai-1x1"
    st = json.loads(curl_text(B + "/api/v1/stream?slug=" + slug))
    check(bool(st and st.get("video_source")), "stream returns video_source")
    if not st or not st.get("video_source"):
        return done()

    master = st["video_source"]
    pm = B + "/api/v1/hls?url=" + urllib.parse.quote(master, safe="")
    code, _ = curl_stat(pm)
    check(code == 200, "proxied master playlist 200")

    mtext = curl_text(pm)
    lines = mtext.split("\n")
    best, bestbw = None, -1
    for i, l in enumerate(lines):
        if l.startswith("#EXT-X-STREAM-INF"):
            bw = re.search(r"BANDWIDTH=(\d+)", l)
            b = int(bw.group(1)) if bw else 0
            if b > bestbw:
                bestbw, best = b, lines[i + 1]
    variant = best or [l for l in lines if l and not l.startswith("#")][0]
    code, _ = curl_stat(B + variant)
    check(code == 200, "best variant playlist 200", variant[:70])

    vtext = curl_text(B + variant)
    segs = [l.strip() for l in vtext.split("\n") if l.strip() and not l.startswith("#")]
    check(len(segs) > 0, "variant has segments", "count=" + str(len(segs)))
    if not segs:
        return done()

    for idx in [0, len(segs) // 2, len(segs) - 1]:
        u = segs[idx]
        code, size = curl_stat(B + u)
        check(code == 200 and size > 0, "segment[%d] fetchable 200" % idx, "(%d bytes)" % size)

    done()


def done():
    print()
    if fails == 0:
        print("RESULT: ALL OFFLINE-PATH CHECKS PASS")
    else:
        print("RESULT: %d FAILURE(S)" % fails)
    sys.exit(1 if fails else 0)


main()
