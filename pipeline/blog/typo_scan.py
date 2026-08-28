#!/usr/bin/env python3
"""Read-only typo detector across the micro.blog post history.

Jamie's blog was migrated to micro.blog by running pandoc over HTML from older
platforms. Most of the conversion artifacts are hard-wraps — those are handled
separately by ``pipeline/blog/dewrap.py``. This script does ONE other thing:
flag *simple, certain typos* with an LLM (Haiku by default) so a human can glance
and decide. It is strictly READ-ONLY — it never changes a post, never calls
micro.blog, never touches Pinboard, never commits. The only output is stdout + one
JSON report under ``tmp/blog-typos/``.

"Typo" here means very simple, certain mistakes only — clear spelling errors,
doubled words ("the the"), obvious wrong-word slips ("teh"). NOT grammar, style,
phrasing, punctuation, or capitalization. This is not an edit pass.

``<img>`` is the PREFERRED image format on this blog — the LLM is told never to
flag it. Line-wrap issues are explicitly out of scope (``dewrap.py`` owns them).

Usage::

    # 100 migrated-era long-form posts, Haiku
    python pipeline/blog/typo_scan.py --count 100 --seed 0

    # target one known post by micro.blog id (calibration)
    python pipeline/blog/typo_scan.py --only 1074933

    # escalate to a stronger model if Haiku is noisy
    python pipeline/blog/typo_scan.py --count 100 --seed 0 --model sonnet

Sampling weights to where the artifacts actually live: ``post_kind: post`` (drop
microposts) published in or before ``--year-max`` (default 2017, the migration era).
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import yaml
from dotenv import load_dotenv

sys.stdout.reconfigure(line_buffering=True)
load_dotenv()

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

import anthropic_client  # noqa: E402

BLOG_POSTS_DIR = REPO / "data" / "blog" / "posts"
RUN_DIR = REPO / "tmp" / "blog-typos"

# Front matter is `---\n<inner>\n---\n` at the very top (byte-stable, written by
# ingest_blog). Same regex the alt-text backfill and dewrap use.
_FM_RE = re.compile(r"\A---\n(?P<fm>.*?)\n---\n(?P<body>.*)\Z", re.DOTALL)


# ── local store ───────────────────────────────────────────────────────


def _read_blog_post(path: Path) -> tuple[dict[str, Any], str]:
    """Return ``(metadata, body)``. Raises on missing/malformed front matter."""
    raw = path.read_text(encoding="utf-8")
    m = _FM_RE.match(raw)
    if not m:
        raise RuntimeError(f"{path}: missing/malformed front matter")
    metadata = yaml.safe_load(m.group("fm")) or {}
    return metadata, m.group("body").strip()


def _post_year(metadata: dict[str, Any]) -> Optional[int]:
    raw = str(metadata.get("published") or "").strip()
    if len(raw) >= 4 and raw[:4].isdigit():
        return int(raw[:4])
    return None


# ── sampling ──────────────────────────────────────────────────────────


def select_posts(*, count: int, year_max: int, seed: int, include_microposts: bool) -> list[Path]:
    """Random sample of candidate posts, weighted to the migrated era.

    Pool = ``post_kind: post`` (unless ``include_microposts``) published in or
    before ``year_max``. Sampling is seeded for reproducible calibration runs.
    """
    pool: list[Path] = []
    for path in sorted(BLOG_POSTS_DIR.rglob("*.md")):
        try:
            metadata, _body = _read_blog_post(path)
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
    if count >= len(pool):
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


# ── LLM layer (typos only) ────────────────────────────────────────────

_LLM_PROMPT = """\
You are proofreading ONE blog post body for TYPOS only. Report ONLY clear, \
unambiguous mistakes:

- spelling errors ("recieve" -> "receive", "teh" -> "the")
- doubled words ("the the", "and and")
- obvious wrong-word slips where a real word is clearly the wrong one ("fro" for \
"for", "form" for "from")

Do NOT report:
- grammar, style, phrasing, word choice, or anything you'd "rephrase"
- punctuation, capitalization, or spacing preferences
- line-break, word-wrap, or hard-wrap issues (handled separately — ignore them)
- proper nouns, names, brands, slang, deliberate spellings, or foreign words
- <img> tags or any HTML/markdown — these are intentional; never flag them
- anything you are not certain is a mistake

When in doubt, leave it out. This is not an edit pass — only very simple, certain \
typos. Most posts will have NONE; an empty result is the common, correct answer.

Return STRICT JSON only — no prose, no markdown code fences:
{{"typos":[{{"text":"...","suggestion":"...","context":"..."}}]}}
where "context" is the short phrase around the typo so a human can locate it.
If there is nothing to report, return {{"typos":[]}}.

POST BODY:
---
{body}
---"""


def _parse_json_object(text: str) -> dict[str, Any]:
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < 0:
        raise ValueError(f"no JSON object in: {text[:200]}")
    return json.loads(text[start : end + 1])


def scan_typos(body: str, *, model: str, client: Any) -> dict[str, Any]:
    """One LLM call: simple typos as strict JSON. On parse failure records the raw
    text rather than raising, so one bad post can't abort the run. Returns the
    findings dict plus token usage for the spend total."""
    resp = client.messages.create(
        model=anthropic_client.MODELS[model],
        max_tokens=1024,
        messages=[{"role": "user", "content": _LLM_PROMPT.format(body=body)}],
    )
    text = "".join(b.text for b in resp.content if b.type == "text")
    usage = {
        "input_tokens": getattr(resp.usage, "input_tokens", 0) or 0,
        "output_tokens": getattr(resp.usage, "output_tokens", 0) or 0,
    }
    try:
        parsed = _parse_json_object(text)
        return {"typos": parsed.get("typos") or [], "usage": usage}
    except Exception:  # noqa: BLE001 — keep the run going; record raw for review
        return {"typos": [], "parse_error": text[:500], "usage": usage}


# ── orchestration ─────────────────────────────────────────────────────


def run_scan(
    *,
    count: int,
    year_max: int,
    seed: int,
    model: str,
    include_microposts: bool,
    only: Optional[str],
) -> int:
    print("\n── blog typo scan (read-only) ──", flush=True)

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
    print(f"  scanning {len(paths)} post(s); model={model}\n", flush=True)

    client = anthropic_client.client("general")

    posts_out: list[dict[str, Any]] = []
    in_tok = out_tok = 0
    n_typo_posts = total_typos = n_parse_errors = 0

    for path in paths:
        try:
            metadata, body = _read_blog_post(path)
        except Exception as exc:  # noqa: BLE001
            print(f"  ! skip {path.relative_to(REPO)}: {exc}", flush=True)
            continue

        mbid = metadata.get("microblog_id")
        url = str(metadata.get("url") or "").strip()
        year = _post_year(metadata)

        result = scan_typos(body, model=model, client=client)
        in_tok += result["usage"]["input_tokens"]
        out_tok += result["usage"]["output_tokens"]
        typos = result["typos"]

        record: dict[str, Any] = {
            "path": str(path.relative_to(REPO)),
            "microblog_id": mbid,
            "url": url,
            "year": year,
            "typos": typos,
        }
        if "parse_error" in result:
            record["parse_error"] = result["parse_error"]
            n_parse_errors += 1

        if typos:
            n_typo_posts += 1
        total_typos += len(typos)

        flag = f"typos={len(typos)}"
        if "parse_error" in result:
            flag += " parse-err"
        print(f"  [{mbid}] {year}  {flag}  {path.name}", flush=True)
        for t in typos:
            txt = str(t.get("text", "")).strip()
            sug = str(t.get("suggestion", "")).strip()
            print(f"        {txt!r} -> {sug!r}", flush=True)
        posts_out.append(record)

    cost = anthropic_client.cost_usd(
        anthropic_client.MODELS[model],
        input_tokens=in_tok,
        output_tokens=out_tok,
    )
    totals = {
        "posts_scanned": len(posts_out),
        "posts_with_typos": n_typo_posts,
        "total_typos": total_typos,
        "parse_errors": n_parse_errors,
        "input_tokens": in_tok,
        "output_tokens": out_tok,
        "cost_usd": cost,
    }
    _write_report(
        model=model,
        count=count,
        year_max=year_max,
        seed=seed,
        only=only,
        totals=totals,
        posts=posts_out,
    )

    print("\n── summary ──", flush=True)
    print(f"  posts scanned:    {totals['posts_scanned']}", flush=True)
    print(f"  with typos:       {n_typo_posts}  ({total_typos} total)", flush=True)
    if n_parse_errors:
        print(f"  parse errors:     {n_parse_errors}", flush=True)
    print(f"  tokens:           {in_tok} in / {out_tok} out", flush=True)
    print(f"  cost:             ${cost:.4f}" if cost is not None else "  cost: n/a", flush=True)
    return 0


def _write_report(
    *,
    model: str,
    count: int,
    year_max: int,
    seed: int,
    only: Optional[str],
    totals: dict[str, Any],
    posts: list[dict[str, Any]],
) -> None:
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = RUN_DIR / f"typos-{ts}.json"
    path.write_text(
        json.dumps(
            {
                "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "model": model,
                "count": count,
                "year_max": year_max,
                "seed": seed,
                "only": only,
                "totals": totals,
                "posts": posts,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"\n  report: {path.relative_to(REPO)}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="Read-only blog typo detector (Haiku)")
    ap.add_argument("--count", type=int, default=100, help="how many posts to sample (default 100)")
    ap.add_argument(
        "--year-max",
        type=int,
        default=2017,
        help="only sample posts published in or before this year (default 2017)",
    )
    ap.add_argument(
        "--seed", type=int, default=0, help="random seed for reproducible sampling (default 0)"
    )
    ap.add_argument(
        "--model",
        default="haiku",
        choices=sorted(anthropic_client.MODELS),
        help="LLM for the typo pass (default haiku)",
    )
    ap.add_argument(
        "--include-microposts",
        action="store_true",
        help="include post_kind=micropost (default: long-form posts only)",
    )
    ap.add_argument(
        "--only",
        default=None,
        help="scan a single post by microblog_id (calibration; ignores sampling)",
    )
    args = ap.parse_args()

    if not BLOG_POSTS_DIR.exists():
        print(f"error: {BLOG_POSTS_DIR} not found — run ingest_blog.py first", flush=True)
        return 1

    return run_scan(
        count=args.count,
        year_max=args.year_max,
        seed=args.seed,
        model=args.model,
        include_microposts=args.include_microposts,
        only=args.only,
    )


if __name__ == "__main__":
    raise SystemExit(main())
