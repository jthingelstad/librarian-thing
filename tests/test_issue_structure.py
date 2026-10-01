"""Phase 3 corpus structure (plan 2026-09-29, items 1-4): section families
across the eras, commentary and Journal links with their targets, voice
spans, and the issue dek. None of it may move a chunk id or an embed input."""

import json
import tempfile
import unittest
from pathlib import Path

from librarian_core import corpus as core
from librarian_core.links import section_family

NBSP = " "


def _write_issue(
    archive: Path,
    number: int,
    body: str,
    *,
    links: str = "",
    publish_date: str = "2026-09-26T12:00:00Z",
) -> None:
    (archive / str(number)).mkdir(parents=True)
    (archive / str(number) / "archive.md").write_text(
        "---\n"
        f"number: {number}\n"
        f"subject: Weekly Thing {number}\n"
        f"publish_date: {publish_date}\n"
        f"slug: weekly-thing-{number}-a-slug\n"
        "description: Jamie's dek for the issue.\n"
        f"{links}"
        "---\n" + body,
        encoding="utf-8",
    )


def _write_post(blog: Path, microblog_id: int, url: str, title: str = "") -> None:
    blog.mkdir(parents=True, exist_ok=True)
    (blog / f"{microblog_id}.md").write_text(
        f'---\nmicroblog_id: {microblog_id}\nurl: "{url}"\ntitle: "{title}"\n'
        'published: "2017-05-13T12:00:00+00:00"\npost_kind: micropost\n---\n\nA post.\n',
        encoding="utf-8",
    )


class SectionFamilyTests(unittest.TestCase):
    def test_every_era_name_maps_to_its_family(self):
        cases = {
            "Notable Links 📌": "Notable",
            "Recommended Links": "Notable",
            "Links 📌": "Notable",
            "Tech": "Notable",
            "Social Media": "Notable",
            "Featured Links 🏅": "Featured",
            "Must Read": "Featured",
            "Featured": "Featured",
            "Yet More Links 🍞": "Briefly",
            "Briefly": "Briefly",
            "FYI": "FYI",
            "Microposts 🎈": "Journal",
            "Microblog updates 🎈": "Journal",
            "Status Updates": "Journal",
            "Stream": "Journal",
            "My Blog Posts ✍️": "Journal",
            "Now Reading 📚": "Currently",
            "Photog 📷": "Photo",
            "Photograph (Not Mine)": "Photo",
            "My Weekly Photo 📷": "Photo",
            "Fortune 🥠": "Fortune",
            "Replies 📬": "Reply All",
            "Promotion 🎁": "Give Back",
            "Want to support the Weekly Thing?": "Support",
            "Highlighted iOS App 📱": "App",
            "Yearly Thing 2025": "Yearly Thing",
        }
        for name, family in cases.items():
            self.assertEqual(section_family(name), family, name)
        for name in ("Photography", "Signature", "Covid-19 Links", "", None):
            self.assertIsNone(section_family(name), name)

    def test_h3_items_carry_their_h2_family(self):
        body = (
            "Intro prose.\n\n"
            "## Notable\n\n"
            "### [A Title](https://example.com/a)\n\nCommentary on A.\n\n"
            "## Microposts 🎈\n\n"
            "[Thursday @ 9:28 PM](https://www.thingelstad.com/2020/05/28/entry.html)\n\nAn entry.\n\n"
            "## Signature\n\nSigned.\n"
        )
        sections = core.split_issue_sections(body)
        self.assertEqual(
            [(s.heading, s.family, s.parent) for s in sections],
            [
                ("Issue", "Intro", "Issue"),
                ("A Title", "Notable", "Notable"),
                ("Microposts 🎈", "Journal", "Microposts 🎈"),
                ("Signature", "Signature", "Signature"),
            ],
        )
        self.assertEqual(sections[1].raw_heading, "[A Title](https://example.com/a)")
        self.assertEqual(
            core.split_sections(body),
            [(s.heading, s.text) for s in sections],
            "split_sections is unchanged",
        )

    def test_a_group_header_lends_its_family_to_the_h2s_under_it(self):
        body = (
            "## Links 📌\n\n## Tech\n\n[A link](https://example.com/t)\n\n"
            "## Kubernetes Corner\n\nMore links.\n\n## Promotion 🎁\n\nGive.\n"
        )
        families = [(s.heading, s.family) for s in core.split_issue_sections(body)]
        self.assertEqual(
            families,
            [("Tech", "Notable"), ("Kubernetes Corner", "Notable"), ("Promotion 🎁", "Give Back")],
        )

    def test_a_featured_item_is_not_a_group_header(self):
        # WT309: "## Featured" then its H3 item, then an unlisted H2.
        body = (
            "## Featured\n\n### [Item](https://example.com/f)\n\nWhy it matters.\n\n"
            "## Introducing Eric Cohn's Blog\n\nEric writes.\n"
        )
        families = [(s.heading, s.family) for s in core.split_issue_sections(body)]
        self.assertEqual(
            families,
            [
                ("Item", "Featured"),
                ("Introducing Eric Cohn's Blog", "Introducing Eric Cohn's Blog"),
            ],
        )

    def test_content_kind_follows_the_family(self):
        self.assertEqual(core.content_kind("HTML for People", "Notable"), "links")
        self.assertEqual(core.content_kind("Sunday", "Journal"), "personal")
        self.assertEqual(core.content_kind("Fortune", "Fortune"), "meta")
        self.assertEqual(core.content_kind("Issue", "Intro"), "essay")
        self.assertEqual(core.content_kind("Briefly"), "links", "no family still reads the name")


class VoiceSpanTests(unittest.TestCase):
    def test_spans_partition_the_text(self):
        text = (
            "Jamie says hi.\n\n> A quote line one.\n> line two.\n\n"
            "Back to Jamie → **[Title](https://x.com/a)**\n\n"
            "- [Other](https://y.com) y.com\nKind of weird."
        )
        spans = core.voice_spans(text, "Briefly")
        self.assertEqual(spans[0]["start"], 0)
        self.assertEqual(spans[-1]["end"], len(text))
        for before, after in zip(spans, spans[1:]):
            self.assertEqual(before["end"], after["start"])
            self.assertNotEqual(before["voice"], after["voice"])
        by_voice = {}
        for span in spans:
            by_voice.setdefault(span["voice"], []).append(text[span["start"] : span["end"]])
        self.assertEqual(by_voice["quoted"], ["> A quote line one.\n> line two."])
        self.assertIn("**[Title](https://x.com/a)**", by_voice["link"][0])
        self.assertIn("- [Other](https://y.com) y.com", by_voice["link"][0])
        self.assertTrue(all("[" not in part for part in by_voice["jamie"]))

    def test_link_lines_are_jamie_outside_link_sections(self):
        entry = "[Thursday @ 9:28 PM](https://www.thingelstad.com/2020/05/28/a.html)\n\nAn entry."
        self.assertEqual(
            core.voice_spans(entry, "Journal"), [{"voice": "jamie", "start": 0, "end": len(entry)}]
        )

    def test_a_fortune_is_quoted_and_empty_text_has_no_spans(self):
        fortune = "Here is your fortune…\n\n**Wish.**"
        self.assertEqual(
            core.voice_spans(fortune, "Fortune"),
            [{"voice": "quoted", "start": 0, "end": len(fortune)}],
        )
        self.assertEqual(core.voice_spans(""), [])


class JournalLinkTests(unittest.TestCase):
    def test_every_era_entry_style_is_an_entry(self):
        journal = "\n\n".join(
            [
                "[Thursday @ 9:28 PM](https://www.thingelstad.com/2018/02/22/one.html)",
                f"[Sep 24, 2023 at 3:40{NBSP}PM](https://www.thingelstad.com/2023/09/24/two.html)",
                "[2018-05-04 4:47 PM](https://www.thingelstad.com/2018/05/04/three.html)",
                "[5:25 PM](https://www.thingelstad.com/2026/05/16/four.html?ref=weekly-thing)",
                "[→](http://www.thingelstad.com/2017/05/13/five.html)",
                "Jamie pointing back at [an older post](https://www.thingelstad.com/2016/01/01/old.html).",
            ]
        )
        self.assertEqual(
            core.journal_post_urls(journal),
            [
                "https://www.thingelstad.com/2018/02/22/one.html",
                "https://www.thingelstad.com/2023/09/24/two.html",
                "https://www.thingelstad.com/2018/05/04/three.html",
                "https://www.thingelstad.com/2026/05/16/four.html",
                "https://www.thingelstad.com/2017/05/13/five.html",
            ],
        )

    def test_blog_path_drops_the_query(self):
        self.assertEqual(
            core._normalize_blog_path("2026/05/23/slug.html?ref=weekly-thing"), "2026/05/23/slug"
        )


class LinkTargetTests(unittest.TestCase):
    def test_targets_resolve_to_issue_post_and_episode(self):
        weekly = {"186": 186, "weekly-thing-186-blockchain-pairing-sharding": 186}
        self.assertEqual(
            core.resolve_link_target(
                "https://weekly.thingelstad.com/archive/weekly-thing-186-blockchain-pairing-sharding/",
                weekly=weekly,
            ),
            {
                "target_source_kind": "weekly_thing",
                "target_resolved": True,
                "target_issue_number": 186,
            },
        )
        self.assertEqual(
            core.resolve_link_target(
                "https://weekly.thingelstad.com/archive/weekly-thing-186-renamed/", weekly=weekly
            )["target_issue_number"],
            186,
        )
        self.assertFalse(
            core.resolve_link_target("https://weekly.thingelstad.com/archive/999/", weekly=weekly)[
                "target_resolved"
            ]
        )
        for home in ("https://weekly.thingelstad.com/", "https://another.thingelstad.com/"):
            self.assertEqual(core.resolve_link_target(home, weekly=weekly), {}, home)
        self.assertEqual(core.resolve_link_target("https://example.com/2020/01/01/x.html"), {})
        podcast = {"2025/10/05/start": {"episode_number": 1, "url": "u", "subject": "Start"}}
        self.assertEqual(
            core.resolve_link_target(
                "https://another.thingelstad.com/2025/10/05/start.html", podcast=podcast
            )["target_episode_number"],
            1,
        )

    def test_blog_lookup_keys_on_the_date_path_whatever_the_host(self):
        with tempfile.TemporaryDirectory() as tmp:
            blog = Path(tmp) / "blog"
            _write_post(blog, 7, "http://jthingelstad.micro.blog/2017/05/13/surly.html", "Surly")
            lookup = core.blog_post_lookup(blog)
        self.assertEqual(lookup["2017/05/13/surly"]["microblog_id"], 7)
        target = core.resolve_link_target(
            "https://www.thingelstad.com/2017/05/13/surly.html?ref=weekly-thing", blog=lookup
        )
        self.assertEqual(target["target_microblog_id"], 7)
        self.assertEqual(target["target_subject"], "Surly")


class BuildCorpusStructureTests(unittest.TestCase):
    def _build(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        archive = root / "archive"
        blog = root / "blog"
        podcast = root / "podcast"
        podcast.mkdir()
        (podcast / "001.json").write_text(
            json.dumps(
                {
                    "number": 1,
                    "title": "Start",
                    "url": "https://another.thingelstad.com/2025/10/05/start.html",
                }
            ),
            encoding="utf-8",
        )
        _write_post(blog, 7, "http://jthingelstad.micro.blog/2017/05/13/surly.html", "Surly")
        # The issue reprints a post from its own week: a Journal link to an
        # older post is a reference, not a copy (QA2 I2-1).
        _write_issue(archive, 100, "An older issue.\n", publish_date="2017-05-06T12:00:00Z")
        _write_issue(
            archive,
            101,
            "Intro with [a commentary link](https://example.com/intro).\n\n"
            "## Notable\n\n"
            "### [Headline](https://example.com/headline)\n\n"
            "Jamie on it, citing [a source](https://example.com/source) and "
            "[WT100](https://weekly.thingelstad.com/archive/100/).\n\n"
            "> Someone else's words.\n\n"
            "## Journal\n\n"
            "### Sunday\n\n"
            "[9:28 PM](https://www.thingelstad.com/2017/05/13/surly.html?ref=weekly-thing)\n\n"
            "A beer. Heard [the episode](https://another.thingelstad.com/2025/10/05/start.html).\n",
            links=(
                "links:\n"
                "- text: Headline\n"
                "  url: https://example.com/headline\n"
                "  domain: example.com\n"
                "  section: Notable\n"
            ),
            publish_date="2017-05-13T12:00:00Z",
        )
        return core.build_corpus(
            archive,
            include_issue_bodies=True,
            site_dir=root / "no-site",
            faq_path=root / "no-faq.json",
            blog_dir=blog,
            podcast_dir=podcast,
        )

    def test_chunks_carry_family_spans_and_kind_without_moving_ids(self):
        corpus = self._build()
        chunks = {c["section"]: c for c in corpus["chunks"] if c["issue_number"] == 101}
        self.assertEqual(
            {name: c["section_family"] for name, c in chunks.items()},
            {"Issue": "Intro", "Headline": "Notable", "Sunday": "Journal"},
        )
        notable = chunks["Headline"]
        self.assertEqual(notable["content_kind"], "links")
        quoted = [
            notable["text"][s["start"] : s["end"]]
            for s in notable["spans"]
            if s["voice"] == "quoted"
        ]
        self.assertEqual(quoted, ["> Someone else's words."])
        self.assertEqual(
            notable["id"], core.chunk_id(101, "Headline", 0, notable["text"]), "the id is unchanged"
        )
        embed = core._embed_input(notable)
        self.assertNotIn(
            "Notable", embed.split("\n")[-2], "the family never enters the embed input"
        )
        self.assertNotIn("spans", embed)
        self.assertEqual(
            chunks["Sunday"]["journal_post_urls"],
            ["http://jthingelstad.micro.blog/2017/05/13/surly.html"],
            "the Journal twin is the blog post's own URL",
        )

    def test_issue_records_carry_the_dek_and_section_families(self):
        corpus = self._build()
        issue = next(i for i in corpus["issues"] if i["number"] == 101)
        self.assertEqual(issue["description"], "Jamie's dek for the issue.")
        self.assertEqual(
            [(s["name"], s["section_family"]) for s in issue["sections"]],
            [("Issue", "Intro"), ("Headline", "Notable"), ("Sunday", "Journal")],
        )

    def test_links_carry_role_family_and_target(self):
        corpus = self._build()
        links = {link["url"]: link for link in corpus["links"] if link["issue_number"] == 101}
        self.assertEqual(
            {url: link["link_role"] for url, link in links.items()},
            {
                "https://example.com/headline": "headline",
                "https://example.com/intro": "commentary",
                "https://example.com/source": "commentary",
                "https://weekly.thingelstad.com/archive/100/": "commentary",
                "https://www.thingelstad.com/2017/05/13/surly.html?ref=weekly-thing": "journal",
                "https://another.thingelstad.com/2025/10/05/start.html": "journal",
            },
            "the front-matter headline is not repeated from the body",
        )
        self.assertEqual(links["https://example.com/headline"]["section_family"], "Notable")
        source = links["https://example.com/source"]
        self.assertEqual(
            (source["section"], source["section_family"], source["heading_context"]),
            ("Notable", "Notable", "Headline"),
        )
        self.assertIn("citing a source", source["context"])
        self.assertEqual(
            links["https://weekly.thingelstad.com/archive/100/"]["target_issue_number"], 100
        )
        journal = links["https://www.thingelstad.com/2017/05/13/surly.html?ref=weekly-thing"]
        self.assertEqual((journal["target_resolved"], journal["target_microblog_id"]), (True, 7))
        self.assertEqual(
            links["https://another.thingelstad.com/2025/10/05/start.html"]["target_episode_number"],
            1,
        )
        self.assertNotIn("target_source_kind", links["https://example.com/source"])


if __name__ == "__main__":
    unittest.main()


class BlogSkimFieldTests(unittest.TestCase):
    def test_posts_carry_categories_published_and_issue_targets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / "archive"
            _write_issue(archive, 186, "An issue.\n")
            blog = root / "blog"
            blog.mkdir()
            (blog / "1.md").write_text(
                "---\nmicroblog_id: 1\n"
                'url: "https://www.thingelstad.com/2021/01/02/post.html"\n'
                'title: "A post"\npublished: "2021-01-02T17:53:39+00:00"\n'
                'post_kind: post\ncategories: ["Coffee", "Kubb"]\n---\n\n'
                "See [WT186](https://weekly.thingelstad.com/archive/weekly-thing-186-a-slug/).\n",
                encoding="utf-8",
            )
            corpus = core.build_blog_corpus(
                blog_dir=blog, archive_dir=archive, podcast_dir=root / "none"
            )
        post = corpus["posts"][0]
        self.assertEqual(post["categories"], ["Coffee", "Kubb"])
        self.assertEqual(post["published"], "2021-01-02T17:53:39+00:00")
        self.assertEqual(post["publish_date"], "2021-01-02")
        link = corpus["links"][0]
        self.assertEqual(
            (link["target_source_kind"], link["target_resolved"], link["target_issue_number"]),
            ("weekly_thing", True, 186),
        )
