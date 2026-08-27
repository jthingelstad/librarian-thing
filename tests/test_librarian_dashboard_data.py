from __future__ import annotations

import unittest
from datetime import UTC, datetime
from unittest.mock import patch

from apps.librarian.admin import dashboard_data
from apps.librarian.admin.operator_report import Conversation, Turn


def conversation(
    conversation_id: str,
    *,
    quality: str = "clean",
    flags: list[str] | None = None,
    mode: str = "thingy",
    scope: str = "all",
    updated_at: str = "2026-07-17T12:00:00Z",
    turns: list[Turn] | None = None,
) -> Conversation:
    return Conversation(
        subscriber_hash=f"hash-{conversation_id}",
        conversation_id=conversation_id,
        title="Test conversation",
        topic="Test topic",
        summary="Test summary",
        scope=scope,
        mode=mode,
        created_at=updated_at,
        updated_at=updated_at,
        turn_count=len(turns or []),
        eval_quality=quality,
        eval_flags=flags or [],
        eval_improvements=["Use evidence that matches the claim."],
        eval_reader="",
        eval_thingy="",
        eval_takeaway="Ground the answer more carefully.",
        turns=turns or [],
    )


class DashboardQualityQueueTests(unittest.TestCase):
    def test_repeated_flags_become_prioritized_regression_candidates(self):
        first = conversation(
            "one",
            quality="watch",
            flags=["citation_mismatch", "reader_delight"],
            mode="research_guide",
            scope="blog",
            turns=[
                Turn(
                    citations=[{"source_kind": "blog"}],
                    feedback_reaction="",
                )
            ],
        )
        second = conversation(
            "two",
            quality="watch",
            flags=["citation_mismatch"],
            scope="weekly_thing",
            updated_at="2026-07-18T12:00:00Z",
            turns=[Turn(citations=[{"issue_number": 350}])],
        )

        findings = dashboard_data.build_quality_queue([first, second])

        self.assertEqual(len(findings), 1)
        finding = findings[0]
        self.assertEqual(finding.key, "citation_mismatch")
        self.assertEqual(finding.priority, "medium")
        self.assertTrue(finding.regression_candidate)
        self.assertEqual(finding.occurrences, 2)
        self.assertEqual(finding.conversation_count, 2)
        self.assertEqual(finding.modes, ("research_guide", "thingy"))
        self.assertEqual(finding.sources, ("blog", "weekly_thing"))

    def test_downvote_is_high_priority_and_clean_suggestions_are_not_queued(self):
        clean = conversation("clean")
        downvoted = conversation(
            "down",
            turns=[
                Turn(
                    question="Where is the evidence?",
                    feedback_reaction="down",
                    feedback_comment="The source does not support this answer.",
                )
            ],
        )

        findings = dashboard_data.build_quality_queue([clean, downvoted])

        self.assertEqual([finding.key for finding in findings], ["reader_downvote"])
        self.assertEqual(findings[0].priority, "high")
        self.assertIn("does not support", findings[0].examples[0].note)

    def test_privacy_boundary_is_critical(self):
        finding = dashboard_data.build_quality_queue(
            [conversation("privacy", quality="problem", flags=["privacy_boundary"])]
        )[0]
        self.assertEqual(finding.priority, "critical")


class DashboardCorpusTests(unittest.TestCase):
    def test_parse_artifact_metadata_reads_scalar_header(self):
        parsed = dashboard_data.parse_artifact_metadata(
            '{"version":2,"generated_at":"2026-07-17T20:02:02Z",'
            '"embedding_model":"cohere.embed-english-v3","post_count":10359,'
            '"chunk_count":12031,"link_count":812,"posts":['
        )
        self.assertEqual(parsed["version"], 2)
        self.assertEqual(parsed["post_count"], 10359)
        self.assertEqual(parsed["chunk_count"], 12031)
        self.assertEqual(parsed["embedding_model"], "cohere.embed-english-v3")

    def test_corpus_status_marks_upload_behind_source_mirror(self):
        class Body:
            def read(self):
                return (
                    b'{"generated_at":"2026-07-16T12:00:00Z",'
                    b'"issue_count":2,"chunk_count":20,"link_count":4,"issues":['
                )

        class S3:
            def head_object(self, **_kwargs):
                return {
                    "LastModified": datetime(2026, 7, 16, 12, tzinfo=UTC),
                    "ContentLength": 100,
                }

            def get_object(self, **_kwargs):
                return {"Body": Body()}

        spec = dashboard_data.SourceSpec(
            "weekly_thing", "Weekly Thing", "artifacts/corpus.json", "issue_count"
        )
        mirror = dashboard_data.SourceMirror(
            count=3,
            latest_content_at="2026-07-17T12:00:00Z",
            changed_at="2026-07-17T12:00:00Z",
        )
        with patch.object(dashboard_data.boto3, "client", return_value=S3()):
            status = dashboard_data._corpus_status(spec, mirror, "bucket")

        self.assertEqual(status.status, "stale")
        self.assertEqual(status.deployed_count, 2)
        self.assertIn("source mirror has 3", status.reasons[0])


if __name__ == "__main__":
    unittest.main()
