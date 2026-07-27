"""Presentation logic for the current issue and its single next action."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Optional


def suggested_publish_date(today: Optional[date] = None) -> str:
    """Next publishing Saturday, respecting the July/August summer break."""
    candidate = today or date.today()
    if candidate.month in (7, 8):
        candidate = date(candidate.year, 9, 1)
    days = (5 - candidate.weekday()) % 7
    return (candidate + timedelta(days=days)).isoformat()


def next_action(
    *,
    row: dict[str, Any],
    state: dict[str, Any],
    source_sync: Optional[dict[str, Any]],
) -> dict[str, str]:
    pid = row["id"]
    phase = row["phase"]
    if phase == "planned":
        return {"label": "Start working", "kind": "post", "url": f"/productions/{pid}/start"}
    if phase in ("write", "build"):
        if source_sync is None or source_sync.get("status") != "succeeded":
            return {"label": "Sync sources", "kind": "post", "url": f"/productions/{pid}/sync"}
        if not state.get("intro_present"):
            return {"label": "Write the intro", "kind": "link", "url": "#atom-content-intro.md"}
        if not state.get("cover_present"):
            return {"label": "Add the cover", "kind": "link", "url": "#cover"}
        if not all(
            state.get("sections", {}).get(key, {}).get("present")
            for key in ("notable", "brief", "journal")
        ):
            return {"label": "Curate issue sections", "kind": "link", "url": "#issue-canvas"}
        if state.get("open_comments", 0):
            return {"label": "Resolve Eddy’s notes", "kind": "link", "url": "#eddy-notes"}
        if state.get("build_ready"):
            return {
                "label": "Mark built",
                "kind": "post",
                "url": f"/productions/{pid}/phase",
                "field": "phase",
                "value": "publish",
            }
        return {"label": "Continue the draft", "kind": "link", "url": "#issue-canvas"}
    if phase == "publish":
        if not state.get("email_shipped"):
            return {"label": "Create Buttondown draft", "kind": "publish", "value": "email"}
        if not state.get("website_shipped"):
            return {"label": "Publish website", "kind": "publish", "value": "website"}
        if not state.get("audio_shipped") and not state.get("audio_waived"):
            return {"label": "Publish or waive audio", "kind": "link", "url": "#pipeline"}
        if not state.get("email_confirmed"):
            return {"label": "Confirm email scheduled/sent", "kind": "link", "url": "#pipeline"}
        if state.get("close_ready"):
            return {"label": "Put issue to bed", "kind": "publish", "value": "bed"}
    return {"label": "Review the issue", "kind": "link", "url": "#issue-canvas"}
