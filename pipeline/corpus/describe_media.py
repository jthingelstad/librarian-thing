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

The normal pass hands the API each image by URL, and the API refuses large
or unusual files (a 7 MB TIFF served as image/jpeg, a HEIC) with a bare 400.
`--retry-errors` fetches each failed image itself, converts anything the API
won't take (HEIC, WebP, TIFF, longer than 1,568 px, over 5 MB) to JPEG, and
sends it inline. What still fails gets a precise error: fetch_404,
fetch_403, fetch_error, decode_error or api_400. Because nothing here sends
the API a URL, this mode also takes the images the normal pass never tried:
http:// ones (fetched over https first) and hosts outside the allowlist.
Their sidecar key stays the URL exactly as the corpus has it.

    uv run --locked python pipeline/corpus/describe_media.py --dry-run
    uv run --locked python pipeline/corpus/describe_media.py
    uv run --locked python pipeline/corpus/describe_media.py --limit 20
    uv run --locked python pipeline/corpus/describe_media.py --retry-errors --dry-run
    uv run --locked python pipeline/corpus/describe_media.py --retry-errors
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import anthropic
import requests
from dotenv import load_dotenv
from librarian_core.corpus import build_corpus, extract_video_posters

ROOT = Path(__file__).resolve().parents[2]
SIDECAR = ROOT / "data" / "librarian" / "media-descriptions.json"
BLOG_POSTS = ROOT / "data" / "blog" / "posts"

MODEL = "claude-haiku-4-5"
CONCURRENCY = 8

# What the API takes inline without complaint: these formats, at most this
# long on the long edge (it downsizes anything larger anyway) and this many
# bytes. Anything else is converted to JPEG first.
INLINE_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "GIF": "image/gif"}
MAX_EDGE = 1568
MAX_BYTES = 5 * 1024 * 1024
USER_AGENT = "librarian-thing describe_media (+https://weekly.thingelstad.com)"

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


def fetchable(url: str) -> bool:
    return url.startswith(("https://", "http://"))


def collect_urls(keep=allowed) -> list[str]:
    urls: dict[str, None] = {}
    # Weekly Thing media from a fresh build of data/issues, not the
    # gitignored data/librarian/corpus.json: that local artifact is only as
    # new as the last local build, and a stale one silently skipped every
    # issue since (WT350-351 went undescribed that way).
    for media in build_corpus().get("media", []):
        url = str(media.get("url") or "")
        if keep(url):
            urls.setdefault(url)
    for post in BLOG_POSTS.rglob("*.md"):
        text = post.read_text(errors="ignore")
        for match in IMG_TAG_RE.findall(text):
            if keep(match):
                urls.setdefault(match)
        for match in MD_IMG_RE.findall(text):
            if keep(match):
                urls.setdefault(match)
        # A video's poster still is a blog media record of its own (the
        # corpus build's extract_video_posters); collecting only <img> and
        # Markdown images left 108 of 110 undescribed (QA2 I2-5, 2026-10-01).
        for poster in extract_video_posters(text):
            if keep(poster["url"]):
                urls.setdefault(poster["url"])
    return list(urls)


class ImageFailure(Exception):
    """A failure recorded as the sidecar entry's error code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def fetch(url: str) -> bytes:
    """The image bytes. An http:// URL is tried over https first."""
    candidates = [url]
    if url.startswith("http://"):
        candidates.insert(0, "https://" + url[len("http://") :])
    code = "fetch_error"
    for candidate in candidates:
        try:
            response = requests.get(candidate, timeout=30, headers={"User-Agent": USER_AGENT})
        except requests.RequestException:
            continue
        if response.status_code == 200 and response.content:
            return response.content
        code = f"fetch_{response.status_code}"
    raise ImageFailure(code)


def prepare(data: bytes) -> tuple[str, bytes]:
    """(media type, bytes) the API takes inline: the original when it is
    already a small JPEG/PNG/GIF, otherwise a JPEG at most MAX_EDGE long."""
    from PIL import Image, ImageOps
    from pillow_heif import register_heif_opener

    register_heif_opener()
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as error:  # noqa: BLE001 - any decoder failure is the same verdict
        raise ImageFailure("decode_error") from error
    if image.format in INLINE_FORMATS and max(image.size) <= MAX_EDGE and len(data) <= MAX_BYTES:
        return INLINE_FORMATS[image.format], data
    image = ImageOps.exif_transpose(image)
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        flat = Image.new("RGB", image.size, "white")
        flat.paste(image, mask=image.getchannel("A"))
        image = flat
    else:
        image = image.convert("RGB")
    image.thumbnail((MAX_EDGE, MAX_EDGE))
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=85)
    return "image/jpeg", out.getvalue()


def inline_source(url: str) -> dict:
    media_type, data = prepare(fetch(url))
    return {
        "type": "base64",
        "media_type": media_type,
        "data": base64.b64encode(data).decode("ascii"),
    }


def describe(client: anthropic.Anthropic, url: str, source: dict | None = None) -> dict:
    response = client.messages.create(
        model=MODEL,
        max_tokens=120,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "image", "source": source or {"type": "url", "url": url}},
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
    parser.add_argument(
        "--retry-errors",
        action="store_true",
        help="fetch failed and never-tried images locally and send them inline",
    )
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")
    api_key = os.environ.get("ANTHROPIC_GENERAL_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    if not args.dry_run and not api_key:
        print("no ANTHROPIC_GENERAL_API_KEY / ANTHROPIC_API_KEY", file=sys.stderr)
        return 1

    sidecar: dict[str, dict] = {}
    if SIDECAR.exists():
        sidecar = json.loads(SIDECAR.read_text())

    if args.retry_errors:
        urls = collect_urls(keep=fetchable)
        pending = [u for u in urls if "description" not in sidecar.get(u, {})]
        retried = sum(1 for u in pending if u in sidecar)
        print(f"retry: {retried} failed before, {len(pending) - retried} never tried")
    else:
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
            if args.retry_errors:
                entry = describe(client, url, inline_source(url))
            else:
                entry = describe(client, url)
        except ImageFailure as failure:
            entry = {"error": failure.code, "model": MODEL}
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
            finished.add(url)
            done += 1
            if done % 25 == 0 or time.monotonic() - flushed > 30:
                flush()
                flushed = time.monotonic()
                print(f"  {done}/{len(pending)}")

    # Two passes: the second retries anything a transient failure skipped.
    finished: set[str] = set()
    for attempt in (1, 2):
        todo = [u for u in pending if u not in finished]
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
                            if futures[future] not in sidecar:
                                sidecar[futures[future]] = {
                                    "error": type(error).__name__,
                                    "model": MODEL,
                                }
        flush()

    described = sum(1 for v in sidecar.values() if "description" in v)
    failed = sum(1 for v in sidecar.values() if "error" in v)
    print(f"done: {described} described, {failed} failed, sidecar {SIDECAR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
