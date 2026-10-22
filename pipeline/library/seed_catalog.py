#!/usr/bin/env python3
"""Seed the library's catalog from the 2026-10-21 categories overhaul.

The overhaul (www.thingelstad.com ``scripts/categories/``) labelled all 10,469
posts, built the categories, and wrote them to micro.blog on 10-22. Its
cache (``dev/cache/categories/`` there, gitignored) is the record of what it
decided and what it wrote. This copies that record into the library so nothing
already filed is classified again:

- ``categories``: every category the overhaul assigned, with its kind (trip,
  series, project, topic, kept; Featured is its own kind), slug and, for
  topics, the rule that says what belongs.
- ``labels``: the model's reading of each post (topics, subjects, gist, kind,
  place, substance, evergreen).
- ``filings``: what the write-back wrote to each post (its ``ok`` rows), or
  what the overhaul left as it was. The seven posts the write-back could not
  reach (each shares an address with an earlier post), and any post whose
  live categories no longer match what was filed, are seeded as Jamie-set
  with their live categories: a hand edit is never overwritten.

Run against a library whose blog pull is current (``library.py pull``); it
prints every post whose live categories differ from the overhaul's record.

    python pipeline/library/seed_catalog.py --cache ../www.thingelstad.com/dev/cache/categories
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from librarian_core.library import connect
from librarian_core.library.db import now

# The write-back's run (02:45Z to 10:38Z on 2026-10-22); posts it left as they
# were are filed as of its end.
OVERHAUL_FILED_AT = "2026-10-22T10:38:36Z"
LABELLED_AT = "2026-10-21T19:59:00Z"
LABEL_MODEL = "claude-opus-5-5"
DEFAULT_LIBRARY = Path(__file__).resolve().parents[2] / ".library" / "library.db"


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def load(cache: Path, name: str):
    return json.loads((cache / name).read_text(encoding="utf-8"))


def category_rows(cache: Path) -> list[tuple]:
    assignments = load(cache, "assignments.json")
    topics = {topic["name"]: topic for topic in load(cache, "taxonomy.json")["topics"]}
    collections = {
        entry["name"]: url
        for url, entry in load(cache, "collections.json").items()
        if entry.get("matched")
    }
    kinds: dict[str, str] = {}
    for record in assignments.values():
        kinds.update(record["groups"])
    rows = []
    for name, kind in sorted(kinds.items()):
        if name == "Featured":
            kind = "featured"
        why = None
        if name in topics:
            why = topics[name].get("rule") or None
        elif kind == "trip":
            why = (
                f"A trip's posts, from its collection page {collections[name]}"
                if name in collections
                else "A trip's posts"
            )
        description = (topics.get(name) or {}).get("intro") or None
        slug = (topics.get(name) or {}).get("slug") or slugify(name)
        rows.append((name, slug, kind, description, why, "overhaul", OVERHAUL_FILED_AT, None))
    return rows


def label_rows(cache: Path) -> list[tuple]:
    rows = []
    for post_id, label in sorted(load(cache, "labels.json").items(), key=lambda kv: int(kv[0])):
        rows.append(
            (
                f"blog-{post_id}",
                json.dumps(label.get("topics") or [], ensure_ascii=False),
                json.dumps(label.get("subjects") or [], ensure_ascii=False),
                label.get("gist") or None,
                label.get("kind") or None,
                label.get("place") or None,
                str(label["substance"]) if label.get("substance") is not None else None,
                None if label.get("evergreen") is None else int(bool(label["evergreen"])),
                LABEL_MODEL,
                LABELLED_AT,
            )
        )
    return rows


def filing_rows(cache: Path, live: dict[str, list[str]]) -> tuple[list[tuple], list[str]]:
    """Filings from the write-back log and the assignments, checked against
    the live categories. Returns the rows and a line per post seeded as
    Jamie-set."""
    assignments = load(cache, "assignments.json")
    log: dict[str, dict] = {}
    for line in (cache / "writeback" / "log.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            entry = json.loads(line)
            log[str(entry["id"])] = entry
    rows, jamie = [], []
    for post_id in sorted(assignments, key=int):
        entry = log.get(post_id)
        if entry and entry.get("status") == "ok":
            filed, at = list(entry["after"]), entry["at"].replace(".000Z", "Z")
        elif entry:  # the write-back could not reach it
            filed, at = None, None
        else:  # nothing to change
            filed, at = list(assignments[post_id]["after"]), OVERHAUL_FILED_AT
        source_id = f"blog-{post_id}"
        current = live.get(source_id)
        if current is None:
            jamie.append(f"{source_id}: not in the live pull, left unfiled")
            continue
        if filed is None or sorted(filed) != sorted(current):
            why = "the write-back could not reach it" if filed is None else f"filed {filed}"
            jamie.append(f"{source_id}: live {current} ({why})")
            rows.append(
                (source_id, json.dumps(current, ensure_ascii=False), "[]", 1, "jamie", now())
            )
        else:
            rows.append((source_id, json.dumps(filed, ensure_ascii=False), "[]", 0, "overhaul", at))
    return rows, jamie


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--library", type=Path, default=DEFAULT_LIBRARY)
    args = parser.parse_args(argv)

    conn = connect(args.library)
    try:
        live = {
            row["id"]: json.loads(row["categories"])
            for row in conn.execute("SELECT id, categories FROM sources WHERE id LIKE 'blog-%'")
        }
        categories = category_rows(args.cache)
        labels = label_rows(args.cache)
        filings, jamie = filing_rows(args.cache, live)
        with conn:
            conn.execute("DELETE FROM categories")
            conn.execute("DELETE FROM labels")
            conn.execute("DELETE FROM filings")
            conn.executemany("INSERT INTO categories VALUES (?, ?, ?, ?, ?, ?, ?, ?)", categories)
            conn.executemany(
                "INSERT INTO labels (source_id, topics, subjects, gist, kind, place, substance, "
                "evergreen, model, labeled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                labels,
            )
            conn.executemany(
                "INSERT INTO filings (source_id, categories, alt_filled, jamie_set, filed_by, "
                "filed_at) VALUES (?, ?, ?, ?, ?, ?)",
                filings,
            )
        unfiled = sorted(set(live) - {row[0] for row in filings}, key=lambda s: int(s[5:]))
    finally:
        conn.close()

    kinds: dict[str, int] = {}
    for row in categories:
        kinds[row[2]] = kinds.get(row[2], 0) + 1
    print(f"categories: {len(categories)} {kinds}")
    print(f"labels: {len(labels)}")
    print(
        f"filings: {len(filings)} ({sum(1 for r in filings if r[1] == '[]')} empty, "
        f"{sum(r[3] for r in filings)} Jamie-set)"
    )
    for line in jamie:
        print(f"  Jamie-set {line}")
    print(f"live posts with no filing (newer than the overhaul): {len(unfiled)}")
    for source_id in unfiled[:20]:
        print(f"  {source_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
