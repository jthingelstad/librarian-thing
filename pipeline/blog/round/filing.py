"""The blog round's labeller: one Opus 5.5 call per post reads it the way the
10-21 overhaul did (topics, subjects, gist, kind, place, substance,
evergreen) and files it against the catalog in library.db.

The catalog goes in the system prompt, cached: each topic with its rule,
each trip with its dates, and each series, project and kept category with
recent gists of posts filed there, so the model sees what each one holds
rather than guessing from a name. The post comes with the posts on either
side of it and how they are filed, which is how a trip under way shows.

The answer is structured (``output_config.format``) against enums of the
catalog's own names, so a pick is always a category that exists. A trip
with no category yet comes back as ``new_trip``, and a category the archive
seems to lack as ``missing``: both are for the agent to judge, never filed
by the round. Weekly Thing (WT Builder's), Featured (decided on Sundays) and
the retired names are not offered at all.

Server-side fallback is on (``fallbacks="default"``): when Opus 5.5 is
overloaded or declines in a category the fallback covers, the API answers
from its fallback model, and the label records the model that answered.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass, field
from typing import Any

import anthropic_client
import guards
from librarian_core.library.index import _front_matter

MODEL = anthropic_client.MODELS["opus"]
EFFORT = "low"
MAX_TOKENS = 8000
BETAS = ["server-side-fallback-2026-07-01"]
KINDS = [
    "essay",
    "note",
    "link",
    "photo",
    "review",
    "trip-log",
    "how-to",
    "announcement",
    "quote",
    "checkin",
    "automated",
    "other",
]
MAX_POST_CHARS = 12_000
NEIGHBOURS = 8
NEIGHBOUR_DAYS = 14
EXAMPLES = 3

_IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)
_SRC_RE = re.compile(r"""\bsrc\s*=\s*(["'])(.*?)\1""", re.IGNORECASE | re.DOTALL)
_ALT_RE = re.compile(r"""\balt\s*=\s*(["'])(.*?)\1""", re.IGNORECASE | re.DOTALL)
_MD_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(\s*<?([^)\s>]+)[^)]*\)")
_TAG_RE = re.compile(r"<[^>]+>")

SYSTEM = """\
You keep the categories of Jamie Thingelstad's personal blog, \
www.thingelstad.com: about 10,500 posts since 2004 (a few older ones were \
posted later), from essays to one-line notes, shared links, photos, trip \
logs and posts made by services. Jamie lives in Minneapolis.

You get one post, and the posts published around it with the categories \
they are filed in. Read it, then answer two ways.

First, label it, the way every post in the archive was labelled in October \
2026:
- topics: 1 to 3 short lowercase subject labels a reader could browse by, \
most central first ("coffee", "kubb", "parenting"). Never "blog", "life", \
"personal" or "misc".
- subjects: 0 to 4 named things it is about: products, companies, teams, \
events, places of business, software, titles of books, films and albums. \
No private people.
- gist: what it says, in 15 words or fewer. Never a pronoun for Jamie; the \
posts are first person, so a pronoun is a guess. Write around it.
- kind: essay, note, link (sharing someone else's page), photo (the photo is \
the post), review, trip-log (one entry of a day-by-day account of a trip or \
event), how-to, announcement, quote, checkin, automated (posted by a service \
with little writing by Jamie), or other.
- place: the city, region or country it is set in, when that matters to it; \
otherwise "".
- substance: 1 (a passing note) to 5 (a considered piece a newcomer should \
read).
- evergreen: true when it reads as well years later; false when it is tied \
to its moment.

Then file it, using only the categories listed below:
- trip: the trip it belongs to, when it is part of one listed (its dates \
and the posts around it tell you). Otherwise "".
- new_trip: when it is plainly part of a trip, vacation, conference or event \
with several posts that has no category yet, a name in the form "<Place or \
event> <year>" ("Lisbon 2026"); otherwise "". Name what the post itself \
names.
- series and project: the one it belongs to, or "".
- topics_filed: the topics that fit, most central first. One or two as a \
rule, three at most, none when nothing fits. A topic must be what the post \
is about, not something it mentions on the way. Follow each topic's rule.
- others: any of the remaining categories that fit, judged by what each \
one holds.
- missing: when the post is about something the archive keeps coming back \
to and no category covers, a short Title Case name for the category it \
lacks; otherwise "". Most posts: "".
- reason: one plain sentence on why it is filed this way.

The catalog:

"""


@dataclass
class Catalog:
    names: dict[str, str]  # slug -> name
    kinds: dict[str, str]  # slug -> kind
    by_kind: dict[str, list[str]] = field(default_factory=dict)
    text: str = ""

    def name_list(self) -> list[str]:
        return sorted(self.names.values())


@dataclass
class Filing:
    source_id: str
    labels: dict[str, Any]
    picks: list[str]
    new_trip: str
    missing: str
    reason: str
    model: str
    usage: dict[str, int]
    stop: str | None = None


def load_catalog(conn: sqlite3.Connection) -> Catalog:
    """The live catalog, and its text for the system prompt."""
    rows = conn.execute(
        "SELECT name, slug, kind, why FROM categories WHERE retired_at IS NULL ORDER BY name"
    ).fetchall()
    names: dict[str, str] = {}
    kinds: dict[str, str] = {}
    by_kind: dict[str, list[str]] = {}
    for row in rows:
        key = row["slug"] or guards.slug(row["name"])
        if key in guards.RETIRED:
            continue
        names[key] = row["name"]
        kinds[key] = row["kind"]
        by_kind.setdefault(row["kind"], []).append(row["name"])

    spans = _trip_spans(conn)
    lines = ["Topics (topics_filed):"]
    for row in rows:
        if row["kind"] == "topic":
            lines.append(f"- {row['name']}: {row['why'] or ''}".rstrip())
    lines.append("\nTrips (trip), with the dates of their posts:")
    for name in by_kind.get("trip", []):
        first, last, n = spans.get(name, ("?", "?", 0))
        lines.append(f"- {name}: {first} to {last}, {n} posts")
    for kind, title, slot in (
        ("series", "Series", "series"),
        ("project", "Jamie's projects", "project"),
        ("kept", "Other categories", "others"),
    ):
        lines.append(f"\n{title} ({slot}), each with recent posts filed there:")
        for name in by_kind.get(kind, []):
            if guards.slug(name) == guards.WEEKLY_THING:
                continue
            examples = "; ".join(_examples(conn, name)) or "no labelled posts yet"
            lines.append(f"- {name}: {examples}")
    return Catalog(names=names, kinds=kinds, by_kind=by_kind, text="\n".join(lines))


def _trip_spans(conn: sqlite3.Connection) -> dict[str, tuple[str, str, int]]:
    out: dict[str, tuple[str, str, int]] = {}
    for row in conn.execute(
        "SELECT j.value AS name, min(substr(s.published, 1, 10)) AS first, "
        "max(substr(s.published, 1, 10)) AS last, count(*) AS n "
        "FROM filings f JOIN json_each(f.categories) j JOIN sources s ON s.id = f.source_id "
        "JOIN categories c ON c.name = j.value AND c.kind = 'trip' GROUP BY j.value"
    ):
        out[row["name"]] = (row["first"], row["last"], row["n"])
    return out


def _examples(conn: sqlite3.Connection, name: str) -> list[str]:
    rows = conn.execute(
        "SELECT substr(s.published, 1, 10) AS day, l.gist FROM filings f "
        "JOIN json_each(f.categories) j JOIN sources s ON s.id = f.source_id "
        "JOIN labels l ON l.source_id = f.source_id "
        "WHERE j.value = ? AND l.gist IS NOT NULL ORDER BY s.published DESC LIMIT ?",
        (name, EXAMPLES),
    ).fetchall()
    return [f"{row['gist']} ({row['day']})" for row in rows]


def schema(catalog: Catalog) -> dict[str, Any]:
    def names(kind: str) -> list[str]:
        return [
            name
            for name in catalog.by_kind.get(kind, [])
            if guards.slug(name) not in (guards.WEEKLY_THING, guards.FEATURED)
        ]

    def choice(kind: str) -> dict[str, Any]:
        return {"type": "string", "enum": ["", *names(kind)]}

    def several(kind: str) -> dict[str, Any]:
        return {"type": "array", "items": {"type": "string", "enum": names(kind)}}

    properties = {
        "topics": {"type": "array", "items": {"type": "string"}},
        "subjects": {"type": "array", "items": {"type": "string"}},
        "gist": {"type": "string"},
        "kind": {"type": "string", "enum": KINDS},
        "place": {"type": "string"},
        "substance": {"type": "integer", "enum": [1, 2, 3, 4, 5]},
        "evergreen": {"type": "boolean"},
        "trip": choice("trip"),
        "new_trip": {"type": "string"},
        "series": choice("series"),
        "project": choice("project"),
        "topics_filed": several("topic"),
        "others": several("kept"),
        "missing": {"type": "string"},
        "reason": {"type": "string"},
    }
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


def post_body(conn: sqlite3.Connection, source_id: str) -> tuple[dict[str, Any], str]:
    row = conn.execute(
        "SELECT f.content FROM sources s JOIN files f ON f.path = s.path WHERE s.id = ?",
        (source_id,),
    ).fetchone()
    if row is None:
        raise KeyError(source_id)
    return _front_matter(row["content"])


def readable(conn: sqlite3.Connection, body: str) -> str:
    """A post body as the model reads it: each photo as its alt or the
    archive's description of it, markup gone, cut at MAX_POST_CHARS."""

    def described(url: str, alt: str) -> str:
        if alt.strip():
            return f"[Photo: {alt.strip()}]"
        row = conn.execute("SELECT description FROM descriptions WHERE url = ?", (url,)).fetchone()
        return f"[Photo: {row['description']}]" if row and row["description"] else "[Photo]"

    def tag(match: re.Match[str]) -> str:
        src = _SRC_RE.search(match.group(0))
        alt = _ALT_RE.search(match.group(0))
        return described(src.group(2) if src else "", alt.group(2) if alt else "")

    text = _IMG_TAG_RE.sub(tag, body)
    text = _MD_IMAGE_RE.sub(lambda m: described(m.group(2), m.group(1)), text)
    text = _TAG_RE.sub("", text).strip()
    if len(text) > MAX_POST_CHARS:
        text = text[:MAX_POST_CHARS].rsplit(" ", 1)[0] + " [...]"
    return text


def neighbours(conn: sqlite3.Connection, source_id: str, published: str) -> list[str]:
    rows = conn.execute(
        "SELECT s.id, s.title, s.published, coalesce(f.categories, s.categories) AS cats, "
        "l.gist FROM sources s LEFT JOIN filings f ON f.source_id = s.id "
        "LEFT JOIN labels l ON l.source_id = s.id "
        "WHERE s.kind IN ('post', 'micropost') AND s.id != ? "
        "AND abs(julianday(s.published) - julianday(?)) <= ? "
        "ORDER BY abs(julianday(s.published) - julianday(?)) LIMIT ?",
        (source_id, published, NEIGHBOUR_DAYS, published, NEIGHBOURS),
    ).fetchall()
    lines = []
    for row in sorted(rows, key=lambda r: r["published"]):
        label = row["title"] or row["gist"] or "(untitled)"
        cats = ", ".join(json.loads(row["cats"] or "[]")) or "none"
        lines.append(f"- {row['published'][:10]} {label} [{cats}]")
    return lines


def user_message(conn: sqlite3.Connection, source_id: str) -> str:
    meta, body = post_body(conn, source_id)
    published = str(meta.get("published") or "")
    parts = [
        f"Post {source_id}, published {published[:10] or 'undated'}",
        f"Title: {meta.get('title') or '(untitled)'}",
        f"Categories on it now: {', '.join(meta.get('categories') or []) or 'none'}",
        "",
        "<post>",
        readable(conn, body),
        "</post>",
    ]
    around = neighbours(conn, source_id, published) if published else []
    if around:
        parts += ["", "Posts around it, with their categories:", *around]
    return "\n".join(parts)


def request(conn: sqlite3.Connection, catalog: Catalog, source_id: str) -> dict[str, Any]:
    return {
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "betas": BETAS,
        "fallbacks": "default",
        "system": [
            {"type": "text", "text": SYSTEM + catalog.text, "cache_control": {"type": "ephemeral"}}
        ],
        "messages": [{"role": "user", "content": user_message(conn, source_id)}],
        "output_config": {
            "effort": EFFORT,
            "format": {"type": "json_schema", "schema": schema(catalog)},
        },
    }


def _usage(message: Any) -> dict[str, int]:
    usage = getattr(message, "usage", None)
    return {
        "input_tokens": getattr(usage, "input_tokens", 0) or 0,
        "output_tokens": getattr(usage, "output_tokens", 0) or 0,
        "cache_read_tokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
        "cache_create_tokens": getattr(usage, "cache_creation_input_tokens", 0) or 0,
    }


def file_post(client: Any, conn: sqlite3.Connection, catalog: Catalog, source_id: str) -> Filing:
    """Label and file one post. A refusal or a cut-off answer comes back
    with ``stop`` set and nothing filed."""
    message = client.beta.messages.create(**request(conn, catalog, source_id))
    model = getattr(message, "model", None) or MODEL
    usage = _usage(message)
    if message.stop_reason in ("refusal", "max_tokens"):
        return Filing(source_id, {}, [], "", "", "", model, usage, stop=message.stop_reason)
    text = next((block.text for block in message.content if block.type == "text"), "")
    answer = json.loads(text)
    labels = {
        key: answer[key]
        for key in ("topics", "subjects", "gist", "kind", "place", "substance", "evergreen")
    }
    picks = [answer["trip"], answer["series"], answer["project"]]
    picks += answer["topics_filed"] + answer["others"]
    return Filing(
        source_id=source_id,
        labels=labels,
        picks=[name for name in picks if name],
        new_trip=answer["new_trip"].strip(),
        missing=answer["missing"].strip(),
        reason=answer["reason"].strip(),
        model=model,
        usage=usage,
    )
