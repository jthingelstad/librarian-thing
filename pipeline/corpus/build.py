"""CLI entrypoint: build the citation-ready archive corpus.

Thin wrapper around :mod:`librarian_core.corpus`. Build logic lives in the
package; this file just exposes the argparse interface that CI, npm scripts,
and Makefile targets call. Re-exports a few names (``build_corpus``,
``OUT_PATH``, ``DEFAULT_EMBEDDING_MODEL``, ``DEFAULT_EMBEDDING_DIMENSIONS``)
so existing test fixtures and sibling scripts that imported from this module
keep working without churn.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from librarian_core.corpus import (
    DEFAULT_EMBEDDING_DIMENSIONS,
    DEFAULT_EMBEDDING_MODEL,
    add_bedrock_embeddings,
    annotate_media_descriptions,
    build_corpus,
)
from librarian_core.paths import MEDIA_DESCRIPTIONS_PATH, ARCHIVE_DIR, CORPUS_PATH

OUT_PATH = CORPUS_PATH

__all__ = [
    "ARCHIVE_DIR",
    "DEFAULT_EMBEDDING_DIMENSIONS",
    "DEFAULT_EMBEDDING_MODEL",
    "OUT_PATH",
    "add_bedrock_embeddings",
    "build_corpus",
    "main",
]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build a citation-ready corpus for the archive librarian."
    )
    parser.add_argument("--output", default=str(CORPUS_PATH), help="Output JSON path")
    parser.add_argument(
        "--embed", action="store_true", help="Add Bedrock Cohere embeddings to each chunk"
    )
    parser.add_argument(
        "--include-issue-bodies",
        action="store_true",
        help="Include full issue bodies and sections for runtime tools",
    )
    parser.add_argument("--embedding-model", default=DEFAULT_EMBEDDING_MODEL)
    parser.add_argument("--embedding-dimensions", type=int, default=DEFAULT_EMBEDDING_DIMENSIONS)
    args = parser.parse_args()

    corpus = build_corpus(include_issue_bodies=args.include_issue_bodies)
    annotated = annotate_media_descriptions(corpus, MEDIA_DESCRIPTIONS_PATH)
    print(f"media descriptions merged: {annotated}/{len(corpus.get('media', []))}")
    if args.embed:
        add_bedrock_embeddings(corpus, args.embedding_model, args.embedding_dimensions)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(corpus, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {corpus['chunk_count']} chunks from {corpus['issue_count']} issues to {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
