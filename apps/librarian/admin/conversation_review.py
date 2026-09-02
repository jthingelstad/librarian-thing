#!/usr/bin/env python3
"""Read exact, private Thingy conversation and MCP evidence directly from DynamoDB.

This is the Codex-facing evaluator path. It does not sign in to Thingy, call a
Thingy HTTP endpoint, create a synthetic conversation, invoke a model grader,
or write production state. ``list`` / ``show`` review native conversations;
``mcp-list`` / ``mcp-show`` review real MCP tool calls without pretending the
external client's prompt, final synthesis, or feedback is available.

Raw output is private reader evidence. Keep it in the active Codex run only;
never paste it into commits, issues, automation memory, or run summaries.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from collections import Counter
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import BotoCoreError, ClientError
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_STACK = "weekly-thing-librarian"
DEFAULT_OWNER_EMAIL = "jamie@thingelstad.com"
DEFAULT_DAYS = 7
DEFAULT_LIMIT = 30
DEFAULT_MAX_CANDIDATES = 100
DEFAULT_MAX_SCAN_PAGES = 30
DEFAULT_MAX_TURNS = 80
MCP_SLOW_TOOL_MS = 8_000

PRIVATE_NOTICE = (
    "Private reader evidence for the active Codex evaluation only. "
    "Do not persist or quote raw content in commits, issues, automation memory, or summaries."
)
RUNTIME_ATTENTION_REASONS = {
    "app_deadline_exceeded",
    "error",
    "max_tokens",
    "tool_use_exhausted",
}
CRITICAL_FLAGS = {"privacy_boundary", "prompt_leak"}


def utc_now() -> datetime:
    return datetime.now(UTC)


def iso_timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def parse_iso(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"invalid ISO timestamp: {value}") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def owner_hash(email: str) -> str:
    normalized = str(email or "").strip().lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def json_safe(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, set):
        return sorted(json_safe(item) for item in value)
    return value


def parse_json_object(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return json_safe(value)
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return json_safe(parsed) if isinstance(parsed, dict) else None


def subscriber_hash(item: dict[str, Any]) -> str:
    pk = str(item.get("pk") or "")
    return pk.removeprefix("user#") if pk.startswith("user#") else ""


def conversation_id(item: dict[str, Any]) -> str:
    sk = str(item.get("sk") or "")
    return str(item.get("conversation_id") or sk.removeprefix("conversation#"))


def reader_kind(item: dict[str, Any], *, configured_owner_hash: str) -> str:
    return "owner" if subscriber_hash(item) == configured_owner_hash else "reader"


def background_evaluation(item: dict[str, Any]) -> dict[str, Any]:
    last_request_id = str(item.get("last_request_id") or "")
    eval_last_request_id = str(item.get("eval_last_request_id") or "")
    return {
        "status": str(item.get("eval_status") or "unreviewed"),
        "quality": str(item.get("eval_quality") or "unreviewed"),
        "flags": [str(value) for value in item.get("eval_flags") or []],
        "assessed_at": str(item.get("eval_assessed_at") or ""),
        "stale": bool(last_request_id and last_request_id != eval_last_request_id),
        "note": "Background evaluator output is a triage hint, not Codex's judgment.",
    }


def resolve_table_name(session: boto3.Session, stack_name: str) -> str:
    cloudformation = session.client("cloudformation")
    response = cloudformation.describe_stack_resources(
        StackName=stack_name,
        LogicalResourceId="LibrarianTable",
    )
    resources = response.get("StackResources") or []
    if not resources:
        raise RuntimeError("CloudFormation resource not found: LibrarianTable")
    return str(resources[0]["PhysicalResourceId"])


def scan_recent_conversations(
    table: Any,
    *,
    since_iso: str,
    max_scan_pages: int,
) -> tuple[list[dict[str, Any]], int, bool]:
    rows: list[dict[str, Any]] = []
    exclusive_start_key = None
    pages = 0
    while pages < max(1, max_scan_pages):
        kwargs: dict[str, Any] = {
            "FilterExpression": (
                Attr("pk").begins_with("user#")
                & Attr("sk").begins_with("conversation#")
                & Attr("updated_at").gte(since_iso)
            )
        }
        if exclusive_start_key:
            kwargs["ExclusiveStartKey"] = exclusive_start_key
        response = table.scan(**kwargs)
        rows.extend(response.get("Items") or [])
        pages += 1
        exclusive_start_key = response.get("LastEvaluatedKey")
        if not exclusive_start_key:
            break
    rows.sort(key=lambda row: str(row.get("updated_at") or ""), reverse=True)
    return rows, pages, bool(exclusive_start_key)


def scan_recent_mcp_calls(
    table: Any,
    *,
    since_iso: str,
    max_scan_pages: int,
) -> tuple[list[dict[str, Any]], int, bool]:
    rows: list[dict[str, Any]] = []
    exclusive_start_key = None
    pages = 0
    while pages < max(1, max_scan_pages):
        kwargs: dict[str, Any] = {
            "FilterExpression": (
                Attr("pk").begins_with("user#")
                & Attr("sk").begins_with("mcp#")
                & Attr("created_at").gte(since_iso)
            )
        }
        if exclusive_start_key:
            kwargs["ExclusiveStartKey"] = exclusive_start_key
        response = table.scan(**kwargs)
        rows.extend(response.get("Items") or [])
        pages += 1
        exclusive_start_key = response.get("LastEvaluatedKey")
        if not exclusive_start_key:
            break
    rows.sort(key=lambda row: str(row.get("created_at") or ""), reverse=True)
    return rows, pages, bool(exclusive_start_key)


def find_conversation(
    table: Any,
    *,
    requested_id: str,
    max_scan_pages: int,
) -> tuple[dict[str, Any], int]:
    matches: list[dict[str, Any]] = []
    exclusive_start_key = None
    pages = 0
    while pages < max(1, max_scan_pages):
        kwargs: dict[str, Any] = {
            "FilterExpression": (
                Attr("pk").begins_with("user#") & Attr("sk").eq(f"conversation#{requested_id}")
            )
        }
        if exclusive_start_key:
            kwargs["ExclusiveStartKey"] = exclusive_start_key
        response = table.scan(**kwargs)
        matches.extend(response.get("Items") or [])
        pages += 1
        exclusive_start_key = response.get("LastEvaluatedKey")
        if not exclusive_start_key:
            break
    if exclusive_start_key:
        raise RuntimeError(
            f"conversation {requested_id!r} could not be resolved uniquely before the "
            f"{max_scan_pages}-page scan limit"
        )
    if not matches:
        raise RuntimeError(f"conversation not found: {requested_id}")
    if len(matches) > 1:
        raise RuntimeError(f"conversation id is not unique: {requested_id}")
    return matches[0], pages


def find_mcp_call(
    table: Any,
    *,
    requested_id: str,
    max_scan_pages: int,
) -> tuple[dict[str, Any], int]:
    matches: list[dict[str, Any]] = []
    exclusive_start_key = None
    pages = 0
    while pages < max(1, max_scan_pages):
        kwargs: dict[str, Any] = {
            "FilterExpression": (
                Attr("pk").begins_with("user#")
                & Attr("sk").begins_with("mcp#")
                & Attr("request_id").eq(requested_id)
            )
        }
        if exclusive_start_key:
            kwargs["ExclusiveStartKey"] = exclusive_start_key
        response = table.scan(**kwargs)
        matches.extend(response.get("Items") or [])
        pages += 1
        exclusive_start_key = response.get("LastEvaluatedKey")
        if not exclusive_start_key:
            break
    if exclusive_start_key:
        raise RuntimeError(
            f"MCP request {requested_id!r} could not be resolved uniquely before the "
            f"{max_scan_pages}-page scan limit"
        )
    if not matches:
        raise RuntimeError(f"MCP request not found: {requested_id}")
    if len(matches) > 1:
        raise RuntimeError(f"MCP request id is not unique: {requested_id}")
    return matches[0], pages


def query_turn_rows(
    table: Any,
    *,
    pk: str,
    requested_id: str,
    max_turns: int,
    signals_only: bool,
) -> tuple[list[dict[str, Any]], bool]:
    rows: list[dict[str, Any]] = []
    exclusive_start_key = None
    limit = max(1, max_turns)
    while len(rows) < limit:
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": (
                Key("pk").eq(pk) & Key("sk").begins_with(f"turn#{requested_id}#")
            ),
            "ScanIndexForward": True,
            "Limit": limit - len(rows),
        }
        if signals_only:
            kwargs["ProjectionExpression"] = (
                "#sk, feedback_reaction, feedback_at, citation_count, tool_count, "
                "stop_reason, duration_ms"
            )
            kwargs["ExpressionAttributeNames"] = {"#sk": "sk"}
        if exclusive_start_key:
            kwargs["ExclusiveStartKey"] = exclusive_start_key
        response = table.query(**kwargs)
        rows.extend(response.get("Items") or [])
        exclusive_start_key = response.get("LastEvaluatedKey")
        if not exclusive_start_key:
            break
    return rows[:limit], bool(exclusive_start_key)


def turn_signals(rows: list[dict[str, Any]], *, truncated: bool) -> dict[str, Any]:
    reactions = Counter(
        str(row.get("feedback_reaction")) for row in rows if str(row.get("feedback_reaction") or "")
    )
    runtime_reasons = Counter(
        str(row.get("stop_reason"))
        for row in rows
        if str(row.get("stop_reason") or "") in RUNTIME_ATTENTION_REASONS
    )
    return {
        "feedback": dict(sorted(reactions.items())),
        "downvotes": reactions.get("down", 0),
        "runtime_attention": dict(sorted(runtime_reasons.items())),
        "citation_count": sum(int(row.get("citation_count") or 0) for row in rows),
        "tool_count": sum(int(row.get("tool_count") or 0) for row in rows),
        "turn_signals_truncated": truncated,
    }


def attention(item: dict[str, Any], signals: dict[str, Any]) -> tuple[str, list[str]]:
    evaluation = background_evaluation(item)
    quality = evaluation["quality"]
    flags = set(evaluation["flags"])
    reasons: list[str] = []
    if flags & CRITICAL_FLAGS:
        reasons.extend(sorted(flags & CRITICAL_FLAGS))
    if signals["downvotes"]:
        reasons.append("reader_downvote")
    if quality in {"problem", "watch"}:
        reasons.append(f"background_{quality}")
    reasons.extend(flag for flag in sorted(flags) if flag not in reasons)
    if signals["runtime_attention"]:
        reasons.append("runtime_attention")
    if evaluation["stale"]:
        reasons.append("background_eval_stale")

    if flags & CRITICAL_FLAGS:
        priority = "critical"
    elif signals["downvotes"] or quality == "problem":
        priority = "high"
    elif quality == "watch" or flags or signals["runtime_attention"]:
        priority = "medium"
    else:
        priority = "routine"
    return priority, reasons


def index_record(
    item: dict[str, Any],
    signals: dict[str, Any],
    *,
    configured_owner_hash: str,
) -> dict[str, Any]:
    priority, reasons = attention(item, signals)
    return {
        "conversation_id": conversation_id(item),
        "reader_kind": reader_kind(item, configured_owner_hash=configured_owner_hash),
        "title": str(item.get("title") or "Untitled chat"),
        "topic": str(item.get("eval_topic") or item.get("topic") or ""),
        "created_at": str(item.get("created_at") or ""),
        "updated_at": str(item.get("updated_at") or item.get("created_at") or ""),
        "turn_count": int(item.get("turn_count") or 0),
        "scope": str(item.get("scope") or "all"),
        "mode": str(item.get("mode") or "thingy"),
        "shared": bool(item.get("shared_at")),
        "priority": priority,
        "attention_reasons": reasons,
        "signals": signals,
        "background_evaluation": background_evaluation(item),
    }


def exact_turn(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "created_at": str(row.get("created_at") or ""),
        "request_id": str(row.get("request_id") or ""),
        "scope": str(row.get("scope") or "all"),
        "mode": str(row.get("mode") or "thingy"),
        "question": str(row.get("question") or ""),
        "answer": str(row.get("answer") or ""),
        "citations": json_safe(row.get("citations") or []),
        "feedback": {
            "reaction": str(row.get("feedback_reaction") or ""),
            "comment": str(row.get("feedback_comment") or ""),
            "at": str(row.get("feedback_at") or ""),
        },
        "preflight": json_safe(row.get("preflight")) if row.get("preflight") else None,
        "runtime": {
            "model": str(row.get("model") or ""),
            "duration_ms": int(row.get("duration_ms") or 0),
            # output_tokens is cumulative across the agent loop on schema v2
            # rows; on older rows it is the final Bedrock call only.
            "output_tokens": int(row.get("output_tokens") or 0),
            "input_tokens": int(row.get("input_tokens") or 0),
            "total_tokens": int(row.get("total_tokens") or 0),
            "cache_read_input_tokens": int(row.get("cache_read_input_tokens") or 0),
            "cache_write_input_tokens": int(row.get("cache_write_input_tokens") or 0),
            "bedrock_calls": int(row.get("bedrock_calls") or 0),
            "stop_reason": str(row.get("stop_reason") or ""),
            "tool_count": int(row.get("tool_count") or 0),
            "tool_names": [str(value) for value in row.get("tool_names") or []],
        },
        "versions": {
            "trace_schema_version": int(row.get("trace_schema_version") or 0),
            "prompt_fingerprint": str(row.get("prompt_fingerprint") or ""),
            "source_revision": str(row.get("source_revision") or ""),
        },
        "tool_trace": parse_json_object(row.get("tool_trace_json")),
        "artifact": parse_json_object(row.get("artifact_json")),
    }


def detail_record(
    item: dict[str, Any],
    turns: list[dict[str, Any]],
    *,
    turns_truncated: bool,
    configured_owner_hash: str,
) -> dict[str, Any]:
    evaluation = background_evaluation(item)
    evaluation.update(
        {
            "summary": str(item.get("summary") or ""),
            "reader": str(item.get("eval_reader") or ""),
            "thingy": str(item.get("eval_thingy") or ""),
            "takeaway": str(item.get("eval_takeaway") or ""),
            "improvements": [str(value) for value in item.get("eval_improvements") or []],
        }
    )
    return {
        "privacy": PRIVATE_NOTICE,
        "source": "direct_dynamodb_read_only",
        "conversation": {
            "conversation_id": conversation_id(item),
            "reader_kind": reader_kind(item, configured_owner_hash=configured_owner_hash),
            "title": str(item.get("title") or "Untitled chat"),
            "topic": str(item.get("eval_topic") or item.get("topic") or ""),
            "created_at": str(item.get("created_at") or ""),
            "updated_at": str(item.get("updated_at") or item.get("created_at") or ""),
            "turn_count": int(item.get("turn_count") or 0),
            "scope": str(item.get("scope") or "all"),
            "mode": str(item.get("mode") or "thingy"),
            "shared": bool(item.get("shared_at")),
        },
        "background_evaluation": evaluation,
        "turns_returned": len(turns),
        "turns_truncated": turns_truncated,
        "turns": [exact_turn(row) for row in turns],
    }


def collect_index(
    table: Any,
    *,
    since_iso: str,
    limit: int,
    max_candidates: int,
    max_scan_pages: int,
    max_turns: int,
    configured_owner_hash: str,
    reader_filter: str,
    sort: str,
) -> dict[str, Any]:
    items, pages, scan_truncated = scan_recent_conversations(
        table,
        since_iso=since_iso,
        max_scan_pages=max_scan_pages,
    )
    filtered_items = [
        item
        for item in items
        if reader_filter == "all"
        or reader_kind(item, configured_owner_hash=configured_owner_hash) == reader_filter
    ]
    candidate_items = filtered_items[: max(1, max_candidates)]
    records: list[dict[str, Any]] = []
    for item in candidate_items:
        kind = reader_kind(item, configured_owner_hash=configured_owner_hash)
        assert reader_filter == "all" or kind == reader_filter
        rows, turns_truncated = query_turn_rows(
            table,
            pk=str(item.get("pk") or ""),
            requested_id=conversation_id(item),
            max_turns=max_turns,
            signals_only=True,
        )
        records.append(
            index_record(
                item,
                turn_signals(rows, truncated=turns_truncated),
                configured_owner_hash=configured_owner_hash,
            )
        )
    if sort == "attention":
        priority_order = {"critical": 0, "high": 1, "medium": 2, "routine": 3}
        records.sort(key=lambda record: str(record.get("updated_at") or ""), reverse=True)
        records.sort(key=lambda record: priority_order.get(str(record.get("priority")), 3))
    bounded = records[: max(1, limit)]
    return {
        "privacy": PRIVATE_NOTICE,
        "source": "direct_dynamodb_read_only",
        "generated_at": iso_timestamp(utc_now()),
        "since": since_iso,
        "scan_pages": pages,
        "scan_truncated": scan_truncated,
        "matching_conversations": len(filtered_items),
        "candidate_conversations": len(records),
        "candidate_truncated": len(filtered_items) > len(candidate_items),
        "returned_conversations": len(bounded),
        "conversations": bounded,
    }


def mcp_trace(item: dict[str, Any]) -> dict[str, Any] | None:
    return parse_json_object(item.get("tool_trace_json"))


def mcp_call_from_trace(trace: dict[str, Any] | None) -> dict[str, Any]:
    calls = trace.get("calls") if trace else None
    return calls[0] if isinstance(calls, list) and calls and isinstance(calls[0], dict) else {}


def mcp_attention(item: dict[str, Any]) -> tuple[str, list[str]]:
    status = str(item.get("status") or "")
    duration_ms = int(item.get("duration_ms") or 0)
    trace = mcp_trace(item)
    call = mcp_call_from_trace(trace)
    result = call.get("result") if isinstance(call.get("result"), dict) else {}
    reasons: list[str] = []
    if status != "ok" or result.get("error"):
        reasons.append("tool_error")
    if not trace or not call:
        reasons.append("evidence_missing")
    if duration_ms >= MCP_SLOW_TOOL_MS:
        reasons.append("slow_tool")
    if bool(item.get("response_truncated")):
        reasons.append("client_response_truncated")
    truncation = result.get("truncation") if isinstance(result.get("truncation"), dict) else {}
    if truncation.get("sources_dropped") or truncation.get("evidence_dropped"):
        reasons.append("evidence_truncated")
    if "tool_error" in reasons or "evidence_missing" in reasons:
        return "high", reasons
    if reasons:
        return "medium", reasons
    return "routine", reasons


def mcp_result_signals(item: dict[str, Any]) -> dict[str, Any]:
    trace = mcp_trace(item)
    call = mcp_call_from_trace(trace)
    result = call.get("result") if isinstance(call.get("result"), dict) else {}
    sources = result.get("sources") if isinstance(result.get("sources"), list) else []
    return {
        "result_counts": json_safe(result.get("counts") or {}),
        "source_count": len(sources),
        "has_error": bool(result.get("error")),
        "trace_schema_version": int(item.get("trace_schema_version") or 0),
        "result_chars": int(item.get("result_chars") or 0),
        "client_response_truncated": bool(item.get("response_truncated")),
    }


def mcp_index_record(
    item: dict[str, Any],
    *,
    configured_owner_hash: str,
) -> dict[str, Any]:
    priority, reasons = mcp_attention(item)
    return {
        "request_id": str(item.get("request_id") or ""),
        "activity_kind": "mcp_tool_call",
        "reader_kind": reader_kind(item, configured_owner_hash=configured_owner_hash),
        "created_at": str(item.get("created_at") or ""),
        "tool_name": str(item.get("tool_name") or ""),
        "status": str(item.get("status") or ""),
        "priority": priority,
        "attention_reasons": reasons,
        "runtime": {
            "duration_ms": int(item.get("duration_ms") or 0),
            "result_chars": int(item.get("result_chars") or 0),
            "client_response_truncated": bool(item.get("response_truncated")),
        },
        "signals": mcp_result_signals(item),
        "external_answer_available": False,
    }


def collect_mcp_index(
    table: Any,
    *,
    since_iso: str,
    limit: int,
    max_candidates: int,
    max_scan_pages: int,
    configured_owner_hash: str,
    reader_filter: str,
    sort: str,
) -> dict[str, Any]:
    items, pages, scan_truncated = scan_recent_mcp_calls(
        table,
        since_iso=since_iso,
        max_scan_pages=max_scan_pages,
    )
    filtered_items = [
        item
        for item in items
        if reader_filter == "all"
        or reader_kind(item, configured_owner_hash=configured_owner_hash) == reader_filter
    ]
    records = [
        mcp_index_record(item, configured_owner_hash=configured_owner_hash)
        for item in filtered_items[: max(1, max_candidates)]
    ]
    if sort == "attention":
        priority_order = {"high": 0, "medium": 1, "routine": 2}
        records.sort(key=lambda record: str(record.get("created_at") or ""), reverse=True)
        records.sort(key=lambda record: priority_order.get(str(record.get("priority")), 2))
    bounded = records[: max(1, limit)]
    return {
        "privacy": PRIVATE_NOTICE,
        "source": "direct_dynamodb_read_only",
        "surface": "mcp",
        "generated_at": iso_timestamp(utc_now()),
        "since": since_iso,
        "scan_pages": pages,
        "scan_truncated": scan_truncated,
        "matching_mcp_calls": len(filtered_items),
        "candidate_mcp_calls": len(records),
        "candidate_truncated": len(filtered_items) > len(records),
        "returned_mcp_calls": len(bounded),
        "mcp_calls": bounded,
        "limitation": (
            "Librarian records exact MCP tool arguments and bounded result evidence, not the external "
            "client's prompt, final synthesis, or feedback."
        ),
    }


def mcp_detail_record(
    item: dict[str, Any],
    *,
    configured_owner_hash: str,
) -> dict[str, Any]:
    return {
        "privacy": PRIVATE_NOTICE,
        "source": "direct_dynamodb_read_only",
        "surface": "mcp",
        "request": {
            "request_id": str(item.get("request_id") or ""),
            "activity_kind": "mcp_tool_call",
            "reader_kind": reader_kind(item, configured_owner_hash=configured_owner_hash),
            "created_at": str(item.get("created_at") or ""),
            "tool_name": str(item.get("tool_name") or ""),
            "status": str(item.get("status") or ""),
            "arguments": parse_json_object(item.get("arguments_json")),
        },
        "runtime": {
            "duration_ms": int(item.get("duration_ms") or 0),
            "result_chars": int(item.get("result_chars") or 0),
            "client_response_truncated": bool(item.get("response_truncated")),
        },
        "versions": {
            "trace_schema_version": int(item.get("trace_schema_version") or 0),
            "source_revision": str(item.get("source_revision") or ""),
        },
        "tool_trace": mcp_trace(item),
        "external_client_outcome": {
            "final_answer_available": False,
            "feedback_available": False,
            "note": (
                "The Librarian MCP server does not receive the external client's prompt, final "
                "synthesis, or reader feedback; do not infer final-answer quality from this record."
            ),
        },
    }


def add_connection_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--stack-name", default=os.environ.get("LIBRARIAN_STACK_NAME", DEFAULT_STACK)
    )
    parser.add_argument("--table-name", default="")
    parser.add_argument(
        "--owner-email",
        default=os.environ.get("THINGY_OPERATOR_OWNER_EMAIL", DEFAULT_OWNER_EMAIL),
        help="Used only to label owner conversations; the email is never emitted.",
    )
    parser.add_argument("--max-scan-pages", type=int, default=DEFAULT_MAX_SCAN_PAGES)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list", help="List a bounded private review index.")
    add_connection_arguments(list_parser)
    list_parser.add_argument("--days", type=int, default=DEFAULT_DAYS)
    list_parser.add_argument("--since", default="", help="ISO lower bound; overrides --days.")
    list_parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    list_parser.add_argument("--max-candidates", type=int, default=DEFAULT_MAX_CANDIDATES)
    list_parser.add_argument("--max-turns", type=int, default=DEFAULT_MAX_TURNS)
    list_parser.add_argument("--reader", choices=("all", "reader", "owner"), default="all")
    list_parser.add_argument("--sort", choices=("attention", "newest"), default="attention")

    show_parser = subparsers.add_parser("show", help="Show one exact private conversation.")
    add_connection_arguments(show_parser)
    show_parser.add_argument("conversation_id")
    show_parser.add_argument("--max-turns", type=int, default=DEFAULT_MAX_TURNS)

    mcp_list_parser = subparsers.add_parser(
        "mcp-list", help="List a bounded private index of natural MCP tool calls."
    )
    add_connection_arguments(mcp_list_parser)
    mcp_list_parser.add_argument("--days", type=int, default=DEFAULT_DAYS)
    mcp_list_parser.add_argument("--since", default="", help="ISO lower bound; overrides --days.")
    mcp_list_parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    mcp_list_parser.add_argument("--max-candidates", type=int, default=DEFAULT_MAX_CANDIDATES)
    mcp_list_parser.add_argument("--reader", choices=("all", "reader", "owner"), default="all")
    mcp_list_parser.add_argument("--sort", choices=("attention", "newest"), default="attention")

    mcp_show_parser = subparsers.add_parser(
        "mcp-show", help="Show one exact private MCP tool call."
    )
    add_connection_arguments(mcp_show_parser)
    mcp_show_parser.add_argument("request_id")
    return parser.parse_args(argv)


def run(args: argparse.Namespace) -> dict[str, Any]:
    load_dotenv(REPO_ROOT / ".env")
    session = boto3.Session()
    table_name = args.table_name or resolve_table_name(session, args.stack_name)
    table = session.resource("dynamodb").Table(table_name)
    configured_owner_hash = owner_hash(args.owner_email)

    if args.command in {"list", "mcp-list"}:
        since = (
            parse_iso(args.since) if args.since else utc_now() - timedelta(days=max(1, args.days))
        )
        if args.command == "mcp-list":
            return collect_mcp_index(
                table,
                since_iso=iso_timestamp(since),
                limit=args.limit,
                max_candidates=args.max_candidates,
                max_scan_pages=args.max_scan_pages,
                configured_owner_hash=configured_owner_hash,
                reader_filter=args.reader,
                sort=args.sort,
            )
        return collect_index(
            table,
            since_iso=iso_timestamp(since),
            limit=args.limit,
            max_candidates=args.max_candidates,
            max_scan_pages=args.max_scan_pages,
            max_turns=args.max_turns,
            configured_owner_hash=configured_owner_hash,
            reader_filter=args.reader,
            sort=args.sort,
        )

    if args.command == "mcp-show":
        item, pages = find_mcp_call(
            table,
            requested_id=args.request_id,
            max_scan_pages=args.max_scan_pages,
        )
        detail = mcp_detail_record(item, configured_owner_hash=configured_owner_hash)
        detail["scan_pages"] = pages
        return detail

    item, pages = find_conversation(
        table,
        requested_id=args.conversation_id,
        max_scan_pages=args.max_scan_pages,
    )
    turns, turns_truncated = query_turn_rows(
        table,
        pk=str(item.get("pk") or ""),
        requested_id=args.conversation_id,
        max_turns=args.max_turns,
        signals_only=False,
    )
    detail = detail_record(
        item,
        turns,
        turns_truncated=turns_truncated,
        configured_owner_hash=configured_owner_hash,
    )
    detail["scan_pages"] = pages
    return detail


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        payload = run(args)
    except (BotoCoreError, ClientError, RuntimeError, ValueError) as error:
        print(f"conversation review failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(json_safe(payload), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
