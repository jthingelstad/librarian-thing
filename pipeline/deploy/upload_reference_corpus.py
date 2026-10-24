"""Build the embedded reference corpus and upload it to S3.

The reference base (the Weekly Thing's site pages and FAQ, Things I've built,
thingelstad.com's pages, and the documents about Jamie) is its own corpus
and S3 key. The Lambda loads it beside whichever corpora a request's scope
names and always searches it; no scope or source kind selects or excludes
it. Incremental by default: unchanged chunk ids reuse embeddings from the
existing S3 corpus; pass --full to force a full re-embed.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path

from dotenv import load_dotenv
from librarian_core.corpus import (
    DEFAULT_EMBEDDING_DIMENSIONS,
    DEFAULT_EMBEDDING_MODEL,
    add_bedrock_embeddings,
    build_reference_corpus,
)
from upload_corpus import (  # noqa: E402
    build_chunk_cache,
    fetch_existing_corpus,
    merge_cached_embeddings,
    staged_path,
    upload_json_gzip,
    write_staged,
)

STAGED_NAME = "reference_corpus.json"


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bucket", default=os.environ.get("LIBRARIAN_BUCKET") or "weekly-thing-librarian"
    )
    parser.add_argument(
        "--key",
        default=os.environ.get("LIBRARIAN_REFERENCE_CORPUS_KEY", "artifacts/reference_corpus.json"),
    )
    parser.add_argument("--embedding-model", default=DEFAULT_EMBEDDING_MODEL)
    parser.add_argument("--embedding-dimensions", type=int, default=DEFAULT_EMBEDDING_DIMENSIONS)
    parser.add_argument(
        "--keep-output", help="Optional local path for the embedded reference corpus JSON"
    )
    parser.add_argument(
        "--full", action="store_true", help="Skip the incremental cache and re-embed every chunk"
    )
    parser.add_argument(
        "--no-upload",
        action="store_true",
        help="Build + embed locally but skip the S3 upload (dry run)",
    )
    parser.add_argument(
        "--stage",
        metavar="DIR",
        help=f"Build and embed into DIR/{STAGED_NAME} for the corpus gate; upload nothing",
    )
    parser.add_argument(
        "--upload-staged",
        metavar="DIR",
        help=f"Upload DIR/{STAGED_NAME} as staged, after the gate passed; build nothing",
    )
    args = parser.parse_args()

    if not args.bucket:
        raise RuntimeError("Provide --bucket or LIBRARIAN_BUCKET")

    if args.upload_staged:
        upload_json_gzip(args.bucket, args.key, staged_path(args.upload_staged, STAGED_NAME))
        print(f"Uploaded staged reference corpus to s3://{args.bucket}/{args.key}")
        return 0

    corpus = build_reference_corpus()
    kinds = ", ".join(f"{count} {kind}" for kind, count in corpus["chunk_counts_by_kind"].items())
    print(f"Built reference corpus: {corpus['chunk_count']} chunks ({kinds or 'none'})")

    if not args.full:
        existing = fetch_existing_corpus(args.bucket, args.key)
        if existing is not None:
            cache = build_chunk_cache(existing, args.embedding_model, args.embedding_dimensions)
            merge_cached_embeddings(corpus, cache)

    add_bedrock_embeddings(corpus, args.embedding_model, args.embedding_dimensions)

    if args.stage:
        write_staged(args.stage, STAGED_NAME, corpus)
        return 0

    if args.keep_output:
        out_path = Path(args.keep_output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(corpus, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"Wrote embedded reference corpus to {out_path}")

    if args.no_upload:
        print("--no-upload set; skipping S3 upload")
        return 0

    if not args.keep_output:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", suffix=".json", delete=False
        ) as handle:
            handle.write(json.dumps(corpus, ensure_ascii=False) + "\n")
            out_path = Path(handle.name)

    upload_json_gzip(args.bucket, args.key, out_path)
    print(f"Uploaded embedded reference corpus to s3://{args.bucket}/{args.key}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
