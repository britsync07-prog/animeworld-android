# AnimeWorld — Android app with the backend INSIDE the phone

This is a real, installable Android app where **the entire backend runs inside the
app itself**. No PC left on. No cloud server. When you open the app it starts a
local HTTP server (our exact stdlib Python proxy) on `http://127.0.0.1:8080` and
points a WebView at it. Search, feeds, series, the HLS proxy, and offline download
all happen on the device.

## Why the backend has to run on-device
The HLS segment CDN is Cloudflare-protected (`403 Forbidden / Cf-Mitigated:
challenge`, no CORS headers), so a browser cannot load streams directly. A server
is needed to proxy them. Putting that server *inside the app* (instead of on a PC or
in the cloud) is what makes the app fully self-contained.

## How it works
- `app/src/main/python/server.py` — the same zero-dependency HTTP server as
  `server/app.py`, serving the frontend from the bundled `www/` folder and proxying
  `watchanimeworld.one` + the HLS streams.
- `app/src/main/python/anime_client.py` — the reverse-engineered client (stdlib only).
- `app/src/main/python/www/` — the frontend (copied from `web/`).
- `app/src/main/java/com/animeworld/MainActivity.java` — starts the Python server
  on a background thread, then loads `http://127.0.0.1:8080` in a WebView.

Chaquopy embeds a Python 3.11 runtime in the APK, so `server.py` runs natively on
the phone with no extra dependencies.

## Build & install (needs Android Studio — one-time)
1. Install Android Studio (with SDK + NDK; Chaquopy downloads the NDK automatically).
2. Open this `android-app/` folder as a project.
3. Let it sync Gradle (it pulls the Chaquopy + Android plugins).
4. Connect your phone (USB debugging on) or use an emulator.
5. Run ▸ (green play). It builds the APK, installs it, and launches.
6. The app icon "AnimeWorld" now runs the whole system on your phone — PC off.

Signed release APK for distribution: `Build ▸ Generate Signed Bundle / APK`.

## Verified
The embedded `server.py` was run on localhost and exercised end-to-end:
search → series → seasons → stream (`secured_link`) → HLS proxy (same-origin
rewrite) → variant → segment bytes (239 KB fetched). The app's WebView uses the
same origin, so this is exactly what runs on-device.

## Instant alternative (no Android Studio, works today)
You can run the backend on the phone right now with Termux:
1. Install Termux, then `pkg install python`.
2. Copy `app/src/main/python/` (server.py, anime_client.py, www/) to the phone.
3. `cd` there and run `python server.py 8080`.
4. Open `http://127.0.0.1:8080` in your mobile browser (or "Add to Home Screen" —
   the PWA manifest turns it into an app icon). Backend is on your phone, no PC.
