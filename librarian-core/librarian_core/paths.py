"""Canonical paths used by librarian-core consumers.

Resolved from this file's location on disk so editable installs work without
extra env vars: librarian-core/ lives at the repo root, so parents[2] is REPO.
"""

from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PROJECTS_DIR = REPO.parent
ARCHIVE_DIR = REPO / "data" / "issues"
# Site grounding pages moved to the weekly.thingelstad.com repo in the
# 2026-08 split; the corpus build reads the snapshots in data/site/ so it
# stays self-contained (see data/site/README.md for the re-copy step).
SITE_DIR = REPO / "data" / "site"
FAQ_PATH = REPO / "apps" / "librarian" / "lambda" / "shared" / "faq.json"
CORPUS_PATH = REPO / "data" / "librarian" / "corpus.json"
# Vision descriptions for archive images, keyed by image URL - written by
# pipeline/corpus/describe_media.py, merged into media entries at build.
MEDIA_DESCRIPTIONS_PATH = REPO / "data" / "librarian" / "media-descriptions.json"
GRAPH_PATH = REPO / "data" / "librarian" / "graph.json"

# thingelstad.com blog — Jamie's 20-year personal blog, ingested by
# pipeline/blog/ingest_blog.py. Its own corpus (separate from the Weekly
# Thing corpus above) so blog scope loads lazily and never crowds out
# Weekly-Thing retrieval. See build_blog_corpus in corpus.py.
BLOG_DIR = REPO / "data" / "blog" / "posts"
BLOG_CORPUS_PATH = REPO / "data" / "librarian" / "blog_corpus.json"

# Another Thing podcast episodes are authored/published by the sibling
# another.thingelstad.com repo, then normalized into Studio-owned data so
# Librarian can build a separate podcast corpus without scraping Thingy-time
# pages.
ANOTHER_THING_REPO = PROJECTS_DIR / "another.thingelstad.com"
ANOTHER_THING_EPISODES_DIR = ANOTHER_THING_REPO / "content" / "episodes"
PODCAST_DIR = REPO / "data" / "podcast" / "another-thing" / "episodes"
PODCAST_CORPUS_PATH = REPO / "data" / "librarian" / "podcast_corpus.json"
