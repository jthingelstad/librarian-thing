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
        with unittest.mock.patch.object(core.boto3, "client", return_value=client):
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
            with unittest.mock.patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}):
                with redirect_stdout(out):
                    self.assertEqual(gate.main(argv), 0)
        self.assertIn("::warning title=Embed truncation (QA2 I2-4)::", out.getvalue())


if __name__ == "__main__":
    unittest.main()
