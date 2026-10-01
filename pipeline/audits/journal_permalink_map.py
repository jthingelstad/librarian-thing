#!/usr/bin/env python3
"""
Build the reviewed map of dead Journal permalinks to the blog posts they copy.

micro.blog changed many www.thingelstad.com permalinks after the fact (Jamie,
2026-09-30), so a Weekly Thing Journal entry can link to a URL that no longer
answers while the post lives on at a new one. The corpus build already ties
each Journal entry to the post it copies: an entry matched by date and text
(``matched_by: "date_text"``) is an old permalink with a known new home, its
``url`` -> ``canonical_url``. This writes those pairs out for review, then
confirms each with GETs only (never a write):

  old URL 3xx to the new URL     -> confirmed (the host says so)
  old 404/410, new 200, texts match -> confirmed
  both 200, texts match          -> confirmed (Jamie, 2026-10-01: repair a
                                    both-200 row when the texts match)
  anything else                  -> review (Jamie decides; never repaired)

"Texts match" means the Weekly Thing entry's words are in the post at
TEXT_MATCH or better (the matcher's own share, _entry_score) and, for a
both-200 row, the two live pages carry the same post text.

The entries the build could not match (``journal_unmatched``) are listed
separately with no proposed target.

  uv run --locked python pipeline/audits/journal_permalink_map.py \
      --corpus /tmp/qa2/corpus/corpus.json            # map + live checks
  uv run --locked python pipeline/audits/journal_permalink_map.py \
      --corpus ... --no-fetch                          # map only

Writes tmp/journal-permalinks.csv and tmp/journal-permalinks-unmatched.csv.
repair_journal_permalinks.py applies the confirmed rows.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "librarian-core"))

from librarian_core.corpus import (  # noqa: E402
    ARCHIVE_DIR,
    _copy_words,
    _entry_score,
    _journal_entries,
    _shingles,
    journal_post_index,
    journal_section_indexes,
    read_issue,
    split_issue_sections,
    strip_thingy_blocks,
)

OUT = ROOT / "tmp" / "journal-permalinks.csv"
UNMATCHED_OUT = ROOT / "tmp" / "journal-permalinks-unmatched.csv"
TEXT_MATCH = 0.9  # share of the entry's distinct words found in the post
PAGE_MATCH = 0.5  # share of the post's shingles found on the old live page
USER_AGENT = "librarian-thing journal permalink audit (read-only; jamie@thingelstad.com)"
FIELDS = [
    "issue",
    "old_url",
    "new_url",
    "microblog_id",
    "date",
    "entry_text",
    "post_text",
    "similarity",
    "old_status",
    "old_final",
    "new_status",
    "new_final",
    "repair_to",
    "page_similarity",
    "verdict",
    "reason",
]


def entry_texts(number: int) -> dict[str, str]:
    """Each Journal entry's own text in issue ``number``, by its link URL."""
    path = ARCHIVE_DIR / str(number) / "archive.md"
    _metadata, body = read_issue(path)
    split = split_issue_sections(strip_thingy_blocks(body))
    journal = [split[i] for i in journal_section_indexes(split)]
    return {entry.url: entry.text for entry in _journal_entries(journal)}


def excerpt(text: str, n: int = 80) -> str:
    return " ".join(" ".join(_copy_words(text)).split())[:n]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: ANN002, ANN003
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _get_once(url: str) -> tuple[int, str, str]:
    """(status, Location, body text) of one GET, redirects not followed."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(3):
        try:
            with _OPENER.open(request, timeout=20) as response:
                return response.status, "", response.read(400_000).decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            if error.code in (429, 502, 503, 504) and attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            return error.code, error.headers.get("Location", "") or "", ""
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            return 0, str(getattr(error, "reason", error)), ""
    return 0, "retries exhausted", ""


def get(url: str) -> tuple[int, str, str, int]:
    """(final status, final URL, body, hops): GETs along the redirect chain,
    at most five hops. An http:// link 308s to https:// before it answers,
    and a jthingelstad.micro.blog URL 308s to www.thingelstad.com."""
    current = url
    for hops in range(6):
        status, location, body = _get_once(current)
        if status in (301, 302, 303, 307, 308) and location and hops < 5:
            current = urllib.parse.urljoin(current, location)
            continue
        return status, current, body, hops
    return 0, current, "", 5


_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.S | re.I)


def page_words(page: str) -> list[str]:
    return _copy_words(html.unescape(_TAG_RE.sub(" ", _SCRIPT_RE.sub(" ", page))))


def same_url(a: str, b: str) -> bool:
    def norm(u: str) -> str:
        return re.sub(r"^https?://(www\.)?", "", u.strip()).rstrip("/").lower()

    return norm(a) == norm(b)


def judge(row: dict, old: tuple, new: tuple, post_words) -> None:
    """Fill the row's live columns and its verdict from the two GET chains."""
    row["old_status"], row["old_final"] = old[0], old[1] if old[3] else ""
    row["new_status"], row["new_final"] = new[0], new[1] if new[3] else ""
    # The repair target is where the post answers, on the canonical host.
    row["repair_to"] = new[1] if new[0] == 200 else ""
    matched = float(row["similarity"]) >= TEXT_MATCH
    if new[0] != 200:
        row["verdict"], row["reason"] = "review", f"new URL answers {new[0]}"
        return
    if old[0] == 200 and same_url(old[1], new[1]):
        row["verdict"], row["reason"] = "confirmed", "old redirects to new"
        return
    if old[0] in (404, 410):
        if matched:
            row["verdict"], row["reason"] = "confirmed", "old dead, new live, texts match"
        else:
            row["verdict"], row["reason"] = "review", "old dead, but the texts differ"
        return
    if old[0] == 200:
        post = _shingles(post_words)
        old_page = _shingles(page_words(old[2]))
        page_share = len(post & old_page) / len(post) if post else 0.0
        row["page_similarity"] = f"{page_share:.2f}"
        if matched and page_share >= PAGE_MATCH:
            row["verdict"], row["reason"] = "confirmed", "both live, same post text"
        else:
            row["verdict"], row["reason"] = "review", "both live, texts differ"
        return
    row["verdict"], row["reason"] = "review", f"old URL answers {old[0]}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, required=True, help="a built corpus.json")
    parser.add_argument("--no-fetch", action="store_true", help="write the map without GETs")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    corpus = json.loads(args.corpus.read_text())
    posts = journal_post_index().by_id
    rows: list[dict] = []
    texts_by_issue: dict[int, dict[str, str]] = {}
    for issue in corpus["issues"]:
        for entry in issue.get("journal_entries") or []:
            if entry.get("matched_by") != "date_text" or not entry.get("url"):
                continue
            number = int(issue["number"])
            texts = texts_by_issue.setdefault(number, entry_texts(number))
            text = texts.get(entry["url"], "")
            post = posts.get(str(entry["copy_of_microblog_id"]))
            tokens = _copy_words(text)
            score = _entry_score(tokens, post) if post and tokens else 0.0
            path_day = re.search(r"/(\d{4})/(\d{2})/(\d{2})/", entry["url"])
            rows.append(
                {
                    "issue": number,
                    "old_url": entry["url"],
                    "new_url": entry["canonical_url"],
                    "microblog_id": str(entry["copy_of_microblog_id"]),
                    "date": "-".join(path_day.groups()) if path_day else "",
                    "entry_text": excerpt(text),
                    "post_text": excerpt(" ".join(post.words)) if post else "",
                    "similarity": f"{score:.2f}",
                    "old_status": "",
                    "old_final": "",
                    "new_status": "",
                    "new_final": "",
                    "repair_to": "",
                    "page_similarity": "",
                    "verdict": "unchecked",
                    "reason": "",
                }
            )

    if not args.no_fetch:
        urls = sorted({row["old_url"] for row in rows} | {row["new_url"] for row in rows})
        with concurrent.futures.ThreadPoolExecutor(args.workers) as pool:
            fetched = dict(zip(urls, pool.map(get, urls), strict=True))
        for row in rows:
            post = posts.get(row["microblog_id"])
            judge(row, fetched[row["old_url"]], fetched[row["new_url"]], post.words if post else ())

    OUT.parent.mkdir(exist_ok=True)
    with OUT.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(sorted(rows, key=lambda r: (r["issue"], r["old_url"])))
    with UNMATCHED_OUT.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["issue", "url", "title"])
        writer.writeheader()
        for item in corpus.get("journal_unmatched") or []:
            writer.writerow(
                {"issue": item["issue_number"], "url": item["url"], "title": item["title"]}
            )

    verdicts: dict[str, int] = {}
    for row in rows:
        verdicts[row["verdict"]] = verdicts.get(row["verdict"], 0) + 1
    print(f"{len(rows)} pairs -> {OUT.relative_to(ROOT)}: {verdicts}")
    print(
        f"{len(corpus.get('journal_unmatched') or [])} unmatched -> "
        f"{UNMATCHED_OUT.relative_to(ROOT)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
