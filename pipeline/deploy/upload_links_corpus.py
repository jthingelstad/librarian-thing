"""Build the embedded links corpus and upload it to S3.

Linking Things (links.thingelstad.xyz: every public link Jamie has saved
since 2005) is its own corpus and S3 key, one passage per saved link. The
Lambda loads it only when a request asks for source_kind link (or opens a
link-<id>), so the default searches never pay for it. Incremental by
default: unchanged chunk ids reuse embeddings from the existing S3 corpus,
so a night's new links are the only ones embedded; pass --full to force a
full re-embed (about 16,500 passages).
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path

from corpus_fact import corpus_fact
from dotenv import load_dotenv
from librarian_core.corpus import (
    DEFAULT_EMBEDDING_DIMENSIONS,
    DEFAULT_EMBEDDING_MODEL,
    add_bedrock_embeddings,
    build_links_corpus,
)
from upload_corpus import (  # noqa: E402
    build_chunk_cache,
    fetch_existing_corpus,
    merge_cached_embeddings,
    staged_path,
    upload_json_gzip,
    write_staged,
)

STAGED_NAME = "links_corpus.json"


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bucket", default=os.environ.get("LIBRARIAN_BUCKET") or "weekly-thing-librarian"
    )
    parser.add_argument(
        "--key",
        default=os.environ.get("LIBRARIAN_LINKS_CORPUS_KEY", "artifacts/links_corpus.json"),
    )
    parser.add_argument("--embedding-model", default=DEFAULT_EMBEDDING_MODEL)
    parser.add_argument("--embedding-dimensions", type=int, default=DEFAULT_EMBEDDING_DIMENSIONS)
    parser.add_argument(
        "--keep-output", help="Optional local path for the embedded links corpus JSON"
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
        print(f"Uploaded staged links corpus to s3://{args.bucket}/{args.key}")
        return 0

    corpus = build_links_corpus()
    kinds = ", ".join(
        f"{count} {kind}" for kind, count in corpus["chunk_counts_by_link_type"].items()
    )
    print(f"Built links corpus: {corpus['chunk_count']} saved links ({kinds or 'none'})")
    if corpus["missing"]:
        # The library has no Linking Things snapshot until a round pulls it;
        # an empty corpus serves no link until then, and the round's next
        # build fills it.
        print("links corpus: the library holds no links/ snapshot yet; building it empty")

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
        print(f"Wrote embedded links corpus to {out_path}")

    if args.no_upload:
        print("--no-upload set; skipping S3 upload")
        return 0

    if not args.keep_output:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", suffix=".json", delete=False
        ) as handle:
            handle.write(json.dumps(corpus, ensure_ascii=False) + "\n")
            out_path = Path(handle.name)

    upload_json_gzip(args.bucket, args.key, out_path, facts=corpus_fact(STAGED_NAME, corpus))
    print(f"Uploaded embedded links corpus to s3://{args.bucket}/{args.key}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
