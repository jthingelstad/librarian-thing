"""The blog round's guards, in code rather than only in the agent's prompt
(docs/PLAN-2026-10-22-blog-steward.md, "Guards").

Pure functions over category lists and post bodies, so the round and its
tests share them:

- names compare by slug ("Pokémon" is ``pokemon``), so a spelling never
  makes a twin, and lists compare as sets (micro.blog reorders them);
- the Weekly Thing category is WT Builder's: never added or removed;
- Book and Travel Log are retired and never come back; no category is ever
  removed from a post the Librarian has not filed;
- an alt edit changes only one empty alt and leaves every other byte alone,
  and never turns an ``<img>`` into markdown;
- pace caps of 50 category writes and 20 alt edits a day, a ``PAUSED`` file
  that stops the round, and a switch that turns every write off.
"""

from __future__ import annotations

import difflib
import html
import re
import unicodedata
from pathlib import Path

# Plan step 5 ("Writes on") turned this on, on Jamie's go (2026-10-22). Set
# False, --write refuses and the round only proposes; a PAUSED file stops the
# whole round without a commit.
WRITES_ON = True
PAUSE_FILE = Path(__file__).with_name("PAUSED")

CATEGORY_CAP = 50
ALT_CAP = 20

WEEKLY_THING = "weekly-thing"
FEATURED = "featured"
RETIRED = frozenset({"book", "travel-log"})
# Seven posts share an address with an earlier post, so Micropub reaches the
# other one; Jamie sets these by hand (2026-10-22: "Don't treat them as drift").
SHARED_ADDRESS = frozenset(
    f"blog-{n}" for n in (377970, 1074798, 1074800, 1074801, 1075452, 1076156, 1076174)
)

# Order on a post: trip, series, project, topics, kept; Featured last. The
# theme's "Keep going" takes the first category with an earlier titled post.
KIND_ORDER = {"trip": 0, "series": 1, "project": 2, "topic": 3, "kept": 4, "featured": 5}

# Characters an alt may not carry: they would break the attribute or the
# markdown image around it.
_ALT_FORBIDDEN = re.compile(r"[\"<>&\[\]\n\r]")
_IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)
_ALT_ATTR_RE = re.compile(r"""\balt\s*=\s*(["'])(.*?)\1""", re.IGNORECASE | re.DOTALL)
_SRC_ATTR_RE = re.compile(r"""\bsrc\s*=\s*(["'])(.*?)\1""", re.IGNORECASE | re.DOTALL)
_MD_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(\s*<?([^)\s>]+)[^)]*\)")


class RoundStop(RuntimeError):
    """The round stops here: paused, writes off, or past a pace cap."""


def slug(name: str) -> str:
    """The slug a category name compares by: accents dropped, then every run
    of other characters a hyphen (the catalog's slugs)."""
    plain = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-")


def slugs(names: list[str]) -> set[str]:
    return {slug(name) for name in names}


def same_set(a: list[str], b: list[str]) -> bool:
    return slugs(a) == slugs(b)


def check_running(*, writing: bool) -> None:
    """Raise RoundStop when the round may not run (PAUSED) or may not write."""
    if PAUSE_FILE.exists():
        raise RoundStop(f"PAUSED: {PAUSE_FILE} exists; remove it to run the round")
    if writing and not WRITES_ON:
        raise RoundStop("writes are off (guards.WRITES_ON): the round only proposes")


def target_categories(
    live: list[str],
    picks: list[str],
    kinds: dict[str, str],
) -> list[str]:
    """The list to write to a post the Librarian has not filed before: its
    picks plus every category already on it, in the catalog's order. Nothing
    on the post is removed; Weekly Thing and Featured are never added; a
    retired name is never written. ``kinds`` maps slug to catalog kind."""
    out: list[tuple[int, int, str]] = []
    seen: set[str] = set()
    for position, name in enumerate(picks):
        key = slug(name)
        if key in seen or key in RETIRED or key in (WEEKLY_THING, FEATURED):
            continue
        seen.add(key)
        out.append((KIND_ORDER.get(kinds.get(key, "kept"), 4), position, name))
    for position, name in enumerate(live, start=len(picks)):
        key = slug(name)
        if key in seen:
            continue
        seen.add(key)
        out.append((KIND_ORDER.get(kinds.get(key, "kept"), 4), position, name))
    return [name for _group, _position, name in sorted(out)]


def check_target(live: list[str], target: list[str]) -> str | None:
    """Why ``target`` may not replace ``live``, or None when it may."""
    if not target:
        return "the list would be empty"
    if not slugs(live) <= slugs(target):
        return "it would remove a category from the post"
    if (WEEKLY_THING in slugs(live)) != (WEEKLY_THING in slugs(target)):
        return "it would change the Weekly Thing category, which is WT Builder's"
    if slugs(target) & RETIRED:
        return "it would bring back a retired category"
    return None


def twin_of(name: str, existing: list[str]) -> str | None:
    """The existing category a proposed new one would be a twin of, if any:
    the same slug, the same slug but for a plural or a number, or one so
    close a reader would take them for one. The same place in another year
    is a new trip (North Shore 2024, North Shore 2025), not a twin."""
    key = slug(name)

    def stem(value: str) -> str:
        return re.sub(r"s$", "", re.sub(r"[-\d]+", "", value))

    def years(value: str) -> set[str]:
        return set(re.findall(r"(?:19|20)\d\d", value))

    for other in existing:
        other_key = slug(other)
        if key == other_key:
            return other
        if years(key) and years(other_key) and years(key) != years(other_key):
            continue
        if stem(key) and stem(key) == stem(other_key):
            return other
        if difflib.SequenceMatcher(None, key, other_key).ratio() >= 0.9:
            return other
    return None


def check_new_name(name: str, existing: list[str]) -> str | None:
    """Why a proposed category name may not be made, or None."""
    if not name.strip():
        return "the name is empty"
    if "/" in name:
        return 'a "/" in a name becomes a subfolder in Hugo'
    if slug(name) in RETIRED:
        return f"{name} is retired"
    twin = twin_of(name, existing)
    if twin:
        return f"it would be a twin of {twin}"
    return None


def check_alt(alt: str) -> str | None:
    """Why ``alt`` may not be written, or None."""
    if not alt.strip():
        return "the alt is empty"
    if _ALT_FORBIDDEN.search(alt):
        return "the alt carries a character that would break the image markup"
    return None


def _with_alt(tag: str, alt: str) -> str:
    match = _ALT_ATTR_RE.search(tag)
    if match:
        quote = match.group(1)
        return tag[: match.start()] + f"alt={quote}{alt}{quote}" + tag[match.end() :]
    src = _SRC_ATTR_RE.search(tag)
    return tag[: src.end()] + f' alt="{alt}"' + tag[src.end() :]


def splice_alt(content: str, src: str, alt: str) -> tuple[str | None, str]:
    """``content`` with ``alt`` filled into the one empty-alt image whose
    source is ``src``, and a note. Returns ``(None, why)`` when there is not
    exactly one such image (already filled, gone, or shown twice) or the
    result would change anything but that alt."""
    problem = check_alt(alt)
    if problem:
        return None, problem
    spots: list[tuple[int, int, str]] = []
    for match in _IMG_TAG_RE.finditer(content):
        tag = match.group(0)
        found = _SRC_ATTR_RE.search(tag)
        if not found or html.unescape(found.group(2)) != src:
            continue
        current = _ALT_ATTR_RE.search(tag)
        if current is None or not current.group(2).strip():
            spots.append((match.start(), match.end(), _with_alt(tag, alt)))
    for match in _MD_IMAGE_RE.finditer(content):
        if match.group(2) == src and not match.group(1).strip():
            start = match.start() + 2
            spots.append((start, start + len(match.group(1)), alt))
    if not spots:
        return None, "no empty alt on that image any more"
    if len(spots) > 1:
        return None, "the image is in the post more than once"
    start, end, replacement = spots[0]
    edited = content[:start] + replacement + content[end:]
    return (edited, "ok") if only_alt_changed(content, edited, alt) else (None, "edit not clean")


def only_alt_changed(before: str, after: str, alt: str) -> bool:
    """True when ``after`` is ``before`` with one alt added and nothing else:
    the same images, still in their own form, and every other byte alike."""
    if len(_IMG_TAG_RE.findall(before)) != len(_IMG_TAG_RE.findall(after)):
        return False
    if len(_MD_IMAGE_RE.findall(before)) != len(_MD_IMAGE_RE.findall(after)):
        return False
    matcher = difflib.SequenceMatcher(None, before, after, autojunk=False)
    changes = [op for op in matcher.get_opcodes() if op[0] != "equal"]
    added = "".join(after[j1:j2] for _tag, _i1, _i2, j1, j2 in changes)
    removed = "".join(before[i1:i2] for _tag, i1, i2, _j1, _j2 in changes)
    return not removed.strip() and alt in added and len(added) <= len(alt) + len(' alt=""')
