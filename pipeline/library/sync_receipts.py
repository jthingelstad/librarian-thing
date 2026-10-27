"""Public source identities received by a successful library upload.

Selection is pure. The optional transport reads only its environment; it
never loads .env, a secret, reader tables or unpublished documents.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import UTC, datetime
from urllib.parse import urlsplit


def instant(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return (
            parsed.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
            if parsed.tzinfo
            else None
        )
    except ValueError, TypeError:
        return None


def snapshot(conn):
    rows = [
        dict(row)
        for row in conn.execute(
            "SELECT id, kind, url, published FROM sources "
            "WHERE id LIKE 'blog-%' OR kind IN ('issue', 'episode', 'thing')"
        )
    ]
    link_file = conn.execute(
        "SELECT content FROM files WHERE path = 'links/links.json' AND origin = 'links'"
    ).fetchone()
    if link_file:
        for link in json.loads(link_file[0]).get("links", []):
            if re.fullmatch(r"[a-f0-9]{12}", str(link.get("id", ""))):
                rows.append(
                    {"id": "link-" + link["id"], "kind": "link", "published": link.get("saved")}
                )
    return rows


def arrivals(before, after, at, canonical_link=None):
    if before is None or after is None or not instant(at):
        return []
    known = {row["id"] for row in before}
    grouped = {}
    for row in after:
        raw = str(row.get("id", ""))
        if raw.startswith("blog-"):
            kind = "post"
        elif row.get("kind") in {"issue", "episode", "thing", "link"}:
            kind = row["kind"]
        else:
            continue
        if kind in {"issue", "episode"} and not raw.split("-", 1)[-1].isdigit():
            continue
        if kind in {"post", "link"} and not instant(row.get("published")):
            continue
        rank = (
            int(raw.split("-", 1)[1])
            if kind in {"issue", "episode"} and raw.split("-", 1)[-1].isdigit()
            else instant(row.get("published")) or str(row.get("published") or "")
        )
        if kind not in grouped or rank > grouped[kind][0]:
            grouped[kind] = (rank, row)
    events = []
    for kind, (_, row) in grouped.items():
        raw = row["id"]
        if raw in known:
            continue
        public_id, url = raw.split("-", 1)[-1], None
        if kind == "post":
            url = row.get("url")
            try:
                parts = urlsplit(url or "")
            except ValueError:
                continue
            if (
                parts.scheme != "https"
                or parts.netloc != "www.thingelstad.com"
                or parts.query
                or parts.fragment
            ):
                continue
            public_id = url
        elif kind == "link":
            stamp = instant(row.get("published"))
            source_item = canonical_link.get("item") if isinstance(canonical_link, dict) else None
            if (
                not isinstance(source_item, dict)
                or canonical_link.get("kind") != "link"
                or canonical_link.get("origin") != "pinboard"
                or source_item.get("id") != stamp
            ):
                continue
            public_id = stamp
        if not public_id or (kind != "post" and not re.fullmatch(r"[\w.:-]{1,128}", public_id)):
            continue
        detail = {
            "system": "librarian",
            "kind": kind,
            "id": public_id,
            "at": instant(at),
            "via": "library-round",
        }
        if url:
            detail["url"] = url
        events.append(
            {"Source": "librarian", "DetailType": "received", "Detail": json.dumps(detail)}
        )
    return events


def announce(before, after, bus, at, *, client=None, canonical_link=None):
    if not bus or before is None or after is None:
        return 0
    try:
        if canonical_link is None and any(row.get("kind") == "link" for row in after or []):
            import requests

            try:
                response = requests.get(
                    "https://sync.thingelstad.xyz/receipts/link.json", timeout=5
                )
                if response.ok:
                    canonical_link = response.json()
            except Exception:
                canonical_link = None
        events = arrivals(before, after, at, canonical_link)
        if events and client is None:
            import boto3

            client = boto3.client("events", region_name="us-east-1")
        for event in events:
            result = client.put_events(
                Entries=[
                    {
                        **event,
                        "EventBusName": bus,
                        "Time": datetime.fromisoformat(instant(at).replace("Z", "+00:00")),
                    }
                ]
            )
            entries = result.get("Entries", [])
            if (
                result.get("FailedEntryCount") != 0
                or len(entries) != 1
                or not entries[0].get("EventId")
                or entries[0].get("ErrorCode")
            ):
                raise RuntimeError("Not acknowledged")
        return len(events)
    except Exception:
        print(
            "::warning::The library arrival was not acknowledged; the upload remains successful.",
            file=sys.stderr,
        )
        return 0
