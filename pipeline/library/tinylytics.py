"""Reader numbers from Tinylytics into the library (read-only on Tinylytics).

Each site's hits are read raw (``GET /sites/<id>/hits``, a thousand a page)
and counted per path and US Central day here, because the grouped endpoint
only totals a whole window. Raw and grouped agree hit for hit (checked
2026-10-22 on a week of Weekly Thing). A round re-reads the last three days
it holds, so hits Tinylytics later drops as spam drop here too, and reads
through yesterday; kudos are few and are read whole each time.

A hit's visitor, referrer, country and browser are never kept: only its
path and day reach the library. The key is ``TINYLYTICS_API_KEY`` (read-only
is enough), from the environment or this repo's ``.env``. A bad key makes
Tinylytics answer with its marketing page, not a 401, so a page that is not
JSON is an error here.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterator
from datetime import date, datetime, timedelta

from librarian_core.library.db import LibraryError, now
from librarian_core.library.readers import (
    CENTRAL,
    SITES,
    central_day,
    index_readers,
    store_days,
    store_kudos,
)

API = "https://tinylytics.app/api/v1"
PER_PAGE = 1000
# The API refuses a window longer than 730 days.
WINDOW_DAYS = 365
REREAD_DAYS = 3
USER_AGENT = "librarian-thing-library/1 (+https://github.com/jthingelstad/librarian-thing)"

Fetch = Callable[[str, dict], dict]


def api_key() -> str:
    key = (os.environ.get("TINYLYTICS_API_KEY") or "").strip()
    if not key:
        raise LibraryError("TINYLYTICS_API_KEY is not set (this repo's .env holds it on otto)")
    return key


def http_fetch(key: str) -> Fetch:
    """A fetch that GETs one API path, retrying rate limits and server
    errors three times."""

    def fetch(path: str, query: dict) -> dict:
        url = f"{API}{path}?{urllib.parse.urlencode(query)}" if query else f"{API}{path}"
        request = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {key}",
                "Accept": "application/json",
                "User-Agent": USER_AGENT,
            },
        )
        for attempt in range(4):
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    body = response.read()
            except urllib.error.HTTPError as exc:
                if exc.code in (429, 500, 502, 503, 504) and attempt < 3:
                    time.sleep(2 ** (attempt + 1))
                    continue
                raise LibraryError(f"Tinylytics {path}: HTTP {exc.code}") from exc
            try:
                return json.loads(body)
            except ValueError as exc:
                raise LibraryError(
                    f"Tinylytics {path} answered with a page that is not JSON; "
                    "the API key is missing or wrong"
                ) from exc
        raise LibraryError(f"Tinylytics {path}: still failing after retries")

    return fetch


def _pages(fetch: Fetch, path: str, query: dict, rows_key: str) -> Iterator[dict]:
    page = 1
    while True:
        data = fetch(path, {**query, "per_page": PER_PAGE, "page": page})
        rows = data.get(rows_key) or []
        yield from rows
        total_pages = (data.get("pagination") or {}).get("total_pages") or 1
        if not rows or page >= total_pages:
            return
        page += 1


def _windows(start: date, end: date) -> Iterator[tuple[str, str]]:
    while start <= end:
        stop = min(end, start + timedelta(days=WINDOW_DAYS - 1))
        yield start.isoformat(), stop.isoformat()
        start = stop + timedelta(days=1)


def day_counts(
    fetch: Fetch, site_id: int, start: date, through: date
) -> dict[tuple[str, str], int]:
    """Views per (path, Central day) for ``start``..``through``. The API's
    dates are UTC days, so the window reaches a day further each way and
    every hit is placed by its own instant; a hit seen twice (pages shift
    while new hits arrive) counts once."""
    counts: dict[tuple[str, str], int] = {}
    seen: set = set()
    first, last = start.isoformat(), through.isoformat()
    for window_start, window_end in _windows(
        start - timedelta(days=1), through + timedelta(days=1)
    ):
        query = {"start_date": window_start, "end_date": window_end}
        for hit in _pages(fetch, f"/sites/{site_id}/hits", query, "hits"):
            if hit.get("id") in seen:
                continue
            seen.add(hit.get("id"))
            day = central_day(hit.get("created_at"))
            path = hit.get("path")
            if day and path and first <= day <= last:
                counts[(path, day)] = counts.get((path, day), 0) + 1
    return counts


def all_kudos(fetch: Fetch, site_id: int, since: date, through: date) -> list[tuple[int, str, str]]:
    found: dict[int, tuple[int, str, str]] = {}
    for window_start, window_end in _windows(
        since - timedelta(days=1), through + timedelta(days=1)
    ):
        query = {"start_date": window_start, "end_date": window_end}
        for kudo in _pages(fetch, f"/sites/{site_id}/kudos", query, "kudos"):
            if kudo.get("id") is not None and kudo.get("path") and kudo.get("created_at"):
                found[int(kudo["id"])] = (int(kudo["id"]), kudo["path"], kudo["created_at"])
    return sorted(found.values())


def _tracked_since(fetch: Fetch) -> dict[int, str]:
    """When Tinylytics began counting each site: the Central day it was
    added."""
    data = fetch("/sites", {})
    sites = data.get("sites") if isinstance(data, dict) else data
    out = {}
    for site in sites or []:
        day = central_day(site.get("created_at"))
        if site.get("id") is not None and day:
            out[int(site["id"])] = day
    return out


def pull_readers(
    conn: sqlite3.Connection, fetch: Fetch, *, today: date | None = None
) -> dict[str, dict]:
    """Bring every site's counts up to yesterday (US Central) and re-read its
    kudos. Returns, per site, the days read and the views and kudos found."""
    today = today or datetime.now(CENTRAL).date()
    through = today - timedelta(days=1)
    held = {row["site"]: row for row in conn.execute("SELECT * FROM reader_sites")}
    added: dict[int, str] | None = None
    report: dict[str, dict] = {}
    for site, info in SITES.items():
        site_id = info["tinylytics_id"]
        row = held.get(site)
        if row is not None:
            tracked_since = row["tracked_since"]
        else:
            added = added if added is not None else _tracked_since(fetch)
            if site_id not in added:
                raise LibraryError(f"Tinylytics does not list site {site_id} ({site}) for this key")
            tracked_since = added[site_id]
        since = date.fromisoformat(tracked_since)
        start = since
        if row is not None and row["pulled_through"]:
            start = max(
                since, date.fromisoformat(row["pulled_through"]) - timedelta(days=REREAD_DAYS - 1)
            )
        if start > through:
            report[site] = {"days": 0, "views": 0}
            continue
        counts = day_counts(fetch, site_id, start, through)
        kudos = all_kudos(fetch, site_id, since, through)
        store_days(conn, site, start.isoformat(), through.isoformat(), counts)
        store_kudos(conn, site, kudos)
        with conn:
            conn.execute(
                "INSERT INTO reader_sites (site, tinylytics_id, tracked_since, pulled_through, pulled_at) "
                "VALUES (?, ?, ?, ?, ?) ON CONFLICT (site) DO UPDATE SET "
                "tinylytics_id = excluded.tinylytics_id, pulled_through = excluded.pulled_through, "
                "pulled_at = excluded.pulled_at",
                (site, site_id, tracked_since, through.isoformat(), now()),
            )
        report[site] = {
            "from": start.isoformat(),
            "through": through.isoformat(),
            "days": (through - start).days + 1,
            "views": sum(counts.values()),
            "kudos": len(kudos),
        }
    report["paths"] = index_readers(conn)
    return report
