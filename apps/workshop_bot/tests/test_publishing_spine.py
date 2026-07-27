"""Tests for the publishing spine — phase state + the headless transitions.

The Discord phase cards (Build / Publish / Share) were retired; production
status is the web scoreboard now. The status that used to live on the cards is
in `jobs/production_state.py` (`build_state` / `publish_state` + the gate keys),
and the transitions are in `jobs/production_ops.py` (`mark_built` / `reopen` /
`recompose`). See docs/publishing-process.md for the model.
"""

from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))

from apps.workshop_bot.tests import _stubs  # noqa: E402

_stubs.install()

from apps.workshop_bot.jobs import (  # noqa: E402
    _base,
    compose_echoes,
    compose_envelope,
    production_ops,
    production_state,
    publish,
    put_to_bed,
)
from apps.workshop_bot.tests._fixtures import DBTestCase as _DBTestCase  # noqa: E402
from apps.workshop_bot.tools import content_store, db, renderers  # noqa: E402

_OK = _base.JobResult(True, "ok")


def _window(n=458, pub="2026-05-23"):
    from apps.workshop_bot.tools.content import issue as issue_mod

    w = issue_mod.compute_window(pub, 7)
    db.set_issue_window(
        issue_number=n,
        pub_date=w["pub_date"],
        end_date=w["end_date"],
        start_date=w["start_date"],
        day_count=w["day_count"],
        set_by="test",
    )


def _patch_composes():
    """Patch the compose jobs (lazily imported inside production_ops) so
    mark_built's auto-fires don't hit Anthropic."""
    return (
        patch.object(compose_envelope, "run", new=AsyncMock(return_value=_OK)),
        patch.object(compose_echoes, "run", new=AsyncMock(return_value=_OK)),
    )


class PhaseModelTests(_DBTestCase):
    def test_start_seeds_build_phase(self):
        _window(458)
        self.assertEqual(db.get_active_issue_window()["phase"], "build")

    def test_set_phase(self):
        _window(458)
        db.set_issue_phase(458, "publish")
        self.assertEqual(db.get_active_issue_window()["phase"], "publish")


class BuildStateTests(_DBTestCase):
    def _seed_full_content(self, n=458):
        # The DB is the draft: sections are issue_items rows, authored atoms
        # live in the content store; cover.jpg stays an S3 binary.
        from apps.workshop_bot.tools import issue_items

        for section, source, sid in (
            ("notable", "pinboard", "n1"),
            ("brief", "pinboard", "b1"),
            ("journal", "microblog", "j1"),
        ):
            issue_items.upsert_item(
                issue_number=n, section=section, source=source, source_id=sid, body_md="x"
            )
        content_store.write_issue(n, "intro.md", "Opening.")
        content_store.write_issue(n, "haiku.md", "a\nb\nc")
        self.ws.write_issue_file(n, "cover.jpg", "binary")  # genuine S3 binary

    def test_build_ready_when_content_present(self):
        _window(458)
        self._seed_full_content()
        st = production_state.build_state(458)
        self.assertTrue(st["build_ready"])
        self.assertTrue(st["intro_present"])
        self.assertTrue(st["cover_present"])

    def test_build_not_ready_without_content(self):
        _window(459, pub="2026-05-30")
        st = production_state.build_state(459)
        self.assertFalse(st["build_ready"])

    def test_mark_built_refuses_when_not_ready(self):
        _window(459, pub="2026-05-30")
        res = asyncio.run(production_ops.mark_built(_base.JobContext()))
        self.assertFalse(res.ok)
        self.assertIn("isn't built", res.message.lower())
        self.assertEqual(db.get_active_issue_window()["phase"], "build")

    def test_mark_built_flips_to_publish_and_fires_composes(self):
        _window(458)
        self._seed_full_content()
        pt, pe = _patch_composes()
        with pt as m_envelope, pe as m_echoes:
            res = asyncio.run(production_ops.mark_built(_base.JobContext()))
        self.assertTrue(res.ok, res.message)
        self.assertEqual(res.data["phase"], "publish")
        self.assertEqual(db.get_active_issue_window()["phase"], "publish")
        m_envelope.assert_awaited_once()
        m_echoes.assert_awaited_once()

    def test_mark_built_recovers_when_a_compose_raises(self):
        # If a compose auto-fire blows up, the phase still flips to Publish and
        # the ack is success — the logged exception is the recovery signal.
        _window(458)
        self._seed_full_content()
        with (
            patch.object(compose_envelope, "run", new=AsyncMock(return_value=_OK)),
            patch.object(
                compose_echoes, "run", new=AsyncMock(side_effect=RuntimeError("LLM hiccup"))
            ),
        ):
            res = asyncio.run(production_ops.mark_built(_base.JobContext()))
        self.assertTrue(res.ok, res.message)
        self.assertEqual(db.get_active_issue_window()["phase"], "publish")

    def test_reopen_flips_publish_back_to_build(self):
        _window(458)
        db.set_issue_phase(458, "publish")
        res = asyncio.run(production_ops.reopen(_base.JobContext()))
        self.assertTrue(res.ok, res.message)
        self.assertEqual(db.get_active_issue_window()["phase"], "build")

    def test_reopen_no_op_when_no_active_window(self):
        res = asyncio.run(production_ops.reopen(_base.JobContext()))
        self.assertFalse(res.ok)


class PublishStateTests(_DBTestCase):
    def _seed_built(self, n=458, *, subject="", description="", buttondown_id=""):
        content_store.write_issue(n, "intro.md", "x")
        content_store.write_issue(n, "haiku.md", "a\nb\nc")
        self.ws.write_issue_file(n, "cover.jpg", "bin")  # genuine S3 binary
        meta = {"number": n, "slug": str(n)}
        if subject:
            meta["subject"] = subject
        if description:
            meta["description"] = description
        content_store.write_issue(n, "metadata.json", json.dumps(meta))
        if buttondown_id:
            # Publish-stamped fields live on the issue window now.
            db.set_issue_publish_record(
                n,
                buttondown_id=buttondown_id,
                absolute_url="https://weekly.thingelstad.com/archive/%d/" % n,
            )

    def test_email_gate_needs_subject_and_description(self):
        _window(458)
        db.set_issue_phase(458, "publish")
        self._seed_built(subject="WT458 — Test")  # no description
        st = production_state.publish_state(458)
        self.assertFalse(st["gates"][production_state.BTN_EMAIL])
        self.assertIn("description", st["email_missing"])
        # With both, email is ready.
        self._seed_built(subject="WT458 — Test", description="a, b, c")
        st = production_state.publish_state(458)
        self.assertTrue(st["gates"][production_state.BTN_EMAIL])

    def test_website_gate_opens_after_buttondown(self):
        _window(458)
        db.set_issue_phase(458, "publish")
        self._seed_built(subject="S", description="d", buttondown_id="em_x")
        st = production_state.publish_state(458)
        self.assertTrue(st["email_shipped"])
        self.assertTrue(st["gates"][production_state.BTN_WEBSITE])

    def test_completed_legs_leave_only_failed_leg_retryable(self):
        _window(458)
        db.set_issue_phase(458, "publish")
        self._seed_built(subject="S", description="d", buttondown_id="em_x")
        content_store.write_issue(458, "echoes.md", "Echoes.")
        db.publish_leg_set(458, "audio", "succeeded")
        db.publish_leg_set(458, "email", "succeeded")
        db.publish_leg_set(458, "website", "failed", message="planned failure")
        st = production_state.publish_state(458)
        self.assertFalse(st["gates"][production_state.BTN_PODCAST])
        self.assertFalse(st["gates"][production_state.BTN_EMAIL])
        self.assertTrue(st["gates"][production_state.BTN_WEBSITE])
        self.assertFalse(st["gates"][production_state.BTN_ALL])

    def test_close_ready_requires_delivery_website_and_audio_or_waiver(self):
        _window(458)
        db.set_issue_phase(458, "publish")
        self._seed_built(subject="S", description="d", buttondown_id="em_x")
        db.publish_leg_set(458, "website", "succeeded")
        db.publish_leg_set(458, "email_delivery", "succeeded")
        self.assertFalse(production_state.publish_state(458)["close_ready"])
        db.publish_leg_set(458, "audio", "waived")
        self.assertTrue(production_state.publish_state(458)["close_ready"])

    def test_recompose_gate_off_when_echoes_present(self):
        _window(458)
        db.set_issue_phase(458, "publish")
        self._seed_built(subject="S", description="d")
        content_store.write_issue(458, "echoes.md", "Echoes prose.")
        st = production_state.publish_state(458)
        self.assertFalse(st["echoes_failed"])
        self.assertFalse(st["recompose_needed"])
        self.assertFalse(st["gates"][production_state.BTN_RECOMPOSE])
        # Thesis is retired — no thesis key in the state.
        self.assertNotIn("thesis", st)
        self.assertNotIn("thesis_failed", st)

    def test_recompose_gate_on_when_echoes_failed_in_publish(self):
        _window(458)
        db.set_issue_phase(458, "publish")
        self._seed_built(subject="S", description="d")  # echoes missing
        st = production_state.publish_state(458)
        self.assertTrue(st["echoes_failed"])
        self.assertTrue(st["recompose_needed"])
        self.assertTrue(st["gates"][production_state.BTN_RECOMPOSE])

    def test_recompose_gate_off_in_build_phase(self):
        # In build phase the composes haven't auto-fired yet, so their absence
        # isn't a failure — recompose stays off.
        _window(458)
        self._seed_built(subject="", description="")
        st = production_state.publish_state(458)
        self.assertFalse(st["recompose_needed"])
        self.assertFalse(st["gates"][production_state.BTN_RECOMPOSE])

    def test_recompose_refires_missing_echoes(self):
        _window(458)
        db.set_issue_phase(458, "publish")
        self._seed_built(subject="S", description="d")  # echoes missing
        with patch.object(compose_echoes, "run", new=AsyncMock(return_value=_OK)) as m_echoes:
            res = asyncio.run(production_ops.recompose(_base.JobContext()))
        self.assertTrue(res.ok, res.message)
        m_echoes.assert_awaited_once()


class PublishLegTrackingTests(_DBTestCase):
    def test_tracked_leg_persists_success_evidence(self):
        _window(458)
        operation = AsyncMock(
            return_value=_base.JobResult(
                True,
                "website shipped",
                data={"commit_sha": "abc123"},
            )
        )
        result = asyncio.run(
            publish._run_tracked(_base.JobContext(), "website", operation, issue_number=458)
        )
        self.assertTrue(result.ok)
        leg = db.get_publish_legs(458)["website"]
        self.assertEqual(leg["status"], "succeeded")
        self.assertEqual(leg["evidence"]["commit_sha"], "abc123")
        self.assertEqual(leg["attempt_count"], 1)

    def test_tracked_leg_persists_failure_for_recovery(self):
        _window(458)
        operation = AsyncMock(return_value=_base.JobResult(False, "planned website failure"))
        result = asyncio.run(
            publish._run_tracked(_base.JobContext(), "website", operation, issue_number=458)
        )
        self.assertFalse(result.ok)
        leg = db.get_publish_legs(458)["website"]
        self.assertEqual(leg["status"], "failed")
        self.assertIn("planned website failure", leg["message"])


class PutToBedTests(_DBTestCase):
    """`put-to-bed` files the shipped issue and closes the active window."""

    def _seed_filing_artifacts(self, n=458):
        issues_dir = Path(self._tmpdir.name) / "data" / "issues" / str(n)
        issues_dir.mkdir(parents=True, exist_ok=True)
        (issues_dir / "metadata.json").write_text(
            json.dumps(
                {
                    "number": n,
                    "subject": f"WT{n} — Test ship",
                    "publish_date": "2026-05-23T12:00:00Z",
                    "slug": str(n),
                    "buttondown_id": "em_test",
                    "absolute_url": f"https://buttondown.com/weekly-thing/archive/{n}/",
                }
            ),
            encoding="utf-8",
        )
        (issues_dir / "links.json").write_text(
            json.dumps(
                {
                    "notable_links": [],
                    "briefly_links": [],
                    "domains": [],
                    "word_count": 0,
                }
            ),
            encoding="utf-8",
        )
        audio_path = Path(self._tmpdir.name) / "data" / "audio" / "manifest.json"
        audio_path.parent.mkdir(parents=True, exist_ok=True)
        audio_path.write_text(json.dumps({str(n): {}}), encoding="utf-8")
        return issues_dir.parent, audio_path

    def test_put_to_bed_files_issue(self):
        n = 458
        _window(n)
        db.set_issue_phase(n, "publish")
        issues_root, audio_manifest = self._seed_filing_artifacts(n)
        db.publish_leg_set(n, "website", "succeeded")
        db.publish_leg_set(n, "email_delivery", "succeeded")
        db.publish_leg_set(n, "audio", "waived")
        ctx = _base.JobContext()
        with (
            patch.object(put_to_bed, "ISSUES_ROOT", issues_root),
            patch.object(put_to_bed, "AUDIO_MANIFEST", audio_manifest),
            patch.object(ctx, "post", new=AsyncMock(return_value=True)),
        ):
            res = asyncio.run(put_to_bed.run(ctx))
        self.assertTrue(res.ok, res.message)
        # Window is closed; issue filed.
        self.assertIsNone(db.get_active_issue_window())
        latest = db.get_latest_issue()
        self.assertIsNotNone(latest)
        self.assertEqual(int(latest["number"]), n)

    def test_missing_metadata_refuses_without_closing_window(self):
        n = 458
        _window(n)
        db.set_issue_phase(n, "publish")
        issues_root = Path(self._tmpdir.name) / "data" / "issues"
        audio_manifest = Path(self._tmpdir.name) / "data" / "audio" / "manifest.json"
        ctx = _base.JobContext()
        with (
            patch.object(put_to_bed, "ISSUES_ROOT", issues_root),
            patch.object(put_to_bed, "AUDIO_MANIFEST", audio_manifest),
            patch.object(ctx, "post", new=AsyncMock(return_value=True)),
        ):
            res = asyncio.run(put_to_bed.run(ctx))
        self.assertFalse(res.ok)
        self.assertIsNotNone(db.get_active_issue_window())


class EchoesRenameTests(unittest.TestCase):
    def test_renderer_emits_echoes_heading(self):
        body = renderers.render_archive_body(
            atoms={"intro": "Hi.", "haiku": "a\nb\nc"},
            sections={"notable": "### [A](http://a)\n\nx"},
            features=[],
            echoes="The archive connects this to [WT287](https://weekly.thingelstad.com/archive/287/).",
        )
        self.assertIn("## Echoes", body)
        self.assertNotIn("## The Closer", body)


if __name__ == "__main__":
    unittest.main()
