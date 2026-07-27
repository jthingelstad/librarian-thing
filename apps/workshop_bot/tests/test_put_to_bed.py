"""Integration tests for ``/eddy issue put-to-bed``.

Each test seeds an active ``issue_windows`` row, writes a fake
``data/issues/{N}/`` tree under a temp path, points the put_to_bed module
at it, runs the handler, and asserts the resulting DB state.
"""

from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))

from apps.workshop_bot.tests import _stubs  # noqa: E402

_stubs.install()

from apps.workshop_bot.jobs import _base, put_to_bed  # noqa: E402
from apps.workshop_bot.tests._fixtures import DBTestCase  # noqa: E402
from apps.workshop_bot.tools import db  # noqa: E402
from apps.workshop_bot.tools.db.connection import connect  # noqa: E402


def _write_issue_files(root: Path, n: int, *, shipped: bool = True) -> None:
    issue_dir = root / "data" / "issues" / str(n)
    issue_dir.mkdir(parents=True, exist_ok=True)
    meta = {
        "number": n,
        "subject": f"WT {n} / Test issue",
        "slug": f"wt-{n}",
        "description": "Test description",
        "image": "https://files.test/cover.jpg",
        "publish_date": "2026-05-16T12:00:00Z",
        "buttondown_id": f"em_test_{n}" if shipped else "",
        "absolute_url": f"https://buttondown.test/wt-{n}/" if shipped else "",
    }
    (issue_dir / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")

    links = {
        "notable_links": [
            {
                "text": "A",
                "url": "https://daringfireball.net/x",
                "domain": "daringfireball.net",
                "heading_context": "[A](https://daringfireball.net/x)",
                "section": "Notable",
            },
            {
                "text": "B",
                "url": "https://example.com/y",
                "domain": "example.com",
                "heading_context": "[B](https://example.com/y)",
                "section": "Notable",
            },
        ],
        "briefly_links": [
            {
                "text": "C",
                "url": "https://other.test/z",
                "domain": "other.test",
                "heading_context": "**[C](https://other.test/z)**",
                "section": "Briefly",
            },
        ],
        "domains": ["daringfireball.net", "example.com", "other.test"],
        "word_count": 2042,
    }
    (issue_dir / "links.json").write_text(json.dumps(links), encoding="utf-8")


def _write_audio_manifest(root: Path, n: int) -> None:
    audio_dir = root / "data" / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        str(n): {
            "audio_url": f"https://files.thingelstad.com/weekly-thing/{n}/weekly-thing-{n}.mp3",
            "audio_duration_seconds": 1500,
            "audio_byte_size": 30_000_000,
            "audio_voice": "openai-tts-1-hd:echo",
        }
    }
    (audio_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def _set_active_window(n: int, pub_date: str = "2026-05-16") -> None:
    db.set_issue_window(
        issue_number=n,
        pub_date=pub_date,
        end_date="2026-05-15",
        start_date="2026-05-08",
        day_count=7,
        set_by="test",
    )


def _complete_runbook(n: int, *, audio: str = "succeeded") -> None:
    db.publish_leg_set(n, "website", "succeeded", message="test website")
    db.publish_leg_set(n, "email_delivery", "succeeded", message="test delivery")
    db.publish_leg_set(n, "audio", audio, message="test audio")


class PutToBedTests(DBTestCase):
    def setUp(self) -> None:
        super().setUp()
        # Re-point put_to_bed module's REPO + paths at a temp tree so
        # the test doesn't depend on the real ``data/issues/`` files.
        self._fake_repo = Path(self._tmpdir.name) / "fake_repo"
        self._fake_repo.mkdir(parents=True, exist_ok=True)
        self._repo_patcher = patch.object(put_to_bed, "REPO", self._fake_repo)
        self._issues_patcher = patch.object(
            put_to_bed,
            "ISSUES_ROOT",
            self._fake_repo / "data" / "issues",
        )
        self._audio_patcher = patch.object(
            put_to_bed,
            "AUDIO_MANIFEST",
            self._fake_repo / "data" / "audio" / "manifest.json",
        )
        self._repo_patcher.start()
        self._issues_patcher.start()
        self._audio_patcher.start()

    def tearDown(self) -> None:
        self._audio_patcher.stop()
        self._issues_patcher.stop()
        self._repo_patcher.stop()
        super().tearDown()

    def _run(self) -> _base.JobResult:
        ctx = _base.JobContext(trigger="manual")
        return asyncio.run(put_to_bed.run(ctx))

    def test_files_issue_closes_window_and_writes_links(self) -> None:
        _write_issue_files(self._fake_repo, 348)
        _write_audio_manifest(self._fake_repo, 348)
        _set_active_window(348)
        _complete_runbook(348)
        self.assertEqual(db.get_active_issue_window()["issue_number"], 348)

        result = self._run()
        self.assertTrue(result.ok, result.message)
        self.assertEqual(result.data["issue_number"], 348)
        self.assertEqual(result.data["notable_count"], 2)
        self.assertEqual(result.data["briefly_count"], 1)
        self.assertEqual(result.data["domain_count"], 3)
        self.assertTrue(result.data["has_audio"])

        # Active window is closed.
        self.assertIsNone(db.get_active_issue_window())

        # issues row is filed with the right field values.
        with connect() as conn:
            row = conn.execute(
                "SELECT subject, publish_date, word_count, notable_count, "
                "       briefly_count, domain_count, link_count, audio_url, "
                "       audio_duration_s, audio_voice, era "
                "FROM issues WHERE number = ?",
                (348,),
            ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["subject"], "WT 348 / Test issue")
        self.assertEqual(row["publish_date"], "2026-05-16")
        self.assertEqual(row["word_count"], 2042)
        self.assertEqual(row["notable_count"], 2)
        self.assertEqual(row["briefly_count"], 1)
        self.assertEqual(row["domain_count"], 3)
        self.assertEqual(row["link_count"], 3)
        self.assertEqual(row["audio_duration_s"], 1500)
        self.assertEqual(row["audio_voice"], "openai-tts-1-hd:echo")
        self.assertEqual(row["era"], "buttondown")

        # issue_links rows landed.
        with connect() as conn:
            link_rows = conn.execute(
                "SELECT section, position, url, domain FROM issue_links "
                "WHERE issue_number = ? ORDER BY section, position",
                (348,),
            ).fetchall()
        self.assertEqual(len(link_rows), 3)
        sections = sorted([r["section"] for r in link_rows])
        self.assertEqual(sections, ["briefly", "notable", "notable"])

    def test_idempotent_rerun_replaces_link_rows(self) -> None:
        _write_issue_files(self._fake_repo, 348)
        _set_active_window(348)
        _complete_runbook(348, audio="waived")
        result1 = self._run()
        self.assertTrue(result1.ok)

        # Re-open the window manually to force a second put-to-bed.
        # (In normal flow you'd re-publish-then-put-to-bed; for the test
        # we just flip is_active back on.)
        with connect() as conn:
            conn.execute(
                "UPDATE issue_windows SET is_active = 1 WHERE issue_number = ?",
                (348,),
            )
        result2 = self._run()
        self.assertTrue(result2.ok)

        with connect() as conn:
            n_links = conn.execute(
                "SELECT COUNT(*) AS n FROM issue_links WHERE issue_number = ?",
                (348,),
            ).fetchone()["n"]
            n_issues = conn.execute(
                "SELECT COUNT(*) AS n FROM issues WHERE number = ?",
                (348,),
            ).fetchone()["n"]
        # Still 3 links + 1 issue row — re-run didn't duplicate.
        self.assertEqual(n_issues, 1)
        self.assertEqual(n_links, 3)

    def test_refuses_when_no_active_issue(self) -> None:
        # No window set — refuse cleanly without crashing.
        result = self._run()
        self.assertFalse(result.ok)
        self.assertIn("no active issue", result.message.lower())

    def test_refuses_when_metadata_missing(self) -> None:
        _set_active_window(999)
        result = self._run()
        self.assertFalse(result.ok)
        self.assertIn("metadata.json", result.message)

    def test_refuses_when_unpublished(self) -> None:
        # Metadata exists but buttondown_id / absolute_url are empty.
        _write_issue_files(self._fake_repo, 348, shipped=False)
        _set_active_window(348)
        result = self._run()
        self.assertFalse(result.ok)
        self.assertIn("publish", result.message.lower())
        # Active window is NOT closed on refusal.
        self.assertIsNotNone(db.get_active_issue_window())

    def test_rerun_after_close_returns_no_active_issue(self) -> None:
        _write_issue_files(self._fake_repo, 348)
        _set_active_window(348)
        _complete_runbook(348, audio="waived")
        first = self._run()
        self.assertTrue(first.ok)
        second = self._run()
        self.assertFalse(second.ok)
        self.assertIn("no active issue", second.message.lower())


if __name__ == "__main__":
    unittest.main()
