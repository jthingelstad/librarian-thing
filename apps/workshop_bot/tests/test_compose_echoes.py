"""Tests for compose-echoes — Echoes archive note generator.

compose-echoes auto-fires inside ``mark-built`` (the Build → Publish
phase transition). It reads the frozen issue body, the last 6 issues'
echoes bodies (for anti-repetition), and the top archive passages from
Librarian's `/retrieve` endpoint (Bedrock embed + Cohere rerank), then
asks Opus for a 2-4 sentence paragraph. The output lands in
data/issues/{N}/echoes.md on both S3 (under atoms/) and local; the
daily renderers splice the ``## Echoes`` section into archive/email/
transcript from there — there is no final.md assembly.

Tests cover: refusal paths (no window, no body, no Eddy), happy path
(echoes.md written to local + S3), prior-echoes lookup (reads up to 6,
skips missing), Librarian retrieval failure (fail-loud), and the
bare-reference linkifier.
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))

from apps.workshop_bot.tests import _stubs  # noqa: E402

_stubs.install()

from apps.workshop_bot.jobs import _base, compose_echoes  # noqa: E402
from apps.workshop_bot.tests._fixtures import (  # noqa: E402
    DBTestCase as _DBTestCase,
)
from apps.workshop_bot.tests._fixtures import (
    FakeBotChannel as _FakeBotChannel,
)
from apps.workshop_bot.tools import content_store, db, thingy_retrieve  # noqa: E402

_FAKE_PASSAGES = [
    {
        "issue_number": 281,
        "subject": "Weekly Thing 281 / Bar",
        "publish_date": "2024-06-08",
        "section": "Notable",
        "text": "A passage about local food systems in Minneapolis, with a long pull on the farmers market scene downtown.",
        "score": 0.91,
    },
    {
        "issue_number": 280,
        "subject": "Weekly Thing 280 / Foo",
        "publish_date": "2024-06-01",
        "section": "Journal",
        "text": "An evening walk along the river, noting how the light changed as the city's skyline filled in.",
        "score": 0.74,
    },
]


class CleanEchoesTests(unittest.TestCase):
    def test_strips_outer_code_fence(self):
        out = compose_echoes._clean_echoes("```\nAn echoes note.\n```")
        self.assertEqual(out, "An echoes note.")

    def test_strips_markdown_code_fence(self):
        out = compose_echoes._clean_echoes("```markdown\nAn echoes note.\n```")
        self.assertEqual(out, "An echoes note.")

    def test_preserves_inline_backticks(self):
        out = compose_echoes._clean_echoes("A `code` reference.")
        self.assertEqual(out, "A `code` reference.")


class PriorEchoesTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._issues_root_patch = patch.object(
            compose_echoes,
            "ISSUES_ROOT",
            Path(self._tmp.name),
        )
        self._issues_root_patch.start()

    def tearDown(self):
        self._issues_root_patch.stop()
        self._tmp.cleanup()

    def _seed_echoes(self, n: int, text: str) -> None:
        d = compose_echoes.ISSUES_ROOT / str(n)
        d.mkdir(parents=True, exist_ok=True)
        (d / "echoes.md").write_text(text, encoding="utf-8")

    def test_reads_up_to_six_prior_echoes_newest_first(self):
        for n in range(450, 458):
            self._seed_echoes(n, f"echoes for WT{n}")
        out = compose_echoes._prior_echoes(458)
        # Returns newest-first (457, 456, ..., 452); not 451 or 450 since cap=6.
        nums = [n for n, _ in out]
        self.assertEqual(nums, [457, 456, 455, 454, 453, 452])

    def test_skips_missing_echoes_files(self):
        # Only 455 and 453 have echoes.md; 457/456/454/452 don't.
        self._seed_echoes(455, "wt455 echoes")
        self._seed_echoes(453, "wt453 echoes")
        out = compose_echoes._prior_echoes(458)
        nums = [n for n, _ in out]
        self.assertEqual(nums, [455, 453])

    def test_no_prior_echoes_returns_empty(self):
        out = compose_echoes._prior_echoes(458)
        self.assertEqual(out, [])

    def test_stops_at_issue_one(self):
        # For issue 3 we'd look at 2, 1, then stop (offsets > N-1 hit prev<1).
        self._seed_echoes(1, "wt1 echoes")
        out = compose_echoes._prior_echoes(3)
        nums = [n for n, _ in out]
        self.assertEqual(nums, [1])


class ComposeEchoesRunTests(_DBTestCase):
    def setUp(self):
        super().setUp()
        self._tmp = tempfile.TemporaryDirectory()
        # Distinct attribute name so we don't clobber _DBTestCase's
        # self._patches (which holds the s3 fake-workspace patchers and
        # gets stopped by the parent tearDown).
        # Patch retrieval at the compose_echoes call site so the tests
        # don't reach the network. Default: return the fake passages;
        # individual tests override via .side_effect / .return_value if
        # they need a failure or empty-result path.
        retrieve_patcher = patch.object(
            compose_echoes.thingy_retrieve,
            "retrieve",
            return_value=list(_FAKE_PASSAGES),
        )
        issues_root_patcher = patch.object(
            compose_echoes,
            "ISSUES_ROOT",
            Path(self._tmp.name),
        )
        self._mock_retrieve = retrieve_patcher.start()
        issues_root_patcher.start()
        self._echoes_patches = [retrieve_patcher, issues_root_patcher]

    def tearDown(self):
        for p in self._echoes_patches:
            p.stop()
        os.environ.pop("DISCORD_CHANNEL_EDITORIAL", None)
        self._tmp.cleanup()
        super().tearDown()

    def _window(self, n: int = 458):
        from apps.workshop_bot.tools.content import issue as issue_mod

        w = issue_mod.compute_window("2026-05-16", 7)
        db.set_issue_window(
            issue_number=n,
            pub_date=w["pub_date"],
            end_date=w["end_date"],
            start_date=w["start_date"],
            day_count=w["day_count"],
            set_by="test",
        )

    def _ctx(self, reply: str = "A genuine archive moment from WT281."):
        fc = _FakeBotChannel(persona="eddy", reply=reply)
        os.environ["DISCORD_CHANNEL_EDITORIAL"] = "123"
        return _base.JobContext(deps=fc.deps()), fc

    def test_refuses_without_window(self):
        ctx, _fc = self._ctx()
        result = asyncio.run(compose_echoes.run(ctx))
        self.assertFalse(result.ok)
        self.assertIn("issue window", result.message)

    def test_refuses_without_body(self):
        """With no baseline_body and no draft.md on S3, the job refuses
        with a clear pointer at what to run first."""
        self._window()
        ctx, _fc = self._ctx()
        result = asyncio.run(compose_echoes.run(ctx))
        self.assertFalse(result.ok)
        self.assertIn("no body available", result.message)

    def test_happy_path_writes_echoes(self):
        """Reply is a real paragraph — echoes.md gets written to both S3
        (FakeWorkspace) and local ISSUES_ROOT/458/echoes.md."""
        self._window()
        ctx, fc = self._ctx(
            reply="In WT281, Jamie wrote about local food systems. The thread runs through this issue too."
        )
        result = asyncio.run(
            compose_echoes.run(
                ctx,
                baseline_body="## Notable\n\n### [A](http://a)\n\nbody",
            )
        )
        self.assertTrue(result.ok, result.message)
        self.assertTrue(result.data["echoes_written"])
        # S3 mirror — written under the atoms/ prefix as echoes.md now.
        self.assertIsNotNone(content_store.read_issue(458, "echoes.md"))
        self.assertIn("WT281", content_store.read_issue(458, "echoes.md"))
        # Local mirror
        local_path = compose_echoes.ISSUES_ROOT / "458" / "echoes.md"
        self.assertTrue(local_path.exists())
        self.assertIn("WT281", local_path.read_text(encoding="utf-8"))
        # Status message posted to #editorial
        fc.channel.send.assert_awaited()
        sent = fc.channel.send.await_args_list[0].args[0]
        self.assertIn("compose-echoes", sent)
        self.assertIn("WT458", sent)

    def test_empty_reply_fails_cleanly(self):
        self._window()
        ctx, fc = self._ctx(reply="")
        result = asyncio.run(
            compose_echoes.run(
                ctx,
                baseline_body="## Notable\n\nbody",
            )
        )
        self.assertFalse(result.ok)
        self.assertIn("empty reply", result.message)

    def test_retrieve_called_with_baseline_body(self):
        """The Librarian retrieval query is the baseline body — that's how
        Sonnet gets candidates that are semantically aligned with the
        current draft. Confirm the wiring."""
        self._window()
        ctx, _fc = self._ctx(reply="An echoes note mentioning WT281.")
        body = "## Notable\n\n### [Signal](http://signal)\n\nA piece about messaging."
        result = asyncio.run(compose_echoes.run(ctx, baseline_body=body))
        self.assertTrue(result.ok, result.message)
        self._mock_retrieve.assert_called_once()
        args, kwargs = self._mock_retrieve.call_args
        # First positional arg is the query; k is a kwarg.
        self.assertEqual(args[0], body)
        self.assertEqual(kwargs.get("k"), compose_echoes._ARCHIVE_SNIPPET_COUNT)

    def test_retrieval_failure_fails_loud(self):
        """If Librarian /retrieve is unreachable or refuses, the job fails
        loud — no silent fallback to BM25 / inventory / nothing. The
        quality bar for echoes requires real semantic retrieval."""
        self._window()
        self._mock_retrieve.side_effect = thingy_retrieve.ThingyRetrieveError(
            "LIBRARIAN_RETRIEVE_SECRET is not set",
        )
        ctx, fc = self._ctx(reply="should not be used")
        result = asyncio.run(
            compose_echoes.run(
                ctx,
                baseline_body="## Notable\n\nbody",
            )
        )
        self.assertFalse(result.ok)
        self.assertIn("Librarian retrieval unavailable", result.message)
        self.assertTrue(result.data.get("retrieval_failed"))
        # No echoes.md written
        self.assertIsNone(content_store.read_issue(458, "echoes.md"))
        # No Sonnet call attempted (FakeBotChannel records calls)
        sent = fc.channel.send.await_args_list[0].args[0]
        self.assertIn("Librarian retrieval unavailable", sent)

    def test_reply_linkifies_bare_issue_references(self):
        """The model is asked to render references as markdown links,
        but if it slips and writes a bare 'WT281', the post-processor
        wraps it in a link to the public archive."""
        self._window()
        ctx, _fc = self._ctx(
            reply="In WT281 Jamie wrote about local food systems. The thread carries through to this issue.",
        )
        result = asyncio.run(
            compose_echoes.run(
                ctx,
                baseline_body="## Notable\n\nbody",
            )
        )
        self.assertTrue(result.ok, result.message)
        written = content_store.read_issue(458, "echoes.md")
        self.assertIn(
            "[WT281](https://weekly.thingelstad.com/archive/281/)",
            written,
        )

    def test_reply_preserves_existing_markdown_links(self):
        """If the model already wrote the reference as a proper markdown
        link, the post-processor must not double-wrap it."""
        self._window()
        link = "[Weekly Thing 281](https://weekly.thingelstad.com/archive/281/)"
        ctx, _fc = self._ctx(
            reply=f"In {link}, Jamie wrote about local food systems. The thread is alive again.",
        )
        result = asyncio.run(
            compose_echoes.run(
                ctx,
                baseline_body="## Notable\n\nbody",
            )
        )
        self.assertTrue(result.ok, result.message)
        written = content_store.read_issue(458, "echoes.md")
        # Exactly one occurrence of the link — no double-wrapping.
        self.assertEqual(written.count(link), 1)
        # And no nested `[[..]](..)` pathology.
        self.assertNotIn("[[", written)

    def test_passages_from_current_issue_excluded(self):
        """A passage from the in-flight issue itself should never appear
        in the candidates — citing the issue you're closing makes no
        sense, and retrieval doesn't know which issue is in-flight."""
        self._window(n=281)
        # Retrieve returns a passage for WT281 plus one for WT200; the
        # WT281 one should be filtered out before reaching the prompt.
        self._mock_retrieve.return_value = [
            {
                "issue_number": 281,
                "subject": "self",
                "publish_date": "2024-06-08",
                "section": "x",
                "text": "self",
            },
            {
                "issue_number": 200,
                "subject": "other",
                "publish_date": "2022-01-01",
                "section": "y",
                "text": "other",
            },
        ]
        ctx, fc = self._ctx(
            reply="A reflection drawing on [Weekly Thing 200](https://weekly.thingelstad.com/archive/200/)."
        )
        result = asyncio.run(
            compose_echoes.run(
                ctx,
                baseline_body="## Notable\n\nbody",
            )
        )
        self.assertTrue(result.ok, result.message)


class LinkifyArchiveRefsTests(unittest.TestCase):
    def test_wraps_bare_wt_reference(self):
        out = compose_echoes._linkify_archive_refs("Back in WT185 Jamie wrote about Signal.")
        self.assertEqual(
            out,
            "Back in [WT185](https://weekly.thingelstad.com/archive/185/) Jamie wrote about Signal.",
        )

    def test_wraps_bare_weekly_thing_reference(self):
        out = compose_echoes._linkify_archive_refs(
            "In Weekly Thing 281 the theme was food systems."
        )
        self.assertEqual(
            out,
            "In [Weekly Thing 281](https://weekly.thingelstad.com/archive/281/) the theme was food systems.",
        )

    def test_preserves_existing_markdown_link(self):
        text = (
            "In [Weekly Thing 281](https://weekly.thingelstad.com/archive/281/) the theme was food."
        )
        self.assertEqual(compose_echoes._linkify_archive_refs(text), text)

    def test_does_not_double_wrap_when_label_is_already_a_link(self):
        # The label inside an existing link contains "WT185" but should
        # not be processed.
        text = "See [the WT185 piece](https://example.com/page) for more."
        self.assertEqual(compose_echoes._linkify_archive_refs(text), text)

    def test_handles_multiple_references_in_one_paragraph(self):
        out = compose_echoes._linkify_archive_refs(
            "Both WT100 and Weekly Thing 281 explored this terrain.",
        )
        self.assertIn("[WT100](https://weekly.thingelstad.com/archive/100/)", out)
        self.assertIn("[Weekly Thing 281](https://weekly.thingelstad.com/archive/281/)", out)

    def test_ignores_non_issue_numbers(self):
        # "WT" without a digit, or a year-like number not preceded by WT/Weekly Thing
        out = compose_echoes._linkify_archive_refs(
            "In 2017 the WT began, and 100 years before that."
        )
        self.assertNotIn("[", out)

    def test_empty_string_passes_through(self):
        self.assertEqual(compose_echoes._linkify_archive_refs(""), "")


class AnniversaryCandidatesTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._tmp_path = Path(self._tmp.name)
        self._emails = self._tmp_path / "emails.json"
        self._issues_root = self._tmp_path / "issues"
        self._patches = [
            patch.object(compose_echoes, "EMAILS_JSON", self._emails),
            patch.object(compose_echoes, "ISSUES_ROOT", self._issues_root),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def _seed_emails(self, entries):
        import json as _json

        self._emails.write_text(_json.dumps(entries), encoding="utf-8")

    def _seed_archive(self, n, body):
        issue_dir = self._issues_root / str(n)
        issue_dir.mkdir(parents=True, exist_ok=True)
        (issue_dir / "archive.md").write_text(
            f"---\nnumber: {n}\n---\n{body}",
            encoding="utf-8",
        )

    def test_finds_nearest_issue_at_each_offset(self):
        # Issues laid out so 1y/5y/8y back from 2026-05-17 resolve cleanly.
        self._seed_emails(
            [
                {"number": 348, "subject": "WT348", "publish_date": "2026-05-17T11:00:00Z"},
                {"number": 296, "subject": "WT296", "publish_date": "2025-05-18T12:00:00Z"},  # ~1y
                {"number": 200, "subject": "WT200", "publish_date": "2021-05-15T12:00:00Z"},  # ~5y
                {"number": 60, "subject": "WT60", "publish_date": "2018-05-19T12:00:00Z"},  # ~8y
            ]
        )
        self._seed_archive(296, "Body for WT296 about home automation.")
        self._seed_archive(200, "Body for WT200 about pandemic life.")
        self._seed_archive(60, "Body for WT60 about early WWDC keynotes.")

        out = compose_echoes._anniversary_candidates(
            "2026-05-17T11:00:00Z",
            current_number=348,
        )
        self.assertEqual([c["issue_number"] for c in out], [296, 200, 60])
        self.assertEqual([c["years_ago"] for c in out], [1, 5, 8])
        self.assertIn("home automation", out[0]["body_preview"])
        self.assertIn("pandemic life", out[1]["body_preview"])
        self.assertIn("WWDC", out[2]["body_preview"])

    def test_deduplicates_when_offsets_collide(self):
        # Only one prior issue exists; all three offsets resolve to it.
        self._seed_emails(
            [
                {"number": 348, "subject": "WT348", "publish_date": "2026-05-17T11:00:00Z"},
                {"number": 100, "subject": "WT100", "publish_date": "2019-01-01T12:00:00Z"},
            ]
        )
        self._seed_archive(100, "Only candidate.")
        out = compose_echoes._anniversary_candidates(
            "2026-05-17T11:00:00Z",
            current_number=348,
        )
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["issue_number"], 100)

    def test_skips_current_and_future_issues(self):
        # No issue numbered < 348 in the list — should return empty
        # (the current issue itself doesn't qualify as its own anniversary).
        self._seed_emails(
            [
                {"number": 348, "subject": "WT348", "publish_date": "2026-05-17T11:00:00Z"},
                {"number": 349, "subject": "WT349", "publish_date": "2026-05-24T11:00:00Z"},
            ]
        )
        out = compose_echoes._anniversary_candidates(
            "2026-05-17T11:00:00Z",
            current_number=348,
        )
        self.assertEqual(out, [])

    def test_handles_missing_emails_json(self):
        out = compose_echoes._anniversary_candidates(
            "2026-05-17T11:00:00Z",
            current_number=348,
        )
        self.assertEqual(out, [])

    def test_handles_unparseable_publish_date(self):
        self._seed_emails(
            [
                {"number": 100, "subject": "WT100", "publish_date": "2019-01-01T12:00:00Z"},
            ]
        )
        out = compose_echoes._anniversary_candidates(
            "not a real date",
            current_number=348,
        )
        self.assertEqual(out, [])

    def test_body_preview_truncates_long_archives(self):
        self._seed_emails(
            [
                {"number": 348, "subject": "WT348", "publish_date": "2026-05-17T11:00:00Z"},
                {"number": 100, "subject": "WT100", "publish_date": "2025-05-18T12:00:00Z"},
            ]
        )
        long_body = "x " * (compose_echoes._ANNIVERSARY_PREVIEW_CHARS)
        self._seed_archive(100, long_body)
        out = compose_echoes._anniversary_candidates(
            "2026-05-17T11:00:00Z",
            current_number=348,
        )
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0]["body_preview"].endswith("…"))


class FormatArchiveSnippetsTests(unittest.TestCase):
    def test_renders_passages_as_blockquoted_blocks(self):
        out = compose_echoes._format_archive_snippets(
            [
                {
                    "issue_number": 281,
                    "subject": "S",
                    "publish_date": "2024-06-08",
                    "section": "Notable",
                    "text": "T",
                },
            ]
        )
        self.assertIn("**WT281**", out)
        self.assertIn("S", out)
        self.assertIn("2024-06-08", out)
        self.assertIn("Notable", out)
        self.assertIn("> T", out)

    def test_truncates_long_snippets(self):
        long_text = "x" * (compose_echoes._SNIPPET_PREVIEW_CHARS + 200)
        out = compose_echoes._format_archive_snippets(
            [
                {
                    "issue_number": 1,
                    "subject": "S",
                    "publish_date": "2017-05-13",
                    "section": "Notable",
                    "text": long_text,
                },
            ]
        )
        # Truncation marker present, full-length string not.
        self.assertIn("…", out)
        self.assertNotIn(long_text, out)

    def test_empty_list_yields_placeholder(self):
        out = compose_echoes._format_archive_snippets([])
        self.assertIn("retrieval returned no passages", out)


if __name__ == "__main__":
    unittest.main()
