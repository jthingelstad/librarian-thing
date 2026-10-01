"""A Weekly Thing photo that is also a blog post's photo points at the post.

Jamie, 2026-09-30: collapse duplicate photos, with the blog copy canonical.
The Weekly Thing reprints blog photos, under the same URL or under the same
micro.blog upload name on another host (www.thingelstad.com,
cdn.uploads.micro.blog, files.thingelstad.com). Each such media row carries
``copy_of_microblog_id`` and ``canonical_url`` (the blog photo's URL).

A post copied with its own H2s splits into sections named after them; those
sections stay in the issue's Journal (WT147, "A New Way to Mourn").
"""

import tempfile
import unittest
from pathlib import Path

from librarian_core import corpus as core
from librarian_core.paths import ARCHIVE_DIR

BASE = "https://www.thingelstad.com"
DECK = f"{BASE}/uploads/2017/5b1cabc144.jpg"
PHONE = f"{BASE}/uploads/2017/IMG_1234.jpg"
LAKE = "https://cdn.uploads.micro.blog/1234/2017/a1b2c3d4e5.jpg"


def _post(blog: Path, mid: int, url: str, published: str, body: str) -> None:
    path = blog / published[:4] / f"{mid}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f'---\nmicroblog_id: {mid}\nurl: "{url}"\ntitle: ""\n'
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


ISSUE_1 = f"""## Journal

- Nice night on the deck. [→]({BASE}/2017/05/09/nice-night.html)
- Out on the lake at sunset with the whole family tonight. [→]({BASE}/2017/05/11/lake-again.html)

![Deck]({DECK})

![The deck from micro.blog](https://cdn.uploads.micro.blog/1234/2017/5b1cabc144.jpg)

![My phone]({PHONE})

![Someone else's phone](https://files.thingelstad.com/2017/IMG_1234.jpg)

![Lake](https://files.thingelstad.com/2017/a1b2c3d4e5.jpg)

![Not on the blog](https://files.thingelstad.com/2017/f0f0f0f0f0.jpg)
"""
ISSUE_2 = f"""## Notable

### A link

Something worth reading.

![Lake again]({LAKE})
"""
WT147 = """## Stream

Some short entries from the week.

## A New Way to Mourn

A long post copied with its own heading.

## Notable

### A link

Something worth reading.

## A Section Nobody Knows

After Notable, so not the Journal.
"""


class MediaBlogCopyTests(unittest.TestCase):
    def build(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        blog, archive = Path(tmp.name) / "blog", Path(tmp.name) / "archive"
        _post(
            blog,
            1,
            f"{BASE}/2017/05/09/nice-night.html",
            "2017-05-10T02:00:00+00:00",
            f"Nice night on the deck.\n\n![]({DECK})\n\n![]({PHONE})",
        )
        _post(
            blog,
            2,
            f"{BASE}/2017/05/10/lake.html",
            "2017-05-10T23:00:00+00:00",
            f"On the lake.\n\n![]({LAKE})",
        )
        _post(
            blog,
            3,
            f"{BASE}/2017/05/11/lake-again.html",
            "2017-05-11T23:00:00+00:00",
            f"Out on the lake at sunset with the whole family tonight.\n\n![]({LAKE})",
        )
        _issue(archive, 1, "2017-05-13T13:00:00Z", ISSUE_1)
        _issue(archive, 2, "2017-05-20T13:00:00Z", ISSUE_2)
        return core.build_corpus(archive, blog_dir=blog)

    def test_rows_point_at_the_blog_photo(self):
        wt = self.build()
        got = {
            (row["issue_number"], row["url"]): (
                row.get("copy_of_microblog_id"),
                row.get("canonical_url"),
            )
            for row in wt["media"]
        }
        self.assertEqual(
            got,
            {
                # The same URL.
                (1, DECK): ("1", DECK),
                (1, PHONE): ("1", PHONE),
                # The same upload name on another host.
                (1, "https://cdn.uploads.micro.blog/1234/2017/5b1cabc144.jpg"): ("1", DECK),
                # "IMG_1234.jpg" names many photos: only the same URL matches.
                (1, "https://files.thingelstad.com/2017/IMG_1234.jpg"): (None, None),
                # Two posts carry the photo: the one this issue's Journal copies.
                (1, "https://files.thingelstad.com/2017/a1b2c3d4e5.jpg"): ("3", LAKE),
                (1, "https://files.thingelstad.com/2017/f0f0f0f0f0.jpg"): (None, None),
                # No Journal copy in the issue: the earliest post.
                (2, LAKE): ("2", LAKE),
            },
        )

    def test_hashed_photo_name(self):
        self.assertEqual(core._hashed_photo_name(DECK), "5b1cabc144.jpg")
        self.assertEqual(
            core._hashed_photo_name(
                "https://cdn.uploads.micro.blog/1/2021/0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9.PNG"
            ),
            "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9.png",
        )
        self.assertIsNone(core._hashed_photo_name(PHONE))
        self.assertIsNone(core._hashed_photo_name(f"{BASE}/uploads/2017/5b1cabc144-2.jpg"))

    def test_wt_builder_rehost_contract(self):
        # wt-builder src/server/integrations/images.ts keyFor: a real WT350
        # Journal photo and the CDN copy WT Builder made of it.
        self.assertEqual(
            core.wt_builder_rehost_url(
                "https://www.thingelstad.com/uploads/2026/39697360-9ad9-47b4-82d2-e7ab416b6196.jpg",
                350,
            ),
            "https://files.thingelstad.com/weekly-thing/350/images/16caa566dc0f.jpg",
        )

    def test_wt_builder_rehosted_photos_point_at_the_blog_photo(self):
        # WT350 on, every issue photo is rehosted under a name derived from
        # its source URL, so neither the URL nor the upload name matches.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        blog, archive = Path(tmp.name) / "blog", Path(tmp.name) / "archive"
        walk = f"{BASE}/uploads/2026/0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9.jpg"
        _post(
            blog,
            9,
            f"{BASE}/2026/09/22/kubb.html",
            "2026-09-22T23:00:00+00:00",
            f"Kubb in the yard with the whole family tonight.\n\n![]({walk})",
        )
        copy = core.wt_builder_rehost_url(walk, 350)
        currently = core.wt_builder_rehost_url(f"{BASE}/uploads/2026/not-a-post.jpg", 350)
        _issue(
            archive,
            350,
            "2026-09-26T12:00:00Z",
            f"## Currently\n\n![Sailboats]({currently})\n\n## Journal\n\n"
            f"Kubb in the yard with the whole family tonight. [→]({BASE}/2026/09/22/kubb.html)\n\n"
            f"![Kubb]({copy})\n",
        )
        wt = core.build_corpus(archive, blog_dir=blog)
        got = {
            row["url"]: (row.get("copy_of_microblog_id"), row.get("canonical_url"))
            for row in wt["media"]
        }
        self.assertEqual(got[copy], ("9", walk))
        # A Currently photo is the issue's own: no post to point at.
        self.assertEqual(got[currently], (None, None))

    def test_renamed_journal_copies_point_at_the_blog_photo(self):
        # QA3 M2-2: the Shortcuts workflow rehosted Journal photos under the
        # blog photo's file name, and a few issues used micro.blog's CDN form
        # of the upload; a poster still is the post's photo too.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        blog, archive = Path(tmp.name) / "blog", Path(tmp.name) / "archive"
        chart = f"{BASE}/uploads/2023/weekly-thing-automation-2023.png"
        poap = f"{BASE}/uploads/2023/minnebar-poap.gif"
        poster = f"{BASE}/uploads/2023/aecbcc42c5.png"
        _post(
            blog,
            21,
            f"{BASE}/2023/05/01/automation.html",
            "2023-05-01T23:00:00+00:00",
            f"How the Weekly Thing gets automated these days.\n\n![]({chart})\n\n![]({poap})\n\n"
            f'<video src="{BASE}/uploads/2023/a.mov" poster="{poster}"></video>\n\n'
            f"![]({BASE}/uploads/2023/img-7222.jpeg)",
        )
        _post(
            blog,
            22,
            f"{BASE}/2023/05/02/two-phones.html",
            "2023-05-02T23:00:00+00:00",
            f"Two phones on the table with nothing else to say.\n\n![]({BASE}/uploads/2023/img-7222.jpeg)",
        )
        _post(
            blog,
            23,
            f"{BASE}/2023/05/03/not-copied.html",
            "2023-05-03T23:00:00+00:00",
            f"Another photo of a lake.\n\n![]({BASE}/uploads/2023/lake.png)",
        )
        rehost = "https://files.thingelstad.com/weekly-thing/263/journal/"
        _issue(
            archive,
            263,
            "2023-05-06T12:00:00Z",
            "## Journal\n\n"
            f"How the Weekly Thing gets automated these days. [→]({BASE}/2023/05/01/automation.html)\n\n"
            f"Two phones on the table with nothing else to say. [→]({BASE}/2023/05/02/two-phones.html)\n\n"
            f"![]({rehost}weekly-thing-automation-2023.png)\n\n"
            "![](https://cdn.uploads.micro.blog/890/2023/minnebar-poap.gif)\n\n"
            "![](https://cdn.uploads.micro.blog/890/2022/minnebar-poap.gif)\n\n"
            f"![]({poster})\n\n"
            f"![]({rehost}img-7222.jpeg)\n\n"
            f"![]({rehost}lake.png)\n",
        )
        wt = core.build_corpus(archive, blog_dir=blog)
        got = {
            row["url"]: (row.get("copy_of_microblog_id"), row.get("canonical_url"))
            for row in wt["media"]
        }
        self.assertEqual(got[f"{rehost}weekly-thing-automation-2023.png"], ("21", chart))
        self.assertEqual(
            got["https://cdn.uploads.micro.blog/890/2023/minnebar-poap.gif"], ("21", poap)
        )
        self.assertEqual(got[poster], ("21", poster))
        # Another year's upload of the name is another file.
        self.assertEqual(
            got["https://cdn.uploads.micro.blog/890/2022/minnebar-poap.gif"], (None, None)
        )
        # Two copied posts hold an "img-7222.jpeg": which one is unknowable.
        self.assertEqual(got[f"{rehost}img-7222.jpeg"], (None, None))
        # A post the Journal does not copy is never tied by name.
        self.assertEqual(got[f"{rehost}lake.png"], (None, None))

    def test_journal_runs_through_unknown_h2s(self):
        split = core.split_issue_sections(WT147)
        self.assertEqual(
            [split[i].heading for i in core.journal_section_indexes(split)],
            ["Stream", "A New Way to Mourn"],
        )


class RealMediaBlogCopyTests(unittest.TestCase):
    def test_real_archive(self):
        wt = core.build_corpus(ARCHIVE_DIR)
        copies = [row for row in wt["media"] if row.get("copy_of_microblog_id")]
        same_url = [row for row in copies if row["url"] == row["canonical_url"]]
        self.assertGreaterEqual(len(same_url), 1600)
        self.assertGreaterEqual(len(copies), 3500)
        by_rule = {"url": 0, "hashed": 0, "rehost": 0, "named": 0}
        for row in copies:
            self.assertIsInstance(row["copy_of_microblog_id"], str)
            hashed = core._hashed_photo_name(row["url"])
            if row["url"] == row["canonical_url"]:
                by_rule["url"] += 1
            elif hashed and hashed == core._hashed_photo_name(row["canonical_url"]):
                by_rule["hashed"] += 1
            elif (
                core.wt_builder_rehost_url(row["canonical_url"], row["issue_number"]) == row["url"]
            ):
                by_rule["rehost"] += 1
            else:
                self.assertTrue(core._same_named_photo(row["url"], row["canonical_url"]), row)
                by_rule["named"] += 1
        # QA3 M2-2: 93 Shortcuts-era Journal rehosts and 3 micro.blog CDN
        # copies tie by file name (WT263-WT349).
        self.assertEqual(by_rule["named"], 96)
        # QA3 M2-2: WT169 and WT191 ran a blog video's poster still.
        posters = {
            (row["issue_number"], row["copy_of_microblog_id"])
            for row in copies
            if row["issue_number"] in (169, 191)
        }
        self.assertLessEqual({(169, "1230047"), (191, "1342986")}, posters)
        # WT Builder issues: every Journal photo points at its post (WT350's
        # and WT351's other photos are Currently photos, never blog posts).
        rehosted = [row for row in wt["media"] if row["issue_number"] in (350, 351)]
        tied = [row for row in rehosted if row.get("copy_of_microblog_id")]
        self.assertGreaterEqual(len(tied), 16)
        # WT147's long post kept its own H2: its sections are still the Journal.
        wt147 = [
            chunk
            for chunk in wt["chunks"]
            if chunk.get("issue_number") == 147 and chunk.get("section") == "A New Way to Mourn"
        ]
        self.assertTrue(wt147)
        self.assertTrue(any(chunk.get("journal_posts") for chunk in wt147))


if __name__ == "__main__":
    unittest.main()
