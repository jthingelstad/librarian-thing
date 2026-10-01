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

from librarian_core import corpus as core
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


class RepeatedMediaTest(unittest.TestCase):
    """QA3 M8: the same image twice in one source is one media row."""

    def test_distinct_images_keeps_first_and_its_alt(self):
        images = [
            {"url": "https://a.test/1.gif", "alt": ""},
            {"url": "https://a.test/2.gif", "alt": "two"},
            {"url": "https://a.test/1.gif", "alt": "one"},
        ]
        self.assertEqual(
            core.distinct_images(images),
            [
                {"url": "https://a.test/1.gif", "alt": "one"},
                {"url": "https://a.test/2.gif", "alt": "two"},
            ],
        )

    def test_blog_post_repeating_a_gif_is_one_row(self):
        gif = "https://www.thingelstad.com/uploads/2020/4f09200a62.gif"
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp) / "posts" / "2004" / "11"
            posts.mkdir(parents=True)
            (posts / "2004-11-25-change-game.md").write_text(
                "---\nmicroblog_id: 5\n"
                'url: "https://www.thingelstad.com/2004/11/25/change-game.html"\n'
                'title: "Change game"\npublished: "2004-11-25T12:00:00+00:00"\n'
                "post_kind: post\ncategories: []\n---\n\n"
                + "".join(f'Move {n}. <img src="{gif}">\n\n' for n in range(5)),
                encoding="utf-8",
            )
            archive = Path(tmp) / "archive"
            archive.mkdir()
            blog = core.build_blog_corpus(blog_dir=Path(tmp) / "posts", archive_dir=archive)
        self.assertEqual([m["url"] for m in blog["media"]], [gif])
        self.assertEqual(gate.repeated_media(blog), [])
        blog["media"].append(dict(blog["media"][0]))
        self.assertEqual(gate.repeated_media(blog), [f"5: {gif}"])
        failures = gate.ingest_failures({"media": blog["media"]}, None)
        self.assertEqual(len(failures), 1)
        self.assertIn("(M8)", failures[0])


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
