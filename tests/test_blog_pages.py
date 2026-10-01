"""micro.blog Pages join the blog corpus as their own sources (2026-10-01).

Jamie: "it is currently not pulling in my Pages from micro.blog. It is only
looking at Posts." Pages come from the Micropub ``pages`` channel. Their uids
are a separate number space from posts (page 71862 shares its number with a
post), so a page is keyed ``page_id`` and never ``microblog_id``. A page's
``published`` is its last edit, so pages are undated: ``updated``, never
``publish_date``. Family pages and pages about the website are left out.
"""

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

from librarian_core.corpus import body_hash, build_blog_corpus
from librarian_core.paths import REPO

# ingest_blog imports its sibling microblog.py, as it does when run as a script.
sys.path.insert(0, str(REPO / "pipeline" / "blog"))
spec = importlib.util.spec_from_file_location(
    "test_ingest_blog_module", REPO / "pipeline" / "blog" / "ingest_blog.py"
)
ingest_blog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ingest_blog)

PAGE_URL = "https://www.thingelstad.com/charlie-brown-tree/"
POST_URL = "https://www.thingelstad.com/2019/12/01/tree-post.html"


def _item(uid, url, content, *, name="A page", template=None, status="published"):
    props = {
        "uid": [uid],
        "url": [url],
        "name": [name],
        "content": [content],
        "published": ["2024-12-15T10:00:00-06:00"],
        "post-status": [status],
    }
    if template is not None:
        props["microblog-template"] = [template]
    return {"type": ["h-entry"], "properties": props}


class PageIngestTests(unittest.TestCase):
    def test_page_path_collapses_double_slashes(self):
        self.assertEqual(ingest_blog._page_path("https://www.thingelstad.com/about//"), "/about")
        self.assertEqual(ingest_blog._page_path("https://www.thingelstad.com/"), "/")

    def test_exclusion_reasons(self):
        excl = ingest_blog.page_exclusion
        self.assertEqual(excl("/family/kids", "Hi.", template=False), "family page")
        self.assertEqual(excl("/family", "Hi.", template=False), "family page")
        self.assertIsNone(excl("/familyish", "Real words.", template=False))
        self.assertEqual(
            excl("/pagefind", "Search.", template=False), "about the website, not content"
        )
        self.assertEqual(excl("/x", "Body.", template=True), "micro.blog template page")
        self.assertEqual(excl("/x", "  \n", template=False), "empty")
        self.assertEqual(
            excl("/x", "https://example.com/elsewhere", template=False), "redirect stub"
        )
        self.assertEqual(
            excl("/x", "- [Books](/books/)\n- [Movies](/movies/)", template=False),
            "navigation only",
        )
        self.assertIsNone(excl("/x", "- [Books](/books/)\n\nSome words of my own.", template=False))

    def test_render_page_normalises_url_and_path(self):
        page, skipped = ingest_blog.render_page(
            _item(
                71862,
                "https://www.thingelstad.com/lists//charlie-brown-tree",
                "The tree.",
                name="Charlie Brown Tree",
            )
        )
        self.assertIsNone(skipped)
        self.assertEqual(page["id"], 71862)
        self.assertEqual(page["url"], "https://www.thingelstad.com/lists/charlie-brown-tree/")
        self.assertEqual(page["path"], "pages/lists/charlie-brown-tree.md")
        self.assertEqual(page["updated"], "2024-12-15T10:00:00-06:00")

    def test_render_page_reports_exclusions_and_skips_drafts(self):
        page, skipped = ingest_blog.render_page(
            _item(5, "https://www.thingelstad.com/family/us/", "Us.")
        )
        self.assertIsNone(page)
        self.assertEqual(skipped["reason"], "family page")
        self.assertEqual(
            ingest_blog.render_page(_item(6, PAGE_URL, "Draft.", status="draft")), (None, None)
        )

    def test_colliding_paths_are_disambiguated_by_id(self):
        pages, _ = ingest_blog.render_pages(
            [
                _item(1, "https://www.thingelstad.com/books/", "One."),
                _item(2, "https://www.thingelstad.com/books//", "Two."),
            ]
        )
        self.assertEqual(sorted(p["path"] for p in pages), ["pages/books-2.md", "pages/books.md"])


class PageCorpusTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        posts = root / "posts" / "2019" / "12"
        posts.mkdir(parents=True)
        (posts / "2019-12-01-tree-post.md").write_text(
            "---\n"
            "microblog_id: 71862\n"
            f'url: "{POST_URL}"\n'
            'title: "A post about the tree"\n'
            'published: "2019-12-01T10:00:00+00:00"\n'
            "post_kind: post\n"
            "categories: []\n"
            "---\n\n"
            "We put up the [little tree](https://www.thingelstad.com/charlie-brown-tree/) again.\n",
            encoding="utf-8",
        )
        pages = root / "pages"
        pages.mkdir()
        (pages / "charlie-brown-tree.md").write_text(
            "---\n"
            "page_id: 71862\n"
            f'url: "{PAGE_URL}"\n'
            'title: "Charlie Brown Tree"\n'
            'updated: "2024-12-15T10:00:00-06:00"\n'
            "post_kind: page\n"
            "categories: []\n"
            "---\n\n"
            "The Charlie Brown tree has stood in our window every December since 2009.\n\n"
            '<img src="https://www.thingelstad.com/uploads/2020/tree.jpg" alt="The tree">\n',
            encoding="utf-8",
        )
        archive = root / "archive"
        archive.mkdir()
        self.corpus = build_blog_corpus(blog_dir=root / "posts", archive_dir=archive)

    def test_page_is_its_own_source(self):
        self.assertEqual(self.corpus["page_count"], 1)
        page = next(p for p in self.corpus["posts"] if p.get("page_id"))
        self.assertEqual(page["page_id"], 71862)
        self.assertNotIn("microblog_id", {k for k, v in page.items() if v is not None})
        self.assertIsNone(page.get("publish_date"))
        self.assertEqual(page["updated"], "2024-12-15T10:00:00-06:00")
        self.assertEqual(page["post_kind"], "page")

    def test_page_chunks_and_media_key_by_page_id(self):
        chunks = [c for c in self.corpus["chunks"] if c.get("page_id")]
        self.assertTrue(chunks)
        for chunk in chunks:
            self.assertEqual(
                chunk["id"], f"page:71862:{chunk['id'].split(':')[2]}:{body_hash(chunk['text'])}"
            )
            self.assertIsNone(chunk.get("microblog_id"))
            self.assertEqual(chunk["section"], "Page")
        media = [m for m in self.corpus["media"] if m["url"].endswith("tree.jpg")]
        self.assertEqual([m.get("page_id") for m in media], [71862])
        self.assertIsNone(media[0].get("microblog_id"))
        for row in self.corpus["posts"] + self.corpus["chunks"] + self.corpus["media"]:
            self.assertFalse(row.get("page_id") and row.get("microblog_id"), row)

    def test_a_post_link_to_a_page_resolves_to_the_page(self):
        link = next(link for link in self.corpus["links"] if link.get("url") == PAGE_URL)
        self.assertEqual(link["microblog_id"], 71862)
        self.assertEqual(link["target_page_id"], 71862)
        self.assertIsNone(link.get("target_microblog_id"))


if __name__ == "__main__":
    unittest.main()
