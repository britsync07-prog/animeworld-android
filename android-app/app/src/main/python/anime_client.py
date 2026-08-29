#!/usr/bin/env python3
"""
anime_client.py -- zero-dependency client for the watchanimeworld.one platform APIs.

Everything here was reverse-engineered from the live site (TaroFilm-style
WordPress + zephyrix player). No third-party packages required -- only urllib.

Endpoints covered (all verified live):
  * Search ............ GET  /?s=<query>                      (HTML scrape)
  * Feeds ............. POST /wp-admin/admin-ajax.php
                         action=action_tr_movie_category
                         (post=series|movies, category=<slug|all>,
                          mode=1 newest | 2 trending, limit, page)
  * Categories ........ GET  /wp-json/wp/v2/categories        (genre slugs)
  * Series detail ..... GET  /series/<slug>/                  (post_id + seasons)
  * Seasons ........... POST /wp-admin/admin-ajax.php
                         action=action_select_season           (episode links)
  * Episode stream .... POST https://play.zephyrix.org/player/index.php
                         ?data=<id>&do=getVideo                (signed m3u8 + poster)

If the domain ever moves, only SITE / PLAYER_HOST below need to change.
"""
import json
import re
import time
import urllib.parse
import urllib.request

# ----------------------------- config --------------------------------------
SITE = "https://watchanimeworld.one"
PLAYER_HOST = "play.zephyrix.org"
PLAYER = f"https://{PLAYER_HOST}"
AJAX = f"{SITE}/wp-admin/admin-ajax.php"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
REFERRER = f"{SITE}/"

# mode mapping for the homepage feed ajax
FEED_MODE = {
    "newest": ("series", "1"),   # latest arrivals / new drops
    "trending": ("series", "2"),  # popular / most-viewed analogue
    "movies": ("movies", "2"),    # movie listings
}


# ----------------------------- low-level http ------------------------------
def _http(url, headers=None, data=None, timeout=40, retries=4):
    """GET (data=None) or POST (data=dict form-body, or bytes raw body). Returns decoded text."""
    h = {"User-Agent": UA, "Accept": "*/*"}
    if headers:
        h.update(headers)
    if data is not None:
        if isinstance(data, dict):
            body = urllib.parse.urlencode(data).encode()
            h["Content-Type"] = "application/x-www-form-urlencoded"
        elif isinstance(data, (bytes, bytearray)):
            body = bytes(data)
        else:
            body = str(data).encode()
        h["X-Requested-With"] = "XMLHttpRequest"
        req = urllib.request.Request(url, data=body, headers=h, method="POST")
    else:
        req = urllib.request.Request(url, headers=h, method="GET")
    last = None
    for _ in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "ignore")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.2)
    raise last


def _post_form(url, fields, timeout=40):
    return _http(url, data=fields, timeout=timeout)


# ----------------------------- helpers -------------------------------------
def _tmdb(url, size="w500"):
    """Normalize a TMDB poster path to an absolute, size-selected URL."""
    if not url:
        return None
    if url.startswith("//"):
        url = "https:" + url
    return re.sub(r"/t/p/[^/]+/", f"/t/p/{size}/", url, count=1)


def _slug_title(slug):
    return slug.replace("-", " ").title()


# ----------------------------- public API ----------------------------------
def search(query, limit=20):
    """Search the site. Returns [{title, slug, url}]."""
    html = _http(f"{SITE}/?s={urllib.parse.quote(query)}")
    out, seen = [], set()
    for url, slug, txt in re.findall(
        r'href="(https://watchanimeworld\.one/series/([^"/]+)/)"[^>]*>(.*?)</a>',
        html, re.S | re.I,
    ):
        if slug in seen:
            continue
        seen.add(slug)
        title = re.sub(r"<[^>]+>", "", txt).strip() or _slug_title(slug)
        out.append({"title": title, "slug": slug, "url": url})
        if len(out) >= limit:
            break
    return out


def feed(kind="newest", category="all", page=1, limit=25):
    """
    Homepage-style feed.
      kind: 'newest' | 'trending' | 'movies'
      category: genre slug (from categories()) or 'all'
    Returns [{title, slug, url, poster}].
    """
    post, mode = FEED_MODE.get(kind, FEED_MODE["newest"])
    html = _post_form(AJAX, {
        "action": "action_tr_movie_category",
        "post": post, "category": category, "mode": mode,
        "limit": str(limit), "page": str(page),
    })
    links = re.findall(r'href="(https://watchanimeworld\.one/(?:series|movies)/([^"/]+)/)"', html)
    imgs = re.findall(r'src="(//image\.tmdb\.org/[^"]+)"', html)
    out, seen = [], set()
    for i, (url, slug) in enumerate(links):
        if slug in seen:
            continue
        seen.add(slug)
        poster = _tmdb(imgs[i]) if i < len(imgs) else None
        out.append({"title": _slug_title(slug), "slug": slug,
                    "url": url, "poster": poster})
    return out


def categories(per_page=100):
    """List genre/category slugs usable as feed(category=...)."""
    try:
        data = json.loads(_http(f"{SITE}/wp-json/wp/v2/categories?per_page={per_page}"))
        return [{"name": c.get("name"), "slug": c.get("slug")} for c in data]
    except Exception:  # noqa: BLE001
        return []


def series(slug):
    """Series detail: post_id, seasons, title."""
    html = _http(f"{SITE}/series/{slug}/")
    m = re.search(r'data-post="(\d+)"', html) or re.search(r'postid-(\d+)', html)
    post_id = m.group(1) if m else None
    seasons = sorted({int(s) for s in re.findall(r'data-season="(\d+)"', html)}) or [1]
    t = re.search(r"<title>([^<]+)</title>", html)
    title = (t.group(1).split(" - ")[0].strip() if t else _slug_title(slug)) or _slug_title(slug)
    return {"slug": slug, "title": title, "post_id": post_id, "seasons": seasons}


def episodes(post_id, season):
    """Episodes for a season. Returns [{season, episode, slug, url}]."""
    html = _post_form(AJAX, {
        "action": "action_select_season", "season": str(season), "post": str(post_id),
    })
    out = []
    for full, slug in re.findall(r'href="(https://[^"]*?/episode/([^"/]+)/)"', html):
        m = re.search(r"(\d+)x(\d+)", slug)
        if m:
            out.append({"season": int(m.group(1)), "episode": int(m.group(2)),
                        "slug": slug, "url": full})
    out.sort(key=lambda e: (e["season"], e["episode"]))
    return out


def all_seasons(post_id, seasons):
    """Map every season -> its episode list."""
    return {s: episodes(post_id, s) for s in seasons}


def episode_player_id(episode_url):
    """Extract the zephyrix player id from an episode page."""
    html = _http(episode_url, headers={"Referer": REFERRER})
    m = re.search(re.escape(PLAYER_HOST) + r"/video/([a-f0-9]+)", html)
    if not m:
        raise RuntimeError(f"player id not found on {episode_url}")
    return m.group(1)


def episode_stream(episode_url=None, player_id=None):
    """
    Get the playable stream for an episode.
    Returns {player_id, hls, video_source, secured_link, poster}.
    secured_link is a signed m3u8 (md5+expires) -- fetch it promptly.
    """
    pid = player_id or episode_player_id(episode_url)
    # The zephyrix player expects data/do in the QUERY STRING with an empty POST
    # body (sending them as a form body returns HTTP 502).
    url = f"{PLAYER}/player/index.php?data={pid}&do=getVideo"
    raw = _http(url, headers={"Referer": f"{PLAYER}/", "Origin": f"{PLAYER}/",
                              "X-Requested-With": "XMLHttpRequest"},
                data=b"", timeout=30)
    data = json.loads(raw)
    return {
        "player_id": pid,
        "source_url": episode_url,
        "hls": data.get("hls"),
        "video_source": data.get("videoSource"),
        "secured_link": data.get("securedLink"),
        "poster": data.get("videoImage"),
        "download_links": data.get("downloadLinks"),
    }


def master_playlist(secured_link):
    """Fetch the master.m3u8 text for an episode (quality variants inside)."""
    return _http(secured_link, headers={"Referer": f"{PLAYER}/"}, timeout=30)


if __name__ == "__main__":
    import pprint
    print("SEARCH 'elusive samurai':")
    pprint.pprint(search("elusive samurai")[:3])
    print("\nFEED newest (page1):")
    pprint.pprint(feed("newest", limit=3))
    print("\nFEED trending (page1):")
    pprint.pprint(feed("trending", limit=3))
