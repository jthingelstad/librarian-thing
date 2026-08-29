from __future__ import annotations

from decimal import Decimal

import pytest

from apps.librarian.admin import conversation_review


class FakeTable:
    def __init__(self, *, scan_pages=None, query_pages=None):
        self.scan_pages = list(scan_pages or [])
        self.query_pages = list(query_pages or [])
        self.scan_calls = []
        self.query_calls = []

    def scan(self, **kwargs):
        self.scan_calls.append(kwargs)
        return self.scan_pages.pop(0)

    def query(self, **kwargs):
        self.query_calls.append(kwargs)
        return self.query_pages.pop(0)


def metadata(**overrides):
    row = {
        "pk": "user#reader-hash",
        "sk": "conversation#conversation-1",
        "conversation_id": "conversation-1",
        "title": "A private reader topic",
        "eval_topic": "Archive question",
        "created_at": "2026-08-28T12:00:00Z",
        "updated_at": "2026-08-28T12:05:00Z",
        "turn_count": Decimal("1"),
        "scope": "all",
        "mode": "thingy",
        "last_request_id": "request-1",
        "eval_last_request_id": "request-1",
        "eval_status": "reviewed",
        "eval_quality": "clean",
        "eval_flags": [],
    }
    row.update(overrides)
    return row


def test_index_is_bounded_private_and_does_not_expose_reader_identity_or_transcript():
    table = FakeTable(
        scan_pages=[{"Items": [metadata()]}],
        query_pages=[
            {
                "Items": [
                    {
                        "sk": "turn#conversation-1#one",
                        "feedback_reaction": "down",
                        "citation_count": Decimal("2"),
                        "tool_count": Decimal("3"),
                        "stop_reason": "end_turn",
                    }
                ]
            }
        ],
    )

    payload = conversation_review.collect_index(
        table,
        since_iso="2026-08-22T00:00:00Z",
        limit=10,
        max_candidates=20,
        max_scan_pages=3,
        max_turns=80,
        configured_owner_hash="owner-hash",
        reader_filter="all",
        sort="attention",
    )

    assert payload["source"] == "direct_dynamodb_read_only"
    assert payload["returned_conversations"] == 1
    record = payload["conversations"][0]
    assert record["conversation_id"] == "conversation-1"
    assert record["reader_kind"] == "reader"
    assert record["priority"] == "high"
    assert record["signals"]["downvotes"] == 1
    assert record["signals"]["citation_count"] == 2
    assert "pk" not in record
    assert "subscriber_hash" not in record
    assert "question" not in record
    assert "answer" not in record
    assert "ProjectionExpression" in table.query_calls[0]


def test_detail_contains_one_exact_conversation_and_parses_runtime_evidence():
    item = metadata(
        summary="Background summary",
        eval_reader="Reader wanted source evidence.",
        eval_thingy="Thingy cited the archive.",
        eval_takeaway="Nothing to act on.",
        eval_improvements=[],
    )
    turns = [
        {
            "created_at": "2026-08-28T12:05:00Z",
            "request_id": "request-1",
            "question": "Exact private question",
            "answer": "Exact Thingy answer",
            "citations": [{"issue_number": Decimal("350")}],
            "feedback_reaction": "up",
            "feedback_comment": "Helpful",
            "duration_ms": Decimal("1250"),
            "output_tokens": Decimal("90"),
            "tool_count": Decimal("1"),
            "tool_names": ["search_archive"],
            "tool_trace_json": '{"calls":[{"name":"search_archive"}]}',
            "artifact_json": '{"kind":"reading_path"}',
        }
    ]

    payload = conversation_review.detail_record(
        item,
        turns,
        turns_truncated=False,
        configured_owner_hash="owner-hash",
    )

    assert payload["conversation"]["conversation_id"] == "conversation-1"
    assert payload["conversation"]["reader_kind"] == "reader"
    assert payload["turns"][0]["question"] == "Exact private question"
    assert payload["turns"][0]["answer"] == "Exact Thingy answer"
    assert payload["turns"][0]["citations"][0]["issue_number"] == 350
    assert payload["turns"][0]["tool_trace"]["calls"][0]["name"] == "search_archive"
    assert payload["turns"][0]["artifact"]["kind"] == "reading_path"
    assert payload["background_evaluation"]["note"].endswith("not Codex's judgment.")
    assert "reader-hash" not in str(payload)


def test_exact_turn_backward_compatible_with_pre_schema_v2_rows():
    old_row = {
        "created_at": "2026-08-01T12:00:00Z",
        "request_id": "request-old",
        "question": "Old question",
        "answer": "Old answer",
        "output_tokens": Decimal("90"),
        "tool_trace_json": '{"compacted":true,"omitted":true,"original_chars":52000}',
    }
    turn = conversation_review.exact_turn(old_row)
    assert turn["runtime"]["output_tokens"] == 90
    assert turn["runtime"]["input_tokens"] == 0
    assert turn["runtime"]["bedrock_calls"] == 0
    assert turn["versions"] == {
        "trace_schema_version": 0,
        "prompt_fingerprint": "",
        "source_revision": "",
    }
    assert turn["tool_trace"]["omitted"] is True


def test_exact_turn_exposes_schema_v2_usage_versions_and_evidence():
    new_row = {
        "created_at": "2026-08-29T12:00:00Z",
        "request_id": "request-new",
        "question": "New question",
        "answer": "New answer",
        "output_tokens": Decimal("640"),
        "input_tokens": Decimal("210000"),
        "total_tokens": Decimal("210640"),
        "cache_read_input_tokens": Decimal("180000"),
        "cache_write_input_tokens": Decimal("9000"),
        "bedrock_calls": Decimal("4"),
        "trace_schema_version": Decimal("2"),
        "prompt_fingerprint": "abc123def456",
        "source_revision": "chat-lambda/1788021805",
        "tool_trace_json": (
            '{"schema_version":2,"prompt_fingerprint":"abc123def456",'
            '"source_revision":"chat-lambda/1788021805","calls":[{"name":"search_archive",'
            '"ok":true,"duration_ms":420,"result":{"counts":{"results":3},"sources":'
            '[{"rank":1,"id":"wt-300-journal","issue_number":"300","score":0.91,'
            '"excerpt":"Owning your words."}]}}]}'
        ),
    }
    turn = conversation_review.exact_turn(new_row)
    runtime = turn["runtime"]
    assert runtime["input_tokens"] == 210000
    assert runtime["total_tokens"] == 210640
    assert runtime["cache_read_input_tokens"] == 180000
    assert runtime["cache_write_input_tokens"] == 9000
    assert runtime["bedrock_calls"] == 4
    assert turn["versions"]["trace_schema_version"] == 2
    assert turn["versions"]["prompt_fingerprint"] == "abc123def456"
    assert turn["versions"]["source_revision"] == "chat-lambda/1788021805"
    evidence = turn["tool_trace"]["calls"][0]["result"]
    assert evidence["counts"]["results"] == 3
    assert evidence["sources"][0]["id"] == "wt-300-journal"


def test_find_conversation_fails_closed_when_scan_limit_cannot_prove_absence():
    table = FakeTable(scan_pages=[{"Items": [], "LastEvaluatedKey": {"pk": "next"}}])

    with pytest.raises(RuntimeError, match="before the 1-page scan limit"):
        conversation_review.find_conversation(
            table,
            requested_id="missing",
            max_scan_pages=1,
        )


def test_background_evaluation_is_marked_stale_after_a_new_turn():
    evaluation = conversation_review.background_evaluation(
        metadata(last_request_id="new", eval_last_request_id="old")
    )

    assert evaluation["stale"] is True
