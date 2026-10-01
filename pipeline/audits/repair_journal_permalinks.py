#!/usr/bin/env python3
"""
Historical repair: point dead Journal permalinks at the posts they copy.

micro.blog changed many www.thingelstad.com permalinks after the fact and
merged some same-day microposts into one post (Jamie, 2026-09-30). This takes
the reviewed map from journal_permalink_map.py (snapshot in
notes/audits/journal-permalinks-2026-10-01.csv) and rewrites each confirmed
row's link target in both copies of the issue:

- data/issues/N/archive.md (canonical), and
- ../weekly.thingelstad.com/apps/site/archive/N.md (the render copy, by
  sibling-relative path, committed in that repo).

Only an exact Markdown link target changes: "](old)" becomes "](new)". Link
text, front matter (the render copy's audio_* record included) and every
other byte stay as they are. Rows whose verdict is not "confirmed" are never
applied. Issues WT Builder wrote (WT350 on) are refused: fix those in WT
Builder and re-send. Idempotent: a repaired link no longer matches.

  uv run --locked python pipeline/audits/repair_journal_permalinks.py --dry-run
  uv run --locked python pipeline/audits/repair_journal_permalinks.py
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ISSUES = ROOT / "data" / "issues"
SITE_ARCHIVE = ROOT.parent / "weekly.thingelstad.com" / "apps" / "site" / "archive"
MAP = ROOT / "notes" / "audits" / "journal-permalinks-2026-10-01.csv"
FIRST_BUILDER_ISSUE = 350
FRONT_MATTER_RE = re.compile(r"\A---\n.*?\n---\n", re.S)


def confirmed_rows(path: Path) -> dict[int, dict[str, str]]:
    """{issue: {old URL: new URL}} for every confirmed row."""
    by_issue: dict[int, dict[str, str]] = defaultdict(dict)
    with path.open(newline="") as handle:
        for row in csv.DictReader(handle):
            if row["verdict"] != "confirmed" or not row["repair_to"]:
                continue
            issue = int(row["issue"])
            if issue >= FIRST_BUILDER_ISSUE:
                raise SystemExit(f"WT{issue} is a WT Builder issue: fix it there and re-send")
            by_issue[issue][row["old_url"]] = row["repair_to"]
    return by_issue


def repair(text: str, pairs: dict[str, str]) -> tuple[str, int]:
    """``text`` with each "](old)" target replaced, and how many changed.
    Front matter is split off first and returned untouched."""
    match = FRONT_MATTER_RE.match(text)
    head, body = (match.group(0), text[match.end() :]) if match else ("", text)
    changed = 0
    for old, new in pairs.items():
        target = f"]({old})"
        count = body.count(target)
        if count:
            body = body.replace(target, f"]({new})")
            changed += count
    return head + body, changed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--map", type=Path, default=MAP)
    parser.add_argument("--site-archive", type=Path, default=SITE_ARCHIVE)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    rows = confirmed_rows(args.map)
    totals = {"canonical": 0, "render": 0}
    for issue, pairs in sorted(rows.items()):
        counts = []
        for label, path in (
            ("canonical", ISSUES / str(issue) / "archive.md"),
            ("render", args.site_archive / f"{issue}.md"),
        ):
            text = path.read_text()
            fixed, changed = repair(text, pairs)
            totals[label] += changed
            counts.append(changed)
            if changed and not args.dry_run:
                path.write_text(fixed)
        print(f"WT{issue}: {len(pairs)} rows, {counts[0]} canonical, {counts[1]} render")
    verb = "would change" if args.dry_run else "changed"
    print(
        f"{len(rows)} issues; {verb} {totals['canonical']} canonical and "
        f"{totals['render']} render-copy links"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
