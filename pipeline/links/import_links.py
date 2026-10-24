"""Snapshot Linking Things into Librarian data.

links.thingelstad.xyz ("Linking Things") publishes every public link Jamie
has saved since 2005 as a static database, rebuilt there nightly at 00:30 US
Central. That site owns the links; the Librarian depends on it and never the
reverse. This importer copies two of its files into the library's ``links/``
over HTTPS, and the links corpus build reads those stable local copies
instead of fetching the live site at build time:

- ``links.json``: one row per saved link (id, hash, url, title, note, saved,
  tags, toread, permalink, kind), newest first. A link's id is the first 12
  hex characters of the md5 of its URL exactly as saved; it is taken as
  published and never recomputed here.
- ``issues.json``: the links each Weekly Thing issue carried, joined to the
  saved links (a row's id is null when no saved link matched).

The snapshot drops what changes without the links changing (each file's
``generated`` stamp and ``count``, and a row's ``meta``, the bookmark
service's change signature, which nothing reads) and sorts both lists, so a
run with no new link writes nothing and the round has nothing to absorb.
A feed that would shrink the snapshot by more than a tenth is refused, as
the blog ingest refuses a partial walk.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import requests
from librarian_core.paths import LINK_ISSUES_URL, LINKS_DIR, LINKS_SITE, LINKS_URL

LINK_ID_RE = re.compile(r"^[0-9a-f]{12}$")
# Fields every saved link carries, in the order links.json gives them; meta
# is dropped (see the module docstring).
LINK_FIELDS = (
    "id",
    "hash",
    "url",
    "title",
    "note",
    "saved",
    "tags",
    "toread",
    "permalink",
    "kind",
)
ISSUE_LINK_FIELDS = ("position", "id", "url", "text", "section", "heading_context", "permalink")
# The share of the snapshot's links a new feed may drop before it is
# refused: more than this is a broken or partial feed, not Jamie deleting.
SHRINK_LIMIT = 0.10


def _saved_at(value: Any, link_id: str) -> str:
    text = str(value or "")
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise RuntimeError(f"link {link_id} has an unreadable saved time {text!r}") from error
    return text


def normalize_links(payload: Any) -> dict[str, Any]:
    """The links snapshot: ``site`` and ``links`` (newest first, by saved
    time then id), every row with the fields in ``LINK_FIELDS``. Raises
    ``RuntimeError`` when the payload is not Linking Things' links.json."""
    if not isinstance(payload, dict):
        raise RuntimeError("links.json is not an object")
    rows = payload.get("links")
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("links.json has no links")
    count = payload.get("count")
    if count is not None and count != len(rows):
        raise RuntimeError(f"links.json says {count} links and holds {len(rows)}")
    site = str(payload.get("site") or LINKS_SITE).rstrip("/")
    links: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            raise RuntimeError("a link is not an object")
        link_id = str(row.get("id") or "")
        if not LINK_ID_RE.match(link_id):
            raise RuntimeError(f"link id {link_id!r} is not 12 hex characters")
        url = row.get("url")
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            raise RuntimeError(f"link {link_id} has no http(s) url")
        tags = row.get("tags") or []
        if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
            raise RuntimeError(f"link {link_id} tags are not a list of words")
        link = {
            "id": link_id,
            "hash": str(row.get("hash") or ""),
            "url": url,
            "title": str(row.get("title") or ""),
            "note": str(row.get("note") or ""),
            "saved": _saved_at(row.get("saved"), link_id),
            "tags": list(tags),
            "toread": bool(row.get("toread")),
            "permalink": str(row.get("permalink") or f"{site}/links/{link_id}/"),
            "kind": str(row.get("kind") or "page"),
        }
        links.append(link)
    ids = [link["id"] for link in links]
    if len(set(ids)) != len(ids):
        raise RuntimeError("link ids are not unique")
    links.sort(key=lambda link: (link["saved"], link["id"]), reverse=True)
    return {"site": site, "links": links}


def _issue_key(issue: dict[str, Any]) -> tuple[str, str]:
    return (str(issue.get("date") or ""), str(issue.get("url") or ""))


def normalize_issues(payload: Any) -> dict[str, Any]:
    """The issues snapshot: ``site``, ``source`` and ``issues`` (oldest
    first), each issue's links by position. A link row's id is a saved
    link's or null; one naming no saved link is kept as published (the build
    finds nothing for it, and the import says how many, ``dangling_ids``)."""
    if not isinstance(payload, dict):
        raise RuntimeError("issues.json is not an object")
    rows = payload.get("issues")
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("issues.json has no issues")
    count = payload.get("count")
    if count is not None and count != len(rows):
        raise RuntimeError(f"issues.json says {count} issues and holds {len(rows)}")
    issues: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            raise RuntimeError("an issue is not an object")
        url = str(row.get("url") or "")
        if not url.startswith("https://"):
            raise RuntimeError(f"issue {row.get('number')!r} has no https url")
        links = row.get("links") or []
        if not isinstance(links, list):
            raise RuntimeError(f"issue {url} links are not a list")
        kept: list[dict[str, Any]] = []
        for link in links:
            if not isinstance(link, dict) or not isinstance(link.get("position"), int):
                raise RuntimeError(f"issue {url} has a link with no position")
            link_id = link.get("id")
            if link_id is not None and not LINK_ID_RE.match(str(link_id)):
                raise RuntimeError(f"issue {url} names link id {link_id!r}")
            kept.append({field: link.get(field) for field in ISSUE_LINK_FIELDS})
        kept.sort(key=lambda link: link["position"])
        issue = {key: value for key, value in row.items() if key != "links"}
        issue["links"] = kept
        issues.append(issue)
    issues.sort(key=_issue_key)
    return {
        "site": str(payload.get("site") or LINKS_SITE).rstrip("/"),
        "source": str(payload.get("source") or ""),
        "issues": issues,
    }


def dangling_ids(issues: dict[str, Any], link_ids: set[str]) -> list[str]:
    """Issue link ids that name no saved link in the snapshot."""
    return sorted(
        {
            str(link["id"])
            for issue in issues["issues"]
            for link in issue["links"]
            if link.get("id") and link["id"] not in link_ids
        }
    )


def fetch(source: str) -> Any:
    if source.startswith(("http://", "https://")):
        response = requests.get(source, timeout=60, headers={"Accept": "application/json"})
        response.raise_for_status()
        return response.json()
    return json.loads(Path(source).read_text(encoding="utf-8"))


def previous_count(path: Path) -> int:
    """How many links the snapshot at ``path`` holds (0 when none)."""
    try:
        return len(json.loads(path.read_text(encoding="utf-8")).get("links") or [])
    except FileNotFoundError, ValueError, AttributeError:
        return 0


def snapshot_text(snapshot: dict[str, Any]) -> str:
    """The snapshot as JSON with one row of its list (``links`` or
    ``issues``) per line: as compact as the feed, and a change is a line."""
    head = {key: value for key, value in snapshot.items() if not isinstance(value, list)}
    (name, rows), *rest = [(k, v) for k, v in snapshot.items() if isinstance(v, list)]
    if rest:
        raise ValueError("a snapshot holds one list")
    lines = [json.dumps(row, ensure_ascii=False) for row in rows]
    fields = "".join(
        f"{json.dumps(k)}: {json.dumps(v, ensure_ascii=False)},\n" for k, v in head.items()
    )
    return "{\n" + fields + f"{json.dumps(name)}: [\n" + ",\n".join(lines) + "\n]}\n"


def write_snapshot(snapshot: dict[str, Any], output: Path) -> bool:
    """Write ``snapshot`` to ``output``; False when the file already held it."""
    text = snapshot_text(snapshot)
    if output.exists() and output.read_text(encoding="utf-8") == text:
        return False
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text, encoding="utf-8")
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--links-source", default=LINKS_URL, help="links.json URL or local path")
    parser.add_argument(
        "--issues-source", default=LINK_ISSUES_URL, help="issues.json URL or local path"
    )
    parser.add_argument("--output-dir", default=str(LINKS_DIR), help="the tree's links/")
    parser.add_argument(
        "--allow-shrink",
        action="store_true",
        help="take a feed with over a tenth fewer links than the snapshot",
    )
    args = parser.parse_args(argv)
    output_dir = Path(args.output_dir)
    try:
        links = normalize_links(fetch(args.links_source))
        link_ids = {link["id"] for link in links["links"]}
        issues = normalize_issues(fetch(args.issues_source))
    except (RuntimeError, ValueError, requests.RequestException) as error:
        print(f"links import failed: {error}", file=sys.stderr)
        return 1
    before = previous_count(output_dir / "links.json")
    if before and len(links["links"]) < before * (1 - SHRINK_LIMIT) and not args.allow_shrink:
        print(
            f"links import refused: the feed has {len(links['links'])} links and the "
            f"snapshot {before}; pass --allow-shrink if Linking Things really lost them",
            file=sys.stderr,
        )
        return 1
    dangling = dangling_ids(issues, link_ids)
    changed = [
        name
        for name, snapshot in (("links.json", links), ("issues.json", issues))
        if write_snapshot(snapshot, output_dir / name)
    ]
    carried = sum(len(issue["links"]) for issue in issues["issues"])
    matched = sum(1 for issue in issues["issues"] for link in issue["links"] if link.get("id"))
    print(
        f"links: {len(links['links'])} saved links, {len(issues['issues'])} issues carrying "
        f"{carried} links ({matched} matched to a saved link) from {args.links_source}"
        + (f" (wrote {', '.join(changed)})" if changed else " (unchanged)")
    )
    if dangling:
        print(f"links: {len(dangling)} issue link ids name no saved link, e.g. {dangling[:3]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
