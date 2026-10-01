"""A media item's context reads as prose, not HTML.

plain_text strips ">" (blockquote markers) but kept HTML tags, so a context
line of HTML came out as tag soup with only its ">" gone. Found live in a
2.2.0 media_search result: "<pPOAP <a href="https://collectors.poap.xyz/
token/7284931"7284931</a at <strong<a ...", on 333 blog and 13 Weekly Thing
media items. A line of markup alone is passed over for the next line with
words in it.
"""

import re
import tempfile
import unittest
from pathlib import Path

from librarian_core import corpus as core
from librarian_core.paths import ARCHIVE_DIR

POAP_IMAGE = "https://www.thingelstad.com/uploads/2025/women-in-tech-night-out.png"
POAP = (
    '<p>POAP <a href="https://collectors.poap.xyz/token/4765283">4765283</a> at '
    '<strong><a href="https://poap.gallery/drops/40021">Women in Tech Night Out '
    "(April 2022)</a></strong>.</p>\n"
    f'<img src="{POAP_IMAGE}" alt="A badge" width="500" height="500" />'
)
TAG_SOUP = re.compile(r"</?[a-zA-Z][a-zA-Z0-9]*[\s/>]|&(?:[a-z]+|#\d+);")


class MediaContextHtmlTests(unittest.TestCase):
    def test_poap_line(self):
        self.assertEqual(
            core._media_context(POAP, POAP_IMAGE),
            "POAP 4765283 at Women in Tech Night Out (April 2022).",
        )

    def test_markup_only_lines_are_passed_over(self):
        image = "https://www.thingelstad.com/uploads/2024/c73eecb561.png"
        body = (
            f"![]({image})\n"
            '<video controls="controls" playsinline="playsinline" '
            'src="https://www.thingelstad.com/uploads/2024/5b5e9882e0.mov" '
            f'poster="{image}" preload="none"></video>\n'
            '<br clear="all">\n'
            "</audio></p>\n"
            "<p>A Z scale train on the <em>#TeamSPS</em> layout &amp; more.</p>\n"
        )
        self.assertEqual(
            core._media_context(body, image),
            "A Z scale train on the #TeamSPS layout & more.",
        )

    def test_br_after_caption_and_autolinks(self):
        image = "https://files.thingelstad.com/weekly-thing/20200613.jpg"
        self.assertEqual(
            core._media_context(f"![]({image})\n\nJun 12, 2020 at 8:42 PM <br/>\n", image),
            "Jun 12, 2020 at 8:42 PM",
        )
        self.assertEqual(
            core._media_context(f'![]({image})\n<br clear="all">\n', image),
            "",
        )
        self.assertEqual(
            core._media_context(f"![]({image})\nSee <https://example.com/x>.\n", image),
            "See https://example.com/x.",
        )

    def test_blog_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp) / "posts" / "2022"
            posts.mkdir(parents=True)
            (posts / "poap.md").write_text(
                '---\nmicroblog_id: 5474375\nurl: "https://www.thingelstad.com/2022/04/20/'
                'poap-at-women-in-tech.html"\ntitle: ""\npublished: "2022-04-20T22:55:20+00:00"\n'
                f"post_kind: micropost\n---\n\n{POAP}\n",
                encoding="utf-8",
            )
            archive = Path(tmp) / "archive"
            archive.mkdir()
            corpus = core.build_blog_corpus(blog_dir=Path(tmp) / "posts", archive_dir=archive)
        self.assertEqual(
            [item["context"] for item in corpus["media"]],
            ["POAP 4765283 at Women in Tech Night Out (April 2022)."],
        )


class RealMediaContextTests(unittest.TestCase):
    def test_no_tag_soup_in_real_media_context(self):
        wt = core.build_corpus(ARCHIVE_DIR)
        blog = core.build_blog_corpus()
        soup = [
            (item.get("issue_number") or item.get("microblog_id"), item["context"][:60])
            for item in wt["media"] + blog["media"]
            if TAG_SOUP.search(item.get("context") or "")
        ]
        self.assertEqual(soup, [])


if __name__ == "__main__":
    unittest.main()
