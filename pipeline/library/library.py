#!/usr/bin/env python3
"""The library from the command line: download, pull, absorb, upload.

``library.db`` (see librarian_core/library) is the archive; ``data/`` is a
working copy of it. The local copy lives in ``.library/`` with the ETag it
was downloaded at, so ``upload`` only replaces the copy it started from.

    python pipeline/library/library.py round          # the whole morning pull
    python pipeline/library/library.py download       # .library/library.db + its ETag
    python pipeline/library/library.py export         # library -> data/
    python pipeline/library/library.py pull           # sources -> data/ -> library
    python pipeline/library/library.py upload         # .library/library.db -> S3, If-Match
    python pipeline/library/library.py status         # what the local copy holds
    python pipeline/library/library.py create --from-tree data   # a new library (once)

``pull`` runs the same ingesters as always against the exported tree
(``LIBRARIAN_DATA_DIR``): the blog ingest as a full, pruning walk of
micro.blog; weekly.thingelstad.com's archive, about and support pages and
another.thingelstad.com's episodes from shallow sparse clones of their public
repos (or ``--weekly-dir`` / ``--another-dir`` checkouts); and the
thingelstad.xyz registry. Then it absorbs what changed. Nothing here writes to
any source.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from librarian_core.library import absorb_tree, connect, export_tree, reindex
from librarian_core.library.db import LibraryError, counts, meta_get, now
from librarian_core.library.store import LibraryConflict, download, upload
from librarian_core.paths import DATA, REPO

LIBRARY_DIR = REPO / ".library"
DB_PATH = LIBRARY_DIR / "library.db"
STATE_PATH = LIBRARY_DIR / "state.json"
SOURCES = ("blog", "weekly", "another", "things")
WEEKLY_REPO = "https://github.com/jthingelstad/weekly.thingelstad.com.git"
ANOTHER_REPO = "https://github.com/jthingelstad/another.thingelstad.com.git"
WEEKLY_SITE_FILES = ("about.njk", "support.njk", "_data/support.json")
# Which origins each pull refreshes, so an absorb compares only those.
ORIGINS = {"blog": "micro.blog", "weekly": "weekly", "another": "another", "things": "xyz"}


@contextmanager
def _library(*, create: bool = False) -> Iterator:
    """The local library.db, committed and closed on the way out, so the
    file is whole before anything uploads it."""
    conn = connect(DB_PATH, create=create)
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def _state() -> dict:
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    return {}


def _save_state(**values) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    state = {**_state(), **values}
    STATE_PATH.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def cmd_download() -> int:
    etag = download(DB_PATH)
    if etag is None:
        print("no library in S3 yet; create one with `create --from-tree`", file=sys.stderr)
        return 1
    _save_state(etag=etag, downloaded_at=now())
    with _library() as conn:
        print(f"downloaded library {meta_get(conn, 'library_id')} at {etag}")
    return 0


def cmd_upload() -> int:
    if not DB_PATH.exists():
        print(f"{DB_PATH} does not exist", file=sys.stderr)
        return 1
    state = _state()
    if "etag" not in state and not state.get("created"):
        print("no ETag recorded: download first, or create a new library", file=sys.stderr)
        return 1
    etag = upload(DB_PATH, state.get("etag"))
    _save_state(etag=etag, uploaded_at=now(), created=False)
    print(f"uploaded library.db ({DB_PATH.stat().st_size:,} bytes) at {etag}")
    return 0


def cmd_create(from_tree: Path, force: bool) -> int:
    if DB_PATH.exists() and not force:
        print(f"{DB_PATH} exists; pass --force to replace it", file=sys.stderr)
        return 1
    DB_PATH.unlink(missing_ok=True)
    with _library(create=True) as conn:
        changes = absorb_tree(conn, from_tree, seed=True, note=f"created from {from_tree}")
        kinds = reindex(conn)
    STATE_PATH.unlink(missing_ok=True)
    _save_state(created=True)
    for origin, bucket in sorted(changes.items()):
        print(f"  {origin}: {len(bucket['added'])} files")
    print(f"  sources: {kinds}")
    return 0


def cmd_export(tree: Path, force: bool) -> int:
    with _library() as conn:
        written = export_tree(conn, tree, force=force)
    print(f"exported {written} files to {tree}")
    return 0


def _run(argv: list[str], tree: Path) -> None:
    env = {**os.environ, "LIBRARIAN_DATA_DIR": str(tree)}
    print("$ " + " ".join(argv), flush=True)
    subprocess.run(argv, cwd=REPO, env=env, check=True)


def _sparse_clone(url: str, paths: list[str], into: Path) -> Path:
    subprocess.run(
        [
            "git",
            "clone",
            "--quiet",
            "--depth",
            "1",
            "--filter=blob:none",
            "--sparse",
            url,
            str(into),
        ],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(into), "sparse-checkout", "set", "--no-cone", *paths], check=True
    )
    return into


def _mirror(files: dict[str, Path], dest: Path) -> None:
    """Make ``dest`` hold exactly ``files`` (relative path -> source file)."""
    if dest.exists():
        for existing in dest.rglob("*"):
            if existing.is_file() and existing.relative_to(dest).as_posix() not in files:
                existing.unlink()
    for rel, source in files.items():
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)


def pull_weekly(tree: Path, weekly_dir: Path | None) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        if weekly_dir is None:
            weekly_dir = _sparse_clone(
                WEEKLY_REPO,
                ["/apps/site/archive/*.md", *[f"/apps/site/{name}" for name in WEEKLY_SITE_FILES]],
                Path(tmp) / "weekly",
            )
        site = weekly_dir / "apps" / "site"
        pages = {path.name: path for path in sorted((site / "archive").glob("*.md"))}
        if len(pages) < 300:
            raise LibraryError(f"weekly's archive has {len(pages)} pages; refusing a short pull")
        _mirror(pages, tree / "weekly" / "archive")
        missing = [name for name in WEEKLY_SITE_FILES if not (site / name).is_file()]
        if missing:
            raise LibraryError(f"weekly is missing {', '.join(missing)}")
        _mirror({name: site / name for name in WEEKLY_SITE_FILES}, tree / "site")
        print(f"weekly: {len(pages)} archive pages and {len(WEEKLY_SITE_FILES)} site files")


def pull_another(tree: Path, another_dir: Path | None) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        if another_dir is None:
            another_dir = _sparse_clone(ANOTHER_REPO, ["/content/episodes/"], Path(tmp) / "another")
        _run(
            [
                sys.executable,
                "pipeline/podcast/import_another_thing.py",
                "--source-dir",
                str(another_dir / "content" / "episodes"),
                "--output-dir",
                str(tree / "podcast" / "another-thing" / "episodes"),
            ],
            tree,
        )


def cmd_pull(
    tree: Path, only: list[str], weekly_dir: Path | None, another_dir: Path | None
) -> dict:
    with _library() as conn:
        if not (tree / ".library.json").exists():
            raise LibraryError(f"{tree} is not an export of the library; run export first")
        for source in only:
            if source == "blog":
                _run([sys.executable, "pipeline/blog/ingest_blog.py", "--prune"], tree)
            elif source == "weekly":
                pull_weekly(tree, weekly_dir)
            elif source == "another":
                pull_another(tree, another_dir)
            elif source == "things":
                _run([sys.executable, "pipeline/things/import_things.py"], tree)
        changes = absorb_tree(conn, tree, origins={ORIGINS[s] for s in only}, note="pull")
        kinds = reindex(conn)
    _report(changes)
    print(f"sources: {kinds}")
    return changes


def cmd_absorb(tree: Path, allow_removals: bool) -> int:
    with _library() as conn:
        changes = absorb_tree(conn, tree, allow_removals=allow_removals, note="absorb")
        reindex(conn)
    _report(changes)
    return 0


def _report(changes: dict) -> None:
    if not any(v for bucket in changes.values() for v in bucket.values()):
        print("no changes")
    for origin, bucket in sorted(changes.items()):
        line = ", ".join(f"{len(paths)} {what}" for what, paths in bucket.items() if paths)
        if line:
            print(f"  {origin}: {line}")
            for what, paths in bucket.items():
                for path in paths[:10]:
                    print(f"    {what[0]} {path}")
                if len(paths) > 10:
                    print(f"    … {len(paths) - 10} more {what}")


def cmd_round(tree: Path, only: list[str], weekly_dir: Path | None) -> int:
    """Download, export, pull, upload; on a conflict, once more from the top."""
    for attempt in (1, 2):
        if cmd_download():
            return 1
        cmd_export(tree, force=False)
        cmd_pull(tree, only, weekly_dir, None)
        try:
            return cmd_upload()
        except LibraryConflict as exc:
            if attempt == 2:
                raise
            print(f"{exc}; starting the round again", file=sys.stderr)
    return 1


def cmd_status() -> int:
    with _library() as conn:
        print(f"library {meta_get(conn, 'library_id')} (created {meta_get(conn, 'created_at')})")
        print(json.dumps(_state(), indent=2))
        for name, value in counts(conn).items():
            print(f"  {name}: {value:,}")
        print("recent pulls:")
        for row in conn.execute("SELECT * FROM pulls ORDER BY id DESC LIMIT 8"):
            print(
                f"  {row['at']} {row['origin']}: +{row['added']} ~{row['changed']} "
                f"-{row['removed']} ({row['note'] or ''})"
            )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("download")
    sub.add_parser("upload")
    sub.add_parser("status")
    create = sub.add_parser("create")
    create.add_argument("--from-tree", type=Path, required=True)
    create.add_argument("--force", action="store_true")
    for name in ("export", "pull", "absorb", "round"):
        command = sub.add_parser(name)
        command.add_argument("--tree", type=Path, default=DATA)
        if name == "export":
            command.add_argument("--force", action="store_true")
        if name in ("pull", "round"):
            command.add_argument("--only", default=",".join(SOURCES))
            command.add_argument("--weekly-dir", type=Path)
        if name == "pull":
            command.add_argument("--another-dir", type=Path)
        if name == "absorb":
            command.add_argument("--allow-removals", action="store_true")
    args = parser.parse_args(argv)

    only = [s.strip() for s in getattr(args, "only", "").split(",") if s.strip()]
    unknown = sorted(set(only) - set(SOURCES))
    if unknown:
        parser.error(f"unknown source(s): {', '.join(unknown)}")
    try:
        if args.command == "download":
            return cmd_download()
        if args.command == "upload":
            return cmd_upload()
        if args.command == "status":
            return cmd_status()
        if args.command == "create":
            return cmd_create(args.from_tree, args.force)
        if args.command == "export":
            return cmd_export(args.tree, args.force)
        if args.command == "pull":
            cmd_pull(args.tree, only, args.weekly_dir, args.another_dir)
            return 0
        if args.command == "absorb":
            return cmd_absorb(args.tree, args.allow_removals)
        if args.command == "round":
            return cmd_round(args.tree, only, args.weekly_dir)
    except (LibraryError, LibraryConflict) as exc:
        print(f"library: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"library: {' '.join(map(str, exc.cmd))} failed ({exc.returncode})", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    sys.exit(main())
