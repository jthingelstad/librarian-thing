#!/usr/bin/env python3
"""Ingest Jamie's thingelstad.com blog into the canonical store at data/blog/.

The full ~20-year post history is reachable through micro.blog's **Micropub
source query**: ``GET {MICROBLOG_MICROPUB_URL}?q=source&limit=N&offset=M``
(``Authorization: Bearer {MICROBLOG_API_KEY}``). It returns mf2-JSON
(``items[].properties``) for *Jamie's own* www.thingelstad.com posts —
newest-first, native markdown in ``content`` (the markdown Jamie wrote, with
photo ``<img>`` tags embedded), no reply/cross-blog noise. ``offset`` walks
backward over the whole archive; an empty page marks the end.

(The JSON Feed ``/posts/all`` endpoint is a follow-timeline, and
``/posts/{username}`` ignores ``before_id`` — both verified dead ends. The
Micropub source query is the only full-history path. See the ingest spike.)

Each post is written to::

    data/blog/posts/{YYYY}/{MM}/{YYYY-MM-DD}-{slug}.md

with YAML front matter (``microblog_id`` [uid], ``url``, ``title``,
``published``, ``post_kind`` [post|micropost], ``categories``) + the native
markdown body, plus a manifest at ``data/blog/index.json`` (``highest_id`` +
``posts`` keyed by uid) that drives incremental sync and corpus iteration.

Markdown-only v1 — image rehosting is deferred, so ``<img>`` src attributes
still point at micro.blog-hosted URLs (the corpus builder strips them from the
embedding text; the canonical store keeps them for a future image pass).

Idempotent: re-running UPSERTs by ``microblog_id`` and rewrites unchanged posts
byte-identically (fixed front-matter key order) so the embed cache stays warm.

Usage::

    python pipeline/blog/ingest_blog.py --dry-run --limit 50   # spike
    python pipeline/blog/ingest_blog.py                        # full backfill
    python pipeline/blog/ingest_blog.py --since-last           # incremental top-up
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv

sys.stdout.reconfigure(line_buffering=True)
load_dotenv()

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

# Micro.blog content extraction (stdlib + requests only), promoted here when
# the workshop bot retired. ``_content_to_markdown`` coerces the mf2
# ``content`` value (native markdown string, or {html|markdown|value} dict)
# to markdown.
from microblog import _content_to_markdown  # noqa: E402

BLOG_DIR = REPO / "data" / "blog"
INDEX_PATH = BLOG_DIR / "index.json"

DEFAULT_MICROPUB_URL = "https://micro.blog/micropub"
PAGE_SIZE = 500
_TIMEOUT = 60.0
_UA = "WeeklyThing-BlogIngest/1.0"
_URL_DATE_RE = re.compile(r"/(\d{4})/(\d{2})/(\d{2})/")


# ── micro.blog Micropub source query ──────────────────────────────────


def _micropub_url() -> str:
    return (os.environ.get("MICROBLOG_MICROPUB_URL") or DEFAULT_MICROPUB_URL).strip()


def _api_key() -> str:
    key = (os.environ.get("MICROBLOG_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("MICROBLOG_API_KEY is required (set it in .env)")
    return key


def _first(props: dict, *keys: str):
    """First value of the first present mf2 property in ``keys``."""
    for k in keys:
        v = props.get(k)
        if isinstance(v, list) and v:
            return v[0]
        if v not in (None, "", [], {}):
            return v
    return None


def _fetch_source_page(token: str, *, limit: int, offset: int) -> list[dict[str, Any]]:
    resp = requests.get(
        _micropub_url(),
        params={"q": "source", "limit": limit, "offset": offset},
        headers={"Authorization": f"Bearer {token}", "User-Agent": _UA},
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    items = data.get("items") if isinstance(data, dict) else None
    if items is None:
        raise ValueError("micro.blog Micropub q=source returned no `items`")
    return [it for it in items if isinstance(it, dict)]


def iter_posts(*, limit: int | None, known_uids: set[int] | None):
    """Yield rendered posts oldest-first across the whole archive, paginating
    backward via ``offset``. With ``known_uids`` (incremental), stop at the
    first page that contributes nothing new."""
    token = _api_key()
    out: list[dict[str, Any]] = []
    seen: set[int] = set()
    offset = 0
    while True:
        page = _fetch_source_page(token, limit=PAGE_SIZE, offset=offset)
        if not page:
            break
        new_this_page = 0
        for it in page:
            post = render_post(it)
            if post is None:
                continue
            uid = post["id"]
            if uid in seen:
                continue
            if known_uids is not None and uid in known_uids:
                continue
            seen.add(uid)
            out.append(post)
            new_this_page += 1
            if limit is not None and len(out) >= limit:
                break
        dates = [p["date"] for p in out]
        print(
            f"  offset={offset}: {len(page)} items, +{new_this_page} new, "
            f"{len(out)} total" + (f" (oldest {min(dates)})" if dates else ""),
            flush=True,
        )
        if limit is not None and len(out) >= limit:
            break
        # incremental: a fully-known page means everything older is known too
        if known_uids is not None and new_this_page == 0:
            break
        if len(page) < PAGE_SIZE:
            break  # short page → end of archive
        offset += len(page)
    out.sort(key=lambda p: p["id"])  # oldest-first, stable
    return out


# ── mf2 item → rendered post ──────────────────────────────────────────


def _post_date(url: str, published: str) -> str | None:
    m = _URL_DATE_RE.search(url or "")
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    if published:
        try:
            dt = datetime.fromisoformat(str(published).replace("Z", "+00:00"))
            return dt.date().isoformat()
        except ValueError:
            pass
    return None


def _slug(url: str) -> str:
    path = urlparse(url or "").path.rstrip("/")
    seg = path.rsplit("/", 1)[-1] if path else ""
    seg = re.sub(r"\.html?$", "", seg, flags=re.IGNORECASE)
    seg = re.sub(r"[^A-Za-z0-9._-]", "-", seg).strip("-")
    return seg or "post"


def _categories(props: dict) -> list[str]:
    raw = props.get("category")
    if not isinstance(raw, list):
        return []
    return [str(c).strip() for c in raw if isinstance(c, str) and c.strip()]


def render_post(item: dict[str, Any]) -> dict[str, Any] | None:
    """Convert an mf2 h-entry into ``{id, date, slug, path, url, title,
    published, post_kind, categories, markdown}``. Returns None for drafts or
    posts that can't be dated."""
    props = item.get("properties") or {}
    status = _first(props, "post-status")
    if status and str(status).lower() not in ("published", "publish"):
        return None  # drafts etc.
    uid_raw = _first(props, "uid")
    try:
        uid = int(uid_raw)
    except TypeError, ValueError:
        return None
    url = str(_first(props, "url") or "").strip()
    published = str(_first(props, "published", "publish-date") or "").strip()
    date_str = _post_date(url, published)
    if not date_str:
        return None
    year, month, _ = date_str.split("-")
    title = str(_first(props, "name") or "").strip()
    return {
        "id": uid,
        "date": date_str,
        "slug": _slug(url),
        "path": f"posts/{year}/{month}/{date_str}-{_slug(url)}.md",
        "url": url,
        "title": title,
        "published": published,
        "post_kind": "post" if title else "micropost",
        "categories": _categories(props),
        "markdown": _content_to_markdown(props.get("content")),
    }


# ── file + manifest ───────────────────────────────────────────────────


def _yaml_scalar(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _yaml_list(values: list[str]) -> str:
    if not values:
        return "[]"
    return "[" + ", ".join(_yaml_scalar(v) for v in values) + "]"


def _front_matter(post: dict[str, Any]) -> str:
    # Fixed key order → byte-stable on re-ingest (keeps the embed cache warm).
    return "\n".join(
        [
            "---",
            f"microblog_id: {post['id']}",
            f"url: {_yaml_scalar(post['url'])}",
            f"title: {_yaml_scalar(post['title'])}",
            f"published: {_yaml_scalar(post['published'])}",
            f"post_kind: {post['post_kind']}",
            f"categories: {_yaml_list(post['categories'])}",
            "---",
        ]
    )


def write_post(post: dict[str, Any]) -> Path:
    path = BLOG_DIR / post["path"]
    path.parent.mkdir(parents=True, exist_ok=True)
    content = _front_matter(post) + "\n\n" + post["markdown"].strip() + "\n"
    path.write_text(content, encoding="utf-8")
    return path


def load_index() -> dict[str, Any]:
    if INDEX_PATH.exists():
        return json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    return {"highest_id": 0, "post_count": 0, "posts": {}}


def write_index(index: dict[str, Any]) -> None:
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(
        json.dumps(index, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


# ── report ────────────────────────────────────────────────────────────


def _authorship_verdict(posts: list[dict[str, Any]]) -> str:
    if not posts:
        return "no posts to judge"
    own = sum(1 for p in posts if "thingelstad.com" in (p.get("url") or ""))
    pct = 100.0 * own / len(posts)
    tag = "OWN blog ✓" if pct >= 95 else ("follow-timeline ✗" if pct <= 5 else "MIXED")
    return f"{own}/{len(posts)} on thingelstad.com ({pct:.0f}%) → {tag}"


# ── main ──────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description="Ingest the thingelstad.com blog → data/blog/")
    ap.add_argument("--limit", type=int, default=None, help="stop after N posts (spike)")
    ap.add_argument(
        "--since-last",
        action="store_true",
        help="incremental: only posts not already in the manifest",
    )
    ap.add_argument("--dry-run", action="store_true", help="fetch + report, write nothing")
    args = ap.parse_args()

    index = load_index()
    known_uids: set[int] | None = None
    if args.since_last:
        known_uids = {int(k) for k in index.get("posts", {})}
        print(f"incremental: manifest has {len(known_uids)} known post(s)", flush=True)

    print(
        "fetching micro.blog q=source"
        + (f" (limit={args.limit})" if args.limit else " (full archive)")
        + "…",
        flush=True,
    )
    posts = iter_posts(limit=args.limit, known_uids=known_uids)

    print("\n── ingest report ──", flush=True)
    print(f"  posts:        {len(posts)}", flush=True)
    if posts:
        dates = sorted(p["date"] for p in posts)
        kinds = {"post": 0, "micropost": 0}
        for p in posts:
            kinds[p["post_kind"]] += 1
        print(f"  date range:   {dates[0]} … {dates[-1]}", flush=True)
        print(f"  kinds:        {kinds['post']} posts, {kinds['micropost']} microposts", flush=True)
        print(f"  authorship:   {_authorship_verdict(posts)}", flush=True)
        s = posts[-1]
        print(f"  newest:       [{s['id']}] {s['date']} {s['url']}", flush=True)
        print(f"                title={s['title']!r} kind={s['post_kind']}", flush=True)
        print(f"                md[:120]={s['markdown'][:120]!r}", flush=True)

    if args.dry_run:
        print("\n(dry-run — no files written)", flush=True)
        return 0
    if args.since_last and not posts:
        print("\n(no new posts — local blog store unchanged)", flush=True)
        return 0

    written = 0
    posts_index: dict[str, Any] = dict(index.get("posts", {}))
    highest = int(index.get("highest_id") or 0)
    claimed: dict[str, int] = {}
    for p in posts:
        # Disambiguate the rare case where two posts resolve to the same
        # {date}-{slug}.md (e.g. legacy posts whose URL lacks a date path).
        if claimed.get(p["path"], p["id"]) != p["id"]:
            p["path"] = re.sub(r"\.md$", f"-{p['id']}.md", p["path"])
        claimed[p["path"]] = p["id"]
        write_post(p)
        written += 1
        posts_index[str(p["id"])] = {
            "path": p["path"],
            "url": p["url"],
            "published": p["published"],
            "title": p["title"],
        }
        highest = max(highest, p["id"])
    write_index(
        {
            "highest_id": highest,
            "post_count": len(posts_index),
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "posts": posts_index,
        }
    )
    print(
        f"\nwrote {written} post file(s); manifest tracks "
        f"{len(posts_index)} post(s), highest_id={highest}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
