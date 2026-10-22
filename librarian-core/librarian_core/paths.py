"""Canonical paths used by librarian-core consumers.

Resolved from this file's location on disk so editable installs work without
extra env vars: librarian-core/ lives at the repo root, so parents[2] is REPO.
"""

from __future__ import annotations

import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PROJECTS_DIR = REPO.parent
# The data tree every reader and builder works on. The library
# (librarian_core/library, one SQLite file in S3) holds the archive; data/ is
# a working copy of it, and LIBRARIAN_DATA_DIR points the same code at
# another copy (the twin build, a test tree).
DATA = Path(os.environ.get("LIBRARIAN_DATA_DIR") or REPO / "data").resolve()
ARCHIVE_DIR = DATA / "issues"
# weekly.thingelstad.com's archive pages as pulled (apps/site/archive/<n>.md);
# the library derives issues/<n>/archive.md from them.
WEEKLY_ARCHIVE_DIR = DATA / "weekly" / "archive"
# Site grounding pages (about, support) pulled from weekly.thingelstad.com's
# apps/site/, read by the corpus build as site_page chunks.
SITE_DIR = DATA / "site"
FAQ_PATH = REPO / "apps" / "librarian" / "lambda" / "shared" / "faq.json"
CORPUS_PATH = DATA / "librarian" / "corpus.json"
# Vision descriptions for archive images, keyed by image URL - written by
# pipeline/corpus/describe_media.py, merged into media entries at build.
MEDIA_DESCRIPTIONS_PATH = DATA / "librarian" / "media-descriptions.json"
GRAPH_PATH = DATA / "librarian" / "graph.json"
# Reader numbers from Tinylytics, written from the library on every export
# (librarian_core/library/readers.py) and carried on each corpus as
# ``readers``: display metadata, never chunk text or embedding input.
READERS_PATH = DATA / "librarian" / "readers.json"

# thingelstad.com blog — Jamie's 20-year personal blog, ingested by
# pipeline/blog/ingest_blog.py. Its own corpus (separate from the Weekly
# Thing corpus above) so blog scope loads lazily and never crowds out
# Weekly-Thing retrieval. See build_blog_corpus in corpus.py.
BLOG_DIR = DATA / "blog" / "posts"
BLOG_CORPUS_PATH = DATA / "librarian" / "blog_corpus.json"
# Generated abstracts for titled blog posts, keyed by microblog_id - written
# by pipeline/blog/abstracts.py, merged onto post records only (display
# metadata, never chunk text or embedding input; see librarian_core/abstracts.py).
BLOG_ABSTRACTS_PATH = DATA / "librarian" / "blog-abstracts.json"

# Another Thing podcast episodes are authored/published by the sibling
# another.thingelstad.com repo, then normalized into Studio-owned data so
# Librarian can build a separate podcast corpus without scraping Thingy-time
# pages.
ANOTHER_THING_REPO = PROJECTS_DIR / "another.thingelstad.com"
ANOTHER_THING_EPISODES_DIR = ANOTHER_THING_REPO / "content" / "episodes"
PODCAST_DIR = DATA / "podcast" / "another-thing" / "episodes"
PODCAST_CORPUS_PATH = DATA / "librarian" / "podcast_corpus.json"

# Things I've built - Jamie's project registry at thingelstad.xyz, which
# publishes itself as JSON. pipeline/things/import_things.py snapshots it
# here and the Weekly Thing corpus build turns it into undated "thing"
# chunks (see _things_chunks in corpus.py and pipeline/library/README.md).
THINGS_URL = "https://thingelstad.xyz/things.json"
THINGS_PATH = DATA / "things" / "things.json"
