# watchanimeworld Platform API Reference

This document describes **every real API** the source site
(`watchanimeworld.one`, a TaroFilm-style WordPress + zephyrix player) exposes,
reverse-engineered and verified live. It then documents the clean JSON API
layer we built on top of it (`server/app.py` + `anime_client.py`) so you can
clone the platform.

> If the domain moves, only `SITE` / `PLAYER_HOST` in `anime_client.py` need to
> change. Everything else is derived.

---

## 1. Raw upstream APIs (what the site actually uses)

### 1.1 Search
```
GET https://watchanimeworld.one/?s=<urlencoded query>
```
- Returns **HTML**. Parse `/series/<slug>/` links.
- WordPress REST `/wp-json/wp/v2/search` does **not** index series posts, so the
  front-end search (`/?s=`) is the only working search.

### 1.2 Homepage feeds (the "Newest / Drops / Trending" widgets)
```
POST https://watchanimeworld.one/wp-admin/admin-ajax.php
Content-Type: application/x-www-form-urlencoded
action=action_tr_movie_category
post=series|movies
category=<slug|all>
mode=1|2
limit=<n>
page=<n>
```
- Returns **HTML cards**. Each card has a poster (`//image.tmdb.org/...`) and a
  `/series/<slug>/` link.
- `mode=1` → **newest / latest arrivals / new drops**.
- `mode=2` → **trending / popular** (the closest thing to a "most liked" feed —
  the site has **no literal "Most Liked" section**; use `mode=2`).
- `post=movies` → movie listings.
- `category=<slug>` filters by genre (slugs from `GET /wp-json/wp/v2/categories`).

### 1.3 Categories / genres
```
GET https://watchanimeworld.one/wp-json/wp/v2/categories?per_page=100
```
- Returns `[{name, slug, ...}]`. Use `slug` as the `category=` value in 1.2.

### 1.4 Series detail
```
GET https://watchanimeworld.one/series/<slug>/
```
- `post_id`: regex `data-post="(\d+)"` OR body class `postid-(\d+)`.
- seasons: all `data-season="(\d+)"` attributes (default `[1]`).
- title: `<title>` (strip " - ...").

### 1.5 Seasons -> episodes
```
POST https://watchanimeworld.one/wp-admin/admin-ajax.php
action=action_select_season
season=<n>
post=<post_id>
```
- Returns HTML with `/episode/<slug>/` links. Episode number is parsed from the
  slug via `(\d+)x(\d+)` (e.g. `the-elusive-samurai-1x1` → season 1, ep 1).

### 1.6 Episode -> player id
```
GET https://watchanimeworld.one/episode/<slug>/
```
- Player id: regex `play.zephyrix.org/video/([a-f0-9]+)`.

### 1.7 Stream (the player)
```
POST https://play.zephyrix.org/player/index.php?data=<player_id>&do=getVideo
Referer: https://play.zephyrix.org/
Origin:  https://play.zephyrix.org/
X-Requested-With: XMLHttpRequest
```
- **Params go in the QUERY STRING with an empty POST body** (a form body returns
  HTTP 502).
- Response JSON:
  ```json
  {
    "hls": true,
    "videoSource": "https://play.zephyrix.org/cdn/hls/<id>/master.txt",
    "securedLink": "https://play.zephyrix.org/cdn/hls/<id>/master.m3u8?md5=...&expires=...",
    "videoImage": "https://s11.zn-gridXX.top/f/<...>.jpg",
    "downloadLinks": [],
    "attachmentLinks": []
  }
  ```
- `securedLink` is a **signed m3u8** (md5 + expires). Fetch it promptly; it has a
  validity window. `videoImage` is the episode poster/thumbnail.

### 1.8 Images
- **Posters**: TMDB CDN — `//image.tmdb.org/t/p/w185|w500|w780|original/<path>.jpg`
  (from feed/series cards). Request `w500`/`original` for HD.
- **Episode thumb**: `videoImage` from 1.7 (zephyrix CDN).
- **Site assets**: `https://watchanimeworld.one/wp-content/uploads/...`.

---

## 2. Clean platform API (what we expose)

Implemented in `server/app.py` (stdlib only) on top of `anime_client.py`.
All endpoints are `GET`, return JSON, and send CORS `*` headers.

| Method | Path | Params | Returns |
|--------|------|--------|---------|
| GET | `/api/v1/health` | – | `{status, site, player}` |
| GET | `/api/v1/search` | `q`, `limit` | `[{title, slug, url}]` |
| GET | `/api/v1/feed` | `type=newest\|trending\|movies`, `category`, `page`, `limit` | `[{title, slug, url, poster}]` |
| GET | `/api/v1/categories` | `per_page` | `[{name, slug}]` |
| GET | `/api/v1/series` | `slug` | `{slug, title, post_id, seasons}` |
| GET | `/api/v1/seasons` | `slug` | `{slug, title, seasons:{<n>:[episodes]}}` |
| GET | `/api/v1/episodes` | `slug`, `season` | `[{season, episode, slug, url}]` |
| GET | `/api/v1/stream` | `slug` **or** `url` **or** `series`+`season`+`episode` | `{player_id, hls, video_source, secured_link, poster, download_links}` |

Example responses are shown in `README.md` and via the running server.

### Streaming in your front-end
Point an `<video>` / hls.js at `secured_link` (a standard HLS m3u8). Use `poster`
for the thumbnail. The signed link expires, so re-request `/api/v1/stream` when
playback starts (don't cache it long-term).

---

## 3. Data models (JSON)
```jsonc
Series   : { "slug", "title", "post_id", "seasons": [int] }
Episode  : { "season": int, "episode": int, "slug", "url" }
FeedItem : { "title", "slug", "url", "poster" }
Stream   : { "player_id", "hls": bool, "video_source", "secured_link",
             "poster", "download_links" }
```

## 4. Known limitations
- `secured_link` is signed + expiring; the server returns it fresh each call.
- The site has **no** subtitle API (all `do=getSubtitle` etc. return 502).
- Category archive pages (`/category/<slug>/`) are unreliable; use the feed
  `category=` filter instead.
- The upstream is rate-limited / Cloudflare-fronted; `anime_client` retries 4x.
