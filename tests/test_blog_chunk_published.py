"""Blog chunks carry their post's ``published`` timestamp, and a post has one
date: the Chicago day of ``published``.

The Lambda shows every day in Chicago time and takes a source's day as the
Chicago date of ``published`` when present. ``publish_date`` was the
permalink's day, which names another day for 121 of 10,443 posts (the UTC
day, or a permalink several posts share) and another year for 11 Blot
imports, so on_this_day and every year filter disagreed (QA2 I2-8, T2-2,
T2-3). Eight of those imports carry a 05:00Z date-only placeholder, read as
Chicago noon on its date (Jamie, 2026-10-01, QA2 Q16).
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
        self.assertEqual(chunks[1]["publish_date"], "2017-04-28")
        self.assertEqual(chunks[2]["publish_date"], "2017-05-01")
        self.assertNotIn("published", chunks[2])
        posts = {post["microblog_id"]: post for post in corpus["posts"]}
        self.assertEqual(chunks[1]["published"], posts[1]["published"])

    def test_the_chicago_day_dates_the_post_everywhere(self):
        corpus = self.build()
        posts = {post["microblog_id"]: post for post in corpus["posts"]}
        self.assertEqual(posts[1]["publish_date"], "2017-04-28")
        self.assertEqual(posts[1]["post_year"], 2017)
        # The permalink's day is kept where it differs: the Journal matcher
        # pairs copies by it.
        self.assertEqual(posts[1]["permalink_date"], "2017-04-29")
        self.assertNotIn("permalink_date", posts[2])

    def test_published_is_not_embedded(self):
        chunk = self.build()["chunks"][0]
        without = {key: value for key, value in chunk.items() if key != "published"}
        self.assertEqual(core._embed_input(chunk), core._embed_input(without))


class BlotPlaceholderTests(unittest.TestCase):
    """QA2 Q16: 05:00Z in a CST month is 23:00 the evening before in Chicago,
    a bare date converted at a fixed -05:00."""

    def test_placeholder_is_chicago_noon_on_its_date(self):
        self.assertEqual(
            core.blog_published("2019-11-22T05:00:00+00:00", "2020-04-21"),
            "2019-11-22T18:00:00+00:00",
        )

    def test_a_late_post_its_permalink_vouches_for_keeps_its_time(self):
        # 4482285: 23:00 on Nov 22 2024 in Chicago, permalink 2024/11/22.
        self.assertEqual(
            core.blog_published("2024-11-23T05:00:00+00:00", "2024-11-22"),
            "2024-11-23T05:00:00+00:00",
        )

    def test_summer_midnight_is_already_chicago_midnight(self):
        self.assertEqual(
            core.blog_published("2004-06-02T05:00:00+00:00", "2020-04-21"),
            "2004-06-02T05:00:00+00:00",
        )

    def test_other_times_and_bad_stamps_pass_through(self):
        self.assertEqual(
            core.blog_published("2019-06-30T03:25:00+00:00", "2020-04-21"),
            "2019-06-30T03:25:00+00:00",
        )
        self.assertIsNone(core.blog_published(None, "2020-04-21"))
        self.assertEqual(core.blog_published("not a date", None), "not a date")
        self.assertIsNone(core.chicago_day("not a date"))


class RealBlogChunkPublishedTests(unittest.TestCase):
    def test_every_chunk_has_its_posts_published(self):
        corpus = core.build_blog_corpus()
        published = {
            post["microblog_id"]: post.get("published")
            for post in corpus["posts"]
            if post.get("microblog_id")
        }
        post_chunks = [chunk for chunk in corpus["chunks"] if chunk.get("microblog_id")]
        mismatched = [
            chunk["id"]
            for chunk in post_chunks
            if chunk.get("published") != published[chunk["microblog_id"]]
        ]
        self.assertEqual(mismatched, [])
        self.assertTrue(all(chunk.get("published") for chunk in post_chunks))
        # One date per post, on the post, its chunks, links and photos.
        split = [
            post["microblog_id"]
            for post in corpus["posts"]
            if post.get("published")
            and (
                post["publish_date"] != core.chicago_day(post["published"])
                or post["post_year"] != int(post["publish_date"][:4])
            )
        ]
        self.assertEqual(split, [])
        day = {post.get("microblog_id"): post["publish_date"] for post in corpus["posts"]}
        for row in [*corpus["chunks"], *corpus["links"], *corpus["media"]]:
            if row.get("microblog_id"):
                self.assertEqual(row["publish_date"], day[row["microblog_id"]])
        # The eight Blot placeholders are Chicago noon; Kyiv Photowalk is 2019.
        blot = {1077249, 1077253, 1077264, 1077238, 1077252, 1077240, 1077239, 1077241}
        for post in corpus["posts"]:
            if post.get("microblog_id") in blot:
                self.assertTrue(post["published"].endswith("T18:00:00+00:00"), post)
        kyiv = next(post for post in corpus["posts"] if post.get("microblog_id") == 1077264)
        self.assertEqual((kyiv["publish_date"], kyiv["post_year"]), ("2019-11-22", 2019))
        # Pages are undated: their chunks carry the page's last edit instead.
        updated = {
            post["page_id"]: post.get("updated") for post in corpus["posts"] if post.get("page_id")
        }
        for chunk in corpus["chunks"]:
            if chunk.get("page_id"):
                self.assertNotIn("published", chunk)
                self.assertEqual(chunk.get("updated"), updated[chunk["page_id"]])


if __name__ == "__main__":
    unittest.main()
