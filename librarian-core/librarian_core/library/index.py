"""The ``sources`` and ``media`` index over the library's files.

One row per post, page, issue, episode, thing, site page and reference
document, with the ids the Librarian uses everywhere (``blog-<id>``,
``page-<id>``, ``wt-<n>``, ``ep-<n>``, ``thing-<id>``, ``doc-<name>``), and
one row per image with its alt as published.
Rebuilt whole from ``files`` after every absorb, so it can never drift from
the content it indexes; the reader numbers' path index is rebuilt with it.
"""

from __future__ import annotations

import html
import json
import re
import sqlite3
from collections.abc import Iterator
from pathlib import PurePosixPath
from typing import Any

import yaml

from librarian_core.library.readers import index_readers

_IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)
_MD_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(\s*<?([^)\s>]+)")


def _attr(tag: str, name: str) -> str | None:
    match = re.search(rf"\b{name}\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))", tag, re.IGNORECASE)
    if not match:
        return None
    value = next(group for group in match.groups() if group is not None)
    return html.unescape(value)


def images(body: str) -> list[tuple[str, str | None]]:
    """Each image in a markdown body, in order: ``(url, alt)``, alt None when
    the tag has no alt attribute at all."""
    found: list[tuple[int, str, str | None]] = []
    for match in _IMG_TAG_RE.finditer(body):
        src = _attr(match.group(0), "src")
        if src:
            found.append((match.start(), src, _attr(match.group(0), "alt")))
    for match in _MD_IMAGE_RE.finditer(body):
        found.append((match.start(), match.group(2), match.group(1)))
    return [(url, alt) for _pos, url, alt in sorted(found)]


def _front_matter(text: str) -> tuple[dict[str, Any], str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end < 0:
        return {}, text
    meta = yaml.safe_load(text[4:end]) or {}
    return (meta if isinstance(meta, dict) else {}), text[end + 5 :]


def _text(value: Any) -> str | None:
    if value is None or value == "":
        return None
    return str(value)


def _rows(path: str, content: str) -> Iterator[tuple[dict[str, Any], str]]:
    """``(source row, body for images)`` for each source in one file."""
    if path.startswith(("blog/posts/", "blog/pages/")) and path.endswith(".md"):
        meta, body = _front_matter(content)
        if "page_id" in meta:
            yield (
                {
                    "id": f"page-{meta['page_id']}",
                    "kind": "page",
                    "url": _text(meta.get("url")),
                    "title": _text(meta.get("title")),
                    "published": None,
                    "updated": _text(meta.get("updated")),
                    "categories": meta.get("categories") or [],
                },
                body,
            )
        elif "microblog_id" in meta:
            yield (
                {
                    "id": f"blog-{meta['microblog_id']}",
                    "kind": str(meta.get("post_kind") or "post"),
                    "url": _text(meta.get("url")),
                    "title": _text(meta.get("title")),
                    "published": _text(meta.get("published")),
                    "updated": None,
                    "categories": meta.get("categories") or [],
                },
                body,
            )
    elif path.startswith("weekly/archive/") and path.endswith(".md"):
        meta, body = _front_matter(content)
        number = str(meta.get("number") or PurePosixPath(path).stem)
        yield (
            {
                "id": f"wt-{number}",
                "kind": "issue",
                "url": f"https://weekly.thingelstad.com/archive/{number}/",
                "title": _text(meta.get("subject")),
                "published": _text(meta.get("publish_date")),
                "updated": None,
                "categories": [],
            },
            body,
        )
    elif path.startswith("podcast/") and path.endswith(".json"):
        episode = json.loads(content)
        yield (
            {
                "id": f"ep-{episode.get('number')}",
                "kind": "episode",
                "url": _text(episode.get("url")),
                "title": _text(episode.get("title")),
                "published": _text(episode.get("published_at") or episode.get("publish_date")),
                "updated": None,
                "categories": [],
            },
            str(episode.get("notes_markdown") or ""),
        )
    elif path == "things/things.json":
        for thing in json.loads(content).get("things") or []:
            yield (
                {
                    "id": f"thing-{thing['id']}",
                    "kind": "thing",
                    "url": _text(thing.get("page")),
                    "title": _text(thing.get("title")),
                    "published": _text(thing.get("started")),
                    "updated": _text(thing.get("ended")),
                    "categories": thing.get("topics") or [],
                },
                "",
            )
    elif path.startswith(("reference/", "reference-unpublished/")) and path.endswith(".md"):
        # One id space over both folders: a name in both is two files
        # claiming one id, which reindex refuses.
        meta, body = _front_matter(content)
        yield (
            {
                "id": f"doc-{PurePosixPath(path).stem}",
                "kind": "document",
                "url": _text(meta.get("url")),
                "title": _text(meta.get("title")),
                "published": None,
                "updated": _text(meta.get("updated")),
                "categories": [],
            },
            body,
        )
    elif path.startswith("site/") and path.endswith(".njk"):
        meta, body = _front_matter(content)
        permalink = str(meta.get("permalink") or f"/{PurePosixPath(path).stem}/")
        yield (
            {
                "id": f"site-{PurePosixPath(path).stem}",
                "kind": "site_page",
                "url": f"https://weekly.thingelstad.com{permalink}",
                "title": _text(meta.get("pageTitle") or meta.get("title")),
                "published": None,
                "updated": None,
                "categories": [],
            },
            body,
        )


def reindex(conn: sqlite3.Connection) -> dict[str, int]:
    """Rebuild ``sources`` and ``media`` from ``files``. Returns sources per
    kind. Two files claiming one id is an error, not a silent overwrite."""
    sources: dict[str, tuple] = {}
    media: list[tuple] = []
    for row in conn.execute("SELECT path, content, sha256, pulled_at FROM files ORDER BY path"):
        for source, body in _rows(row["path"], row["content"]):
            if source["id"] in sources:
                raise ValueError(
                    f"{source['id']} is claimed by {sources[source['id']][2]} and {row['path']}"
                )
            sources[source["id"]] = (
                source["id"],
                source["kind"],
                row["path"],
                source["url"],
                source["title"],
                source["published"],
                source["updated"],
                json.dumps(source["categories"], ensure_ascii=False),
                row["sha256"],
                row["pulled_at"],
            )
            for position, (url, alt) in enumerate(images(body)):
                media.append((source["id"], position, url, alt))
    with conn:
        conn.execute("DELETE FROM sources")
        conn.execute("DELETE FROM media")
        conn.executemany(
            "INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", sources.values()
        )
        conn.executemany(
            "INSERT INTO media (source_id, position, url, alt) VALUES (?, ?, ?, ?)", media
        )
    # Reader numbers follow the sources they belong to.
    index_readers(conn)
    kinds: dict[str, int] = {}
    for row in sources.values():
        kinds[row[1]] = kinds.get(row[1], 0) + 1
    return kinds
