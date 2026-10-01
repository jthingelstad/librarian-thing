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
- an ingest check fails (``ingest_failures``, QA 2026-10-01 round 3): a
  regression in the build's strips or media ties that would otherwise ship
  without a sound. The blog checks run on the blog candidate when one is
  staged.

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
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "librarian-core"))

from librarian_core.audio import audio_record, read_site_frontmatter  # noqa: E402
from librarian_core.paths import BLOG_DIR  # noqa: E402

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


# Ingest checks (QA 2026-10-01 round 3). Each pins a fix the corpus build
# carries, so a later change that undoes it fails the gate instead of shipping.


def ingest_failures(
    corpus: dict[str, Any] | None,
    blog: dict[str, Any] | None,
    blog_source_dir: Path = BLOG_DIR.parent,
) -> list[str]:
    failures = []
    if corpus is not None:
        # F18: Thingy's words never enter the corpus.
        if "from-thingy" in json.dumps(corpus, ensure_ascii=False):
            failures.append("a Thingy frame (from-thingy) reached the Weekly Thing corpus")
    if blog is not None:
        failures.extend(blog_source_failures(blog, blog_source_dir))
    for name, built in (("Weekly Thing", corpus), ("blog", blog)):
        if built is not None and (repeated := repeated_media(built)):
            failures.append(
                f"{len(repeated)} {name} media rows repeat an image in the same source "
                f"(M8), e.g. {repeated[:3]}"
            )
    return failures


def repeated_media(corpus: dict[str, Any]) -> list[str]:
    """QA3 M8: one media row per image per source, however often it shows."""
    seen, repeated = set(), []
    for item in corpus.get("media") or []:
        source = item.get("issue_number") or item.get("microblog_id") or item.get("page_id")
        key = (item.get("source_kind"), str(source), item.get("url"))
        if key in seen:
            repeated.append(f"{source}: {item.get('url')}")
        seen.add(key)
    return repeated


# An oracle over the blog's markdown, written apart from the build's own
# regexes so the two cannot share a mistake.
_FENCE_RE = re.compile(r"^[ \t]*(`{3,}|~{3,})")
_GATE_SHORTCODE_RE = re.compile(r"\{\{<\s*(x|tweet|youtube|vimeo)\s+([^>]*?)\s*>\}\}", re.I)
_GATE_IFRAME_SRC_RE = re.compile(r"""<iframe\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']""", re.I)
_GATE_STYLE_RE = re.compile(r"<style\b[^>]*>(.*?)</style\s*>", re.I | re.S)


def _fold(text: str) -> str:
    return " ".join(text.split())


def _source_post(path: Path) -> tuple[tuple[str, str], str] | None:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return None
    _, front, body = text.split("---", 2)
    fields = dict(
        line.split(":", 1) for line in front.splitlines() if ":" in line and line[:1].isalpha()
    )
    for name in ("microblog_id", "page_id"):
        value = fields.get(name, "").strip().strip("\"'")
        if value:
            return (name, value), body
    return None


def _code_lines(body: str) -> list[str]:
    lines, fence = [], None
    for line in body.splitlines():
        opener = _FENCE_RE.match(line)
        if fence is None:
            if opener:
                fence = opener.group(1)
        elif opener and opener.group(1)[0] == fence[0] and len(opener.group(1)) >= len(fence):
            fence = None
        elif len(line.strip()) >= 12:
            lines.append(_fold(line))
    return lines


def _embed_urls(body: str) -> list[str]:
    urls = [match.group(1) for match in _GATE_IFRAME_SRC_RE.finditer(body)]
    for match in _GATE_SHORTCODE_RE.finditer(body):
        name, args = match.group(1).lower(), match.group(2)
        named = dict(re.findall(r"""(\w+)=["']?([^"'\s]+)""", args))
        ident = named.get("id") or args.split()[0].strip("\"'")
        if name in {"x", "tweet"}:
            urls.append(f"/status/{ident}")
        elif name == "youtube":
            urls.append(f"v={ident}")
        else:
            urls.append(f"vimeo.com/{ident}")
    return urls


def blog_source_failures(blog: dict[str, Any], source_dir: Path) -> list[str]:
    """QA3 R2-6 and F16, against the blog's markdown: every fenced code line
    (12+ chars) is in its post's chunk text, every embedded tweet, video and
    iframe is one of its post's links, and no <style> rule is chunk text."""
    texts: dict[tuple[str, str], list[str]] = {}
    for chunk in blog.get("chunks") or []:
        key = (
            ("page_id", str(chunk["page_id"]))
            if chunk.get("page_id") is not None
            else ("microblog_id", str(chunk.get("microblog_id")))
        )
        texts.setdefault(key, []).append(chunk.get("text") or "")
    links: dict[tuple[str, str], list[str]] = {}
    for link in blog.get("links") or []:
        key = (
            ("page_id", str(link["page_id"]))
            if link.get("page_id") is not None
            else ("microblog_id", str(link.get("microblog_id")))
        )
        links.setdefault(key, []).append(link.get("url") or "")
    code_missing, embeds_missing, css_kept = [], [], []
    for path in sorted(source_dir.rglob("*.md")):
        post = _source_post(path)
        if post is None:
            continue
        key, body = post
        text = _fold("\n".join(texts.get(key, [])))
        code_missing += [f"{key[1]}: {line[:60]}" for line in _code_lines(body) if line not in text]
        urls = links.get(key, [])
        embeds_missing += [
            f"{key[1]}: {want}" for want in _embed_urls(body) if not any(want in u for u in urls)
        ]
        for style in _GATE_STYLE_RE.finditer(body):
            css_kept += [
                f"{key[1]}: {line[:60]}"
                for line in map(_fold, style.group(1).splitlines())
                if len(line) >= 12 and line in text
            ]
    failures = []
    for label, missing in (
        ("fenced code lines missing from blog chunk text", code_missing),
        ("embedded tweets, videos or iframes with no blog link", embeds_missing),
        ("<style> CSS kept as blog chunk text", css_kept),
    ):
        if missing:
            failures.append(f"{len(missing)} {label}, e.g. {missing[:3]}")
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
        corpus = load_json(candidate) if candidate.is_file() else None
        blog = load_json(blog_candidate) if blog_candidate.is_file() else None
        if corpus is None and blog is None:
            print(f"corpus gate: no Weekly Thing candidate at {candidate}; nothing to check")
            return 0
        failures = gate_failures(corpus, args.site_archive) if corpus is not None else []
        failures.extend(ingest_failures(corpus, blog))
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
