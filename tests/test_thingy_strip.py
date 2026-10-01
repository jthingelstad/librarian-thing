"""The Thingy strip holds on frames that drift from WT Builder's exact spelling.

QA 2026-10-01 round 3 (ingest F18): the strip was one regex for the exact
frame, so a nested div, a quote or case change, an extra class, or an
unclosed frame leaked Thingy's words into the corpus, and an indented or
same-line close ate Jamie's text up to the next "</div>". Every empty
heading in an issue with a Thingy block was dropped too, not only the one
the strip emptied. Real issues must be unchanged: WT350 and WT351 lose only
their two Thingy blocks (27 lines each).
"""

import difflib
import unittest

from librarian_core import corpus as core
from librarian_core.paths import ARCHIVE_DIR

J1 = "Jamie paragraph one."
J2 = "Jamie closing paragraph that must survive."
T = "Thingy says hello."


def strip(body):
    return core.strip_thingy_blocks(body)


class ThingyStripTests(unittest.TestCase):
    def assertStripped(self, body, *jamie):
        out = strip(body)
        self.assertNotIn("Thingy says", out)
        self.assertNotIn("from-thingy", out.lower())
        for text in (J1, J2, *jamie):
            self.assertIn(text, out)
        return out

    def test_well_formed_frame(self):
        out = self.assertStripped(f'{J1}\n\n<div class="from-thingy">\n\n{T}\n\n</div>\n\n{J2}\n')
        self.assertEqual(out, f"{J1}\n\n{J2}\n")

    def test_nested_div_on_its_own_line(self):
        body = (
            f'{J1}\n\n<div class="from-thingy">\n\n<div class="inner">\n{T} part A\n</div>\n\n'
            f"{T} part B\n\n</div>\n\n{J2}\n"
        )
        out = self.assertStripped(body)
        self.assertNotIn("</div>", out)

    def test_class_spellings(self):
        for frame in (
            "<div class='from-thingy'>",
            '<div class="from-thingy echoes">',
            '<div class="echoes from-thingy">',
            '<div id="echoes" class="from-thingy">',
            '<DIV class="from-thingy">',
            "<div class=from-thingy>",
        ):
            with self.subTest(frame=frame):
                close = "</DIV>" if frame.startswith("<DIV") else "</div>"
                self.assertStripped(f"{J1}\n\n{frame}\n\n{T}\n\n{close}\n\n{J2}\n")

    def test_other_classes_are_not_thingy(self):
        body = f'{J1}\n\n<div class="from-thingy-label">\n\nJamie box\n\n</div>\n\n{J2}\n'
        self.assertEqual(strip(body), body)

    def test_indented_and_same_line_closes_keep_jamies_later_div(self):
        for close in (f"{T}\n\n  </div>", f"{T}</div>"):
            with self.subTest(close=close):
                body = f'{J1}\n\n<div class="from-thingy">\n\n{close}\n\n{J2}\n\n<div>\nJamie box\n</div>\n'
                self.assertStripped(body, "Jamie box", "<div>\nJamie box\n</div>")

    def test_unclosed_frame_fails_loud(self):
        for body in (
            f'{J1}\n\n<div class="from-thingy">\n\n{T}\n',
            f'{J1}\n\n<div class="from-thingy">\n\n{T}\n\n## Journal\n\n{J2}\n\n'
            '<div style="text-align:center">\nJamie centered poem\n</div>\n\nJamie after poem.\n',
        ):
            with self.subTest(body=body[-40:]):
                with self.assertRaisesRegex(ValueError, "unclosed Thingy block"):
                    strip(body)

    def test_crlf_and_two_blocks(self):
        crlf = f'{J1}\n\n<div class="from-thingy">\n\n{T}\n\n</div>\n\n{J2}\n'.replace("\n", "\r\n")
        self.assertStripped(crlf)
        two = (
            f'{J1}\n\n<div class="from-thingy">\n\n{T} 1\n\n</div>\n\n{J2}\n\n'
            f'<div class="from-thingy">\n\n{T} 2\n\n</div>\n'
        )
        self.assertEqual(self.assertStripped(two).rstrip(), f"{J1}\n\n{J2}")

    def test_only_the_heading_the_strip_emptied_goes(self):
        body = (
            "## Links\n\n## Tech\n\n### [x](https://x.test)\n\nJamie on x.\n\n"
            f'## Echoes\n\n<div class="from-thingy">\n\n{T}\n\n</div>\n\n## The end\n'
        )
        self.assertEqual(
            strip(body),
            "## Links\n\n## Tech\n\n### [x](https://x.test)\n\nJamie on x.\n\n## The end\n",
        )

    def test_a_comment_in_code_is_not_a_heading(self):
        body = f'{J1}\n\n```\n# comment\n```\n\n<div class="from-thingy">\n\n{T}\n\n</div>\n'
        self.assertEqual(strip(body).rstrip(), f"{J1}\n\n```\n# comment\n```")

    def test_real_issues_lose_only_the_thingy_blocks(self):
        touched = {}
        for path in sorted(ARCHIVE_DIR.glob("*/archive.md")):
            _, body = core.read_issue(path)
            out = strip(body)
            self.assertNotIn("from-thingy", out, path)
            if out == body:
                continue
            removed = [
                line
                for line in difflib.ndiff(body.split("\n"), out.split("\n"))
                if line.startswith("- ")
            ]
            added = [
                line
                for line in difflib.ndiff(body.split("\n"), out.split("\n"))
                if line.startswith("+ ")
            ]
            self.assertEqual(added, [], path)
            touched[path.parent.name] = len(removed)
        self.assertEqual(touched.get("350"), 27)
        self.assertEqual(touched.get("351"), 27)


if __name__ == "__main__":
    unittest.main()
