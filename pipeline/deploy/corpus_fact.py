"""The freshness fact each corpus artifact carries as S3 object metadata.

The sync page (sync.thingelstad.xyz) asks "is WT354 in the Librarian yet?"
and used to have only the artifact's upload time to go on. Each uploader
now computes, from the corpus it is about to ship, the newest item the
corpus holds and writes it onto the S3 object as user metadata, next to
the library fingerprint. A reader HEADs the object and knows what it holds
without downloading 55 MB of gzip.

The fact is computed at stage time from the in-memory corpus (the staged
file is too big to parse again at upload) and written beside the staged
file as ``<name>.fact.json`` (``corpus.fact.json`` beside ``corpus.json``);
``upload_json_gzip`` reads it back. S3 user metadata is ASCII and small, so
the fact is ids, instants and counts only, never a title.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# S3 user metadata keys. S3 lowercases them and serves them back as
# x-amz-meta-<key>; a reader sees the names below.
NEWEST_ID_META = "newest-id"
NEWEST_AT_META = "newest-at"
ITEM_COUNT_META = "item-count"
BUILT_AT_META = "built-at"

FACT_SUFFIX = ".fact.json"


def _newest(items: list[dict[str, Any]], key) -> dict[str, Any] | None:
    ranked = [item for item in items if key(item) is not None]
    return max(ranked, key=key) if ranked else None


def _instant(value: Any) -> str | None:
    text = str(value or "").strip()
    return text if text and text.isascii() else None


def corpus_fact(name: str, payload: dict[str, Any]) -> dict[str, str]:
    """The metadata for the artifact ``name`` (``corpus.json``, ``blog_corpus.json``
    and so on) built from ``payload``: the newest item's public id (the one
    every Librarian tool uses: ``wt-354``, ``blog-<microblog id>``, ``ep-<n>``,
    ``link-<id>``) and when it was published, the item count, and when the
    corpus was built. A corpus with no dated items (the reference base, the
    graph) carries its count and build time only. Every value is ASCII."""
    stem = Path(name).stem
    fact: dict[str, str] = {}
    newest: dict[str, Any] | None = None
    newest_id: str | None = None
    newest_at: str | None = None
    count: int | None = None

    if stem == "corpus":
        issues = [i for i in payload.get("issues") or [] if str(i.get("number", "")).isdigit()]
        newest = _newest(issues, lambda i: int(i["number"]))
        if newest:
            newest_id, newest_at = f"wt-{int(newest['number'])}", newest.get("publish_date")
        count = len(issues)
    elif stem == "blog_corpus":
        # Posts only: a page (page_id) is undated, its published is its last edit.
        posts = [p for p in payload.get("posts") or [] if p.get("microblog_id") is not None]
        newest = _newest(posts, lambda p: _instant(p.get("published") or p.get("publish_date")))
        if newest:
            newest_id = f"blog-{newest['microblog_id']}"
            newest_at = newest.get("published") or newest.get("publish_date")
        count = len(posts)
    elif stem == "podcast_corpus":
        episodes = [e for e in payload.get("episodes") or [] if str(e.get("number", "")).isdigit()]
        newest = _newest(episodes, lambda e: int(e["number"]))
        if newest:
            newest_id, newest_at = f"ep-{int(newest['number'])}", newest.get("publish_date")
        count = len(episodes)
    elif stem == "links_corpus":
        chunks = [c for c in payload.get("chunks") or [] if c.get("link_id")]
        newest = _newest(chunks, lambda c: _instant(c.get("published")))
        if newest:
            newest_id, newest_at = f"link-{newest['link_id']}", newest.get("published")
        count = len(chunks)
    elif stem == "reference_corpus":
        count = int(payload.get("chunk_count") or len(payload.get("chunks") or []))
    else:
        return fact

    if newest_id and newest_id.isascii():
        fact[NEWEST_ID_META] = newest_id
    if _instant(newest_at):
        fact[NEWEST_AT_META] = _instant(newest_at)
    if count is not None:
        fact[ITEM_COUNT_META] = str(count)
    if _instant(payload.get("generated_at")):
        fact[BUILT_AT_META] = _instant(payload.get("generated_at"))
    return fact


def fact_path(path: str | Path) -> Path:
    """Where the fact for the artifact at ``path`` sits: ``corpus.fact.json``
    beside ``corpus.json``."""
    path = Path(path)
    return path.with_name(path.stem + FACT_SUFFIX)


def write_fact(path: str | Path, fact: dict[str, str]) -> Path | None:
    """Write the fact beside the artifact; nothing when there is no fact."""
    if not fact:
        return None
    target = fact_path(path)
    target.write_text(json.dumps(fact, sort_keys=True) + "\n", encoding="utf-8")
    return target


def read_fact(path: str | Path) -> dict[str, str]:
    """The fact written beside the artifact at ``path``, or nothing."""
    target = fact_path(path)
    if not target.is_file():
        return {}
    loaded = json.loads(target.read_text(encoding="utf-8"))
    return {str(k): str(v) for k, v in loaded.items()} if isinstance(loaded, dict) else {}
