"""Truncation past Cohere Embed v3's 512 tokens is counted, not silent.

QA2 I2-4: chunks are sized in characters (2,048 a text, header included),
but the model reads at most 512 tokens and the builds send truncate END,
which drops the rest without an error. Measured 2026-10-01 on the live
corpora with Cohere's published tokenizer: 1,308 of 10,051 Weekly Thing
embed inputs and 630 of 11,973 blog inputs run past 512 tokens (the worst,
WT61's pasted blob, is 1,020). Bedrock agreed at the cap: with truncate
NONE it embedded a 505-token input and refused a 537-token one.

librarian_core.embed_tokens counts tokens the way that tokenizer does
(it matched the reference on all 22,033 live inputs), so the build and the
corpus gate can say how many inputs lose their tails. Re-chunking by tokens
is the fix that would make the count zero; this pins the count.
"""

from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
import unittest.mock
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

from librarian_core import corpus as core
from librarian_core.embed_tokens import COHERE_EMBED_MAX_TOKENS, embed_token_count
from librarian_core.paths import REPO

PROBES = json.loads((Path(__file__).parent / "fixtures" / "embed_token_probes.json").read_text())


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gate = _load("test_embed_tokens_gate", REPO / "pipeline" / "corpus" / "corpus_gate.py")


class TokenCountTests(unittest.TestCase):
    def test_counts_match_what_bedrock_accepted_and_refused(self):
        for probe in PROBES["probes"]:
            with self.subTest(chunk=probe["chunk"]):
                tokens = embed_token_count(probe["text"])
                self.assertEqual(tokens, probe["tokens"])
                fits = probe["bedrock_truncate_none"] == "embedded"
                self.assertEqual(tokens <= COHERE_EMBED_MAX_TOKENS, fits)

    def test_characters_do_not_bound_tokens(self):
        # The 537-token probe is shorter than the 505-token one.
        under, over = PROBES["probes"][0], PROBES["probes"][1]
        self.assertLess(len(over["text"]), len(under["text"]))
        self.assertLessEqual(len(over["text"]), core.COHERE_EMBED_MAX_TEXT_CHARS)

    def test_the_tokenizer_steps(self):
        self.assertEqual(embed_token_count(""), 2)  # [CLS] [SEP]
        self.assertEqual(embed_token_count("Hello, world!"), 6)  # hello , world !
        self.assertEqual(embed_token_count("Café"), embed_token_count("cafe"))
        self.assertEqual(embed_token_count("東京"), 4)  # one token a character
        self.assertEqual(embed_token_count("a" * 101), 3)  # an over-long word is one [UNK]
        self.assertEqual(embed_token_count("\x00�"), 2)  # cleaned away

    def test_the_build_says_how_many_inputs_are_cut(self):
        inputs = [PROBES["probes"][0]["text"], PROBES["probes"][1]["text"]]
        response = {"body": StringIO(json.dumps({"embeddings": [[0.0], [0.0]]}))}
        client = unittest.mock.Mock()
        client.invoke_model.return_value = response
        out = StringIO()
        with unittest.mock.patch.object(core, "_bedrock_runtime", return_value=client):
            with redirect_stdout(out):
                core.fetch_bedrock_embeddings(inputs, core.DEFAULT_EMBEDDING_MODEL)
        self.assertIn("embed_input_truncated: 1 of 2 inputs over 512 tokens", out.getvalue())


class GateReportTests(unittest.TestCase):
    @staticmethod
    def chunk(probe):
        # Each probe is a whole Weekly Thing embed input: take it back apart
        # into the chunk fields _embed_input joins.
        head, published, summary, section, text = probe["text"].split("\n", 4)
        number, subject = head.removeprefix("Weekly Thing #").split(": ", 1)
        chunk = {
            "id": probe["chunk"],
            "issue_number": int(number),
            "subject": subject,
            "publish_date": published.removeprefix("Published: "),
            "issue_abstract": summary.removeprefix("Issue summary: "),
            "section": section.removeprefix("Section: "),
            "text": text,
        }
        assert core._embed_input(chunk) == probe["text"]
        return chunk

    def corpus(self):
        return {"chunks": [self.chunk(probe) for probe in PROBES["probes"]]}

    def test_the_gate_counts_chunks_past_the_cap(self):
        over = gate.embed_truncation(self.corpus())
        self.assertEqual([chunk for chunk, _ in over], ["2ea265c29a377ce6", "7dbb61062b544f4d"])
        count, line = gate.embed_truncation_report("blog_corpus.json", self.corpus())
        self.assertEqual(count, 2)
        self.assertIn("blog_corpus.json 2 of 3 chunk inputs run past 512 tokens", line)

    def test_the_gate_warns_in_ci_but_does_not_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp)
            (stage / "blog_corpus.json").write_text(json.dumps({"posts": [], **self.corpus()}))
            argv = ["gate", "--candidate", str(stage), "--site-archive", str(stage / "none")]
            out = StringIO()
            # The ingest checks read the real blog markdown; they have their
            # own tests.
            with (
                unittest.mock.patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}),
                unittest.mock.patch.object(gate, "ingest_failures", return_value=[]),
            ):
                with redirect_stdout(out):
                    self.assertEqual(gate.main(argv), 0)
        self.assertIn("::warning title=Embed truncation (QA2 I2-4)::", out.getvalue())

    def test_the_gate_reads_the_cap_of_the_corpus_model(self):
        # Embed v4 reads 128K tokens: no live chunk comes near it.
        corpus = {**self.corpus(), "embedding_model": "cohere.embed-v4:0"}
        self.assertEqual(gate.embed_truncation(corpus), [])
        count, line = gate.embed_truncation_report("blog_corpus.json", corpus)
        self.assertEqual(count, 0)
        self.assertIn("past 128000 tokens (cohere.embed-v4:0)", line)


class EmbedModelTests(unittest.TestCase):
    """Embed v4 takes its vector length in the request and answers keyed by
    type; v3's body and parse stay as they were."""

    V4 = "cohere.embed-v4:0"

    def invoke(self, inputs, model, dimensions, answer):
        client = unittest.mock.Mock()
        client.invoke_model.return_value = {"body": StringIO(json.dumps(answer))}
        with unittest.mock.patch.object(core, "_bedrock_runtime", return_value=client):
            with redirect_stdout(StringIO()):
                vectors = core.fetch_bedrock_embeddings(inputs, model, dimensions=dimensions)
        return vectors, json.loads(client.invoke_model.call_args.kwargs["body"])

    def test_v3_body_is_unchanged(self):
        vectors, body = self.invoke(
            ["a"], core.DEFAULT_EMBEDDING_MODEL, 1024, {"embeddings": [[1.0]]}
        )
        self.assertEqual(vectors, [[1.0]])
        self.assertEqual(body, {"texts": ["a"], "input_type": "search_document", "truncate": "END"})

    def test_v4_asks_for_its_length_and_reads_the_float_vectors(self):
        answer = {"response_type": "embeddings_by_type", "embeddings": {"float": [[0.5, 0.5]]}}
        vectors, body = self.invoke(["a"], self.V4, 2, answer)
        self.assertEqual(vectors, [[0.5, 0.5]])
        self.assertEqual(body["output_dimension"], 2)
        self.assertEqual(body["embedding_types"], ["float"])
        self.assertEqual(body["truncate"], "RIGHT")

    def test_v4_keeps_text_past_v3s_character_cap(self):
        long = "word " * 1000
        _, body = self.invoke([long], self.V4, 1, {"embeddings": {"float": [[1.0]]}})
        self.assertEqual(body["texts"], [long])
        _, body = self.invoke([long], core.DEFAULT_EMBEDDING_MODEL, None, {"embeddings": [[1.0]]})
        self.assertEqual(len(body["texts"][0]), core.COHERE_EMBED_MAX_TEXT_CHARS)

    def test_a_wrong_length_vector_fails_the_build(self):
        with self.assertRaisesRegex(RuntimeError, "asked for 512"):
            self.invoke(["a"], self.V4, 512, {"embeddings": {"float": [[0.0] * 1536]}})

    def test_an_inference_profile_is_the_same_model(self):
        self.assertTrue(core.is_embed_v4("us.cohere.embed-v4:0"))
        self.assertFalse(core.is_embed_v4(core.DEFAULT_EMBEDDING_MODEL))

    def test_a_throttled_batch_waits_and_tries_again(self):
        from botocore.exceptions import ClientError

        throttled = ClientError({"Error": {"Code": "ThrottlingException"}}, "InvokeModel")
        answer = {"body": StringIO(json.dumps({"embeddings": {"float": [[1.0]]}}))}
        client = unittest.mock.Mock()
        client.invoke_model.side_effect = [throttled, throttled, answer]
        with unittest.mock.patch.object(core, "_bedrock_runtime", return_value=client):
            with unittest.mock.patch.object(core.time, "sleep") as sleep:
                with redirect_stdout(StringIO()):
                    vectors = core.fetch_bedrock_embeddings(["a"], self.V4, dimensions=1)
        self.assertEqual(vectors, [[1.0]])
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [5, 10])

    def test_a_v4_build_paces_its_batches_under_the_minute_limit(self):
        answer = lambda: {"body": StringIO(json.dumps({"embeddings": {"float": [[1.0]]}}))}  # noqa: E731
        client = unittest.mock.Mock()
        client.invoke_model.side_effect = [answer(), answer(), answer()]
        clock = [1000.0]
        waits = []

        def sleep(seconds):
            waits.append(seconds)
            clock[0] += seconds

        text = "x" * 350  # 100 estimated tokens
        with (
            unittest.mock.patch.object(core, "_bedrock_runtime", return_value=client),
            unittest.mock.patch.object(core, "EMBED_V4_TOKENS_PER_MINUTE", 250),
            unittest.mock.patch.object(core, "_embed_sent", core.collections.deque()),
            unittest.mock.patch.object(core.time, "monotonic", lambda: clock[0]),
            unittest.mock.patch.object(core.time, "sleep", sleep),
        ):
            for _ in range(3):
                core.fetch_bedrock_embeddings([text], self.V4, dimensions=1)
        # Two batches fit in the minute; the third waits for the first to age out.
        self.assertEqual(len(waits), 1)
        self.assertAlmostEqual(waits[0], 60.1)

    def test_v3_is_not_paced(self):
        answer = lambda: {"body": StringIO(json.dumps({"embeddings": [[1.0]]}))}  # noqa: E731
        client = unittest.mock.Mock()
        client.invoke_model.side_effect = [answer(), answer(), answer()]
        with (
            unittest.mock.patch.object(core, "_bedrock_runtime", return_value=client),
            unittest.mock.patch.object(core, "EMBED_V4_TOKENS_PER_MINUTE", 1),
            unittest.mock.patch.object(core, "_embed_sent", core.collections.deque()),
            unittest.mock.patch.object(core.time, "sleep") as sleep,
        ):
            for _ in range(3):
                core.fetch_bedrock_embeddings(["x" * 400], "cohere.embed-english-v3")
        sleep.assert_not_called()

    def test_any_other_error_fails_at_once(self):
        from botocore.exceptions import ClientError

        denied = ClientError({"Error": {"Code": "AccessDeniedException"}}, "InvokeModel")
        client = unittest.mock.Mock()
        client.invoke_model.side_effect = denied
        with unittest.mock.patch.object(core, "_bedrock_runtime", return_value=client):
            with self.assertRaises(ClientError):
                core.fetch_bedrock_embeddings(["a"], self.V4, dimensions=1)
        self.assertEqual(client.invoke_model.call_count, 1)


if __name__ == "__main__":
    unittest.main()
