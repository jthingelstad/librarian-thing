"""Every blog chunk and blog media row names its post by microblog_id.

QA 2026-09-30 (ingest F5, media M9): micro.blog gave six permalinks to
fourteen different posts (2014/12/21/010000.html alone is four posts), and
the only key a blog chunk or photo carried was that shared URL. Anything
grouping by URL merged the posts and put one post's text or photo under
another. The id is additive: chunk ids and text do not move.
"""

import tempfile
import unittest
from pathlib import Path

from librarian_core.corpus import body_hash, build_blog_corpus

SHARED_URL = "https://www.thingelstad.com/2014/12/21/010000.html"


def _post(blog_dir: Path, name: str, mid: int, title: str, body: str) -> None:
    path = blog_dir / "2014" / "12" / f"{name}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "---\n"
        f"microblog_id: {mid}\n"
        f'url: "{SHARED_URL}"\n'
        f'title: "{title}"\n'
        'published: "2014-12-21T01:00:00+00:00"\n'
        "post_kind: post\n"
        "categories: []\n"
        "---\n\n"
        f"{body}\n",
        encoding="utf-8",
    )


class BlogSourceIdTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        blog = Path(tmp.name) / "posts"
        _post(
            blog,
            "2014-12-21-010000",
            1074797,
            "The Chess Master and the Computer",
            "A review of The Chess Master and the Computer.\n\n"
            '<img src="https://www.thingelstad.com/uploads/2020/chess.jpg" alt="Chess">',
        )
        _post(
            blog,
            "2014-12-21-010000-1074798",
            1074798,
            "Rudolph the Red-Nosed Reindeer: The Musical",
            "We saw Rudolph the Red-Nosed Reindeer.\n\n"
            '<img src="https://www.thingelstad.com/uploads/2020/rudolph.jpg" alt="Stage">',
        )
        archive = Path(tmp.name) / "archive"
        archive.mkdir()
        self.corpus = build_blog_corpus(blog_dir=blog, archive_dir=archive)

    def test_every_chunk_carries_its_posts_microblog_id(self):
        chunks = self.corpus["chunks"]
        self.assertEqual({chunk["url"] for chunk in chunks}, {SHARED_URL})
        for chunk in chunks:
            self.assertEqual(chunk["id"].split(":")[1], str(chunk["microblog_id"]))
        by_id = {chunk["microblog_id"]: chunk["text"] for chunk in chunks}
        self.assertIn("Chess Master", by_id[1074797])
        self.assertIn("Rudolph", by_id[1074798])

    def test_chunk_ids_and_text_do_not_move(self):
        for chunk in self.corpus["chunks"]:
            self.assertEqual(
                chunk["id"],
                f"blog:{chunk['microblog_id']}:0:{body_hash(chunk['text'])}",
            )

    def test_every_media_row_carries_its_posts_microblog_id(self):
        owners = {row["url"].rsplit("/", 1)[1]: row["microblog_id"] for row in self.corpus["media"]}
        self.assertEqual(owners, {"chess.jpg": 1074797, "rudolph.jpg": 1074798})
        for row in self.corpus["media"]:
            self.assertEqual(row["source_url"], SHARED_URL)


if __name__ == "__main__":
    unittest.main()
