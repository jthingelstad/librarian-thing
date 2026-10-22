"""Tests that read the real archive.

The archive is the library's export (``pipeline/library/library.py export``),
not something git holds: a fresh checkout has none, so these tests skip there.
``deploy.yml`` exports the library first and sets LIBRARIAN_REQUIRE_ARCHIVE=1,
so a missing archive fails the build instead of skipping.
"""

from __future__ import annotations

import os
import unittest

from librarian_core.library import read_marker
from librarian_core.paths import DATA


def have_archive() -> bool:
    return read_marker(DATA) is not None


def requires_archive(test):
    if have_archive() or os.environ.get("LIBRARIAN_REQUIRE_ARCHIVE") == "1":
        return test
    return unittest.skip(f"no library export in {DATA}")(test)
