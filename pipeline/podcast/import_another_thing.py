"""Import Another Thing episode metadata + transcripts into Librarian data.

The Another site owns podcast authoring and publishing. Librarian owns the
corpus, so this importer copies a small normalized JSON record per
episode into ``data/podcast/another-thing/episodes``. The corpus builder reads
that stable local data instead of scraping the live site or coupling Thingy to
Another's Eleventy templates.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from librarian_core.paths import ANOTHER_THING_EPISODES_DIR, PODCAST_DIR

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.S)


def _split_frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    text = path.read_text(encoding="utf-8")
    match = FRONTMATTER_RE.match(text)
    if not match:
        raise RuntimeError(f"{path} is missing YAML front matter")
    metadata = yaml.safe_load(match.group(1)) or {}
    body = text[match.end() :].strip()
    return metadata, body


def _utc_date(value: Any) -> datetime:
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value or "").strip()
        if not text:
            raise RuntimeError("episode date is required")
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _episode_permalink(date: datetime, slug: str) -> str:
    return f"/{date:%Y/%m/%d}/{slug}.html"


def _audio_url(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.startswith(("http://", "https://")):
        return text
    return f"https://another.thingelstad.com/{text.lstrip('/')}"


def episode_record(path: Path, source_dir: Path) -> dict[str, Any]:
    metadata, notes_markdown = _split_frontmatter(path)
    number = metadata.get("number")
    if number is None:
        raise RuntimeError(f"{path} is missing episode number")
    date = _utc_date(metadata.get("date"))
    slug = str(metadata.get("slug") or re.sub(r"^\d+-", "", path.stem)).strip()
    permalink = str(metadata.get("permalink") or _episode_permalink(date, slug))
    if permalink.startswith("http"):
        url = permalink
    else:
        url = f"https://another.thingelstad.com{permalink}"
    transcript_text = ""
    transcript_file = str(metadata.get("transcript") or "").strip()
    if transcript_file:
        transcript_path = (source_dir / transcript_file).resolve()
        if transcript_path.exists():
            transcript_text = transcript_path.read_text(encoding="utf-8").strip()
    transcript_url = f"{url}#transcript" if transcript_text else None

    return {
        "id": path.stem,
        "show": "Another Thing",
        "source_kind": "podcast",
        "number": number,
        "title": str(metadata.get("title") or path.stem).strip(),
        "slug": slug,
        "publish_date": date.date().isoformat(),
        "published_at": date.isoformat().replace("+00:00", "Z"),
        "summary": str(metadata.get("summary") or "").strip(),
        "url": url,
        "guid": str(metadata.get("guid") or url).strip(),
        "audio_url": _audio_url(metadata.get("audio")),
        "transcript_url": transcript_url,
        "notes_markdown": notes_markdown,
        "transcript_text": transcript_text,
    }


def import_episodes(
    source_dir: Path = ANOTHER_THING_EPISODES_DIR, output_dir: Path = PODCAST_DIR
) -> list[Path]:
    if not source_dir.exists():
        raise RuntimeError(f"Another Thing episodes directory not found: {source_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    seen: set[str] = set()
    for path in sorted(source_dir.glob("*.md")):
        record = episode_record(path, source_dir)
        output_path = output_dir / f"{int(record['number']):03d}-{record['slug']}.json"
        output_path.write_text(
            json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        written.append(output_path)
        seen.add(output_path.name)
    for stale in output_dir.glob("*.json"):
        if stale.name not in seen:
            stale.unlink()
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=ANOTHER_THING_EPISODES_DIR)
    parser.add_argument("--output-dir", type=Path, default=PODCAST_DIR)
    args = parser.parse_args()

    written = import_episodes(args.source_dir, args.output_dir)
    print(f"Imported {len(written)} Another Thing episode(s) to {args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
