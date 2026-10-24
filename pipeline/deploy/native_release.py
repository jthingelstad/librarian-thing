"""Immutable native packages and deliberate CloudFormation promotion.

The Node owner handles Web Function APIs (not yet present in this locked
botocore). This module only uses existing CloudFormation and S3 clients.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path


def run_owner(action: str, outputs: dict[str, str], root: Path) -> dict[str, str]:
    path = root / "tmp" / "native-outputs.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(outputs))
    path.chmod(0o600)
    value = subprocess.check_output(
        ["node", str(root / "apps/librarian/lambda/scripts/native-release.mjs"), action, str(path)],
        text=True,
    )
    return json.loads(value) if value.strip() else {}


def prepare(s3, outputs, pins, build_dir: Path, root: Path, zip_build) -> list[dict]:
    source_bucket = outputs["NativeSourceBucketName"]
    settings = {"NativeWebEnabled": "true", **pins}
    hashes = []
    for door in ("Auth", "Archive"):
        # The same checked modules and prompts as the Event bundle, plus a
        # conventional root entry file. No handler adapter or runtime loader.
        entry = build_dir / "index.js"
        entry.write_text(f"import './web/{door.lower()}.mjs';\n")
        archive = root / "tmp" / f"native-{door.lower()}.zip"
        zip_build(build_dir, archive)
        entry.unlink()
        data = archive.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        hashes.append(digest)
        key = f"native/{door.lower()}/{digest}.zip"
        uploaded = s3.put_object(
            Bucket=source_bucket, Key=key, Body=data, ContentType="application/zip"
        )
        settings[f"Native{door}CodeKey"] = key
        settings[f"Native{door}CodeVersion"] = uploaded["VersionId"]
    # Corpus-only updates must publish a new configuration too, so warm
    # environments can't retain a previous corpus indefinitely.
    for key in (
        "corpus.json",
        "blog_corpus.json",
        "podcast_corpus.json",
        "reference_corpus.json",
        "graph.json",
    ):
        hashes.append(
            s3.head_object(Bucket="weekly-thing-librarian", Key=f"artifacts/{key}")["VersionId"]
        )
    settings["NativeBuildId"] = hashlib.sha256("\n".join(hashes).encode()).hexdigest()
    return [{"ParameterKey": key, "ParameterValue": value} for key, value in settings.items()]


def promotion(outputs, previous) -> list[dict]:
    values = {}
    for door in ("Auth", "Archive"):
        candidate = outputs[f"Native{door}CandidateRevision"]
        values[f"Native{door}LiveRevision"] = candidate
        values[f"Native{door}RollbackRevision"] = previous.get(
            f"Native{door}LiveRevision", candidate
        )
    return [{"ParameterKey": key, "ParameterValue": value} for key, value in values.items()]
