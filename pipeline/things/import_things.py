"""Snapshot Jamie's project registry into Librarian data.

thingelstad.xyz ("Things I've built") publishes its registry as JSON at
``/things.json``: every thing with its status, dates, topics, sources,
connections, story and the latest observation per source, plus the sourced
history ledger and the topic list. That site owns the registry; Librarian
owns the corpus, so this importer copies a normalized snapshot into
``data/things/things.json`` and the corpus build reads that stable local
file instead of fetching the live site at build time.

The snapshot drops the site's ``generated`` timestamp and sorts the lists,
so a run with no registry change writes nothing and the sync workflow has
nothing to commit.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import requests
from librarian_core.paths import THINGS_PATH, THINGS_URL

REQUIRED_THING_FIELDS = ("id", "title", "status", "page")
STATUSES = {"active", "dormant", "retired", "archived"}


def normalize(payload: Any) -> dict[str, Any]:
    """The snapshot shape: ``site``, ``things``, ``topics`` and ``history``
    with stable ordering and no build timestamp. Raises ``RuntimeError``
    when the payload is not a registry."""
    if not isinstance(payload, dict):
        raise RuntimeError("things.json is not an object")
    for key in ("site", "things", "topics", "history"):
        if key not in payload:
            raise RuntimeError(f"things.json is missing {key!r}")
    things = payload["things"]
    if not isinstance(things, list) or not things:
        raise RuntimeError("things.json has no things")
    for thing in things:
        if not isinstance(thing, dict):
            raise RuntimeError("a thing is not an object")
        missing = [field for field in REQUIRED_THING_FIELDS if not thing.get(field)]
        if missing:
            raise RuntimeError(f"thing {thing.get('id')!r} is missing {', '.join(missing)}")
        if thing["status"] not in STATUSES:
            raise RuntimeError(f"thing {thing['id']!r} has unknown status {thing['status']!r}")
        if not str(thing["page"]).startswith("https://"):
            raise RuntimeError(f"thing {thing['id']!r} page is not an https URL")
    ids = [thing["id"] for thing in things]
    if len(set(ids)) != len(ids):
        raise RuntimeError("thing ids are not unique")
    return {
        "site": str(payload["site"]),
        "things": sorted(things, key=lambda thing: thing["id"]),
        "topics": sorted(payload["topics"] or [], key=lambda topic: str(topic.get("id"))),
        "history": sorted(
            payload["history"] or [],
            key=lambda event: (str(event.get("date")), str(event.get("id"))),
        ),
    }


def fetch(source: str) -> Any:
    if source.startswith(("http://", "https://")):
        response = requests.get(source, timeout=30, headers={"Accept": "application/json"})
        response.raise_for_status()
        return response.json()
    return json.loads(Path(source).read_text(encoding="utf-8"))


def write_snapshot(snapshot: dict[str, Any], output: Path) -> bool:
    """Write ``snapshot`` to ``output``; False when the file already held it."""
    text = json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n"
    if output.exists() and output.read_text(encoding="utf-8") == text:
        return False
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text, encoding="utf-8")
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", default=THINGS_URL, help="things.json URL or local path")
    parser.add_argument("--output", default=str(THINGS_PATH), help="snapshot path")
    args = parser.parse_args(argv)
    try:
        snapshot = normalize(fetch(args.source))
    except (RuntimeError, ValueError, requests.RequestException) as error:
        print(f"things import failed: {error}", file=sys.stderr)
        return 1
    changed = write_snapshot(snapshot, Path(args.output))
    print(
        f"things: {len(snapshot['things'])} things, {len(snapshot['topics'])} topics, "
        f"{len(snapshot['history'])} history events from {args.source}"
        + ("" if changed else " (unchanged)")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
