#!/usr/bin/env python3
"""De-wrap pandoc hard-wrapped prose paragraphs in the micro.blog post store.

ONE job: undo the line wrapping pandoc introduced when Jamie's blog was migrated
to micro.blog — prose hard-wrapped at ~70 cols (line breaks mid-paragraph,
sometimes mid-link). It joins each machine-wrapped paragraph back onto one logical
line and rejoins link text split across a wrap. It does NOTHING else: code fences,
lists, headings, blockquotes, tables, raw HTML, ``<img>`` tags, front matter, and
blank-line spacing are all preserved byte-for-byte. (``<img>`` is the preferred
image format on this blog — it is never touched or converted.)

Dry-run by default — it prints what WOULD change and writes nothing. ``--write``
applies the change after copying each touched file to ``tmp/blog-dewrap/backups/``
(mirroring the post tree) so every edit is reversible. Never calls micro.blog,
never touches Pinboard, never commits. Pure deterministic text surgery: zero spend.

Typos are a SEPARATE concern — see ``pipeline/blog/typo_scan.py``.

Usage::

    # dry-run a sample of migrated-era posts — proposed de-wraps from the local
    # cache, zero writes, no API
    python pipeline/blog/dewrap.py --count 50

    # dry-run one known post with a full unified diff
    python pipeline/blog/dewrap.py --only 1074933 --show-diff

    # apply across the whole migrated-era pool: write to micro.blog + sync cache
    python pipeline/blog/dewrap.py --all --write

micro.blog is canonical; ``data/blog/posts/`` is a disposable cache. So ``--write``
re-fetches each post's LIVE body, de-wraps THAT, backs up the original live body,
and sends a content-only Micropub update to micro.blog. It deliberately does NOT
sync the local cache — the cache is refreshed wholesale afterward by re-running
``ingest_blog.py``. Dry-run (default) previews from the local cache (fast, no API).
Pure text surgery: zero LLM spend either way.
"""

from __future__ import annotations

import argparse
import difflib
import json
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import yaml
from dotenv import load_dotenv

sys.stdout.reconfigure(line_buffering=True)
load_dotenv()

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

import microblog  # noqa: E402

BLOG_POSTS_DIR = REPO / "data" / "blog" / "posts"
RUN_DIR = REPO / "tmp" / "blog-dewrap"
BACKUP_DIR = RUN_DIR / "backups"

# micro.blog throttles bursts of Micropub calls with HTTP 403/429 once a few
# hundred requests land in quick succession (observed: ~390 writes before the
# block kicks in). A small fixed gap between posts plus exponential backoff on a
# throttle response keeps a full-corpus write under the limit without aborting.
_API_THROTTLE_S = 0.5  # gap between posts (each post = 1 read + 1 write)
_RETRY_BACKOFFS = (5, 15, 45, 90)  # seconds to wait on a throttle response
_THROTTLE_MARKERS = (
    "403",
    "429",
    "rate limit",
    "too many requests",
    "500",
    "502",
    "503",
    "504",
    "timed out",
    "timeout",
)

# Front matter is `---\n<inner>\n---\n` at the very top (byte-stable).
_FM_RE = re.compile(r"\A---\n(?P<fm>.*?)\n---\n(?P<body>.*)\Z", re.DOTALL)

# A non-final prose line in this length band is almost certainly a pandoc hard
# wrap: authored markdown keeps each paragraph on one logical line, so a "full"
# line (near the ~70-col wrap width) signals machine wrapping, not intent.
_WRAP_MIN_LEN = 55
_WRAP_MAX_LEN = 82

# A markdown link whose text was split across a hard wrap: `[The New\nStandards](`.
_LINK_SPLIT_RE = re.compile(r"\[[^\]\n]*\n[^\]]*\]\(")

# Structural line starts — a block containing any of these is not flat prose, so
# its internal line breaks are legitimate (lists, tables, headings, quotes, hr).
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s")
_ULIST_RE = re.compile(r"^\s*[-*+]\s")
_OLIST_RE = re.compile(r"^\s*\d+[.)]\s")
_QUOTE_RE = re.compile(r"^\s*>")
_HR_RE = re.compile(r"^\s*(?:[-*_]\s*){3,}$")


# ── local store ───────────────────────────────────────────────────────


def _read_raw(path: Path) -> tuple[dict[str, Any], str, str]:
    """Return ``(metadata, fm_text, body_raw)``. ``body_raw`` is the body verbatim
    (NOT stripped) so a no-change rewrite is byte-identical to the original."""
    raw = path.read_text(encoding="utf-8")
    m = _FM_RE.match(raw)
    if not m:
        raise RuntimeError(f"{path}: missing/malformed front matter")
    metadata = yaml.safe_load(m.group("fm")) or {}
    return metadata, m.group("fm"), m.group("body")


def _post_year(metadata: dict[str, Any]) -> Optional[int]:
    raw = str(metadata.get("published") or "").strip()
    if len(raw) >= 4 and raw[:4].isdigit():
        return int(raw[:4])
    return None


# ── sampling ──────────────────────────────────────────────────────────


def select_posts(
    *, count: Optional[int], year_max: int, seed: int, include_microposts: bool
) -> list[Path]:
    """Candidate posts weighted to the migrated era. Pool = ``post_kind: post``
    (unless ``include_microposts``) published in or before ``year_max``. With
    ``count is None`` the whole pool is returned (sorted); otherwise a seeded
    random sample for reproducible dry-runs."""
    pool: list[Path] = []
    for path in sorted(BLOG_POSTS_DIR.rglob("*.md")):
        try:
            metadata, _fm, _body = _read_raw(path)
        except Exception:  # noqa: BLE001 — skip malformed files during selection
            continue
        kind = str(metadata.get("post_kind") or "post").strip()
        if not include_microposts and kind != "post":
            continue
        year = _post_year(metadata)
        if year is None or year > year_max:
            continue
        pool.append(path)

    print(
        f"  candidate pool: {len(pool)} posts "
        f"(post_kind={'any' if include_microposts else 'post'}, year ≤ {year_max})",
        flush=True,
    )
    if count is None or count >= len(pool):
        return pool
    return random.Random(seed).sample(pool, count)


def find_by_microblog_id(mbid: str) -> Optional[Path]:
    """Locate one post file by its ``microblog_id`` front-matter value."""
    needle = f"microblog_id: {mbid}"
    for path in BLOG_POSTS_DIR.rglob("*.md"):
        head = path.read_text(encoding="utf-8")[:400]
        if needle in head:
            return path
    return None


# ── de-wrap core (deterministic) ──────────────────────────────────────


def _is_prose_block(lines: list[str]) -> bool:
    """A flat-prose block has no structural markers — no heading / list / quote /
    hr / table (`|`) / HTML line (incl. ``<img>``). Those keep their line breaks."""
    for ln in lines:
        if (
            _HEADING_RE.match(ln)
            or _ULIST_RE.match(ln)
            or _OLIST_RE.match(ln)
            or _QUOTE_RE.match(ln)
            or _HR_RE.match(ln)
            or "|" in ln
            or ln.lstrip().startswith("<")
        ):
            return False
    return True


def _is_wrap_block(lines: list[str]) -> bool:
    """True when this flat-prose block looks machine-wrapped: ≥2 lines and at least
    one non-final line is "full" (in the wrap band) without a markdown hard break."""
    if len(lines) < 2 or not _is_prose_block(lines):
        return False
    return any(
        _WRAP_MIN_LEN <= len(ln) <= _WRAP_MAX_LEN
        and not ln.endswith("  ")
        and not ln.endswith("\\")
        for ln in lines[:-1]
    )


def _inside_link_dest(s: str) -> bool:
    """True when ``s`` ends inside an unclosed markdown link destination — the last
    ``](`` has no closing ``)`` after it. Used to avoid inserting a space into a
    URL that pandoc happened to wrap (a space in text is right; in a URL it breaks)."""
    i = s.rfind("](")
    if i == -1:
        return False
    return ")" not in s[i + 2 :]


def _join_wrapped(lines: list[str]) -> list[str]:
    """Join machine-wrapped lines of one prose block onto single logical line(s).
    A trailing ``  `` or ``\\`` is an intentional markdown hard break and is
    preserved (the join stops there). Joins insert a single space, except inside an
    unclosed link URL where they insert nothing."""
    out: list[str] = []
    cur = lines[0]
    for nxt in lines[1:]:
        if cur.endswith("\\") or cur.endswith("  "):
            out.append(cur)  # intentional hard break — don't merge across it
            cur = nxt
        elif _inside_link_dest(cur.rstrip()):
            cur = cur.rstrip() + nxt.lstrip()  # mid-URL: no space
        else:
            cur = cur.rstrip() + " " + nxt.lstrip()  # normal prose wrap: single space
    out.append(cur)
    return out


def dewrap_body(body: str) -> tuple[str, list[dict[str, Any]]]:
    """Return ``(new_body, changes)``. Only flat-prose wrap-flagged blocks are
    rejoined; fenced code, blank lines, and every structural block are emitted
    verbatim, so the rewrite differs from the original ONLY where prose was
    de-wrapped. 1-based line numbers in ``changes``."""
    lines = body.split("\n")
    out: list[str] = []
    changes: list[dict[str, Any]] = []
    in_fence = False
    block: list[str] = []
    block_start = 0

    def flush() -> None:
        nonlocal block
        if not block:
            return
        if _is_wrap_block(block):
            joined = _join_wrapped(block)
            if joined != block:
                changes.append(
                    {
                        "line_start": block_start,
                        "lines_before": len(block),
                        "lines_after": len(joined),
                        "link_split": bool(_LINK_SPLIT_RE.search("\n".join(block))),
                        "sample": block[0][:80],
                    }
                )
            out.extend(joined)
        else:
            out.extend(block)
        block = []

    for i, line in enumerate(lines, 1):
        s = line.lstrip()
        if s.startswith("```") or s.startswith("~~~"):
            flush()
            in_fence = not in_fence
            out.append(line)
            continue
        if in_fence:
            out.append(line)
            continue
        if not line.strip():
            flush()
            out.append(line)
            continue
        if not block:
            block_start = i
        block.append(line)
    flush()
    return "\n".join(out), changes


# ── per-post processing ───────────────────────────────────────────────


def _backup_live(mbid: Any, live_body: str) -> Path:
    """Back up the live micro.blog body before a write, keyed by microblog_id (same
    scheme as the alt-text backfill). Overwrites any prior backup so it always holds
    the body as it was right before THIS write — the thing you'd restore."""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    dest = BACKUP_DIR / f"{mbid}.md"
    dest.write_text(live_body, encoding="utf-8")
    return dest


def _is_throttle(exc: Exception) -> bool:
    """A micro.blog throttle / transient transport error worth retrying (vs. a
    permanent failure like a missing post)."""
    msg = str(exc).lower()
    return any(m in msg for m in _THROTTLE_MARKERS)


def _with_retry(fn, *, what: str, mbid: Any):
    """Call ``fn()``, retrying only on throttle/transient responses with growing
    backoff. Permanent errors raise immediately; a throttle that outlasts every
    backoff raises after the final wait."""
    for i, wait in enumerate((*_RETRY_BACKOFFS, None)):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 — re-raised unless retryable
            if wait is None or not _is_throttle(exc):
                raise
            print(
                f"  … [{mbid}] {what} throttled ({exc}); backoff {wait}s "
                f"(retry {i + 1}/{len(_RETRY_BACKOFFS)})",
                flush=True,
            )
            time.sleep(wait)


def _print_diff(old: str, new: str, label: str) -> None:
    for ln in difflib.unified_diff(
        old.split("\n"),
        new.split("\n"),
        fromfile=label,
        tofile=label + "  (dewrapped)",
        lineterm="",
    ):
        print(f"    {ln}", flush=True)


def _change_stats(changes: list[dict[str, Any]]) -> tuple[int, int, int]:
    """(paragraphs, lines_removed, link_splits) for a list of de-wrap changes."""
    paras = len(changes)
    lines_removed = sum(c["lines_before"] - c["lines_after"] for c in changes)
    splits = sum(1 for c in changes if c["link_split"])
    return paras, lines_removed, splits


# ── orchestration ─────────────────────────────────────────────────────


def run(
    *,
    count: Optional[int],
    year_max: int,
    seed: int,
    include_microposts: bool,
    only: Optional[str],
    write: bool,
    show_diff: bool,
) -> int:
    mode = (
        "WRITE → micro.blog (cache NOT synced; re-ingest after)"
        if write
        else "DRY-RUN (local-cache preview, no writes, no API)"
    )
    print(f"\n── blog de-wrap · {mode} ──", flush=True)
    if write:
        print(
            f"  backups → {BACKUP_DIR.relative_to(REPO)}/{{microblog_id}}.md  "
            "(pre-write live body)",
            flush=True,
        )

    if only:
        path = find_by_microblog_id(only)
        if not path:
            print(f"  no post found with microblog_id {only}", flush=True)
            return 1
        paths = [path]
    else:
        paths = select_posts(
            count=count, year_max=year_max, seed=seed, include_microposts=include_microposts
        )
    print(f"  processing {len(paths)} post(s)\n", flush=True)

    posts_out: list[dict[str, Any]] = []
    n_candidates = n_written = n_failed = n_noop = 0
    total_paras = total_lines = total_splits = 0

    for path in paths:
        try:
            metadata, _fm, body_local = _read_raw(path)
        except Exception as exc:  # noqa: BLE001
            print(f"  ! skip {path.relative_to(REPO)}: {exc}", flush=True)
            continue
        mbid = metadata.get("microblog_id")
        url = str(metadata.get("url") or "").strip()
        year = _post_year(metadata)

        # Cheap discovery from the local cache (no API): is this a wrap candidate?
        body_local = body_local.strip()
        new_local, changes_local = dewrap_body(body_local)
        if not changes_local or new_local == body_local:
            continue  # nothing to de-wrap here
        n_candidates += 1

        rec: dict[str, Any] = {
            "path": str(path.relative_to(REPO)),
            "microblog_id": mbid,
            "url": url,
            "year": year,
        }

        if not write:
            paras, lines_removed, splits = _change_stats(changes_local)
            total_paras += paras
            total_lines += lines_removed
            total_splits += splits
            rec.update(
                paragraphs_dewrapped=paras,
                lines_removed=lines_removed,
                link_splits_fixed=splits,
                source="local-cache",
            )
            split = f" link-splits×{splits}" if splits else ""
            print(
                f"  [{mbid}] {year}  would fix: -{lines_removed} lines across "
                f"{paras} para(s){split}  {path.name}",
                flush=True,
            )
            if show_diff or only:
                _print_diff(body_local, new_local, rec["path"])
            posts_out.append(rec)
            continue

        # --- write path: re-fetch LIVE so a newer micro.blog edit is never clobbered ---
        if not url:
            n_failed += 1
            print(f"  ! [{mbid}] no url in front matter — cannot write, skipping", flush=True)
            continue
        try:
            props = _with_retry(
                lambda: microblog.source_for_url(url), what="live re-fetch", mbid=mbid
            )
            live_body = microblog._content_to_markdown(props.get("content"))
        except Exception as exc:  # noqa: BLE001
            n_failed += 1
            print(f"  ! [{mbid}] live re-fetch failed, skipping: {exc}", flush=True)
            continue
        time.sleep(_API_THROTTLE_S)  # space every API touch (incl. re-run no-ops)

        new_live, changes_live = dewrap_body(live_body)
        if not changes_live or new_live == live_body:
            n_noop += 1
            print(
                f"  = [{mbid}] no wraps live (clean / edited since ingest) — skipped  {path.name}",
                flush=True,
            )
            continue

        paras, lines_removed, splits = _change_stats(changes_live)
        _backup_live(mbid, live_body)
        try:
            _with_retry(
                lambda: microblog.update_post_content(url, new_live), what="write", mbid=mbid
            )
        except Exception as exc:  # noqa: BLE001
            n_failed += 1
            print(
                f"  ! [{mbid}] micro.blog write FAILED (backup kept, retry next run): {exc}",
                flush=True,
            )
            continue

        n_written += 1
        total_paras += paras
        total_lines += lines_removed
        total_splits += splits
        rec.update(
            paragraphs_dewrapped=paras,
            lines_removed=lines_removed,
            link_splits_fixed=splits,
            written=True,
            source="micro.blog-live",
        )
        split = f" link-splits×{splits}" if splits else ""
        print(
            f"  ✓ [{mbid}] {year}  wrote: -{lines_removed} lines across "
            f"{paras} para(s){split}  {url}",
            flush=True,
        )
        if show_diff or only:
            _print_diff(live_body, new_live, rec["path"])
        posts_out.append(rec)

    _write_report(
        count=count,
        year_max=year_max,
        seed=seed,
        only=only,
        write=write,
        totals={
            "candidates": n_candidates,
            "written": n_written,
            "noop_live": n_noop,
            "failed": n_failed,
            "paragraphs_dewrapped": total_paras,
            "lines_removed": total_lines,
            "link_splits_fixed": total_splits,
        },
        posts=posts_out,
    )

    print("\n── summary ──", flush=True)
    print(f"  wrap candidates (cache): {n_candidates}", flush=True)
    if write:
        print(f"  written to micro.blog:   {n_written}", flush=True)
        print(f"  no-op live (skipped):    {n_noop}", flush=True)
        print(f"  failed:                  {n_failed}", flush=True)
    print(f"  paragraphs de-wrapped:   {total_paras}", flush=True)
    print(f"  lines removed:           {total_lines}", flush=True)
    print(f"  link-splits rejoined:    {total_splits}", flush=True)
    if not write and n_candidates:
        print(
            "\n  dry-run — nothing written. Re-run with --write to apply to micro.blog.", flush=True
        )
    if write and n_written:
        print(
            "\n  micro.blog updated. Local cache is now STALE — refresh it with:\n"
            "    uv run --locked python pipeline/blog/ingest_blog.py\n"
            "  then re-embed: npm run librarian:deploy:blog",
            flush=True,
        )
    return 0


def _write_report(
    *,
    count: Optional[int],
    year_max: int,
    seed: int,
    only: Optional[str],
    write: bool,
    totals: dict[str, Any],
    posts: list[dict[str, Any]],
) -> None:
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = RUN_DIR / f"dewrap-{ts}.json"
    slim = [{k: v for k, v in p.items() if not k.startswith("_")} for p in posts]
    path.write_text(
        json.dumps(
            {
                "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "mode": "write" if write else "dry-run",
                "count": count,
                "year_max": year_max,
                "seed": seed,
                "only": only,
                "totals": totals,
                "posts": slim,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"\n  report: {path.relative_to(REPO)}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="De-wrap pandoc-wrapped blog prose (dry-run by default)"
    )
    ap.add_argument(
        "--count",
        type=int,
        default=100,
        help="how many posts to sample (default 100; ignored with --all/--only)",
    )
    ap.add_argument(
        "--all", action="store_true", help="process the whole eligible pool (no sampling cap)"
    )
    ap.add_argument(
        "--year-max",
        type=int,
        default=2017,
        help="only touch posts published in or before this year (default 2017)",
    )
    ap.add_argument(
        "--seed", type=int, default=0, help="random seed for reproducible sampling (default 0)"
    )
    ap.add_argument(
        "--include-microposts",
        action="store_true",
        help="include post_kind=micropost (default: long-form posts only)",
    )
    ap.add_argument(
        "--only", default=None, help="process a single post by microblog_id (ignores sampling)"
    )
    ap.add_argument(
        "--write",
        action="store_true",
        help="apply the de-wrap to micro.blog (default is dry-run); re-fetches "
        "live + backs up the original body first. Cache is refreshed by re-ingest.",
    )
    ap.add_argument(
        "--show-diff",
        action="store_true",
        help="print a unified diff for every changed post (always on for --only)",
    )
    args = ap.parse_args()

    if not BLOG_POSTS_DIR.exists():
        print(f"error: {BLOG_POSTS_DIR} not found — run ingest_blog.py first", flush=True)
        return 1

    return run(
        count=None if args.all else args.count,
        year_max=args.year_max,
        seed=args.seed,
        include_microposts=args.include_microposts,
        only=args.only,
        write=args.write,
        show_diff=args.show_diff,
    )


if __name__ == "__main__":
    raise SystemExit(main())
