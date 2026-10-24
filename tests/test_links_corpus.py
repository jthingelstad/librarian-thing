"""The links corpus: Linking Things' saved links (Jamie, 2026-10-23).

links.thingelstad.xyz publishes every public link Jamie has saved since
2005. ``pipeline/links/import_links.py`` snapshots its links.json and
issues.json into the library's ``links/``; ``build_links_corpus`` makes one
passage per saved link (selectable as source_kind ``link``), and the Weekly
Thing and blog builds give a link record whose URL is a saved link its
``link_id``. A link's id is Linking Things' (the first 12 hex characters of
the md5 of its URL as saved), taken as published and never recomputed.
"""

import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from librarian_core import corpus as core
from librarian_core.library import absorb_tree, connect, export_tree, fingerprints, reindex
from librarian_core.library.tree import origin_of
from librarian_core.saved_links import (
    attach_link_ids,
    host_of,
    issue_link_ids,
    issue_number_of,
    link_id_from_page_url,
    link_page_url,
    note_spans,
    note_voice,
    prepare_note,
    read_link_issues,
    read_saved_links,
    saved_link_ids,
)

ROOT = Path(__file__).resolve().parents[1]
SITE = "https://links.thingelstad.xyz"
NEW = "aaaaaaaaaaaa"
OLD = "bbbbbbbbbbbb"
QUOTE = "cccccccccccc"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


IMPORT = _load("import_links_for_tests", ROOT / "pipeline" / "links" / "import_links.py")


def _link(link_id: str, url: str, saved: str, **fields) -> dict:
    return {
        "id": link_id,
        "hash": link_id + "0" * 20,
        "url": url,
        "title": fields.pop("title", f"Title {link_id}"),
        "note": fields.pop("note", ""),
        "saved": saved,
        "tags": fields.pop("tags", []),
        "toread": False,
        "meta": "a change signature nothing reads",
        "permalink": f"{SITE}/links/{link_id}/",
        "kind": fields.pop("kind", "page"),
        **fields,
    }


def _links_feed() -> dict:
    return {
        "site": SITE,
        "generated": "2026-10-24T02:33:42.959Z",
        "count": 3,
        "links": [
            # Saved at 9:30pm US Central on New Year's Eve: 2020-01-01 in UTC.
            _link(
                NEW,
                "https://www.example.com/agents",
                "2020-01-01T03:30:00Z",
                title="Agents  at\nwork",
                note="This is the best piece on agents I have read.",
                tags=["ai", "agents"],
                kind="article",
            ),
            _link(
                OLD,
                "https://example.org/old",
                "2012-05-01T15:00:00Z",
                note="The page's own words, saved by the bookmarklet.",
            ),
            _link(
                QUOTE,
                "https://video.example.net/watch",
                "2018-03-04T12:00:00Z",
                note="> A line I liked.\n> And another.\n\nMy take on it.",
                kind="video",
            ),
        ],
    }


def _issues_feed() -> dict:
    return {
        "site": SITE,
        "source": "weekly.thingelstad.com archive front matter",
        "generated": "2026-10-24T02:33:42.959Z",
        "count": 2,
        "issues": [
            {
                "number": 120,
                "date": "2020-01-04T13:00:00Z",
                "url": "https://weekly.thingelstad.com/archive/120/",
                "links": [
                    {
                        "position": 1,
                        "id": None,
                        "url": "https://unsaved.example.com/",
                        "text": "Unsaved",
                        "section": "Links",
                        "heading_context": "",
                        "permalink": None,
                    },
                    {
                        "position": 0,
                        "id": NEW,
                        "url": "https://www.example.com/agents",
                        "text": "Agents",
                        "section": "Notable",
                        "heading_context": "",
                        "permalink": f"{SITE}/links/{NEW}/",
                    },
                ],
            },
            {
                "number": None,
                "date": "2021-06-05T13:00:00Z",
                "url": "https://weekly.thingelstad.com/archive/140-special/",
                "links": [
                    {
                        "position": 0,
                        "id": NEW,
                        "url": "https://www.example.com/agents",
                        "text": "Agents again",
                        "section": "Briefly",
                        "heading_context": "",
                        "permalink": f"{SITE}/links/{NEW}/",
                    }
                ],
            },
        ],
    }


def _snapshot(folder: Path) -> Path:
    """The two snapshot files the importer writes, from the feeds above."""
    IMPORT.write_snapshot(IMPORT.normalize_links(_links_feed()), folder / "links.json")
    IMPORT.write_snapshot(IMPORT.normalize_issues(_issues_feed()), folder / "issues.json")
    return folder


class SavedLinkRuleTests(unittest.TestCase):
    def test_a_link_page_url_names_its_id_and_nothing_else_does(self):
        self.assertEqual(link_page_url(NEW), f"{SITE}/links/{NEW}/")
        for url in (
            f"{SITE}/links/{NEW}/",
            f"{SITE}/links/{NEW}",
            f"{SITE}/links/{NEW}.md",
            f"{SITE}/links/{NEW}.json",
            f"http://LINKS.thingelstad.xyz/links/{NEW}/",
        ):
            self.assertEqual(link_id_from_page_url(url), NEW, url)
        for url in (
            f"{SITE}/",
            f"{SITE}/issues/120/",
            f"{SITE}/links/{NEW.upper()}/",
            f"{SITE}/links/abc/",
            f"https://example.com/links/{NEW}/",
            "",
        ):
            self.assertIsNone(link_id_from_page_url(url), url)

    def test_host_is_linking_things_host(self):
        self.assertEqual(host_of("https://www.Example.com/a"), "example.com")
        self.assertEqual(host_of("https://me@www.example.org:8080/a"), "example.org:8080")
        self.assertEqual(host_of("https://sub.example.net/"), "sub.example.net")
        self.assertEqual(host_of("not a url"), "")

    def test_a_blockquote_note_reads_as_quote_lines(self):
        self.assertEqual(
            prepare_note("<blockquote>One.\nTwo.</blockquote>Mine."),
            "> One.\n> Two.\n\nMine.",
        )

    def test_whose_words_a_note_is(self):
        self.assertIsNone(note_voice("", 2020))
        self.assertIsNone(note_voice("   ", 2020))
        self.assertEqual(note_voice("My own words.", 2020), "jamie")
        # 2007 to 2016: the bookmarklet saved the page's own words.
        self.assertEqual(note_voice("Words.", 2007), "excerpt")
        self.assertEqual(note_voice("Words.", 2016), "excerpt")
        self.assertEqual(note_voice("Words.", 2006), "jamie")
        self.assertEqual(note_voice("Words.", 2017), "jamie")
        self.assertEqual(note_voice("> All quoted.\n\n> Still quoted.", 2020), "excerpt")
        self.assertEqual(note_voice("> Quoted.\n\nMine.", 2020), "mixed")
        self.assertEqual(note_voice("“Quoted words.”", 2020), "excerpt")
        self.assertEqual(note_voice('"Quoted words."\n\nMine.', 2020), "mixed")
        self.assertEqual(note_voice("<blockquote>Quoted.</blockquote>", 2020), "excerpt")

    def test_spans_cover_the_note_end_to_end(self):
        self.assertEqual(note_spans("", "jamie"), [])
        self.assertEqual(
            note_spans("Mine.", "jamie", 10), [{"voice": "jamie", "start": 10, "end": 15}]
        )
        self.assertEqual(
            note_spans("Theirs.", "excerpt", 3), [{"voice": "quoted", "start": 3, "end": 10}]
        )
        text = "> One.\n> Two.\n\nMine."
        spans = note_spans(text, "mixed", 100)
        self.assertEqual(
            [(s["voice"], text[s["start"] - 100 : s["end"] - 100]) for s in spans],
            [("quoted", "> One.\n> Two."), ("jamie", "\n\nMine.")],
        )
        # A mixed note with no quote lines quotes its opening block.
        text = '"Quoted."\n\nMine.'
        spans = note_spans(text, "mixed")
        self.assertEqual(
            [(s["voice"], text[s["start"] : s["end"]]) for s in spans],
            [("quoted", '"Quoted."'), ("jamie", "\n\nMine.")],
        )

    def test_a_missing_snapshot_is_empty_and_a_broken_one_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            self.assertEqual(read_saved_links(folder / "links.json"), [])
            self.assertEqual(read_link_issues(folder / "issues.json"), [])
            (folder / "links.json").write_text('{"links": {}}', encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "holds no links"):
                read_saved_links(folder / "links.json")
            (folder / "links.json").write_text('{"links": [{"id": "nope"}]}', encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "a link with no id"):
                read_saved_links(folder / "links.json")
            (folder / "issues.json").write_text("[]", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "holds no issues"):
                read_link_issues(folder / "issues.json")

    def test_the_special_issue_is_filed_by_its_archive_path(self):
        self.assertEqual(issue_number_of({"number": 7, "url": "x"}), 7)
        self.assertEqual(
            issue_number_of({"url": "https://weekly.thingelstad.com/archive/140-special/"}),
            "140-special",
        )
        self.assertIsNone(issue_number_of({"url": "https://weekly.thingelstad.com/"}))

    def test_a_record_gets_the_issue_join_first_then_its_url_as_saved(self):
        links = [_link(NEW, "https://example.com/a", "2020-01-01T00:00:00Z")]
        by_url = saved_link_ids(links)
        by_issue = {("5", "https://example.com/b"): OLD}
        records = [
            {"issue_number": 5, "url": "https://example.com/b"},
            {"issue_number": 6, "url": "https://example.com/a"},
            {"microblog_id": 9, "url": "https://example.com/a"},
            # The URL as saved, never a normalized one.
            {"microblog_id": 9, "url": "https://example.com/a/"},
            {"microblog_id": 9, "url": "https://example.com/c", "link_id": "stale"},
        ]
        self.assertEqual(attach_link_ids(records, by_url=by_url, by_issue=by_issue), 3)
        self.assertEqual([record.get("link_id") for record in records], [OLD, NEW, NEW, None, None])

    def test_the_issue_join_is_linking_things_own(self):
        issues = IMPORT.normalize_issues(_issues_feed())["issues"]
        self.assertEqual(
            issue_link_ids(issues),
            {
                ("120", "https://www.example.com/agents"): NEW,
                ("140-special", "https://www.example.com/agents"): NEW,
            },
        )


class ImporterTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _feeds(self, links: dict | None = None) -> tuple[Path, Path]:
        feed = self.tmp / "feed"
        feed.mkdir(exist_ok=True)
        (feed / "links.json").write_text(json.dumps(links or _links_feed()), encoding="utf-8")
        (feed / "issues.json").write_text(json.dumps(_issues_feed()), encoding="utf-8")
        return feed / "links.json", feed / "issues.json"

    def _run(self, *argv: str) -> tuple[int, str, str]:
        with redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()) as err:
            code = IMPORT.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_the_snapshot_keeps_the_links_and_drops_what_changes_without_them(self):
        links = IMPORT.normalize_links(_links_feed())
        self.assertEqual(sorted(links), ["links", "site"])
        self.assertEqual([link["id"] for link in links["links"]], [NEW, QUOTE, OLD])
        self.assertEqual(list(links["links"][0]), list(IMPORT.LINK_FIELDS))
        self.assertNotIn("meta", links["links"][0])
        issues = IMPORT.normalize_issues(_issues_feed())
        self.assertEqual(sorted(issues), ["issues", "site", "source"])
        self.assertEqual([link["position"] for link in issues["issues"][0]["links"]], [0, 1])

    def test_a_feed_that_is_not_linking_things_is_refused(self):
        feed = _links_feed()
        feed["count"] = 4
        with self.assertRaisesRegex(RuntimeError, "says 4 links and holds 3"):
            IMPORT.normalize_links(feed)
        for bad, message in (
            ({"id": "ABC"}, "not 12 hex"),
            ({"url": "ftp://example.com"}, "no http"),
            ({"saved": "yesterday"}, "unreadable saved time"),
            ({"tags": "ai"}, "tags are not a list"),
        ):
            feed = _links_feed()
            feed["links"][0].update(bad)
            with self.assertRaisesRegex(RuntimeError, message):
                IMPORT.normalize_links(feed)
        feed = _links_feed()
        feed["links"][1]["id"] = NEW
        with self.assertRaisesRegex(RuntimeError, "not unique"):
            IMPORT.normalize_links(feed)
        issues = _issues_feed()
        issues["issues"][0]["links"][0]["id"] = "XYZ"
        with self.assertRaisesRegex(RuntimeError, "names link id"):
            IMPORT.normalize_issues(issues)

    def test_a_second_run_with_no_new_link_writes_nothing(self):
        links_source, issues_source = self._feeds()
        out = self.tmp / "tree" / "links"
        code, stdout, _ = self._run(
            "--links-source",
            str(links_source),
            "--issues-source",
            str(issues_source),
            "--output-dir",
            str(out),
        )
        self.assertEqual(code, 0)
        self.assertIn("3 saved links, 2 issues carrying 3 links (2 matched", stdout)
        self.assertIn("(wrote links.json, issues.json)", stdout)
        first = (out / "links.json").read_text(encoding="utf-8")
        # One row a line, and every line a JSON row.
        self.assertEqual(len(first.splitlines()), 7)
        self.assertEqual(json.loads(first), IMPORT.normalize_links(_links_feed()))
        feed = _links_feed()
        feed["generated"] = "2026-10-25T05:30:00Z"
        for link in feed["links"]:
            link["meta"] = "changed"
        links_source, issues_source = self._feeds(feed)
        code, stdout, _ = self._run(
            "--links-source",
            str(links_source),
            "--issues-source",
            str(issues_source),
            "--output-dir",
            str(out),
        )
        self.assertEqual(code, 0)
        self.assertIn("(unchanged)", stdout)
        self.assertEqual((out / "links.json").read_text(encoding="utf-8"), first)

    def test_a_feed_that_would_shrink_the_snapshot_by_over_a_tenth_is_refused(self):
        links_source, issues_source = self._feeds()
        out = self.tmp / "tree" / "links"
        args = (
            "--links-source",
            str(links_source),
            "--issues-source",
            str(issues_source),
            "--output-dir",
            str(out),
        )
        self.assertEqual(self._run(*args)[0], 0)
        before = (out / "links.json").read_text(encoding="utf-8")
        feed = _links_feed()
        feed["links"] = feed["links"][:2]
        feed["count"] = 2
        self._feeds(feed)
        code, _, stderr = self._run(*args)
        self.assertEqual(code, 1)
        self.assertIn("the feed has 2 links and the snapshot 3", stderr)
        self.assertEqual((out / "links.json").read_text(encoding="utf-8"), before)
        self.assertEqual(self._run(*args, "--allow-shrink")[0], 0)
        self.assertEqual(len(read_saved_links(out / "links.json")), 2)

    def test_a_broken_feed_fails_and_writes_nothing(self):
        feed = self.tmp / "feed"
        feed.mkdir()
        (feed / "links.json").write_text('{"links": []}', encoding="utf-8")
        (feed / "issues.json").write_text(json.dumps(_issues_feed()), encoding="utf-8")
        out = self.tmp / "tree" / "links"
        code, _, stderr = self._run(
            "--links-source",
            str(feed / "links.json"),
            "--issues-source",
            str(feed / "issues.json"),
            "--output-dir",
            str(out),
        )
        self.assertEqual(code, 1)
        self.assertIn("links import failed: links.json has no links", stderr)
        self.assertFalse(out.exists())

    def test_issue_ids_naming_no_saved_link_are_counted(self):
        issues = _issues_feed()
        issues["issues"][0]["links"][0]["id"] = "dddddddddddd"
        normalized = IMPORT.normalize_issues(issues)
        self.assertEqual(IMPORT.dangling_ids(normalized, {NEW, OLD}), ["dddddddddddd"])


class LinksCorpusTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.links = _snapshot(Path(self._tmp.name) / "links")
        self.corpus = core.build_links_corpus(links_dir=self.links)
        self.chunks = {chunk["link_id"]: chunk for chunk in self.corpus["chunks"]}

    def tearDown(self):
        self._tmp.cleanup()

    def test_one_passage_per_saved_link_oldest_first(self):
        self.assertEqual([c["link_id"] for c in self.corpus["chunks"]], [OLD, QUOTE, NEW])
        self.assertFalse(self.corpus["missing"])
        self.assertEqual(self.corpus["source"], "links")
        self.assertEqual(self.corpus["saved_link_count"], 3)
        self.assertEqual(self.corpus["chunk_count"], 3)
        self.assertEqual(
            self.corpus["chunk_counts_by_link_type"], {"article": 1, "page": 1, "video": 1}
        )
        self.assertEqual(self.corpus["note_voice_counts"], {"excerpt": 1, "jamie": 1, "mixed": 1})
        self.assertEqual(self.corpus["shared_link_count"], 1)
        for chunk in self.corpus["chunks"]:
            self.assertRegex(chunk["id"], rf"^link:{chunk['link_id']}:[0-9a-f]+$")

    def test_a_link_is_dated_by_the_central_day_it_was_saved_and_cited_at_its_page(self):
        chunk = self.chunks[NEW]
        self.assertEqual(chunk["published"], "2020-01-01T03:30:00Z")
        self.assertEqual(chunk["publish_date"], "2019-12-31")
        self.assertEqual(chunk["issue_year"], 2019)
        self.assertEqual(chunk["url"], f"{SITE}/links/{NEW}/")
        self.assertEqual(chunk["link_url"], "https://www.example.com/agents")
        self.assertEqual(chunk["host"], "example.com")
        self.assertEqual(chunk["domains"], ["example.com"])
        self.assertEqual(chunk["subject"], "Agents at work")
        self.assertEqual(chunk["source_kind"], "link")
        self.assertEqual(chunk["content_kind"], "link")
        self.assertEqual(chunk["section"], "Saved link")
        self.assertIsNone(chunk["issue_number"])
        self.assertEqual(chunk["link_type"], "article")
        self.assertNotIn("kind", chunk)
        self.assertEqual(chunk["tags"], ["ai", "agents"])
        self.assertEqual(chunk["topics"], [])

    def test_the_head_is_the_links_and_the_note_keeps_its_own_voice(self):
        chunk = self.chunks[NEW]
        head, note = chunk["text"].split("\n\n", 1)
        self.assertEqual(
            head.splitlines(),
            [
                "Agents at work",
                "Article from example.com, saved December 31, 2019",
                "Tags: ai, agents",
                "Shared in WT120, Notable; WT140-special, Briefly",
            ],
        )
        self.assertEqual(note, "This is the best piece on agents I have read.")
        self.assertEqual(chunk["note_voice"], "jamie")
        self.assertEqual(
            chunk["spans"],
            [
                {"voice": "link", "start": 0, "end": len(head) + 2},
                {"voice": "jamie", "start": len(head) + 2, "end": len(chunk["text"])},
            ],
        )
        old = self.chunks[OLD]
        self.assertEqual(old["note_voice"], "excerpt")
        self.assertEqual([s["voice"] for s in old["spans"]], ["link", "quoted"])
        mixed = self.chunks[QUOTE]
        self.assertEqual(mixed["note_voice"], "mixed")
        self.assertEqual(
            [(s["voice"], mixed["text"][s["start"] : s["end"]]) for s in mixed["spans"][1:]],
            [("quoted", "> A line I liked.\n> And another."), ("jamie", "\n\nMy take on it.")],
        )
        for chunk in self.corpus["chunks"]:
            spans = chunk["spans"]
            self.assertEqual(spans[0]["start"], 0)
            self.assertEqual(spans[-1]["end"], len(chunk["text"]))
            for before, after in zip(spans, spans[1:]):
                self.assertEqual(before["end"], after["start"])

    def test_a_link_with_no_note_is_its_head_alone(self):
        links = self.links.parent / "bare"
        feed = _links_feed()
        feed["links"] = [_link(NEW, "https://example.com/x", "2024-02-03T18:00:00Z")]
        feed["count"] = 1
        IMPORT.write_snapshot(IMPORT.normalize_links(feed), links / "links.json")
        chunk = core.build_links_corpus(links_dir=links)["chunks"][0]
        self.assertIsNone(chunk["note_voice"])
        self.assertEqual(chunk["spans"], [{"voice": "link", "start": 0, "end": len(chunk["text"])}])
        self.assertEqual(chunk["appearances"], [])
        self.assertNotIn("Shared in", chunk["text"])

    def test_the_issues_that_shared_a_link(self):
        self.assertEqual(
            self.chunks[NEW]["appearances"],
            [
                {
                    "issue_number": 120,
                    "section": "Notable",
                    "issue_url": "/archive/120/",
                    "publish_date": "2020-01-04",
                },
                {
                    "issue_number": "140-special",
                    "section": "Briefly",
                    "issue_url": "/archive/140-special/",
                    "publish_date": "2021-06-05",
                },
            ],
        )
        self.assertEqual(self.chunks[OLD]["appearances"], [])

    def test_ids_are_stable_and_move_with_what_is_embedded(self):
        again = core.build_links_corpus(links_dir=self.links)
        self.assertEqual(
            [c["id"] for c in again["chunks"]], [c["id"] for c in self.corpus["chunks"]]
        )
        feed = _links_feed()
        feed["links"][0]["note"] = "A different note."
        IMPORT.write_snapshot(IMPORT.normalize_links(feed), self.links / "links.json")
        moved = {
            c["link_id"]: c["id"] for c in core.build_links_corpus(links_dir=self.links)["chunks"]
        }
        self.assertNotEqual(moved[NEW], self.chunks[NEW]["id"])
        self.assertEqual(moved[OLD], self.chunks[OLD]["id"])

    def test_a_long_note_stays_whole_and_its_embedding_input_fits(self):
        feed = _links_feed()
        feed["links"][0]["note"] = "A long thought about agents. " * 400
        IMPORT.write_snapshot(IMPORT.normalize_links(feed), self.links / "links.json")
        chunk = next(
            c
            for c in core.build_links_corpus(links_dir=self.links)["chunks"]
            if c["link_id"] == NEW
        )
        self.assertIn(feed["links"][0]["note"].strip(), chunk["text"])
        embedded = core._embed_input(chunk)
        self.assertLessEqual(len(embedded), core.COHERE_EMBED_MAX_TEXT_CHARS)
        self.assertTrue(
            embedded.startswith("A link Jamie Thingelstad saved on 2019-12-31\nAgents at work")
        )

    def test_with_no_snapshot_the_corpus_is_empty_and_says_so(self):
        empty = core.build_links_corpus(links_dir=self.links.parent / "none")
        self.assertTrue(empty["missing"])
        self.assertEqual(empty["chunks"], [])
        self.assertEqual(empty["chunk_count"], 0)
        self.assertEqual(empty["chunk_counts_by_link_type"], {})

    def test_the_build_command_reads_any_folder_and_writes_only_its_output(self):
        tree = Path(self._tmp.name) / "tree"
        (tree / "issues").mkdir(parents=True)
        output = Path(self._tmp.name) / "candidate" / "links_corpus.json"
        env = {**os.environ, "LIBRARIAN_DATA_DIR": str(tree)}
        script = ROOT / "pipeline" / "corpus" / "build_links.py"
        done = subprocess.run(
            [sys.executable, str(script), "--links-dir", str(self.links), "--output", str(output)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn(
            "3 saved links (1 article, 1 page, 1 video); notes: 1 excerpt, 1 jamie, 1 mixed; "
            "1 shared in an issue",
            done.stdout,
        )
        built = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(len(built["chunks"]), 3)
        self.assertEqual(sorted(p.name for p in tree.iterdir()), ["issues"])
        missing = subprocess.run(
            [sys.executable, str(script), "--output", str(output)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(missing.returncode, 0, missing.stderr)
        self.assertIn("links corpus: no snapshot in", missing.stderr)
        self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["chunks"], [])


GATE = _load("corpus_gate_for_links", ROOT / "pipeline" / "corpus" / "corpus_gate.py")


class GateTests(unittest.TestCase):
    """The corpus gate refuses a staged links candidate that files a link by
    any day but the Chicago day it was saved, or cites anything but its page."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.corpus = core.build_links_corpus(links_dir=_snapshot(Path(self._tmp.name) / "links"))

    def tearDown(self):
        self._tmp.cleanup()

    def test_a_built_corpus_passes(self):
        self.assertEqual(GATE.links_date_failures(self.corpus), [])

    def test_a_link_filed_by_its_utc_day_or_cited_elsewhere_fails(self):
        utc, elsewhere, malformed = (
            dict(chunk) for chunk in sorted(self.corpus["chunks"], key=lambda c: c["link_id"])
        )
        utc["publish_date"], utc["issue_year"] = "2020-01-01", 2020
        elsewhere["url"] = "https://www.example.com/agents"
        malformed["link_id"] = "XYZ"
        failures = GATE.links_date_failures({"chunks": [utc, elsewhere, malformed]})
        self.assertEqual(
            failures,
            [
                f"link-{NEW}: filed 2020-01-01 (2020), saved 2020-01-01T03:30:00Z is "
                "2019-12-31 in Chicago",
                f"link-{OLD}: url https://www.example.com/agents is not the link's page",
                "link-XYZ: malformed link id",
            ],
        )


class LinkIdOnSourceTests(unittest.TestCase):
    """A Weekly Thing or blog link record whose URL is a saved link carries
    its link_id, and a link to a saved link's page is the link source."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        _snapshot(self.root / "links")

    def tearDown(self):
        self._tmp.cleanup()

    def test_a_weekly_thing_link_is_its_saved_link(self):
        archive = self.root / "archive"
        (archive / "120").mkdir(parents=True)
        (archive / "120" / "archive.md").write_text(
            "---\nnumber: 120\nsubject: Weekly Thing 120\npublish_date: 2020-01-04\n---\n\n"
            "## Notable\n\n### [Agents](https://www.example.com/agents)\n\n"
            "Read [this too](https://unsaved.example.com/) and [the old one](https://example.org/old).\n",
            encoding="utf-8",
        )
        corpus = core.build_corpus(archive, include_issue_bodies=True)
        self.assertEqual(
            [(link["url"], link.get("link_id")) for link in corpus["links"]],
            [
                ("https://www.example.com/agents", NEW),
                ("https://unsaved.example.com/", None),
                ("https://example.org/old", OLD),
            ],
        )

    def test_a_blog_link_is_its_saved_link_and_a_link_page_is_the_link_source(self):
        posts = self.root / "posts" / "2024"
        posts.mkdir(parents=True)
        (posts / "a.md").write_text(
            '---\nmicroblog_id: 9\nurl: "https://www.thingelstad.com/2024/05/01/a.html"\n'
            'title: ""\npublished: "2024-05-01T12:00:00+00:00"\npost_kind: micropost\n---\n\n'
            "I liked [this](https://www.example.com/agents), saved "
            f"[here]({SITE}/links/{NEW}/), and [not saved]({SITE}/links/dddddddddddd/).\n",
            encoding="utf-8",
        )
        archive = self.root / "archive"
        archive.mkdir()
        corpus = core.build_blog_corpus(blog_dir=self.root / "posts", archive_dir=archive)
        rows = {link["url"]: link for link in corpus["links"]}
        self.assertEqual(rows["https://www.example.com/agents"].get("link_id"), NEW)
        page = rows[f"{SITE}/links/{NEW}/"]
        self.assertEqual(
            (page["target_source_kind"], page["target_resolved"], page["target_link_id"]),
            ("link", True, NEW),
        )
        dangling = rows[f"{SITE}/links/dddddddddddd/"]
        self.assertEqual(
            (dangling["target_source_kind"], dangling["target_resolved"]), ("link", False)
        )

    def test_the_link_target_of_a_linking_things_url(self):
        self.assertEqual(
            core.resolve_link_target(f"{SITE}/links/{NEW}/", links={NEW}),
            {"target_source_kind": "link", "target_resolved": True, "target_link_id": NEW},
        )
        self.assertEqual(core.resolve_link_target(f"{SITE}/links/{NEW}/")["target_resolved"], False)
        self.assertEqual(core.resolve_link_target(f"{SITE}/"), {})
        self.assertEqual(core.resolve_link_target(f"{SITE}/issues/120/"), {})


class LibraryTests(unittest.TestCase):
    """The snapshot in the library: its own origin, pulled by the round, and
    an input of the links corpus and of the two builds that read link_id."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.conn = connect(self.tmp / "library.db", create=True)
        seed = self.tmp / "seed"
        _snapshot(seed / "links")
        (seed / "site").mkdir(parents=True)
        (seed / "site" / "about.njk").write_text("---\npermalink: /about/\n---\nHi\n")
        absorb_tree(self.conn, seed, seed=True)
        reindex(self.conn)
        self.conn.commit()
        self.tree = self.tmp / "tree"
        export_tree(self.conn, self.tree)

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def test_its_own_origin(self):
        self.assertEqual(origin_of("links/links.json"), "links")
        self.assertEqual(origin_of("links/issues.json"), "links")
        self.assertTrue((self.tree / "links" / "links.json").is_file())

    def test_what_a_snapshot_change_moves(self):
        before = fingerprints(self.conn)
        feed = _links_feed()
        feed["links"][0]["note"] = "Changed my mind."
        IMPORT.write_snapshot(IMPORT.normalize_links(feed), self.tree / "links" / "links.json")
        changes = absorb_tree(self.conn, self.tree)
        self.assertEqual(changes["links"]["changed"], ["links/links.json"])
        after = fingerprints(self.conn)
        moved = sorted(corpus for corpus in after if after[corpus] != before[corpus])
        self.assertEqual(moved, ["blog_corpus", "corpus", "links_corpus"])
        issues = _issues_feed()
        issues["issues"][0]["links"].pop()
        IMPORT.write_snapshot(IMPORT.normalize_issues(issues), self.tree / "links" / "issues.json")
        absorb_tree(self.conn, self.tree)
        later = fingerprints(self.conn)
        moved = sorted(corpus for corpus in later if later[corpus] != after[corpus])
        self.assertEqual(moved, ["corpus", "links_corpus"])

    def test_the_round_pulls_links_with_the_importer(self):
        library = _load("library_cli_for_links", ROOT / "pipeline" / "library" / "library.py")
        self.assertIn("links", library.SOURCES)
        self.assertEqual(library.ORIGINS["links"], "links")
        self.assertEqual(library.OUTPUTS["links_corpus"], "links_corpus")


if __name__ == "__main__":
    unittest.main()
