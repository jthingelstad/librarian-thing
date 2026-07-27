from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))

from apps.workshop_bot.webapp import issue_workflow


def test_suggested_publish_date_skips_summer_break():
    assert issue_workflow.suggested_publish_date(date(2026, 7, 26)) == "2026-09-05"
    assert issue_workflow.suggested_publish_date(date(2026, 8, 31)) == "2026-09-05"
    assert issue_workflow.suggested_publish_date(date(2026, 9, 6)) == "2026-09-12"


def test_planned_issue_next_action_is_start():
    action = issue_workflow.next_action(
        row={"id": "WT351", "phase": "planned"},
        state={},
        source_sync=None,
    )
    assert action == {
        "label": "Start working",
        "kind": "post",
        "url": "/productions/WT351/start",
    }


def test_build_issue_requires_sync_then_intro():
    row = {"id": "WT351", "phase": "build"}
    state = {"intro_present": False}
    assert (
        issue_workflow.next_action(row=row, state=state, source_sync=None)["label"]
        == "Sync sources"
    )
    assert (
        issue_workflow.next_action(
            row=row,
            state=state,
            source_sync={"status": "succeeded"},
        )["label"]
        == "Write the intro"
    )


def test_publish_issue_advances_in_dependency_order():
    row = {"id": "WT351", "phase": "publish"}
    state = {
        "email_shipped": True,
        "website_shipped": False,
        "audio_shipped": False,
        "audio_waived": False,
        "email_confirmed": False,
        "close_ready": False,
    }
    assert (
        issue_workflow.next_action(row=row, state=state, source_sync={})["label"]
        == "Publish website"
    )
