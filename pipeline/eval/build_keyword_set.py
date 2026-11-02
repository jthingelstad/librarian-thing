"""Build the keyword-retrieval eval set: what a reader types to find a thing.

The meaning set (``build_meaning_set.py``) asks the questions keyword search
cannot answer. This one asks the ones it should: a reader who remembers a
name, a few words of the wording, or a title. Every question is cut from the
archive by rule, with no model, so the set is free to rebuild and has no
opinion of its own. Each one is checked to lead to exactly one source in the
whole archive (all five corpora), so a hit is unambiguous:

- ``phrase``: four to six words of the passage's own wording, every one a
  common word (in at least 0.5% of sources), so no rare word carries it. Only
  word order and proximity can.
- ``quoted``: a phrase in double quotes, as a reader who knows the exact
  words types it.
- ``name``: a name (a word the archive capitalizes nine times in ten, in 2
  to 12 sources) and a word near it that is in at least 3 sources, so
  neither finds it alone; the pair is in no other source.
- ``inflected``: a name pair with the word's other form (session/sessions,
  company/companies), one the source never uses. Only stemming finds it.
- ``title``: the title of a post, a saved link, a section heading, a page.
- ``question``: a name pair inside the words a reader wraps around it ("what
  did Jamie write about ..."), which add noise and no signal.

Items share the meaning set's shape (``target_source``, ``answer_quote``,
``run``), so ``apps/librarian/lambda/scripts/eval-meaning.mjs`` scores them:

    node --max-old-space-size=12288 scripts/eval-meaning.mjs \\
        --corpus-dir ../../../tmp/live --label keyword-v3 --set eval/keyword-set.json

Questions about the reference documents quote unpublished text, so they go
to ``--private-out`` (under tmp/, which git ignores), as in the meaning set.

    uv run --locked python pipeline/eval/build_keyword_set.py --corpus-dir tmp/live
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_meaning_set as meaning  # noqa: E402
from librarian_core.paths import REPO  # noqa: E402

TOKEN_RE = meaning.TOKEN_RE
COMMON_SHARE = 0.005
NAME_SOURCES = (2, 12)
PAIR_WINDOW = 12
PAIR_MAX_SHARE = 0.05
PHRASE_WORDS = (4, 6)
PLAIN_RE = re.compile(r"^[a-z0-9' -]+$")
WORD_RE = re.compile(r"\b[A-Za-z][A-Za-z]{3,}\b")
NAME_CAPITALIZED = 0.85
NOT_NAMES = frozenset(
    """jamie thingelstad weekly thing january february march april june july august
    september october november december monday tuesday wednesday thursday friday
    saturday sunday""".split()
)

URL_WORDS = frozenset({"com", "www", "http", "https", "html", "org", "net"})

KINDS = ("phrase", "quoted", "name", "inflected", "title", "question")

# Per target group, in KINDS order.
COUNTS = {
    "weekly_thing": (10, 5, 10, 6, 8, 6),
    "blog": (10, 5, 10, 6, 8, 6),
    "link": (5, 3, 8, 4, 10, 5),
    "reference": (4, 2, 5, 2, 5, 3),
    "document": (3, 1, 3, 1, 2, 1),
    "podcast": (2, 1, 2, 0, 1, 1),
}

QUESTION_TEMPLATES = (
    "what did Jamie write about {name} and {word}",
    "Jamie on {name} {word}",
    "has Jamie ever mentioned {name} {word}?",
)

STOPWORDS = frozenset(
    """a about above after again all also am an and any are as at be because been
    before being but by can could did do does doing for from had has have having he
    her here him his how i if in into is it its just like me more most my no not now
    of off on once only or other our out over own same she should so some such than
    that the their them then there these they this those through to too under until
    up very was we were what when where which while who why will with would you your
    it's i'm i've don't that's""".split()
)


def flatten(chunk: dict[str, Any]) -> str:
    """What a keyword search sees of a chunk, folded the way the harness folds
    a returned chunk's text. Fields are kept apart so no phrase spans two."""
    return " | ".join(
        meaning.normalize(str(chunk.get(field) or "")) for field in ("subject", "section", "text")
    )


def inflect(word: str) -> str | None:
    """The word's other number: one plural or singular rule, or None."""
    if not word.isalpha() or len(word) < 4:
        return None
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    if word.endswith(("ss", "us", "is")):
        return None
    if word.endswith("s"):
        return word[:-1]
    if word.endswith("y") and word[-2] not in "aeiou":
        return word[:-1] + "ies"
    if word.endswith(("sh", "ch", "x", "z")):
        return word + "es"
    return word + "s"


class Archive:
    """Every source in the five corpora, as keyword search sees it."""

    def __init__(self, corpora: meaning.Corpora):
        self.corpora = corpora
        self.text: dict[str, str] = {}
        for chunks in corpora.chunks.values():
            for chunk in chunks:
                key = meaning.source_key(chunk)
                self.text[key] = self.text.get(key, "") + " || " + flatten(chunk)
        self.sources: dict[str, set[str]] = {}
        for key, text in self.text.items():
            for word in {match.group(0) for match in TOKEN_RE.finditer(text)}:
                self.sources.setdefault(word, set()).add(key)
        self.total = max(len(self.text), 1)
        # How often the archive capitalizes each word: a name is a word it
        # almost always does, wherever the word sits in a sentence.
        seen: dict[str, list[int]] = {}
        for chunks in corpora.chunks.values():
            for chunk in chunks:
                for match in WORD_RE.finditer(chunk.get("text") or ""):
                    word = match.group(0)
                    tally = seen.setdefault(word.lower(), [0, 0])
                    tally[0] += word[0].isupper()
                    tally[1] += 1
        self.names = {
            word
            for word, (upper, total) in seen.items()
            if total >= 3 and upper / total >= NAME_CAPITALIZED and word not in NOT_NAMES
        }

    def count(self, word: str) -> int:
        return len(self.sources.get(word.lower(), ()))

    def holding(self, words: list[str]) -> set[str]:
        """Sources holding every word."""
        sets = sorted((self.sources.get(word, set()) for word in words), key=len)
        if not sets:
            return set()
        found = set(sets[0])
        for other in sets[1:]:
            found &= other
        return found

    def holding_phrase(self, phrase: str, words: list[str]) -> set[str]:
        return {key for key in self.holding(words) if phrase in self.text[key]}


def target_fields(chunk: dict[str, Any]) -> dict[str, Any]:
    return {field: chunk[field] for field in meaning.IDENTITY_FIELDS if chunk.get(field)}


def make_item(group: str, kind: str, chunk: dict[str, Any], question: str, quote: str, **extra):
    return {
        "corpus": group,
        "kind": kind,
        "question": question,
        "answer_quote": quote,
        "target": target_fields(chunk),
        "target_chunk_id": chunk.get("id"),
        "target_source": meaning.source_key(chunk),
        "run": meaning.RUNS[group],
        **extra,
    }


def phrase_item(archive: Archive, group: str, chunk: dict[str, Any], rng: random.Random, kind: str):
    text = meaning.normalize(chunk.get("text") or "")
    tokens = list(TOKEN_RE.finditer(text))
    starts = list(range(len(tokens)))
    rng.shuffle(starts)
    floor = COMMON_SHARE * archive.total
    for start in starts[:60]:
        size = rng.randint(*PHRASE_WORDS)
        window = tokens[start : start + size]
        if len(window) < size:
            continue
        words = [match.group(0) for match in window]
        if words[0] in STOPWORDS or words[-1] in STOPWORDS:
            continue
        if sum(1 for word in words if word not in STOPWORDS and len(word) >= 4) < 2:
            continue
        if any(archive.count(word) < floor for word in words):
            continue
        phrase = text[window[0].start() : window[-1].end()]
        if not PLAIN_RE.match(phrase):
            continue
        # Not the tail of a host name or a path ("apple.com the shortcuts").
        before = text[window[0].start() - 1] if window[0].start() else " "
        after = text[window[-1].end()] if window[-1].end() < len(text) else " "
        if before in "./@" or after in "./@" or set(words) & URL_WORDS:
            continue
        if archive.holding_phrase(phrase, words) != {meaning.source_key(chunk)}:
            continue
        question = f'"{phrase}"' if kind == "quoted" else phrase
        return make_item(group, kind, chunk, question, phrase)
    return None


def name_pair(archive: Archive, chunk: dict[str, Any], rng: random.Random, inflected: bool):
    """(name, word, quote, typed word): a name and a nearby word that only
    this source holds together."""
    raw = chunk.get("text") or ""
    names = [match.group(0) for match in WORD_RE.finditer(raw)]
    names = [name for name in names if name[0].isupper() and name.lower() in archive.names]
    rng.shuffle(names)
    text = meaning.normalize(raw)
    tokens = list(TOKEN_RE.finditer(text))
    key = meaning.source_key(chunk)
    low, high = NAME_SOURCES
    tried: set[str] = set()
    for name in names:
        lowered = name.lower()
        if lowered in tried or lowered in STOPWORDS or not low <= archive.count(lowered) <= high:
            continue
        tried.add(lowered)
        places = [index for index, match in enumerate(tokens) if match.group(0) == lowered]
        for place in places:
            # The most distinctive word near the name first: the one a
            # reader remembers.
            near = sorted(
                range(max(place - PAIR_WINDOW, 0), min(place + PAIR_WINDOW + 1, len(tokens))),
                key=lambda index: (archive.count(tokens[index].group(0)), abs(index - place)),
            )
            for index in near:
                word = tokens[index].group(0)
                if index == place or word in STOPWORDS or len(word) < 4 or not word.isalpha():
                    continue
                if lowered in word or word in lowered or word in URL_WORDS:
                    continue
                if not 3 <= archive.count(word) <= archive.total * PAIR_MAX_SHARE:
                    continue
                typed = word
                if inflected:
                    typed = inflect(word)
                    if not typed or not archive.count(typed):
                        continue
                    if re.search(rf"\b{re.escape(typed)}\b", archive.text[key]):
                        continue
                if archive.holding([lowered, word]) != {key}:
                    continue
                first, last = sorted((place, index))
                quote = text[tokens[first].start() : tokens[last].end()]
                return name, word, quote, typed
    return None


def name_item(archive: Archive, group: str, chunk: dict[str, Any], rng: random.Random, kind: str):
    found = name_pair(archive, chunk, rng, inflected=kind == "inflected")
    if not found:
        return None
    name, word, quote, typed = found
    if kind == "question":
        template = QUESTION_TEMPLATES[rng.randrange(len(QUESTION_TEMPLATES))]
        question = template.format(name=name, word=typed)
    else:
        question = f"{name} {typed}"
    terms = {"name": name, "word": word}
    if typed != word:
        terms["typed"] = typed
    return make_item(group, kind, chunk, question, quote, terms=terms)


def title_of(group: str, chunk: dict[str, Any]) -> str | None:
    if group == "weekly_thing":
        title = chunk.get("section") or ""
        if title == chunk.get("section_family"):
            return None
    elif group == "blog":
        title = chunk.get("subject") or ""
        if chunk.get("section") == "Micropost" or title.endswith("…"):
            return None
    else:
        title = chunk.get("subject") or ""
    title = title.strip()
    return title if len(TOKEN_RE.findall(title)) >= 3 else None


def title_item(archive: Archive, group: str, chunk: dict[str, Any], rng: random.Random, kind: str):
    title = title_of(group, chunk)
    if not title:
        return None
    folded = meaning.normalize(title)
    words = TOKEN_RE.findall(folded)
    if archive.holding_phrase(folded, words) != {meaning.source_key(chunk)}:
        return None
    opening = meaning.normalize(chunk.get("text") or "").split(" ")[:8]
    if len(opening) < 4:
        return None
    return make_item(group, kind, chunk, title, " ".join(opening))


BUILDERS = {
    "phrase": phrase_item,
    "quoted": phrase_item,
    "name": name_item,
    "inflected": name_item,
    "question": name_item,
    "title": title_item,
}


def eligible(group: str, chunk: dict[str, Any]) -> bool:
    if group == "weekly_thing" and chunk.get("section_family") in meaning.WT_SKIP_FAMILIES:
        return False
    if group == "blog" and chunk.get("page_id"):
        return False
    return int(chunk.get("word_count") or 0) >= 20


def build(corpora: meaning.Corpora, seed: int) -> tuple[list[dict], list[dict]]:
    archive = Archive(corpora)
    rng = random.Random(seed)
    public: list[dict[str, Any]] = []
    private: list[dict[str, Any]] = []
    for corpus, chunks in corpora.chunks.items():
        groups: dict[str, list[dict[str, Any]]] = {}
        for chunk in chunks:
            group = meaning.target_group(chunk, corpus)
            if eligible(group, chunk):
                groups.setdefault(group, []).append(chunk)
        for group, pool in groups.items():
            pool = sorted(pool, key=lambda chunk: str(chunk.get("id")))
            rng.shuffle(pool)
            used: set[str] = set()
            for kind, wanted in zip(KINDS, COUNTS[group]):
                made = 0
                if group in meaning.SMALL_GROUPS:
                    # A few sources: each may serve once a kind.
                    used = set()
                for chunk in pool:
                    if made >= wanted:
                        break
                    key = meaning.source_key(chunk)
                    if key in used:
                        continue
                    item = BUILDERS[kind](archive, group, chunk, rng, kind)
                    if not item:
                        continue
                    if item["answer_quote"] not in meaning.normalize(chunk.get("text") or ""):
                        raise AssertionError(f"{item['question']!r}: quote not in its chunk")
                    used.add(key)
                    (private if group == "document" else public).append(item)
                    made += 1
                if made < wanted:
                    print(f"{group} {kind}: {made} of {wanted}")
    for prefix, items in (("k", public), ("kp", private)):
        for index, item in enumerate(items, 1):
            item["id"] = f"{prefix}{index:03d}"
    return public, private


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--corpus-dir", type=Path, default=REPO / "tmp" / "live")
    parser.add_argument(
        "--out", type=Path, default=REPO / "apps/librarian/lambda/eval/keyword-set.json"
    )
    parser.add_argument(
        "--private-out", type=Path, default=REPO / "tmp" / "eval" / "keyword-set-private.json"
    )
    parser.add_argument("--seed", type=int, default=20261102)
    args = parser.parse_args(argv)

    corpora = meaning.Corpora(args.corpus_dir)
    public, private = build(corpora, args.seed)
    header = {
        "about": "Keyword-retrieval eval set; built by pipeline/eval/build_keyword_set.py",
        "seed": args.seed,
        "common_share": COMMON_SHARE,
        "name_sources": list(NAME_SOURCES),
    }
    args.out.write_text(
        json.dumps({**header, "items": public}, indent=1, ensure_ascii=False) + "\n"
    )
    args.private_out.parent.mkdir(parents=True, exist_ok=True)
    args.private_out.write_text(
        json.dumps({**header, "items": private}, indent=1, ensure_ascii=False) + "\n"
    )
    print(f"wrote {len(public)} public items to {args.out}")
    print(f"wrote {len(private)} private items to {args.private_out} (never commit)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
