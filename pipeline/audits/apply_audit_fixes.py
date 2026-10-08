#!/usr/bin/env python3
"""Convert LLM audit findings into structured fixes and apply them to bodies.

Reads notes/audits/llm-audit.json. For each high/medium-severity finding,
asks Haiku to convert the free-form `suggested_fix` text into a structured
`{action, find, replace, confidence, reason}` payload. Only auto-applies a
fix when:

  - action == "replace"
  - confidence == "high"
  - the `find` string occurs exactly once in the body file

Everything else is reported in the triage list for manual review.

Usage:
  python pipeline/audits/apply_audit_fixes.py                # dry run
  python pipeline/audits/apply_audit_fixes.py --apply        # write to bodies
  python pipeline/audits/apply_audit_fixes.py --severities high
  python pipeline/audits/apply_audit_fixes.py --limit 20     # smoke test
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import anthropic
from dotenv import load_dotenv
from pydantic import BaseModel, Field

REPO = Path(__file__).resolve().parents[2]
AUDIT_PATH = REPO / "notes" / "audits" / "llm-audit.json"
# After the workshop-as-source inversion the canonical bodies live as
# data/issues/{N}/archive.md (front matter + body). The audit tool still
# works on a snapshot of the notes/audits/llm-audit.json findings; the
# bodies dir got repointed but the per-file shape is different now
# (front matter precedes the body), so a re-run will need a small
# parser tweak before it can apply find/replace fixes against the new
# canonical files. Left in place as a re-runnable starting point.
BODIES_DIR = REPO / "data" / "issues"
TMP = REPO / "tmp"

# Haiku 5.5 (2026-10-08): it thinks by default (thinking counts against
# max_tokens), takes an effort level, and takes no temperature. Prices are
# the up-to-100K-token tier; longer prompts cost five times as much.
HAIKU = "claude-haiku-5-5"
HAIKU_EFFORT = "low"
HAIKU_MAX_TOKENS = 4000
HAIKU_INPUT = 0.10  # $/Mt
HAIKU_OUTPUT = 0.50
HAIKU_CACHE_READ = 0.01
HAIKU_CACHE_WRITE = 0.125

sys.stdout.reconfigure(line_buffering=True)
load_dotenv(REPO / ".env")


class Fix(BaseModel):
    action: str = Field(description="One of: replace, delete, skip, manual.")
    find: str = Field(
        description="Exact verbatim string to find in the body. Empty if action is skip/manual."
    )
    replace: str = Field(description="Exact replacement string. Empty for delete/skip/manual.")
    confidence: str = Field(description="One of: high, medium, low.")
    reason: str = Field(description="Brief one-sentence justification.")


SYSTEM_PROMPT = """You convert audit findings into mechanical text fixes.

Input: a finding with category, severity, the exact snippet from the source, an explanation, and a suggested fix written for a human.

Output: a structured Fix with one of these actions:

- "replace": find/replace can be done mechanically with high certainty. `find` must be a verbatim substring of the snippet (or the snippet itself), and `replace` is the corrected text. Use when the suggested fix is unambiguous like 'Change "X" to "Y"' or 'Replace "X" with "Y"'.

- "delete": the snippet (or part of it) should be removed entirely. `find` is the exact substring to delete; `replace` is the empty string.

- "skip": the finding doesn't need a body change (e.g. the suggestion is "verify against source", "consider whether to keep", or it's a quoted error from a third-party article that should be preserved as-is).

- "manual": the fix needs human judgment, URL lookup, or content rewriting that can't be done mechanically (e.g. "restore the missing URL", "rewrite this paragraph for clarity", anything requiring external information).

Confidence:
- "high": you're certain the find/replace is correct AND the find string is specific enough to occur exactly once.
- "medium": you're confident the fix is right but the find string might be ambiguous.
- "low": you're guessing.

Critical rules:
- The `find` string must be a literal substring that exists in the snippet provided. Do not paraphrase.
- If the suggested fix says "Change X to Y" with quoted strings, use exactly those quoted strings.
- If the snippet contains a quotation from a third-party article (e.g. "as quoted from"), prefer skip — we don't edit other people's prose.
- For migration artifacts like leftover Liquid template tags, MailChimp template tokens, or Buttondown template variables, action=delete is usually right.
- For typos that exist in user-quoted content from external articles, action=skip.
- If the suggested fix mentions URL restoration, image re-hosting, link recovery, or any external lookup, action=manual.
- If you cannot construct a fix with high confidence, use action=skip or action=manual rather than guessing.
- Preserve original whitespace, capitalization, and punctuation exactly in `find` and `replace`.
"""


def build_user_message(issue: int, finding: dict) -> str:
    return (
        f"Issue #{issue}.\n"
        f"Category: {finding['category']}\n"
        f"Severity: {finding['severity']}\n"
        f"Snippet (verbatim from body):\n  {finding['exact_snippet']}\n"
        f"Why: {finding['why']}\n"
        f"Suggested fix: {finding['suggested_fix']}\n\n"
        "Convert this into a structured Fix."
    )


def extract_fix(client: anthropic.Anthropic, issue: int, finding: dict) -> tuple[Fix | None, dict]:
    user = build_user_message(issue, finding)
    t0 = time.monotonic()
    try:
        resp = client.messages.parse(
            model=HAIKU,
            max_tokens=HAIKU_MAX_TOKENS,
            output_config={"effort": HAIKU_EFFORT},
            system=[
                {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}
            ],
            messages=[{"role": "user", "content": user}],
            output_format=Fix,
        )
    except Exception as exc:  # noqa: BLE001
        return None, {"error": f"{exc.__class__.__name__}: {exc}"}
    if resp.stop_reason == "refusal" or resp.parsed_output is None:
        return None, {"error": f"no structured fix (stop_reason {resp.stop_reason})"}
    duration = round(time.monotonic() - t0, 2)
    fresh = (
        resp.usage.input_tokens
        - (getattr(resp.usage, "cache_read_input_tokens", 0) or 0)
        - (getattr(resp.usage, "cache_creation_input_tokens", 0) or 0)
    )
    cost = (
        fresh * HAIKU_INPUT
        + resp.usage.output_tokens * HAIKU_OUTPUT
        + (getattr(resp.usage, "cache_read_input_tokens", 0) or 0) * HAIKU_CACHE_READ
        + (getattr(resp.usage, "cache_creation_input_tokens", 0) or 0) * HAIKU_CACHE_WRITE
    ) / 1_000_000
    return resp.parsed_output, {"duration_s": duration, "cost_usd": round(cost, 6)}


def select_findings(audit: dict, severities: set[str], limit: int | None) -> list[tuple[int, dict]]:
    out: list[tuple[int, dict]] = []
    for entry in audit["results"]:
        for f in entry["findings"]:
            if f["severity"] not in severities:
                continue
            out.append((entry["number"], f))
    if limit:
        out = out[:limit]
    return out


_QUOTE_NORMALIZATIONS = (("’", "'"), ("‘", "'"), ("“", '"'), ("”", '"'))


def _normalize_quotes(s: str) -> str:
    for src, dst in _QUOTE_NORMALIZATIONS:
        s = s.replace(src, dst)
    return s


def find_in_body(body: str, find: str) -> tuple[int, int] | None:
    """Locate `find` in `body`. Returns (start, end) or None.

    First tries exact match. If that fails, tries quote-normalized match
    (curly ↔ straight apostrophes/quotes are common between archive
    snippets and raw bodies). The returned indices are into the original
    body so the substitution preserves surrounding text exactly."""
    pos = body.find(find)
    if pos != -1:
        if body.count(find) > 1:
            return None
        return (pos, pos + len(find))
    norm_body = _normalize_quotes(body)
    norm_find = _normalize_quotes(find)
    if norm_find != find or norm_body != body:
        if norm_body.count(norm_find) == 1:
            pos = norm_body.find(norm_find)
            return (pos, pos + len(norm_find))
    return None


def apply_fixes(decisions: list[dict], apply: bool) -> dict:
    """Apply structured fixes to body files. Returns stats + per-issue diffs."""
    stats = {
        "auto_applied": 0,
        "skipped_not_unique": 0,
        "skipped_not_found": 0,
        "skipped_low_confidence": 0,
        "skipped_action": 0,
        "manual_required": 0,
    }
    by_issue: dict[int, dict] = {}
    for d in decisions:
        if not d.get("fix"):
            stats["skipped_action"] += 1
            continue
        fix = d["fix"]
        issue = d["issue"]
        if fix["action"] == "skip":
            stats["skipped_action"] += 1
            continue
        if fix["action"] == "manual":
            stats["manual_required"] += 1
            by_issue.setdefault(issue, {"manual": [], "applied": [], "rejected": []})[
                "manual"
            ].append(d)
            continue
        if fix["confidence"] != "high":
            stats["skipped_low_confidence"] += 1
            by_issue.setdefault(issue, {"manual": [], "applied": [], "rejected": []})[
                "rejected"
            ].append({**d, "reject_reason": "low_confidence"})
            continue
        if fix["action"] not in {"replace", "delete"}:
            stats["skipped_action"] += 1
            continue
        body_path = BODIES_DIR / f"{issue}.md"
        if not body_path.exists():
            stats["skipped_not_found"] += 1
            continue
        body = body_path.read_text(encoding="utf-8")
        find = fix["find"]
        if not find:
            stats["skipped_action"] += 1
            continue
        # Check uniqueness before locating, so we don't silently replace one of many.
        if body.count(find) > 1 or _normalize_quotes(body).count(_normalize_quotes(find)) > 1:
            stats["skipped_not_unique"] += 1
            by_issue.setdefault(issue, {"manual": [], "applied": [], "rejected": []})[
                "rejected"
            ].append({**d, "reject_reason": "not_unique"})
            continue
        position = find_in_body(body, find)
        if position is None:
            stats["skipped_not_found"] += 1
            by_issue.setdefault(issue, {"manual": [], "applied": [], "rejected": []})[
                "rejected"
            ].append({**d, "reject_reason": "not_found"})
            continue
        start, end = position
        replacement = "" if fix["action"] == "delete" else fix["replace"]
        new_body = body[:start] + replacement + body[end:]
        if apply:
            body_path.write_text(new_body, encoding="utf-8")
        stats["auto_applied"] += 1
        by_issue.setdefault(issue, {"manual": [], "applied": [], "rejected": []})["applied"].append(
            d
        )
    return {"stats": stats, "by_issue": by_issue}


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply LLM audit findings to Buttondown bodies")
    parser.add_argument(
        "--apply", action="store_true", help="Actually write changes (default: dry run)"
    )
    parser.add_argument(
        "--severities",
        default="high,medium",
        help="Comma-separated severities (default: high,medium)",
    )
    parser.add_argument("--limit", type=int, help="Cap how many findings are processed")
    parser.add_argument("--workers", type=int, default=8, help="Parallel Haiku calls (default 8)")
    parser.add_argument(
        "--cache",
        default=str(TMP / "audit-fix-extractions.json"),
        help="Cache extracted fixes here",
    )
    parser.add_argument(
        "--reuse-cache",
        action="store_true",
        help="Use cached extractions instead of re-calling Haiku",
    )
    args = parser.parse_args()

    if not os.environ.get("ANTHROPIC_GENERAL_API_KEY"):
        print("ANTHROPIC_GENERAL_API_KEY missing", file=sys.stderr)
        sys.exit(2)

    audit = json.loads(AUDIT_PATH.read_text())
    severities = set(s.strip() for s in args.severities.split(","))
    findings = select_findings(audit, severities, args.limit)
    print(f"Selected {len(findings)} finding(s) at severities {sorted(severities)}")

    cache_path = Path(args.cache)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cached: dict[str, dict] = {}
    if args.reuse_cache and cache_path.exists():
        cached = json.loads(cache_path.read_text())
        print(f"Loaded {len(cached)} cached extractions from {cache_path.relative_to(REPO)}")

    decisions: list[dict] = []
    total_cost = 0.0
    needs_extraction = []
    for issue, finding in findings:
        key = f"{issue}:{finding['exact_snippet'][:80]}:{finding['suggested_fix'][:80]}"
        if key in cached:
            decisions.append(
                {
                    "issue": issue,
                    "finding": finding,
                    "fix": cached[key]["fix"],
                    "usage": cached[key].get("usage"),
                }
            )
        else:
            needs_extraction.append((issue, finding, key))

    if needs_extraction:
        print(f"Extracting {len(needs_extraction)} fix(es) via Haiku ({args.workers} workers)...")
        client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_GENERAL_API_KEY"])
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {
                pool.submit(extract_fix, client, issue, finding): (issue, finding, key)
                for (issue, finding, key) in needs_extraction
            }
            done = 0
            for fut in as_completed(futures):
                issue, finding, key = futures[fut]
                fix, usage = fut.result()
                total_cost += usage.get("cost_usd", 0) if usage else 0
                fix_dict = fix.model_dump() if fix else None
                decisions.append(
                    {"issue": issue, "finding": finding, "fix": fix_dict, "usage": usage}
                )
                cached[key] = {"fix": fix_dict, "usage": usage}
                done += 1
                if done % 50 == 0:
                    print(f"  {done}/{len(needs_extraction)} (~${total_cost:.4f} so far)")
        cache_path.write_text(json.dumps(cached, indent=2, ensure_ascii=False))
        print(f"Wrote extractions to {cache_path.relative_to(REPO)} (~${total_cost:.4f})")

    # Tally action counts
    action_counts: dict[str, int] = {}
    confidence_counts: dict[str, int] = {}
    for d in decisions:
        if d.get("fix"):
            action_counts[d["fix"]["action"]] = action_counts.get(d["fix"]["action"], 0) + 1
            confidence_counts[d["fix"]["confidence"]] = (
                confidence_counts.get(d["fix"]["confidence"], 0) + 1
            )
    print("\nAction distribution:")
    for k, v in sorted(action_counts.items(), key=lambda x: -x[1]):
        print(f"  {v:4d}  {k}")
    print("\nConfidence distribution:")
    for k, v in sorted(confidence_counts.items(), key=lambda x: -x[1]):
        print(f"  {v:4d}  {k}")

    result = apply_fixes(decisions, apply=args.apply)
    stats = result["stats"]
    print("\nApply stats:")
    for k, v in stats.items():
        print(f"  {v:4d}  {k}")

    # Write triage report
    report_path = TMP / ("audit-fixes-applied.md" if args.apply else "audit-fixes-dry-run.md")
    lines = [
        f"# Audit fix {'application' if args.apply else 'dry run'}",
        "",
        f"- Severities: {sorted(severities)}",
        f"- Findings considered: {len(findings)}",
        f"- Auto-applied: {stats['auto_applied']}",
        f"- Manual required: {stats['manual_required']}",
        f"- Skipped (low confidence): {stats['skipped_low_confidence']}",
        f"- Skipped (snippet not found in body): {stats['skipped_not_found']}",
        f"- Skipped (snippet not unique in body): {stats['skipped_not_unique']}",
        f"- Skipped (action=skip): {stats['skipped_action']}",
        "",
        "## Auto-applied fixes",
        "",
    ]
    for issue in sorted(result["by_issue"].keys()):
        bucket = result["by_issue"][issue]
        if bucket["applied"]:
            lines.append(f"### #{issue}")
            for d in bucket["applied"]:
                f = d["fix"]
                lines.append(
                    f"- **{d['finding']['category']}/{d['finding']['severity']}** — `{f['find'][:120]}` → `{f['replace'][:120]}`  "
                )
                lines.append(f"  Reason: {f['reason']}")
            lines.append("")
    lines.extend(["", "## Manual review required", ""])
    for issue in sorted(result["by_issue"].keys()):
        bucket = result["by_issue"][issue]
        if bucket["manual"]:
            lines.append(f"### #{issue}")
            for d in bucket["manual"]:
                lines.append(
                    f"- **{d['finding']['category']}/{d['finding']['severity']}** — {d['finding']['why']}"
                )
                lines.append(f"  Snippet: `{d['finding']['exact_snippet'][:120]}`")
                lines.append(f"  Suggested: {d['finding']['suggested_fix']}")
            lines.append("")
    lines.extend(["", "## Rejected (low confidence / not found / not unique)", ""])
    for issue in sorted(result["by_issue"].keys()):
        bucket = result["by_issue"][issue]
        if bucket["rejected"]:
            lines.append(f"### #{issue}")
            for d in bucket["rejected"]:
                f = d["fix"]
                reason = d.get("reject_reason", "?")
                lines.append(
                    f"- **{reason}** ({d['finding']['category']}) — `{f['find'][:100]}` → `{f['replace'][:100]}`  "
                )
                lines.append(f"  Confidence: {f['confidence']}; reason: {f['reason']}")
            lines.append("")
    report_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nReport: {report_path.relative_to(REPO)}")
    if args.apply:
        print("Body files updated. Run `git diff data/issues/` to review.")
    else:
        print("Dry run — no body files were modified. Re-run with --apply to write.")


if __name__ == "__main__":
    main()
