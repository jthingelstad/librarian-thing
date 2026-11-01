"""Embed a folder of corpora with another model, for the meaning eval.

Writes the vectors beside the corpora rather than into them: for each corpus
``<kind>.ids.json`` (chunk ids in order), ``<kind>.sha256.json`` (each row's
embed input, hashed), ``<kind>.f32`` (float32, n by dimensions) and, for
Embed v4, ``<kind>.i8`` (its int8 vectors from the same call). ``apps/librarian/lambda/scripts/eval-meaning.mjs --vectors`` swaps
them into the corpora it serves. Embed v4's shorter vectors are the leading
part of its 1536 (checked 2026-11-01: cosine 1.0 at 256, 512 and 1024), so
one pass at 1536 measures every length.

Each chunk's input is the one the build would embed (``_embed_input``), so
a run differs from the live corpora in the model alone; ``--link-text full``
lifts the cut a saved link's note gets to fit v3's 2,048 characters.

    AWS_PROFILE=cloud-engineer uv run --locked python pipeline/eval/embed_variant.py \\
        --corpus-dir tmp/live --out tmp/eval/vectors/v4-live

Resumable: a rerun appends only the chunks not yet written. Prints the
tokens Bedrock counted and their cost ($0.12 per million for v4, $0.10 for
v3, us-east-1).

Embed v4 on demand takes 150,000 tokens a minute and 8.1M a day, neither
adjustable, and the whole archive is 7.4M tokens (measured); the cross-region
profile ``us.cohere.embed-v4:0`` takes 300,000 a minute and 16.2M a day
(service quotas, 2026-11-01). ``--tpm`` paces the calls under the minute
limit, and a throttled call waits and tries again.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import boto3
import numpy as np
from botocore.config import Config
from botocore.exceptions import ClientError
from librarian_core.corpus import (
    _embed_header,
    _embed_input,
    bedrock_embed_body,
    embed_limits,
    embeddings_from_response,
    is_embed_v4,
)
from librarian_core.paths import REPO

CORPUS_FILES = {
    "weekly_thing": "corpus.json",
    "blog": "blog_corpus.json",
    "podcast": "podcast_corpus.json",
    "reference": "reference_corpus.json",
    "link": "links_corpus.json",
}
PRICE_PER_MILLION = {"v4": 0.12, "v3": 0.10}


def embed_input(chunk: dict[str, Any], link_text: str) -> str:
    if link_text == "full" and chunk.get("source_kind") == "link":
        return "\n".join([*_embed_header(chunk), chunk.get("text") or ""])
    return _embed_input(chunk)


def input_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def same_model(left: str, right: str) -> bool:
    # A cross-region profile (us.cohere.embed-v4:0) serves the same model as
    # its base id and returns the same vectors (cosine 0.9998, 2026-11-01).
    def base(model: str) -> str:
        return (
            model.split(".", 1)[1]
            if model.split(".", 1)[0] in {"us", "eu", "apac", "global"}
            else model
        )

    return base(left) == base(right)


class Embedder:
    def __init__(self, model: str, dimensions: int, tpm: int):
        self.model = model
        self.dimensions = dimensions
        self.tpm = tpm
        self.sent: deque[tuple[float, int]] = deque()
        self.client = boto3.client(
            "bedrock-runtime",
            region_name="us-east-1",
            config=Config(retries={"max_attempts": 10, "mode": "adaptive"}, read_timeout=120),
        )
        self.tokens = 0
        self.reused = 0
        self.lock = threading.Lock()

    def _pace(self, estimate: int) -> None:
        # A sliding minute of estimated tokens (3.5 characters a token; the
        # archive runs about 3.66 on v4), kept under --tpm.
        while True:
            with self.lock:
                now = time.monotonic()
                while self.sent and now - self.sent[0][0] > 60:
                    self.sent.popleft()
                if sum(n for _, n in self.sent) + estimate <= self.tpm or not self.sent:
                    self.sent.append((now, estimate))
                    return
                wait = 60 - (now - self.sent[0][0]) + 0.1
            time.sleep(wait)

    def _invoke(self, body: dict[str, Any]) -> Any:
        for attempt in range(12):
            try:
                return self.client.invoke_model(
                    modelId=self.model,
                    body=json.dumps(body),
                    accept="application/json",
                    contentType="application/json",
                )
            except ClientError as error:
                if error.response["Error"]["Code"] != "ThrottlingException" or attempt == 11:
                    raise
                time.sleep(min(60, 5 * 2**attempt))
        raise RuntimeError("unreachable")

    def __call__(self, inputs: list[str]) -> tuple[np.ndarray, np.ndarray | None]:
        max_chars = embed_limits(self.model)["max_chars"]
        if max_chars:
            inputs = [text[:max_chars] for text in inputs]
        body = bedrock_embed_body(inputs, self.model, "search_document", self.dimensions)
        v4 = is_embed_v4(self.model)
        if v4:
            body["embedding_types"] = ["float", "int8"]
        self._pace(int(sum(len(text) for text in inputs) / 3.5))
        response = self._invoke(body)
        counted = response["ResponseMetadata"]["HTTPHeaders"].get(
            "x-amzn-bedrock-input-token-count"
        )
        data = json.loads(response["body"].read())
        floats = np.asarray(embeddings_from_response(data), dtype=np.float32)
        if floats.shape != (len(inputs), self.dimensions):
            raise RuntimeError(
                f"got vectors {floats.shape}, wanted {(len(inputs), self.dimensions)}"
            )
        int8 = np.asarray(data["embeddings"]["int8"], dtype=np.int8) if v4 else None
        with self.lock:
            self.tokens += int(counted or 0)
        return floats, int8


class Reuse:
    """Vectors from an earlier run, for chunks whose embed input is the same
    there (``--reuse <dir>``): a variant that changes a few inputs pays only
    for those."""

    def __init__(self, folder: Path | None, kind: str, dimensions: int, model: str):
        self.rows: dict[str, int] = {}
        self.hashes: list[str] = []
        if not folder or not (folder / f"{kind}.ids.json").exists():
            return
        meta = json.loads((folder / "meta.json").read_text())
        if not same_model(str(meta.get("model") or ""), model):
            raise SystemExit(f"--reuse {folder} holds {meta.get('model')} vectors, not {model}")
        if int(meta.get("dimensions") or 0) != dimensions:
            raise SystemExit(f"--reuse {folder} holds {meta.get('dimensions')} dimensions")
        ids = json.loads((folder / f"{kind}.ids.json").read_text())
        # The hash of the input each vector was made from, written with it:
        # some chunk ids are fixed (a site page's, a thing's), so an id alone
        # does not say the text is the same, and the run's corpus folder may
        # have been rebuilt since.
        hashes_path = folder / f"{kind}.sha256.json"
        if not hashes_path.exists():
            raise SystemExit(
                f"--reuse {folder} has no {hashes_path.name}; its inputs cannot be checked"
            )
        self.hashes = json.loads(hashes_path.read_text())
        if len(self.hashes) != len(ids):
            raise SystemExit(f"{hashes_path} does not match {kind}.ids.json")
        self.rows = {chunk_id: index for index, chunk_id in enumerate(ids)}
        self.f32 = np.memmap(folder / f"{kind}.f32", dtype=np.float32, mode="r").reshape(
            len(ids), dimensions
        )
        i8_path = folder / f"{kind}.i8"
        self.i8 = (
            np.memmap(i8_path, dtype=np.int8, mode="r").reshape(len(ids), dimensions)
            if i8_path.exists()
            else None
        )

    def find(self, chunk: dict[str, Any], link_text: str) -> int | None:
        index = self.rows.get(str(chunk.get("id")))
        if index is None or self.hashes[index] != input_hash(embed_input(chunk, link_text)):
            return None
        return index


def embed_rows(
    rows: list[dict[str, Any]], embed: Embedder, link_text: str, reuse: Reuse
) -> tuple[np.ndarray, np.ndarray | None]:
    found = [reuse.find(row, link_text) for row in rows]
    todo = [row for row, index in zip(rows, found) if index is None]
    fresh_f, fresh_i = (
        embed([embed_input(row, link_text) for row in todo]) if todo else (None, None)
    )
    floats = np.zeros((len(rows), embed.dimensions), dtype=np.float32)
    int8 = np.zeros((len(rows), embed.dimensions), dtype=np.int8)
    has_int8 = True
    cursor = 0
    for position, index in enumerate(found):
        if index is None:
            floats[position] = fresh_f[cursor]
            if fresh_i is None:
                has_int8 = False
            else:
                int8[position] = fresh_i[cursor]
            cursor += 1
        else:
            floats[position] = reuse.f32[index]
            if reuse.i8 is None:
                has_int8 = False
            else:
                int8[position] = reuse.i8[index]
    with embed.lock:
        embed.reused += len(rows) - len(todo)
    return floats, int8 if has_int8 else None


def open_output(out: Path, model: str, dimensions: int) -> dict[str, Any]:
    """The --out folder's meta. A folder resumes only the model and dimensions
    it was started with: its vectors are kept by input, and an input does not
    say which model embedded it."""
    meta_path = out / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    if any(out.glob("*.ids.json")) and not meta.get("model"):
        raise SystemExit(f"--out {out} holds vectors but no meta.json names their model")
    if meta.get("model") and not same_model(str(meta["model"]), model):
        raise SystemExit(f"--out {out} holds {meta['model']} vectors, not {model}")
    if meta.get("dimensions") and int(meta["dimensions"]) != dimensions:
        raise SystemExit(f"--out {out} holds {meta['dimensions']} dimensions, not {dimensions}")
    return meta


def run_corpus(
    kind: str,
    chunks: list[dict[str, Any]],
    out: Path,
    embed: Embedder,
    link_text: str,
    batch: int,
    reuse: Reuse,
) -> None:
    ids_path = out / f"{kind}.ids.json"
    hashes_path = out / f"{kind}.sha256.json"
    f32_path = out / f"{kind}.f32"
    i8_path = out / f"{kind}.i8"
    done = json.loads(ids_path.read_text()) if ids_path.exists() else []
    hashes = json.loads(hashes_path.read_text()) if hashes_path.exists() else []
    expected = [str(chunk.get("id")) for chunk in chunks]
    expected_hashes = [input_hash(embed_input(chunk, link_text)) for chunk in chunks]
    if done != expected[: len(done)] or hashes != expected_hashes[: len(done)]:
        raise SystemExit(
            f"{ids_path} does not match the corpus's order or inputs; delete the run to start over"
        )
    pending = chunks[len(done) :]
    if not pending:
        print(f"{kind}: all {len(chunks)} chunks already embedded")
        return
    print(f"{kind}: embedding {len(pending)} of {len(chunks)} chunks")
    batches = [pending[start : start + batch] for start in range(0, len(pending), batch)]
    # Batches run in parallel but are written in order, eight ahead at most,
    # so a stop leaves a clean prefix to resume from.
    with ThreadPoolExecutor(max_workers=4) as pool:
        for start in range(0, len(batches), 8):
            group = batches[start : start + 8]
            results = list(pool.map(lambda rows: embed_rows(rows, embed, link_text, reuse), group))
            with f32_path.open("ab") as f32:
                for floats, _ in results:
                    f32.write(floats.tobytes())
            if results[0][1] is not None:
                with i8_path.open("ab") as i8:
                    for _, int8 in results:
                        i8.write(int8.tobytes())
            for rows in group:
                done.extend(str(row.get("id")) for row in rows)
            hashes = expected_hashes[: len(done)]
            hashes_path.write_text(json.dumps(hashes))
            ids_path.write_text(json.dumps(done))
            print(f"  {kind}: {len(done)} of {len(chunks)} (tokens so far {embed.tokens:,})")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--corpus-dir", type=Path, default=REPO / "tmp" / "live")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", default="cohere.embed-v4:0")
    parser.add_argument("--dimensions", type=int, default=1536)
    parser.add_argument("--link-text", choices=("cut", "full"), default="cut")
    parser.add_argument("--batch", type=int, default=96)
    parser.add_argument("--only", nargs="*", help="corpora to embed (default: all)")
    parser.add_argument("--tpm", type=int, default=240_000, help="tokens a minute to stay under")
    parser.add_argument(
        "--reuse", type=Path, help="an earlier run whose vectors serve unchanged embed inputs"
    )
    args = parser.parse_args(argv)

    args.out.mkdir(parents=True, exist_ok=True)
    meta = open_output(args.out, args.model, args.dimensions)
    meta.setdefault("tokens", 0)
    meta.update(
        {
            "model": meta.get("model") or args.model,
            "dimensions": args.dimensions,
            "link_text": args.link_text,
            "corpus_dir": str(args.corpus_dir),
        }
    )
    # Written before the first vector, so a run that stops still names its model.
    meta_path = args.out / "meta.json"
    meta_path.write_text(json.dumps(meta, indent=1) + "\n")
    embed = Embedder(args.model, args.dimensions, args.tpm)
    for kind, name in CORPUS_FILES.items():
        if args.only and kind not in args.only:
            continue
        chunks = json.loads((args.corpus_dir / name).read_text())["chunks"]
        reuse = Reuse(args.reuse, kind, args.dimensions, args.model)
        run_corpus(kind, chunks, args.out, embed, args.link_text, args.batch, reuse)
    price = PRICE_PER_MILLION["v4" if is_embed_v4(args.model) else "v3"]
    meta["tokens"] += embed.tokens
    meta["cost_usd"] = round(meta["tokens"] / 1e6 * price, 4)
    meta_path.write_text(json.dumps(meta, indent=1) + "\n")
    print(
        f"Bedrock counted {embed.tokens:,} tokens this run; total {meta['tokens']:,} (${meta['cost_usd']})"
    )
    if args.reuse:
        print(f"reused {embed.reused:,} vectors from {args.reuse}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
