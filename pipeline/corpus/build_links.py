"""CLI entrypoint: build the citation-ready links corpus.

Linking Things (links.thingelstad.xyz, Jamie, 2026-10-23) is every public
link Jamie has saved since 2005. The links corpus is one passage per saved
link, selectable as source_kind ``link`` and searched only when a caller
asks for it. It reads the library's snapshot (``data/links/``, pulled by the
round with ``pipeline/links/import_links.py``). See ``build_links_corpus``
in librarian_core/corpus.py.

A local candidate, written nowhere but ``--output`` (no S3, no git):

    uv run --locked python pipeline/library/library.py download
    uv run --locked python pipeline/library/library.py export
    uv run --locked python pipeline/corpus/build_links.py --output /tmp/links_corpus.json

Until the round pulls ``links`` into the library, snapshot the site first
(``pipeline/links/import_links.py --output-dir /tmp/links``) and pass
``--links-dir /tmp/links``.

The build itself reads only files. ``--embed`` calls Bedrock (Cohere) for
every passage, about 16,500 of them; the deploy embeds instead, through the
upload step's cache.
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
    build_links_corpus,
)
from librarian_core.paths import LINKS_CORPUS_PATH, LINKS_DIR

OUT_PATH = LINKS_CORPUS_PATH


def summary(corpus: dict) -> str:
    kinds = ", ".join(
        f"{count} {kind}" for kind, count in corpus["chunk_counts_by_link_type"].items()
    )
    voices = ", ".join(f"{count} {voice}" for voice, count in corpus["note_voice_counts"].items())
    return (
        f"{corpus['chunk_count']} saved links ({kinds or 'none'}); notes: {voices or 'none'}; "
        f"{corpus['shared_link_count']} shared in an issue"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the links corpus (Linking Things).")
    parser.add_argument("--output", default=str(LINKS_CORPUS_PATH), help="Output JSON path")
    parser.add_argument(
        "--links-dir",
        type=Path,
        default=LINKS_DIR,
        help="the snapshot (default: the tree's links/)",
    )
    parser.add_argument(
        "--embed", action="store_true", help="Add Bedrock Cohere embeddings to each chunk"
    )
    parser.add_argument("--embedding-model", default=DEFAULT_EMBEDDING_MODEL)
    parser.add_argument("--embedding-dimensions", type=int, default=DEFAULT_EMBEDDING_DIMENSIONS)
    args = parser.parse_args()

    corpus = build_links_corpus(links_dir=args.links_dir)
    if corpus["missing"]:
        print(
            f"links corpus: no snapshot in {args.links_dir}; the corpus is empty until the "
            "round pulls links (library.py round --only links)",
            file=sys.stderr,
        )
    if args.embed:
        add_bedrock_embeddings(corpus, args.embedding_model, args.embedding_dimensions)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(corpus, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {summary(corpus)} to {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
