"""Capture metadata-only evidence of what the native backend serves.

Only HEADs and public /health are read. No artifact body, runtime
configuration, unpublished document or secret is read.
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

KEYS = (
    "artifacts/corpus.json",
    "artifacts/blog_corpus.json",
    "artifacts/podcast_corpus.json",
    "artifacts/links_corpus.json",
)


def serving_snapshot(health, heads, checked_at):
    if not isinstance(health, dict):
        health = {"ok": False}
    versions = health.get("corpus_versions") if isinstance(health, dict) else None
    if health.get("ok") is not True or not isinstance(versions, dict):
        return {"version": 1, "ok": False, "checked_at": checked_at, "artifacts": {}}
    artifacts = {}
    for key in KEYS:
        head = heads.get(key)
        if not head or not head.get("VersionId") or versions.get(key) != head["VersionId"]:
            continue
        metadata = head.get("Metadata", {})
        artifacts[key] = {
            "version_id": head["VersionId"],
            "id": metadata.get("newest-id"),
            "at": metadata.get("newest-at"),
            "url": metadata.get("newest-url"),
        }
    return {
        "version": 1,
        "ok": True,
        "checked_at": checked_at,
        "source_revision": health.get("source_revision"),
        "corpus_versions": {key: versions[key] for key in KEYS if key in versions},
        "artifacts": artifacts,
    }


def capture(client, get, checked_at=None):
    try:
        response = get("https://librarian.thingelstad.com/health", timeout=5)
        health = response.json() if response.ok else {"ok": False}
    except Exception:
        health = {"ok": False}
    heads = {}
    for key in KEYS:
        try:
            heads[key] = client.head_object(Bucket="weekly-thing-librarian", Key=key)
        except Exception:
            pass
    verified_at = checked_at or datetime.now(UTC).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )
    return serving_snapshot(health, heads, verified_at)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    import boto3
    import requests

    result = capture(
        boto3.client("s3", region_name="us-east-1"),
        requests.get,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, sort_keys=True) + "\n")
    args.output.chmod(0o600)
    print(f"Sync serving evidence: {len(result['artifacts'])} verified artifact identities.")


if __name__ == "__main__":
    main()
