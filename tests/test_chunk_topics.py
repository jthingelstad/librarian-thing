"""Each passage carries its own clusters, not its issue's.

QA 2026-09-30 (retrieval Q1): every Weekly Thing chunk inherited its issue's
clusters, and because every issue links some micro.blog or blog URL, "Open
web and RSS" sat on 8,856 of 8,895 chunks, so search_archive's topic filter
barely narrowed ("coffee" + "Open web and RSS" returned "Reflections on No
Coffee"). Chunks now get the same nine clusters from the same detector, read
over their own heading and prose. Issue records keep the issue's clusters.
"""

import tempfile
import unittest
from pathlib import Path

from librarian_core import corpus as core

COFFEE = (
    "I gave up coffee this month. Mornings are slower and I sleep better.\n\n"
    "![](https://cdn.uploads.micro.blog/890/2018/coffee.jpg) "
    "[→](https://www.thingelstad.com/2018/06/01/no-coffee.html)"
)
AI = "Claude and other AI agents are changing how I write software. The model is good."
RSS = "I read everything through RSS. My feed reader holds every blog I follow."


class ChunkTopicsTests(unittest.TestCase):
    def test_urls_and_tags_are_not_the_passages_words(self):
        self.assertEqual(core.chunk_topics("Saturday @ 9:00 AM", COFFEE), [])
        self.assertIn("Open web and RSS", core.chunk_topics("Reading", RSS))

    def test_micro_blog_is_the_microblog_keyword(self):
        topics = core.chunk_topics("Microblog updates", "I moved my posts to micro.blog this week.")
        self.assertIn("IndieWeb and personal sites", topics)

    def test_issue_chunks_get_their_own_clusters(self):
        crypto = "Bitcoin and Ethereum wallets. " * 30
        travel = "Our trip to the lake, the city museum and the hotel. " * 30
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "archive"
            (archive / "1").mkdir(parents=True)
            (archive / "1" / "archive.md").write_text(
                "---\nnumber: 1\nsubject: Weekly Thing 1\npublish_date: 2018-06-02\n---\n\n"
                f"## Journal\n\n### Saturday @ 9:00 AM\n\n{COFFEE}\n\n"
                f"## Notable\n\n### Agents\n\n{AI}\n\n"
                f"## Essay\n\n{crypto}\n\n{travel}\n",
                encoding="utf-8",
            )
            corpus = core.build_corpus(archive, include_issue_bodies=True)
        by_section: dict[str, list[list[str]]] = {}
        for chunk in corpus["chunks"]:
            by_section.setdefault(chunk["section"], []).append(chunk["topics"])
        self.assertEqual(by_section["Saturday @ 9:00 AM"], [[]])
        self.assertEqual(by_section["Agents"], [["AI and agents"]])
        # A section split in two: each chunk's clusters come from its own text.
        essay = by_section["Essay"]
        self.assertGreater(len(essay), 1)
        self.assertIn("Crypto and web3", essay[0])
        self.assertNotIn("Crypto and web3", essay[-1])
        self.assertIn("Travel and place", essay[-1])
        # The issue keeps the issue-level clusters, and so does the catalogue.
        issue_topics = corpus["issues"][0]["topics"]
        self.assertIn("Crypto and web3", issue_topics)
        self.assertIn("AI and agents", issue_topics)
        self.assertEqual(
            {topic["name"] for topic in corpus["topics"]},
            set(issue_topics),
        )

    def test_an_issue_is_filed_under_every_cluster_its_passages_carry(self):
        # QA2 L2-7 (corpus half): the issue's own pass keeps its 6 strongest
        # clusters, so a passage labelled with a 7th left the issue unfiled.
        strong = (
            "Bitcoin and Ethereum wallets. " * 6
            + "RSS feeds and blogs on the web. " * 6
            + "Privacy, security and encryption. " * 6
            + "Productivity, OmniFocus and the workflow. " * 6
            + "The fediverse, IndieWeb and ActivityPub. " * 6
            + "Our trip to the lake and the hotel. " * 6
        )
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "archive"
            (archive / "1").mkdir(parents=True)
            (archive / "1" / "archive.md").write_text(
                "---\nnumber: 1\nsubject: Weekly Thing 1\npublish_date: 2018-06-02\n---\n\n"
                f"## Essay\n\n{strong}\n\n## Notable\n\n### Claude\n\nA new model.\n",
                encoding="utf-8",
            )
            corpus = core.build_corpus(archive, include_issue_bodies=True)
        self.assertNotIn(
            "AI and agents", core.detect_topics("Weekly Thing 1", core.topic_prose(strong))
        )
        labelled = {topic for chunk in corpus["chunks"] for topic in chunk["topics"]}
        self.assertIn("AI and agents", labelled)
        issue = corpus["issues"][0]
        self.assertTrue(labelled <= set(issue["topics"]), issue["topics"])
        self.assertEqual(issue["summary"]["topics"], issue["topics"])
        cards = {topic["name"]: topic["issue_numbers"] for topic in corpus["topics"]}
        self.assertEqual(cards["AI and agents"], [1])
        self.assertEqual(set(cards), set(issue["topics"]))

    def test_blog_chunks_get_clusters_from_their_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp) / "posts" / "2018" / "06"
            posts.mkdir(parents=True)
            for mid, slug, body in ((1, "rss", RSS), (2, "coffee", COFFEE)):
                (posts / f"2018-06-01-{slug}.md").write_text(
                    f"---\nmicroblog_id: {mid}\n"
                    f'url: "https://www.thingelstad.com/2018/06/01/{slug}.html"\n'
                    'title: ""\npublished: "2018-06-01T12:00:00+00:00"\n'
                    "post_kind: micropost\ncategories: []\n---\n\n"
                    f"{body}\n",
                    encoding="utf-8",
                )
            archive = Path(tmp) / "archive"
            archive.mkdir()
            corpus = core.build_blog_corpus(blog_dir=Path(tmp) / "posts", archive_dir=archive)
        topics = {chunk["microblog_id"]: chunk["topics"] for chunk in corpus["chunks"]}
        self.assertEqual(topics, {1: ["Open web and RSS"], 2: []})


if __name__ == "__main__":
    unittest.main()
