"""Post abstracts on the blog corpus: display metadata, never retrieval text.

Titled blog posts get a short generated abstract (Claude Haiku, written by
``pipeline/blog/abstracts.py`` into ``data/librarian/blog-abstracts.json``,
keyed by ``microblog_id``). Microposts are short enough to be their own
abstract, so they get their own text, clipped. Both land on the corpus's post
records only, as ``abstract`` plus ``abstract_source`` (``"generated"`` or
``"text"``), so a reader or an agent can skim a result list.

A generated abstract is a model's paraphrase, not Jamie's words. It follows
the rule that keeps Thingy's words out of the corpus: it never becomes chunk
text, never enters the embedding input, and is never matched as something
Jamie wrote. That is why it lives on the post record and nowhere else.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

from librarian_core.corpus import plain_text

ABSTRACT_MAX_CHARS = 350

# A markdown link whose URL may hold one level of parentheses
# (``[Elf](https://en.wikipedia.org/wiki/Elf_(film))``), which the corpus's
# plain_text regex stops short of and leaves a stray ")" behind.
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\((?:[^()\s]|\([^()\s]*\))+\)")
# What the blog embed text leaves of a Hugo shortcode (``{{< x ... >}}``)
# once its HTML-looking middle is stripped.
_SHORTCODE_RESIDUE_RE = re.compile(r"\{\{[\s<>%/]*\}\}")
_SENTENCE_END_RE = re.compile(r"(?<=[.!?…])\s+")


def clip_abstract(text: str, max_chars: int = ABSTRACT_MAX_CHARS) -> str:
    """Collapse whitespace and fit ``text`` to ``max_chars``: whole sentences
    when they fill at least a third of the room, otherwise a word cut with an
    ellipsis."""
    clean = " ".join(str(text or "").split())
    if len(clean) <= max_chars:
        return clean
    kept = ""
    for sentence in _SENTENCE_END_RE.split(clean):
        candidate = f"{kept} {sentence}".strip()
        if len(candidate) > max_chars:
            break
        kept = candidate
    if len(kept) >= max_chars // 3:
        return kept
    cut = clean[: max_chars - 1].rsplit(" ", 1)[0].rstrip(" ,;:-–—")
    return f"{cut}…"


def micropost_abstract(chunk_text: str, alts: list[str] | None = None) -> str:
    """A micropost's own words as its abstract. The blog embed text inlines
    each photo's alt text into the body; that is kept out here so the abstract
    reads as the post, falling back to it only for a photo-only post."""
    base = " ".join(_SHORTCODE_RESIDUE_RE.sub(" ", chunk_text or "").split())
    text = base
    for alt in alts or []:
        if alt:
            text = text.replace(alt, " ")

    def flatten(value: str) -> str:
        return plain_text(_MD_LINK_RE.sub(r"\1", value))

    return clip_abstract(flatten(text) or flatten(base))


def _blog_chunk_position(chunk: dict[str, Any]) -> tuple[str, str] | None:
    """``(microblog_id, index)`` from a blog chunk id
    (``blog:{microblog_id}:{index}:{hash}``)."""
    parts = str(chunk.get("id") or "").split(":")
    if len(parts) < 3 or parts[0] != "blog":
        return None
    return parts[1], parts[2]


def annotate_blog_abstracts(corpus: dict[str, Any], sidecar_path: Path) -> int:
    """Set ``abstract`` and ``abstract_source`` on the blog corpus's post
    records. Titled posts take the sidecar abstract only when its
    ``body_hash`` matches the post's (an edited post waits for the next
    abstracts run rather than showing a summary of the old text). Microposts
    take their own text. Chunks are never touched. Returns how many generated
    abstracts were merged."""
    sidecar: dict[str, Any] = {}
    if sidecar_path.exists():
        sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))

    first_chunk_text: dict[str, str] = {}
    for chunk in corpus.get("chunks") or []:
        position = _blog_chunk_position(chunk)
        if position and position[1] == "0":
            first_chunk_text.setdefault(position[0], str(chunk.get("text") or ""))
    alts_by_url: dict[str, list[str]] = defaultdict(list)
    for entry in corpus.get("media") or []:
        if entry.get("alt"):
            alts_by_url[str(entry.get("source_url") or "")].append(str(entry["alt"]))

    generated = 0
    for post in corpus.get("posts") or []:
        post.pop("abstract", None)
        post.pop("abstract_source", None)
        microblog_id = str(post.get("microblog_id"))
        if post.get("post_kind") == "micropost":
            text = micropost_abstract(
                first_chunk_text.get(microblog_id, ""), alts_by_url.get(str(post.get("url") or ""))
            )
            if text:
                post["abstract"] = text
                post["abstract_source"] = "text"
            continue
        record = sidecar.get(microblog_id) or {}
        abstract = clip_abstract(record.get("abstract") or "")
        if abstract and record.get("body_hash") == post.get("body_hash"):
            post["abstract"] = abstract
            post["abstract_source"] = "generated"
            generated += 1
    return generated
