"""Durable evidence for the latest issue source refresh."""

from __future__ import annotations

import json
from typing import Any, Optional

from .connection import connect


def record_source_sync(
    issue_number: int,
    *,
    ok: bool,
    message: str = "",
    evidence: Optional[dict[str, Any]] = None,
) -> None:
    status = "succeeded" if ok else "partial"
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO issue_source_syncs
              (issue_number, status, message, evidence_json, synced_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(issue_number) DO UPDATE SET
              status=excluded.status,
              message=excluded.message,
              evidence_json=excluded.evidence_json,
              synced_at=datetime('now')
            """,
            (int(issue_number), status, message, json.dumps(evidence or {}, sort_keys=True)),
        )


def get_source_sync(issue_number: int) -> Optional[dict[str, Any]]:
    with connect() as conn:
        raw = conn.execute(
            "SELECT * FROM issue_source_syncs WHERE issue_number = ?",
            (int(issue_number),),
        ).fetchone()
    if raw is None:
        return None
    row = dict(raw)
    try:
        row["evidence"] = json.loads(row.pop("evidence_json") or "{}")
    except (TypeError, ValueError):
        row["evidence"] = {}
    return row
