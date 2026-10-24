"""The reference corpus's documents (Jamie, 2026-10-23): Markdown about Jamie
that the Librarian always consults and no caller selects.

Two folders feed it: ``reference/`` (from ``reference-documents/`` in git,
which is public) and ``reference-unpublished/`` (placed in the library by
hand, never in git). Both are read through one check, in one id space, and
chunked by H2 section; a malformed document fails naming its file.
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
from unittest import mock

from librarian_core import corpus as core
from librarian_core.library import absorb_tree, connect, export_tree, fingerprints, reindex
from librarian_core.library.tree import origin_of
from librarian_core.reference import (
    FIELDS,
    ReferenceDocumentError,
    document_paths,
    document_sections,
    read_document,
    read_reference_documents,
)

ROOT = Path(__file__).resolve().parents[1]
WIKI = "wiki.thingelstad.com (personal wiki, 2010-2015)"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _doc(
    folder: Path,
    name: str,
    body: str,
    *,
    title: str = "A document",
    updated: str = "2026-10-20",
    extra: str = "",
) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    path.write_text(
        f"---\ntitle: {title}\nupdated: {updated}\n{extra}---\n\n{body}\n", encoding="utf-8"
    )
    return path


def _build(root: Path, *, published: Path | None = None, unpublished: Path | None = None):
    """The reference corpus from these documents alone: no site pages, FAQ,
    things or pages, and never the data tree's folders."""
    archive = root / "archive"
    archive.mkdir(exist_ok=True)
    return core.build_reference_corpus(
        archive_dir=archive,
        site_dir=root / "no-site",
        faq_path=root / "no-faq.json",
        things_path=root / "no-things.json",
        pages_dir=root / "no-pages",
        reference_dir=published or root / "no-reference",
        unpublished_dir=unpublished or root / "no-unpublished",
    )


class ReadDocumentTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_every_field(self):
        self.assertEqual(FIELDS, ("title", "updated", "url", "source", "date"))
        path = _doc(
            self.dir,
            "family-weekends.md",
            "Lake weekends.",
            title="Family weekends",
            extra=(
                "url: https://example.com/weekends\n"
                f"source: '{WIKI}'\n"
                # Unquoted, YAML reads a date; quoted, a string. Both are a day.
                "date: 2011-09-29\n"
            ),
        )
        document = read_document(path)
        self.assertEqual(document["doc_id"], "family-weekends")
        self.assertEqual(document["title"], "Family weekends")
        self.assertEqual(document["url"], "https://example.com/weekends")
        self.assertEqual(document["updated"], "2026-10-20")
        self.assertEqual(document["source"], WIKI)
        self.assertEqual(document["date"], "2011-09-29")
        self.assertEqual(document["body"], "Lake weekends.")

    def test_url_source_and_date_are_optional(self):
        document = read_document(_doc(self.dir, "bio.md", "Jamie writes."))
        self.assertEqual(
            (document["url"], document["source"], document["date"]), (None, None, None)
        )
        quoted = read_document(
            _doc(
                self.dir,
                "forum.md",
                "Threads.",
                extra="source: >-\n  Ponder group export\n  (Nov-Dec 2025)\ndate: '2025-11-01'\n",
            )
        )
        self.assertEqual(quoted["source"], "Ponder group export (Nov-Dec 2025)")
        self.assertEqual(quoted["date"], "2025-11-01")

    def test_a_malformed_document_fails_naming_its_file(self):
        cases = {
            "no-title.md": ("---\nupdated: 2026-10-20\n---\n\nText.\n", "title is required"),
            "no-updated.md": ("---\ntitle: T\n---\n\nText.\n", "updated is required"),
            "bad-updated.md": ("---\ntitle: T\nupdated: soon\n---\n\nText.\n", "updated must"),
            "bad-date.md": (
                "---\ntitle: T\nupdated: 2026-10-20\ndate: last spring\n---\n\nText.\n",
                "date must be a date",
            ),
            "impossible-date.md": (
                "---\ntitle: T\nupdated: 2026-10-20\ndate: '2011-13-01'\n---\n\nText.\n",
                "not a calendar day",
            ),
            "number-source.md": (
                "---\ntitle: T\nupdated: 2026-10-20\nsource: 2011\n---\n\nText.\n",
                "source must be text",
            ),
            "empty-source.md": (
                "---\ntitle: T\nupdated: 2026-10-20\nsource: ''\n---\n\nText.\n",
                "source must be text",
            ),
            "unknown-field.md": (
                "---\ntitle: T\nupdated: 2026-10-20\nauthor: Jamie\n---\n\nText.\n",
                "unknown front matter author",
            ),
            "ftp-url.md": (
                "---\ntitle: T\nupdated: 2026-10-20\nurl: ftp://example.com/x\n---\n\nText.\n",
                "url must be an http(s) address",
            ),
            "no-front-matter.md": ("Just text.\n", "has no front matter"),
            "empty-body.md": ("---\ntitle: T\nupdated: 2026-10-20\n---\n\n", "has no text"),
            "headings-only.md": (
                "---\ntitle: T\nupdated: 2026-10-20\n---\n\n## One\n\n## Two\n",
                "no text under any",
            ),
            "Capital.md": ("---\ntitle: T\nupdated: 2026-10-20\n---\n\nText.\n", "file name"),
            "two words.md": ("---\ntitle: T\nupdated: 2026-10-20\n---\n\nText.\n", "file name"),
            "windows.md": (
                "---\r\ntitle: T\r\nupdated: 2026-10-20\r\n---\r\n\r\nText.\r\n",
                "Windows",
            ),
        }
        for name, (text, reason) in cases.items():
            with self.subTest(name):
                path = self.dir / name
                path.write_bytes(text.encode("utf-8"))
                with self.assertRaises(ReferenceDocumentError) as raised:
                    read_document(path)
                self.assertIn(f"reference document {name}:", str(raised.exception))
                self.assertIn(reason, str(raised.exception))

    def test_a_folder_holds_only_markdown_documents(self):
        _doc(self.dir, "bio.md", "Text.")
        (self.dir / "README.md").write_text("notes\n", encoding="utf-8")
        (self.dir / ".DS_Store").write_bytes(b"\0")
        self.assertEqual([path.name for path in document_paths(self.dir)], ["bio.md"])
        (self.dir / "notes.txt").write_text("x\n", encoding="utf-8")
        with self.assertRaisesRegex(ReferenceDocumentError, r"notes\.txt: is not a Markdown file"):
            document_paths(self.dir)


class SectionTests(unittest.TestCase):
    def test_the_text_before_the_first_h2_then_one_section_per_h2(self):
        body = (
            "# Family weekends\n\nWhat we did.\n\n"
            "## Lake weekends\n\nSwimming.\n\n### Food\n\nBrats.\n\n"
            "## Winter weekends ##\n\nBoard games.\n\n"
            "##NotAHeading\n\n"
            "```markdown\n## not a heading, code\n```\n\n"
            "## Empty\n\n"
            "## Last\n\nThe end."
        )
        self.assertEqual(
            document_sections(body),
            [
                (None, "# Family weekends\n\nWhat we did."),
                ("Lake weekends", "Swimming.\n\n### Food\n\nBrats."),
                (
                    "Winter weekends",
                    "Board games.\n\n##NotAHeading\n\n```markdown\n## not a heading, code\n```",
                ),
                ("Last", "The end."),
            ],
        )

    def test_a_document_with_no_text_before_its_first_h2(self):
        self.assertEqual(
            document_sections("## One\n\nA.\n\n## Two\n\nB."), [("One", "A."), ("Two", "B.")]
        )


class DocumentChunkTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.published = self.root / "reference"
        self.unpublished = self.root / "reference-unpublished"

    def tearDown(self):
        self._tmp.cleanup()

    def _chunks(self, corpus, doc_id):
        return [chunk for chunk in corpus["chunks"] if chunk["doc_id"] == doc_id]

    def test_each_chunk_carries_the_title_its_heading_and_the_provenance(self):
        _doc(
            self.unpublished,
            "family-weekends.md",
            "Every family has its weekends.\n\n## Lake weekends\n\nSwimming at the lake.\n\n"
            "## Winter weekends\n\nBoard games.",
            title="Family weekends",
            extra=f"source: '{WIKI}'\ndate: 2011-09-29\n",
        )
        corpus = _build(self.root, unpublished=self.unpublished)
        chunks = self._chunks(corpus, "family-weekends")
        self.assertEqual(
            [(chunk["section"], chunk["text"]) for chunk in chunks],
            [
                ("Family weekends", "Every family has its weekends."),
                ("Lake weekends", "Swimming at the lake."),
                ("Winter weekends", "Board games."),
            ],
        )
        for chunk in chunks:
            self.assertEqual(chunk["subject"], "Family weekends")
            self.assertEqual(chunk["source_kind"], "document")
            self.assertEqual(chunk["content_kind"], "document")
            self.assertEqual(chunk["document_source"], WIKI)
            self.assertEqual(chunk["document_date"], "2011-09-29")
            self.assertEqual(chunk["updated"], "2026-10-20")
            # Undated for every date tool: its own date is citation metadata.
            self.assertIsNone(chunk["publish_date"])
            self.assertIsNone(chunk["issue_year"])
            self.assertIsNone(chunk["issue_number"])
            self.assertIsNone(chunk["url"])
            self.assertRegex(chunk["id"], r"^doc:family-weekends:\d+:[0-9a-f]{16}$")
        header = core._embed_header(chunks[1])
        self.assertEqual(
            header,
            [
                "Jamie Thingelstad, reference document",
                "Document: Family weekends",
                "Section: Lake weekends",
                f"Source: {WIKI}",
            ],
        )
        # The text before the first heading names no section of its own.
        self.assertNotIn("Section: Family weekends", core._embed_header(chunks[0]))
        self.assertEqual(corpus["chunk_counts_by_kind"], {"document": 3})
        [listed] = corpus["documents"]
        self.assertEqual(listed["folder"], "reference-unpublished")
        self.assertEqual(listed["source"], WIKI)
        self.assertEqual(listed["date"], "2011-09-29")
        self.assertEqual(listed["chunk_count"], 3)

    def test_ids_are_stable_and_move_with_what_is_embedded(self):
        body = "Intro.\n\n## Lake weekends\n\nSwimming.\n\n## Winter weekends\n\nGames."
        _doc(self.published, "weekends.md", body, title="Weekends")
        first = [chunk["id"] for chunk in _build(self.root, published=self.published)["chunks"]]
        again = [chunk["id"] for chunk in _build(self.root, published=self.published)["chunks"]]
        self.assertEqual(first, again)
        self.assertEqual(len(set(first)), 3)
        _doc(
            self.published,
            "weekends.md",
            body.replace("## Lake weekends", "## Summer weekends"),
            title="Weekends",
        )
        renamed = [chunk["id"] for chunk in _build(self.root, published=self.published)["chunks"]]
        self.assertEqual(renamed[0], first[0])
        self.assertNotEqual(renamed[1], first[1], "a renamed section is embedded again")
        self.assertEqual(renamed[2], first[2])
        _doc(self.published, "weekends.md", body, title="Weekends", extra="source: a wiki\n")
        sourced = [chunk["id"] for chunk in _build(self.root, published=self.published)["chunks"]]
        self.assertTrue(all(a != b for a, b in zip(first, sourced, strict=True)))

    def test_a_forum_of_86_threads_is_86_sections(self):
        threads = "\n\n".join(
            f"## Thread {n}: weekend plans\n\n_2025-11-{(n % 28) + 1:02d} · Ponder thread {n}_\n\n"
            + " ".join(["We talked about the lake and the cabin."] * 12)
            for n in range(1, 87)
        )
        _doc(
            self.unpublished,
            "ponder-threads.md",
            threads,
            title="Ponder threads",
            extra="source: Ponder group export (Nov-Dec 2025)\ndate: 2025-11-01\n",
        )
        chunks = self._chunks(_build(self.root, unpublished=self.unpublished), "ponder-threads")
        self.assertEqual(len(chunks), 86)
        self.assertEqual(chunks[0]["section"], "Thread 1: weekend plans")
        self.assertTrue(chunks[85]["text"].startswith("_2025-11-03 · Ponder thread 86_"))

    def test_a_long_document_splits_within_the_embedding_input_and_keeps_every_word(self):
        # 12 sections, about 88k characters, the largest document in the
        # first unpublished batch; one section is a single paragraph with no
        # blank line in 9,000 characters.
        paragraphs = {}
        sections = []
        for n in range(12):
            words = [f"s{n}p{p}w{w}" for p in range(14) for w in range(90)]
            text = "\n\n".join(" ".join(words[p * 90 : (p + 1) * 90]) + "." for p in range(14))
            if n == 5:
                text = " ".join(words) + "."
            paragraphs[n] = words
            sections.append(f"## Section {n}\n\n{text}")
        body = "\n\n".join(sections)
        self.assertGreater(len(body), 80_000)
        _doc(self.unpublished, "long.md", body, title="Long", extra="source: a long export\n")
        corpus = _build(self.root, unpublished=self.unpublished)
        chunks = self._chunks(corpus, "long")
        self.assertGreater(len(chunks), 40)
        for chunk in chunks:
            self.assertLessEqual(len(core._embed_input(chunk)), core.COHERE_EMBED_MAX_TEXT_CHARS)
        for n, words in paragraphs.items():
            text = " ".join(c["text"] for c in chunks if c["section"] == f"Section {n}")
            missing = [word for word in words if word not in text]
            self.assertEqual(missing, [], f"Section {n}")
        self.assertEqual(len({chunk["id"] for chunk in chunks}), len(chunks))
        self.assertEqual(corpus["documents"][0]["char_count"], len(body))


class FolderTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.published = self.root / "reference"
        self.unpublished = self.root / "reference-unpublished"

    def tearDown(self):
        self._tmp.cleanup()

    def test_both_folders_are_read_published_first(self):
        _doc(self.published, "bio.md", "Bio text.", title="Bio")
        _doc(self.unpublished, "timeline.md", "Timeline text.", title="Timeline")
        documents = read_reference_documents(self.published, self.unpublished)
        self.assertEqual(
            [(d["doc_id"], d["folder"]) for d in documents],
            [("bio", "reference"), ("timeline", "reference-unpublished")],
        )
        corpus = _build(self.root, published=self.published, unpublished=self.unpublished)
        self.assertEqual(corpus["document_count"], 2)

    def test_a_name_in_both_folders_fails_naming_the_file(self):
        _doc(self.published, "bio.md", "Bio text.", title="Bio")
        _doc(self.unpublished, "bio.md", "Another bio.", title="Bio")
        with self.assertRaisesRegex(
            ReferenceDocumentError,
            r"reference document bio\.md: is in both reference/ and reference-unpublished/",
        ):
            _build(self.root, published=self.published, unpublished=self.unpublished)

    def test_a_malformed_unpublished_document_fails_the_build_naming_it(self):
        _doc(self.unpublished, "timeline.md", "Text.", updated="someday")
        with self.assertRaisesRegex(ReferenceDocumentError, r"timeline\.md: updated must"):
            _build(self.root, unpublished=self.unpublished)

    def test_the_build_command_reads_any_folder_and_writes_only_its_output(self):
        tree = self.root / "tree"
        (tree / "issues").mkdir(parents=True)
        local = self.root / "staged"
        _doc(local, "timeline.md", "Intro.\n\n## 1990s\n\nSchool.", title="Timeline")
        output = self.root / "candidate" / "reference_corpus.json"
        env = {**os.environ, "LIBRARIAN_DATA_DIR": str(tree)}
        script = ROOT / "pipeline" / "corpus" / "build_reference.py"
        done = subprocess.run(
            [sys.executable, str(script), "--unpublished-dir", str(local), "--output", str(output)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("doc-timeline (reference-unpublished): 2 chunks", done.stdout)
        built = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(
            [c["section"] for c in built["chunks"] if c["source_kind"] == "document"],
            ["Timeline", "1990s"],
        )
        self.assertEqual(sorted(p.name for p in tree.iterdir()), ["issues"])
        _doc(local, "Bad Name.md", "Text.")
        refused = subprocess.run(
            [sys.executable, str(script), "--unpublished-dir", str(local), "--output", str(output)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(refused.returncode, 1)
        self.assertIn("reference document Bad Name.md:", refused.stderr)


class ImporterTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.importer = _load(
            "import_reference_for_tests", ROOT / "pipeline" / "reference" / "import_reference.py"
        )

    def tearDown(self):
        self._tmp.cleanup()

    def test_the_mirror_never_touches_the_unpublished_folder(self):
        source = self.root / "reference-documents"
        output = self.root / "tree" / "reference"
        unpublished = self.root / "tree" / "reference-unpublished"
        _doc(source, "bio.md", "Bio.", title="Bio")
        (source / "README.md").write_text("the guide\n", encoding="utf-8")
        kept = _doc(unpublished, "timeline.md", "Timeline.", title="Timeline")
        before = kept.read_bytes()
        _doc(output, "old.md", "Gone from git.")
        changes = self.importer.mirror(source, output, unpublished)
        self.assertEqual(changes, {"added": ["bio.md"], "changed": [], "removed": ["old.md"]})
        self.assertEqual(sorted(p.name for p in output.iterdir()), ["bio.md"])
        self.assertEqual(kept.read_bytes(), before)
        self.assertEqual(sorted(p.name for p in unpublished.iterdir()), ["timeline.md"])
        # An empty git folder empties reference/, and only reference/.
        (source / "bio.md").unlink()
        self.importer.mirror(source, output, unpublished)
        self.assertEqual(list(output.iterdir()), [])
        self.assertEqual(kept.read_bytes(), before)

    def test_a_name_in_both_folders_fails_the_import_and_writes_nothing(self):
        source = self.root / "reference-documents"
        output = self.root / "tree" / "reference"
        unpublished = self.root / "tree" / "reference-unpublished"
        _doc(source, "timeline.md", "Public.", title="Timeline")
        _doc(unpublished, "timeline.md", "Private.", title="Timeline")
        with redirect_stderr(io.StringIO()) as err:
            code = self.importer.main(
                [
                    "--source-dir",
                    str(source),
                    "--output-dir",
                    str(output),
                    "--unpublished-dir",
                    str(unpublished),
                ]
            )
        self.assertEqual(code, 1)
        self.assertIn("timeline.md: is in both", err.getvalue())
        self.assertFalse(output.exists())


class LibraryTests(unittest.TestCase):
    """The unpublished folder in the library: its own origin, placed by hand
    (absorb, then upload), counted in the reference corpus's inputs."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.conn = connect(self.tmp / "library.db", create=True)
        seed = self.tmp / "seed"
        _doc(seed / "reference", "bio.md", "Bio.", title="Bio")
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
        self.assertEqual(origin_of("reference-unpublished/timeline.md"), "reference-unpublished")
        self.assertEqual(origin_of("reference/bio.md"), "reference")
        self.assertIsNone(origin_of("reference-unpublished/README.md"))

    def test_an_absorbed_document_is_indexed_and_moves_only_the_reference_corpus(self):
        before = fingerprints(self.conn)
        _doc(
            self.tree / "reference-unpublished",
            "timeline.md",
            "Born.",
            title="Timeline",
            extra="source: a family notebook\ndate: 2011-09-29\n",
        )
        changes = absorb_tree(self.conn, self.tree)
        self.assertEqual(
            changes["reference-unpublished"]["added"], ["reference-unpublished/timeline.md"]
        )
        reindex(self.conn)
        rows = {
            row["id"]: (row["kind"], row["path"], row["published"])
            for row in self.conn.execute("SELECT id, kind, path, published FROM sources")
        }
        self.assertEqual(
            rows["doc-timeline"], ("document", "reference-unpublished/timeline.md", None)
        )
        self.assertEqual(rows["doc-bio"][0], "document")
        after = fingerprints(self.conn)
        moved = sorted(corpus for corpus in after if after[corpus] != before[corpus])
        self.assertEqual(moved, ["reference_corpus"])

    def test_one_name_in_both_folders_is_refused_by_the_index(self):
        _doc(self.tree / "reference-unpublished", "bio.md", "Other bio.", title="Bio")
        absorb_tree(self.conn, self.tree)
        with self.assertRaisesRegex(ValueError, "doc-bio is claimed by"):
            reindex(self.conn)

    def test_absorb_refuses_a_malformed_document_and_absorbs_nothing(self):
        library = _load("library_cli_for_reference", ROOT / "pipeline" / "library" / "library.py")
        self.conn.close()
        _doc(self.tree / "reference-unpublished", "timeline.md", "Text.", updated="soon")
        with (
            mock.patch.object(library, "DB_PATH", self.tmp / "library.db"),
            redirect_stderr(io.StringIO()) as err,
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(library.cmd_absorb(self.tree, allow_removals=False), 1)
        self.assertIn("timeline.md: updated must", err.getvalue())
        self.assertIn("nothing absorbed", err.getvalue())
        self.conn = connect(self.tmp / "library.db")
        paths = [row["path"] for row in self.conn.execute("SELECT path FROM files")]
        self.assertNotIn("reference-unpublished/timeline.md", paths)

    def test_a_good_document_absorbs_and_the_next_stale_check_builds_reference(self):
        library = _load(
            "library_cli_for_reference_ok", ROOT / "pipeline" / "library" / "library.py"
        )
        live = fingerprints(self.conn)
        self.conn.close()
        _doc(self.tree / "reference-unpublished", "timeline.md", "Born.", title="Timeline")
        output = self.tmp / "github_output"
        with (
            mock.patch.object(library, "DB_PATH", self.tmp / "library.db"),
            mock.patch.dict(os.environ, {"GITHUB_OUTPUT": str(output)}),
            mock.patch.object(library, "built_from", side_effect=lambda corpus: live[corpus]),
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(library.cmd_absorb(self.tree, allow_removals=False), 0)
            from datetime import datetime

            stale = library.cmd_stale(None, datetime(2026, 10, 22, 12, tzinfo=library.CENTRAL))
        self.assertEqual(
            stale,
            {
                "corpus": False,
                "blog_corpus": False,
                "podcast_corpus": False,
                "reference_corpus": True,
            },
        )
        self.conn = connect(self.tmp / "library.db")

    def test_a_pull_of_the_git_folder_leaves_the_unpublished_folder_alone(self):
        library = _load(
            "library_cli_for_reference_pull", ROOT / "pipeline" / "library" / "library.py"
        )
        _doc(self.tree / "reference-unpublished", "timeline.md", "Born.", title="Timeline")
        absorb_tree(self.conn, self.tree)
        reindex(self.conn)
        self.conn.commit()
        self.conn.close()
        local = self.tmp / "reference-documents"
        _doc(local, "resume.md", "Work.", title="Resume")
        with (
            mock.patch.object(library, "DB_PATH", self.tmp / "library.db"),
            redirect_stdout(io.StringIO()),
        ):
            changes = library.cmd_pull(self.tree, ["reference"], None, None, local)
        self.assertEqual(changes["reference"]["added"], ["reference/resume.md"])
        self.assertEqual(changes["reference"]["removed"], ["reference/bio.md"])
        self.assertNotIn(
            "reference-unpublished", {o for o, b in changes.items() if any(b.values())}
        )
        self.assertTrue((self.tree / "reference-unpublished" / "timeline.md").is_file())
        self.conn = connect(self.tmp / "library.db")
        paths = {row["path"] for row in self.conn.execute("SELECT path FROM files")}
        self.assertIn("reference-unpublished/timeline.md", paths)


class RepositoryFolderTests(unittest.TestCase):
    def test_the_git_folder_ships_its_guide_and_no_documents(self):
        folder = ROOT / "reference-documents"
        self.assertEqual(document_paths(folder), [])
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ["README.md"])
        guide = (folder / "README.md").read_text(encoding="utf-8")
        for words in ("reference-unpublished", "public", "source", "date", "updated"):
            self.assertIn(words, guide)


if __name__ == "__main__":
    unittest.main()
