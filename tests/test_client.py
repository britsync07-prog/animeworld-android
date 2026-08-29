#!/usr/bin/env python3
"""
tests/test_client.py -- live verification of anime_client.py.

Run:  python tests/test_client.py
It hits the REAL site and asserts each API returns sane data. Requires internet
and that watchanimeworld.one / play.zephyrix.org are up. Exits non-zero on fail.
"""
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import anime_client as api

FAILS = []


def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}  {detail}")
    if not cond:
        FAILS.append(name)


def main():
    # search
    res = api.search("elusive samurai")
    check("search returns results", len(res) > 0, f"({len(res)})")
    check("search result has slug+url", res and res[0].get("slug") and res[0].get("url"))

    # feed
    for kind in ("newest", "trending", "movies"):
        res = api.feed(kind, limit=3)
        check(f"feed {kind}", len(res) > 0, f"({len(res)})")
        if res:
            check(f"feed {kind} has poster", bool(res[0].get("poster")),
                  res[0].get("poster", "")[:60])

    # categories
    cats = api.categories()
    check("categories", len(cats) > 0, f"({len(cats)})")

    # series -> seasons -> episodes -> stream
    s = api.series("the-elusive-samurai")
    check("series post_id", bool(s.get("post_id")), f"post_id={s.get('post_id')}")
    check("series seasons", len(s.get("seasons", [])) > 0, str(s.get("seasons")))

    eps = api.episodes(s["post_id"], s["seasons"][0])
    check("episodes", len(eps) > 0, f"({len(eps)})")
    check("episode has SxE", eps and eps[0]["season"] and eps[0]["episode"])

    st = api.episode_stream(eps[0]["url"])
    check("stream secured_link", bool(st.get("secured_link")), (st.get("secured_link") or "")[:70])
    check("stream poster", bool(st.get("poster")), (st.get("poster") or "")[:70])

    mp = api.master_playlist(st["secured_link"])
    check("master playlist is HLS", "EXT-X-STREAM-INF" in mp, f"{len(mp.splitlines())} lines")

    print("\n" + ("ALL PASS" if not FAILS else f"FAILURES: {FAILS}"))
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
