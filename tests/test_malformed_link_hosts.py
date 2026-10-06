"""Typos in a link never make a domain of their own.

QA 2026-09-30 (links L6): 29 blog links read "https://https://www.thingelstad
.com/candles/" and were stored with domain "https" (ranked as a top external
site, missing from thingelstad.com and the candles URL). "ttps://..." kept
an unusable URL, "https://www.hwardmiles.com." counted as a separate domain,
and "http://carcassonne:///f/..." gave the domain "carcassonne".
"""

import json
import re
import unittest

from librarian_core import corpus as core
from librarian_core.links import repair_url, web_domain
from librarian_core.paths import ARCHIVE_DIR, BLOG_DIR, PODCAST_DIR


class RepairUrlTests(unittest.TestCase):
    def test_repairs(self):
        cases = {
            "https://https://www.thingelstad.com/candles/": "https://www.thingelstad.com/candles/",
            "http://https://x.example/a": "https://x.example/a",
            "ttps://blog.coinbase.com/2015/11/20/x/": "https://blog.coinbase.com/2015/11/20/x/",
            "https://www.hwardmiles.com.": "https://www.hwardmiles.com",
            # the blogroll page (2026-10-01)
            "htttps://weekly.thingelstad.com": "https://weekly.thingelstad.com",
            "https://www.hwardmiles.com./a?b=1": "https://www.hwardmiles.com/a?b=1",
        }
        for url, fixed in cases.items():
            self.assertEqual(repair_url(url), fixed)

    def test_good_urls_are_untouched(self):
        for url in (
            "https://1.1.1.1",
            "https://x.example/a?b=1&c=%20#frag",
            "https://en.wikipedia.org/wiki/Elf_(film)",
            "/weekly-thing/",
            "https://httptoolkit.tech/blog/http-wtf/",
        ):
            self.assertEqual(repair_url(url), url)

    def test_web_domain(self):
        self.assertEqual(web_domain("https://www.thingelstad.com/candles/"), "www.thingelstad.com")
        self.assertEqual(web_domain("https://1.1.1.1"), "1.1.1.1")
        self.assertEqual(web_domain("http://carcassonne:///f/19be897d13137244"), "")
        self.assertEqual(web_domain("https://https//www.thingelstad.com/"), "")

    def test_blog_link_records(self):
        body = (
            "[Things 4 Good](https://https://www.thingelstad.com/candles/) and "
            "[Shift](ttps://blog.coinbase.com/2015/11/20/introducing-the-shift-card/) and "
            "[H. Ward Miles](https://www.hwardmiles.com)[www.hwardmiles.com.](https://www.hwardmiles.com.)"
        )
        records = core._blog_outbound_links(
            body,
            microblog_id=1,
            subject="s",
            publish_date="2022-11-06",
            post_kind="micropost",
            post_url="https://www.thingelstad.com/2022/11/06/x.html",
            post_lookup={},
        )
        self.assertEqual(
            [(r["url"], r["domain"], r["link_kind"]) for r in records],
            [
                ("https://www.thingelstad.com/candles/", "www.thingelstad.com", "internal"),
                (
                    "https://blog.coinbase.com/2015/11/20/introducing-the-shift-card/",
                    "blog.coinbase.com",
                    "external",
                ),
                ("https://www.hwardmiles.com", "www.hwardmiles.com", "external"),
            ],
        )


class RealCorporaDomainTests(unittest.TestCase):
    def test_no_link_has_a_malformed_domain(self):
        wt = core.build_corpus(ARCHIVE_DIR, include_issue_bodies=True)
        blog = core.build_blog_corpus(BLOG_DIR, ARCHIVE_DIR)
        podcast = core.build_podcast_corpus(PODCAST_DIR)
        links = wt["links"] + blog["links"] + podcast["links"]
        bad = [
            (link["url"], link["domain"])
            for link in links
            if link["domain"] in {"https", "http"}
            or link["domain"].endswith(".")
            or ("." not in link["domain"] and link["domain"] != "localhost")
            or not link["url"].lower().startswith(("http://", "https://"))
        ]
        self.assertEqual(bad, [], json.dumps(bad[:5]))
        # The 29 doubled-scheme links are the candles page's again: every post
        # whose source names the page links it, however the link was typed.
        linking = {
            str(link["microblog_id"])
            for link in blog["links"]
            if link.get("microblog_id")
            and link["url"].rstrip("/") == "https://www.thingelstad.com/candles"
        }
        naming = set()
        for path in BLOG_DIR.rglob("*.md"):
            text = path.read_text(encoding="utf-8")
            if "thingelstad.com/candles" in text:
                naming.add(re.search(r'^microblog_id:\s*"?(\d+)', text, re.M).group(1))
        self.assertEqual(linking, naming)
        self.assertGreaterEqual(len(linking), 29)


if __name__ == "__main__":
    unittest.main()
