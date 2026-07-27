"""``sync-issue`` — refresh ``issue_items`` from upstream sources.

**The DB is the draft; this job is its inbound mirror.** Pulls Pinboard
(Notable / Briefly) and micro.blog (Journal + Featured promotions + journal
image rehost + alt fills) into ``issue_items`` rows via
``issue_items_sync.sync_all``. Nothing is rendered and nothing is written to
S3 or disk — reading the draft is the web preview's job
(``renderers.render_body_for_issue``), and artifacts are rendered at publish
time by the publish legs.

Replaces the sync half of the retired ``update-draft`` job (the other half —
draft.md projection, daily artifact renders, the S3 draft.html preview, the
embedded Opus review — was the S3-collaboration era and is gone: see
``eddy-review`` for the on-demand review).

Triggers: daily 17:00 CT cron and the web editor's Sync button.
"""

from __future__ import annotations

import asyncio
import logging

from ..tools import alt_text, db, issue_items, issue_items_sync
from . import _base

logger = logging.getLogger("workshop.jobs.sync_issue")

NAME = "sync-issue"


def _counts(n: int) -> str:
    notable = issue_items.list_items(n, section="notable", include_promoted=False)
    brief = issue_items.list_items(n, section="brief", include_promoted=False)
    journal = issue_items.list_items(n, section="journal", include_promoted=False)
    return f"{len(notable)} Notable / {len(brief)} Briefly / {len(journal)} Journal"


def _sync(n: int, window: dict) -> dict:
    # Cap the per-run vision fan-out (journal images + cover alt fills).
    alt_text.begin_run(purpose="eddy")
    return issue_items_sync.sync_all(n, window)


async def run(ctx: "_base.JobContext") -> "_base.JobResult":
    window = db.get_active_issue_window()
    if window is None:
        return _base.JobResult(
            False,
            "❌ no active issue window — start one in Studio first.",
        )
    n = int(window["issue_number"])

    with _base.job_lock([f"{n}/issue_items"], NAME):
        # sync_all wraps each source so a Pinboard outage doesn't kill the
        # micro.blog sync (or vice-versa); per-source errors surface in the
        # result summary instead of failing the run.
        sync_result = await asyncio.to_thread(_sync, n, window)

    # Visibility: one line in #chatter per alt that was generated and written
    # back to micro.blog during the upstream sync. Best-effort.
    for filled in sync_result.get("microblog", {}).get("alts_filled") or []:
        title = (filled.get("post_title") or "").strip() or "(untitled)"
        line = f'🔤 filled alt on [{title}]({filled["post_url"]}): "{filled["alt"]}"'
        try:
            await ctx.post("DISCORD_CHANNEL_CHATTER", line)
        except Exception:  # noqa: BLE001
            logger.exception("sync-issue: failed to post alt-fill log to #chatter")

    bits: list[str] = []
    ok = True
    for source in ("pinboard", "microblog"):
        res = sync_result.get(source, {})
        if "error" in res:
            ok = False
            bits.append(f"{source} error: {res['error']}")
        elif res.get("observed"):
            bits.append(f"{res['observed']} {source} items")
    summary = ", ".join(bits) or "no source updates"
    await asyncio.to_thread(
        db.record_source_sync,
        n,
        ok=ok,
        message=summary,
        evidence=sync_result,
    )

    mark = "✅" if ok else "⚠️"
    return _base.JobResult(
        ok,
        f"{mark} synced **WT{n}** — {summary} · {_counts(n)}",
        data={"issue_number": n, "sync": sync_result},
    )
