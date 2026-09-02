#!/usr/bin/env python3
"""Generate a local Thingy operator report from canonical DynamoDB rows.

This is intentionally local-only: it reads AWS credentials from the repo-root
``.env`` and writes a static HTML file under ``tmp/`` by default. No public
operator web surface, no browser-side secrets, no extra database.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import os
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import boto3
from boto3.dynamodb.types import TypeDeserializer
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_STACK = "weekly-thing-librarian"
DEFAULT_OUTPUT = Path.home() / "Desktop" / "Thingy Operator Report.html"
DEFAULT_OWNER_EMAIL = "jamie@thingelstad.com"

deserializer = TypeDeserializer()


def utc_now() -> datetime:
    return datetime.now(UTC)


def parse_iso(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        text = str(value).replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def iso_days_ago(days: int) -> str:
    return (utc_now() - timedelta(days=max(1, int(days)))).isoformat().replace("+00:00", "Z")


def h(value: Any) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def normalize_email(value: str) -> str:
    return str(value or "").strip().lower()


def email_hash(value: str) -> str:
    return hashlib.sha256(normalize_email(value).encode("utf-8")).hexdigest()


def compact(value: Any, limit: int = 240) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def local_time(value: Any) -> str:
    dt = parse_iso(value)
    if not dt:
        return str(value or "")
    local = dt.astimezone()
    return local.strftime("%b %-d, %-I:%M %p %Z")


def dynamo_item(item: dict[str, Any]) -> dict[str, Any]:
    return {key: deserializer.deserialize(value) for key, value in (item or {}).items()}


def stack_resource(logical_id: str, *, stack_name: str) -> str:
    cfn = boto3.client("cloudformation")
    response = cfn.describe_stack_resources(StackName=stack_name, LogicalResourceId=logical_id)
    resources = response.get("StackResources") or []
    if not resources:
        raise RuntimeError(f"CloudFormation resource not found: {logical_id}")
    return str(resources[0]["PhysicalResourceId"])


def source_label(citation: dict[str, Any]) -> str:
    if citation.get("issue_number"):
        return f"WT{citation['issue_number']}"
    return str(
        citation.get("subject") or citation.get("url") or citation.get("source_kind") or ""
    ).strip()


@dataclass
class Turn:
    created_at: str = ""
    request_id: str = ""
    question: str = ""
    answer: str = ""
    feedback_reaction: str = ""
    feedback_comment: str = ""
    citations: list[dict[str, Any]] = field(default_factory=list)
    tool_names: list[str] = field(default_factory=list)
    preflight: dict[str, Any] | None = None
    stop_reason: str = ""
    duration_ms: float = 0

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "Turn":
        return cls(
            created_at=str(row.get("created_at") or ""),
            request_id=str(row.get("request_id") or ""),
            question=str(row.get("question") or ""),
            answer=str(row.get("answer") or ""),
            feedback_reaction=str(row.get("feedback_reaction") or ""),
            feedback_comment=str(row.get("feedback_comment") or ""),
            citations=[c for c in row.get("citations") or [] if isinstance(c, dict)],
            tool_names=[str(t) for t in row.get("tool_names") or [] if t],
            preflight=row.get("preflight") if isinstance(row.get("preflight"), dict) else None,
            stop_reason=str(row.get("stop_reason") or ""),
            duration_ms=float(row.get("duration_ms") or 0),
        )

    @property
    def source_labels(self) -> list[str]:
        out: list[str] = []
        for citation in self.citations:
            label = source_label(citation)
            if label and label not in out:
                out.append(label)
        return out


@dataclass
class Conversation:
    subscriber_hash: str
    conversation_id: str
    title: str
    topic: str
    summary: str
    scope: str
    mode: str
    created_at: str
    updated_at: str
    turn_count: int
    eval_quality: str
    eval_flags: list[str]
    eval_improvements: list[str]
    eval_reader: str
    eval_thingy: str
    eval_takeaway: str
    shared_at: str = ""
    is_owner: bool = False
    turns: list[Turn] = field(default_factory=list)

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "Conversation | None":
        pk = str(row.get("pk") or "")
        sk = str(row.get("sk") or "")
        if not pk.startswith("user#") or not sk.startswith("conversation#"):
            return None
        return cls(
            subscriber_hash=pk.removeprefix("user#"),
            conversation_id=str(row.get("conversation_id") or sk.removeprefix("conversation#")),
            title=str(row.get("title") or "Untitled chat"),
            topic=str(row.get("eval_topic") or row.get("topic") or ""),
            summary=str(row.get("summary") or ""),
            scope=str(row.get("scope") or "all"),
            mode=str(row.get("mode") or "thingy"),
            created_at=str(row.get("created_at") or ""),
            updated_at=str(
                row.get("updated_at") or row.get("last_message_at") or row.get("created_at") or ""
            ),
            turn_count=int(row.get("turn_count") or 0),
            eval_quality=str(row.get("eval_quality") or "unreviewed"),
            eval_flags=[str(flag) for flag in row.get("eval_flags") or [] if flag],
            eval_improvements=[str(item) for item in row.get("eval_improvements") or [] if item],
            eval_reader=str(row.get("eval_reader") or ""),
            eval_thingy=str(row.get("eval_thingy") or ""),
            eval_takeaway=str(row.get("eval_takeaway") or ""),
            shared_at=str(row.get("shared_at") or ""),
        )

    @property
    def has_feedback(self) -> bool:
        return any(t.feedback_reaction for t in self.turns)

    @property
    def reader_kind(self) -> str:
        return "owner" if self.is_owner else "reader"

    @property
    def reader_label(self) -> str:
        return "Jamie" if self.is_owner else f"reader·{self.subscriber_hash[:8]}"

    @property
    def has_downvote(self) -> bool:
        return any(t.feedback_reaction == "down" for t in self.turns)

    @property
    def has_preflight(self) -> bool:
        return any(t.preflight for t in self.turns)

    @property
    def has_tool_use(self) -> bool:
        return any(t.tool_names for t in self.turns)

    @property
    def feedback_count(self) -> int:
        return sum(1 for t in self.turns if t.feedback_reaction)

    @property
    def source_labels(self) -> list[str]:
        out: list[str] = []
        for turn in self.turns:
            for label in turn.source_labels:
                if label not in out:
                    out.append(label)
        return out

    @property
    def tool_names(self) -> list[str]:
        out: list[str] = []
        for turn in self.turns:
            for tool_name in turn.tool_names:
                if tool_name not in out:
                    out.append(tool_name)
        return out

    @property
    def attention_reasons(self) -> list[str]:
        reasons: list[str] = []
        if self.eval_quality in {"watch", "problem"}:
            reasons.append(self.eval_quality)
        if self.has_downvote:
            reasons.append("downvote")
        if self.eval_flags:
            reasons.append("flags")
        if self.feedback_count and "downvote" not in reasons:
            reasons.append("feedback")
        return reasons

    @property
    def filter_tokens(self) -> list[str]:
        tokens = ["all"]
        if self.attention_reasons:
            tokens.append("attention")
        if self.has_feedback:
            tokens.append("feedback")
        if self.has_downvote:
            tokens.append("downvote")
        if self.eval_flags:
            tokens.append("flags")
        if self.has_preflight:
            tokens.append("preflight")
        if self.has_tool_use:
            tokens.append("tools")
        if self.is_owner:
            tokens.append("owner")
        if self.mode:
            tokens.append(f"mode:{self.mode}")
        return tokens

    @property
    def search_text(self) -> str:
        parts = [
            self.conversation_id,
            self.subscriber_hash,
            self.title,
            self.topic,
            self.summary,
            self.scope,
            self.mode,
            self.eval_quality,
            " ".join(self.eval_flags),
            " ".join(self.eval_improvements),
            self.eval_reader,
            self.eval_thingy,
            self.eval_takeaway,
            self.reader_kind,
            self.reader_label,
        ]
        for turn in self.turns:
            parts.extend(
                [
                    turn.question,
                    turn.feedback_reaction,
                    turn.feedback_comment,
                    " ".join(turn.tool_names),
                    " ".join(turn.source_labels),
                ]
            )
        return " ".join(str(part or "") for part in parts).lower()


def scan_conversations(table_name: str, *, since_iso: str, max_pages: int) -> list[Conversation]:
    client = boto3.client("dynamodb")
    conversations: list[Conversation] = []
    exclusive_start_key = None
    pages = 0
    while True:
        kwargs: dict[str, Any] = {
            "TableName": table_name,
            "FilterExpression": (
                "begins_with(#pk, :user_prefix) AND begins_with(#sk, :conversation_prefix) "
                "AND #updated_at >= :since"
            ),
            "ExpressionAttributeNames": {"#pk": "pk", "#sk": "sk", "#updated_at": "updated_at"},
            "ExpressionAttributeValues": {
                ":user_prefix": {"S": "user#"},
                ":conversation_prefix": {"S": "conversation#"},
                ":since": {"S": since_iso},
            },
        }
        if exclusive_start_key:
            kwargs["ExclusiveStartKey"] = exclusive_start_key
        response = client.scan(**kwargs)
        for raw in response.get("Items", []):
            conv = Conversation.from_row(dynamo_item(raw))
            if conv:
                conversations.append(conv)
        exclusive_start_key = response.get("LastEvaluatedKey")
        pages += 1
        if not exclusive_start_key or pages >= max_pages:
            break
    conversations.sort(key=lambda c: c.updated_at, reverse=True)
    return conversations


def load_turns(table_name: str, conversation: Conversation, *, limit: int = 80) -> list[Turn]:
    client = boto3.client("dynamodb")
    response = client.query(
        TableName=table_name,
        KeyConditionExpression="#pk = :pk AND begins_with(#sk, :prefix)",
        ExpressionAttributeNames={"#pk": "pk", "#sk": "sk"},
        ExpressionAttributeValues={
            ":pk": {"S": f"user#{conversation.subscriber_hash}"},
            ":prefix": {"S": f"turn#{conversation.conversation_id}#"},
        },
        ScanIndexForward=True,
        Limit=limit,
    )
    return [Turn.from_row(dynamo_item(item)) for item in response.get("Items", [])]


def sort_for_review(conversations: list[Conversation]) -> list[Conversation]:
    priority = {
        "problem": 0,
        "watch": 1,
        "unreviewed": 2,
        "clean": 3,
    }
    return sorted(
        conversations,
        key=lambda c: (
            priority.get(c.eval_quality, 2),
            0 if c.has_downvote else 1,
            0 if c.eval_flags else 1,
            -(parse_iso(c.updated_at) or datetime.min.replace(tzinfo=UTC)).timestamp(),
        ),
    )


def metric_cards(conversations: list[Conversation]) -> dict[str, Any]:
    quality = Counter(c.eval_quality or "unreviewed" for c in conversations)
    modes = Counter(c.mode or "thingy" for c in conversations)
    flags = Counter(flag for c in conversations for flag in c.eval_flags)
    feedback = Counter(
        t.feedback_reaction for c in conversations for t in c.turns if t.feedback_reaction
    )
    return {
        "total": len(conversations),
        "turns": sum(c.turn_count for c in conversations),
        "readers": len({c.subscriber_hash for c in conversations}),
        "quality": quality,
        "modes": modes,
        "flags": flags,
        "feedback": feedback,
    }


def render_metric(label: str, value: Any, sub: str = "") -> str:
    return f'<div class="metric"><div class="metric-value">{h(value)}</div><div class="metric-label">{h(label)}</div><div class="metric-sub">{h(sub)}</div></div>'


def render_counter(counter: Counter, *, empty: str = "None", limit: int = 12) -> str:
    if not counter:
        return f'<p class="muted">{h(empty)}</p>'
    rows = []
    total = sum(counter.values()) or 1
    for key, value in counter.most_common(limit):
        pct = round(value * 100 / total)
        rows.append(
            "<tr>"
            f"<td>{h(key)}</td>"
            f'<td class="num">{value}</td>'
            f'<td><div class="bar"><span style="width:{pct}%"></span></div></td>'
            "</tr>"
        )
    return '<table class="compact"><tbody>' + "".join(rows) + "</tbody></table>"


def render_chips(values: list[str], *, limit: int = 8, css_class: str = "chip") -> str:
    chips = [f'<span class="{css_class}">{h(value)}</span>' for value in values[:limit] if value]
    remaining = len(values) - limit
    if remaining > 0:
        chips.append(f'<span class="{css_class}">+{remaining}</span>')
    return " ".join(chips)


def render_turn(turn: Turn, index: int) -> str:
    feedback = ""
    if turn.feedback_reaction:
        feedback = f'<p class="feedback">Feedback: <strong>{h(turn.feedback_reaction)}</strong> {h(turn.feedback_comment)}</p>'
    sources = ", ".join(turn.source_labels[:10])
    tools = ", ".join(turn.tool_names[:10])
    metadata = []
    if sources:
        metadata.append(f"Sources: {h(sources)}")
    if tools:
        metadata.append(f"Tools: {h(tools)}")
    if turn.stop_reason:
        runtime = f"Runtime: {h(turn.stop_reason)}"
        if turn.duration_ms:
            runtime += f" · {h(round(turn.duration_ms / 1000, 1))}s"
        metadata.append(runtime)
    if turn.preflight and (turn.preflight.get("category") or turn.preflight.get("action")):
        metadata.append(
            f"Preflight: {h(turn.preflight.get('category'))}/{h(turn.preflight.get('action'))}"
        )
    meta = f'<p class="meta">{" · ".join(metadata)}</p>' if metadata else ""
    return (
        '<div class="turn">'
        f"<h4>Turn {index} <span>{h(local_time(turn.created_at))}</span></h4>"
        f'<div class="bubble reader"><strong>Reader</strong><p>{h(turn.question)}</p></div>'
        f'<div class="bubble thingy"><strong>Thingy</strong><p>{h(turn.answer)}</p></div>'
        f"{feedback}{meta}"
        "</div>"
    )


def render_conversation_card(c: Conversation, *, open_by_default: bool = False) -> str:
    title = c.topic or c.title or "Untitled conversation"
    flags = render_chips(c.eval_flags, limit=10)
    owner = '<span class="chip owner-chip">Jamie</span>' if c.is_owner else ""
    mode_chip = f'<span class="chip mode-chip">{h(c.mode or "thingy")}</span>'
    shared_chip = '<span class="chip shared-chip">shared</span>' if c.shared_at else ""
    attention = render_chips(c.attention_reasons, limit=6, css_class="chip attention-chip")
    improvements = "".join(f"<li>{h(item)}</li>" for item in c.eval_improvements)
    sources = render_chips(c.source_labels, limit=16)
    tools = render_chips(c.tool_names, limit=10)
    turns = "".join(render_turn(turn, i + 1) for i, turn in enumerate(c.turns))
    search_text = compact(c.search_text, 4000)
    status_tokens = " ".join(c.filter_tokens)
    open_attr = " open" if open_by_default else ""
    return (
        f'<details class="conversation-card" data-quality="{h(c.eval_quality)}" data-status="{h(status_tokens)}" '
        f'data-scope="{h(c.scope)}" data-mode="{h(c.mode or "thingy")}" data-reader="{h(c.reader_kind)}" data-flags="{h(" ".join(c.eval_flags))}" data-search="{h(search_text)}"{open_attr}>'
        '<summary class="conversation-summary">'
        '<div class="conversation-topline">'
        f'<span class="quality q-{h(c.eval_quality)}">{h(c.eval_quality)}</span>'
        f"<span>{h(local_time(c.updated_at))}</span>"
        f"<span>{h(c.turn_count)} turn{'s' if c.turn_count != 1 else ''}</span>"
        f'<span class="reader-badge reader-{h(c.reader_kind)}">{h(c.reader_label)}</span>'
        f"<span>mode {h(c.mode or 'thingy')}</span>"
        f"<span>scope {h(c.scope)}</span>"
        f"{shared_chip}"
        "</div>"
        f"<h2>{h(title)}</h2>"
        f'<p class="conversation-preview">{h(c.summary or "No eval summary yet.")}</p>'
        f'<div class="chipline">{owner}{mode_chip}{attention}{flags}</div>'
        "</summary>"
        '<div class="conversation-body">'
        f'<p class="meta"><code>{h(c.conversation_id)}</code></p>'
        '<section class="eval-grid">'
        f"<div><h3>Reader</h3><p>{h(c.eval_reader or 'No reader assessment yet.')}</p></div>"
        f"<div><h3>Thingy</h3><p>{h(c.eval_thingy or 'No Thingy assessment yet.')}</p></div>"
        f"<div><h3>Takeaway</h3><p>{h(c.eval_takeaway or 'No takeaway yet.')}</p></div>"
        "</section>"
        f"{'<section><h3>Improvements</h3><ul>' + improvements + '</ul></section>' if improvements else ''}"
        f'<section class="meta-block"><strong>Sources</strong><div>{sources or '<span class="muted">None recorded</span>'}</div></section>'
        f'<section class="meta-block"><strong>Tools</strong><div>{tools or '<span class="muted">None recorded</span>'}</div></section>'
        '<section class="transcript">'
        "<h3>Transcript</h3>"
        f"{turns}"
        "</section>"
        "</div></details>"
    )


def render_html(
    conversations: list[Conversation],
    *,
    since_iso: str,
    generated_at: str,
    stack_name: str,
    table_name: str,
) -> str:
    metrics = metric_cards(conversations)
    quality = metrics["quality"]
    modes = metrics["modes"]
    flags = metrics["flags"]
    feedback = metrics["feedback"]
    by_day: dict[str, int] = defaultdict(int)
    for c in conversations:
        dt = parse_iso(c.updated_at)
        by_day[(dt or utc_now()).date().isoformat()] += 1
    review_conversations = sort_for_review(conversations)
    conversation_cards = "".join(render_conversation_card(c) for c in review_conversations)
    timeline = Counter(dict(sorted(by_day.items())))
    scopes = sorted({c.scope or "all" for c in conversations})
    modes_values = sorted({c.mode or "thingy" for c in conversations})
    flag_values = sorted({flag for c in conversations for flag in c.eval_flags})
    scope_options = "".join(f'<option value="{h(scope)}">{h(scope)}</option>' for scope in scopes)
    mode_options = "".join(f'<option value="{h(mode)}">{h(mode)}</option>' for mode in modes_values)
    flag_options = "".join(f'<option value="{h(flag)}">{h(flag)}</option>' for flag in flag_values)
    attention_count = sum(1 for c in conversations if c.attention_reasons)
    feedback_count = sum(1 for c in conversations if c.has_feedback)
    owner_count = sum(1 for c in conversations if c.is_owner)
    real_reader_count = len({c.subscriber_hash for c in conversations if not c.is_owner})
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Thingy Operator Report</title>
<style>
:root {{ color-scheme: light; --ink:#17211d; --muted:#66736d; --line:#dfe6e2; --line-strong:#c8d4ce; --soft:#f6f8f7; --accent:#176b5b; --accent-soft:#e8f4f1; --warn:#9f5c00; --bad:#9d2c2c; }}
* {{ box-sizing: border-box; }}
body {{ margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--ink); background:#fbfcfb; }}
main {{ max-width:1180px; margin:0 auto; padding:32px 20px 56px; }}
h1 {{ margin:0 0 4px; font-size:32px; letter-spacing:0; }}
h2 {{ margin:0 0 6px; font-size:20px; }}
h3 {{ margin:0 0 10px; font-size:14px; }}
h4 {{ margin:18px 0 8px; font-size:14px; }}
h4 span, .muted, .meta, .metric-sub {{ color:var(--muted); font-weight:400; }}
.lede {{ color:var(--muted); margin:0 0 22px; }}
.section-title {{ display:flex; align-items:flex-end; justify-content:space-between; gap:12px; margin:34px 0 12px; }}
.section-title p {{ margin:0; color:var(--muted); font-size:13px; }}
.grid {{ display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:12px; }}
.two {{ display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:16px; }}
.panel, .metric, details.conversation-card {{ background:white; border:1px solid var(--line); border-radius:8px; box-shadow:0 1px 2px rgba(0,0,0,.03); }}
.panel {{ padding:16px; }}
.metric {{ padding:18px; }}
.metric-value {{ font-size:30px; font-weight:700; }}
.metric-label {{ color:var(--muted); font-size:13px; }}
table {{ width:100%; border-collapse:collapse; font-size:14px; }}
th, td {{ text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:top; }}
th {{ color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }}
.compact td {{ padding:7px 4px; }}
.num {{ text-align:right; font-variant-numeric:tabular-nums; }}
.bar {{ height:7px; background:var(--soft); border-radius:99px; overflow:hidden; }}
.bar span {{ display:block; height:100%; background:var(--accent); }}
.quality, .chip {{ display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 8px; font-size:12px; white-space:nowrap; }}
.q-clean {{ background:#eef7f1; color:#1f6c3b; border-color:#c8e4cf; }}
.q-watch {{ background:#fff7e8; color:var(--warn); border-color:#efd29a; }}
.q-problem {{ background:#fff0f0; color:var(--bad); border-color:#edb9b9; }}
.q-unreviewed {{ background:#f2f3f2; color:#5d6862; }}
.chip {{ margin:1px 2px 1px 0; color:#3f4d47; background:#f7f9f8; }}
.attention-chip {{ background:#fff8e8; color:var(--warn); border-color:#ead59e; }}
.owner-chip, .reader-owner {{ background:#edf2ff; color:#334f9a; border-color:#c9d6ff; }}
.reader-badge {{ font-weight:700; }}
  .filters {{ position:sticky; top:0; z-index:2; display:grid; grid-template-columns:1.4fr repeat(6, minmax(105px, .5fr)) auto; gap:10px; align-items:end; padding:12px; margin:0 0 12px; background:rgba(251,252,251,.92); border:1px solid var(--line); border-radius:8px; backdrop-filter:blur(10px); }}
.filter-field {{ display:grid; gap:4px; }}
.filter-field label {{ color:var(--muted); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; }}
.filters input, .filters select {{ width:100%; min-height:36px; border:1px solid var(--line-strong); border-radius:7px; background:white; color:var(--ink); padding:0 10px; font:inherit; font-size:14px; }}
.filters button {{ min-height:36px; border:1px solid var(--line-strong); border-radius:7px; background:white; color:var(--ink); padding:0 12px; font:inherit; cursor:pointer; }}
.filter-count {{ margin:0 0 10px; color:var(--muted); font-size:13px; }}
.conversation-list {{ display:grid; gap:12px; }}
details.conversation-card {{ overflow:hidden; }}
details.conversation-card[hidden] {{ display:none; }}
.conversation-summary {{ cursor:pointer; padding:16px; list-style:none; }}
.conversation-summary::-webkit-details-marker {{ display:none; }}
.conversation-topline {{ display:flex; flex-wrap:wrap; align-items:center; gap:7px 10px; color:var(--muted); font-size:12px; }}
.conversation-summary h2 {{ margin:9px 0 6px; line-height:1.2; }}
.conversation-preview {{ margin:0; color:#33423c; line-height:1.45; }}
.chipline {{ margin-top:10px; min-height:20px; }}
.conversation-body {{ border-top:1px solid var(--line); padding:16px 16px 18px; }}
.eval-grid {{ display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:12px; }}
.eval-grid div, .meta-block {{ border:1px solid var(--line); border-radius:8px; padding:12px; background:#fcfdfc; }}
.eval-grid p {{ margin:0; color:#33423c; line-height:1.45; }}
.meta-block {{ display:grid; grid-template-columns:90px 1fr; gap:10px; align-items:start; margin-top:12px; }}
.transcript {{ margin-top:18px; }}
.turn {{ border-top:1px solid var(--line); margin-top:14px; padding-top:10px; }}
.bubble {{ border-radius:8px; padding:10px 12px; margin:8px 0; }}
.bubble p {{ white-space:pre-wrap; margin:5px 0 0; line-height:1.5; }}
.reader {{ background:#f2f4f3; }}
.thingy {{ background:#eef6f4; }}
.feedback {{ color:var(--bad); }}
.empty-state {{ padding:28px; text-align:center; color:var(--muted); border:1px dashed var(--line-strong); border-radius:8px; background:white; }}
code {{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.92em; }}
@media (max-width: 980px) {{ .filters {{ grid-template-columns:1fr 1fr; }} .eval-grid {{ grid-template-columns:1fr; }} }}
@media (max-width: 820px) {{ .grid, .two {{ grid-template-columns:1fr; }} main {{ padding:22px 14px 42px; }} table {{ font-size:13px; }} .filters {{ position:static; grid-template-columns:1fr; }} .section-title {{ display:block; }} .meta-block {{ grid-template-columns:1fr; }} }}
</style>
</head>
<body>
<main>
<h1>Thingy Operator Report</h1>
<p class="lede">Generated {h(local_time(generated_at))}. Covers conversations updated since {h(local_time(since_iso))}. Stack <code>{h(stack_name)}</code>, table <code>{h(table_name)}</code>.</p>

<section class="grid">
{render_metric("Conversations", metrics["total"])}
{render_metric("Turns", metrics["turns"])}
{render_metric("Real Readers", real_reader_count, f"{owner_count} Jamie conversation{'s' if owner_count != 1 else ''} included")}
{render_metric("Needs Attention", attention_count, f"{feedback_count} with explicit feedback")}
</section>

<section class="two">
  <div class="panel"><h3>Quality</h3>{render_counter(quality)}</div>
  <div class="panel"><h3>Modes</h3>{render_counter(modes, empty="No modes in this window")}</div>
  <div class="panel"><h3>Eval Flags</h3>{render_counter(flags, empty="No flags in this window")}</div>
<div class="panel"><h3>Feedback</h3>{render_counter(feedback, empty="No explicit feedback in this window")}</div>
<div class="panel"><h3>Daily Volume</h3>{render_counter(timeline, empty="No conversations in this window", limit=30)}</div>
</section>

<section class="section-title">
<div>
<h2>Conversation Review</h2>
<p>Conversation cards are the organizing unit: eval, metadata, feedback, sources, tools, and transcript stay together.</p>
</div>
</section>

<section class="filters" aria-label="Conversation filters">
<div class="filter-field"><label for="filter-search">Search</label><input id="filter-search" type="search" placeholder="Prompt, topic, flag, source, reader…"></div>
<div class="filter-field"><label for="filter-quality">Quality</label><select id="filter-quality"><option value="all">All</option><option value="problem">Problem</option><option value="watch">Watch</option><option value="unreviewed">Unreviewed</option><option value="clean">Clean</option></select></div>
<div class="filter-field"><label for="filter-status">Status</label><select id="filter-status"><option value="all">All</option><option value="attention">Needs attention</option><option value="feedback">Has feedback</option><option value="downvote">Downvoted</option><option value="flags">Has flags</option><option value="preflight">Preflight</option><option value="tools">Tool use</option></select></div>
  <div class="filter-field"><label for="filter-reader">Reader</label><select id="filter-reader"><option value="all">All readers</option><option value="reader">Real users</option><option value="owner">Jamie</option></select></div>
  <div class="filter-field"><label for="filter-mode">Mode</label><select id="filter-mode"><option value="all">All modes</option>{mode_options}</select></div>
  <div class="filter-field"><label for="filter-flag">Flag</label><select id="filter-flag"><option value="all">All flags</option>{flag_options}</select></div>
<div class="filter-field"><label for="filter-scope">Scope</label><select id="filter-scope"><option value="__all">All scopes</option>{scope_options}</select></div>
<button id="filter-clear" type="button">Clear</button>
</section>
<p class="filter-count" id="filter-count">{len(review_conversations)} conversations shown.</p>
<section class="conversation-list" id="conversation-list">
{conversation_cards or '<p class="empty-state">No conversations in this window.</p>'}
</section>
<p class="empty-state" id="filter-empty" hidden>No conversations match those filters.</p>
</main>
<script>
(() => {{
  const cards = Array.from(document.querySelectorAll('.conversation-card'));
  const search = document.getElementById('filter-search');
  const quality = document.getElementById('filter-quality');
  const status = document.getElementById('filter-status');
    const reader = document.getElementById('filter-reader');
    const mode = document.getElementById('filter-mode');
    const flag = document.getElementById('filter-flag');
  const scope = document.getElementById('filter-scope');
  const clear = document.getElementById('filter-clear');
  const count = document.getElementById('filter-count');
  const empty = document.getElementById('filter-empty');

  function words(value) {{
    return String(value || '').toLowerCase().trim().split(/\\s+/).filter(Boolean);
  }}

  function matches(card) {{
    const q = quality.value;
    const s = status.value;
      const r = reader.value;
      const m = mode.value;
      const f = flag.value;
    const sc = scope.value;
    const haystack = card.dataset.search || '';
    const terms = words(search.value);
    if (q !== 'all' && card.dataset.quality !== q) return false;
    if (s !== 'all' && !words(card.dataset.status).includes(s)) return false;
      if (r !== 'all' && card.dataset.reader !== r) return false;
      if (m !== 'all' && card.dataset.mode !== m) return false;
      if (f !== 'all' && !words(card.dataset.flags).includes(f.toLowerCase())) return false;
    if (sc !== '__all' && card.dataset.scope !== sc) return false;
    return terms.every((term) => haystack.includes(term));
  }}

  function update() {{
    let visible = 0;
    cards.forEach((card) => {{
      const show = matches(card);
      card.hidden = !show;
      if (show) visible += 1;
    }});
    count.textContent = `${{visible}} of ${{cards.length}} conversation${{cards.length === 1 ? '' : 's'}} shown.`;
    empty.hidden = visible !== 0 || cards.length === 0;
  }}

    [search, quality, status, reader, mode, flag, scope].forEach((control) => control && control.addEventListener(control === search ? 'input' : 'change', update));
  clear?.addEventListener('click', () => {{
    search.value = '';
    quality.value = 'all';
    status.value = 'all';
      reader.value = 'all';
      mode.value = 'all';
      flag.value = 'all';
    scope.value = '__all';
    update();
    search.focus();
  }});
  update();
}})();
</script>
</body>
</html>
"""


def build_report(args: argparse.Namespace) -> tuple[Path, int]:
    load_dotenv(REPO_ROOT / ".env")
    stack_name = args.stack_name
    table_name = args.table_name or stack_resource("LibrarianTable", stack_name=stack_name)
    since_iso = args.since or iso_days_ago(args.days)
    owner_hash = email_hash(args.owner_email)
    conversations = scan_conversations(
        table_name, since_iso=since_iso, max_pages=args.max_scan_pages
    )

    for conversation in conversations:
        conversation.is_owner = conversation.subscriber_hash == owner_hash
        conversation.turns = load_turns(table_name, conversation)

    output = Path(args.output)
    if not output.is_absolute():
        output = REPO_ROOT / output
    output.parent.mkdir(parents=True, exist_ok=True)
    html_text = render_html(
        conversations,
        since_iso=since_iso,
        generated_at=utc_now().isoformat().replace("+00:00", "Z"),
        stack_name=stack_name,
        table_name=table_name,
    )
    output.write_text(html_text, encoding="utf-8")
    return output, len(conversations)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a local Thingy operator HTML report.")
    parser.add_argument(
        "--stack-name", default=os.environ.get("LIBRARIAN_STACK_NAME", DEFAULT_STACK)
    )
    parser.add_argument("--table-name", default="")
    parser.add_argument(
        "--days", type=int, default=7, help="Look back this many days when --since is omitted."
    )
    parser.add_argument("--since", default="", help="ISO timestamp lower bound for updated_at.")
    parser.add_argument("--max-scan-pages", type=int, default=30)
    parser.add_argument(
        "--detail-limit",
        type=int,
        default=30,
        help="Number of prioritized conversations to expand.",
    )
    parser.add_argument(
        "--owner-email",
        default=os.environ.get("THINGY_OPERATOR_OWNER_EMAIL", DEFAULT_OWNER_EMAIL),
        help="Email address to label as Jamie/owner in the report.",
    )
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    return parser.parse_args()


def main() -> int:
    output, count = build_report(parse_args())
    print(f"Wrote {output} ({count} conversations)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
