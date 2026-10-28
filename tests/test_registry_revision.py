"""Public-only snapshot evidence, derived from the bytes actually uploaded."""

import json
import sqlite3
import subprocess
from pathlib import Path
from unittest.mock import Mock

import pytest
import yaml
from librarian_core.library import connect, store
from librarian_core.library.registry import ALGORITHM, normalized, revision

from tests.test_things import import_things

ROOT = Path(__file__).resolve().parents[1]
VECTORS = json.loads((ROOT / "tests/fixtures/registry-revisions.json").read_text())["vectors"]


@pytest.mark.parametrize("vector", VECTORS, ids=lambda v: v["name"])
def test_cross_language_vectors_and_actual_import_normalization(vector):
    assert revision(vector["payload"]) == vector["revision"]
    assert normalized(vector["payload"]) == import_things.normalize(vector["payload"])
    assert revision(import_things.normalize(vector["payload"])) == vector["revision"]


def put_registry(conn, payload, origin="xyz"):
    conn.execute(
        "INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?)",
        (
            "things/things.json",
            origin,
            json.dumps(payload),
            "not-a-revision",
            "2026-01-01T00:00:00Z",
        ),
    )
    conn.commit()


def test_uploaded_wal_snapshot_and_metadata_remain_one_copy_during_local_edit(tmp_path):
    src = tmp_path / "library.db"
    conn = connect(src, create=True)
    conn.execute("PRAGMA journal_mode=WAL")
    put_registry(conn, VECTORS[0]["payload"])
    conn.execute(
        "INSERT INTO files VALUES (?, ?, ?, ?, ?)",
        ("reference-unpublished/private.md", "private", "PRIVATE-CANARY", "private-hash", "old"),
    )
    conn.commit()
    client = Mock()

    def upload(**kwargs):
        # A writer changes the original after the snapshot/metadata is prepared.
        put_registry(conn, VECTORS[3]["payload"])
        body = kwargs.pop("Body").read()
        captured = tmp_path / "captured.db"
        captured.write_bytes(body)
        with sqlite3.connect(captured) as actual:
            payload = json.loads(
                actual.execute(
                    "SELECT content FROM files WHERE path='things/things.json'"
                ).fetchone()[0]
            )
        assert kwargs["IfMatch"] == '"old"'
        assert revision(payload) == VECTORS[0]["revision"]
        assert kwargs["Metadata"] == {
            "things-revision-algorithm": ALGORITHM,
            "things-revision": VECTORS[0]["revision"],
        }
        assert "PRIVATE" not in json.dumps(kwargs["Metadata"])
        return {"ETag": '"new"'}

    client.put_object.side_effect = upload
    try:
        assert store.upload(src, '"old"', client=client) == '"new"'
        current = json.loads(
            conn.execute("SELECT content FROM files WHERE origin='xyz'").fetchone()[0]
        )
        assert revision(current) == VECTORS[3]["revision"]
    finally:
        conn.close()


def test_wrong_origin_and_invalid_registry_never_publish_a_private_digest(tmp_path):
    src = tmp_path / "library.db"
    conn = connect(src, create=True)
    client = Mock()
    client.put_object.return_value = {"ETag": '"new"'}
    put_registry(conn, {"private": "PRIVATE-CANARY"}, origin="reference-unpublished")
    store.upload(src, None, client=client)
    assert client.put_object.call_args.kwargs["Metadata"] == {}
    put_registry(conn, {"private": "PRIVATE-CANARY"})
    with pytest.warns(
        UserWarning, match="^Public registry revision unavailable for this snapshot.$"
    ):
        store.upload(src, None, client=client)
    assert client.put_object.call_args.kwargs["Metadata"] == {}
    conn.close()


@pytest.mark.parametrize("number", [1.5, 9007199254740992, float("nan"), float("inf")])
def test_unsupported_numbers_cannot_be_miscompared(number):
    payload = json.loads(json.dumps(VECTORS[0]["payload"]))
    payload["things"][0]["number"] = number
    with pytest.raises((ValueError, OverflowError)):
        revision(payload)


def test_telemetry_change_does_not_force_paid_corpus_builds():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy.yml").read_text())
    scripts = [s.get("run", "") for s in workflow["jobs"]["produce"]["steps"]]
    script = next(s for s in scripts if "has_change()" in s)
    # Run the actual classification, before it writes GITHUB_OUTPUT or builds.
    classifier = script[script.index("# Upload telemetry") : script.index("if has_change")]
    for path, expected in (
        ("librarian-core/librarian_core/library/store.py", "no"),
        ("librarian-core/librarian_core/library/registry.py", "no"),
        ("librarian-core/librarian_core/corpus.py", "yes"),
        ("librarian-core/librarian_core/library/tree.py", "yes"),
        ("librarian-core/librarian_core/library/store.py\nlibrarian-core/new.py", "yes"),
    ):
        command = classifier + '\nif has_change "^librarian-core/"; then echo yes; else echo no; fi'
        result = subprocess.run(
            ["bash", "-c", command],
            env={"changed": path},
            capture_output=True,
            text=True,
            check=True,
        )
        assert result.stdout.strip() == expected
