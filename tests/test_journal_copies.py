"""A Weekly Thing Journal entry points at the blog post it copies.

Jamie, 2026-09-30: "Journal entries in the Weekly Thing are simply copies of
blog posts ... the blog post should be considered the canonical item." Each
entry is matched by permalink first; a permalink micro.blog later changed or
merged falls back to a post from the same day whose text holds the entry's;
a Journal section with no link to a post from the issue's week whose text
it shares. What matches nothing is counted, never dropped.
"""

import tempfile
import unittest
from pathlib import Path

from librarian_core import corpus as core
from librarian_core.paths import ARCHIVE_DIR, BLOG_DIR


def _post(blog: Path, mid: int, url: str, published: str, body: str, title: str = "") -> None:
    path = blog / published[:4] / f"{mid}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f'---\nmicroblog_id: {mid}\nurl: "{url}"\ntitle: "{title}"\n'
        f'published: "{published}"\npost_kind: micropost\ncategories: []\n---\n\n{body}\n',
        encoding="utf-8",
    )


def _issue(archive: Path, number: int, publish_date: str, body: str) -> None:
    (archive / str(number)).mkdir(parents=True)
    (archive / str(number) / "archive.md").write_text(
        f"---\nnumber: {number}\nsubject: Weekly Thing {number}\n"
        f"publish_date: {publish_date}\n---\n\n{body}\n",
        encoding="utf-8",
    )


BASE = "https://www.thingelstad.com"
MERGED = (
    "Kicking off TechJam community event. Great day of learning ahead.\n\n"
    "Nate and Dan sharing how they are using serverless solutions to build services.\n\n"
    "Marcell sharing capabilities of the newest editions of Microsoft SQL Server."
)
ISSUE_1 = f"""## Microblog updates 🎈

- Nice night on the deck. [→]({BASE}/2017/05/09/nice-night.html)
- Kicking off #TechJam community event. Great day of learning ahead! [→]({BASE}/2017/05/10/kicking-off-techjam.html)
- Nate and Dan sharing how they are using serverless solutions to build services. [→]({BASE}/2017/05/10/nate-and-dan.html)
- A thought that was deleted long ago and exists nowhere else. [→]({BASE}/2017/05/11/deleted-thought.html)
"""
ISSUE_2 = f"""## Journal

[Thursday @ 9:23 PM]({BASE}/2017/05/18/we-are-going.html?ref=weekly-thing)

We are going to the Mothership Weekend, gonna be great!

[Thursday @ 9:19 PM]({BASE}/2017/05/18/the-ice-is.html)

The ice is nearly gone on Lake Harriet this evening.

### Mississippi River Lowered

The Corps of Engineers lowered the Mississippi River by twelve feet to inspect locks and dams,
so we went to see the riverbed. As I [wrote before]({BASE}/2016/01/02/old-post.html), I love it.
"""


class JournalCopyTests(unittest.TestCase):
    def build(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        blog, archive = Path(tmp.name) / "blog", Path(tmp.name) / "archive"
        _post(
            blog,
            1,
            f"{BASE}/2017/05/09/nice-night.html",
            "2017-05-10T02:00:00+00:00",
            "Nice night on the deck.",
        )
        _post(
            blog,
            2,
            f"{BASE}/2017/05/10/sps-techjam.html",
            "2017-05-10T13:52:00+00:00",
            MERGED,
            "SPS TechJam 2017",
        )
        _post(
            blog,
            3,
            f"{BASE}/2017/05/18/we-are-going.html",
            "2017-05-19T02:23:00+00:00",
            "We are going to the [Mothership Weekend](https://example.com/m), gonna be great!",
        )
        _post(
            blog,
            4,
            f"{BASE}/2017/05/18/ice-out.html",
            "2017-05-19T02:19:00+00:00",
            "The ice is nearly gone on Lake Harriet this evening.",
        )
        _post(
            blog,
            5,
            f"{BASE}/2017/05/17/mississippi-river-lowered.html",
            "2017-05-17T20:00:00+00:00",
            "The Corps of Engineers lowered the Mississippi River by twelve feet to inspect "
            "locks and dams, so we went to see the riverbed.",
            "Mississippi River Lowered",
        )
        _post(
            blog,
            6,
            f"{BASE}/2016/01/02/old-post.html",
            "2016-01-02T20:00:00+00:00",
            "An old post about rivers.",
        )
        _issue(archive, 1, "2017-05-13T13:00:00Z", ISSUE_1)
        _issue(archive, 2, "2017-05-20T13:00:00Z", ISSUE_2)
        wt = core.build_corpus(archive, include_issue_bodies=True, blog_dir=blog)
        posts = core.build_blog_corpus(blog_dir=blog, archive_dir=archive)
        return wt, posts

    def test_entries_point_at_their_posts(self):
        wt, _ = self.build()
        entries = {
            entry["url"]: entry
            for issue in wt["issues"]
            for entry in issue.get("journal_entries", [])
        }
        got = {
            url.rsplit("/", 1)[-1]: (e["copy_of_microblog_id"], e["matched_by"])
            for url, e in entries.items()
            if url
        }
        self.assertEqual(
            got,
            {
                "nice-night.html": ("1", "permalink"),
                # Merged into one post later: same day, same text.
                "kicking-off-techjam.html": ("2", "date_text"),
                "nate-and-dan.html": ("2", "date_text"),
                "deleted-thought.html": (None, None),
                "we-are-going.html?ref=weekly-thing": ("3", "permalink"),
                # The slug changed: same day, same text.
                "the-ice-is.html": ("4", "date_text"),
            },
        )
        river = [e for e in entries.values() if e["url"] is None]
        self.assertEqual(
            [(e["title"], e["copy_of_microblog_id"], e["matched_by"]) for e in river],
            [("Mississippi River Lowered", "5", "date_text")],
        )
        self.assertEqual(
            entries[f"{BASE}/2017/05/09/nice-night.html"]["canonical_url"],
            f"{BASE}/2017/05/09/nice-night.html",
        )
        # The link to an old post is a reference, not an entry.
        self.assertNotIn(f"{BASE}/2016/01/02/old-post.html", entries)

    def test_unmatched_entries_are_counted(self):
        wt, _ = self.build()
        self.assertEqual(
            wt["journal_copy_stats"],
            {
                "entries": 7,
                "matched": 6,
                "matched_by_permalink": 2,
                "matched_by_date_text": 4,
                "unmatched": 1,
            },
        )
        self.assertEqual(
            wt["journal_unmatched"],
            [
                {
                    "issue_number": 1,
                    "title": "A thought that was deleted long ago and exists nowhere else.",
                    "url": f"{BASE}/2017/05/11/deleted-thought.html",
                }
            ],
        )

    def test_chunk_journal_posts_pair_with_journal_post_urls(self):
        wt, _ = self.build()
        for chunk in wt["chunks"]:
            urls = chunk.get("journal_post_urls", [])
            posts = chunk.get("journal_posts", [])
            self.assertGreaterEqual(len(posts), len(urls))
            for url, post in zip(urls, posts):
                self.assertIn(url, {post["canonical_url"], core._canonical_blog_url(post["url"])})
        journal = [c for c in wt["chunks"] if c.get("section_family") == "Journal"]
        by_section = {c["section"]: c["journal_posts"] for c in journal}
        self.assertEqual(
            [
                (p["copy_of_microblog_id"], p["matched_by"])
                for p in by_section["Microblog updates 🎈"]
            ],
            [("1", "permalink"), ("2", "date_text"), ("2", "date_text"), (None, None)],
        )
        self.assertEqual(
            by_section["Mississippi River Lowered"],
            [
                {
                    "url": None,
                    "copy_of_microblog_id": "5",
                    "canonical_url": f"{BASE}/2017/05/17/mississippi-river-lowered.html",
                    "matched_by": "date_text",
                }
            ],
        )

    def test_every_copy_is_in_its_posts_also_in_issues(self):
        _, posts = self.build()
        also = {post["microblog_id"]: post.get("also_in_issues") for post in posts["posts"]}
        self.assertEqual(also[2], [1])
        self.assertEqual(also[4], [2])
        self.assertEqual(also[5], [2])
        # Linked from an issue, as before: still listed.
        self.assertEqual(also[6], [2])


class RealJournalCopyTests(unittest.TestCase):
    def test_real_archive(self):
        wt = core.build_corpus(ARCHIVE_DIR, include_issue_bodies=True)
        stats = wt["journal_copy_stats"]
        self.assertEqual(stats["unmatched"], len(wt["journal_unmatched"]))
        self.assertEqual(stats["matched"] + stats["unmatched"], stats["entries"])
        self.assertGreaterEqual(stats["matched"] / stats["entries"], 0.98)
        entries = {
            (issue["number"], entry["url"]): entry
            for issue in wt["issues"]
            for entry in issue.get("journal_entries", [])
        }
        # WT1's TechJam microposts were merged into one post on micro.blog;
        # since the 2026-10-01 repair the issue links that post, so the
        # entry matches by permalink instead of by date and text.
        techjam = entries[(1, f"{BASE}/2017/05/10/sps-techjam.html")]
        self.assertEqual(techjam["copy_of_microblog_id"], "1320679")
        self.assertEqual(techjam["matched_by"], "permalink")
        self.assertNotIn((1, f"{BASE}/2017/05/10/dan-talking-at.html"), entries)
        posts = core.build_blog_corpus(BLOG_DIR, ARCHIVE_DIR)
        also = {
            str(post["microblog_id"]): set(post.get("also_in_issues") or [])
            for post in posts["posts"]
        }
        missing = [
            (number, entry["copy_of_microblog_id"])
            for (number, _url), entry in entries.items()
            if entry["copy_of_microblog_id"] and number not in also[entry["copy_of_microblog_id"]]
        ]
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
