"""File the just-shipped newsletter issue into the archive data layer.

The closing bookend to starting an issue in Studio. Operates on the currently
active issue (the one row in ``issue_windows`` with ``is_active = 1``); takes no
arguments. After it runs, Studio has no active issue until the next issue is
started.

The handler, in one DB transaction:

1. Reads the active issue from ``issue_windows``. Refuses cleanly if none.
2. Validates ``data/issues/{N}/metadata.json`` exists locally with
   non-empty ``buttondown_id`` + ``absolute_url`` (i.e. the issue
   actually shipped through ``publish_buttondown`` + ``publish_website``).
3. UPSERTs the ``issues`` row from ``metadata.json`` + ``links.json`` +
   ``data/audio/manifest.json``.
4. Replaces all ``issue_links`` rows for that issue.
5. Closes the active window: ``is_active = 0``.

Re-running immediately refuses with "no active issue" (the window is
already closed). To re-file after a ``metadata.json`` correction without
disturbing the active-window state, run the historical backfill script —
it's idempotent and skips no shipped issue.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional

from ..tools import db
from ..tools.archive_lookup import derive_era
from ..tools.db.connection import connect
from . import _base

logger = logging.getLogger("workshop.jobs.put_to_bed")

NAME = "put-to-bed"

REPO = Path(__file__).resolve().parents[3]
ISSUES_ROOT = REPO / "data" / "issues"
AUDIO_MANIFEST = REPO / "data" / "audio" / "manifest.json"


def _read_metadata(n: int) -> Optional[dict[str, Any]]:
    path = ISSUES_ROOT / str(n) / "metadata.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("put-to-bed: bad metadata.json for #%d: %s", n, exc)
        return None


def _read_links(n: int) -> dict[str, Any]:
    path = ISSUES_ROOT / str(n) / "links.json"
    if not path.exists():
        return {"notable_links": [], "briefly_links": [], "domains": [], "word_count": 0}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("put-to-bed: bad links.json for #%d: %s", n, exc)
        return {"notable_links": [], "briefly_links": [], "domains": [], "word_count": 0}


def _read_audio_entry(n: int) -> dict[str, Any]:
    if not AUDIO_MANIFEST.exists():
        return {}
    try:
        manifest = json.loads(AUDIO_MANIFEST.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("put-to-bed: bad audio manifest: %s", exc)
        return {}
    return manifest.get(str(n)) or {}


def _normalize_publish_date(raw: str) -> str:
    return (raw or "")[:10]


def file_issue(
    *,
    meta: dict[str, Any],
    links: dict[str, Any],
    audio: dict[str, Any],
) -> None:
    """Atomic write: upsert the ``issues`` row + rebuild ``issue_links`` +
    flip the active window to inactive. Raises on failure (caller wraps
    the exception into a JobResult)."""
    number = int(meta["number"])
    notable = links.get("notable_links") or []
    briefly = links.get("briefly_links") or []
    domains = links.get("domains") or []
    word_count = int(links.get("word_count") or 0)

    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(
                "INSERT INTO issues "
                "  (number, subject, slug, description, publish_date, image, "
                "   absolute_url, buttondown_id, word_count, notable_count, "
                "   briefly_count, domain_count, link_count, audio_url, "
                "   audio_duration_s, audio_byte_size, audio_voice, era) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(number) DO UPDATE SET "
                "  subject=excluded.subject, "
                "  slug=excluded.slug, "
                "  description=excluded.description, "
                "  publish_date=excluded.publish_date, "
                "  image=excluded.image, "
                "  absolute_url=excluded.absolute_url, "
                "  buttondown_id=excluded.buttondown_id, "
                "  word_count=excluded.word_count, "
                "  notable_count=excluded.notable_count, "
                "  briefly_count=excluded.briefly_count, "
                "  domain_count=excluded.domain_count, "
                "  link_count=excluded.link_count, "
                "  audio_url=excluded.audio_url, "
                "  audio_duration_s=excluded.audio_duration_s, "
                "  audio_byte_size=excluded.audio_byte_size, "
                "  audio_voice=excluded.audio_voice, "
                "  era=excluded.era, "
                "  filed_at=datetime('now')",
                (
                    number,
                    meta.get("subject", "") or "",
                    meta.get("slug", "") or "",
                    meta.get("description", "") or "",
                    _normalize_publish_date(meta.get("publish_date", "")),
                    meta.get("image", "") or "",
                    meta.get("absolute_url", "") or "",
                    meta.get("buttondown_id", "") or "",
                    word_count,
                    len(notable),
                    len(briefly),
                    len(domains),
                    len(notable) + len(briefly),
                    audio.get("audio_url", "") or "",
                    audio.get("audio_duration_seconds"),
                    audio.get("audio_byte_size"),
                    audio.get("audio_voice", "") or "",
                    derive_era(number),
                ),
            )

            conn.execute("DELETE FROM issue_links WHERE issue_number = ?", (number,))
            for section_name, items in (("notable", notable), ("briefly", briefly)):
                for idx, link in enumerate(items):
                    conn.execute(
                        "INSERT INTO issue_links "
                        "  (issue_number, section, position, url, text, domain, heading_context) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (
                            number,
                            section_name,
                            idx,
                            link.get("url", "") or "",
                            link.get("text", "") or "",
                            (link.get("domain", "") or "").lower(),
                            link.get("heading_context", "") or "",
                        ),
                    )

            conn.execute(
                "UPDATE issue_windows SET is_active = 0, phase = 'share' WHERE issue_number = ?",
                (number,),
            )
            # Move the newsletter's registry row to its terminal Share state so
            # the slate/feed show it as shipped (mirrors set_issue_phase).
            conn.execute(
                "UPDATE productions SET phase = 'share', status = 'done', "
                "updated_at = datetime('now') WHERE id = 'WT'||?",
                (number,),
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise


async def run(ctx: "_base.JobContext", *, issue_number: int | None = None) -> "_base.JobResult":
    window = db.get_active_issue_window(issue_number)
    if window is None:
        msg = (
            "🛏️ nothing to put to bed — no active issue. Start the next issue in Studio when ready."
        )
        return _base.JobResult(False, msg)
    n = int(window["issue_number"])

    meta = _read_metadata(n)
    if meta is None:
        msg = (
            f"❌ can't put **WT{n}** to bed — `data/issues/{n}/metadata.json` not found locally. "
            "Publish Website from Studio first to commit the artifacts."
        )
        await ctx.post("DISCORD_CHANNEL_EDITORIAL", msg, persona="eddy")
        return _base.JobResult(False, msg, data={"issue_number": n})

    legs = db.get_publish_legs(n)
    audio_status = (legs.get("audio") or {}).get("status")
    website_status = (legs.get("website") or {}).get("status")
    delivery_status = (legs.get("email_delivery") or {}).get("status")
    missing_steps = []
    if website_status != "succeeded":
        missing_steps.append("Website publish")
    if delivery_status != "succeeded":
        missing_steps.append("Buttondown scheduled/sent confirmation")
    if audio_status not in ("succeeded", "waived"):
        missing_steps.append("Audio publish or explicit waiver")
    if missing_steps:
        msg = (
            f"❌ can't put **WT{n}** to bed — the publish runbook is incomplete: "
            + ", ".join(missing_steps)
            + "."
        )
        await ctx.post("DISCORD_CHANNEL_EDITORIAL", msg, persona="eddy")
        return _base.JobResult(
            False,
            msg,
            data={"issue_number": n, "missing_steps": missing_steps},
        )

    if not (meta.get("buttondown_id") and meta.get("absolute_url")):
        msg = (
            f"❌ can't put **WT{n}** to bed — `metadata.json` is missing `buttondown_id` "
            f"and/or `absolute_url`. Publish Email from Studio first."
        )
        await ctx.post("DISCORD_CHANNEL_EDITORIAL", msg, persona="eddy")
        return _base.JobResult(False, msg, data={"issue_number": n})

    links = _read_links(n)
    audio = _read_audio_entry(n)

    try:
        file_issue(meta=meta, links=links, audio=audio)
    except Exception as exc:  # noqa: BLE001
        logger.exception("put-to-bed: file_issue failed for WT%d", n)
        msg = f"⚠️ couldn't put **WT{n}** to bed: `{type(exc).__name__}: {exc}`"
        await ctx.post("DISCORD_CHANNEL_EDITORIAL", msg, persona="eddy")
        return _base.JobResult(False, msg, data={"issue_number": n})

    notable_n = len(links.get("notable_links") or [])
    briefly_n = len(links.get("briefly_links") or [])
    domain_n = len(links.get("domains") or [])
    audio_tag = "🎧 yes" if audio.get("audio_url") else "no"

    lines = [
        f"🛏️ **WT{n}** put to bed — `{meta.get('subject', '') or 'WT' + str(n)}`",
        f"- {notable_n + briefly_n} links ({notable_n} notable, {briefly_n} briefly)",
        f"- {domain_n} domains",
        f"- audio: {audio_tag}",
        f"- era: `{derive_era(n)}`",
        "",
        "Studio is between issues. Start the next issue when ready.",
    ]
    msg = "\n".join(lines)
    await ctx.post("DISCORD_CHANNEL_EDITORIAL", msg, persona="eddy")

    return _base.JobResult(
        True,
        f"WT{n} filed.",
        data={
            "issue_number": n,
            "notable_count": notable_n,
            "briefly_count": briefly_n,
            "domain_count": domain_n,
            "has_audio": bool(audio.get("audio_url")),
        },
    )
