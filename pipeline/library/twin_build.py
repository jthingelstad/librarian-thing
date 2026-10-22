#!/usr/bin/env python3
"""The switch's check: build today's corpora from two data trees and compare.

Builds the Weekly Thing, blog and podcast corpora, unembedded and exactly as
the upload scripts compose them, once from each tree (``LIBRARIAN_DATA_DIR``
in a child process, since the paths resolve at import), then compares them
chunk by chunk and record by record. Prints every source whose chunk text
differs and, for the rest, which fields moved and on how many sources, so
each difference can be matched against the expected list before ``data/``
leaves git.

    python pipeline/library/twin_build.py --old data --new .library/tree \\
        --old-site ../weekly.thingelstad.com/apps/site/archive

``--old-site`` is the weekly archive the old build read for audio pointers;
the new tree carries its own (``weekly/archive``).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
CORPORA = ("corpus", "blog_corpus", "podcast_corpus")
# Build stamps, not content.
VOLATILE = {"generated_at", "built_at"}


def build(out: Path) -> None:
    """In the child: build the three corpora from LIBRARIAN_DATA_DIR into ``out``."""
    sys.path.insert(0, str(REPO / "pipeline" / "deploy"))
    from librarian_core.abstracts import annotate_blog_abstracts
    from librarian_core.corpus import (
        annotate_media_descriptions,
        build_blog_corpus,
        build_podcast_corpus,
    )
    from librarian_core.paths import BLOG_ABSTRACTS_PATH, MEDIA_DESCRIPTIONS_PATH
    from upload_corpus import build_wt_corpus

    out.mkdir(parents=True, exist_ok=True)
    corpora = {"corpus": build_wt_corpus()}
    blog = build_blog_corpus()
    annotate_media_descriptions(blog, MEDIA_DESCRIPTIONS_PATH)
    annotate_blog_abstracts(blog, BLOG_ABSTRACTS_PATH)
    corpora["blog_corpus"] = blog
    corpora["podcast_corpus"] = build_podcast_corpus()
    for name, corpus in corpora.items():
        (out / f"{name}.json").write_text(json.dumps(corpus, ensure_ascii=False), encoding="utf-8")
        print(f"{out.name}/{name}: {corpus.get('chunk_count')} chunks")


def _source(record: dict[str, Any]) -> str:
    if record.get("microblog_id") is not None:
        return f"blog-{record['microblog_id']}"
    if record.get("page_id") is not None:
        return f"page-{record['page_id']}"
    if record.get("episode_number") is not None:
        return f"ep-{record['episode_number']}"
    if record.get("issue_number") is not None:
        return f"wt-{record['issue_number']}"
    if record.get("number") is not None:
        return f"wt-{record['number']}"
    if record.get("thing_id") is not None:
        return f"thing-{record['thing_id']}"
    return str(record.get("id") or record.get("url") or "?")


def _key(record: dict[str, Any]) -> str:
    for field in ("id", "microblog_id", "page_id", "number", "url"):
        if record.get(field) is not None:
            return f"{field}:{record[field]}"
    return json.dumps(record, sort_keys=True, ensure_ascii=False)


def compare(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """Chunk text added or removed per source, and field changes per list."""
    text: dict[str, Counter] = defaultdict(Counter)
    fields: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    old_chunks = {c["id"]: c for c in old.get("chunks", [])}
    new_chunks = {c["id"]: c for c in new.get("chunks", [])}
    for cid in old_chunks.keys() - new_chunks.keys():
        text[_source(old_chunks[cid])]["removed"] += 1
    for cid in new_chunks.keys() - old_chunks.keys():
        text[_source(new_chunks[cid])]["added"] += 1
    for cid in old_chunks.keys() & new_chunks.keys():
        a, b = old_chunks[cid], new_chunks[cid]
        for field in (a.keys() | b.keys()) - {"embedding"}:
            if a.get(field) != b.get(field):
                fields["chunks"][field].add(_source(b))
    for name in (old.keys() | new.keys()) - {"chunks"} - VOLATILE:
        a, b = old.get(name), new.get(name)
        if a == b:
            continue
        if isinstance(a, list) and isinstance(b, list) and all(isinstance(x, dict) for x in a + b):
            olds = {_key(r): r for r in a}
            news = {_key(r): r for r in b}
            for key in olds.keys() - news.keys():
                fields[name]["(removed)"].add(_source(olds[key]))
            for key in news.keys() - olds.keys():
                fields[name]["(added)"].add(_source(news[key]))
            for key in olds.keys() & news.keys():
                for field in olds[key].keys() | news[key].keys():
                    if olds[key].get(field) != news[key].get(field):
                        fields[name][field].add(_source(news[key]))
        else:
            fields["(top)"][name].add("-")
    return {"text": text, "fields": fields}


def report(name: str, diff: dict[str, Any], show: int) -> None:
    print(f"\n== {name}")
    text = diff["text"]
    if text:
        print(f"chunk text differs on {len(text)} sources:")
        for source in sorted(text, key=_sort):
            counts = text[source]
            print(f"  {source}: -{counts['removed']} +{counts['added']}")
    else:
        print("chunk text: identical")
    for listing, by_field in sorted(diff["fields"].items()):
        for field, sources in sorted(by_field.items(), key=lambda kv: -len(kv[1])):
            sample = ", ".join(sorted(sources, key=_sort)[:show])
            more = f" … +{len(sources) - show}" if len(sources) > show else ""
            print(f"  {listing}.{field}: {len(sources)} sources ({sample}{more})")


def _sort(source: str) -> tuple:
    kind, _, rest = source.partition("-")
    return (kind, int(rest) if rest.isdigit() else 0, rest)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--old", type=Path, help="the tree the corpus is built from today")
    parser.add_argument("--new", type=Path, help="the library's export")
    parser.add_argument("--old-site", type=Path, help="weekly archive pages for the old build")
    parser.add_argument("--out", type=Path, default=REPO / ".library" / "twin")
    parser.add_argument("--show", type=int, default=8, help="sources listed per field")
    parser.add_argument("--compare-only", action="store_true", help="reuse the last builds")
    parser.add_argument("--build-into", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    if args.build_into:
        build(args.build_into)
        return 0
    if not args.compare_only:
        if not (args.old and args.new):
            parser.error("--old and --new are required unless --compare-only")
        for side, tree, site in (
            ("old", args.old, args.old_site),
            ("new", args.new, args.new / "weekly" / "archive"),
        ):
            env = {**os.environ, "LIBRARIAN_DATA_DIR": str(tree.resolve())}
            if site:
                env["WEEKLY_SITE_ARCHIVE_DIR"] = str(site.resolve())
            subprocess.run(
                [sys.executable, __file__, "--build-into", str(args.out / side)],
                env=env,
                cwd=REPO,
                check=True,
            )
    for name in CORPORA:
        old = json.loads((args.out / "old" / f"{name}.json").read_text(encoding="utf-8"))
        new = json.loads((args.out / "new" / f"{name}.json").read_text(encoding="utf-8"))
        report(name, compare(old, new), args.show)
    return 0


if __name__ == "__main__":
    sys.exit(main())
