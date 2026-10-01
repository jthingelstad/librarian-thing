"""The blog's HTML strip keeps code, embeds and autolinks, and drops CSS.

QA 2026-10-01 round 3 (retrieval R2-6, ingest F16): the strip removed every
"<...>", so code holding a "<" lost lines (3,429 chars in 7 posts; the
Cacti script in blog-1075044 lost AVERAGE_TIME), "<[text](url)>" links and
autolinks vanished, Hugo shortcodes were deleted with their tweet, video or
collection (349 in 328 posts), iframes never became links, and <style> CSS
became a micropost's subject and abstract (blog-1313477).
"""

import importlib.util
import tempfile
import unittest
from pathlib import Path

from librarian_core import corpus as core
from librarian_core.paths import BLOG_DIR, REPO


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gate = _load("test_blog_html_strip_gate", REPO / "pipeline" / "corpus" / "corpus_gate.py")

POST = (
    "---\nmicroblog_id: 9\n"
    'url: "https://www.thingelstad.com/2013/05/15/embeds.html"\n'
    'title: ""\npublished: "2013-05-15T12:00:00+00:00"\n'
    "post_kind: micropost\ncategories: []\n---\n\n"
    "<style>\n.embed-container { position: relative; padding-bottom: 56.25%; }\n</style>\n"
    "Watch this. Run `cat a < b` first.\n\n"
    "```bash\nif [ $A -lt 3 ]; then echo <none>; fi\nPOLL_DATA=$(tail < file)\n```\n\n"
    '{{< x user="Pinboard" id="515306258024" >}}\n\n'
    "{{< youtube wvhWkDmKWSc >}}\n\n"
    "{{< youtube id=abcDEF start=30 >}}\n\n"
    "{{< vimeo 71448666 >}}\n\n"
    '{{< collection "Wind Cave Trail" >}}\n\n'
    "<iframe src='https://embed.ted.com/talks/clifford_stoll' frameborder='0'></iframe>\n\n"
    "See <[Keybase](https://keybase.io/jthingelstad)> and <https://example.com/auto>.\n"
)


def _build(tmp: str) -> dict:
    posts = Path(tmp) / "posts" / "2013" / "05"
    posts.mkdir(parents=True)
    (posts / "2013-05-15-embeds.md").write_text(POST, encoding="utf-8")
    archive = Path(tmp) / "archive"
    archive.mkdir()
    return core.build_blog_corpus(blog_dir=Path(tmp) / "posts", archive_dir=archive)


class BlogHtmlStripTests(unittest.TestCase):
    def test_text_keeps_code_and_embeds_and_drops_css(self):
        with tempfile.TemporaryDirectory() as tmp:
            corpus = _build(tmp)
        text = "\n".join(chunk["text"] for chunk in corpus["chunks"])
        self.assertIn("if [ $A -lt 3 ]; then echo <none>; fi", text)
        self.assertIn("POLL_DATA=$(tail < file)", text)
        self.assertIn("`cat a < b`", text)
        self.assertIn("Wind Cave Trail", text)
        self.assertIn("[Keybase](https://keybase.io/jthingelstad)", text)
        self.assertIn("https://example.com/auto", text)
        self.assertNotIn("embed-container", text)
        self.assertNotIn("{{", text)
        self.assertNotIn("embed-container", corpus["posts"][0]["subject"])

    def test_embeds_are_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            corpus = _build(tmp)
        urls = {link["url"] for link in corpus["links"]}
        for url in (
            "https://twitter.com/Pinboard/status/515306258024",
            "https://www.youtube.com/watch?v=wvhWkDmKWSc",
            "https://www.youtube.com/watch?v=abcDEF&t=30s",
            "https://vimeo.com/71448666",
            "https://embed.ted.com/talks/clifford_stoll",
            "https://keybase.io/jthingelstad",
            "https://example.com/auto",
        ):
            self.assertIn(url, urls)

    def test_gate_oracle_flags_the_old_strip(self):
        with tempfile.TemporaryDirectory() as tmp:
            corpus = _build(tmp)
            self.assertEqual(gate.blog_source_failures(corpus, Path(tmp) / "posts"), [])
            for chunk in corpus["chunks"]:
                chunk["text"] = core._HTML_TAG_RE.sub(" ", chunk["text"]) + (
                    "\n.embed-container { position: relative; padding-bottom: 56.25%; }"
                )
            corpus["links"] = []
            failures = gate.blog_source_failures(corpus, Path(tmp) / "posts")
        self.assertEqual(len(failures), 3, failures)

    def test_real_cacti_script_is_whole(self):
        [path] = BLOG_DIR.glob("2011/10/2011-10-02-detect-slow-cacti.md")
        _, body = core.read_issue(path)
        text = core._blog_embed_text(body)
        self.assertIn("AVERAGE_TIME=$(($TOTAL_TIME / $TOTAL_COUNT))", text)
        self.assertIn("because the file may have < CACTI_SAMPLES in it", text)


if __name__ == "__main__":
    unittest.main()
