"""The corpus gate's ingest checks (QA 2026-10-01 round 3).

Each check pins a fix in the corpus build, so a later change that undoes it
fails the deploy's corpus gate instead of shipping silently.
"""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from librarian_core.paths import REPO


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gate = _load("test_ingest_gate_module", REPO / "pipeline" / "corpus" / "corpus_gate.py")


class ThingyGateTest(unittest.TestCase):
    def test_clean_corpus_passes(self):
        self.assertEqual(gate.ingest_failures({"chunks": [{"text": "Jamie."}]}, None), [])

    def test_thingy_frame_fails(self):
        corpus = {"chunks": [{"text": '<div class="from-thingy">Thingy.</div>'}]}
        [failure] = gate.ingest_failures(corpus, None)
        self.assertIn("from-thingy", failure)


class GateCommandTest(unittest.TestCase):
    def test_blog_only_candidate_is_checked(self):
        # An empty blog candidate holds none of the real posts' code or
        # embeds, so the blog checks fail it even with no WT candidate.
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp)
            (stage / "blog_corpus.json").write_text(json.dumps({"posts": [], "media": []}))
            argv = ["gate", "--candidate", str(stage), "--site-archive", str(stage / "none")]
            self.assertEqual(gate.main(argv), 1)


if __name__ == "__main__":
    unittest.main()
