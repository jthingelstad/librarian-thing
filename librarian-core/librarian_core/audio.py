"""Audio pointers on Weekly Thing issue records.

The audio edition's record lives only in the render copy of each issue,
``weekly.thingelstad.com/apps/site/archive/N.md``: WT Builder (and the audio
back-catalogue job) write ``audio_url``, ``audio_duration_seconds`` and
``audio_chapters`` into that page's frontmatter, and nothing copies them into
``data/issues/``. The build reads them from the sibling checkout and stamps
each issue record with::

    audio: {url, duration_seconds, chapters: [{start, title}]}

Text only: this is a pointer to the audio, never its words. The transcript
and VTT stay out, chapters keep start and title only, and chunks and the
embedding input are never touched. Chapters that link to Thingy (the Echoes
questions) are Thingy's words and are dropped, as the corpus drops the
from-thingy blocks.

A missing site checkout is normal for local builds and CI runs that did not
fetch it: the annotation merges nothing and the build goes on.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import yaml

from librarian_core.paths import PROJECTS_DIR

# Sibling-relative: the thingelstad.com repos move as a unit. CI checks the
# site out inside its workspace and points here with the env var.
SITE_ARCHIVE_ENV = "WEEKLY_SITE_ARCHIVE_DIR"
DEFAULT_SITE_ARCHIVE_DIR = PROJECTS_DIR / "weekly.thingelstad.com" / "apps" / "site" / "archive"

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*(?:\n|$)", re.S)
THINGY_HOST = "thingy.thingelstad.com"


def default_site_archive_dir() -> Path:
    override = os.environ.get(SITE_ARCHIVE_ENV)
    return Path(override) if override else DEFAULT_SITE_ARCHIVE_DIR


def _number(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if value >= 0 else None


def _is_thingy(url: Any) -> bool:
    if not isinstance(url, str):
        return False
    try:
        return urlparse(url).hostname == THINGY_HOST
    except ValueError:
        return False


def audio_record(frontmatter: dict[str, Any]) -> dict[str, Any] | None:
    """The corpus audio pointer for one site page's frontmatter, or None when
    the page has no audio edition."""
    url = frontmatter.get("audio_url")
    if not isinstance(url, str) or not url.strip():
        return None
    chapters = []
    raw_chapters = frontmatter.get("audio_chapters")
    for chapter in raw_chapters if isinstance(raw_chapters, list) else []:
        if not isinstance(chapter, dict) or _is_thingy(chapter.get("url")):
            continue
        start = _number(chapter.get("start"))
        title = chapter.get("title")
        if start is None or not isinstance(title, str) or not title.strip():
            continue
        chapters.append({"start": start, "title": title.strip()})
    return {
        "url": url.strip(),
        "duration_seconds": _number(frontmatter.get("audio_duration_seconds")),
        "chapters": chapters,
    }


def read_site_frontmatter(path: Path) -> dict[str, Any] | None:
    """A site page's frontmatter, or None when it is missing or malformed."""
    try:
        match = _FRONTMATTER_RE.match(path.read_text(encoding="utf-8"))
        data = yaml.safe_load(match.group(1)) if match else None
    except OSError, UnicodeDecodeError, yaml.YAMLError:
        return None
    return data if isinstance(data, dict) else None


def annotate_issue_audio(corpus: dict[str, Any], site_archive_dir: Path | None = None) -> int:
    """Stamp ``audio`` on the corpus's issue records from the site pages.
    Returns how many issues gained it. Never raises for a missing directory
    or an unreadable page; those issues simply ship without audio."""
    site_archive_dir = site_archive_dir or default_site_archive_dir()
    if not site_archive_dir.is_dir():
        print(f"audio pointers: no weekly site archive at {site_archive_dir}; skipping")
        return 0
    annotated = malformed = 0
    for issue in corpus.get("issues", []) or []:
        page = site_archive_dir / f"{issue.get('number')}.md"
        if not page.is_file():
            continue
        frontmatter = read_site_frontmatter(page)
        if frontmatter is None:
            malformed += 1
            continue
        record = audio_record(frontmatter)
        if record:
            issue["audio"] = record
            annotated += 1
    if malformed:
        print(f"audio pointers: skipped {malformed} site pages with unreadable frontmatter")
    return annotated
