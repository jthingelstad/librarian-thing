"""A post that is only a photo is still a post, and its photo is media.

QA 2026-09-30 (ingest F4): build_blog_corpus skipped any post whose
embedding text was empty, so micropost 5965985 (one photo, no words, no alt
text) was in neither the posts nor the media.
"""

import tempfile
import unittest
from pathlib import Path

from librarian_core import corpus as core
from librarian_core.paths import ARCHIVE_DIR, BLOG_DIR


def _post(blog: Path, *, mid: int, date: str, slug: str, title: str, body: str) -> None:
    y, m, d = date.split("-")
    path = blog / y / m / f"{date}-{slug}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"---\nmicroblog_id: {mid}\n"
        f'url: "https://www.thingelstad.com/{y}/{m}/{d}/{slug}.html"\n'
        f'title: "{title}"\npublished: "{date}T12:00:00+00:00"\n'
        f"post_kind: micropost\ncategories: []\n---\n\n{body}\n",
        encoding="utf-8",
    )


PHOTO = '<img src="https://www.thingelstad.com/uploads/2026/91e3e34e96.jpg" width="600" alt="">'


class PhotoOnlyPostTests(unittest.TestCase):
    def test_photo_only_post_and_its_photo_are_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            blog = Path(tmp) / "posts"
            _post(blog, mid=1, date="2026-08-07", slug="105825", title="", body=PHOTO)
            _post(blog, mid=2, date="2026-08-08", slug="empty", title="", body="<p></p>")
            archive = Path(tmp) / "archive"
            archive.mkdir()
            corpus = core.build_blog_corpus(blog_dir=blog, archive_dir=archive)
        self.assertEqual([post["microblog_id"] for post in corpus["posts"]], [1])
        self.assertEqual(corpus["posts"][0]["subject"], "Photo")
        self.assertEqual(
            [(item["microblog_id"], item["url"]) for item in corpus["media"]],
            [(1, "https://www.thingelstad.com/uploads/2026/91e3e34e96.jpg")],
        )
        self.assertEqual(corpus["chunks"], [])

    def test_every_real_post_file_is_a_post(self):
        corpus = core.build_blog_corpus(BLOG_DIR, ARCHIVE_DIR)
        files = list(BLOG_DIR.rglob("*.md"))
        self.assertEqual(corpus["post_count"], len(files))
        self.assertIn(5965985, {post.get("microblog_id") for post in corpus["posts"]})


if __name__ == "__main__":
    unittest.main()
