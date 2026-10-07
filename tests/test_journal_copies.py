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
                # WT2's "As I wrote before" link to a 2016 post.
                "references": 1,
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
        linked = {post["microblog_id"]: post.get("linked_from_issues") for post in posts["posts"]}
        self.assertEqual(also[2], [1])
        self.assertEqual(also[4], [2])
        self.assertEqual(also[5], [2])
        # Linked from an issue that does not reprint it: linked_from_issues
        # (Jamie, 2026-10-01), never dropped.
        self.assertIsNone(also[6])
        self.assertEqual(linked[6], [2])
        self.assertEqual(posts["appearance_stats"], {"also_in_issues": 5, "linked_from_issues": 1})


# QA2 I2-1, I2-6, I2-7: what the Journal links that are not copies become,
# an own entry named earlier in prose, a permalink two posts share, and the
# lines of a photo series micro.blog merged into one post.
ISSUE_3 = """## Journal

### [Four Great Years](<BASE>/2017/05/26/four-great-years.html)

Four great years of writing here. Over those years I've used .Text [→](<BASE>/2006/11/25/migrating-text.html)
and WordPress [→](<BASE>/2014/03/01/wordpress-move.html).

Also see [the skull rock hike](<BASE>/2017/05/26/skull-rock.html), the best of the trip.

### [Friday @ 6:52 PM](<BASE>/2017/05/26/skull-rock.html)

We hiked to the skull rock and back.

### Sous Vide

- First run with the Sous Vide worked great! [Now I know](<BASE>/2017/05/25/first-run.html)
- First run with [the Sous Vide. Making beef.](<BASE>/2017/05/25/first-run.html)

### [Saturday @ 1:37 PM](<BASE>/2017/05/27/133747.html)

SPS Tech Jam 2017! #TeamSPS #SPSTechJam

### [Saturday @ 1:36 PM](<BASE>/2017/05/27/080643.html)

Great talks at Tech Jam 2017, and incredible breadth. #TeamSPS

### [Saturday @ 3:27 PM](<BASE>/2017/05/27/152728.html)

⚾️💥🤩
""".replace("<BASE>", BASE)


class JournalReferenceTests(unittest.TestCase):
    def build(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        blog, archive = Path(tmp.name) / "blog", Path(tmp.name) / "archive"
        _post(
            blog,
            10,
            f"{BASE}/2017/05/26/four-great-years.html",
            "2017-05-26T20:00:00+00:00",
            "Four great years of writing here. Over those years I've used .Text and WordPress.",
            "Four Great Years",
        )
        _post(
            blog,
            11,
            f"{BASE}/2006/11/25/migrating-text.html",
            "2006-11-25T20:00:00+00:00",
            "Migrating from .Text to WordPress, and over the years I've used both.",
        )
        _post(
            blog,
            12,
            f"{BASE}/2014/03/01/wordpress-move.html",
            "2014-03-01T20:00:00+00:00",
            "And WordPress it is.",
        )
        _post(
            blog,
            13,
            f"{BASE}/2017/05/26/skull-rock.html",
            "2017-05-26T23:52:00+00:00",
            "We hiked to the skull rock and back.",
        )
        _post(
            blog,
            14,
            f"{BASE}/2017/05/25/first-run.html",
            "2017-05-25T23:03:00+00:00",
            "First run with the Sous Vide. Making beef.",
        )
        _post(
            blog,
            15,
            f"{BASE}/2017/05/25/first-run.html",
            "2017-05-26T02:42:00+00:00",
            "First run with the Sous Vide worked great! Now I know.",
        )
        _post(
            blog,
            16,
            f"{BASE}/2017/05/27/080643.html",
            "2017-05-27T13:06:00+00:00",
            "Great talks at TechJam 2017, and incredible breadth.\n\nSPS TechJam 2017!\n\n⚾️💥🤩",
            "SPS TechJam 2017",
        )
        _issue(archive, 1, "2017-05-20T13:00:00Z", "## Notable\n\nNothing.\n")
        _issue(archive, 2, "2017-05-27T13:00:00Z", ISSUE_3)
        wt = core.build_corpus(archive, include_issue_bodies=True, blog_dir=blog)
        posts = core.build_blog_corpus(blog_dir=blog, archive_dir=archive)
        return wt, posts

    def test_links_to_older_posts_are_references(self):
        wt, posts = self.build()
        issue = next(issue for issue in wt["issues"] if issue["number"] == 2)
        self.assertEqual(
            [
                (item["microblog_id"], item["url"].rsplit("/", 1)[-1])
                for item in issue["journal_references"]
            ],
            [("11", "migrating-text.html"), ("12", "wordpress-move.html")],
        )
        copied = {
            post["copy_of_microblog_id"]
            for chunk in wt["chunks"]
            for post in chunk.get("journal_posts", [])
        }
        self.assertNotIn("11", copied)
        self.assertNotIn("12", copied)
        urls = [url for chunk in wt["chunks"] for url in chunk.get("journal_post_urls", [])]
        self.assertFalse([url for url in urls if "/2006/" in url or "/2014/" in url])
        by_id = {post["microblog_id"]: post for post in posts["posts"]}
        self.assertNotIn("also_in_issues", by_id[11])
        self.assertEqual(by_id[11]["linked_from_issues"], [2])
        self.assertEqual(by_id[12]["linked_from_issues"], [2])
        self.assertEqual(wt["journal_copy_stats"]["references"], 2)

    def test_own_link_wins_over_an_earlier_mention(self):
        wt, _ = self.build()
        entries = [e for i in wt["issues"] for e in i.get("journal_entries", [])]
        skull = [e for e in entries if e["copy_of_microblog_id"] == "13"]
        self.assertEqual(
            [(e["url"], e["matched_by"]) for e in skull],
            [(f"{BASE}/2017/05/26/skull-rock.html", "permalink")],
        )

    def test_a_shared_permalink_copies_each_post_it_names(self):
        wt, posts = self.build()
        entries = [e for i in wt["issues"] for e in i.get("journal_entries", [])]
        self.assertEqual(
            sorted(e["copy_of_microblog_id"] for e in entries if "first-run" in (e["url"] or "")),
            ["14", "15"],
        )
        by_id = {post["microblog_id"]: post for post in posts["posts"]}
        self.assertEqual((by_id[14]["also_in_issues"], by_id[15]["also_in_issues"]), ([2], [2]))

    def test_merged_series_lines_find_their_post(self):
        wt, _ = self.build()
        entries = {
            e["url"]: e for i in wt["issues"] for e in i.get("journal_entries", []) if e["url"]
        }
        for slug in ("133747.html", "152728.html"):
            entry = entries[f"{BASE}/2017/05/27/{slug}"]
            self.assertEqual(
                (entry["copy_of_microblog_id"], entry["matched_by"]), ("16", "date_text")
            )
        self.assertEqual(wt["journal_unmatched"], [])

    def test_every_issue_naming_a_post_is_in_exactly_one_list(self):
        _, posts = self.build()
        for post in posts["posts"]:
            also = set(post.get("also_in_issues") or [])
            linked = set(post.get("linked_from_issues") or [])
            self.assertFalse(also & linked, post["microblog_id"])


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
            if post.get("microblog_id")
        }
        missing = [
            (number, entry["copy_of_microblog_id"])
            for (number, _url), entry in entries.items()
            if entry["copy_of_microblog_id"] and number not in also[entry["copy_of_microblog_id"]]
        ]
        self.assertEqual(missing, [])
        # QA2 I2-6: an own time link after an earlier mention of the post.
        skull = entries[(174, f"{BASE}/2021/02/15/skull-rock-in.html")]
        self.assertEqual(
            (skull["copy_of_microblog_id"], skull["matched_by"]), ("1267487", "permalink")
        )
        # QA2 I2-7: lines of a photo series micro.blog merged into one post.
        # Since the 2026-10-07 repair (round 7) the issue links the merged
        # post for every line, so they match by permalink, as WT1 does.
        for number, dead, url, post in [
            (105, "2019/05/09/133747.html", "2019/05/09/080643.html", "1318870"),
            (105, "2019/05/09/sps-tech-jam.html", "2019/05/09/080643.html", "1318870"),
            (105, "2019/05/04/minnesota-united-v.html", "2019/05/04/191509.html", "1316384"),
            (
                108,
                "2019/05/25/beautiful-game-mnufc.html",
                "2019/05/25/minnesota-united-v.html",
                "1182817",
            ),
            (125, "2019/11/03/152728.html", "2019/11/03/160928.html", "1437903"),
        ]:
            entry = entries[(number, f"{BASE}/{url}")]
            self.assertEqual(
                (entry["copy_of_microblog_id"], entry["matched_by"]), (post, "permalink"), url
            )
            self.assertNotIn((number, f"{BASE}/{dead}"), entries)
        # QA2 I2-1: a copy is a post from the issue's week, [previous issue
        # - 3 days, this issue + 1 day] (Jamie, 2026-10-01); everything else
        # the Journal links is a reference.
        days = {
            post["microblog_id"]: post["publish_date"]
            for post in posts["posts"]
            if post.get("microblog_id")
        }
        dated = [(issue["number"], issue["publish_date"][:10]) for issue in wt["issues"]]
        weeks = {
            number: (core._journal_window(day, dated[i - 1][1] if i else None))
            for i, (number, day) in enumerate(dated)
        }
        stale = [
            (chunk["issue_number"], copy["copy_of_microblog_id"])
            for chunk in wt["chunks"]
            for copy in chunk.get("journal_posts", [])
            if copy["copy_of_microblog_id"]
            and not weeks[chunk["issue_number"]][0]
            <= days[int(copy["copy_of_microblog_id"])]
            <= weeks[chunk["issue_number"]][1]
        ]
        self.assertEqual(stale, [])
        references = {
            (issue["number"], item["microblog_id"])
            for issue in wt["issues"]
            for item in issue.get("journal_references", [])
        }
        # WT334 "Also see 2021 and 2015."; WT212's link back to an NFT post.
        self.assertIn((212, "1464172"), references)
        self.assertEqual(
            stats["references"], sum(len(i.get("journal_references", [])) for i in wt["issues"])
        )
        linked = {
            str(post["microblog_id"]): set(post.get("linked_from_issues") or [])
            for post in posts["posts"]
            if post.get("microblog_id")
        }
        self.assertIn(212, linked["1464172"])
        self.assertNotIn(212, also["1464172"])
        self.assertFalse([mid for mid in also if also[mid] & linked[mid]])


if __name__ == "__main__":
    unittest.main()
