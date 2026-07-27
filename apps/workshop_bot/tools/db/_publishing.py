"""Durable state for the newsletter publish runbook."""

from __future__ import annotations

import json
from typing import Any, Optional

from .connection import connect

LEGS = ("audio", "email", "website", "email_delivery")
STATUSES = ("running", "succeeded", "failed", "waived")


def publish_leg_start(issue_number: int, leg: str) -> None:
    if leg not in LEGS:
        raise ValueError(f"unknown publish leg: {leg}")
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO issue_publish_legs
              (issue_number, leg, status, attempt_count, started_at, updated_at)
            VALUES (?, ?, 'running', 1, datetime('now'), datetime('now'))
            ON CONFLICT(issue_number, leg) DO UPDATE SET
              status='running',
              message='',
              evidence_json='{}',
              attempt_count=issue_publish_legs.attempt_count + 1,
              started_at=datetime('now'),
              completed_at=NULL,
              updated_at=datetime('now')
            """,
            (int(issue_number), leg),
        )


def publish_leg_finish(
    issue_number: int,
    leg: str,
    *,
    ok: bool,
    message: str = "",
    evidence: Optional[dict[str, Any]] = None,
) -> None:
    status = "succeeded" if ok else "failed"
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO issue_publish_legs
              (issue_number, leg, status, message, evidence_json,
               attempt_count, started_at, completed_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'), datetime('now'))
            ON CONFLICT(issue_number, leg) DO UPDATE SET
              status=excluded.status,
              message=excluded.message,
              evidence_json=excluded.evidence_json,
              completed_at=datetime('now'),
              updated_at=datetime('now')
            """,
            (
                int(issue_number),
                leg,
                status,
                message or "",
                json.dumps(evidence or {}, sort_keys=True),
            ),
        )


def publish_leg_set(
    issue_number: int,
    leg: str,
    status: str,
    *,
    message: str = "",
    evidence: Optional[dict[str, Any]] = None,
) -> None:
    if leg not in LEGS:
        raise ValueError(f"unknown publish leg: {leg}")
    if status not in STATUSES:
        raise ValueError(f"unknown publish status: {status}")
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO issue_publish_legs
              (issue_number, leg, status, message, evidence_json,
               attempt_count, completed_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
            ON CONFLICT(issue_number, leg) DO UPDATE SET
              status=excluded.status,
              message=excluded.message,
              evidence_json=excluded.evidence_json,
              completed_at=datetime('now'),
              updated_at=datetime('now')
            """,
            (
                int(issue_number),
                leg,
                status,
                message or "",
                json.dumps(evidence or {}, sort_keys=True),
            ),
        )


def get_publish_legs(issue_number: int) -> dict[str, dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM issue_publish_legs WHERE issue_number = ? ORDER BY leg",
            (int(issue_number),),
        ).fetchall()
    result: dict[str, dict[str, Any]] = {}
    for raw in rows:
        row = dict(raw)
        try:
            row["evidence"] = json.loads(row.pop("evidence_json") or "{}")
        except TypeError, ValueError:
            row["evidence"] = {}
        result[row["leg"]] = row
    return result
