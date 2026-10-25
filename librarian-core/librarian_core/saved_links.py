"""Linking Things' saved links, as the Librarian reads them (Jamie, 2026-10-23).

links.thingelstad.xyz publishes every public link Jamie has saved since 2005;
``pipeline/links/import_links.py`` snapshots its ``links.json`` and
``issues.json`` into the library's ``links/``. This module reads those
snapshots for the corpus builds: the links corpus (``build_links_corpus``
in corpus.py), and the ``link_id`` a Weekly Thing or blog link record
carries when its URL is a saved link.

A link's id is the first 12 hex characters of the md5 of its URL exactly as
saved. Linking Things computes it; the Librarian takes it as published and
never recomputes it, so a URL is a saved link only when the snapshot says so.

Two of Linking Things' own rules are ported here so the Librarian reads a
link as the site does: the host (``hostOf``: the URL's lower-cased netloc
after any ``user@``, less a leading ``www.``) and the voice of a note
(``voiceOf``): a note from 2007 to 2016 is mostly the page's own words,
which the bookmarklet saved, not Jamie's.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .paths import LINK_ISSUES_PATH, LINKS_PATH, LINKS_SITE

LINK_ID_RE = re.compile(r"^[0-9a-f]{12}$")
# A link's page on Linking Things, https://links.thingelstad.xyz/links/<id>/.
LINKS_HOST = urlsplit(LINKS_SITE).hostname or "links.thingelstad.xyz"
_LINK_PAGE_PATH_RE = re.compile(r"^/links/([0-9a-f]{12})(?:/|\.md|\.json)?$")
_WEEKLY_ARCHIVE_RE = re.compile(r"/archive/([^/?#]+)/?$")
_BLOCKQUOTE_RE = re.compile(r"<blockquote[^>]*>([\s\S]*?)</blockquote>", re.I)
_BLOCKQUOTE_TAG_RE = re.compile(r"</?blockquote[^>]*>", re.I)
_BLOCK_SPLIT_RE = re.compile(r"\n\s*\n")
_OPENING_QUOTE_RE = re.compile(r"^[\"“‘«„]")


def link_page_url(link_id: str) -> str:
    """A saved link's page on Linking Things."""
    return f"{LINKS_SITE}/links/{link_id}/"


def link_id_from_page_url(url: str) -> str | None:
    """The id in a Linking Things record URL (``/links/<id>/``, or its
    ``.md`` or ``.json`` twin), or None for any other URL."""
    try:
        parts = urlsplit(str(url or "").strip())
    except ValueError:
        return None
    if (parts.hostname or "").lower() != LINKS_HOST:
        return None
    match = _LINK_PAGE_PATH_RE.match(parts.path or "")
    return match.group(1) if match else None


def host_of(url: str) -> str:
    """Linking Things' host for a URL (its ``hostOf``)."""
    try:
        netloc = urlsplit(str(url or "").strip()).netloc.lower()
    except ValueError:
        return ""
    host = netloc[netloc.rfind("@") + 1 :]
    return host[4:] if host.startswith("www.") else host


def prepare_note(note: str) -> str:
    """A note as Linking Things renders it (its ``prepare``): ``<blockquote>``
    HTML (192 notes from 2012) becomes Markdown quote lines."""

    def quote(match: re.Match[str]) -> str:
        lines = match.group(1).strip().split("\n")
        return (
            "\n\n"
            + "\n".join(f"> {line.strip()}" if line.strip() else ">" for line in lines)
            + "\n\n"
        )

    text = _BLOCKQUOTE_RE.sub(quote, str(note or ""))
    return _BLOCKQUOTE_TAG_RE.sub("\n\n", text).strip()


def note_voice(note: str) -> str | None:
    """Whose words a note is, as Linking Things labels it (its ``voiceOf``),
    read from the note's form alone: ``excerpt`` (a ``>`` blockquote, the
    page's own words), ``mixed`` (Jamie quoting something inside his own
    words), ``jamie`` (bare text), or None for no note. There is no year
    rule: the page excerpts the bookmarklet saved as bare text before 2017
    were quoted at the source on 2026-10-24."""
    text = prepare_note(note)
    if not text:
        return None
    blocks = [block for block in _BLOCK_SPLIT_RE.split(text) if block.strip()]
    quoted = [block for block in blocks if block.lstrip().startswith(">")]
    if len(quoted) == len(blocks):
        return "excerpt"
    if quoted:
        return "mixed"
    if _OPENING_QUOTE_RE.match(text):
        return "mixed" if len(blocks) > 1 else "excerpt"
    return "jamie"


def note_spans(text: str, voice: str | None, offset: int = 0) -> list[dict[str, Any]]:
    """Voice spans over a prepared note placed at ``offset``: an excerpt is
    quoted whole, Jamie's note is his whole, and a mixed note quotes its
    quotation (its ``>`` lines, or with none its opening block) and keeps
    the rest as Jamie's. Covers the note end to end."""
    if not text:
        return []
    if voice != "mixed":
        return [
            {
                "voice": "quoted" if voice == "excerpt" else "jamie",
                "start": offset,
                "end": offset + len(text),
            }
        ]
    marks: list[tuple[int, int]] = []
    position = 0
    for line in text.split("\n"):
        if line.lstrip().startswith(">"):
            marks.append((position, position + len(line)))
        position += len(line) + 1
    if not marks:
        first = _BLOCK_SPLIT_RE.search(text)
        marks = [(0, first.start() if first else len(text))]
    spans: list[dict[str, Any]] = []

    def push(start: int, end: int, voice_name: str) -> None:
        if end <= start:
            return
        if spans and spans[-1]["voice"] == voice_name and spans[-1]["end"] == offset + start:
            spans[-1]["end"] = offset + end
        else:
            spans.append({"voice": voice_name, "start": offset + start, "end": offset + end})

    cursor = 0
    for start, end in marks:
        gap = text[cursor:start]
        push(cursor, start, spans[-1]["voice"] if spans and not gap.strip() else "jamie")
        push(start, end, "quoted")
        cursor = end
    push(cursor, len(text), "jamie")
    return spans


def read_saved_links(path: Path = LINKS_PATH) -> list[dict[str, Any]]:
    """The saved links in the snapshot, newest first; [] when the library
    holds no snapshot yet. A snapshot that is not one raises."""
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    links = data.get("links") if isinstance(data, dict) else None
    if not isinstance(links, list):
        raise RuntimeError(f"{path} holds no links")
    for link in links:
        if not isinstance(link, dict) or not LINK_ID_RE.match(str(link.get("id") or "")):
            raise RuntimeError(f"{path} has a link with no id")
    return links


def read_link_issues(path: Path = LINK_ISSUES_PATH) -> list[dict[str, Any]]:
    """The Weekly Thing issues in the snapshot, oldest first, each with the
    links it carried; [] when the library holds no snapshot yet."""
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    issues = data.get("issues") if isinstance(data, dict) else None
    if not isinstance(issues, list):
        raise RuntimeError(f"{path} holds no issues")
    return issues


def issue_number_of(issue: dict[str, Any]) -> Any:
    """An issue's number as the Weekly Thing corpus files it: its number, or
    for the one special issue (no number) its archive path, ``140-special``."""
    if issue.get("number") is not None:
        return issue["number"]
    match = _WEEKLY_ARCHIVE_RE.search(urlsplit(str(issue.get("url") or "")).path or "")
    return match.group(1) if match else None


def saved_link_ids(links: list[dict[str, Any]]) -> dict[str, str]:
    """``{url as saved: link id}``: a link record whose URL is one of these
    is that saved link."""
    return {str(link["url"]): str(link["id"]) for link in links if link.get("url")}


def issue_link_ids(issues: list[dict[str, Any]]) -> dict[tuple[str, str], str]:
    """``{(issue number, url): link id}`` from the issues snapshot: Linking
    Things' own join of each issue's links to the saved links."""
    ids: dict[tuple[str, str], str] = {}
    for issue in issues:
        number = issue_number_of(issue)
        if number is None:
            continue
        for link in issue.get("links") or []:
            if link.get("id") and link.get("url"):
                ids.setdefault((str(number), str(link["url"])), str(link["id"]))
    return ids


def attach_link_ids(
    records: list[dict[str, Any]],
    *,
    by_url: dict[str, str],
    by_issue: dict[tuple[str, str], str] | None = None,
) -> int:
    """Give each link record whose URL is a saved link its ``link_id``: an
    issue's link by Linking Things' join first, then any record by its URL
    exactly as saved. Returns how many records carry one."""
    count = 0
    for record in records:
        url = str(record.get("url") or "")
        link_id = None
        if by_issue and record.get("issue_number") is not None:
            link_id = by_issue.get((str(record["issue_number"]), url))
        link_id = link_id or by_url.get(url)
        if link_id:
            record["link_id"] = link_id
            count += 1
        else:
            record.pop("link_id", None)
    return count
