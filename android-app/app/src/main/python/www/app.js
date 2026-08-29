// AnimeWorld front-end (hash-routed SPA). Talks to /api/v1 (same origin).
const API = "/api/v1";
const PLAYER = "https://play.zephyrix.org";
const $app = document.getElementById("app");
const $form = document.getElementById("searchForm");
const $input = document.getElementById("searchInput");

function esc(s) {
  return (s == null ? "" : String(s)).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function apiGet(path) {
  const r = await fetch(API + path, { headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

function setLoading(m) { $app.innerHTML = `<div class="center">${esc(m || "Loading...")}</div>`; }
function setError(e) { $app.innerHTML = `<div class="center error">Error: ${esc(e.message || e)}</div>`; }

function dlStatusText(st) {
  if (st.active === 0 && st.queued === 0) return "No active downloads.";
  let s = `Active: ${st.active}`;
  if (st.activeTitles.length) s += " (" + st.activeTitles.join(", ") + ")";
  if (st.queued > 0) s += ` · Queued: ${st.queued}`;
  return s;
}

function playerHTML(poster, src, originalUrl) {
  const proxied = src ? "/api/v1/hls?url=" + encodeURIComponent(src) : "";
  const fallback = originalUrl
    ? `<p class="muted">If the player doesn't start, <a href="${esc(originalUrl)}" target="_blank" rel="noopener">open the original &#8599;</a>.</p>`
    : "";
  return `<div class="player">
      <video id="player" controls playsinline ${poster ? `poster="${esc(poster)}"` : ""} ${proxied ? `data-hls="${esc(proxied)}"` : ""}></video>
    </div>
    <div class="track-controls" id="trackControls">
      <label>Audio / Language
        <select id="audioTrack"><option value="">Loading…</option></select>
      </label>
      <label>Subtitles
        <select id="subTrack"><option value="-1">Off</option></select>
      </label>
    </div>
    <div class="dl-bar">
      <button id="dlBtn" class="btn">&#11015; Download for offline</button>
      <button id="fsBtn" class="btn">&#9974; Fullscreen</button>
      <button id="extBtn" class="btn">&#9658;&#65039; External player</button>
      <span id="dlProg" class="muted"></span>
    </div>
    ${fallback}`;
}

// hls.js exposes the current audio/subtitle track setter under different names
// across versions ("audioTrack" vs "currentAudioTrack"); detect at runtime.
function _hlsAudioProp(hls) {
  if (!hls) return null;
  if ("currentAudioTrack" in hls) return "currentAudioTrack";
  if ("audioTrack" in hls) return "audioTrack";
  return null;
}
function _hlsSubProp(hls) {
  if (!hls) return null;
  if ("currentSubtitleTrack" in hls) return "currentSubtitleTrack";
  if ("subtitleTrack" in hls) return "subtitleTrack";
  return null;
}

function setupTracks(video, hls) {
  const audioSel = document.getElementById("audioTrack");
  const subSel = document.getElementById("subTrack");
  const box = document.getElementById("trackControls");
  if (!audioSel || !subSel || !box) return;

  const aProp = _hlsAudioProp(hls);
  const sProp = _hlsSubProp(hls);

  // ---- Audio / language (dub) tracks ----
  let audios = [];
  if (hls && hls.audioTracks) audios = hls.audioTracks;
  else if (video.audioTracks) audios = Array.from(video.audioTracks);
  if (audios.length) {
    audioSel.innerHTML = audios.map((t, i) =>
      `<option value="${i}">${esc(t.name || t.label || (t.language ? t.language.toUpperCase() : "Track " + i))}</option>`
    ).join("");
    const cur = (aProp && hls[aProp] != null) ? hls[aProp]
              : (video.audioTracks ? Array.from(video.audioTracks).findIndex(t => t.enabled) : 0);
    if (cur >= 0) audioSel.value = String(cur);
    audioSel.disabled = false;
    audioSel.onchange = () => {
      const i = parseInt(audioSel.value, 10);
      if (aProp) hls[aProp] = i;
      else if (video.audioTracks) Array.from(video.audioTracks).forEach((t, k) => { t.enabled = (k === i); });
    };
  } else {
    audioSel.innerHTML = `<option value="-1">No audio tracks</option>`;
    audioSel.disabled = true;
  }

  // ---- Subtitle tracks (only shown if the manifest actually exposes any) ----
  let subs = [];
  if (hls && hls.subtitleTracks) subs = hls.subtitleTracks;
  else if (video.textTracks) subs = Array.from(video.textTracks);
  if (subs.length) {
    subSel.disabled = false;
    subSel.innerHTML = `<option value="-1">Off</option>` + subs.map((t, i) =>
      `<option value="${i}">${esc(t.name || t.label || (t.language ? t.language.toUpperCase() : "Sub " + i))}</option>`
    ).join("");
    subSel.onchange = () => {
      const i = parseInt(subSel.value, 10);
      if (sProp) { hls[sProp] = i; if ("subtitleDisplay" in hls) hls.subtitleDisplay = (i !== -1); }
      else if (video.textTracks) Array.from(video.textTracks).forEach((t, k) => { t.mode = (k === i ? "showing" : "disabled"); });
    };
  } else {
    subSel.innerHTML = `<option value="-1">Off</option>`;
    subSel.disabled = true;
  }
  box.hidden = false;
}

function initPlayer(video, src) {
  if (!video || !src) return;
  const proxied = "/api/v1/hls?url=" + encodeURIComponent(src);
  if (window.Hls && window.Hls.isSupported()) {
    try {
      const hls = new window.Hls();
      hls.loadSource(proxied);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => { setupTracks(video, hls); video.play().catch(() => {}); });
      hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, () => setupTracks(video, hls));
      hls.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, () => setupTracks(video, hls));
      hls.on(window.Hls.Events.ERROR, (evt, data) => {
        if (data && data.fatal && video.insertAdjacentHTML) {
          video.insertAdjacentHTML("afterend",
            `<p class="muted">Playback error &mdash; <a href="${esc(src)}" target="_blank" rel="noopener">open original &#8599;</a>.</p>`);
        }
      });
      return;
    } catch (e) { /* fall through to native HLS */ }
  }
  if (video.canPlayType && video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = proxied;
    video.addEventListener("loadedmetadata", () => { setupTracks(video, null); video.play().catch(() => {}); });
  }
}

// ---- Fullscreen + external-player helpers ----
function enterFullscreen() {
  const v = document.getElementById("player");
  if (!v) return;
  try {
    if (v.requestFullscreen) { v.requestFullscreen(); return; }
  } catch (e) {}
  try {
    if (v.webkitEnterFullscreen) { v.webkitEnterFullscreen(); return; }
  } catch (e) {}
  try {
    if (v.webkitRequestFullscreen) { v.webkitRequestFullscreen(); }
  } catch (e) {}
}

async function openExternal(masterRaw) {
  if (!masterRaw) return;
  try {
    const r = await fetch("/api/v1/ext_url?url=" + encodeURIComponent(masterRaw));
    const j = await r.json();
    if (!j.url) throw new Error("no url");
    if (window.AnimeBridge && window.AnimeBridge.openExternal) {
      window.AnimeBridge.openExternal(j.url);
    } else {
      // Outside the Android app (e.g. desktop) there is no chooser; just open it.
      location.href = j.url;
    }
  } catch (e) {
    alert("Could not open external player: " + (e.message || e));
  }
}

function wireFs(fsId) {
  const b = document.getElementById(fsId);
  if (b) b.addEventListener("click", enterFullscreen);
}
function wireExt(extId, masterRaw) {
  const b = document.getElementById(extId);
  if (b) b.addEventListener("click", () => openExternal(masterRaw));
}

function cardHTML(item, kind) {
  const poster = item.poster
    ? `<img loading="lazy" src="${esc(item.poster)}" alt="${esc(item.title)}">`
    : `<div class="ph">no image</div>`;
  const href = kind === "movie"
    ? `#/watch?url=${encodeURIComponent(item.url)}`
    : `#/series/${esc(item.slug)}`;
  return `<a class="card" href="${href}">
      <div class="thumb">${poster}</div>
      <div class="cap">${esc(item.title)}</div>
    </a>`;
}

function row(title, items, kind) {
  const cards = items.map(it => cardHTML(it, kind)).join("");
  return `<section class="row"><h2>${esc(title)}</h2><div class="grid">${cards}</div></section>`;
}

async function home() {
  setLoading("Loading home...");
  try {
    const [trending, newest, movies] = await Promise.all([
      apiGet("/feed?type=trending&limit=12"),
      apiGet("/feed?type=newest&limit=12"),
      apiGet("/feed?type=movies&limit=12"),
    ]);
    $app.innerHTML =
      row("Trending", trending, "series") +
      row("Newest Arrivals", newest, "series") +
      row("Latest Anime Movies", movies, "movie");
  } catch (e) { setError(e); }
}

async function feedPage(type) {
  setLoading("Loading...");
  const titles = { newest: "Newest Arrivals", trending: "Trending", movies: "Anime Movies" };
  try {
    const items = await apiGet(`/feed?type=${type}&limit=36`);
    $app.innerHTML = row(titles[type] || type, items, type === "movies" ? "movie" : "series");
  } catch (e) { setError(e); }
}

async function searchPage(q) {
  setLoading("Searching...");
  try {
    const items = await apiGet("/search?q=" + encodeURIComponent(q));
    if (!items.length) $app.innerHTML = `<div class="center">No results for "${esc(q)}"</div>`;
    else $app.innerHTML = row('Results for "' + esc(q) + '"', items, "series");
  } catch (e) { setError(e); }
}

async function seriesPage(slug) {
  setLoading("Loading series...");
  try {
    const data = await apiGet("/seasons?slug=" + encodeURIComponent(slug));
    const seasons = data.seasons || {};
    const nums = Object.keys(seasons).map(Number).sort((a, b) => a - b);
    if (!nums.length) { setError(new Error("No seasons found")); return; }
    let html = `<section class="detail"><h1>${esc(data.title)}</h1><div class="season-tabs">`;
    nums.forEach((s, i) => { html += `<button class="tab${i === 0 ? " active" : ""}" data-s="${s}">Season ${s}</button>`; });
    html += `</div><div class="ep-grid" id="epGrid"></div></section>`;
    $app.innerHTML = html;

    const renderSeason = (s) => {
      const grid = document.getElementById("epGrid");
      const eps = seasons[s] || [];
      grid.innerHTML = eps.map(ep =>
        `<a class="ep" href="#/episode/${esc(ep.slug)}">
           <span class="ep-no">S${ep.season}E${ep.episode}</span>
           <span class="ep-title">Episode ${ep.episode}</span>
         </a>`).join("");
    };
    renderSeason(nums[0]);
    $app.querySelectorAll(".tab").forEach(btn => {
      btn.addEventListener("click", () => {
        $app.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        renderSeason(btn.dataset.s);
      });
    });
  } catch (e) { setError(e); }
}

async function episodePage(slug) {
  setLoading("Loading episode...");
  try {
    const st = await apiGet("/stream?slug=" + encodeURIComponent(slug));
    // Render the player IMMEDIATELY so playback isn't blocked by the nav lookup.
    $app.innerHTML = `<section class="watch">
        <h1>Episode ${esc(slug)}</h1>
        ${playerHTML(st.poster, st.video_source, st.source_url)}
        <div class="epinav" id="epinav"></div>
      </section>`;
    initPlayer(document.getElementById("player"), st.video_source);
    wireDownload("dlBtn", "dlProg", slug, "Episode " + slug, st.poster, st.video_source);
    wireFs("fsBtn");
    wireExt("extBtn", st.video_source);
    // Prev/Next/Series nav loads separately (non-blocking).
    const m = slug.match(/^(.*)-\d+x\d+$/);
    const seriesSlug = m ? m[1] : null;
    if (seriesSlug) {
      apiGet("/seasons?slug=" + encodeURIComponent(seriesSlug)).then(sd => {
        const all = [];
        Object.keys(sd.seasons).map(Number).sort((a, b) => a - b)
          .forEach(s => (sd.seasons[s] || []).forEach(e => all.push(e)));
        const idx = all.findIndex(e => e.slug === slug);
        let nav = `<a class="navlink" href="#/series/${esc(seriesSlug)}">&#8592; Series</a>`;
        if (idx > 0) { const p = all[idx - 1]; nav += `<a class="navlink" href="#/episode/${esc(p.slug)}">&#8592; Prev</a>`; }
        if (idx >= 0 && idx < all.length - 1) { const n = all[idx + 1]; nav += `<a class="navlink" href="#/episode/${esc(n.slug)}">Next &#8594;</a>`; }
        const box = document.getElementById("epinav");
        if (box) box.innerHTML = nav;
      }).catch(() => {});
    }
  } catch (e) { setError(e); }
}

async function watchPage(url) {
  setLoading("Loading...");
  try {
    const st = await apiGet("/stream?url=" + encodeURIComponent(url));
    $app.innerHTML = `<section class="watch">
        <h1>Movie</h1>
        ${playerHTML(st.poster, st.video_source, st.source_url || url)}
      </section>`;
    initPlayer(document.getElementById("player"), st.video_source);
    wireDownload("dlBtn", "dlProg", url, "Movie", st.poster, st.video_source);
    wireFs("fsBtn");
    wireExt("extBtn", st.video_source);
  } catch (e) { setError(e); }
}

function wireDownload(btnId, progId, id, title, poster, masterRaw) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const prog = document.getElementById(progId);
    try {
      if (prog) prog.textContent = "Queued…";
      const r = await Downloads.enqueue(id, title, poster, masterRaw, (d, t) => {
        if (prog) prog.textContent = `Downloading ${d}/${t}`;
      });
      if (prog) prog.textContent = r.already ? "Already saved ✓" : `Saved offline ✓ (${r.segments} files)`;
    } catch (e) {
      if (prog) prog.textContent = "Download failed: " + (e.message || e);
      btn.disabled = false;
    }
  });
}

async function downloadsPage() {
  setLoading("Loading downloads...");
  try {
    const items = await Downloads.list();
    const st = Downloads.status();
    if (!items.length && st.active === 0 && st.queued === 0) {
      $app.innerHTML = `<div class="center">No downloads yet.<br>Open an episode or movie and tap <b>Download for offline</b>.</div>`;
      return;
    }
    let html = `<section class="row"><h2>Your Downloads</h2>`;
    html += `<p class="muted">${dlStatusText(st)}</p>`;
    html += `<div class="grid">`;
    items.forEach(it => {
      html += `<div class="card">
        <div class="thumb">${it.poster ? `<img loading="lazy" src="${esc(it.poster)}" alt="">` : `<div class="ph">no image</div>`}</div>
        <div class="cap">${esc(it.title)}</div>
        <div class="dl-actions">
          <a class="navlink" href="#/offline/${encodeURIComponent(it.id)}">Play</a>
          <button class="navlink ext" data-raw="${esc(it.masterRaw)}">Open with</button>
          <button class="navlink del" data-id="${esc(it.id)}">Delete</button>
        </div>
      </div>`;
    });
    html += `</div></section>`;
    $app.innerHTML = html;
    $app.querySelectorAll(".del").forEach(b => b.addEventListener("click", async () => {
      await Downloads.remove(b.dataset.id);
      downloadsPage();
    }));
    $app.querySelectorAll(".ext").forEach(b => b.addEventListener("click", () => openExternal(b.dataset.raw)));
  } catch (e) { setError(e); }
}

async function offlinePage(id) {
  setLoading("Loading...");
  try {
    const it = await Downloads.get(id);
    if (!it) { setError(new Error("Not downloaded")); return; }
    $app.innerHTML = `<section class="watch">
        <h1>${esc(it.title)}</h1>
        ${playerHTML(it.poster, it.masterRaw, "")}
      </section>`;
    initPlayer(document.getElementById("player"), it.masterRaw);
    wireFs("fsBtn");
    wireExt("extBtn", it.masterRaw);
  } catch (e) { setError(e); }
}

async function genresPage() {
  setLoading("Loading genres...");
  try {
    const cats = await apiGet("/categories");
    const chips = cats.map(c => `<a class="chip" href="#/genre/${esc(c.slug)}">${esc(c.name)}</a>`).join("");
    $app.innerHTML = `<section class="row"><h2>Genres</h2><div class="chips">${chips}</div></section>`;
  } catch (e) { setError(e); }
}

async function genrePage(slug) {
  setLoading("Loading...");
  try {
    const items = await apiGet("/feed?type=newest&category=" + encodeURIComponent(slug) + "&limit=36");
    $app.innerHTML = row("Genre: " + slug, items, "series");
  } catch (e) { setError(e); }
}

function route() {
  const h = location.hash.slice(1) || "/";
  const [path, query] = h.split("?");
  const parts = path.split("/").filter(Boolean);
  if (!parts.length) return home();
  switch (parts[0]) {
    case "search": return searchPage(decodeURIComponent(query || "").replace(/^q=/, ""));
    case "feed": return feedPage(parts[1] || "newest");
    case "series": return seriesPage(parts[1]);
    case "episode": return episodePage(parts[1]);
    case "watch": return watchPage(new URLSearchParams(query).get("url"));
    case "genres": return genresPage();
    case "genre": return genrePage(parts[1]);
    case "downloads": return downloadsPage();
    case "offline": return offlinePage(decodeURIComponent(parts[1]));
    default: return home();
  }
}

$form.addEventListener("submit", e => {
  e.preventDefault();
  const q = $input.value.trim();
  if (q) location.hash = "#/search?q=" + encodeURIComponent(q);
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

window.addEventListener("hashchange", route);
if (document.readyState !== "loading") route();
else window.addEventListener("DOMContentLoaded", route);
