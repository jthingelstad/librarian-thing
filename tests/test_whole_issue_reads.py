"""Topics, entities and tropes read the whole issue.

QA 2026-09-30 (ingest F14, approved by Jamie): an issue's topic clusters
came from its first 12,000 characters, its graph entities from the first
14,000 and 24 links, its tropes from the first 20,000 and a Bedrock
extraction from the first 18,000. 301 issues are longer than 12,000; 28.8%
of Weekly Thing text was past the entity window (Big Green Egg in WT9,
MNUFC in WT19 were in no entity).
"""

import json
import unittest
from unittest import mock

from librarian_core import corpus as core
from librarian_core import graph

FILLER = "Nothing much happened on a quiet ordinary day here. " * 400  # ~21,000 chars
TAIL = (
    "We grilled on the Big Green Egg again. The Big Green Egg is great. "
    "Bitcoin and Ethereum wallets, a crypto wallet and a token. "
    "I keep an archive of links in Pinboard, my database of memory."
)


def _issue() -> dict:
    return {
        "number": 9,
        "subject": "Weekly Thing 9",
        "publish_date": "2017-07-08",
        "body": f"## Journal\n\n{FILLER}\n\n{TAIL}\n",
        "links": [
            {"text": f"Link {n}", "domain": f"site{n}.example", "url": f"https://site{n}.example/"}
            for n in range(30)
        ],
    }


class WholeIssueTests(unittest.TestCase):
    def test_topics_read_past_12000_characters(self):
        issue = _issue()
        self.assertGreater(issue["body"].index(TAIL), 20000)
        self.assertIn("Crypto and web3", core.detect_topics("", issue["body"]))
        self.assertIn("Crypto and web3", core.detect_topics("", core.topic_prose(issue["body"])))

    def test_topics_do_not_read_urls(self):
        body = "A note. " + " ".join(f"https://micro.blog/rss/feed{n}" for n in range(5))
        self.assertEqual(core.detect_topics("", core.topic_prose(body)), [])

    def test_entities_read_the_whole_issue_and_every_link(self):
        entities = graph.heuristic_entities(_issue())
        self.assertIn("Big Green Egg", entities)
        self.assertIn("site29.example", entities)

    def test_tropes_read_the_whole_issue(self):
        self.assertIn("durable archives", graph.heuristic_tropes(_issue()))

    def test_bedrock_extraction_gets_the_whole_issue(self):
        seen = {}

        class FakeClient:
            def converse(self, **kwargs):
                seen["prompt"] = kwargs["messages"][0]["content"][0]["text"]
                return {
                    "output": {
                        "message": {
                            "content": [{"text": json.dumps({"entities": [], "tropes": []})}]
                        }
                    }
                }

        with mock.patch.object(graph.boto3, "client", return_value=FakeClient()):
            graph.extract_with_bedrock(_issue(), "model")
        self.assertIn(TAIL, seen["prompt"])


if __name__ == "__main__":
    unittest.main()
