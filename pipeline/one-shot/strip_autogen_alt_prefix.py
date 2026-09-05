#!/usr/bin/env python3
"""
Historical repair: strip Micro.blog's "Auto-generated description:" prefix
from image alt text inside published issue records.

The prefix is UI residue from Micro.blog's alt-text assistant. It was
removed from the live blog posts at the source (Micropub sweep, wt-builder
scripts/strip-autogen-alt.ts, 2026-09-05), but the Weekly Thing issues that
reprinted those journal photos carried the residue into data/issues/ — 55
occurrences across 17 pre-Builder archives (WT286–WT342), all inside
markdown image alts, leaking into 34 corpus chunks Thingy could quote.

Jamie approved the repair 2026-09-05: this is tool residue inside alt
attributes, invisible to readers — not authored words — which is exactly
the pre-Builder-repair lane. The description text is kept; only the label
goes.

  uv run --locked python pipeline/one-shot/strip_autogen_alt_prefix.py --dry-run
  uv run --locked python pipeline/one-shot/strip_autogen_alt_prefix.py
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ISSUES = ROOT / "data" / "issues"
PREFIX_RE = re.compile(r"Auto-generated description:\s*")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    files = 0
    fixes = 0
    for path in sorted(ISSUES.glob("*/archive.md")):
        text = path.read_text()
        fixed, count = PREFIX_RE.subn("", text)
        if not count:
            continue
        files += 1
        fixes += count
        print(f"{'would fix' if args.dry_run else 'fixed'} {path.parent.name}: {count}")
        if not args.dry_run:
            path.write_text(fixed)
    print(f"{files} files, {fixes} prefixes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
