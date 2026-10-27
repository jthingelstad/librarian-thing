import json

from pipeline.deploy.sync_snapshot import capture, serving_snapshot


def test_only_matching_served_versions_and_public_metadata_are_captured():
    key = "artifacts/corpus.json"
    health = {
        "ok": True,
        "source_revision": "fixture-revision",
        "corpus_versions": {key: "v1"},
        "private_canary": "never-copy",
    }
    head = {
        "VersionId": "v1",
        "Metadata": {
            "newest-id": "wt-355",
            "newest-at": "2026-10-31",
            "private_canary": "never-copy",
        },
    }
    result = serving_snapshot(health, {key: head}, "2026-10-28T02:41:01Z")
    assert result["artifacts"][key]["id"] == "wt-355"
    assert "never-copy" not in json.dumps(result)
    assert (
        serving_snapshot(health, {key: {**head, "VersionId": "v2"}}, result["checked_at"])[
            "artifacts"
        ]
        == {}
    )
    assert serving_snapshot({"ok": False}, {key: head}, result["checked_at"])["ok"] is False


def test_capture_performs_only_heads_and_public_health_and_failures_are_unknown():
    class Client:
        def __init__(self):
            self.reads = []

        def head_object(self, **kwargs):
            self.reads.append(kwargs)
            raise RuntimeError("private-error")

    client = Client()

    def failed_get(url, **kwargs):
        assert url == "https://librarian.thingelstad.com/health"
        raise RuntimeError("private-error")

    result = capture(client, failed_get, "2026-10-28T02:41:01Z")
    assert result["ok"] is False
    assert len(client.reads) == 4
    assert "private-error" not in json.dumps(result)
