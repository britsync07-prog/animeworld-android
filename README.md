# watchanimeworld Platform Clone — API + Scaffold

A complete, **verified** blueprint for cloning `watchanimeworld.one`: every real
API the site exposes, a zero-dependency Python client (`anime_client.py`), a
runnable JSON API server (`server/app.py`), an OpenAPI spec, and live tests.

> All endpoints were reverse-engineered from the live site and tested against it.
> If the domain moves, only `SITE` / `PLAYER_HOST` in `anime_client.py` change.

## Folder structure
```
D:\myapps\anime\
├── README.md              # this file
├── anime_client.py        # zero-dep SDK wrapping every upstream API
├── openapi.yaml           # OpenAPI 3 spec for the /api/v1 layer
├── docs/
│   └── API.md             # full endpoint reference (raw + wrapped)
├── server/
│   └── app.py             # runnable REST API server (stdlib only)
└── tests/
    └── test_client.py     # live verification against the real site
```

## Quickstart
```bash
# 1) run the API server (binds 0.0.0.0:<port>)
cd D:\myapps\anime
python server/app.py 8080

# 2) call it
curl "http://127.0.0.1:8080/api/v1/feed?type=newest&limit=5"
curl "http://127.0.0.1:8080/api/v1/search?q=naruto"
curl "http://127.0.0.1:8080/api/v1/series?slug=the-elusive-samurai"
curl "http://127.0.0.1:8080/api/v1/seasons?slug=the-elusive-samurai"
curl "http://127.0.0.1:8080/api/v1/episodes?slug=the-elusive-samurai&season=1"
curl "http://127.0.0.1:8080/api/v1/stream?slug=the-elusive-samurai-1x1"
```

## The website (front-end)
`server/app.py` also serves a ready-made anime site from `web/` on the same
origin, so there is no CORS and no second server to run.

- Open **http://127.0.0.1:8080/** after starting the server below.
- Pages (hash-routed SPA, no build step):
  - `#/` Home — Trending / Newest / Movies rows with posters
  - `#/series/<slug>` — poster, season tabs, episode grid
  - `#/episode/<slug>` — native video player + Prev/Next/Series nav
  - `#/watch?url=<movie url>` — movie player
  - `#/genres`, `#/genre/<slug>`, `#/search?q=...`
  - `#/downloads` — your offline library; `#/offline/<id>` — play a saved episode
- **Audio / Language + Subtitles**: under the player there is an *Audio / Language*
  dropdown (Japanese / English / Telugu / Tamil / Hindi — the source's real audio
  dubs) and a *Subtitles* dropdown (disabled when a title has no subtitle tracks).
  Switching audio reloads that language's audio stream live through the proxy.
- **Offline download**: every episode/movie has a *Download for offline* button.
  It saves the full HLS set (a ~720p video variant + all audio tracks + every
  segment) into the browser's Cache Storage via the Service Worker, and records
  metadata in IndexedDB. Open `#/downloads`, tap **Play** to watch with no network
  (the Service Worker serves the cached segments, range-aware). Delete frees space.
- Video plays via **hls.js** through the same-origin HLS proxy (`/api/v1/hls`); the
  Service Worker (`web/sw.js`) caches the app shell and the offline HLS segments.
  The proxy fetches the zephyrix m3u8 + segment CDN and rewrites every URI so the
  browser loads it same-origin (the zephyrix player page blocks iframing via CSP
  `frame-ancestors`, and the CDNs send no CORS headers, so the iframe approach
  cannot work on a clone).
- `web/app.js` is plain JS (no framework); `web/style.css` is a dark anime theme;
  `web/hls.min.js` is the bundled hls.js player; `web/download.js` is the offline
  download manager; `web/sw.js` is the Service Worker; `web/manifest.webmanifest`
  + `web/icon.svg` make it an installable PWA.

> If port 8000 is already taken by a stale server, run on another port:
> `python server/app.py 8080` and open http://127.0.0.1:8080/

## Mobile app (phone)
The `web/` site is already an **installable PWA** — on a phone, open the URL in
Chrome/Safari and choose *Add to Home Screen*; it installs as a standalone app with
offline support. No app store needed. For a **native Android/iOS binary**, the
`web/` folder is wrapped with Capacitor (Apache-2.0, open source) under `mobile/`:

```bash
cd D:\myapps\anime\mobile
npm install                 # installs @capacitor/cli + platform packages
npx cap add android        # (or: npx cap add ios)
npx cap sync               # copies ../web into the native project
npx cap build android      # => APK/AAB  (needs Android SDK / Android Studio)
# npx cap build ios        # => IPA      (needs Xcode, macOS)
```

## Using the API on your phone
The API server binds `0.0.0.0`, so any device on the **same Wi-Fi** as the machine
running it can reach it via that machine's LAN IP, e.g. `http://192.168.1.50:8080/`.
To use it from a phone on a different network, host the server on a VPS / a tunneling
service (e.g. Cloudflare Tunnel) and point the app at that URL. Endpoints:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/health` | liveness |
| `GET /api/v1/search?q=` | search series by name |
| `GET /api/v1/feed?type=&category=&page=&limit=` | newest / trending / movies + genre filter |
| `GET /api/v1/categories` | genre slugs |
| `GET /api/v1/series?slug=` | post_id + seasons |
| `GET /api/v1/seasons?slug=` | all seasons → episodes |
| `GET /api/v1/episodes?slug=&season=` | one season's episodes |
| `GET /api/v1/stream?slug=` | signed m3u8 + poster (also `?url=` for movies) |
| `GET /api/v1/hls?url=<encoded upstream m3u8>` | HLS proxy (master/variant/segment) |

## Run it without your PC (always-on backend)
The phone app talks to a server that proxies `watchanimeworld.one` and rewrites the
HLS streams (the upstream CDNs block direct browser access). To use the app **without
leaving your PC on**, host that server somewhere always-on. The app uses same-origin
relative URLs, so once it is served from the hosted URL it just works — no app changes
and no config.

**Free deploy (Render):**
1. Push this `D:\myapps\anime` folder to a GitHub repo.
2. On https://render.com → *New* → *Web Service* → connect the repo. Render
   auto-detects `render.yaml` (or set: Runtime = Python, Build = `pip install -r
   requirements.txt`, Start = `python server/app.py`). Render supplies `$PORT`.
3. You get a URL like `https://animeworld-xxxx.onrender.com`.
4. On your phone, open that URL in Chrome/Safari → *Add to Home Screen*. That is your
   phone app. Browse, stream, and **download-for-offline** all work with your PC off.

(Any host works: Railway, Fly.io, PythonAnywhere, or a VPS running
`python server/app.py`. Free tiers may spin down when idle — the first request after a
pause takes a few seconds to wake. `Procfile`, `render.yaml`, and `requirements.txt`
are included for this.)

**Truly self-contained on the phone (no server anywhere):** the `mobile/` Capacitor
project could embed a tiny local HTTP server so the proxy runs *inside* the native app.
That requires a native build (`npx cap build android`, needs Android Studio) and a
small local-server plugin — a follow-up step. For almost everyone the free cloud
deploy above is the simplest "no PC" solution.

## Backend inside the phone app (no server anywhere)
For a single installable app where the backend runs *inside* the app itself — no PC,
no cloud — see `android-app/` (a Chaquopy Android project that bundles this exact
Python server; the WebView talks to a localhost server the app starts on launch).
See `android-app/README.md` for build steps. (The embedded backend was verified
end-to-end on localhost.)

## Build your own platform on top
1. **Backend** — run `server/app.py` (or port it to FastAPI/Express). It already
   proxies search, feeds (newest/trending/movies), categories, series, seasons,
   episodes, and the signed stream URL. No video is hosted by you.
2. **Frontend** — any SPA (React/Vue/Svelte). Use the endpoints above to render
   home/browse/search/series/episode pages. For playback, point **hls.js** (or a
   native `<video>` with HLS support) at `secured_link` from `/api/v1/stream`,
   and use `poster` as the thumbnail. Re-fetch the stream per playback start
   because the signed link expires.
3. **Images** — posters come from TMDB (`image.tmdb.org`, request `w500`/
   `original`); episode thumbs from `poster` in the stream response. Proxy or
   hot-link them (respect hot-link/bandwidth limits).
4. **Your own DB (optional)** — cache series/episode metadata from the APIs into
   Postgres/Mongo so you're not hammering the upstream on every page view.

## API surface (summary)
| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/health` | liveness |
| `GET /api/v1/search?q=` | search series by name |
| `GET /api/v1/feed?type=&category=&page=&limit=` | newest / trending / movies + genre filter |
| `GET /api/v1/categories` | genre slugs |
| `GET /api/v1/series?slug=` | post_id + seasons |
| `GET /api/v1/seasons?slug=` | all seasons → episodes |
| `GET /api/v1/episodes?slug=&season=` | one season's episodes |
| `GET /api/v1/stream?slug=` | signed m3u8 + poster |

See `docs/API.md` for the **raw upstream** requests (admin-ajax actions,
WordPress search, the zephyrix player `getVideo` call) so you understand exactly
what the server proxies.

## Tests
```bash
python tests/test_client.py     # hits the live site, asserts each API
```

## Tests
- `python tests/test_client.py` — live verification of the API client (search,
  feeds, categories, series→seasons→episodes→stream). Requires internet.
- `node tests/test_frontend.js` — loads the REAL `web/app.js` against a DOM/fetch
  shim and drives every route (home, series, episode, watch, genres, search),
  asserting the rendered HTML. Successful API responses are cached to
  `tests/.api_cache.json` on first run so the front-end suite is deterministic;
  the warmup phase fetches them gently (spaced) to avoid tripping the upstream
  rate limiter. Requires the server running (`python server/app.py 8080`) and
  Node.js.

## Notes / honest limitations
- The site has **no literal "Most Liked" feed** — `feed?type=trending` (mode=2)
  is the popularity analogue. "Newest arrived" / "New drop" = `feed?type=newest`
  (mode=1). "Latest Anime Movies" = `feed?type=movies`.
- `secured_link` is signed + expiring; re-request it when playback starts.
- No subtitle API exists upstream (returns 502).
- Upstream is Cloudflare-fronted and rate-limited; `anime_client` retries 4x.
- Downloading full files is handled separately by `anime_dl_v2.py`
  (Python pulls segments with the Referer, ffmpeg muxes to .mkv).
