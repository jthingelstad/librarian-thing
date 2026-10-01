"""Every link in a body is a link record, whole and pointing where it points.

QA 2026-09-30 (ingest F6-F8, links L3 and L7). The link regexes stopped a
label at its first "]" and a URL at its first ")": a linked image
``[![](img)](target)`` recorded the image as the link (text "![") and lost
the target, "Elf_(film)" was stored as "Elf_(film", a label holding "[...]"
or a space after "](" was no link at all, and <autolinks> and bare URLs were
never links. One scanner (links.markdown_links) now reads them all.
"""

import tempfile
import unittest
from pathlib import Path

from librarian_core import corpus as core
from librarian_core.links import link_label_text, markdown_links

L7 = """Intro paragraph with a [![Banff](https://cdn.example/banff.jpg)](https://t.example/banff).

Nested [x [y]](https://b.example/nested) label and a spaced [x]( https://c.example/spaced) one.

An autolink <https://d.example/auto> and a film [Elf](https://en.wikipedia.org/wiki/Elf_(film)).

An escaped [Bees](https://en.wikipedia.org/wiki/Bees_\\(film\\)) link.

A bare https://e.example/bare/path. And one in parentheses (https://f.example/x_(y)) here.

Titled [T](https://g.example/t "A title") and `https://code.example/not-a-link`.

![Just an image](https://cdn.example/plain.png)
"""

EXPECTED = [
    ("Banff", "https://t.example/banff"),
    ("x [y]", "https://b.example/nested"),
    ("x", "https://c.example/spaced"),
    ("Elf", "https://en.wikipedia.org/wiki/Elf_(film)"),
    ("Bees", "https://en.wikipedia.org/wiki/Bees_(film)"),
    ("T", "https://g.example/t"),
    ("https://d.example/auto", "https://d.example/auto"),
    ("https://e.example/bare/path", "https://e.example/bare/path"),
    ("https://f.example/x_(y)", "https://f.example/x_(y)"),
]
IMAGES = ["https://cdn.example/banff.jpg", "https://cdn.example/plain.png"]


class MarkdownLinkScannerTests(unittest.TestCase):
    def test_l7_fixture(self):
        self.assertEqual(core._markdown_html_links(L7), EXPECTED)
        self.assertEqual([image["url"] for image in core.extract_images(L7)], IMAGES)
        self.assertEqual(core.extract_images(L7)[0]["alt"], "Banff")

    def test_link_kinds_and_spans(self):
        links = markdown_links(L7)
        kinds = [link.kind for link in links]
        self.assertEqual(kinds.count("image"), 2)
        self.assertEqual(kinds.count("autolink"), 1)
        self.assertEqual(kinds.count("bare"), 2)
        linked = next(link for link in links if link.url == "https://t.example/banff")
        self.assertTrue(L7[linked.start : linked.end].startswith("[![Banff]"))

    def test_bare_url_edges(self):
        cases = {
            "See https://a.example/x.": "https://a.example/x",
            "(see https://a.example/x)": "https://a.example/x",
            "It is https://a.example/x_(y), really": "https://a.example/x_(y)",
            "**https://a.example/bold**": "https://a.example/bold",
            "at https://a.example/q?a=1&b=2!": "https://a.example/q?a=1&b=2",
        }
        for text, url in cases.items():
            self.assertEqual([link.url for link in markdown_links(text)], [url], text)

    def test_urls_that_are_not_links_of_their_own(self):
        for text in (
            '<img src="https://a.example/i.jpg">',
            '<a href="https://a.example/">https://a.example/</a>',
            "<!-- https://a.example/ -->",
            "```\nhttps://a.example/\n```",
            "`https://a.example/`",
            "[https://a.example/](https://a.example/)",
        ):
            bare = [link for link in markdown_links(text) if link.kind == "bare"]
            self.assertEqual(bare, [], text)

    def test_labels_do_not_cross_a_blank_line_or_escapes(self):
        # Not a markdown link, but the URL is still recorded, bare.
        self.assertEqual(
            [link.kind for link in markdown_links("[a\n\nb](https://a.example/)")], ["bare"]
        )
        self.assertEqual(
            [link.kind for link in markdown_links("\\[a](https://a.example/)")], ["bare"]
        )

    def test_label_text(self):
        self.assertEqual(link_label_text("![Banff](big.jpg)"), "Banff")
        self.assertEqual(link_label_text("**Bold** `code`"), "Bold code")
        self.assertEqual(
            link_label_text("Python post-Guido [LWN.net]"), "Python post-Guido [LWN.net]"
        )
        self.assertEqual(
            core.clean_heading("[Python post-Guido [LWN.net]](https://lwn.net/Articles/1/)"),
            "Python post-Guido [LWN.net]",
        )

    def test_malformed_links_in_the_archive(self):
        # Blog 5506744 and 1074891: a label pasted where the URL goes, and
        # doubled parentheses.
        self.assertEqual(
            core._markdown_html_links(
                "[Local Motion]([Island Line Trail](https://www.localmotion.org/) in town"
            ),
            [("Island Line Trail", "https://www.localmotion.org/")],
        )
        self.assertEqual(
            core._markdown_html_links("[2FA]((http://lifehacker.com/5938565/two-factor))"),
            [("2FA", "http://lifehacker.com/5938565/two-factor")],
        )


class IssueAndBlogLinkRecordTests(unittest.TestCase):
    def test_issue_links_carry_every_kind_and_no_image_urls(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "archive"
            (archive / "1").mkdir(parents=True)
            (archive / "1" / "archive.md").write_text(
                "---\nnumber: 1\nsubject: Weekly Thing 1\npublish_date: 2018-06-02\n---\n\n"
                "## Notable\n\n### [Python post-Guido [LWN.net]](https://lwn.net/Articles/1/)\n\n"
                f"{L7}\n",
                encoding="utf-8",
            )
            corpus = core.build_corpus(archive, include_issue_bodies=True)
        links = corpus["issues"][0]["links"]
        by_url = {link["url"]: link for link in links}
        self.assertEqual(by_url["https://lwn.net/Articles/1/"]["link_role"], "headline")
        self.assertEqual(
            by_url["https://lwn.net/Articles/1/"]["text"], "Python post-Guido [LWN.net]"
        )
        for _, url in EXPECTED:
            self.assertIn(url, by_url)
        self.assertFalse([link for link in links if link["text"].startswith("![")])
        self.assertFalse(set(IMAGES) & set(by_url))
        self.assertEqual(sorted(item["url"] for item in corpus["media"]), sorted(IMAGES))

    def test_blog_links_carry_every_kind(self):
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp) / "posts" / "2018" / "06"
            posts.mkdir(parents=True)
            (posts / "2018-06-01-links.md").write_text(
                "---\nmicroblog_id: 1\n"
                'url: "https://www.thingelstad.com/2018/06/01/links.html"\n'
                'title: "Links"\npublished: "2018-06-01T12:00:00+00:00"\n'
                "post_kind: post\ncategories: []\n---\n\n"
                f"{L7}\n",
                encoding="utf-8",
            )
            archive = Path(tmp) / "archive"
            archive.mkdir()
            corpus = core.build_blog_corpus(blog_dir=Path(tmp) / "posts", archive_dir=archive)
        post = corpus["posts"][0]
        self.assertEqual([(link["text"], link["url"]) for link in post["links"]], EXPECTED)
        self.assertEqual(sorted(item["url"] for item in corpus["media"]), sorted(IMAGES))


if __name__ == "__main__":
    unittest.main()
