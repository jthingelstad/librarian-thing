"""Things I've built: the registry snapshot import and its corpus chunks."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from librarian_core import corpus
from librarian_core.paths import THINGS_PATH

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "pipeline" / "things" / "import_things.py"
spec = importlib.util.spec_from_file_location("pipeline_things_import", SCRIPT)
import_things = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(import_things)


def _registry() -> dict:
    return {
        "site": "https://thingelstad.xyz",
        "generated": "2026-10-17T20:00:00.000Z",
        "things": [
            {
                "id": "weekly-thing",
                "title": "Weekly Thing",
                "summary": "A weekly collection of links and ideas.",
                "collection": "Publishing",
                "status": "active",
                "url": "https://weekly.thingelstad.com/",
                "started": "2017-05-13",
                "page": "https://thingelstad.xyz/things/weekly-thing/",
                "topics": ["open-web"],
                "sources": [
                    {
                        "kind": "github",
                        "repository": "jthingelstad/weekly.thingelstad.com",
                        "role": "implementation",
                        "observation": {
                            "kind": "github",
                            "description": "Public website and archive.",
                            "archived": False,
                            "release": None,
                            "activity": [{"latestCommit": {"date": "2026-10-16T11:40:33.000Z"}}],
                        },
                    }
                ],
                "connections": [],
                "body": "The newsletter that started it all.",
                "latest": {"date": "2026-10-16", "label": "Latest commit", "url": "x"},
            },
            {
                "id": "librarian",
                "title": "Librarian",
                "summary": "Retrieval over the archive.",
                "collection": "Developer tools and systems",
                "status": "retired",
                "page": "https://thingelstad.xyz/things/librarian/",
                "ended": "2030-01-01",
                "topics": [],
                "sources": [],
                "connections": [
                    {
                        "to": "weekly-thing",
                        "label": "indexes",
                        "detail": "Builds a searchable corpus",
                    }
                ],
                "body": "",
                "latest": None,
            },
        ],
        "topics": [{"id": "open-web", "title": "The open web", "things": ["weekly-thing"]}],
        "history": [
            {
                "id": "weekly-thing-first",
                "date": "2017-05-13",
                "kind": "launch",
                "title": "The first Weekly Thing",
                "summary": "A newsletter experiment begins",
                "source": "https://weekly.thingelstad.com/archive/1/",
                "things": ["weekly-thing"],
            }
        ],
    }


class ImportThingsTest(unittest.TestCase):
    def test_normalize_drops_the_timestamp_and_sorts(self):
        snapshot = import_things.normalize(_registry())
        self.assertNotIn("generated", snapshot)
        self.assertEqual([t["id"] for t in snapshot["things"]], ["librarian", "weekly-thing"])
        self.assertEqual(snapshot["site"], "https://thingelstad.xyz")

    def test_normalize_rejects_a_broken_registry(self):
        for breakage in (
            lambda r: r.pop("history"),
            lambda r: r["things"][0].pop("title"),
            lambda r: r["things"][0].__setitem__("status", "busy"),
            lambda r: r["things"][0].__setitem__("page", "/things/weekly-thing/"),
            lambda r: r["things"].append(dict(r["things"][0])),
        ):
            registry = _registry()
            breakage(registry)
            with self.assertRaises(RuntimeError):
                import_things.normalize(registry)
        with self.assertRaises(RuntimeError):
            import_things.normalize([])

    def test_write_snapshot_is_idempotent(self):
        snapshot = import_things.normalize(_registry())
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "things" / "things.json"
            self.assertTrue(import_things.write_snapshot(snapshot, output))
            self.assertFalse(import_things.write_snapshot(snapshot, output))
            self.assertEqual(json.loads(output.read_text())["things"][1]["id"], "weekly-thing")


class ThingsChunksTest(unittest.TestCase):
    def _chunks(self, registry=None):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "things.json"
            path.write_text(json.dumps(registry or _registry()), encoding="utf-8")
            return corpus._things_chunks(things_path=path)

    def test_one_source_per_thing_plus_the_registry_index(self):
        chunks = self._chunks()
        by_id = {c["id"]: c for c in chunks}
        self.assertEqual(
            sorted(by_id), ["thing:index:0", "thing:librarian:0", "thing:weekly-thing:0"]
        )
        weekly = by_id["thing:weekly-thing:0"]
        self.assertEqual(weekly["source_kind"], "thing")
        self.assertEqual(weekly["content_kind"], "thing")
        self.assertIsNone(weekly["publish_date"])
        self.assertIsNone(weekly["issue_number"])
        self.assertEqual(weekly["url"], "https://thingelstad.xyz/things/weekly-thing/")
        self.assertEqual(weekly["subject"], "Weekly Thing")
        self.assertEqual(weekly["thing_id"], "weekly-thing")
        self.assertEqual(weekly["thing_status"], "active")
        self.assertEqual(weekly["started"], "2017-05-13")
        self.assertEqual(weekly["topics"], [])
        index = by_id["thing:index:0"]
        self.assertEqual(index["url"], "https://thingelstad.xyz/")
        self.assertNotIn("thing_id", index)
        self.assertIn("2 things", index["text"])
        self.assertIn("Active (being built or operated), 1: Weekly Thing.", index["text"])
        self.assertIn("Retired (deliberately ended), 1: Librarian.", index["text"])

    def test_text_states_status_as_decision_and_activity_as_evidence(self):
        weekly = next(c for c in self._chunks() if c["id"] == "thing:weekly-thing:0")
        text = weekly["text"]
        self.assertIn("Status: active (being built or operated).", text)
        self.assertIn("Started 2017-05-13.", text)
        self.assertIn("Latest commit 2026-10-16 (an observation, not a status).", text)
        self.assertIn("Topics: The open web.", text)
        self.assertIn(
            "GitHub repository jthingelstad/weekly.thingelstad.com (implementation)", text
        )
        self.assertIn("latest commit 2026-10-16", text)
        self.assertIn("- 2017-05-13: The first Weekly Thing. A newsletter experiment begins", text)
        self.assertTrue(text.endswith("The newsletter that started it all."))
        # Connections read both ways, from either thing's page.
        self.assertIn("Librarian indexes Weekly Thing: Builds a searchable corpus.", text)
        librarian = next(c for c in self._chunks() if c["id"] == "thing:librarian:0")
        self.assertIn(
            "Librarian indexes Weekly Thing: Builds a searchable corpus.", librarian["text"]
        )
        self.assertIn("Status: retired (deliberately ended).", librarian["text"])
        self.assertIn("Ended 2030-01-01.", librarian["text"])
        self.assertEqual(librarian["ended"], "2030-01-01")

    def test_missing_or_malformed_snapshot_yields_no_chunks(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(corpus._things_chunks(things_path=Path(tmp) / "nope.json"), [])
            broken = Path(tmp) / "broken.json"
            broken.write_text("{not json", encoding="utf-8")
            self.assertEqual(corpus._things_chunks(things_path=broken), [])
            empty = Path(tmp) / "empty.json"
            empty.write_text(json.dumps({"site": "x", "things": []}), encoding="utf-8")
            self.assertEqual(corpus._things_chunks(things_path=empty), [])

    def test_repo_snapshot_grounds_the_weekly_thing_corpus(self):
        # The snapshot is committed (sync workflow refreshes it) so every
        # corpus build ships the registry. Guard against it going missing.
        self.assertTrue(THINGS_PATH.exists(), f"missing {THINGS_PATH} (see data/things/README.md)")
        chunks = corpus._things_chunks(things_path=THINGS_PATH)
        ids = {c["id"].rsplit(":", 1)[0] for c in chunks}
        self.assertIn("thing:index", ids)
        self.assertIn("thing:weekly-thing", ids)
        self.assertIn("thing:librarian", ids)
        for chunk in chunks:
            self.assertTrue(chunk["url"].startswith("https://thingelstad.xyz/"), chunk["id"])
            self.assertIsNone(chunk["publish_date"])


if __name__ == "__main__":
    unittest.main()
