"""Reference documents: Markdown about Jamie (a bio, a resume, old wiki pages)
that the Librarian always consults and no caller selects (Jamie, 2026-10-23).

Each document is one file, ``<name>.md``, in one of two folders of the
library tree:

    reference/              written in git under ``reference-documents/``
                            (its README is the guide; the repository is
                            public, so these are published) and pulled into
                            the library by ``pipeline/reference/import_reference.py``
    reference-unpublished/  never in git: placed in the library by hand
                            (export, add the files, ``library.py absorb``,
                            ``library.py upload``), for documents that must
                            not be published as a page or in the public
                            repository. The Librarian still searches them for
                            every reader: unpublished is not hidden.

The reference corpus build reads both (``read_reference_documents``) through
``read_document``, so a document the build would refuse fails naming its
file, and one id space: a name in both folders fails the build.

Front matter:

    title: required, the name the Librarian cites it by
    updated: required, the date it was last revised (YYYY-MM-DD)
    url: optional, a public http(s) address for it, if one exists
    source: optional, free text: where the document came from, e.g.
        "wiki.thingelstad.com (personal wiki, 2010-2015)"; citation metadata
        on every passage, so the Librarian can say where a fact came from
    date: optional, the document's own date, when it was first written
        (YYYY-MM-DD); citation metadata only. The corpus stays undated: no
        date-anchored tool returns a document, whatever its date.

The file name, less ``.md``, is the document's id (``doc-<name>``): lowercase
letters, digits and hyphens.

A document's text is cut into passages by its H2 sections
(``document_sections``): the text before the first ``## `` heading is one
section, then one per heading.
"""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import yaml

FIELDS = ("title", "updated", "url", "source", "date")
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*\.md$")
# The library's one front matter shape (the index reads it the same way).
_FRONT_MATTER_RE = re.compile(r"\A---\n(.*?)\n---\n", re.S)
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# Hand-written notes beside the documents, never a document.
README = "README.md"
# The two folders of the library tree a document can live in.
PUBLISHED_FOLDER = "reference"
UNPUBLISHED_FOLDER = "reference-unpublished"
# A Markdown H2 (``## Heading``, up to three spaces in, closing hashes
# allowed) and a code fence, inside which a ``## `` line is code.
_H2_RE = re.compile(r"^ {0,3}##[ \t]+(?P<heading>\S.*?)(?:[ \t]+#+)?[ \t]*$")
_FENCE_RE = re.compile(r"^ {0,3}(?P<fence>`{3,}|~{3,})")


class ReferenceDocumentError(RuntimeError):
    """A reference document the build refuses; the message names the file."""


def _fail(path: Path, reason: str) -> ReferenceDocumentError:
    return ReferenceDocumentError(f"reference document {path.name}: {reason}")


def _day(path: Path, field: str, value: Any) -> str:
    if isinstance(value, date):
        return value.isoformat()[:10]
    text = str(value or "").strip()
    if not _DATE_RE.match(text):
        raise _fail(path, f"{field} must be a date (YYYY-MM-DD), got {value!r}")
    try:
        date.fromisoformat(text)
    except ValueError:
        raise _fail(path, f"{field} {text!r} is not a calendar day") from None
    return text


def _source(path: Path, value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise _fail(path, f"source must be text saying where the document came from, got {value!r}")
    return " ".join(value.split())


def read_document(path: Path) -> dict[str, Any]:
    """One document as the corpus build uses it: ``doc_id``, ``title``,
    ``url``, ``updated``, ``source``, ``date`` (each optional one None when
    it is left out) and ``body``. Raises ``ReferenceDocumentError`` naming
    the file when anything is wrong."""
    path = Path(path)
    if not _NAME_RE.match(path.name):
        raise _fail(
            path,
            "the file name must be lowercase letters, digits and hyphens ending in .md "
            "(it becomes the id doc-<name>)",
        )
    try:
        # Bytes, not read_text: its newline translation hides a \r.
        text = path.read_bytes().decode("utf-8")
    except UnicodeDecodeError:
        raise _fail(path, "is not UTF-8 text") from None
    if "\r" in text:
        raise _fail(path, "has Windows line endings; save it with plain newlines")
    match = _FRONT_MATTER_RE.match(text)
    if not match:
        raise _fail(path, "has no front matter (a --- block with title and updated)")
    try:
        meta = yaml.safe_load(match.group(1))
    except yaml.YAMLError as error:
        raise _fail(path, f"front matter is not valid YAML ({error.__class__.__name__})") from None
    if not isinstance(meta, dict):
        raise _fail(path, "front matter must be key: value lines")
    unknown = sorted(str(key) for key in meta if key not in FIELDS)
    if unknown:
        raise _fail(
            path, f"unknown front matter {', '.join(unknown)}; the fields are {', '.join(FIELDS)}"
        )
    title = meta.get("title")
    if not isinstance(title, str) or not title.strip():
        raise _fail(path, "title is required")
    url = meta.get("url")
    if url is not None and url != "":
        parsed = urlparse(str(url).strip()) if isinstance(url, str) else None
        if not parsed or parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise _fail(path, f"url must be an http(s) address, got {url!r}")
        url = str(url).strip()
    else:
        url = None
    if "updated" not in meta:
        raise _fail(path, "updated is required (YYYY-MM-DD)")
    updated = _day(path, "updated", meta["updated"])
    source = _source(path, meta.get("source"))
    written = _day(path, "date", meta["date"]) if meta.get("date") is not None else None
    body = text[match.end() :].strip()
    if not body:
        raise _fail(path, "has no text below the front matter")
    if not any(section_text for _heading, section_text in document_sections(body)):
        raise _fail(path, "has headings but no text under any of them")
    return {
        "doc_id": path.name[: -len(".md")],
        "title": " ".join(title.split()),
        "url": url,
        "updated": updated,
        "source": source,
        "date": written,
        "body": body,
    }


def document_sections(body: str) -> list[tuple[str | None, str]]:
    """A document's text by H2 section: the text before the first ``## ``
    heading (heading None), then one ``(heading, text)`` per H2, in order.
    The heading line itself is not in the text. A ``## `` line inside a code
    fence is code, not a heading; ``#`` and ``###`` and deeper stay in their
    section's text. A section with no text under its heading is dropped (a
    heading alone says nothing to find)."""
    sections: list[tuple[str | None, list[str]]] = [(None, [])]
    fence: str | None = None
    for line in body.split("\n"):
        opened = _FENCE_RE.match(line)
        if fence is not None:
            if (
                opened
                and opened.group("fence")[0] == fence[0]
                and len(opened.group("fence")) >= len(fence)
            ):
                fence = None
        elif opened:
            fence = opened.group("fence")
        elif heading := _H2_RE.match(line):
            sections.append((" ".join(heading.group("heading").split()), []))
            continue
        sections[-1][1].append(line)
    out = []
    for heading, lines in sections:
        text = "\n".join(lines).strip()
        if text:
            out.append((heading, text))
    return out


def document_paths(directory: Path) -> list[Path]:
    """The documents in ``directory``: every file beside the README (dot
    files aside). A missing directory holds none. Anything that is not a
    ``.md`` file (a folder, a .txt) raises naming it, rather than being
    quietly left out of the Librarian."""
    directory = Path(directory)
    if not directory.is_dir():
        return []
    found = []
    for path in sorted(directory.iterdir()):
        if path.name == README or path.name.startswith("."):
            continue
        if not path.is_file() or path.suffix != ".md":
            raise _fail(path, "is not a Markdown file; the folder holds only <name>.md documents")
        found.append(path)
    return found


def read_documents(directory: Path) -> list[dict[str, Any]]:
    """Every document in ``directory``, by id; the first malformed one raises."""
    return [read_document(path) for path in document_paths(directory)]


def name_clashes(published_dir: Path, unpublished_dir: Path) -> list[str]:
    """The file names in both folders: one id, two documents."""
    published = {path.name for path in document_paths(published_dir)}
    return sorted(path.name for path in document_paths(unpublished_dir) if path.name in published)


def read_reference_documents(published_dir: Path, unpublished_dir: Path) -> list[dict[str, Any]]:
    """Every document in both folders, published first, each with its
    ``folder`` (``reference`` or ``reference-unpublished``). A name in both
    folders raises naming the file, before anything is read."""
    clashes = name_clashes(published_dir, unpublished_dir)
    if clashes:
        raise _fail(
            Path(clashes[0]),
            f"is in both {PUBLISHED_FOLDER}/ and {UNPUBLISHED_FOLDER}/; a name is one "
            "document, so rename or remove one of them",
        )
    documents = []
    for folder, directory in (
        (PUBLISHED_FOLDER, published_dir),
        (UNPUBLISHED_FOLDER, unpublished_dir),
    ):
        documents.extend({**document, "folder": folder} for document in read_documents(directory))
    return documents
