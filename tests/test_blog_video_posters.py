"""A blog video's poster still is media, marked as a video poster.

QA 2026-09-30 (media Q3, approved by Jamie): 111 blog videos carry a
``poster`` still, the only image of the video, and none were media, so
media_search could not find them.
"""

import importlib.util
import re
import tempfile
import unittest
from pathlib import Path

from librarian_core import corpus as core
from librarian_core.paths import ARCHIVE_DIR, BLOG_DIR, REPO

_spec = importlib.util.spec_from_file_location(
    "test_blog_video_posters_gate", REPO / "pipeline" / "corpus" / "corpus_gate.py"
)
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)

VIDEO = (
    '<video controls="controls" playsinline="playsinline" '
    'src="https://www.thingelstad.com/uploads/2024/5b5e9882e0.mov" width="640" height="360" '
    'poster="https://www.thingelstad.com/uploads/2024/c73eecb561.png" preload="none"></video>'
)
EMPTY = '<video src="https://files.thingelstad.com/posts/2007/drive.mp4" poster=""></video>'


class VideoPosterTests(unittest.TestCase):
    def test_extract(self):
        self.assertEqual(
            core.extract_video_posters(f"{VIDEO}\n{EMPTY}"),
            [
                {
                    "url": "https://www.thingelstad.com/uploads/2024/c73eecb561.png",
                    "alt": "",
                    "video_url": "https://www.thingelstad.com/uploads/2024/5b5e9882e0.mov",
                }
            ],
        )

    def test_blog_media_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp) / "posts" / "2024" / "05"
            posts.mkdir(parents=True)
            (posts / "2024-05-01-boat.md").write_text(
                "---\nmicroblog_id: 7\n"
                'url: "https://www.thingelstad.com/2024/05/01/boat.html"\n'
                'title: ""\npublished: "2024-05-01T12:00:00+00:00"\n'
                "post_kind: micropost\ncategories: []\n---\n\n"
                f"First boat ride of the year.\n\n{VIDEO}\n",
                encoding="utf-8",
            )
            archive = Path(tmp) / "archive"
            archive.mkdir()
            corpus = core.build_blog_corpus(blog_dir=Path(tmp) / "posts", archive_dir=archive)
        [poster] = corpus["media"]
        self.assertEqual(poster["url"], "https://www.thingelstad.com/uploads/2024/c73eecb561.png")
        self.assertEqual(poster["microblog_id"], 7)
        self.assertEqual(
            poster["video_url"], "https://www.thingelstad.com/uploads/2024/5b5e9882e0.mov"
        )
        self.assertTrue(poster["context"].startswith(core.VIDEO_POSTER_CONTEXT))
        self.assertIn("First boat ride", poster["context"])

    def test_posterless_video_is_a_video_record(self):
        # QA3 (ingest I2-5): poster="" left a video with no media record.
        self.assertEqual(
            core.extract_posterless_videos(f"{VIDEO}\n{EMPTY}"),
            [
                {
                    "url": "https://files.thingelstad.com/posts/2007/drive.mp4",
                    "video_url": "https://files.thingelstad.com/posts/2007/drive.mp4",
                }
            ],
        )
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp) / "posts" / "2007" / "05"
            posts.mkdir(parents=True)
            (posts / "2007-05-25-drive-to-work.md").write_text(
                "---\nmicroblog_id: 8\n"
                'url: "https://www.thingelstad.com/2007/05/25/drive-to-work.html"\n'
                'title: "Drive to work"\npublished: "2007-05-25T12:00:00+00:00"\n'
                "post_kind: post\ncategories: []\n---\n\n"
                f"Time-elapsed video of my morning drive.\n\n<p>{EMPTY}</p>\n",
                encoding="utf-8",
            )
            archive = Path(tmp) / "archive"
            archive.mkdir()
            corpus = core.build_blog_corpus(blog_dir=Path(tmp) / "posts", archive_dir=archive)
            # The corpus gate checks every <video> has a record.
            self.assertEqual(gate.blog_source_failures(corpus, Path(tmp) / "posts"), [])
            [failure] = gate.blog_source_failures({**corpus, "media": []}, Path(tmp) / "posts")
            self.assertIn("1 blog videos with no media record", failure)
        [video] = corpus["media"]
        self.assertEqual(video["media_kind"], "video")
        self.assertEqual(video["url"], video["video_url"])
        self.assertEqual(video["alt"], "")
        self.assertNotIn("description", video)
        self.assertEqual(
            video["context"],
            f"{core.VIDEO_NO_POSTER_CONTEXT}. Time-elapsed video of my morning drive.",
        )

    def test_real_blog_posters(self):
        corpus = core.build_blog_corpus(BLOG_DIR, ARCHIVE_DIR)
        posters = [
            item
            for item in corpus["media"]
            if item.get("video_url") and item.get("media_kind") != "video"
        ]
        # Every poster still in the source, posts and pages, read from the
        # markdown rather than counted, so a new video never moves it.
        expected = set()
        for path in BLOG_DIR.parent.rglob("*.md"):
            text = path.read_text(encoding="utf-8")
            if not text.startswith("---"):
                continue
            front, body = text.split("---", 2)[1:]
            owner = re.search(r'^(microblog_id|page_id):\s*"?(\d+)', front, re.M)
            for tag in re.findall(r"<video\b[^>]*>", body, re.I):
                poster = re.search(r"""\bposter=["']([^"']+)["']""", tag, re.I)
                if owner and poster:
                    expected.add((owner.group(1), owner.group(2), poster.group(1)))
        found = {
            ("page_id", str(item["page_id"]), item["url"])
            if item.get("page_id") is not None
            else ("microblog_id", str(item["microblog_id"]), item["url"])
            for item in posters
        }
        self.assertEqual(found, expected)
        self.assertGreater(len(found), 100)
        videos = [item for item in corpus["media"] if item.get("media_kind") == "video"]
        self.assertEqual(
            sorted((item["microblog_id"], item["url"].rsplit("/", 1)[1]) for item in videos),
            [
                (1075505, "Sausage%20Making.m4v"),
                (1076043, "drive-to-work-1.mp4"),
                (1076043, "drive-to-work-2.mp4"),
                (1076047, "drive-to-work-1.mp4"),
            ],
        )


if __name__ == "__main__":
    unittest.main()
