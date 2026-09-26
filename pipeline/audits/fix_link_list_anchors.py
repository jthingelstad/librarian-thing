#!/usr/bin/env python3
"""
Historical repair: pull the whole page title inside the link on MailChimp-era
link-list items where the linkifier bracketed only the tail of it.

The "Yet More Links 🍞" and "Local 📍" lists (WT53–WT130) render one link per
bullet — title, link, source domain:

    - [Title of the page](https://host/path) host

The MailChimp-era linkifier often opened the bracket partway through the
title, leaving the head of it outside the link:

    - Title of [the page](https://host/path) host

This moves the opening bracket back to the start of the item. Nothing else
changes: no words added or removed, the URL and trailing domain untouched.
Only lines that end in a bare domain equal to the link's own host are
touched, which confines the repair to those link lists — prose and microblog
`[→](url)` items never match. Front matter is never read or written.

Tracked as jthingelstad/weekly.thingelstad.com#8. Idempotent: a repaired line
has no text before the bracket, so it no longer matches.

  uv run --locked python pipeline/audits/fix_link_list_anchors.py --dry-run
  uv run --locked python pipeline/audits/fix_link_list_anchors.py
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
ISSUES = ROOT / "data" / "issues"
FRONTMATTER_RE = re.compile(r"^---\n.*?\n---\n", re.S)
ITEM_RE = re.compile(
    r"^- (?P<head>[^\[\]\n]+?) \[(?P<tail>[^\[\]\n]+)\]"
    r"\((?P<url>https?://[^)\s]*)\) (?P<domain>[a-z0-9.-]+\.[a-z]{2,})$",
    re.M,
)


def repair(body: str) -> tuple[str, int]:
    def fix(m: re.Match[str]) -> str:
        if urlparse(m["url"]).hostname != m["domain"]:
            return m[0]
        return f"- [{m['head']} {m['tail']}]({m['url']}) {m['domain']}"

    fixed = ITEM_RE.sub(fix, body)
    changed = sum(a != b for a, b in zip(body.splitlines(), fixed.splitlines(), strict=True))
    return fixed, changed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    files = 0
    fixes = 0
    for path in sorted(ISSUES.glob("*/archive.md")):
        text = path.read_text()
        m = FRONTMATTER_RE.match(text)
        head, body = (text[: m.end()], text[m.end() :]) if m else ("", text)
        fixed, count = repair(body)
        if not count:
            continue
        files += 1
        fixes += count
        print(f"{'would fix' if args.dry_run else 'fixed'} {path.parent.name}: {count}")
        if not args.dry_run:
            path.write_text(head + fixed)
    print(f"{files} files, {fixes} link-list items")
    return 0


if __name__ == "__main__":
    sys.exit(main())
