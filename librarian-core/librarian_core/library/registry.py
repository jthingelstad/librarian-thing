"""Public Things snapshot revision v1; no corpus or private-library fingerprint.

The wire contract and cross-language vectors live in pipeline/library/README.md
and tests/fixtures/registry-revisions.json. Only the imported public registry
row participates; the rest of the library never enters this digest.
"""

from __future__ import annotations

import hashlib
import json

ALGORITHM = "things-snapshot-v1"
PUBLIC_PATH = "things/things.json"


def _utf8(text: str) -> bytes:
    return text.encode("utf-8", errors="strict")


def normalized(payload: dict) -> dict:
    """Match the importer's four-key snapshot, refusing unsupported shapes."""
    if not isinstance(payload, dict) or not isinstance(payload.get("site"), str):
        raise ValueError("unsupported public registry")
    if any(k not in payload for k in ("things", "topics", "history")):
        raise ValueError("unsupported public registry")
    things, topics, history = (payload[k] for k in ("things", "topics", "history"))
    if not isinstance(things, list) or not things:
        raise ValueError("unsupported public registry")
    if any(v is not None and not isinstance(v, list) for v in (topics, history)):
        raise ValueError("unsupported public registry")
    topics, history = topics or [], history or []
    for rows, keys in ((things, ("id",)), (topics, ("id",)), (history, ("date", "id"))):
        for row in rows:
            if not isinstance(row, dict) or any(not isinstance(row.get(k), str) for k in keys):
                raise ValueError("unsupported public registry")
    if len({t["id"] for t in things}) != len(things):
        raise ValueError("duplicate public thing")
    return {
        "site": payload["site"],
        "things": sorted(things, key=lambda t: _utf8(t["id"])),
        "topics": sorted(topics, key=lambda t: _utf8(t["id"])),
        "history": sorted(history, key=lambda t: (_utf8(t["date"]), _utf8(t["id"]))),
    }


def _wire(value) -> bytes:
    if value is None:
        return b"n"
    if isinstance(value, bool):
        return b"t" if value else b"f"
    if isinstance(value, (int, float)):
        if abs(value) > 9007199254740991 or int(value) != value:
            raise ValueError("unsupported registry number")
        return b"i" + str(int(value)).encode("ascii") + b";"
    if isinstance(value, str):
        raw = _utf8(value)
        return b"s" + str(len(raw)).encode("ascii") + b":" + raw
    if isinstance(value, list):
        return b"[" + b"".join(_wire(v) for v in value) + b"]"
    if isinstance(value, dict):
        return b"{" + b"".join(_wire(k) + _wire(value[k]) for k in sorted(value, key=_utf8)) + b"}"
    raise ValueError("unsupported registry value")


def revision(payload: dict) -> str:
    return hashlib.sha256(
        ALGORITHM.encode("ascii") + b"\n" + _wire(normalized(payload))
    ).hexdigest()


def snapshot_metadata(conn) -> dict[str, str]:
    row = conn.execute(
        "SELECT content FROM files WHERE path = ? AND origin = ?", (PUBLIC_PATH, "xyz")
    ).fetchone()
    if not row:
        return {}
    payload = json.loads(row[0])
    return {"things-revision-algorithm": ALGORITHM, "things-revision": revision(payload)}
