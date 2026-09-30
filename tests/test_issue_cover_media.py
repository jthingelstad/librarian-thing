"""An issue's front-matter cover is media for that issue.

QA 2026-09-30 (media Q4, approved by Jamie): 57 issues have a front-matter
``image`` that is in neither the body nor the media, WT350 and WT351 among
them, so media_search could not find their covers. 20 of those are one
generic Buttondown attachment (WT3-22) and stay out; WT236's "IMG_8973" is
not a URL.
"""

import tempfile
import unittest
from pathlib import Path

from librarian_core import corpus as core
from librarian_core.paths import ARCHIVE_DIR

PLACEHOLDER = "https://buttondown-attachments.s3.us-west-2.amazonaws.com/cb69.jpg"


def _issue(archive: Path, number: int, image: str, body: str = "Words.") -> None:
    (archive / str(number)).mkdir(parents=True)
    (archive / str(number) / "archive.md").write_text(
        f"---\nnumber: {number}\nsubject: Weekly Thing {number}\n"
        f"publish_date: 2018-01-0{number}\nimage: '{image}'\n---\n\n## Notable\n\n{body}\n",
        encoding="utf-8",
    )


class IssueCoverTests(unittest.TestCase):
    def test_covers_become_media_and_placeholders_do_not(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "archive"
            _issue(archive, 1, f"{PLACEHOLDER}?Signature=a&Expires=1")
            _issue(archive, 2, f"{PLACEHOLDER}?Signature=b&Expires=2")
            _issue(archive, 3, "https://files.thingelstad.com/weekly-thing/3/cover.jpg")
            _issue(archive, 4, "IMG_8973")
            _issue(
                archive,
                5,
                "https://files.thingelstad.com/weekly-thing/5/cover.jpg",
                "![A lake](https://files.thingelstad.com/weekly-thing/5/cover.jpg)",
            )
            corpus = core.build_corpus(archive, include_issue_bodies=True)
        media = [(item["issue_number"], item["url"], item["context"]) for item in corpus["media"]]
        # 1 and 2 share a placeholder, 4 is no URL, and 5's cover is already
        # an image in its body, recorded once as that.
        self.assertEqual(
            [(number, url) for number, url, _ in media],
            [
                (3, "https://files.thingelstad.com/weekly-thing/3/cover.jpg"),
                (5, "https://files.thingelstad.com/weekly-thing/5/cover.jpg"),
            ],
        )
        self.assertEqual(media[0][2], "Cover image")
        self.assertNotEqual(media[1][2], "Cover image")

    def test_real_archive_covers(self):
        corpus = core.build_corpus(ARCHIVE_DIR, include_issue_bodies=True)
        covers = {
            str(item["issue_number"])
            for item in corpus["media"]
            if item["context"] == core.COVER_CONTEXT
        }
        self.assertIn("350", covers)
        self.assertIn("351", covers)
        self.assertEqual(len(covers), 36)
        self.assertFalse({str(n) for n in range(3, 23)} & covers)


if __name__ == "__main__":
    unittest.main()
