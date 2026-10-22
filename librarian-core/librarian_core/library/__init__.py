"""The library: one SQLite file holding the archive the Librarian answers from.

The sources keep the content and its history: micro.blog (the blog and its
pages), weekly.thingelstad.com (Weekly Thing issues as WT Builder sends them,
and the about and support pages), another.thingelstad.com (episodes),
thingelstad.xyz (Things I've built) and Tinylytics (reader numbers). The
library, ``library.db`` in the Librarian's private bucket, is a copy of what
every source published plus everything the Librarian makes or measures about
it. The corpus is built from the library, and librarian-thing's git holds code
only.

The pulled content lives in the ``files`` table exactly as the data tree holds
it, so the ingesters and the corpus build run unchanged: ``export_tree``
writes a working tree (``data/``, or wherever ``LIBRARIAN_DATA_DIR`` points),
the tools work on it, and ``absorb_tree`` takes what changed back.
``reindex`` keeps one ``sources`` row per post, page, issue, episode, thing
and site page, and one ``media`` row per image, for questions across the whole
archive. See docs/PLAN-2026-10-22-blog-steward.md.

A run downloads the file and notes its ETag, works on the local copy, and
uploads only if S3 still holds the copy it downloaded (``store``).
"""

from librarian_core.library.db import LibraryError, connect
from librarian_core.library.index import reindex
from librarian_core.library.tree import absorb_tree, export_tree, issue_from_weekly_page

__all__ = [
    "LibraryError",
    "absorb_tree",
    "connect",
    "export_tree",
    "issue_from_weekly_page",
    "reindex",
]
