#!/usr/bin/env python3
"""
server.py -- the AnimeWorld backend, bundled INSIDE the Android app.

This is the exact same stdlib server that runs on the desktop, but it serves
the frontend from the `www/` folder that ships inside the app. When the app
launches, MainActivity starts this module in a background thread (on
http://127.0.0.1:8080) and points the WebView at it. So the whole system --
search, feeds, series, the HLS proxy -- runs on the phone itself. No PC, no
cloud, no external server.

Zero third-party deps (Python stdlib only). The site calls the API on the
same origin, so there are no CORS issues.
"""
import json
import mimetypes
import os
import re
import socket
import sys
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "www")  # frontend bundled inside the app
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import anime_client as api

HOST = "0.0.0.0"
PORT = 8080  # filled in by main(); used to build external-player URLs


def _lan_ip():
    # Best-effort device IP so an external player (a *different* app) can reach the
    # in-app proxy. 127.0.0.1 is per-app isolated on modern Android, so we use the
    # LAN/cellular IP instead; the proxy binds 0.0.0.0 and answers on every interface.
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        return "127.0.0.1"


def _ok(handler, payload, code=200):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "*")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _err(handler, msg, code=400):
    _ok(handler, {"error": str(msg)}, code=code)


def _q(query, name, default=None):
    return query.get(name, [default])[0] if name in query else default


def api_route(path, query):
    if path == "/api/v1/health":
        return {"status": "ok", "site": api.SITE, "player": api.PLAYER}

    if path == "/api/v1/search":
        q = _q(query, "q", "")
        if not q:
            return _err(None, "missing ?q=")
        return api.search(q, limit=int(_q(query, "limit", 20) or 20))

    if path == "/api/v1/feed":
        return api.feed(
            kind=_q(query, "type", "newest"),
            category=_q(query, "category", "all"),
            page=int(_q(query, "page", 1) or 1),
            limit=int(_q(query, "limit", 25) or 25),
        )

    if path == "/api/v1/categories":
        return api.categories(per_page=int(_q(query, "per_page", 100) or 100))

    if path == "/api/v1/series":
        slug = _q(query, "slug", "")
        if not slug:
            return _err(None, "missing ?slug=")
        return api.series(slug)

    if path == "/api/v1/seasons":
        slug = _q(query, "slug", "")
        if not slug:
            return _err(None, "missing ?slug=")
        s = api.series(slug)
        return {"slug": slug, "title": s["title"],
                "seasons": api.all_seasons(s["post_id"], s["seasons"])}

    if path == "/api/v1/episodes":
        slug = _q(query, "slug", "")
        season = _q(query, "season", None)
        if not slug or not season:
            return _err(None, "missing ?slug= and ?season=")
        s = api.series(slug)
        return api.episodes(s["post_id"], int(season))

    if path == "/api/v1/stream":
        slug = _q(query, "slug", "")
        url = _q(query, "url", "")
        series = _q(query, "series", "")
        season = _q(query, "season", None)
        episode = _q(query, "episode", None)
        if series and season and episode:
            s = api.series(series)
            eps = api.episodes(s["post_id"], int(season))
            hit = next((e for e in eps if e["episode"] == int(episode)), None)
            if not hit:
                return _err(None, "episode not found", 404)
            url = hit["url"]
        elif slug:
            url = f"{api.SITE}/episode/{slug}/"
        if not url:
            return _err(None, "need ?slug= or ?url= or ?series=&season=&episode=")
        return api.episode_stream(episode_url=url)

    if path == "/api/v1/ext_url":
        # Build the in-app proxied HLS URL and hand it to an external player
        # (MX Player / VLC). The proxy already bypasses the CDN's Cloudflare
        # block and serves every playlist + segment, so the external player gets
        # a fully-local HLS it can stream (with audio tracks) -- no file download
        # / muxing required. We point at the device's LAN IP (not 127.0.0.1,
        # which is per-app isolated) and use a .m3u8 path so players treat it as
        # a playlist rather than a raw file.
        raw = _q(query, "url", "")
        if not raw:
            return _err(None, "missing ?url=", 400)
        if not _hls_allowed(raw):
            return _err(None, "host not allowed", 403)
        base = "http://%s:%d/api/v1/hls.m3u8?url=" % (_lan_ip(), PORT)
        return {"url": base + urllib.parse.quote(raw, safe="")}

    return _err(None, f"unknown route: {path}", 404)


# ---------------------------------------------------------------------------
# HLS proxy. The zephyrix player page blocks framing (its CSP frame-ancestors
# only allows watchanimeworld.*), and the m3u8/segment CDNs send no CORS
# headers, so the browser can't embed or fetch them cross-origin. We proxy
# every playlist and segment through our own same-origin server and rewrite all
# URIs inside playlists so each one routes back through the proxy. This is what
# makes video actually play.
# ---------------------------------------------------------------------------
_HLS_ALLOWED = re.compile(
    r"^(?:play\.zephyrix\.org|s\d+\.zn-grid\d+\.top|zn-grid\d+\.top)$"
)
_HLS_CACHE = {}            # url -> (timestamp, bytes, ctype)
_HLS_CACHE_TTL = 120

def _hls_allowed(url):
    host = urllib.parse.urlparse(url).netloc.lower()
    return bool(_HLS_ALLOWED.match(host))

def _hls_headers():
    return {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"),
        "Referer": "https://play.zephyrix.org/",
        "Origin": "https://play.zephyrix.org",
        "Accept": "*/*",
    }

def _hls_fetch(target):
    req = urllib.request.Request(target, headers=_hls_headers(), method="GET")
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()

def _hls_proxied(abs_url):
    return "/api/v1/hls?url=" + urllib.parse.quote(abs_url, safe="")

def _rewrite_playlist(text, base_url):
    def repl(m):
        inner = m.group(1)
        return 'URI="' + _hls_proxied(urllib.parse.urljoin(base_url, inner)) + '"'
    out = re.sub(r'URI="([^"]*)"', repl, text)
    lines = out.split("\n")
    for i, ln in enumerate(lines):
        s = ln.strip()
        if s and not s.startswith("#"):
            lines[i] = _hls_proxied(urllib.parse.urljoin(base_url, s))
    return "\n".join(lines)

def _guess_seg_ctype(url):
    ext = url.split("?")[0].rsplit(".", 1)[-1].lower()
    return {
        "ts": "video/mp2t", "m4s": "video/iso.segment", "m4a": "audio/mp4",
        "aac": "audio/aac", "mp3": "audio/mpeg", "mp4": "video/mp4",
        "key": "application/octet-stream", "vtt": "text/vtt",
    }.get(ext, "application/octet-stream")

def _hls_send(handler, code, body, ctype):
    if isinstance(body, str):
        body = body.encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)

def _hls(handler, parsed):
    query = urllib.parse.parse_qs(parsed.query)
    target = _q(query, "url", "")
    if not target:
        return _err(handler, "missing ?url=", 400)
    if not _hls_allowed(target):
        return _err(handler, "host not allowed", 403)
    now = time.time()
    if target in _HLS_CACHE:
        ts, data, ctype = _HLS_CACHE[target]
        if now - ts < _HLS_CACHE_TTL:
            return _hls_send(handler, 200, data, ctype)
    try:
        raw = _hls_fetch(target)
    except Exception as e:  # noqa: BLE001
        return _err(handler, f"{type(e).__name__}: {e}", 502)
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    text = raw.decode("utf-8", "ignore")
    if text.lstrip().startswith("#EXTM3U"):
        out = _rewrite_playlist(text, target)
        ctype = "application/vnd.apple.mpegurl; charset=utf-8"
        _HLS_CACHE[target] = (now, out.encode("utf-8"), ctype)
        _hls_send(handler, 200, out, ctype)
    else:
        _hls_send(handler, 200, raw, _guess_seg_ctype(target))


class Handler(BaseHTTPRequestHandler):
    def _api(self, parsed):
        query = urllib.parse.parse_qs(parsed.query)
        try:
            payload = api_route(parsed.path, query)
        except Exception as e:  # noqa: BLE001
            return _err(self, f"{type(e).__name__}: {e}", 502)
        if payload is None:
            return _err(self, "no data", 404)
        return _ok(self, payload)

    def _static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        safe = os.path.normpath(path).lstrip("/\\")
        fp = os.path.join(WEB, safe)
        if not fp.startswith(WEB) or not os.path.isfile(fp):
            fp = os.path.join(WEB, "index.html")
        _ext = os.path.splitext(fp)[1].lower()
        _extra = {".webmanifest": "application/manifest+json", ".svg": "image/svg+xml"}
        ctype = _extra.get(_ext) or mimetypes.guess_type(fp)[0] or "application/octet-stream"
        try:
            with open(fp, "rb") as f:
                data = f.read()
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/v1/hls" or parsed.path == "/api/v1/hls.m3u8":
            _hls(self, parsed)
            return
        if parsed.path.startswith("/api/"):
            self._api(parsed)
        else:
            self._static(parsed.path)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def log_message(self, *args):
        pass  # quiet


def main():
    global PORT
    port = int(os.environ.get("PORT", sys.argv[1] if len(sys.argv) > 1 else 8080))
    PORT = port
    srv = ThreadingHTTPServer((HOST, port), Handler)
    print(f"AnimeWorld (in-app backend) on http://{HOST}:{port}  (Ctrl+C to stop)")
    print(f"  site:  {api.SITE}")
    print(f"  open:  http://127.0.0.1:{port}/")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
