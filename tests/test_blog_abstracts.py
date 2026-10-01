"""Blog abstracts: generated display metadata on blog post records.

Titled posts take a generated abstract from data/librarian/blog-abstracts.json
(pipeline/blog/abstracts.py); microposts are their own abstract. A generated
abstract is a model's paraphrase, so it must never reach chunk text or the
embedding input, the same principle that keeps Thingy's words out of the
corpus. No network here: the script's API client is faked.
"""

import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from librarian_core.abstracts import (
    ABSTRACT_MAX_CHARS,
    annotate_blog_abstracts,
    clip_abstract,
    micropost_abstract,
)
from librarian_core.corpus import _embed_input, build_blog_corpus

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "pipeline" / "blog" / "abstracts.py"

spec = importlib.util.spec_from_file_location("pipeline_blog_abstracts", SCRIPT)
script = importlib.util.module_from_spec(spec)
spec.loader.exec_module(script)

ESSAY_ID = 111
MICRO_ID = 222
PHOTO_ONLY_ID = 333
ABSTRACT = "Jamie argues that systems thinking means seeing wholes, not parts."


def _post(blog_dir: Path, *, mid: int, date: str, slug: str, title: str, body: str, kind: str):
    y, m, d = date.split("-")
    path = blog_dir / y / m / f"{date}-{slug}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "---\n"
        f"microblog_id: {mid}\n"
        f'url: "https://www.thingelstad.com/{y}/{m}/{d}/{slug}.html"\n'
        f'title: "{title}"\n'
        f'published: "{date}T12:00:00+00:00"\n'
        f"post_kind: {kind}\n"
        "categories: []\n"
        "---\n\n"
        f"{body}\n",
        encoding="utf-8",
    )


def _fixture(root: Path) -> Path:
    blog = root / "posts"
    _post(
        blog,
        mid=ESSAY_ID,
        date="2018-04-02",
        slug="on-systems-thinking",
        title="On Systems Thinking",
        body="Systems thinking is a discipline for seeing wholes.\n\n"
        "It is a framework for seeing interrelationships rather than things.",
        kind="post",
    )
    _post(
        blog,
        mid=MICRO_ID,
        date="2021-11-26",
        slug="elf",
        title="",
        body="Family tradition to watch [Elf](https://en.wikipedia.org/wiki/Elf_(film)) "
        "the day after Thanksgiving!\n\n"
        '<img src="https://www.thingelstad.com/uploads/2021/elf.jpg" '
        'alt="Man in a green elf costume with hands on hips" />\n\n'
        '{{< x user="someone" id="123" >}}',
        kind="micropost",
    )
    _post(
        blog,
        mid=PHOTO_ONLY_ID,
        date="2022-01-01",
        slug="photo",
        title="",
        body='<img src="https://www.thingelstad.com/uploads/2022/lake.jpg" '
        'alt="Frozen lake at sunrise" />',
        kind="micropost",
    )
    return blog


def _write_sidecar(path: Path, entries: dict) -> Path:
    path.write_text(json.dumps(entries), encoding="utf-8")
    return path


class AnnotateBlogAbstractsTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.blog = _fixture(self.root)
        self.corpus = build_blog_corpus(blog_dir=self.blog, include_xref=False)
        self.posts = {str(p["microblog_id"]): p for p in self.corpus["posts"]}

    def tearDown(self):
        self._tmp.cleanup()

    def _sidecar(self, body_hash: str) -> Path:
        return _write_sidecar(
            self.root / "blog-abstracts.json",
            {
                str(ESSAY_ID): {
                    "body_hash": body_hash,
                    "abstract": ABSTRACT,
                    "model": "claude-haiku-4-5",
                    "generated_at": "2026-09-29T00:00:00Z",
                }
            },
        )

    def test_titled_post_gets_generated_abstract(self):
        sidecar = self._sidecar(self.posts[str(ESSAY_ID)]["body_hash"])
        self.assertEqual(annotate_blog_abstracts(self.corpus, sidecar), 1)
        essay = self.posts[str(ESSAY_ID)]
        self.assertEqual(essay["abstract"], ABSTRACT)
        self.assertEqual(essay["abstract_source"], "generated")

    def test_stale_body_hash_is_not_applied(self):
        sidecar = self._sidecar("0000000000000000")
        self.assertEqual(annotate_blog_abstracts(self.corpus, sidecar), 0)
        essay = self.posts[str(ESSAY_ID)]
        self.assertNotIn("abstract", essay)
        self.assertNotIn("abstract_source", essay)

    def test_error_entry_and_missing_sidecar_leave_titled_post_bare(self):
        sidecar = _write_sidecar(
            self.root / "errors.json",
            {
                str(ESSAY_ID): {
                    "body_hash": self.posts[str(ESSAY_ID)]["body_hash"],
                    "error": "refusal",
                    "model": "claude-haiku-4-5",
                }
            },
        )
        self.assertEqual(annotate_blog_abstracts(self.corpus, sidecar), 0)
        self.assertNotIn("abstract", self.posts[str(ESSAY_ID)])
        self.assertEqual(annotate_blog_abstracts(self.corpus, self.root / "absent.json"), 0)
        self.assertNotIn("abstract", self.posts[str(ESSAY_ID)])

    def test_micropost_is_its_own_abstract(self):
        annotate_blog_abstracts(self.corpus, self.root / "absent.json")
        micro = self.posts[str(MICRO_ID)]
        self.assertEqual(micro["abstract_source"], "text")
        # The embedded tweet is a link labelled with its author (QA3 F16),
        # where the strip used to delete it.
        self.assertEqual(
            micro["abstract"], "Family tradition to watch Elf the day after Thanksgiving! @someone"
        )
        # Photo-only micropost: its alt text is all the text it has.
        photo = self.posts[str(PHOTO_ONLY_ID)]
        self.assertEqual(photo["abstract"], "Frozen lake at sunrise")
        self.assertEqual(photo["abstract_source"], "text")

    def test_micropost_ignores_sidecar(self):
        sidecar = _write_sidecar(
            self.root / "blog-abstracts.json",
            {str(MICRO_ID): {"body_hash": "x", "abstract": "Generated, should not appear."}},
        )
        annotate_blog_abstracts(self.corpus, sidecar)
        self.assertEqual(self.posts[str(MICRO_ID)]["abstract_source"], "text")
        self.assertNotIn("Generated", self.posts[str(MICRO_ID)]["abstract"])

    def test_abstracts_never_reach_chunks_or_embed_input(self):
        sidecar = self._sidecar(self.posts[str(ESSAY_ID)]["body_hash"])
        chunks_before = copy.deepcopy(self.corpus["chunks"])
        embed_before = [_embed_input(chunk) for chunk in self.corpus["chunks"]]

        annotate_blog_abstracts(self.corpus, sidecar)

        self.assertEqual(self.corpus["chunks"], chunks_before)
        self.assertEqual([_embed_input(chunk) for chunk in self.corpus["chunks"]], embed_before)
        for chunk in self.corpus["chunks"]:
            self.assertNotIn(ABSTRACT, json.dumps(chunk))
            self.assertNotIn(ABSTRACT, _embed_input(chunk))
            self.assertNotIn("abstract", chunk)
            self.assertNotIn("abstract_source", chunk)

    def test_rerun_is_idempotent(self):
        sidecar = self._sidecar(self.posts[str(ESSAY_ID)]["body_hash"])
        annotate_blog_abstracts(self.corpus, sidecar)
        first = copy.deepcopy(self.corpus["posts"])
        annotate_blog_abstracts(self.corpus, sidecar)
        self.assertEqual(self.corpus["posts"], first)


class ClipTests(unittest.TestCase):
    def test_short_text_is_whitespace_collapsed_only(self):
        self.assertEqual(clip_abstract("  One  line.\n Two. "), "One line. Two.")

    def test_long_text_keeps_whole_sentences(self):
        first = "A" * 200 + "."
        text = f"{first} " + "B" * 300 + "."
        self.assertEqual(clip_abstract(text), first)

    def test_long_single_sentence_is_word_cut(self):
        text = " ".join(["word"] * 200)
        clipped = clip_abstract(text)
        self.assertLessEqual(len(clipped), ABSTRACT_MAX_CHARS)
        self.assertTrue(clipped.endswith("…"))

    def test_micropost_abstract_drops_inlined_alt_and_shortcode_residue(self):
        text = micropost_abstract(
            "Tenderloins on the grill. Pork on a grill grate\n\n{{ }}", ["Pork on a grill grate"]
        )
        self.assertEqual(text, "Tenderloins on the grill.")


class AbstractsScriptTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.blog = _fixture(self.root)

    def tearDown(self):
        self._tmp.cleanup()

    def test_collects_titled_posts_only_with_the_corpus_body_hash(self):
        posts = script.collect_posts(self.blog)
        self.assertEqual([p["microblog_id"] for p in posts], [str(ESSAY_ID)])
        corpus = build_blog_corpus(blog_dir=self.blog, include_xref=False)
        corpus_hash = next(p["body_hash"] for p in corpus["posts"] if p["microblog_id"] == ESSAY_ID)
        self.assertEqual(posts[0]["body_hash"], corpus_hash)

    def test_selection_skips_done_and_failed_posts_with_current_hash(self):
        posts = [
            {"microblog_id": "1", "body_hash": "aaa"},
            {"microblog_id": "2", "body_hash": "bbb"},
            {"microblog_id": "3", "body_hash": "ccc"},
            {"microblog_id": "4", "body_hash": "ddd"},
        ]
        sidecar = {
            "1": {"body_hash": "aaa", "abstract": "Done."},
            "2": {"body_hash": "bbb", "error": "refusal"},
            "3": {"body_hash": "old", "abstract": "Written for an earlier edit."},
        }
        pending = script.select_pending(posts, sidecar)
        self.assertEqual([p["microblog_id"] for p in pending], ["3", "4"])

    def test_prompt_body_marks_photos_and_embeds(self):
        body = (
            'Intro <a href="https://example.com/x">a link</a>.\n\n'
            '<img src="https://x/y.jpg" alt="A red barn" />\n\n'
            "![](https://x/z.jpg)\n\n"
            '{{< youtube abc123 >}}\n\n<blockquote class="q">Quoted.</blockquote>'
        )
        text = script.prompt_body(body)
        self.assertIn("[a link](https://example.com/x)", text)
        self.assertIn("[Photo: A red barn]", text)
        self.assertIn("[Photo]", text)
        self.assertIn("[Embedded youtube abc123]", text)
        self.assertIn("<blockquote>Quoted.</blockquote>", text)
        self.assertNotIn("<img", text)

    def test_clean_abstract_strips_labels_quotes_and_markdown(self):
        self.assertEqual(
            script.clean_abstract('Abstract: "Jamie **describes** a ride."'),
            "Jamie describes a ride.",
        )
        self.assertEqual(
            script.clean_abstract("# Heading\nJamie links to a post."), ("Jamie links to a post.")
        )
        self.assertEqual(
            script.clean_abstract("Jamie reads *Scale* and `grep`, keeps snake_case."),
            "Jamie reads Scale and grep, keeps snake_case.",
        )
        self.assertEqual(script.clean_abstract("   "), "")

    def test_refusal_and_empty_output_are_recorded_as_errors(self):
        post = {"microblog_id": "1", "body_hash": "aaa"}
        refusal = SimpleNamespace(stop_reason="refusal", content=[])
        self.assertEqual(script.entry_from_message(refusal, post)["error"], "refusal")
        empty = SimpleNamespace(
            stop_reason="end_turn", content=[SimpleNamespace(type="text", text=" ")]
        )
        entry = script.entry_from_message(empty, post)
        self.assertEqual(entry["error"], "empty")
        self.assertEqual(entry["body_hash"], "aaa")

    def test_prompt_never_gives_jamie_a_pronoun(self):
        # The posts are first person, so any pronoun for Jamie would be the
        # model's guess from the name.
        self.assertIn("Never use a pronoun for Jamie", script.SYSTEM_PROMPT)

    def test_pronoun_repair_edits_only_flagged_abstracts_and_marks_them(self):
        sent = []
        replies = {
            "Jamie celebrates his wife Tammy's birthday with a haiku.": (
                "Jamie celebrates Jamie's wife Tammy's birthday with a haiku."
            ),
            "Jamie reads a memoir that follows his path to surgery.": (
                "Jamie reads a memoir that follows his path to surgery."
            ),
            "Jamie removed analytics from his sites.": "Sorry, I can't.",
            # One of two missed on the first pass, caught on the second.
            "Jamie replaced his Mazda, and his Model 3 went to Tammy.": (
                "Jamie replaced Jamie's Mazda, and his Model 3 went to Tammy."
            ),
            "Jamie replaced Jamie's Mazda, and his Model 3 went to Tammy.": (
                "Jamie replaced Jamie's Mazda, and Jamie's Model 3 went to Tammy."
            ),
        }

        def create(**params):
            sent.append(params)
            content = params["messages"][0]["content"]
            text = replies[content.split("<abstract>\n")[1].split("\n</abstract>")[0]]
            return SimpleNamespace(
                stop_reason="end_turn",
                content=[SimpleNamespace(type="text", text=text)],
                usage=SimpleNamespace(input_tokens=120, output_tokens=30),
            )

        client = SimpleNamespace(messages=SimpleNamespace(create=create))
        entries = {
            "1": {"abstract": "Jamie celebrates his wife Tammy's birthday with a haiku."},
            "2": {"abstract": "Jamie reads a memoir that follows his path to surgery."},
            "3": {"abstract": "Jamie removed analytics from his sites."},
            "4": {"abstract": "Jamie shares photos from a paddle on the lake."},
            "5": {"abstract": "Jamie on his bike.", "pronouns_checked": True},
            "6": {"body_hash": "aaa", "error": "refusal"},
            "7": {"abstract": "Jamie replaced his Mazda, and his Model 3 went to Tammy."},
        }
        posts = {"1": {"text": "It's Tammy's birthday, so I wrote her a haiku."}}
        checked = script.repair_pronouns(client, entries, script.Usage(), posts=posts)
        first = next(p for p in sent if "Tammy's birthday with" in p["messages"][0]["content"])
        self.assertTrue(first["messages"][0]["content"].startswith("<post>\nIt's Tammy's"))

        self.assertEqual(
            sorted(p["messages"][0]["content"].split("<abstract>\n")[1][:14] for p in sent),
            [
                "Jamie celebrat",
                "Jamie reads a ",
                "Jamie removed ",
                "Jamie replaced",
                "Jamie replaced",
            ],
        )
        self.assertEqual(sent[0]["system"], script.PRONOUN_PROMPT)
        self.assertEqual(checked, 3)
        self.assertEqual(
            entries["7"]["abstract"],
            "Jamie replaced Jamie's Mazda, and Jamie's Model 3 went to Tammy.",
        )
        self.assertEqual(
            entries["1"],
            {
                "abstract": "Jamie celebrates Jamie's wife Tammy's birthday with a haiku.",
                "pronouns_checked": True,
            },
        )
        # Someone else's "his" survives the edit, and the entry is still checked.
        self.assertTrue(entries["2"]["pronouns_checked"])
        # A reply about the task is not stored and is retried next run.
        self.assertEqual(entries["3"], {"abstract": "Jamie removed analytics from his sites."})
        self.assertTrue(script.needs_pronoun_repair(entries["3"]))
        self.assertFalse(script.needs_pronoun_repair(entries["4"]))
        self.assertFalse(script.needs_pronoun_repair(entries["5"]))
        self.assertFalse(script.needs_pronoun_repair(entries["6"]))

    def test_a_reply_about_the_task_is_not_stored_as_an_abstract(self):
        post = {"microblog_id": "1", "body_hash": "aaa"}
        meta = SimpleNamespace(
            stop_reason="end_turn",
            content=[
                SimpleNamespace(
                    type="text",
                    text="I don't have access to the embedded collection. Could you provide it?",
                )
            ],
        )
        self.assertEqual(script.entry_from_message(meta, post)["error"], "not_an_abstract")
        titled = SimpleNamespace(
            stop_reason="end_turn",
            content=[SimpleNamespace(type="text", text="Jamie reviews I Heart Huckabees.")],
        )
        self.assertEqual(
            script.entry_from_message(titled, post)["abstract"], "Jamie reviews I Heart Huckabees."
        )

    def test_direct_run_writes_sidecar_incrementally_without_network(self):
        posts = script.collect_posts(self.blog)
        seen = []

        def create(**params):
            seen.append(params)
            return SimpleNamespace(
                stop_reason="end_turn",
                content=[SimpleNamespace(type="text", text=ABSTRACT)],
                usage=SimpleNamespace(input_tokens=500, output_tokens=40),
            )

        client = SimpleNamespace(messages=SimpleNamespace(create=create))
        sidecar_path = self.root / "blog-abstracts.json"
        sidecar: dict = {}
        usage = script.Usage()
        script.run_direct(client, posts, sidecar, usage, sidecar_path=sidecar_path)

        self.assertEqual(seen[0]["model"], script.MODEL)
        self.assertIn("On Systems Thinking", seen[0]["messages"][0]["content"])
        written = json.loads(sidecar_path.read_text(encoding="utf-8"))
        entry = written[str(ESSAY_ID)]
        self.assertEqual(entry["abstract"], ABSTRACT)
        self.assertEqual(entry["body_hash"], posts[0]["body_hash"])
        self.assertEqual(entry["model"], script.MODEL)
        self.assertEqual(script.select_pending(posts, written), [])
        self.assertGreater(usage.cost(), 0)

    def test_batch_results_record_invalid_requests_and_leave_transients(self):
        state = {
            "batch_id": "msgbatch_test",
            "posts": {
                f"mb-{mid}": {"microblog_id": str(mid), "body_hash": f"h{mid}"}
                for mid in (1, 2, 3, 4)
            },
        }

        def message(text):
            return SimpleNamespace(
                stop_reason="end_turn",
                content=[SimpleNamespace(type="text", text=text)],
                usage=SimpleNamespace(input_tokens=1000, output_tokens=50),
            )

        def errored(kind):
            return SimpleNamespace(
                type="errored", error=SimpleNamespace(error=SimpleNamespace(type=kind))
            )

        results = [
            SimpleNamespace(
                custom_id="mb-1", result=SimpleNamespace(type="succeeded", message=message("A."))
            ),
            SimpleNamespace(custom_id="mb-2", result=errored("invalid_request_error")),
            SimpleNamespace(custom_id="mb-3", result=errored("overloaded_error")),
            SimpleNamespace(custom_id="mb-4", result=SimpleNamespace(type="expired")),
        ]
        ended = SimpleNamespace(
            processing_status="ended",
            request_counts=SimpleNamespace(
                processing=0, succeeded=1, errored=2, expired=1, canceled=0
            ),
        )
        client = SimpleNamespace(
            messages=SimpleNamespace(
                batches=SimpleNamespace(
                    retrieve=lambda batch_id: ended, results=lambda batch_id: iter(results)
                )
            )
        )
        state_path = self.root / "batch.json"
        state_path.write_text(json.dumps(state), encoding="utf-8")
        sidecar_path = self.root / "blog-abstracts.json"
        sidecar: dict = {}
        usage = script.Usage()
        with mock.patch.object(script, "BATCH_STATE", state_path):
            script.collect_batch(client, state, sidecar, usage, 0, sidecar_path=sidecar_path)

        written = json.loads(sidecar_path.read_text(encoding="utf-8"))
        self.assertEqual(written["1"]["abstract"], "A.")
        self.assertEqual(written["2"]["error"], "invalid_request")
        self.assertNotIn("3", written)
        self.assertNotIn("4", written)
        self.assertFalse(state_path.exists())
        # Batch results are billed at half the direct rate.
        direct = script.anthropic_client.cost_usd(
            script.RATE_MODEL, input_tokens=1000, output_tokens=50
        )
        self.assertAlmostEqual(usage.cost(), direct * script.BATCH_DISCOUNT)


if __name__ == "__main__":
    unittest.main()
