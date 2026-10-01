"""A heading with no text under it does not vanish.

QA 2026-09-30 (ingest F9): a section was kept only if it had body text, so
WT13's 574-word heading line (its blockquote on the heading line) and 14
H3s were in no section, and 13 of their links were in no link record.
"""

import unittest

from librarian_core import corpus as core
from librarian_core.paths import ARCHIVE_DIR


def sections(body):
    return [(s.heading, s.family, s.parent, s.text) for s in core.split_issue_sections(body)]


class EmptyHeadingTests(unittest.TestCase):
    def test_swallowed_quote_is_the_text(self):
        body = (
            "## Links 📌\n\n"
            "### [Quantify everything](https://brettterpstra.com/q/) > Ever since I wrote "
            "Slogger. [Another](https://treyhunner.com/x/)\n\n"
            "### [Next](https://example.com/n)\n\nNext text.\n"
        )
        [first, second] = core.split_issue_sections(body)
        self.assertEqual(first.heading, "Quantify everything")
        self.assertEqual(first.raw_heading, "[Quantify everything](https://brettterpstra.com/q/)")
        self.assertTrue(first.text.startswith("> Ever since I wrote Slogger."))
        self.assertEqual(second.heading, "Next")

    def test_byline_h2_folds_into_the_item(self):
        body = (
            "## Featured App 📱\n\n"
            "### [Through the Ages](https://itunes.apple.com/app/1)\n\n"
            "## by Czech Games Edition\n\nThe official adaptation.\n\n"
            "## Microblog updates 🎈\n\n- A micropost.\n"
        )
        self.assertEqual(
            sections(body),
            [
                (
                    "Through the Ages",
                    "App",
                    "Featured App 📱",
                    "by Czech Games Edition\n\nThe official adaptation.",
                ),
                ("Microblog updates 🎈", "Journal", "Microblog updates 🎈", "- A micropost."),
            ],
        )

    def test_aside_h2_opens_no_section(self):
        body = (
            "## Notable Links 📌\n\n### [A](https://a.example/)\n\n## Oh my…\n\n"
            "Quote of A.\n\n### [B](https://b.example/)\n\nAbout B.\n"
        )
        self.assertEqual(
            sections(body),
            [
                ("A", "Notable", "Notable Links 📌", "Oh my…\n\nQuote of A."),
                ("B", "Notable", "Notable Links 📌", "About B."),
            ],
        )

    def test_tweet_attribution_closes_the_previous_section(self):
        attribution = "[— Andy (@AndyJD_) November 21, 2019](https://twitter.com/AndyJD_/status/1)"
        body = (
            "## Microposts 🎈\n\n### [Thursday @ 7:17 PM](https://www.thingelstad.com/p/1)\n\n"
            f"Packed house.\n### {attribution}\n\n"
            "### [Thursday @ 7:16 PM](https://www.thingelstad.com/p/2)\n\nGreat to see.\n"
        )
        self.assertEqual(
            [(h, t) for h, _, _, t in sections(body)],
            [
                ("Thursday @ 7:17 PM", f"Packed house.\n\n{attribution}"),
                ("Thursday @ 7:16 PM", "Great to see."),
            ],
        )

    def test_date_label_leads_the_next_item(self):
        body = (
            "## Journal\n\n### Monday, May 18\n\n"
            "### [Minnesota Technology Council](https://www.thingelstad.com/p/3)\n\n9:00 PM\n"
        )
        self.assertEqual(
            sections(body),
            [
                (
                    "Minnesota Technology Council",
                    "Journal",
                    "Journal",
                    "Monday, May 18\n\n9:00 PM",
                )
            ],
        )

    def test_last_empty_item_is_title_only_and_empty_h2s_stay_dropped(self):
        body = "## Links 📌\n\n## Tech\n\n### [Only a title](https://a.example/)\n\n## The end 🎬\n"
        self.assertEqual(
            sections(body),
            [("Only a title", "Notable", "Tech", "[Only a title](https://a.example/)")],
        )

    def test_every_real_heading_is_in_a_section(self):
        missing = []
        for path in sorted(ARCHIVE_DIR.glob("*/archive.md")):
            metadata, body = core.read_issue(path)
            body = core.strip_thingy_blocks(body)
            found = core.split_issue_sections(body)
            names = {s.heading for s in found} | {s.parent for s in found}
            for match in core.HEADING_RE.finditer(body):
                raw = match.group(2).strip()
                name = core.clean_heading(raw)
                if "](" not in raw and len(name.split()) <= 3:
                    continue
                if (
                    name in names
                    or any(raw in s.text for s in found)
                    or any(s.raw_heading and raw.startswith(s.raw_heading) for s in found)
                ):
                    continue
                missing.append((metadata["number"], raw[:80]))
        self.assertEqual(missing, [])

    def test_real_links_under_empty_headings(self):
        corpus = core.build_corpus(ARCHIVE_DIR, include_issue_bodies=True)
        links = {(link["issue_number"], link["domain"]) for link in corpus["links"]}
        self.assertIn((13, "treyhunner.com"), links)
        self.assertIn((127, "twitter.com"), links)
        urls = {link["url"] for link in corpus["links"] if link["issue_number"] == 23}
        self.assertTrue(any("through-the-ages" in url for url in urls))
        slogger = [
            chunk["section"]
            for chunk in corpus["chunks"]
            if chunk["issue_number"] == 13 and "Slogger" in chunk["text"]
        ]
        self.assertEqual(
            slogger, ["Quantify everything with Exist.io custom tracking - BrettTerpstra.com"]
        )


if __name__ == "__main__":
    unittest.main()
