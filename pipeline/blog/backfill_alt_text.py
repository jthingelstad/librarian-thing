#!/usr/bin/env python3
"""Backfill alt text across the full thingelstad.com micro.blog history.

The workshop already fills alt on the journal images it touches; this walks the
*entire* local blog store (``data/blog/posts/**/*.md``, populated by
``ingest_blog.py``) and fills every remaining image whose alt is missing/empty —
so the alt becomes a permanent part of each post on micro.blog *and* flows into
Thingy's blog-corpus embedding text on the next rebuild.

Three modes::

    # AUDIT — free. No vision, no writes. Count missing-alt images + cost estimate.
    python pipeline/blog/backfill_alt_text.py --audit

    # DRY-RUN (default) — generate alt via vision (capped), write a report file,
    # NO micro.blog write. Eyeball quality with a small --limit-posts first.
    python pipeline/blog/backfill_alt_text.py --limit-posts 10

    # WRITE — generate + write to micro.blog + back up original + update local store.
    python pipeline/blog/backfill_alt_text.py --write --max-vision 50

Safety: dry-run is the default; ``--write`` re-fetches each post's *live* content
right before writing (so a post edited on micro.blog since the last ingest is
never clobbered — the Micropub update is content-only) and backs the original
body up to ``tmp/blog-alt/backups/`` before the write. The candidate finder only
returns *still-empty* alts, so re-running resumes naturally — ``--max-vision``
batches + re-run is the resume mechanism, no state table.

This tool touches micro.blog only. It never re-embeds/uploads the corpus — run
``npm run librarian:deploy:blog`` when ready (it picks up the updated local files).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import yaml
from dotenv import load_dotenv

sys.stdout.reconfigure(line_buffering=True)
load_dotenv()

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

import alt_text  # noqa: E402
import microblog  # noqa: E402

BLOG_POSTS_DIR = REPO / "data" / "blog" / "posts"
RUN_DIR = REPO / "tmp" / "blog-alt"
BACKUP_DIR = RUN_DIR / "backups"
# Image URLs that 404/410'd on a prior run — skipped (no fetch, no budget) on
# future runs so a block of deleted uploads can't re-block the cursor. Append-only.
DEAD_URL_LOG = RUN_DIR / "dead-urls.txt"

# Per-image vision cost ballpark (Sonnet: ~1.5–2k input image tokens + ~400
# context + ≤200 output). Used only for the audit estimate.
_COST_PER_IMAGE_LOW = 0.005
_COST_PER_IMAGE_HIGH = 0.010

# Conservative default batch so a naked `--write` can't fan out to thousands of
# paid vision calls. Override with --max-vision; re-run to continue the backlog.
_DEFAULT_MAX_VISION = 25

# Front matter is `---\n<inner>\n---\n` at the very top (byte-stable, written by
# ingest_blog). Capture the inner YAML and the verbatim block so a rewrite keeps
# the front matter byte-identical and only swaps the body.
_FM_RE = re.compile(r"\A---\n(?P<fm>.*?)\n---\n(?P<body>.*)\Z", re.DOTALL)


# ── local store ───────────────────────────────────────────────────────


def _read_blog_post(path: Path) -> tuple[dict[str, Any], str, str]:
    """Return ``(metadata, body, front_matter_block)``. ``front_matter_block`` is
    the verbatim ``---\\n…\\n---\\n`` prefix so a rewrite stays byte-identical."""
    raw = path.read_text(encoding="utf-8")
    m = _FM_RE.match(raw)
    if not m:
        raise RuntimeError(f"{path}: missing/!malformed front matter")
    metadata = yaml.safe_load(m.group("fm")) or {}
    body = m.group("body").strip()
    fm_block = raw[: m.start("body")]  # includes the closing `---\n`
    return metadata, body, fm_block


def _rewrite_body(path: Path, fm_block: str, new_body: str) -> None:
    """Rewrite the local file with front matter verbatim, body replaced — exactly
    ingest_blog's on-disk layout (`---\\n…\\n---\\n\\n<body>\\n`)."""
    path.write_text(fm_block + "\n" + new_body.strip() + "\n", encoding="utf-8")


def _iter_post_files(year: int | None) -> Iterator[Path]:
    root = BLOG_POSTS_DIR / str(year) if year else BLOG_POSTS_DIR
    yield from sorted(root.rglob("*.md"))


def _has_image_markers(raw: str) -> bool:
    """Cheap pre-filter: a post can only have a missing-alt candidate if it
    carries an `<img` tag or an empty-alt `![](` markdown image. Skips the YAML
    parse on the thousands of text-only microposts."""
    return "<img" in raw or "![](" in raw


def _scan_post(path: Path) -> dict[str, Any] | None:
    """Parse one post and return its empty-alt images as ``targets`` (each a
    ``(start, end, kind, src)`` tuple). Returns ``None`` for posts with no
    empty-alt image. Every format micro.blog hosts (jpg/png/gif/webp) is
    fillable — the vision fetch path sniffs magic bytes, so the CDN's
    ``binary/octet-stream`` content-type no longer gates what we attempt."""
    raw = path.read_text(encoding="utf-8")
    if not _has_image_markers(raw):
        return None
    metadata, body, fm_block = _read_blog_post(path)
    targets = microblog._find_empty_alt_images(body)
    if not targets:
        return None
    return {
        "path": path,
        "microblog_id": metadata.get("microblog_id"),
        "url": str(metadata.get("url") or "").strip(),
        "title": str(metadata.get("title") or "").strip(),
        "post_kind": str(metadata.get("post_kind") or "post").strip(),
        "body": body,
        "fm_block": fm_block,
        "targets": targets,
    }


def iter_candidate_posts(*, year: int | None, limit_posts: int | None) -> Iterator[dict[str, Any]]:
    """Yield posts with ≥1 empty-alt image (``targets`` non-empty), in path
    order. ``--limit-posts`` counts only yielded posts."""
    yielded = 0
    for path in _iter_post_files(year):
        post = _scan_post(path)
        if not post or not post["targets"]:
            continue
        yield post
        yielded += 1
        if limit_posts is not None and yielded >= limit_posts:
            return


# ── alt generation / splice ───────────────────────────────────────────


def _splice(
    body: str, targets: list[tuple[int, int, str, str]], *, caption: str | None
) -> tuple[str, list[dict[str, Any]]]:
    """Generate alt for each target and splice it into ``body``. Splices
    end-to-start so earlier offsets stay valid (same as fill_missing_alts).
    Returns ``(new_body, filled)`` where ``filled`` is one entry per alt actually
    produced. Stops early (leaving later images empty) once the vision budget is
    exhausted — ``generate_alt`` returns "" past the cap."""
    new_body = body
    filled: list[dict[str, Any]] = []
    for start, end, kind, src in reversed(targets):
        try:
            alt = alt_text.generate_alt(image_url=src, context=body, caption=caption) or ""
        except Exception as exc:  # noqa: BLE001
            print(f"    ! vision failed for {src}: {exc}", flush=True)
            alt = ""
        if not alt:
            continue
        if kind == "html":
            new_body = (
                new_body[:start]
                + microblog._splice_alt_into_img(new_body[start:end], alt)
                + new_body[end:]
            )
        else:
            # Convert ![](url) → <img src alt>, micro.blog's default format
            # (5,200 of ~6,150 image posts already use <img>). HTML keeps the
            # raw URL out of the Thingy embed text — `_blog_embed_text` inlines
            # only `<img alt>` and strips the tag, whereas a markdown image
            # embeds alt *and* the src URL as noise. `alt` is already
            # attribute-safe (alt_text._clean_alt strips " < > &).
            new_body = new_body[:start] + f'<img src="{src}" alt="{alt}">' + new_body[end:]
        filled.append({"image_src": src, "kind": kind, "alt": alt})
    filled.reverse()  # back to top-to-bottom reading order
    return new_body, filled


# ── modes ─────────────────────────────────────────────────────────────


def run_audit(*, year: int | None, limit_posts: int | None) -> int:
    """Full free scan: tally every empty-alt image (split html-tag vs markdown)
    and print a vision-cost estimate. No vision calls, no writes."""
    posts = 0
    html_missing = 0
    md_missing = 0
    scanned = 0
    for path in _iter_post_files(year):
        post = _scan_post(path)
        if not post:
            continue
        scanned += 1
        if limit_posts is not None and scanned > limit_posts:
            break
        posts += 1
        for _s, _e, kind, _src in post["targets"]:
            if kind == "html":
                html_missing += 1
            else:
                md_missing += 1
    total = html_missing + md_missing
    print("\n── alt-text audit ──", flush=True)
    print(f"  scope:                  {year or 'all years'}", flush=True)
    print(f"  posts missing alt:       {posts}", flush=True)
    print(
        f"  images missing alt:      {total}  ({html_missing} <img>, {md_missing} markdown)",
        flush=True,
    )
    print(
        f"  est. vision cost:        ${total * _COST_PER_IMAGE_LOW:,.2f} – ${total * _COST_PER_IMAGE_HIGH:,.2f}",
        flush=True,
    )
    if total:
        print(f"\n  next: dry-run a sample →  python {_self()} --limit-posts 10", flush=True)
        print(
            f"        then write batches  →  python {_self()} --write --max-vision 50", flush=True
        )
    return 0


def run_fill(*, write: bool, year: int | None, limit_posts: int | None, max_vision: int) -> int:
    os.environ["WORKSHOP_ALT_VISION_CAP"] = str(max_vision)
    RUN_DIR.mkdir(parents=True, exist_ok=True)  # so the dead-url log is writable
    # bills vision to ANTHROPIC_GENERAL_API_KEY; skips/logs deleted-upload 404s
    alt_text.begin_run(purpose="general", dead_url_log=str(DEAD_URL_LOG))

    mode = "write" if write else "dry-run"
    results: list[dict[str, Any]] = []
    posts_touched = 0
    images_filled = 0
    writes_ok = 0
    writes_failed = 0
    synced = 0

    if write:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    print(f"\n── alt-text {mode} (max-vision={max_vision}) ──", flush=True)

    for post in iter_candidate_posts(year=year, limit_posts=limit_posts):
        if alt_text.calls_remaining() <= 0:
            print("  vision budget exhausted — stopping (re-run to continue).", flush=True)
            break

        url = post["url"]
        mbid = post["microblog_id"]
        caption = post["title"] or None

        if not write:
            new_body, filled = _splice(post["body"], post["targets"], caption=caption)
            if not filled:
                continue
            posts_touched += 1
            images_filled += len(filled)
            print(f"  [{mbid}] {url}", flush=True)
            for f in filled:
                print(f"      + alt: {f['alt']}", flush=True)
                results.append(
                    {
                        **f,
                        "post_url": url,
                        "microblog_id": mbid,
                        "post_kind": post["post_kind"],
                        "written": False,
                    }
                )
            continue

        # --- write path: re-fetch live so we never clobber a newer edit ---
        try:
            props = microblog.source_for_url(url)
            live_body = microblog._content_to_markdown(props.get("content"))
        except Exception as exc:  # noqa: BLE001
            print(f"  ! [{mbid}] live re-fetch failed, skipping: {exc}", flush=True)
            continue

        live_targets = microblog._find_empty_alt_images(live_body)
        if not live_targets:
            # No empty-alt image left live (filled upstream since ingest) — sync
            # the local file so the audit stops flagging it, then move on.
            if live_body.strip() != post["body"].strip():
                _rewrite_body(post["path"], post["fm_block"], live_body)
                synced += 1
                print(f"  = [{mbid}] no fillable image live — synced local store", flush=True)
            continue

        new_body, filled = _splice(live_body, live_targets, caption=caption)
        if not filled:
            continue

        # Back up the original live body before touching the live post.
        (BACKUP_DIR / f"{mbid}.md").write_text(live_body, encoding="utf-8")
        try:
            microblog.update_post_content(url, new_body)
        except Exception as exc:  # noqa: BLE001
            writes_failed += 1
            print(
                f"  ! [{mbid}] micro.blog write FAILED (backup kept, retry next run): {exc}",
                flush=True,
            )
            continue

        _rewrite_body(post["path"], post["fm_block"], new_body)
        writes_ok += 1
        posts_touched += 1
        images_filled += len(filled)
        print(f"  ✓ [{mbid}] {url}", flush=True)
        for f in filled:
            print(f"      + alt: {f['alt']}", flush=True)
            results.append(
                {
                    **f,
                    "post_url": url,
                    "microblog_id": mbid,
                    "post_kind": post["post_kind"],
                    "written": True,
                }
            )

    vision_used = max_vision - alt_text.calls_remaining()
    summary = {
        "posts_touched": posts_touched,
        "images_filled": images_filled,
        "vision_calls": vision_used,
        "writes_ok": writes_ok,
        "writes_failed": writes_failed,
        "synced_local": synced,
    }
    _write_run_log(
        mode=mode,
        max_vision=max_vision,
        year=year,
        limit_posts=limit_posts,
        results=results,
        summary=summary,
    )

    print("\n── summary ──", flush=True)
    print(f"  mode:           {mode}", flush=True)
    print(f"  posts touched:  {posts_touched}", flush=True)
    print(f"  images filled:  {images_filled}", flush=True)
    print(f"  vision calls:   {vision_used} / {max_vision}", flush=True)
    if write:
        print(f"  writes ok:      {writes_ok}", flush=True)
        print(f"  writes failed:  {writes_failed}", flush=True)
        print(f"  local synced:   {synced}", flush=True)
        print(
            "\n  When done backfilling: run `npm run librarian:deploy:blog` to re-embed.",
            flush=True,
        )
    else:
        print("\n  (dry-run — nothing written to micro.blog. Add --write to persist.)", flush=True)
    return 0


def _write_run_log(
    *,
    mode: str,
    max_vision: int,
    year: int | None,
    limit_posts: int | None,
    results: list[dict[str, Any]],
    summary: dict[str, Any],
) -> None:
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = RUN_DIR / f"run-{ts}.json"
    path.write_text(
        json.dumps(
            {
                "mode": mode,
                "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "max_vision": max_vision,
                "year": year,
                "limit_posts": limit_posts,
                "summary": summary,
                "results": results,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"\n  run log: {path.relative_to(REPO)}", flush=True)


def _self() -> str:
    return "pipeline/blog/backfill_alt_text.py"


def main() -> int:
    ap = argparse.ArgumentParser(description="Backfill alt text across the micro.blog history")
    ap.add_argument(
        "--audit",
        action="store_true",
        help="count missing-alt images + cost estimate (no vision, no writes)",
    )
    ap.add_argument(
        "--write",
        action="store_true",
        help="write generated alt back to micro.blog + update local store (default: dry-run)",
    )
    ap.add_argument(
        "--max-vision",
        type=int,
        default=_DEFAULT_MAX_VISION,
        help=f"cap vision calls this run (default {_DEFAULT_MAX_VISION}); re-run to continue",
    )
    ap.add_argument(
        "--limit-posts",
        type=int,
        default=None,
        help="process only the first N candidate posts (spike / quality check)",
    )
    ap.add_argument("--year", type=int, default=None, help="scope to one year's subtree")
    args = ap.parse_args()

    if not BLOG_POSTS_DIR.exists():
        print(f"error: {BLOG_POSTS_DIR} not found — run ingest_blog.py first", flush=True)
        return 1

    if args.audit:
        return run_audit(year=args.year, limit_posts=args.limit_posts)
    return run_fill(
        write=args.write, year=args.year, limit_posts=args.limit_posts, max_vision=args.max_vision
    )


if __name__ == "__main__":
    raise SystemExit(main())
