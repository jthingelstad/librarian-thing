#!/usr/bin/env python3
"""Seed the library's ``alt_skips`` from the June 2026 alt backfill.

The blog round never drafts alt for an image in ``alt_skips``. Two sets
come from June:

- the uploads that answered 404/410 to the backfill (158, all from 2017).
  Their only record was the backfill's dead-url log, which lived in a
  gitignored ``tmp/`` of the old checkout
  (``weekly.thingelstad.com/tmp/blog-alt/dead-urls.txt``); a restore was
  asked of micro.blog on 2026-06-03.
- the eight images the backfill left for Jamie, who decided on 2026-06-03:
  "The rest just should not get alt text."

Idempotent: a URL already in ``alt_skips`` keeps its reason. Run against the
local library, then upload it (``library.py upload``).

    python pipeline/library/seed_alt_skips.py --dead-urls ../weekly.thingelstad.com/tmp/blog-alt/dead-urls.txt
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from librarian_core.library import connect
from librarian_core.library.db import now
from librarian_core.paths import REPO

DEFAULT_LIBRARY = REPO / ".library" / "library.db"
GONE = (
    "gone (404/410 to the June 2026 alt backfill); a restore was asked of micro.blog on 2026-06-03"
)
LEFT = 'left without alt by Jamie, 2026-06-03: "The rest just should not get alt text."'
JAMIE_LEFT = (
    "https://www.thingelstad.com/uploads/2019/e5dc49227d.jpg",
    "https://www.thingelstad.com/uploads/2019/386d999d1a.jpg",
    "https://www.thingelstad.com/uploads/2022/ce2c1b4a3e.png",
    "https://www.thingelstad.com/uploads/2023/c49ce55754.jpg",
    "https://www.thingelstad.com/uploads/2024/3bb04e540a.jpg",
    "https://www.thingelstad.com/uploads/2024/98a9c26a97.jpg",
    "https://www.thingelstad.com/uploads/2024/e9e60cb23c.jpg",
    "https://www.thingelstad.com/uploads/2024/ed448340cb.jpg",
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dead-urls", type=Path, required=True)
    parser.add_argument("--library", type=Path, default=DEFAULT_LIBRARY)
    args = parser.parse_args(argv)

    dead = sorted(
        {line.strip() for line in args.dead_urls.read_text().splitlines() if line.strip()}
    )
    rows = [(url, GONE) for url in dead] + [(url, LEFT) for url in JAMIE_LEFT]
    conn = connect(args.library)
    try:
        with conn:
            before = conn.execute("SELECT count(*) FROM alt_skips").fetchone()[0]
            conn.executemany(
                "INSERT OR IGNORE INTO alt_skips (url, reason, noted_at) VALUES (?, ?, ?)",
                [(url, reason, now()) for url, reason in rows],
            )
            after = conn.execute("SELECT count(*) FROM alt_skips").fetchone()[0]
    finally:
        conn.close()
    print(f"alt_skips: {after} ({after - before} added; {len(dead)} gone, {len(JAMIE_LEFT)} left)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
