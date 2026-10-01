"""A blog video's poster still is media, marked as a video poster.

QA 2026-09-30 (media Q3, approved by Jamie): 111 blog videos carry a
``poster`` still, the only image of the video, and none were media, so
media_search could not find them.
"""

import tempfile
import unittest
from pathlib import Path

from librarian_core import corpus as core
from librarian_core.paths import ARCHIVE_DIR, BLOG_DIR

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

    def test_real_blog_posters(self):
        corpus = core.build_blog_corpus(BLOG_DIR, ARCHIVE_DIR)
        posters = [item for item in corpus["media"] if item.get("video_url")]
        self.assertEqual(len([item for item in posters if item.get("microblog_id")]), 111)
        self.assertEqual(len([item for item in posters if item.get("page_id")]), 5)


if __name__ == "__main__":
    unittest.main()
