"""Every labelled Currently line is an entry.

QA 2026-09-30 (ingest F12): the Currently extractor read only "**Label:**"
with the colon inside the bold, so ten "**Dining**: ..." / "**Making**:" /
"**Waiting**:" lines from 2022-2025 were dropped, and five Currently
sections gave no entries at all.
"""

import re
import unittest

from librarian_core import corpus as core
from librarian_core.paths import ARCHIVE_DIR

CURRENTLY = "\n\n".join(
    [
        "**Reading:** [Some Book](https://example.com/book) and loving it.",
        "**Dining**: We finally tried **[Oro by Nixta](https://www.nixtampls.com/about-3)**.",
        "**Waiting** : for [the list](https://reboot.digg.com)!",
        "Not a **label**: in the middle of a line.",
    ]
)


class CurrentlyLabelTests(unittest.TestCase):
    def test_colon_inside_or_outside_the_bold(self):
        entries = core.extract_currently_entries(CURRENTLY)
        self.assertEqual([e["kind"] for e in entries], ["reading", "dining", "waiting"])
        self.assertEqual(
            entries[1]["links"],
            [{"title": "Oro by Nixta", "url": "https://www.nixtampls.com/about-3"}],
        )
        self.assertTrue(entries[1]["text"].startswith("We finally tried Oro by Nixta"))

    def test_every_real_currently_section_yields_entries(self):
        corpus = core.build_corpus(ARCHIVE_DIR, include_issue_bodies=True)
        with_entries = {entry["issue_number"] for entry in corpus["currently"]}
        empty = [
            issue["number"]
            for issue in corpus["issues"]
            for section in issue["sections"]
            if section["name"].strip().lower() == "currently"
            and issue["number"] not in with_entries
        ]
        self.assertEqual(empty, [])
        dining = [e for e in corpus["currently"] if e["kind"] == "dining"]
        self.assertGreaterEqual(len(dining), 8)


class CurrentlyFullTextTests(unittest.TestCase):
    """QA 2026-09-30 (time F4): entry text was cut at 400 characters, so 20
    long entries lost their later titles ("Rag and Bone" and "101 Famous
    Poems" in WT132, the second MrBeast entry in WT247/248) and
    currently_history could not find them. The Lambda clips the display."""

    def test_an_entry_over_400_characters_keeps_its_whole_text(self):
        line = "**Reading:** " + "A long thought about poems. " * 20 + "Finally Rag and Bone."
        [entry] = core.extract_currently_entries(line)
        self.assertGreater(len(entry["text"]), 400)
        self.assertTrue(entry["text"].endswith("Finally Rag and Bone."))
        blurb = "A blurb sentence about the book. " * 20 + "The last line."
        [book] = core.extract_now_reading_entries(f"## Now Reading 📚\n\n### Book\n\n{blurb}\n")
        self.assertTrue(book["text"].endswith("The last line."))

    def test_real_long_entries_are_whole(self):
        corpus = core.build_corpus(ARCHIVE_DIR, include_issue_bodies=True)
        texts = {}
        for entry in corpus["currently"]:
            texts.setdefault(str(entry["issue_number"]), []).append(entry["text"])
        self.assertTrue(any("Rag and Bone" in text for text in texts["132"]))
        self.assertTrue(any("101 Famous Poems" in text for text in texts["132"]))
        self.assertTrue(any("MrBeast" in text for text in texts["248"]))
        self.assertGreaterEqual(sum(len(text) > 400 for t in texts.values() for text in t), 20)


NOW_READING = """## Notable

### [A link](https://example.com/a)

Commentary.

## Now Reading 📚

[![image](https://assets.example/cover.jpg)](http://www.amazon.com/dp/1631490168/)

### [American Eclipse](http://www.amazon.com/dp/1631490168/)

by David Baron

*A blurb.* We are going to St. Louis to see [the eclipse](https://eclipse.example/).

## Now Reading 📚

https://www.amazon.com/Collapse/dp/0143117009/

Collapse ()
by Jared Diamond

My book club is going back to Jared Diamond.

## Currently

**Reading:** [Some Book](https://example.com/book)
"""


class NowReadingEraTests(unittest.TestCase):
    """QA 2026-09-30 (ingest F12, approved by Jamie): the 2017-2018 "Now
    Reading 📚" sections (WT8-77) were in no Currently entry, so
    currently_history started reading in 2018."""

    def test_now_reading_books_are_reading_entries(self):
        entries = core.extract_now_reading_entries(NOW_READING)
        self.assertEqual([e["kind"] for e in entries], ["reading", "reading"])
        self.assertTrue(entries[0]["text"].startswith("American Eclipse by David Baron"))
        self.assertEqual(
            [link["url"] for link in entries[0]["links"]],
            ["http://www.amazon.com/dp/1631490168/", "https://eclipse.example/"],
        )
        self.assertTrue(entries[1]["text"].startswith("Collapse () by Jared Diamond"))
        self.assertEqual(
            [link["url"] for link in entries[1]["links"]],
            ["https://www.amazon.com/Collapse/dp/0143117009/"],
        )

    def test_every_now_reading_issue_has_an_entry(self):
        corpus = core.build_corpus(ARCHIVE_DIR, include_issue_bodies=True)
        reading_era = {
            issue["number"]
            for issue in corpus["issues"]
            if re.search(r"^## (Now Reading|Reading 📚)", issue["body"], re.M)
        }
        with_entries = {
            entry["issue_number"] for entry in corpus["currently"] if entry["kind"] == "reading"
        }
        self.assertEqual(len(reading_era), 17)
        self.assertLessEqual(reading_era, with_entries)


if __name__ == "__main__":
    unittest.main()
