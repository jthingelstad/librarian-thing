"""Build the embedded thingelstad.com blog corpus and upload it to S3.

Separate cadence + S3 key from the Weekly Thing corpus (upload_corpus.py).
The blog corpus is large and rarely changes, so it is NOT rebuilt on every
WT deploy / CI run — run this explicitly via `npm run librarian:deploy:blog`.

Incremental by default: fetches the existing blog corpus from S3 once at the
start, copies cached embeddings onto unchanged chunks (matched by stable
chunk_id), and only sends the leftover chunks to Bedrock. Pass --full to skip
the cache and re-embed everything (the expensive first backfill).
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path

import boto3
from dotenv import load_dotenv
from librarian_core.corpus import (
    DEFAULT_EMBEDDING_DIMENSIONS,
    DEFAULT_EMBEDDING_MODEL,
    add_bedrock_embeddings,
    build_blog_corpus,
)

# Reuse the WT uploader's incremental-cache helpers verbatim — they are
# corpus-shape agnostic (they key on chunk["id"]/chunk["embedding"]).
# Sibling import: this script is run as `python pipeline/deploy/upload_blog_corpus.py`,
# so its own directory is on sys.path and upload_corpus resolves as a sibling.
from upload_corpus import (  # noqa: E402
    build_chunk_cache,
    upload_json_gzip,
    fetch_existing_corpus,
    merge_cached_embeddings,
)


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bucket", default=os.environ.get("LIBRARIAN_BUCKET") or "weekly-thing-librarian"
    )
    parser.add_argument(
        "--key", default=os.environ.get("LIBRARIAN_BLOG_CORPUS_KEY", "artifacts/blog_corpus.json")
    )
    parser.add_argument("--embedding-model", default=DEFAULT_EMBEDDING_MODEL)
    parser.add_argument("--embedding-dimensions", type=int, default=DEFAULT_EMBEDDING_DIMENSIONS)
    parser.add_argument(
        "--keep-output", help="Optional local path for the embedded blog corpus JSON"
    )
    parser.add_argument(
        "--full", action="store_true", help="Skip the incremental cache and re-embed every chunk"
    )
    parser.add_argument(
        "--no-upload",
        action="store_true",
        help="Build + embed locally but skip the S3 upload (dry run)",
    )
    args = parser.parse_args()

    if not args.bucket:
        raise RuntimeError("Provide --bucket or LIBRARIAN_BUCKET")

    corpus = build_blog_corpus()
    print(f"Built blog corpus: {corpus['post_count']} posts -> {corpus['chunk_count']} chunks")

    if not args.full:
        existing = fetch_existing_corpus(args.bucket, args.key)
        if existing is not None:
            cache = build_chunk_cache(existing, args.embedding_model, args.embedding_dimensions)
            merge_cached_embeddings(corpus, cache)

    add_bedrock_embeddings(corpus, args.embedding_model, args.embedding_dimensions)

    if args.keep_output:
        out_path = Path(args.keep_output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(corpus, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"Wrote embedded blog corpus to {out_path}")

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
    print(f"Uploaded embedded blog corpus to s3://{args.bucket}/{args.key}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
