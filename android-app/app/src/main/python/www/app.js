/* app.js -- AnimeWorld frontend (runs inside the app's WebView, served by the
 * in-app Python backend). Talks to the backend over the same origin, so no
 * CORS. Handles search/feed/series navigation, HLS playback (via hls.js),
 * fullscreen, "open with" external player, and offline downloads with a
 * language/quality picker and a live progress + queue UI.
 */
const api = {
  async get(u) {
    const r = await fetch(u);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  },
};

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function qs() { return location.hash.replace(/^#\/?/, ""); }
const $app = document.getElementById("app");

// ---- live download progress (filled by the download worker over a channel) ----
let dlLive = {};
let dlRecords = [];
const dlChannel = ("BroadcastChannel" in window) ? new BroadcastChannel("anime-dl") : null;
if (dlChannel) dlChannel.onmessage = (e) => {
  if (e.data && e.data.type === "progress") {
    dlLive[e.data.id] = e.data;
    if (location.hash === "#/downloads") renderDownloads();
  }
};

function initSW() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

function initPlayer(video, src, raw) {
  raw = raw !== false;
  const proxied = raw ? ("/api/v1/hls?url=" + encodeURIComponent(src)) : src;
  if (window.hls) { try { window.hls.destroy(); } catch (_) {} }
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({ maxBufferLength: 30, capLevelToPlayerSize: true });
    window.hls = hls;
    hls.loadSource(proxied);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (e, d) => {
      if (d && d.fatal) {
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = proxied;
  } else {
    video.src = proxied;
  }
}

function playerHTML(poster, masterRaw, posterFallback) {
  return `
    <div class="player">
      <video id="player" playsinline controls poster="${esc(poster || posterFallback || "")}"></video>
    </div>
    <div class="dl-bar">
      <button id="dlBtn" class="btn">⤓ Download</button>
      <button id="fsBtn" class="btn">⛶ Fullscreen</button>
      <button id="extBtn" class="btn">▶ External player</button>
    </div>`;
}

function enterFullscreen() {
  const v = document.getElementById("player");
  if (!v) return;
  try {
    if (v.requestFullscreen) v.requestFullscreen();
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Language / quality picker (shared by Download and External player)
// ---------------------------------------------------------------------------
function pickTrack(tracks, opts) {
  opts = opts || {};
  const langs = tracks.audio || [];
  const vids = tracks.video || [];
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    let defVideo = vids.reduce((b, v) =>
      (b && Math.abs(b.bandwidth - 800000) < Math.abs(v.bandwidth - 800000)) ? b : v, vids[0]);
    let defLang = (langs.find((l) => /eng/i.test(l.lang || l.name)) || langs[0] || {}).lang || "";
    overlay.innerHTML = `
      <div class="modal">
        <h3>${opts.audioOnly ? "Choose audio language" : "Download options"}</h3>
        ${langs.length ? `
          <label class="lbl">Audio${langs.length > 1 ? " (pick one)" : ""}</label>
          <div class="opt">
            ${langs.map((l) => `<button class="opt-btn ${l.lang === defLang ? "sel" : ""}" data-lang="${esc(l.lang)}">${esc(l.name || l.lang)}</button>`).join("")}
          </div>
          ${!opts.audioOnly ? `<label class="ck"><input type="checkbox" id="allAud"> Download ALL audio tracks (bigger file)</label>` : ""}`
        : `<p class="muted">No separate audio tracks — video has embedded audio.</p>`}
        ${opts.audioOnly ? "" : `
          <label class="lbl">Quality</label>
          <div class="opt">
            ${vids.map((v) => `<button class="opt-btn ${v.uri === (defVideo && defVideo.uri) ? "sel" : ""}" data-vb="${v.bandwidth}">${Math.round(v.bandwidth / 1000)} kb/s</button>`).join("")}
          </div>`}
        <div class="modal-actions">
          <button id="mCancel" class="btn ghost">Cancel</button>
          <button id="mOk" class="btn">OK</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const langBtns = overlay.querySelectorAll(".opt-btn[data-lang]");
    langBtns.forEach((b) => b.onclick = () => {
      langBtns.forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      defLang = b.dataset.lang;
    });
    const vBtns = overlay.querySelectorAll(".opt-btn[data-vb]");
    vBtns.forEach((b) => b.onclick = () => {
      vBtns.forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      defVideo = vids.find((v) => +v.bandwidth === +b.dataset.vb) || defVideo;
    });
    const allChk = overlay.querySelector("#allAud");
    overlay.querySelector("#mCancel").onclick = () => { overlay.remove(); resolve(null); };
    overlay.querySelector("#mOk").onclick = () => {
      const all = allChk ? allChk.checked : false;
      overlay.remove();
      resolve({ lang: defLang, all, video: defVideo });
    };
  });
}

function buildCombinedMaster(video, audios) {
  let m = "#EXTM3U\n";
  audios.forEach((a) => {
    m += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="${esc(a.name || a.lang)}",LANGUAGE="${esc(a.lang)}",AUTOSELECT=YES,DEFAULT=YES,URI="${esc(a.uri)}"\n`;
  });
  m += `#EXT-X-STREAM-INF:BANDWIDTH=${video.bandwidth},AUDIO="a"` +
    (video.codecs ? `,CODECS="${esc(video.codecs)}"` : "") + `\n${video.uri}\n`;
  return m;
}

async function getTracks(masterRaw) {
  return api.get(`/api/v1/tracks?url=${encodeURIComponent(masterRaw)}`);
}

async function onDownload(masterRaw, meta) {
  let tracks;
  try { tracks = await getTracks(masterRaw); }
  catch (e) { alert("Could not read tracks: " + e.message); return; }
  const pick = await pickTrack(tracks, { allowAll: true });
  if (!pick) return;
  const audios = pick.all ? tracks.audio : tracks.audio.filter((a) => a.lang === pick.lang);
  const rec = {
    id: meta.id,
    title: meta.title,
    poster: meta.poster,
    masterRaw,
    videoUri: pick.video.uri,
    videoBandwidth: pick.video.bandwidth,
    videoCodecs: pick.video.codecs,
    audio: audios.map((a) => ({ lang: a.lang, name: a.name, uri: a.uri })),
    combinedMaster: buildCombinedMaster(pick.video, audios),
    qualityLabel: pick.video ? Math.round(pick.video.bandwidth / 1000) + " kb/s" : "",
  };
  startDownload(rec);
  location.hash = "#/downloads";
}

async function onExternal(masterRaw, title) {
  let tracks;
  try { tracks = await getTracks(masterRaw); }
  catch (e) { alert("Could not read tracks: " + e.message); return; }
  const pick = await pickTrack(tracks, { audioOnly: true });
  if (!pick) return;
  const url = `/api/v1/ext_url?url=${encodeURIComponent(masterRaw)}&audio=${encodeURIComponent(pick.lang || "")}`;
  try {
    const j = await (await fetch(url)).json();
    if (window.AnimeBridge && window.AnimeBridge.openExternal) window.AnimeBridge.openExternal(j.url);
    else location.href = j.url;
  } catch (e) { alert("Could not open external player: " + e.message); }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
async function homePage() {
  const feed = await api.get("/api/v1/feed?type=newest&limit=24");
  const rows = [
    { title: "New Episodes", items: feed.items.slice(0, 24) },
  ];
  $app.innerHTML = `
    <section class="row"><h2>New Episodes</h2>
      <div class="grid">${feed.items.map(card).join("")}</div>
    </section>`;
}

function card(it) {
  const img = it.poster
    ? `<img src="${esc(it.poster)}" loading="lazy" onerror="this.style.visibility='hidden'">`
    : `<div class="ph">no image</div>`;
  return `<a class="card" href="#/series/${encodeURIComponent(it.slug)}">
    <div class="thumb">${img}</div>
    <div class="cap">${esc(it.title)}</div>
  </a>`;
}

async function feedPage(kind) {
  const f = await api.get(`/api/v1/feed?type=${encodeURIComponent(kind || "newest")}&limit=48`);
  $app.innerHTML = `<section class="row"><h2>${esc((kind || "newest").replace(/^./, (c) => c.toUpperCase()))}</h2>
    <div class="grid">${f.items.map(card).join("")}</div></section>`;
}

async function categoriesPage() {
  const cats = await api.get("/api/v1/categories?per_page=60");
  const chips = (cats.genres || []).map((g) =>
    `<a class="chip" href="#/feed/${encodeURIComponent(g.slug || g.name)}">${esc(g.name)}</a>`).join("");
  $app.innerHTML = `<section class="row"><h2>Categories</h2><div class="chips">${chips}</div></section>`;
}

async function seriesPage(slug) {
  const s = await api.get(`/api/v1/series?slug=${encodeURIComponent(slug)}`);
  const seasons = s.seasons || [];
  $app.innerHTML = `
    <section class="detail">
      <h1>${esc(s.title)}</h1>
      <div class="season-tabs">
        ${seasons.map((x) => `<a class="tab" href="#/seasons/${encodeURIComponent(slug)}/${x.season}">${esc(x.name || ("Season " + x.season))}</a>`).join("")}
      </div>
      <p class="muted">${seasons.length} season(s). Tap a season to list episodes.</p>
    </section>`;
}

async function seasonsPage(slug, season) {
  const s = await api.get(`/api/v1/seasons?slug=${encodeURIComponent(slug)}&season=${season}`);
  const eps = await api.get(`/api/v1/episodes?slug=${encodeURIComponent(slug)}&season=${season}`);
  $app.innerHTML = `
    <section class="detail">
      <h1>${esc(s.title)} — Season ${esc(season)}</h1>
      <div class="ep-grid">
        ${eps.episodes.map((e) => `<a class="ep" href="#/episode/${encodeURIComponent(e.slug)}">
          <span class="ep-no">EP ${esc(e.episode)}</span>
          <span class="ep-title">${esc(e.title || "")}</span>
        </a>`).join("")}
      </div>
    </section>`;
}

async function episodePage(slug) {
  const st = await api.get(`/api/v1/stream?slug=${encodeURIComponent(slug)}`);
  $app.innerHTML = `<section class="watch"><h1>${esc(st.title)} — Episode ${esc(slug)}</h1>${playerHTML(st.poster, st.video_source, st.poster)}</section>`;
  initPlayer(document.getElementById("player"), st.video_source, true);
  document.getElementById("dlBtn").onclick = () => onDownload(st.video_source, { id: slug, title: st.title + " — Ep " + slug, poster: st.poster });
  document.getElementById("fsBtn").onclick = enterFullscreen;
  document.getElementById("extBtn").onclick = () => onExternal(st.video_source, st.title);
}

async function watchPage(url) {
  const st = await api.get(`/api/v1/stream?url=${encodeURIComponent(url)}`);
  $app.innerHTML = `<section class="watch"><h1>${esc(st.title)}</h1>${playerHTML(st.poster, st.video_source, st.poster)}</section>`;
  initPlayer(document.getElementById("player"), st.video_source, true);
  document.getElementById("dlBtn").onclick = () => onDownload(st.video_source, { id: url, title: "Movie: " + st.title, poster: st.poster });
  document.getElementById("fsBtn").onclick = enterFullscreen;
  document.getElementById("extBtn").onclick = () => onExternal(st.video_source, st.title);
}

async function searchPage(q) {
  const r = await api.get(`/api/v1/search?q=${encodeURIComponent(q)}&limit=48`);
  const items = r.results || [];
  $app.innerHTML = `<section class="row"><h2>Results for "${esc(q)}"</h2>
    <div class="grid">${items.map(card).join("")}</div>
    ${items.length ? "" : `<p class="muted">No results.</p>`}</section>`;
}

async function downloadsPage() {
  dlRecords = await getAllDownloads();
  renderDownloads();
}

function renderDownloads() {
  const items = dlRecords.map((r) => {
    const live = dlLive[r.id] || { done: r.done, total: r.total, bytes: r.bytes, status: r.status };
    const pct = live.total ? Math.min(100, Math.round((100 * live.done) / live.total)) : 0;
    const mb = (live.bytes || 0) / 1048576;
    const label = { queued: "Queued", downloading: "Downloading", done: "Completed", error: "Error", canceled: "Canceled" }[live.status] || live.status;
    const audios = (r.audio || []).map((a) => a.name).join(", ") || "embedded";
    return `<div class="dl-card">
      <img class="dl-poster" src="${esc(r.poster || "")}" onerror="this.style.visibility='hidden'">
      <div class="dl-info">
        <div class="dl-title">${esc(r.title)}</div>
        <div class="dl-meta">${esc(r.qualityLabel || "")} · ${esc(audios)}</div>
        <div class="dl-bar-wrap"><div class="dl-bar" style="width:${pct}%"></div></div>
        <div class="dl-sub">${label} ${pct}% · ${mb.toFixed(1)} MB${live.status === "downloading" ? ` · ${live.done}/${live.total}` : ""}</div>
      </div>
      <div class="dl-actions">
        ${live.status === "done" ? `<a class="navlink" href="#/offline/${encodeURIComponent(r.id)}">Play</a>` : ""}
        ${live.status !== "done" ? `<button class="navlink ext" data-raw="${esc(r.masterRaw)}">Open with</button>` : ""}
        <button class="navlink del" data-id="${esc(r.id)}">${live.status === "downloading" || live.status === "queued" ? "Cancel" : "Delete"}</button>
      </div>
    </div>`;
  }).join("");
  $app.innerHTML = `<section class="downloads"><h1>Downloads</h1>
    ${items || `<p class="muted">No downloads yet. Open an episode and tap <b>Download</b>.</p>`}
    <p class="muted small">Up to 3 downloads run at once; the rest are queued. The app must stay open while downloading. Tap an item to play it offline once finished.</p>
  </section>`;
  $app.querySelectorAll(".del").forEach((b) => b.onclick = async () => {
    const id = b.dataset.id;
    const rec = dlRecords.find((x) => x.id === id);
    if (rec && (rec.status === "downloading" || rec.status === "queued")) cancelDownload(id);
    else await deleteDownload(id);
    dlRecords = dlRecords.filter((x) => x.id !== id);
    renderDownloads();
  });
  $app.querySelectorAll(".ext").forEach((b) => b.onclick = () => {
    const raw = b.dataset.raw;
    onExternal(raw, "Downloaded video");
  });
}

async function offlinePage(id) {
  const rec = await getDownload(id);
  if (!rec) { $app.innerHTML = `<p class="muted">Download not found.</p>`; return; }
  $app.innerHTML = `<section class="watch"><h1>${esc(rec.title)}</h1>${playerHTML(rec.poster, rec.masterRaw, rec.poster)}</section>`;
  const blob = new Blob([rec.combinedMaster], { type: "application/vnd.apple.mpegurl" });
  const url = URL.createObjectURL(blob);
  initPlayer(document.getElementById("player"), url, false);
  document.getElementById("fsBtn").onclick = enterFullscreen;
  document.getElementById("extBtn").onclick = () => onExternal(rec.masterRaw, rec.title);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function render() {
  const path = qs();
  const parts = path.split("/").filter(Boolean);
  try {
    if (parts.length === 0) return homePage();
    if (parts[0] === "feed") return feedPage(parts[1]);
    if (parts[0] === "categories") return categoriesPage();
    if (parts[0] === "series") return seriesPage(parts[1]);
    if (parts[0] === "seasons") return seasonsPage(parts[1], parts[2]);
    if (parts[0] === "episode") return episodePage(parts[1]);
    if (parts[0] === "watch") return watchPage(decodeURIComponent(parts.slice(1).join("/")));
    if (parts[0] === "search") return searchPage(decodeURIComponent(parts.slice(1).join("/")));
    if (parts[0] === "downloads") return downloadsPage();
    if (parts[0] === "offline") return offlinePage(decodeURIComponent(parts[1]));
    return homePage();
  } catch (e) {
    $app.innerHTML = `<p class="error">Error: ${esc(e.message)}</p>`;
  }
}

function nav() {
  const links = [
    ["#/", "Home"], ["#/feed/newest", "New"], ["#/feed/popular", "Popular"],
    ["#/categories", "Categories"], ["#/downloads", "Downloads"],
  ];
  return `<nav class="nav">
    <a class="brand" href="#/">Anime<b>World</b></a>
    <div class="links">${links.map((l) => `<a href="${l[0]}">${l[1]}</a>`).join("")}</div>
    <div class="search">
      <input id="q" placeholder="Search anime…" value="${esc(qs().startsWith("search/") ? decodeURIComponent(qs().slice(7)) : "")}">
      <button id="go">Search</button>
    </div>
  </nav>`;
}

document.getElementById("nav").innerHTML = nav();
document.getElementById("go").onclick = () => {
  const q = document.getElementById("q").value.trim();
  if (q) location.hash = "#/search/" + encodeURIComponent(q);
};
document.getElementById("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { const q = e.target.value.trim(); if (q) location.hash = "#/search/" + encodeURIComponent(q); }
});

window.addEventListener("hashchange", render);
initSW();
render();
