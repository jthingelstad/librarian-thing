#!/usr/bin/env python3
"""
The look-at-them pass: vision descriptions for the archive's images.

The corpus has always been text ABOUT images — regex-extracted alt (92%
empty on the Weekly Thing side) and the nearest caption line. No model had
ever seen a pixel. This job describes every unique image URL with Claude
Haiku vision and stores the results in a sidecar keyed by URL:

    data/librarian/media-descriptions.json

The corpus build merges a matching description into each media entry (see
librarian_core/corpus.py), which media_search then matches and returns.
Descriptions are machine metadata, clearly separated from Jamie's authored
alt and captions — they never overwrite either.

Resumable: the sidecar is flushed incrementally and existing keys are
skipped, so re-running after new content only pays for new images. A
permanent per-URL failure is recorded with an `error` so it is not retried
forever; delete its entry to retry.

    uv run --locked python pipeline/corpus/describe_media.py --dry-run
    uv run --locked python pipeline/corpus/describe_media.py
    uv run --locked python pipeline/corpus/describe_media.py --limit 20
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import anthropic
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
SIDECAR = ROOT / "data" / "librarian" / "media-descriptions.json"
CORPUS = ROOT / "data" / "librarian" / "corpus.json"
BLOG_POSTS = ROOT / "data" / "blog" / "posts"

MODEL = "claude-haiku-4-5"
CONCURRENCY = 8

# Only hosts the archive actually serves images from (parity with the
# Lambda's photo-view allowlist). Anything else in old markup is a stray.
ALLOWED_HOSTS = (
    "thingelstad.com",
    "cdn.uploads.micro.blog",
    "assets.buttondown.email",
    "buttondown-attachments.s3.us-west-2.amazonaws.com",
)

IMG_TAG_RE = re.compile(r"<img\b[^>]*\bsrc=[\"']([^\"']+)[\"'][^>]*>", re.I)
MD_IMG_RE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)[^)]*\)")

PROMPT = (
    "Describe this photo in one or two sentences (at most 30 words) for a "
    "search index: name the visible subjects, setting, activity, and any "
    "notable text in the image. Factual only - no speculation about "
    "identities or feelings. Plain prose only: no headings, no markdown, "
    "no preamble."
)


def allowed(url: str) -> bool:
    if not url.startswith("https://"):
        return False
    host = url.split("/", 3)[2].lower()
    return host.endswith(ALLOWED_HOSTS[0]) or host in ALLOWED_HOSTS


def collect_urls() -> list[str]:
    urls: dict[str, None] = {}
    corpus = json.loads(CORPUS.read_text())
    for media in corpus.get("media", []):
        url = str(media.get("url") or "")
        if allowed(url):
            urls.setdefault(url)
    for post in BLOG_POSTS.rglob("*.md"):
        text = post.read_text(errors="ignore")
        for match in IMG_TAG_RE.findall(text):
            if allowed(match):
                urls.setdefault(match)
        for match in MD_IMG_RE.findall(text):
            if allowed(match):
                urls.setdefault(match)
    return list(urls)


def describe(client: anthropic.Anthropic, url: str) -> dict:
    response = client.messages.create(
        model=MODEL,
        max_tokens=120,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "url", "url": url}},
                    {"type": "text", "text": PROMPT},
                ],
            }
        ],
    )
    text = " ".join(
        block.text.strip() for block in response.content if block.type == "text"
    ).strip()
    # Defense in depth: strip any markdown heading the model slips in.
    text = re.sub(r"^#+\s*[^\n]*\n+", "", text).replace("\n", " ").strip()
    if not text:
        raise ValueError("empty description")
    return {
        "description": text,
        "model": MODEL,
        "described_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")
    api_key = os.environ.get("ANTHROPIC_GENERAL_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    if not args.dry_run and not api_key:
        print("no ANTHROPIC_GENERAL_API_KEY / ANTHROPIC_API_KEY", file=sys.stderr)
        return 1

    sidecar: dict[str, dict] = {}
    if SIDECAR.exists():
        sidecar = json.loads(SIDECAR.read_text())

    urls = collect_urls()
    pending = [u for u in urls if u not in sidecar]
    if args.limit:
        pending = pending[: args.limit]
    print(f"images: {len(urls)} unique | in sidecar: {len(sidecar)} | to do: {len(pending)}")
    if args.dry_run or not pending:
        return 0

    client = anthropic.Anthropic(api_key=api_key)
    lock = threading.Lock()
    done = 0
    flushed = time.monotonic()

    def flush() -> None:
        SIDECAR.write_text(json.dumps(sidecar, indent=1, sort_keys=True) + "\n")

    def work(url: str) -> None:
        nonlocal done, flushed
        try:
            entry = describe(client, url)
        except anthropic.RateLimitError:
            raise  # let the retry pass below pick these up
        except anthropic.APIStatusError as error:
            if error.status_code >= 500:
                raise
            # 4xx: the URL itself is bad for the API (dead image, unfetchable).
            entry = {"error": f"api_{error.status_code}", "model": MODEL}
        except anthropic.APIConnectionError:
            raise
        except Exception as error:  # noqa: BLE001 - record and move on
            entry = {"error": type(error).__name__, "model": MODEL}
        with lock:
            sidecar[url] = entry
            done += 1
            if done % 25 == 0 or time.monotonic() - flushed > 30:
                flush()
                flushed = time.monotonic()
                print(f"  {done}/{len(pending)}")

    # Two passes: the second retries anything a transient failure skipped.
    for attempt in (1, 2):
        todo = [u for u in pending if u not in sidecar]
        if not todo:
            break
        with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
            futures = {pool.submit(work, u): u for u in todo}
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception as error:  # noqa: BLE001 - transient; next pass retries
                    if attempt == 2:
                        with lock:
                            sidecar.setdefault(futures[future], {"error": type(error).__name__, "model": MODEL})
        flush()

    described = sum(1 for v in sidecar.values() if "description" in v)
    failed = sum(1 for v in sidecar.values() if "error" in v)
    print(f"done: {described} described, {failed} failed, sidecar {SIDECAR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
