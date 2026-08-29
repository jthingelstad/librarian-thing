#!/usr/bin/env python3
"""Report the current state of the Librarian archive and its artifacts.

The canonical Weekly Thing source is ``data/issues/{number}/archive.md``.
This report checks that store, the checked-in corpus/graph build artifacts, and
(when credentials are available) the deployed S3 artifacts. It intentionally
does not inspect the retired Studio audio and site-publishing pipeline.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ISSUES_ROOT = REPO / "data" / "issues"
ARTIFACTS_ROOT = REPO / "data" / "librarian"
LIBRARIAN_BUCKET = os.environ.get("LIBRARIAN_BUCKET", "weekly-thing-librarian")
LIBRARIAN_CORPUS_KEY = os.environ.get("LIBRARIAN_CORPUS_KEY", "artifacts/corpus.json")
LIBRARIAN_GRAPH_KEY = os.environ.get("LIBRARIAN_GRAPH_KEY", "artifacts/graph.json")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_frontmatter(path: Path) -> dict[str, str]:
    """Read the simple top-level YAML fields needed for archive reporting."""
    raw = path.read_text(encoding="utf-8")
    if not raw.startswith("---\n"):
        return {}
    end = raw.find("\n---\n", 4)
    if end == -1:
        return {}
    fields: dict[str, str] = {}
    for line in raw[4:end].splitlines():
        key, separator, value = line.partition(":")
        if separator and key and not key.startswith(("-", " ")):
            fields[key.strip()] = value.strip().strip("'\"")
    return fields


def collect_issues() -> list[dict]:
    """Return one state row for every canonical issue directory.

    Most issue directories are numeric, but the corpus also intentionally
    includes special archive items such as ``140-special``.
    """
    rows: list[dict] = []
    issue_dirs = sorted(
        (
            path
            for path in ISSUES_ROOT.iterdir()
            if path.is_dir() and (path.name.isdigit() or (path / "archive.md").exists())
        ),
        key=lambda path: (int(path.name.split("-", 1)[0]), path.name),
    )
    for issue_dir in issue_dirs:
        archive_path = issue_dir / "archive.md"
        metadata_path = issue_dir / "metadata.json"
        frontmatter = load_frontmatter(archive_path) if archive_path.exists() else {}
        rows.append(
            {
                "number": issue_dir.name,
                "subject": frontmatter.get("subject", ""),
                "publish_date": frontmatter.get("publish_date", ""),
                "archive": {"exists": archive_path.exists()},
                "metadata": {"exists": metadata_path.exists()},
            }
        )
    return rows


def s3_object_metadata(bucket: str, key: str) -> dict | None:
    """Return safe deployed-artifact metadata, or None when it is unavailable."""
    try:
        import boto3
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError:
        return None
    try:
        client = boto3.client("s3")
        head = client.head_object(Bucket=bucket, Key=key)
    except BotoCoreError, ClientError:
        return None
    metadata = {
        "size": head.get("ContentLength"),
        "last_modified": head.get("LastModified").isoformat().replace("+00:00", "Z")
        if head.get("LastModified")
        else None,
        "etag": head.get("ETag", "").strip('"'),
    }
    if key.endswith("corpus.json"):
        try:
            prefix = client.get_object(Bucket=bucket, Key=key, Range="bytes=0-2047")["Body"].read()
            text = prefix.decode("utf-8", errors="ignore")
            for field in ("embedding_model", "embedding_dimensions", "issue_count", "chunk_count"):
                match = re.search(rf'"{field}"\s*:\s*("?)([^,"\n}}]+)\1', text)
                if match:
                    value = match.group(2)
                    metadata[field] = int(value) if value.isdigit() else value
        except BotoCoreError, ClientError, UnicodeDecodeError:
            pass
    return metadata


def deployed_artifacts() -> dict:
    return {
        "corpus": s3_object_metadata(LIBRARIAN_BUCKET, LIBRARIAN_CORPUS_KEY)
        or {"unavailable": True},
        "graph": s3_object_metadata(LIBRARIAN_BUCKET, LIBRARIAN_GRAPH_KEY) or {"unavailable": True},
    }


def local_artifact_summary(name: str) -> dict:
    """Read the inexpensive top-level evidence from a checked-in artifact."""
    path = ARTIFACTS_ROOT / name
    if not path.exists():
        return {"missing": True}
    artifact = json.loads(path.read_text(encoding="utf-8"))
    summary = {
        key: artifact[key]
        for key in ("version", "generated_at", "issue_count", "chunk_count")
        if key in artifact
    }
    if name == "corpus.json":
        summary.update(
            media_count=len(artifact.get("media", [])),
            currently_count=len(artifact.get("currently", [])),
            journal_post_url_count=sum(
                len(chunk.get("journal_post_urls", [])) for chunk in artifact.get("chunks", [])
            ),
        )
    return summary


def build_report() -> dict:
    issues = collect_issues()
    deployed = deployed_artifacts()
    archive_paths = [ISSUES_ROOT / row["number"] / "archive.md" for row in issues]
    latest_archive_mtime = max(
        (path.stat().st_mtime for path in archive_paths if path.exists()), default=None
    )
    latest_archive_modified_at = (
        datetime.fromtimestamp(latest_archive_mtime, tz=timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
        if latest_archive_mtime is not None
        else None
    )
    deployed_corpus_at = deployed["corpus"].get("last_modified")
    likely_stale = None
    if latest_archive_modified_at and deployed_corpus_at:
        likely_stale = latest_archive_modified_at > deployed_corpus_at
    local_corpus = local_artifact_summary("corpus.json")
    return {
        "generated_at": now_iso(),
        "summary": {
            "total_issues": len(issues),
            "archive_missing": sum(not row["archive"]["exists"] for row in issues),
            "metadata_missing": sum(not row["metadata"]["exists"] for row in issues),
            "local_corpus_issue_count": local_corpus.get("issue_count"),
            "local_corpus_matches_archive": local_corpus.get("issue_count") == len(issues),
            "deployed_corpus_uploaded_at": deployed_corpus_at,
            "latest_archive_modified_at": latest_archive_modified_at,
            "librarian_likely_stale": likely_stale,
        },
        "local_artifacts": {
            "corpus": local_corpus,
            "graph": local_artifact_summary("graph.json"),
        },
        "deployed": deployed,
        "issues": issues,
    }


def print_table(report: dict) -> None:
    summary = report["summary"]
    state = "STALE" if summary["librarian_likely_stale"] else "ok"
    if summary["librarian_likely_stale"] is None:
        state = "?"
    print(f"Archive status — generated {report['generated_at']}")
    print(
        f"  issues: {summary['total_issues']}  archive missing: {summary['archive_missing']}"
        f"  metadata missing: {summary['metadata_missing']}  deployed corpus: {state}"
    )
    corpus = report["local_artifacts"]["corpus"]
    if not corpus.get("missing"):
        print(
            f"  corpus: {corpus.get('issue_count')} issues, {corpus.get('chunk_count')} chunks,"
            f" {corpus.get('media_count')} media, {corpus.get('currently_count')} Currently entries,"
            f" {corpus.get('journal_post_url_count')} journal URLs"
        )
    if summary["deployed_corpus_uploaded_at"]:
        print(
            f"  deployed corpus: {summary['deployed_corpus_uploaded_at']}  latest archive change:"
            f" {summary['latest_archive_modified_at']}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", help="Write JSON report to this path instead of the table.")
    args = parser.parse_args()
    report = build_report()
    if args.json:
        output = Path(args.json)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"Wrote archive status report to {output}")
    else:
        print_table(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
