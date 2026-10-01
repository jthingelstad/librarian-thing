"""Every word of every chunk is inside its embedding.

QA 2026-09-30 (ingest F1): Bedrock's Cohere embed takes at most 2,048
characters a text, and fetch_bedrock_embeddings cut each input there. The
input is a header (issue, date, issue summary, section) plus the chunk
text, and chunks ran to 5,230 characters, so 8.7% of Weekly Thing words and
2.3% of blog words were in no embedding. Chunks are now sized to the room
their own header leaves (embed_text_budget), and a chunk that already fit
is built exactly as before, so its id and embedding stay.

That bounds characters only. The model also stops at 512 tokens (QA2 I2-4),
and about one input in eleven runs past it; test_embed_tokens.py pins that
the build and the corpus gate count those.
"""

import json
import tempfile
import unittest
from pathlib import Path

from librarian_core import corpus as core
from librarian_core.paths import ARCHIVE_DIR, BLOG_DIR

LIMIT = core.COHERE_EMBED_MAX_TEXT_CHARS


def _without_lead_in(previous: str, text: str) -> str:
    """The Lambda's reassembly rule (archive-tools.mts withoutLeadIn): drop
    the longest run of whole paragraphs the previous chunk already ends with."""
    if not previous:
        return text
    cut = 0
    at = text.find("\n\n")
    while at > 0:
        if previous.endswith(text[:at].strip()):
            cut = at
        at = text.find("\n\n", at + 2)
    if not cut and previous.endswith(text):
        return ""
    return text[cut:].strip() if cut else text


def _rejoined(chunks: list[str]) -> str:
    parts, previous = [], ""
    for chunk in chunks:
        kept = _without_lead_in(previous, chunk)
        if kept:
            parts.append(kept)
        previous = chunk
    return " ".join(" ".join(parts).split())


def _fold(text: str) -> str:
    return " ".join(text.split())


SENTENCE = "The quick brown fox considered the lazy dog for a long while. "
LINK = "[A headline about something](https://example.com/2018/04/16/a-long-slug-here/)"


class ChunkSectionCharCapTests(unittest.TestCase):
    def test_chunks_fit_the_cap_and_rejoin_to_the_text(self):
        text = "\n\n".join(
            [
                SENTENCE * 20,  # one paragraph far over the cap
                "A short paragraph.",
                " · ".join([LINK] * 40),  # a run-on line of links, no sentence end
                SENTENCE * 3,
            ]
        )
        chunks = core.chunk_section(text, max_chars=900)
        self.assertGreater(len(chunks), 3)
        for chunk in chunks:
            self.assertLessEqual(len(chunk), 900)
        self.assertEqual(_rejoined(chunks), _fold(text))

    def test_long_paragraphs_split_at_sentence_ends_and_never_inside_a_link(self):
        chunks = core.chunk_section(SENTENCE * 40, max_chars=700, overlap_words=0)
        for chunk in chunks:
            self.assertTrue(chunk.endswith("while."), chunk[-40:])
        linked = core.chunk_section(" ".join([LINK] * 40), max_chars=500, overlap_words=0)
        for chunk in linked:
            self.assertTrue(chunk.startswith("[A headline"), chunk[:40])
            self.assertTrue(chunk.endswith("-here/)"), chunk[-40:])

    def test_a_single_overlong_token_is_still_cut_to_fit(self):
        text = "x" * 2500
        chunks = core.chunk_section(text, max_chars=1000)
        self.assertEqual("".join(chunks), text)
        self.assertTrue(all(len(chunk) <= 1000 for chunk in chunks))

    def test_a_section_that_fits_is_chunked_exactly_as_before(self):
        text = "\n\n".join([SENTENCE * 3] * 12)
        uncapped = core.chunk_section(text, max_words=120)
        self.assertTrue(all(len(chunk) <= 2000 for chunk in uncapped))
        self.assertEqual(core.chunk_section(text, max_words=120, max_chars=2000), uncapped)
        self.assertEqual(core.chunk_section("Short.", max_chars=2000), ["Short."])

    def test_budget_is_the_room_under_the_header(self):
        chunk = {
            "issue_number": 42,
            "subject": "Weekly Thing 42",
            "publish_date": "2018-01-01",
            "issue_abstract": "An abstract. " * 30,
            "section": "Notable",
        }
        budget = core.embed_text_budget(chunk)
        self.assertEqual(len(core._embed_input({**chunk, "text": "x" * budget})), LIMIT)


class BuiltCorporaFitTests(unittest.TestCase):
    def test_fixture_corpora_fit(self):
        long_section = "\n\n".join([SENTENCE * 12] * 8)
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "archive"
            (archive / "1").mkdir(parents=True)
            (archive / "1" / "archive.md").write_text(
                "---\nnumber: 1\nsubject: Weekly Thing 1\npublish_date: 2017-05-13\n---\n\n"
                f"## Notable\n\n### A long item\n\n{long_section}\n",
                encoding="utf-8",
            )
            blog = Path(tmp) / "posts" / "2018" / "04"
            blog.mkdir(parents=True)
            (blog / "2018-04-02-long.md").write_text(
                "---\nmicroblog_id: 7\n"
                'url: "https://www.thingelstad.com/2018/04/02/long.html"\n'
                'title: "Long"\npublished: "2018-04-02T12:00:00+00:00"\n'
                "post_kind: post\ncategories: []\n---\n\n"
                f"{long_section}\n",
                encoding="utf-8",
            )
            podcast = Path(tmp) / "episodes"
            podcast.mkdir()
            (podcast / "001.json").write_text(
                json.dumps(
                    {
                        "number": 1,
                        "title": "Episode one",
                        "publish_date": "2026-01-01",
                        "url": "https://another.thingelstad.com/2026/01/01/one/",
                        "summary": "A summary. " * 20,
                        "transcript_text": long_section,
                    }
                ),
                encoding="utf-8",
            )
            corpora = [
                core.build_corpus(archive, include_issue_bodies=True),
                core.build_blog_corpus(blog_dir=Path(tmp) / "posts", archive_dir=archive),
                core.build_podcast_corpus(podcast),
            ]
        for corpus in corpora:
            self.assertGreater(len(corpus["chunks"]), 1)
            for chunk in corpus["chunks"]:
                self.assertLessEqual(len(core._embed_input(chunk)), LIMIT, chunk["id"])

    def test_real_archive_and_blog_fit(self):
        for corpus in (
            core.build_corpus(ARCHIVE_DIR, include_issue_bodies=True),
            core.build_blog_corpus(BLOG_DIR, ARCHIVE_DIR),
        ):
            over = [
                chunk["id"] for chunk in corpus["chunks"] if len(core._embed_input(chunk)) > LIMIT
            ]
            self.assertEqual(over, [])


if __name__ == "__main__":
    unittest.main()
