"""jthingelstad.micro.blog is the same blog as thingelstad.com.

Jamie, 2026-09-30. 111 posts from 2017 keep their jthingelstad.micro.blog
URLs, and the build knew micro.thingelstad.com as Jamie's blog host but not
this one, so those posts were not permalink targets: Journal entries copying
them fell back to a date match, and four blog links to them read as
malformed.
"""

import tempfile
import unittest
from pathlib import Path

from librarian_core import corpus as core
from librarian_core.domain_exclusions import is_excluded
from librarian_core.paths import ARCHIVE_DIR, BLOG_DIR

ALIAS = "http://jthingelstad.micro.blog/2017/04/28/poking-around-microblog.html"


class BlogHostAliasTests(unittest.TestCase):
    def test_alias_is_a_blog_permalink(self):
        self.assertEqual(core._blog_target_path(ALIAS), "2017/04/28/poking-around-microblog")
        self.assertTrue(core._is_thingelstad_domain("jthingelstad.micro.blog"))
        self.assertTrue(is_excluded("jthingelstad.micro.blog"))
        self.assertFalse(core._is_thingelstad_domain("someone.micro.blog"))
        self.assertEqual(
            core.journal_post_urls(f"- Poking around. [→]({ALIAS})"),
            ["https://www.thingelstad.com/2017/04/28/poking-around-microblog.html"],
        )

    def test_links_to_alias_posts_resolve(self):
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp) / "posts" / "2017"
            posts.mkdir(parents=True)
            (posts / "a.md").write_text(
                f'---\nmicroblog_id: 7664\nurl: "{ALIAS}"\ntitle: ""\n'
                'published: "2017-04-28T12:00:00+00:00"\npost_kind: micropost\n---\n\n'
                "Poking around micro.blog.\n",
                encoding="utf-8",
            )
            (posts / "b.md").write_text(
                '---\nmicroblog_id: 9\nurl: "https://www.thingelstad.com/2017/05/01/b.html"\n'
                'title: ""\npublished: "2017-05-01T12:00:00+00:00"\npost_kind: micropost\n---\n\n'
                "As I [said](https://www.thingelstad.com/2017/04/28/poking-around-microblog.html)"
                f" and [here]({ALIAS}).\n",
                encoding="utf-8",
            )
            archive = Path(tmp) / "archive"
            archive.mkdir()
            corpus = core.build_blog_corpus(blog_dir=Path(tmp) / "posts", archive_dir=archive)
            target = core.resolve_link_target(
                ALIAS, blog=core.blog_post_lookup(Path(tmp) / "posts")
            )
        self.assertEqual(target["target_microblog_id"], 7664)
        links = [link for link in corpus["links"] if link["microblog_id"] == 9]
        self.assertEqual(
            [
                (link["link_kind"], link["link_category"], link["target_microblog_id"])
                for link in links
            ],
            [("internal", "resolved_post", 7664), ("internal", "resolved_post", 7664)],
        )

    def test_real_journal_entries_match_alias_posts_by_permalink(self):
        wt = core.build_corpus(ARCHIVE_DIR, include_issue_bodies=True)
        # An entry whose permalink is the alias post's own path matches it by
        # permalink; the rest found it by date and text (merged or renamed).
        same_path = [
            entry["matched_by"]
            for issue in wt["issues"]
            for entry in issue.get("journal_entries", [])
            if "jthingelstad.micro.blog" in (entry["canonical_url"] or "")
            and core._blog_target_path(entry["url"] or "")
            == core._blog_target_path(entry["canonical_url"])
        ]
        self.assertGreaterEqual(len(same_path), 90)
        self.assertEqual(set(same_path), {"permalink"})
        alias_posts = [
            path
            for path in BLOG_DIR.rglob("*.md")
            if 'url: "http://jthingelstad.micro.blog/' in path.read_text(encoding="utf-8")[:200]
        ]
        self.assertEqual(len(alias_posts), 111)


if __name__ == "__main__":
    unittest.main()
