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
        for row in copies:
            self.assertIsInstance(row["copy_of_microblog_id"], str)
            self.assertTrue(
                row["url"] == row["canonical_url"]
                or core._hashed_photo_name(row["url"])
                == core._hashed_photo_name(row["canonical_url"])
            )
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
