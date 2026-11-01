"""Build the meaning-retrieval eval set: questions with known answers.

The tool eval (``apps/librarian/lambda/scripts/eval-tools.mjs``) pins
invariants and known answers, and nearly all its queries share their key
words with the answer, so the lexical leg finds them and the semantic leg is
never measured. This set asks the questions keyword search cannot answer:

- ``paraphrase``: the passage's idea in other words. A question is refused
  when it reuses a word that is rare in the corpus (in under 2% of chunks)
  and appears anywhere in the target source, stems folded.
- ``tail``: a paraphrase about text past token 515 of a chunk whose embed
  input runs past Cohere Embed v3's 512-token cap, so v3 never saw it. The
  chunks are cut at 2,048 characters, so a tail is short (18 words at the
  median, often a link and its comment); a quote that is also in another
  chunk (the next one's overlap lead-in) is refused.
- ``direct``: the question a reader would type, names and all.

Every question carries an ``answer_quote`` copied from the passage and
checked here, so relevance is judged two ways that survive re-chunking: the
source (wt-N, blog post, page, link, document, thing, episode) and the span
(a returned chunk holds the quote).

Questions about the reference documents (``data/reference-unpublished``)
quote unpublished text, so they go to ``--private-out`` (under tmp/, which
git ignores) and never into this public repo.

    AWS_PROFILE=cloud-engineer uv run --locked python pipeline/eval/build_meaning_set.py \\
        --corpus-dir tmp/live

Calls Claude on Bedrock once a question (about 450 calls, roughly $5 on Sonnet 4.6); answers
are cached in ``--cache`` so a rerun costs nothing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import boto3
from librarian_core.corpus import _embed_header, _embed_input
from librarian_core.embed_tokens import embed_token_count
from librarian_core.paths import REPO

TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9'-]{1,}", re.I)
RARE_SHARE = 0.02
TAIL_FROM_TOKEN = 515
TAIL_MIN_TOKENS = 530
TAIL_MIN_WORDS = 12
MODEL = "us.anthropic.claude-sonnet-4-6"

CORPUS_FILES = {
    "weekly_thing": "corpus.json",
    "blog": "blog_corpus.json",
    "reference": "reference_corpus.json",
    "link": "links_corpus.json",
    "podcast": "podcast_corpus.json",
}

# How each corpus is searched in the eval: the way callers reach it.
RUNS = {
    "weekly_thing": {"scope": "weekly_thing"},
    "blog": {"scope": "blog"},
    "reference": {"scope": "weekly_thing"},
    "document": {"scope": "weekly_thing"},
    "link": {"scope": "weekly_thing", "sourceKinds": ["link"]},
    "podcast": {"scope": "podcast"},
}

# (paraphrase, tail, direct) per target group.
COUNTS = {
    "weekly_thing": (40, 30, 20),
    "blog": (40, 25, 20),
    "link": (30, 10, 20),
    "reference": (15, 10, 10),
    "document": (10, 5, 5),
    "podcast": (5, 0, 4),
}

# Weekly Thing sections a question is not asked of: Journal sections are
# copies of blog posts (the blog set covers them), and the rest are quotes,
# photos, sign-offs and boilerplate.
WT_SKIP_FAMILIES = {
    "Journal",
    "Fortune",
    "Photo",
    "Signature",
    "Support",
    "The end 🎬",
    "Currently",
}

SMALL_GROUPS = {"podcast", "document"}

IDENTITY_FIELDS = (
    "source_kind",
    "issue_number",
    "microblog_id",
    "post_id",
    "page_id",
    "doc_id",
    "link_id",
    "thing_id",
    "episode_number",
    "url",
    "subject",
    "publish_date",
)


def stem(word: str) -> str:
    word = word.lower().strip("'-")
    for suffix in ("'s", "ing", "ies", "ied", "es", "ed", "ly", "s"):
        if len(word) > len(suffix) + 3 and word.endswith(suffix):
            return word[: -len(suffix)]
    return word


def stems(text: str) -> set[str]:
    return {stem(match.group(0)) for match in TOKEN_RE.finditer(text or "")}


def chunk_terms(chunk: dict[str, Any]) -> str:
    # What the lexical leg indexes: subject, section and text.
    return " ".join(str(chunk.get(field) or "") for field in ("subject", "section", "text"))


def target_group(chunk: dict[str, Any], corpus: str) -> str:
    if corpus == "reference":
        return "document" if chunk.get("source_kind") == "document" else "reference"
    return corpus


def source_key(chunk: dict[str, Any]) -> str:
    kind = chunk.get("source_kind")
    if kind == "document":
        return f"document:{chunk.get('doc_id')}"
    if kind == "link":
        return f"link:{chunk.get('link_id')}"
    if kind == "thing":
        return f"thing:{chunk.get('thing_id')}"
    if kind in ("faq", "site_page"):
        return f"{kind}:{chunk.get('url')}:{chunk.get('subject')}"
    if kind == "blog":
        if chunk.get("page_id"):
            return f"page:{chunk['page_id']}"
        return f"blog:{chunk.get('microblog_id') or chunk.get('url')}"
    if kind == "podcast":
        return f"podcast:{chunk.get('episode_number') or chunk.get('url')}"
    return f"weekly_thing:{chunk.get('issue_number')}"


MARKDOWN_LINK_RE = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")


def normalize(text: str) -> str:
    """Text as compared for a quote: Markdown links reduced to their words,
    emphasis marks and curly quotes folded, whitespace and case ignored. The
    eval harness folds a returned chunk's text the same way."""
    text = MARKDOWN_LINK_RE.sub(r"\1", text or "")
    text = re.sub(r"[*_`#>]+", "", text)
    text = (
        text.replace("\u2019", "'")
        .replace("\u2018", "'")
        .replace("\u201c", '"')
        .replace("\u201d", '"')
    )
    return re.sub(r"\s+", " ", text).strip().lower()


class Corpora:
    def __init__(self, directory: Path):
        self.chunks: dict[str, list[dict[str, Any]]] = {}
        for corpus, name in CORPUS_FILES.items():
            path = directory / name
            if not path.exists():
                print(f"no {name} in {directory}; its questions are skipped")
                self.chunks[corpus] = []
                continue
            data = json.loads(path.read_text())
            self.chunks[corpus] = [
                {key: value for key, value in chunk.items() if key != "embedding"}
                for chunk in data.get("chunks") or []
            ]
        self.df: dict[str, Counter] = {}
        self.size: dict[str, int] = {}
        self.by_source: dict[str, list[dict[str, Any]]] = {}
        for corpus, chunks in self.chunks.items():
            counter: Counter = Counter()
            for chunk in chunks:
                counter.update(stems(chunk_terms(chunk)))
                self.by_source.setdefault(source_key(chunk), []).append(chunk)
            self.df[corpus] = counter
            self.size[corpus] = max(len(chunks), 1)

    def rare_shared(self, corpus: str, question: str, chunk: dict[str, Any]) -> list[str]:
        """Rare words the question shares with the chunk's whole source."""
        source_stems: set[str] = set()
        for sibling in self.by_source.get(source_key(chunk), [chunk]):
            source_stems |= stems(chunk_terms(sibling))
        # The reference base is searched beside the Weekly Thing corpus, so a
        # word is rare when it is rare in both.
        pools = ["weekly_thing", "reference"] if corpus == "reference" else [corpus]
        rare = []
        for word in stems(question) & source_stems:
            share = max(self.df[pool][word] / self.size[pool] for pool in pools)
            if share < RARE_SHARE:
                rare.append(word)
        return sorted(rare)

    def siblings(self, chunk: dict[str, Any]) -> list[dict[str, Any]]:
        return [
            sibling
            for sibling in self.by_source.get(source_key(chunk), [])
            if sibling.get("id") != chunk.get("id")
        ]

    def tail_span(self, chunk: dict[str, Any]) -> tuple[str, str] | None:
        """(head, tail): the embedded head and the longest run of the tail
        past it that is in no embedding at all."""
        split = tail_words(chunk)
        if not split:
            return None
        head, tail = split
        unique = uncovered_tail(tail, self.siblings(chunk))
        if len(unique) < TAIL_MIN_WORDS:
            return None
        return " ".join(head), " ".join(unique)

    def rare_in_chunk(self, corpus: str, chunk: dict[str, Any], limit: int = 120) -> list[str]:
        """The chunk's own rare words, rarest first, for the prompt's ban list."""
        pools = ["weekly_thing", "reference"] if corpus == "reference" else [corpus]
        words = []
        for match in TOKEN_RE.finditer(chunk_terms(chunk)):
            word = match.group(0).lower()
            share = max(self.df[pool][stem(word)] / self.size[pool] for pool in pools)
            if share < RARE_SHARE:
                words.append((share, word))
        seen: dict[str, None] = {}
        for _, word in sorted(words):
            seen.setdefault(word, None)
        return list(seen)[:limit]


def eligible(corpus: str, chunk: dict[str, Any], kind: str) -> bool:
    words = int(chunk.get("word_count") or 0)
    if corpus == "weekly_thing":
        if chunk.get("section_family") in WT_SKIP_FAMILIES:
            return False
    if corpus == "blog" and chunk.get("page_id"):
        return False
    if corpus == "link" and kind != "tail" and chunk.get("note_voice") not in ("jamie", "mixed"):
        # A title-only link has no idea to paraphrase.
        return False
    minimum = {"link": 30, "podcast": 60}.get(corpus, 60)
    return words >= minimum


SHINGLE = 8


def tail_words(chunk: dict[str, Any]) -> tuple[list[str], list[str]] | None:
    """(head words, tail words): the embed input up to token TAIL_FROM_TOKEN,
    and the words after it. A saved link's note is cut to the embedding's
    room before it is embedded, so its tail counts the cut text too."""
    full = "\n".join([*_embed_header(chunk), chunk.get("text") or ""])
    if embed_token_count(full) < TAIL_MIN_TOKENS:
        return None
    words = full.split(" ")
    low, high = 1, len(words)
    while low < high:
        middle = (low + high) // 2
        if embed_token_count(" ".join(words[:middle])) > TAIL_FROM_TOKEN:
            high = middle
        else:
            low = middle + 1
    return words[:low], words[low:]


def uncovered_tail(tail: list[str], siblings: list[dict[str, Any]]) -> list[str]:
    """The longest run of tail words that no other chunk of the source holds.
    Most of a chunk's tail is the next chunk's overlap lead-in, which that
    chunk embeds; a word is covered when an 8-word run around it is in a
    sibling's text."""
    others = " ".join(normalize(sibling.get("text") or "") for sibling in siblings)
    covered = [False] * len(tail)
    for start in range(0, max(len(tail) - SHINGLE + 1, 0)):
        if normalize(" ".join(tail[start : start + SHINGLE])) in others:
            for index in range(start, start + SHINGLE):
                covered[index] = True
    best: list[str] = []
    run: list[str] = []
    for word, hit in zip(tail, covered):
        if hit:
            run = []
            continue
        run.append(word)
        if len(run) > len(best):
            best = list(run)
    return best


PROMPTS = {
    "paraphrase": """You are writing test questions for a search engine over Jamie Thingelstad's archive: his newsletter The Weekly Thing, his blog, the links he has saved, his podcast, and pages about him.

Write ONE question someone might ask whose answer is in the passage below. Ask it the way a person who half-remembers the idea would: describe the idea in ordinary words of your own, as a reader would, not as the passage puts it. Do not name the source, the issue, the post or its title. Make it specific enough that this passage, not some other, answers it.

Never use any of these words, or any form of them: {banned}

Then copy answer_quote: 8 to 30 consecutive words copied exactly from the passage (not the header) that answer the question.

Reply with JSON only: {{"question": "...", "answer_quote": "..."}}

<passage>
{passage}
</passage>""",
    "tail": """You are writing test questions for a search engine over Jamie Thingelstad's archive: his newsletter The Weekly Thing, his blog, the links he has saved, his podcast, and pages about him.

Below is the start of a passage, for context, and then a part of its END. Write ONE question whose answer is in the END part only, never in the start. Ask it the way a person who half-remembers the idea would: in ordinary words of your own, not as the passage puts it. Do not name the source, the issue, the post or its title. Make it specific enough that this passage, not some other, answers it.

Never use any of these words, or any form of them: {banned}

Then copy answer_quote: 8 to 30 consecutive words copied exactly from the END part that answer the question.

Reply with JSON only: {{"question": "...", "answer_quote": "..."}}

<start>
{head}
</start>

<end>
{tail}
</end>""",
    "direct": """You are writing test questions for a search engine over Jamie Thingelstad's archive: his newsletter The Weekly Thing, his blog, the links he has saved, his podcast, and pages about him.

Write ONE question a reader might type to find what the passage below says. Write it naturally: names, places, products and terms from the passage are fine. Do not name the issue number, the post's title or the date. Make it specific enough that this passage, not some other, answers it.

Then copy answer_quote: 8 to 30 consecutive words copied exactly from the passage (not the header) that answer the question.

Reply with JSON only: {{"question": "...", "answer_quote": "..."}}

<passage>
{passage}
</passage>""",
}


class Writer:
    """Claude on Bedrock, behind a cache keyed on the prompt."""

    def __init__(self, cache_path: Path, model: str):
        self.cache_path = cache_path
        self.model = model
        self.cache: dict[str, dict[str, Any]] = {}
        if cache_path.exists():
            for line in cache_path.read_text().splitlines():
                if line.strip():
                    row = json.loads(line)
                    self.cache[row["key"]] = row
        self.client = boto3.client("bedrock-runtime", region_name="us-east-1")
        self.usage = Counter()
        self.lock = threading.Lock()

    def ask(self, prompt: str) -> dict[str, Any] | None:
        key = hashlib.sha256(f"{self.model}\0{prompt}".encode()).hexdigest()
        if key not in self.cache:
            response = self.client.converse(
                modelId=self.model,
                messages=[{"role": "user", "content": [{"text": prompt}]}],
                inferenceConfig={"maxTokens": 400, "temperature": 0.7},
            )
            text = response["output"]["message"]["content"][0]["text"]
            row = {"key": key, "text": text}
            with self.lock:
                self.usage.update(
                    {
                        "input": response["usage"]["inputTokens"],
                        "output": response["usage"]["outputTokens"],
                    }
                )
                self.cache[key] = row
                with self.cache_path.open("a") as handle:
                    handle.write(json.dumps(row) + "\n")
        text = self.cache[key]["text"]
        match = re.search(r"\{.*\}", text, re.S)
        if not match:
            return None
        try:
            parsed = json.loads(match.group(0))
        except json.JSONDecodeError:
            return None
        if not isinstance(parsed.get("question"), str) or not isinstance(
            parsed.get("answer_quote"), str
        ):
            return None
        return parsed

    def cost(self) -> float:
        return self.usage["input"] / 1e6 * 3.0 + self.usage["output"] / 1e6 * 15.0


def build_item(
    corpora: Corpora,
    writer: Writer,
    corpus: str,
    group: str,
    kind: str,
    chunk: dict[str, Any],
) -> tuple[dict[str, Any] | None, str]:
    passage = _embed_input(chunk)
    banned = ", ".join(corpora.rare_in_chunk(corpus, chunk)) or "(none)"
    if kind == "tail":
        span = corpora.tail_span(chunk)
        if not span:
            return None, "no tail"
        head, tail = span
        prompt = PROMPTS["tail"].format(banned=banned, head=head, tail=tail)
        quote_home = tail
    else:
        prompt = PROMPTS[kind].format(banned=banned, passage=passage)
        quote_home = chunk.get("text") or ""
    reason = "no answer"
    for attempt in range(2):
        answer = writer.ask(
            prompt if attempt == 0 else prompt + "\n\n(Second try: follow every rule.)"
        )
        if not answer:
            continue
        question = answer["question"].strip()
        quote = answer["answer_quote"].strip().strip('"')
        if normalize(quote) not in normalize(quote_home) or len(quote.split()) < 6:
            reason = "quote not in passage"
            continue
        if kind == "tail":
            head_text = span[0]
            if normalize(quote) in normalize(head_text):
                reason = "quote in the head"
                continue
            # The answer must be nowhere else in the source, or another
            # chunk's embedding can carry it.
            if any(
                normalize(quote) in normalize(sibling.get("text") or "")
                for sibling in corpora.siblings(chunk)
            ):
                reason = "quote in another chunk"
                continue
        shared = corpora.rare_shared(corpus, question, chunk)
        if kind != "direct" and shared:
            reason = f"shares rare words {shared}"
            continue
        item = {
            "corpus": group,
            "kind": kind,
            "question": question,
            "answer_quote": quote,
            "target": {field: chunk.get(field) for field in IDENTITY_FIELDS if chunk.get(field)},
            "target_chunk_id": chunk.get("id"),
            "target_source": source_key(chunk),
            "run": RUNS[group],
            "rare_shared": shared,
        }
        if kind == "tail":
            item["tail_from_token"] = TAIL_FROM_TOKEN
            item["embed_tokens"] = embed_token_count(passage)
            item["unembedded_words"] = len(span[1].split(" "))
        return item, "ok"
    return None, reason


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--corpus-dir", type=Path, default=REPO / "tmp" / "live")
    parser.add_argument(
        "--out",
        type=Path,
        default=REPO / "apps" / "librarian" / "lambda" / "eval" / "meaning-set.json",
    )
    parser.add_argument(
        "--private-out", type=Path, default=REPO / "tmp" / "eval" / "meaning-set-private.json"
    )
    parser.add_argument(
        "--cache", type=Path, default=REPO / "tmp" / "eval" / "meaning-gen-cache.jsonl"
    )
    parser.add_argument("--seed", type=int, default=20261101)
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--dry-run", action="store_true", help="count candidates; call nothing")
    parser.add_argument("--max-per-kind", type=int, help="cap each count (a smoke run)")
    args = parser.parse_args(argv)

    args.cache.parent.mkdir(parents=True, exist_ok=True)
    corpora = Corpora(args.corpus_dir)
    writer = Writer(args.cache, args.model)
    rng = random.Random(args.seed)
    public: list[dict[str, Any]] = []
    private: list[dict[str, Any]] = []
    refusals: Counter = Counter()
    used: set[str] = set()

    for corpus, chunks in corpora.chunks.items():
        groups = ["reference", "document"] if corpus == "reference" else [corpus]
        for group in groups:
            pool = [chunk for chunk in chunks if target_group(chunk, corpus) == group]
            for kind, wanted in zip(("paraphrase", "tail", "direct"), COUNTS[group]):
                if args.max_per_kind is not None:
                    wanted = min(wanted, args.max_per_kind)
                if not wanted:
                    continue
                candidates = [chunk for chunk in pool if eligible(corpus, chunk, kind)]
                if kind == "tail":
                    candidates = [chunk for chunk in candidates if corpora.tail_span(chunk)]
                rng.shuffle(candidates)
                print(f"{group} {kind}: {len(candidates)} candidates, want {wanted}")
                if args.dry_run:
                    continue
                # One question a source per kind keeps the set broad; the
                # podcast and the documents are a few sources, so one a chunk.
                distinct, seen_sources = [], set()
                for chunk in candidates:
                    marker = f"{kind}:{source_key(chunk)}"
                    if group in SMALL_GROUPS:
                        marker = f"{kind}:{chunk.get('id')}"
                    if marker not in used and marker not in seen_sources:
                        seen_sources.add(marker)
                        distinct.append(chunk)
                made, cursor = 0, 0
                with ThreadPoolExecutor(max_workers=8) as pool_:
                    while made < wanted and cursor < len(distinct):
                        window = distinct[cursor : cursor + max(8, int((wanted - made) * 1.5))]
                        cursor += len(window)
                        results = pool_.map(
                            lambda chunk: build_item(corpora, writer, corpus, group, kind, chunk),
                            window,
                        )
                        for chunk, (item, reason) in zip(window, results):
                            if not item:
                                refusals[f"{group}/{kind}: {reason.split(' [')[0]}"] += 1
                                continue
                            if made >= wanted:
                                continue
                            used.add(
                                f"{kind}:{chunk.get('id')}"
                                if group in SMALL_GROUPS
                                else f"{kind}:{source_key(chunk)}"
                            )
                            made += 1
                            (private if group == "document" else public).append(item)
                if made < wanted:
                    print(f"  only {made} of {wanted}")

    if args.dry_run:
        return 0
    for index, item in enumerate(public):
        item["id"] = f"m{index + 1:03d}"
    for index, item in enumerate(private):
        item["id"] = f"p{index + 1:03d}"
    header = {
        "about": "Meaning-retrieval eval set; built by pipeline/eval/build_meaning_set.py",
        "generator_model": args.model,
        "seed": args.seed,
        "rare_share": RARE_SHARE,
        "tail_from_token": TAIL_FROM_TOKEN,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps({**header, "items": public}, indent=1, ensure_ascii=False) + "\n"
    )
    args.private_out.parent.mkdir(parents=True, exist_ok=True)
    args.private_out.write_text(
        json.dumps({**header, "items": private}, indent=1, ensure_ascii=False) + "\n"
    )
    print(f"wrote {len(public)} public items to {args.out}")
    print(f"wrote {len(private)} private items to {args.private_out} (never commit)")
    print("refusals:", dict(refusals))
    print(f"Bedrock usage this run: {dict(writer.usage)}, about ${writer.cost():.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
