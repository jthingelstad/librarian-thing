"""library.db: its schema, and the meta and file helpers every step shares."""

from __future__ import annotations

import hashlib
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1

# Pulled tables hold what the sources published; made tables hold what the
# Librarian decides or writes about it; the made tables exist nowhere else,
# which is what the bucket's 30 days of replaced copies protect.
SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Pulled: every file of the data tree, byte for byte as the pull wrote it.
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  content TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  pulled_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_origin ON files (origin);

-- Pulled: one row per source, read from files by reindex().
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  url TEXT,
  title TEXT,
  published TEXT,
  updated TEXT,
  categories TEXT NOT NULL DEFAULT '[]',
  sha256 TEXT NOT NULL,
  pulled_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sources_kind ON sources (kind);

-- Pulled: each image in a source, with its alt as published.
CREATE TABLE IF NOT EXISTS media (
  source_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  url TEXT NOT NULL,
  alt TEXT,
  PRIMARY KEY (source_id, position)
);
CREATE INDEX IF NOT EXISTS media_url ON media (url);

-- What each absorb took in, per origin.
CREATE TABLE IF NOT EXISTS pulls (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  origin TEXT NOT NULL,
  added INTEGER NOT NULL,
  changed INTEGER NOT NULL,
  removed INTEGER NOT NULL,
  note TEXT
);

-- Made: the catalog. categories are the blog's categories as the Librarian
-- keeps them (Featured included); labels are its reading of each post;
-- filings what it last wrote to each post, or what Jamie set by hand.
CREATE TABLE IF NOT EXISTS categories (
  name TEXT PRIMARY KEY,
  slug TEXT,
  kind TEXT NOT NULL,
  description TEXT,
  why TEXT,
  made_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE TABLE IF NOT EXISTS labels (
  source_id TEXT PRIMARY KEY,
  topics TEXT NOT NULL DEFAULT '[]',
  subjects TEXT NOT NULL DEFAULT '[]',
  gist TEXT,
  kind TEXT,
  place TEXT,
  substance TEXT,
  evergreen INTEGER,
  model TEXT,
  labeled_at TEXT
);
CREATE TABLE IF NOT EXISTS filings (
  source_id TEXT PRIMARY KEY,
  categories TEXT NOT NULL DEFAULT '[]',
  alt_filled TEXT NOT NULL DEFAULT '[]',
  jamie_set INTEGER NOT NULL DEFAULT 0,
  filed_by TEXT NOT NULL,
  filed_at TEXT NOT NULL
);
-- Every write to micro.blog (and every one a dry run would have made).
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  run TEXT,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  before TEXT,
  after TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  result TEXT
);
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY,
  opened_at TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  closed_at TEXT,
  note TEXT
);

-- Measured: what Tinylytics counted (librarian_core/library/readers.py).
-- Counts only: views per site, path and US Central day, and each kudo's path
-- and time. No visitor, referrer, country or browser is kept.
CREATE TABLE IF NOT EXISTS reader_sites (
  site TEXT PRIMARY KEY,
  tinylytics_id INTEGER NOT NULL,
  tracked_since TEXT NOT NULL,
  pulled_through TEXT,
  pulled_at TEXT
);
CREATE TABLE IF NOT EXISTS reader_days (
  site TEXT NOT NULL,
  path TEXT NOT NULL,
  day TEXT NOT NULL,
  views INTEGER NOT NULL,
  PRIMARY KEY (site, path, day)
);
CREATE TABLE IF NOT EXISTS kudos (
  site TEXT NOT NULL,
  id INTEGER NOT NULL,
  path TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (site, id)
);
-- Each counted path, the source it belongs to (NULL when none, or when two
-- sources share the address) and the measure; rebuilt by reindex().
CREATE TABLE IF NOT EXISTS reader_paths (
  site TEXT NOT NULL,
  path TEXT NOT NULL,
  source_id TEXT,
  measure TEXT NOT NULL,
  PRIMARY KEY (site, path)
);
CREATE INDEX IF NOT EXISTS reader_paths_source ON reader_paths (source_id);
CREATE VIEW IF NOT EXISTS reader_months AS
  SELECT site, path, substr(day, 1, 7) AS month, sum(views) AS views
  FROM reader_days GROUP BY site, path, month;

-- Made: the vision description of each image and each blog post's abstract,
-- read from the sidecars the describe and abstract tools keep in the tree.
CREATE VIEW IF NOT EXISTS descriptions AS
  SELECT d.key AS url,
         json_extract(d.value, '$.description') AS description,
         json_extract(d.value, '$.error') AS error,
         json_extract(d.value, '$.model') AS model,
         json_extract(d.value, '$.described_at') AS described_at
  FROM files, json_each(files.content) AS d
  WHERE files.path = 'librarian/media-descriptions.json';
CREATE VIEW IF NOT EXISTS summaries AS
  SELECT 'blog-' || s.key AS source_id,
         json_extract(s.value, '$.abstract') AS abstract,
         json_extract(s.value, '$.body_hash') AS body_hash,
         json_extract(s.value, '$.model') AS model,
         json_extract(s.value, '$.generated_at') AS generated_at
  FROM files, json_each(files.content) AS s
  WHERE files.path = 'librarian/blog-abstracts.json';
"""


class LibraryError(RuntimeError):
    """The library refused an operation that would lose or corrupt it."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def connect(path: str | Path, *, create: bool = False) -> sqlite3.Connection:
    """Open library.db, creating the schema when ``create`` is set. Refuses a
    file written by newer code, and a missing file unless ``create``."""
    path = Path(path)
    if not create and not path.exists():
        raise LibraryError(f"{path} does not exist (download it, or create a new library)")
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    version = meta_get(conn, "schema_version")
    if version is None:
        meta_set(conn, "schema_version", str(SCHEMA_VERSION))
        meta_set(conn, "library_id", uuid.uuid4().hex)
        meta_set(conn, "created_at", now())
        conn.commit()
    elif int(version) > SCHEMA_VERSION:
        conn.close()
        raise LibraryError(
            f"{path} has schema {version}; this code knows {SCHEMA_VERSION}. Update the code."
        )
    return conn


def meta_get(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def meta_set(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) "
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def counts(conn: sqlite3.Connection) -> dict[str, int]:
    """Rows per table, plus files and sources per origin and kind."""
    out: dict[str, int] = {}
    for table in (
        "files",
        "sources",
        "media",
        "categories",
        "labels",
        "filings",
        "events",
        "reader_days",
        "kudos",
    ):
        out[table] = conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
    for origin, n in conn.execute("SELECT origin, count(*) FROM files GROUP BY origin"):
        out[f"files:{origin}"] = n
    for kind, n in conn.execute("SELECT kind, count(*) FROM sources GROUP BY kind"):
        out[f"sources:{kind}"] = n
    return out
