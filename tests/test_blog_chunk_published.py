"""Blog chunks carry their post's ``published`` timestamp.

The Lambda shows every day in Chicago time and takes a source's day as the
Chicago date of ``published`` when present. Blog chunks carried only
``publish_date``, the permalink's day, which names another day for 121 of
10,443 posts (the UTC day, or a permalink several posts share).
"""

import tempfile
import unittest
from pathlib import Path

from librarian_core import corpus as core


def _post(blog: Path, mid: int, url: str, published: str | None, body: str) -> None:
    path = blog / "2017" / f"{mid}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    stamp = f'published: "{published}"\n' if published else ""
    path.write_text(
        f'---\nmicroblog_id: {mid}\nurl: "{url}"\ntitle: ""\n{stamp}'
        f"post_kind: micropost\n---\n\n{body}\n",
        encoding="utf-8",
    )


class BlogChunkPublishedTests(unittest.TestCase):
    def build(self):
        with tempfile.TemporaryDirectory() as tmp:
            blog = Path(tmp) / "posts"
            # Published 9:19 PM Chicago on 2017-04-28; the permalink took the UTC day.
            _post(
                blog,
                1,
                "http://jthingelstad.micro.blog/2017/04/29/built-in-support.html",
                "2017-04-29T02:19:29+00:00",
                "Built-in support for the new thing.",
            )
            _post(
                blog,
                2,
                "https://www.thingelstad.com/2017/05/01/undated.html",
                None,
                "A post with no published timestamp.",
            )
            archive = Path(tmp) / "archive"
            archive.mkdir()
            return core.build_blog_corpus(blog_dir=blog, archive_dir=archive)

    def test_chunks_carry_published(self):
        corpus = self.build()
        chunks = {chunk["microblog_id"]: chunk for chunk in corpus["chunks"]}
        self.assertEqual(chunks[1]["published"], "2017-04-29T02:19:29+00:00")
        self.assertEqual(chunks[1]["publish_date"], "2017-04-29")
        self.assertNotIn("published", chunks[2])
        posts = {post["microblog_id"]: post for post in corpus["posts"]}
        self.assertEqual(chunks[1]["published"], posts[1]["published"])

    def test_published_is_not_embedded(self):
        chunk = self.build()["chunks"][0]
        without = {key: value for key, value in chunk.items() if key != "published"}
        self.assertEqual(core._embed_input(chunk), core._embed_input(without))


class RealBlogChunkPublishedTests(unittest.TestCase):
    def test_every_chunk_has_its_posts_published(self):
        corpus = core.build_blog_corpus()
        published = {post["microblog_id"]: post.get("published") for post in corpus["posts"]}
        mismatched = [
            chunk["id"]
            for chunk in corpus["chunks"]
            if chunk.get("published") != published[chunk["microblog_id"]]
        ]
        self.assertEqual(mismatched, [])
        self.assertTrue(all(chunk.get("published") for chunk in corpus["chunks"]))


if __name__ == "__main__":
    unittest.main()
