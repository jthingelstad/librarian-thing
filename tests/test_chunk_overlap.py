"""A chunk's overlap lead-in is verbatim text, never a de-punctuated copy.

Review defect 15 (docs/REVIEW-2026-09-29-mcp-corpus.md): chunk_section built
each continuation chunk's overlap as " ".join(words(previous)[-60:]), so
search_archive hits for WT302 and its blog twin opened with "com archive 300
of the Weekly Thing https weekly thingelstad com I sent...", and entity_lens
showed the 2007 OpenID post's sentence twice, once stripped. The overlap is
now the previous chunk's own tail, starting at a sentence or line boundary.
"""

import unittest
from pathlib import Path

from librarian_core import corpus as core

REPO = Path(__file__).resolve().parents[1]

WT302 = (
    "On November 9th I sent the [300th issue](https://weekly.thingelstad.com/archive/300/) "
    "of the [Weekly Thing](https://weekly.thingelstad.com). I sent the very "
    "[1st issue](https://weekly.thingelstad.com/archive/weekly-thing-for-may-13-2017/) on "
    "May 13, 2017. It took 7 years 5 months 3 weeks and 6 days to get to 300."
)
TOKEN_SOUP = ("https weekly thingelstad com", "com archive 300")


def _lead_in(previous: str, current: str) -> str:
    """The longest suffix of ``previous`` that ``current`` starts with."""
    for index in range(len(previous)):
        if current.startswith(previous[index:]):
            return previous[index:]
    return ""


def _assert_verbatim_overlaps(test: unittest.TestCase, chunks: list[str], overlap_words: int):
    for previous, current in zip(chunks, chunks[1:]):
        lead_in = _lead_in(previous, current)
        test.assertTrue(lead_in, f"no verbatim lead-in: {current[:120]!r}")
        test.assertLessEqual(len(core.words(lead_in)), overlap_words)
    for chunk in chunks:
        for soup in TOKEN_SOUP:
            test.assertNotIn(soup, chunk)


class ChunkOverlapTests(unittest.TestCase):
    def test_overlap_is_a_verbatim_suffix_not_token_soup(self):
        text = "\n\n".join(
            [
                ("Filler sentence number one is here. " * 4).strip(),
                WT302,
                "So, what have I learned from sending 300 newsletters? What insights have I gleaned?",
            ]
        )
        for overlap_words in (12, 30, 60):
            chunks = core.chunk_section(text, max_words=60, overlap_words=overlap_words)
            self.assertEqual(len(chunks), 3)
            _assert_verbatim_overlaps(self, chunks, overlap_words)

    def test_overlap_starts_at_a_sentence_boundary(self):
        text = "\n\n".join(
            [
                ("Filler sentence number one is here. " * 4).strip(),
                WT302,
                "So, what have I learned from sending 300 newsletters?",
            ]
        )
        chunks = core.chunk_section(text, max_words=60, overlap_words=30)
        self.assertTrue(chunks[2].startswith("It took 7 years 5 months"), chunks[2][:80])

    def test_overlap_never_starts_inside_a_link_or_tag(self):
        long_sentence = (
            "word " * 30
        ) + "see [a long link title](https://example.com/x) and more after it"
        self.assertEqual(core._overlap_tail(long_sentence, 10), "and more after it")
        tagged = '<img src="a.jpg" alt="A boat. On a lake at dusk with friends"> caption words here'
        self.assertEqual(core._overlap_tail(tagged, 8), "caption words here")

    def test_short_previous_chunk_is_repeated_whole(self):
        self.assertEqual(core._overlap_tail("Just a few words.", 60), "Just a few words.")
        self.assertEqual(core._overlap_tail("", 60), "")


class ArchiveOverlapRegressionTests(unittest.TestCase):
    """The two live sightings, rebuilt from data/."""

    def _chunks(self, path: Path) -> list[list[str]]:
        if not path.exists():
            self.skipTest(f"{path} not in this checkout")
        _metadata, body = core.read_issue(path)
        return [core.chunk_section(section) for _name, section in core.split_sections(body)]

    def test_wt302_journal_continuation_opens_with_the_sentence(self):
        sections = self._chunks(REPO / "data" / "issues" / "302" / "archive.md")
        for chunks in sections:
            _assert_verbatim_overlaps(self, chunks, 60)
        openers = [c[:59] for chunks in sections for c in chunks[1:] if "1st issue" in c[:120]]
        self.assertEqual(openers, ["I sent the very [1st issue](https://weekly.thingelstad.com/"])

    def test_blog_twin_and_openid_post_have_no_stripped_duplicate(self):
        for relative in (
            "2024/11/2024-11-17-thoughts-after-writing.md",
            "2007/05/2007-05-11-openid-makes-identity.md",
        ):
            path = REPO / "data" / "blog" / "posts" / relative
            if not path.exists():
                self.skipTest(f"{path} not in this checkout")
            _metadata, body = core.read_issue(path)
            chunks = core.chunk_section(core._blog_embed_text(body))
            self.assertGreater(len(chunks), 1)
            _assert_verbatim_overlaps(self, chunks, 60)
            self.assertNotIn("Simon Willison http simonwillison", " ".join(chunks))


if __name__ == "__main__":
    unittest.main()
