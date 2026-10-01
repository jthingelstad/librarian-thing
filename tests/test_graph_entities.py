"""Graph entities are names from the issue's words, each issue listed once.

QA 2026-09-30 (ingest F13): the entity regex read URLs, so a signed image
URL (``?AWSAccessKeyId=AKIA...&Signature=...&Expires=...``) made
"AWSAccessKeyId", "Expires" and "AKIA...&Signature" entities of WT3-21,
and "following&tab" one of WT193. entity_index also listed an issue twice
when two of its entities shared a lowercase key ("Micro.blog" and the
domain micro.blog), in 12 lists.

QA round 2 (ingest I2-2): with links unwrapped, a Journal time label ran
into the next line or label, so "PM We" (69 issues), "PM Saturday" (54) and
25 more clock phrases became topics with public pages.
"""

import re
import unittest

from librarian_core import graph
from librarian_core.corpus import build_corpus
from librarian_core.paths import ARCHIVE_DIR

SIGNED = (
    "https://assets.buttondown.email/61dxQnj2kzL.jpg?AWSAccessKeyId=AKIAJEXF6S6TCOKT7N3Q"
    "&Signature=VWPWjTZujXfZDcLsoDBSl0Ncj0U%3D&Expires=1707554322"
)
BODY = f"""## Now Reading 📚

[![image]({SIGNED})](http://www.amazon.com/dp/1631490168/?tag=thingelstad01-20)

### [American Eclipse](http://www.amazon.com/dp/1631490168/)

I love Micro.blog and the Big Green Egg grill, see https://twitter.com/x?ref=Following&Tab=Home and
<a href="https://Example.com/?Q=Upper">Anchor Text</a> or www.Example.com/Path.
"""


def _issue(number: int) -> dict:
    return {
        "number": number,
        "subject": f"Weekly Thing {number}",
        "body": BODY,
        "links": [{"domain": "micro.blog", "text": "Micro.blog"}],
    }


class GraphEntityTests(unittest.TestCase):
    def test_urls_are_not_entities(self):
        entities = graph.heuristic_entities(_issue(8))
        lowered = {entity.lower() for entity in entities}
        for junk in ("awsaccesskeyid", "expires", "signature", "following&tab", "upper", "path"):
            self.assertFalse([e for e in lowered if junk in e], junk)
        self.assertIn("Big Green Egg", entities)
        self.assertIn("Anchor Text", entities)
        self.assertIn("American Eclipse", entities)

    def test_entity_text_keeps_labels_and_drops_urls(self):
        text = graph.entity_text(BODY)
        self.assertNotIn("http", text)
        self.assertNotIn("AWSAccessKeyId", text)
        self.assertIn("American Eclipse", text)
        self.assertIn("image", text)

    def test_entity_index_lists_each_issue_once(self):
        built = graph.build_graph({"issues": [_issue(8), _issue(9)], "chunks": []})
        for key, numbers in built["entity_index"].items():
            self.assertEqual(len(numbers), len(set(numbers)), key)
        self.assertEqual(built["entity_index"]["micro.blog"], ["8", "9"])
        self.assertFalse([k for k in built["entity_index"] if re.search(r"akia|awsaccess", k)])

    def test_clock_labels_are_not_entities(self):
        issue = {
            "number": 44,
            "subject": "Weekly Thing 44",
            "body": "## Journal\n\n[Saturday @ 7:16 PM](https://www.thingelstad.com/2019/x.html)\n\n"
            "We went to see Brandi Carlile with Tammy.\n\n[Sunday @ 9:02 AM](https://x.example/)\n",
            "links": [{"text": "Saturday @ 7:16 PM"}, {"text": "Sunday @ 9:02 AM"}],
        }
        entities = graph.heuristic_entities(issue)
        self.assertEqual([e for e in entities if re.search(r"^(AM|PM)\b|\b(AM|PM)$", e)], [])
        self.assertIn("Brandi Carlile", entities)
        self.assertIn("Tammy", entities)

    def test_real_archive_graph(self):
        corpus = build_corpus(ARCHIVE_DIR, include_issue_bodies=True)
        index = graph.build_graph(corpus)["entity_index"]
        junk = [
            key
            for key in index
            if re.search(r"awsaccesskeyid|akia[0-9a-z]{12}|&signature|following&tab", key)
            or key == "expires"
            or re.search(r"^(am|pm) | (am|pm)$", key)
        ]
        self.assertEqual(junk, [])
        self.assertEqual([k for k, v in index.items() if len(v) != len(set(v))], [])


if __name__ == "__main__":
    unittest.main()
