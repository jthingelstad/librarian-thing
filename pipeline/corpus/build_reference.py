"""CLI entrypoint: build the citation-ready reference corpus.

The reference base is what the Librarian always consults and no caller
selects (Jamie, 2026-10-23): the Weekly Thing's site pages and FAQ, Things
I've built, thingelstad.com's pages, and the documents about Jamie in the
library (``data/reference/``, from ``reference-documents/`` in git, and
``data/reference-unpublished/``, placed in the library by hand). See
``build_reference_corpus`` in librarian_core/corpus.py.

A local candidate from any folder, written nowhere but ``--output``:

    python pipeline/corpus/build_reference.py \\
        --unpublished-dir ~/somewhere/docs --output candidate/reference_corpus.json

The build itself reads only files. ``--embed`` calls Bedrock (Cohere) for
every chunk; the deploy embeds instead, through the upload step's cache.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from librarian_core.corpus import (
    DEFAULT_EMBEDDING_DIMENSIONS,
    DEFAULT_EMBEDDING_MODEL,
    add_bedrock_embeddings,
    build_reference_corpus,
)
from librarian_core.paths import REFERENCE_CORPUS_PATH, REFERENCE_DIR, REFERENCE_UNPUBLISHED_DIR
from librarian_core.reference import ReferenceDocumentError

OUT_PATH = REFERENCE_CORPUS_PATH

__all__ = [
    "DEFAULT_EMBEDDING_DIMENSIONS",
    "DEFAULT_EMBEDDING_MODEL",
    "OUT_PATH",
    "add_bedrock_embeddings",
    "build_reference_corpus",
    "main",
]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build the reference corpus the Librarian always consults."
    )
    parser.add_argument("--output", default=str(REFERENCE_CORPUS_PATH), help="Output JSON path")
    parser.add_argument(
        "--reference-dir",
        type=Path,
        default=REFERENCE_DIR,
        help="the published documents (default: the tree's reference/)",
    )
    parser.add_argument(
        "--unpublished-dir",
        type=Path,
        default=REFERENCE_UNPUBLISHED_DIR,
        help="the unpublished documents (default: the tree's reference-unpublished/)",
    )
    parser.add_argument(
        "--embed", action="store_true", help="Add Bedrock Cohere embeddings to each chunk"
    )
    parser.add_argument("--embedding-model", default=DEFAULT_EMBEDDING_MODEL)
    parser.add_argument("--embedding-dimensions", type=int, default=DEFAULT_EMBEDDING_DIMENSIONS)
    args = parser.parse_args()

    try:
        corpus = build_reference_corpus(
            reference_dir=args.reference_dir, unpublished_dir=args.unpublished_dir
        )
    except ReferenceDocumentError as error:
        print(f"reference corpus build failed: {error}", file=sys.stderr)
        return 1
    if args.embed:
        add_bedrock_embeddings(corpus, args.embedding_model, args.embedding_dimensions)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(corpus, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    kinds = ", ".join(f"{count} {kind}" for kind, count in corpus["chunk_counts_by_kind"].items())
    print(f"Wrote {corpus['chunk_count']} reference chunks ({kinds or 'none'}) to {output}")
    for document in corpus["documents"]:
        print(
            f"  doc-{document['doc_id']} ({document['folder']}): {document['chunk_count']} "
            f"chunks, {document['char_count']:,} characters"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
