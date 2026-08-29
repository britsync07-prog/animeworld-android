// tests/test_frontend.js -- functional test of web/app.js with a DOM/fetch shim.
// Loads the REAL app.js, points fetch at the running server, drives every route,
// and asserts the rendered HTML. To stay deterministic against a flaky upstream,
// successful API responses are cached to disk on first fetch; the warmup phase
// populates that cache with gentle, spaced live requests BEFORE assertions run.
// Run:  node tests/test_frontend.js
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE || "http://127.0.0.1:8080";
const FAILS = [];
const ok = (name, cond, extra = "") => {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}  ${extra}`);
  if (!cond) FAILS.push(name);
};
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ---- DOM / window / location shims ----
const els = {};
function fakeEl(id) {
  return els[id] || (els[id] = { id, innerHTML: "", value: "",
    querySelectorAll: () => [], addEventListener: () => {} });
}
global.document = {
  readyState: "complete",
  getElementById: (id) => fakeEl(id),
  addEventListener: () => {},
  createElement: () => ({ content: { firstChild: null } }),
};
let hashHandlers = [];
global.window = { addEventListener: (ev, fn) => { if (ev === "hashchange") hashHandlers.push(fn); },
  location: { hash: "" } };
global.location = global.window.location;
process.on("unhandledRejection", e => console.log("UNHANDLED", e && e.message));

// fetch shim: relative -> absolute BASE, cache successful responses to disk.
const CACHE_FILE = path.join(__dirname, ".api_cache.json");
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch (_) {}
const saveCache = () => { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch (_) {} };
const realFetch = global.fetch;
global.fetch = async (u, opts) => {
  const abs = u.startsWith("http") ? u : BASE + u;
  if (Object.prototype.hasOwnProperty.call(cache, abs)) {
    return new Response(cache[abs], { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const r = await realFetch(abs, opts);
  const t = await r.text();
  if (r.ok) { cache[abs] = t; saveCache(); }
  return new Response(t, { status: r.status, headers: { "Content-Type": "application/json" } });
};

// ---- gentle warmup: cache each endpoint once, spaced, before assertions ----
const WARM = [
  "/api/v1/feed?type=trending&limit=12",
  "/api/v1/feed?type=newest&limit=12",
  "/api/v1/feed?type=movies&limit=12",
  "/api/v1/seasons?slug=the-elusive-samurai",
  "/api/v1/stream?slug=the-elusive-samurai-1x1",
  "/api/v1/stream?url=" + encodeURIComponent("https://watchanimeworld.one/movies/your-name/"),
  "/api/v1/categories",
  "/api/v1/search?q=elusive",
];
(async () => {
  console.log("Warming cache from live site (gentle, spaced)...");
  for (const w of WARM) {
    if (Object.prototype.hasOwnProperty.call(cache, BASE + w)) { console.log("  cached (skip)", w); continue; }
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(w);
        if (r.ok) { console.log("  cached", w); break; }
        console.log("  retry", w, "status", r.status);
      } catch (e) { console.log("  err", w, e.message); }
      await delay(1500);
    }
    await delay(1000);
  }

  // ---- load app.js (now served entirely from cache) ----
  const src = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8");
  eval(src);

  const go = async (hash) => {
    global.location.hash = hash;
    for (const h of hashHandlers) h();
    for (let i = 0; i < 40; i++) {
      await delay(120);
      const html = fakeEl("app").innerHTML;
      if (!html.includes("Loading") && !html.includes("Error:")) return html;
    }
    return fakeEl("app").innerHTML;
  };

  const homeHtml = await go("#/");
  ok("home renders Trending", homeHtml.includes("Trending"));
  ok("home renders Newest Arrivals", homeHtml.includes("Newest Arrivals"));
  ok("home has series card links", homeHtml.includes('href="#/series/'));
  ok("home has movie card links", homeHtml.includes('href="#/watch?url='));

  const ser = await go("#/series/the-elusive-samurai");
  ok("series shows title", ser.includes("The Elusive Samurai"));
  ok("series shows Season tab", ser.includes("Season 1"));
  const epGrid = fakeEl("epGrid").innerHTML;
  ok("episode grid populated", epGrid.includes("#/episode/the-elusive-samurai-1x1"));

  const ep = await go("#/episode/the-elusive-samurai-1x1");
  ok("episode renders a video player", ep.includes("<video"));
  ok("episode wires HLS proxy", ep.includes('data-hls="/api/v1/hls?url='));
  ok("episode has Audio/Language selector", ep.includes('id="audioTrack"'));
  ok("episode has Subtitles selector", ep.includes('id="subTrack"'));
  ok("episode has Download for offline button", ep.includes('id="dlBtn"'));
  let navHtml = "";
  for (let i = 0; i < 30; i++) {
    await delay(150);
    navHtml = fakeEl("epinav").innerHTML;
    if (navHtml.includes('href="#/series/the-elusive-samurai"')) break;
  }
  ok("episode has Series nav", navHtml.includes('href="#/series/the-elusive-samurai"'));

  const watch = await go("#/watch?url=" + encodeURIComponent("https://watchanimeworld.one/movies/your-name/"));
  ok("watch renders a video player (HLS proxy)", watch.includes('data-hls="/api/v1/hls?url='));
  ok("watch has Download for offline button", watch.includes('id="dlBtn"'));

  const gen = await go("#/genres");
  ok("genres lists chips", gen.includes('href="#/genre/'));

  const sea = await go("#/search?q=elusive");
  ok("search renders results", sea.includes("The Elusive Samurai"));

  console.log("\n" + (FAILS.length ? "FAILURES: " + FAILS.join(", ") : "ALL FRONTEND CHECKS PASS"));
  process.exit(FAILS.length ? 1 : 0);
})();
