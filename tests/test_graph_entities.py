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

QA round 2 (ingest I2-3, Jamie's Q18): entity_index kept each issue's 40
most-extracted names, and 351 of 352 issues fill the 40, so a topic's issue
count was a sample (Tesla 14 against the 25 issues that name it twice). A
topic now lists every issue that names it twice or more; which names are
topics stays the 40-name rule.
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

    def test_a_topic_lists_every_issue_that_names_it_twice(self):
        filler = " ".join(f"Name{i} x Name{i} x Name{i} x" for i in range(45))

        def issue(number, body):
            return {"number": number, "subject": f"Issue {number}", "body": body, "links": []}

        built = graph.build_graph(
            {
                "issues": [
                    issue(1, "Tesla and Tesla."),
                    issue(2, "Tesla and Tesla."),
                    issue(3, "Tesla and Tesla."),
                    # Tesla is named twice but is not among the 40 names.
                    issue(4, f"{filler} Tesla and Tesla."),
                    # Named once: not counted.
                    issue(5, f"{filler} Tesla."),
                    # Kubb is named twice in two issues: still no topic.
                    issue(6, "Kubb and Kubb."),
                    issue(7, f"{filler} Kubb, Kubb."),
                ],
                "chunks": [],
            }
        )
        self.assertNotIn("Tesla", built["issues"]["4"]["entities"])
        self.assertEqual(built["entity_index"]["tesla"], ["1", "2", "3", "4"])
        self.assertEqual(built["entity_index"]["kubb"], ["6"])
        self.assertTrue(built["entity_index_uncapped"])

    def test_a_single_link_names_its_domain_once(self):
        issue = {"number": 1, "subject": "", "body": "", "links": [{"domain": "om.co"}]}
        self.assertNotIn("om.co", graph.named_twice(issue))
        issue["links"].append({"domain": "www.om.co"})
        self.assertIn("om.co", graph.named_twice(issue))
        # Ranking still weighs a link double.
        self.assertEqual(graph.entity_counts({**issue, "links": issue["links"][:1]})["om.co"], 2)

    def test_real_archive_graph(self):
        corpus = build_corpus(ARCHIVE_DIR, include_issue_bodies=True)
        built = graph.build_graph(corpus)
        index = built["entity_index"]
        # Every topic lists every issue that names it twice, and the 40-name
        # lists still decide which names are topics.
        topics = {key for key, numbers in index.items() if len(numbers) >= graph.TOPIC_MIN_ISSUES}
        missing = []
        for issue in corpus["issues"]:
            number = str(issue["number"])
            for key in graph.named_twice(issue) & topics:
                if number not in index[key]:
                    missing.append(f"{key} WT{number}")
        self.assertEqual(missing, [])
        capped = {}
        for number, entry in built["issues"].items():
            for key in dict.fromkeys(entity.lower() for entity in entry["entities"]):
                capped.setdefault(key, []).append(number)
        self.assertEqual(topics, {key for key, numbers in capped.items() if len(numbers) >= 3})
        self.assertGreaterEqual(len(index["tesla"]), 25)
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
