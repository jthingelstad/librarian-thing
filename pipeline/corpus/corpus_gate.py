#!/usr/bin/env python3
"""Archive checks on a Weekly Thing corpus, and the daily audio freshness pull.

Two subcommands, one set of checks:

``gate`` runs in deploy.yml's corpus gate on the staged candidate, before
anything reaches S3. It fails the deploy when:

- the Journal copies left unmatched rise above JOURNAL_UNMATCHED_MAX, the
  count after the 2026-10-01 permalink repair (pipeline/audits/
  repair_journal_permalinks.py), so a regression in matching or ingest
  cannot quietly undo it; or
- an issue page on the weekly site carries an audio edition the candidate
  does not (or carries a different one). The audio record lives only in the
  site's render copy (librarian_core.audio); a site checkout that failed
  would otherwise ship a corpus with every pointer gone; or
- a staged blog candidate files a post by any day but the Chicago day of its
  ``published`` moment, or keeps a 05:00Z date-only placeholder (QA2 I2-8,
  Q16).

``freshness`` runs on a schedule: it compares the site's audio records with
the live corpus in S3 and sets ``stale=true`` in $GITHUB_OUTPUT when they
differ, so the workflow rebuilds the Weekly Thing corpus. A new audio
edition commits to the site, not here, so nothing else would rebuild it
until the next issue. Pull, not push: the site never triggers this repo.

  uv run --locked python pipeline/corpus/corpus_gate.py gate \
      --candidate .candidate --site-archive .weekly-site/apps/site/archive
  uv run --locked python pipeline/corpus/corpus_gate.py freshness \
      --site-archive .weekly-site/apps/site/archive --from-s3
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "librarian-core"))

from librarian_core.audio import audio_record, read_site_frontmatter  # noqa: E402
from librarian_core.corpus import blog_published, chicago_day  # noqa: E402

# Journal copies the build could not tie to a blog post, after the
# 2026-10-01 repair (notes/audits/journal-permalinks-unmatched-2026-10-01.csv).
JOURNAL_UNMATCHED_MAX = 33


def site_audio(site_archive_dir: Path) -> dict[int, dict[str, Any]]:
    """{issue number: audio record} for every site page with an audio edition."""
    records: dict[int, dict[str, Any]] = {}
    for page in site_archive_dir.glob("*.md"):
        if not page.stem.isdigit():
            continue
        frontmatter = read_site_frontmatter(page)
        record = audio_record(frontmatter) if frontmatter else None
        if record:
            records[int(page.stem)] = record
    return records


def audio_drift(corpus: dict[str, Any], site: dict[int, dict[str, Any]]) -> list[str]:
    """One line per issue whose site audio record the corpus lacks or differs
    from. An issue the site has no audio for is not checked: the site is the
    only record, and a page without one has nothing to carry."""
    issues = {
        int(issue["number"]): issue
        for issue in corpus.get("issues") or []
        if str(issue.get("number", "")).isdigit()
    }
    drift = []
    for number in sorted(site):
        issue = issues.get(number)
        if issue is None:
            continue  # the site has a page the corpus has no issue for yet
        have = issue.get("audio")
        if have is None:
            drift.append(f"WT{number}: site has {site[number]['url']}, corpus has none")
        elif have != site[number]:
            drift.append(f"WT{number}: corpus audio differs from the site's ({have.get('url')})")
    return drift


def gate_failures(corpus: dict[str, Any], site_archive_dir: Path | None) -> list[str]:
    failures = []
    unmatched = (corpus.get("journal_copy_stats") or {}).get("unmatched")
    if not isinstance(unmatched, int):
        failures.append("journal_copy_stats.unmatched missing from the corpus")
    elif unmatched > JOURNAL_UNMATCHED_MAX:
        failures.append(
            f"journal copies unmatched rose to {unmatched} (ceiling {JOURNAL_UNMATCHED_MAX}): "
            "see journal_unmatched in the candidate"
        )
    if site_archive_dir is None or not site_archive_dir.is_dir():
        failures.append(
            f"weekly site archive unavailable at {site_archive_dir}: refusing to ship a "
            "corpus whose audio pointers cannot be checked"
        )
    else:
        failures.extend(audio_drift(corpus, site_audio(site_archive_dir)))
    return failures


def blog_date_failures(blog: dict[str, Any]) -> list[str]:
    """One line per blog post whose filed day or year is not the Chicago day
    of its ``published`` moment (QA2 I2-8, T2-2: 121 posts were filed by the
    permalink's date, 11 in another year), and per post still carrying a
    05:00Z placeholder from a CST month that its permalink does not vouch for
    (QA2 Q16: Jamie, 2026-10-01, those read as Chicago noon)."""
    failures = []
    for post in blog.get("posts") or []:
        published = post.get("published")
        day = chicago_day(published)
        if not day:
            continue
        name = f"blog-{post.get('microblog_id')}"
        if post.get("publish_date") != day or post.get("post_year") != int(day[:4]):
            failures.append(
                f"{name}: filed {post.get('publish_date')} ({post.get('post_year')}), "
                f"published {published} is {day} in Chicago"
            )
        elif blog_published(published, post.get("permalink_date") or day) != published:
            failures.append(f"{name}: 05:00Z placeholder {published} kept")
    return failures


def load_json(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    return json.loads(data)


def live_corpus() -> dict[str, Any]:
    import boto3

    bucket = os.environ.get("LIBRARIAN_BUCKET", "weekly-thing-librarian")
    key = os.environ.get("LIBRARIAN_CORPUS_KEY", "artifacts/corpus.json")
    body = boto3.client("s3").get_object(Bucket=bucket, Key=key)["Body"].read()
    if body[:2] == b"\x1f\x8b":
        body = gzip.decompress(body)
    return json.loads(body)


def set_output(name: str, value: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as handle:
            handle.write(f"{name}={value}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    gate = commands.add_parser("gate", help="check a staged candidate corpus")
    gate.add_argument("--candidate", type=Path, required=True)
    gate.add_argument("--site-archive", type=Path, required=True)
    fresh = commands.add_parser("freshness", help="compare the site's audio with a corpus")
    fresh.add_argument("--site-archive", type=Path, required=True)
    source = fresh.add_mutually_exclusive_group(required=True)
    source.add_argument("--corpus", type=Path)
    source.add_argument("--from-s3", action="store_true")
    args = parser.parse_args(argv)

    if args.command == "gate":
        candidate = args.candidate / "corpus.json"
        blog_candidate = args.candidate / "blog_corpus.json"
        if not candidate.is_file() and not blog_candidate.is_file():
            print(f"corpus gate: no candidate corpus in {args.candidate}; nothing to check")
            return 0
        failures = []
        if candidate.is_file():
            failures.extend(gate_failures(load_json(candidate), args.site_archive))
        if blog_candidate.is_file():
            failures.extend(blog_date_failures(load_json(blog_candidate)))
        for failure in failures:
            print(f"FAIL {failure}")
        print(f"corpus gate (archive checks): {len(failures)} failed")
        return 1 if failures else 0

    if not args.site_archive.is_dir():
        print(f"audio freshness: no site archive at {args.site_archive}")
        return 1
    corpus = live_corpus() if args.from_s3 else load_json(args.corpus)
    drift = audio_drift(corpus, site_audio(args.site_archive))
    for line in drift:
        print(line)
    print(f"audio freshness: {len(drift)} issue(s) differ from the site")
    set_output("stale", "true" if drift else "false")
    return 0


if __name__ == "__main__":
    sys.exit(main())
