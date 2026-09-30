"""Every labelled Currently line is an entry.

QA 2026-09-30 (ingest F12): the Currently extractor read only "**Label:**"
with the colon inside the bold, so ten "**Dining**: ..." / "**Making**:" /
"**Waiting**:" lines from 2022-2025 were dropped, and five Currently
sections gave no entries at all.
"""

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


if __name__ == "__main__":
    unittest.main()
