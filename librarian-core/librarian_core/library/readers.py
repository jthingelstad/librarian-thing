"""Reader numbers: what Tinylytics counted on each of Jamie's sites, kept in
the library and carried into the corpus as metadata on each source.

The library keeps counts only: views per site, path and US Central day, and
each kudo's path and time. No visitor, referrer, country or browser is kept.
``reader_paths`` says which source (and which measure) each counted path
belongs to, old Weekly Thing slugs included; ``reindex`` rebuilds it, so a
source that moves takes its numbers with it.

``readers_export`` is what the corpus carries, per source id: views by month
since tracking began, views by day for the last 90 days of what was pulled,
email opens and feed reads for issues, and kudos with their dates. Each
site's ``tracked_since`` travels with it, because a 2009 post's count is
views since July 2024, never all time. Email opens are per issue (the open
pixel), never per recipient.
"""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import date, datetime, timedelta, timezone
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo

from librarian_core.library.db import sha256

CENTRAL = ZoneInfo("America/Chicago")

# Each Tinylytics site the library reads: its key (the id in
# shared/sites.json), its Tinylytics id, and the hosts its sources live on.
# Thingy's site (3424) counts the chat, not content, and stays out.
SITES: dict[str, dict] = {
    "www": {
        "tinylytics_id": 1521,
        "hosts": (
            "www.thingelstad.com",
            "thingelstad.com",
            "micro.thingelstad.com",
            "jthingelstad.micro.blog",
        ),
    },
    "weekly": {"tinylytics_id": 3063, "hosts": ("weekly.thingelstad.com",)},
    "another": {"tinylytics_id": 3059, "hosts": ("another.thingelstad.com",)},
    "xyz": {"tinylytics_id": 3823, "hosts": ("thingelstad.xyz",)},
}
MEASURES = ("views", "email_opens", "feed_reads")
RECENT_DAYS = 90

# Which source ids each corpus carries numbers for (the ids its tools emit).
CORPUS_READERS: dict[str, tuple[str, ...]] = {
    "corpus": ("wt-", "site-", "thing-"),
    "blog_corpus": ("blog-", "page-"),
    "podcast_corpus": ("ep-",),
}

_ISSUE_PATHS = (
    (re.compile(r"^/archive/(\d+)/?$"), "views"),
    (re.compile(r"^/email/(\d+)/?$"), "email_opens"),
    (re.compile(r"^/feed/(\d+)/?$"), "feed_reads"),
    # Buttondown's archive slugs, before the site moved to /archive/<n>/.
    (re.compile(r"^/archive/weekly-thing-(\d+)(?:-[^/]*)?/?$"), "views"),
)
# Sources the corpus builds that have no row in the library: the FAQ (from
# the Lambda's faq.json) and the registry's index (thingelstad.xyz itself).
_BUILT_PAGES = {("weekly", "/faq"): "site-faq", ("xyz", "/"): "thing-index"}
_DATED_SLUG = re.compile(r"^/archive/weekly-thing-for-([a-z]+)-(\d{1,2})-(\d{4})/?$")
_MONTHS = {
    name: number
    for number, names in enumerate(
        (
            ("january", "jan"),
            ("february", "feb"),
            ("march", "mar"),
            ("april", "apr"),
            ("may",),
            ("june", "jun"),
            ("july", "jul"),
            ("august", "aug"),
            ("september", "sep", "sept"),
            ("october", "oct"),
            ("november", "nov"),
            ("december", "dec"),
        ),
        start=1,
    )
    for name in names
}


def _path_key(path: str) -> str:
    """A path as matched: decoded, without a trailing slash (``/`` stays)."""
    return unquote(path).rstrip("/") or "/"


def _site_of(url: str | None) -> tuple[str, str] | None:
    """``(site, path key)`` for a source URL on one of the counted sites."""
    if not url:
        return None
    parts = urlsplit(url)
    for site, info in SITES.items():
        if parts.hostname in info["hosts"]:
            return site, _path_key(parts.path or "/")
    return None


def reader_source_id(source_id: str, kind: str, url: str | None) -> str:
    """The id a source's numbers are kept under: the library's own id, except
    a Weekly Thing site page, which the Lambda names by its address
    (``support.njk`` at ``/members/`` is ``site-members``)."""
    if kind == "site_page" and url:
        tail = urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1]
        return f"site-{tail or 'index'}"
    return source_id


def central_day(value: str | None) -> str | None:
    """The US Central date of an ISO instant (a bare date stays as it is)."""
    if not value:
        return None
    try:
        instant = datetime.fromisoformat(value)
    except ValueError:
        return None
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    return instant.astimezone(CENTRAL).date().isoformat()


def _issue_dates(conn: sqlite3.Connection) -> dict[str, list[str]]:
    """Each Central publish date and the issues sent on it."""
    out: dict[str, list[str]] = {}
    for row in conn.execute("SELECT id, published FROM sources WHERE kind = 'issue'"):
        day = central_day(row["published"])
        if day:
            out.setdefault(day, []).append(row["id"])
    return out


def index_readers(conn: sqlite3.Connection) -> dict[str, int]:
    """Rebuild ``reader_paths`` from every counted path and the sources. A
    path two sources share (a few early blog posts share one address) is
    left unattributed rather than counted twice. Returns paths per measure,
    plus ``unattributed``."""
    by_path: dict[tuple[str, str], list[str]] = {}
    for row in conn.execute("SELECT id, kind, url FROM sources"):
        located = _site_of(row["url"])
        if located:
            by_path.setdefault(located, []).append(
                reader_source_id(row["id"], row["kind"], row["url"])
            )
    issue_dates = _issue_dates(conn)
    issues = {row[0] for row in conn.execute("SELECT id FROM sources WHERE kind = 'issue'")}

    rows: list[tuple[str, str, str | None, str]] = []
    paths = conn.execute(
        "SELECT site, path FROM reader_days UNION SELECT site, path FROM kudos"
    ).fetchall()
    for site, path in paths:
        source_id, measure = None, "views"
        if site == "weekly":
            for pattern, issue_measure in _ISSUE_PATHS:
                match = pattern.match(path)
                if match and f"wt-{int(match.group(1))}" in issues:
                    source_id, measure = f"wt-{int(match.group(1))}", issue_measure
                    break
            dated = _DATED_SLUG.match(path) if source_id is None else None
            if dated and dated.group(1) in _MONTHS:
                day = date(int(dated.group(3)), _MONTHS[dated.group(1)], int(dated.group(2)))
                sent = issue_dates.get(day.isoformat(), [])
                if len(sent) == 1:
                    source_id = sent[0]
        if source_id is None:
            source_id = _BUILT_PAGES.get((site, _path_key(path)))
        if source_id is None:
            claimed = by_path.get((site, _path_key(path)), [])
            if len(claimed) == 1:
                source_id = claimed[0]
        rows.append((site, path, source_id, measure))

    with conn:
        conn.execute("DELETE FROM reader_paths")
        conn.executemany(
            "INSERT INTO reader_paths (site, path, source_id, measure) VALUES (?, ?, ?, ?)", rows
        )
    counts: dict[str, int] = {}
    for _site, _path, source_id, measure in rows:
        key = measure if source_id else "unattributed"
        counts[key] = counts.get(key, 0) + 1
    return counts


def store_days(
    conn: sqlite3.Connection,
    site: str,
    start: str,
    through: str,
    counts: dict[tuple[str, str], int],
) -> None:
    """Replace the site's counts for ``start``..``through`` (Central days,
    inclusive) with ``counts`` ({(path, day): views})."""
    with conn:
        conn.execute(
            "DELETE FROM reader_days WHERE site = ? AND day BETWEEN ? AND ?", (site, start, through)
        )
        conn.executemany(
            "INSERT INTO reader_days (site, path, day, views) VALUES (?, ?, ?, ?)",
            [(site, path, day, views) for (path, day), views in sorted(counts.items())],
        )


def store_kudos(conn: sqlite3.Connection, site: str, kudos: list[tuple[int, str, str]]) -> None:
    """Replace the site's kudos with ``kudos`` ([(id, path, at)]), so one
    Jamie removed in Tinylytics goes here too."""
    with conn:
        conn.execute("DELETE FROM kudos WHERE site = ?", (site,))
        conn.executemany(
            "INSERT INTO kudos (site, id, path, at) VALUES (?, ?, ?, ?)",
            [(site, kudo_id, path, at) for kudo_id, path, at in kudos],
        )


def readers_export(conn: sqlite3.Connection) -> dict:
    """Every source's numbers, keyed by the id the Lambda's tools emit."""
    sites: dict[str, dict] = {}
    for row in conn.execute("SELECT * FROM reader_sites ORDER BY site"):
        sites[row["site"]] = {
            "tracked_since": row["tracked_since"],
            "through": row["pulled_through"],
        }
    recent_from = {
        site: (date.fromisoformat(info["through"]) - timedelta(days=RECENT_DAYS - 1)).isoformat()
        for site, info in sites.items()
        if info["through"]
    }
    sources: dict[str, dict] = {}
    for row in conn.execute(
        "SELECT p.source_id, p.site, p.measure, d.day, sum(d.views) AS views "
        "FROM reader_days d JOIN reader_paths p ON p.site = d.site AND p.path = d.path "
        "WHERE p.source_id IS NOT NULL GROUP BY p.source_id, p.site, p.measure, d.day "
        "ORDER BY p.source_id, p.measure, d.day"
    ):
        entry = sources.setdefault(row["source_id"], {"site": row["site"]})
        measure = entry.setdefault(row["measure"], {"total": 0, "months": {}, "days": {}})
        measure["total"] += row["views"]
        month = row["day"][:7]
        measure["months"][month] = measure["months"].get(month, 0) + row["views"]
        if row["site"] in recent_from and row["day"] >= recent_from[row["site"]]:
            measure["days"][row["day"]] = row["views"]
    for row in conn.execute(
        "SELECT p.source_id, k.site, k.at FROM kudos k "
        "JOIN reader_paths p ON p.site = k.site AND p.path = k.path "
        "WHERE p.source_id IS NOT NULL ORDER BY p.source_id, k.at"
    ):
        entry = sources.setdefault(row["source_id"], {"site": row["site"]})
        entry.setdefault("kudos", []).append(central_day(row["at"]) or row["at"][:10])
    return {"version": 1, "sites": sites, "sources": dict(sorted(sources.items()))}


def corpus_readers(export: dict, corpus: str) -> dict:
    """The part of ``readers_export`` one corpus carries."""
    prefixes = CORPUS_READERS[corpus]
    return {
        "version": export.get("version", 1),
        "sites": export.get("sites", {}),
        "sources": {
            source_id: numbers
            for source_id, numbers in (export.get("sources") or {}).items()
            if source_id.startswith(prefixes)
        },
    }


def readers_fingerprint(export: dict, corpus: str) -> str:
    """A hash of what one corpus would carry, for ``fingerprints``."""
    return sha256(json.dumps(corpus_readers(export, corpus), sort_keys=True))
