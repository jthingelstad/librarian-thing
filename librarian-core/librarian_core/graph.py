"""Build the offline archive graph from a corpus.

Derives per-issue entities (heuristic regex or Bedrock extraction), recurring
tropes, and similarity edges between issues from chunk-level embedding
averages. Consumed by Thingy's runtime, the upload pipeline, and any future
graph-aware tooling.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3

from .corpus import build_corpus
from .links import unlink

DEFAULT_MODEL = "us.anthropic.claude-sonnet-4-6"
# A name may wrap onto the next line but never crosses a blank line, and a
# clock's AM/PM is never its edge. A Journal time label ("Saturday @ 7:16
# PM") ran into the next paragraph or label, and QA round 2 (ingest I2-2)
# found "PM We" (69 issues), "PM Saturday" (54) and 25 more as topics with
# public pages; a heading also ran across a blank line into the label
# below it ("Journal Saturday").
_CLOCK_EDGE_RE = re.compile(r"^(?:AM|PM)\s|\s(?:AM|PM)$", re.I)
ENTITY_RE = re.compile(
    r"\b(?:[A-Z][A-Za-z0-9&'.-]+(?:(?:[^\S\n]*\n)?[^\S\n]+[A-Z][A-Za-z0-9&'.-]+|\n[A-Z][A-Za-z0-9&'.-]+){0,4})\b"
)
STOP_ENTITIES = {
    # Brand / template tokens (matched lowercase below)
    "weekly thing",
    "jamie",
    "the weekly thing",
    "thingy",
    "featured",
    "notable",
    "briefly",
    "journal",
    "currently",
    # English function words and sentence-starters that the regex
    # captures because they appear capitalized at the start of
    # sentences. None of these are real entities.
    "the",
    "this",
    "that",
    "these",
    "those",
    "there",
    "here",
    "and",
    "but",
    "or",
    "so",
    "if",
    "as",
    "of",
    "in",
    "on",
    "at",
    "for",
    "from",
    "with",
    "by",
    "to",
    "into",
    "onto",
    "i",
    "i've",
    "i'm",
    "i'd",
    "i'll",
    "we",
    "we've",
    "we're",
    "you",
    "you've",
    "you're",
    "they",
    "they've",
    "they're",
    "he",
    "she",
    "it",
    "them",
    "us",
    "our",
    "your",
    "their",
    "his",
    "her",
    "what",
    "when",
    "where",
    "why",
    "how",
    "who",
    "whom",
    "which",
    "now",
    "then",
    "today",
    "tomorrow",
    "yesterday",
    "first",
    "second",
    "third",
    "last",
    "next",
    "previous",
    "good",
    "great",
    "new",
    "best",
    "most",
    "more",
    "less",
    "all",
    "also",
    "some",
    "any",
    "every",
    "each",
    "many",
    "few",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "much",
    "such",
    "very",
    "even",
    "only",
    "still",
    "well",
    "back",
    "way",
    "ways",
    "lot",
    "lots",
    "interesting",
    "really",
    "quite",
    "hard",
    "easy",
    "long",
    "short",
    "old",
    "however",
    "moreover",
    "therefore",
    "thus",
    "hence",
    "furthermore",
    "instead",
    "indeed",
    "anyway",
    "anyhow",
    "besides",
    "yes",
    "no",
    "ok",
    "stop",
    "go",
    "do",
    "does",
    "did",
    "done",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "having",
    "can",
    "could",
    "should",
    "would",
    "will",
    "may",
    "might",
    "must",
    "found",
    "followed",
    "thought",
    "things",
    "thing",
    # Days / months — frequently capitalized but not topical entities
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "jan",
    "feb",
    "mar",
    "apr",
    "jun",
    "jul",
    "aug",
    "sep",
    "sept",
    "oct",
    "nov",
    "dec",
    "day",
    "days",
    "week",
    "weeks",
    "month",
    "months",
    "year",
    "years",
}
TROPE_KEYWORDS = {
    "open web and ownership": {
        "rss",
        "blog",
        "blogs",
        "website",
        "web",
        "open web",
        "feed",
        "feeds",
        "domain",
    },
    "agency over convenience": {
        "privacy",
        "control",
        "convenience",
        "surveillance",
        "lock-in",
        "algorithm",
    },
    "tools for thought": {
        "obsidian",
        "notes",
        "knowledge",
        "workflow",
        "productivity",
        "omnifocus",
    },
    "local community": {"minneapolis", "minnesota", "community", "event", "meetup"},
    "ai as collaborator": {"ai", "agent", "agents", "llm", "claude", "openai", "model"},
    "durable archives": {"archive", "links", "pinboard", "database", "memory"},
}


def load_corpus(path: Path) -> dict[str, Any]:
    if path.exists():
        corpus = json.loads(path.read_text(encoding="utf-8"))
        if any(issue.get("body") for issue in corpus.get("issues", [])):
            return corpus
        fresh = build_corpus(include_issue_bodies=True)
        if any(chunk.get("embedding") for chunk in corpus.get("chunks", [])):
            fresh["chunks"] = corpus.get("chunks", [])
            fresh["embedding_model"] = corpus.get("embedding_model")
            fresh["embedding_dimensions"] = corpus.get("embedding_dimensions")
        return fresh
    return build_corpus(include_issue_bodies=True)


# What is not the issue's words: HTML tags, bare and autolinked URLs. Link
# and image markup becomes its label first (``unlink``). Until QA 2026-09-30
# (ingest F13) the entity regex read URLs too, so a signed image URL's
# "AWSAccessKeyId", "Expires" and "AKIA...&Signature" were entities of
# WT3-21, and "following&tab" of WT193.
_NOT_WORDS_RE = re.compile(r"<[^>]*>|<?https?://\S+|\bwww\.\S+", re.I)


def entity_text(markdown: str) -> str:
    """``markdown`` as its words, for entity and trope extraction."""
    return _NOT_WORDS_RE.sub(" ", unlink(markdown))


def clean_entity(value: str) -> str:
    value = " ".join(value.strip(" .,:;!?()[]{}").split())
    return value


# Entities, tropes and the Bedrock extraction read the whole issue and all
# its links. Until QA 2026-09-30 (ingest F14) they read the first 14,000,
# 20,000 and 18,000 characters and 24 links, which left 28.8% of Weekly
# Thing text unread: 1,675 names that occur twice or more only past the cut
# in 225 issues (Big Green Egg in WT9, MNUFC in WT19) were in no entity.
def entity_counts(issue: dict[str, Any], link_weight: int = 2) -> dict[str, int]:
    """Every name in the issue with its count; a linked domain counts
    ``link_weight`` a link (2 when ranking an issue's names)."""
    text = " ".join(
        [
            str(issue.get("subject") or ""),
            " ".join(str(link.get("text") or "") for link in issue.get("links", [])),
            entity_text(str(issue.get("body") or "")),
        ]
    )
    counts: dict[str, int] = {}
    for match in ENTITY_RE.finditer(text):
        entity = clean_entity(match.group(0))
        if (
            len(entity) < 3
            or entity.lower() in STOP_ENTITIES
            or entity.lower().startswith("weekly thing")
            or _CLOCK_EDGE_RE.search(entity)
        ):
            continue
        if entity.isupper() and len(entity) <= 2:
            continue
        counts[entity] = counts.get(entity, 0) + 1
    for link in issue.get("links", []) or []:
        domain = str(link.get("domain") or "").removeprefix("www.")
        if domain:
            counts[domain] = counts.get(domain, 0) + link_weight
    return counts


def heuristic_entities(issue: dict[str, Any], limit: int = 40) -> list[str]:
    counts = entity_counts(issue)
    return [
        entity for entity, _ in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:limit]
    ]


def named_twice(issue: dict[str, Any]) -> set[str]:
    """The lowercase names an issue names twice or more, uncapped. A link is
    one naming of its domain here: a domain linked once is named once."""
    lowered: dict[str, int] = {}
    for entity, count in entity_counts(issue, link_weight=1).items():
        lowered[entity.lower()] = lowered.get(entity.lower(), 0) + count
    return {key for key, count in lowered.items() if count >= 2}


# A name's issue list is uncapped (every issue that names it twice) once 3
# issues file it. Which of those names are site topics is site_topics().
TOPIC_MIN_ISSUES = 3

# The site's topics (weekly.thingelstad.com topic pages, list_topics) are
# for people, so they are tidier than the graph's names (Jamie, 2026-10-26:
# "be ever more tidy and conservative with topics"). Google left most of the
# 777 topic pages unindexed, and they held words like "Find", "Okay" and
# "Few Thoughts", and twins like The Verge and theverge.com. The graph
# carries the result as "topics", and the site and the Lambda read it
# rather than each deriving topics from entity_index.
SITE_TOPIC_MIN_ISSUES = 5
# A word the archive mostly writes in lowercase is a word, not a name
# ("people", "find"). One mostly capitalized only at the start of a
# sentence is a sentence opener ("Thanks", "Maybe", "Introducing").
SITE_TOPIC_MAX_LOWERCASE = 0.5
SITE_TOPIC_MIN_MID_SENTENCE = 0.3
# Fragments of longer names, and titles, that pass both tests.
SITE_TOPIC_NOT_NAMES = {
    "pro",
    "max",
    "plus",
    "series",
    "review",
    "edition",
    "ceo",
    "ceos",
    "cto",
    "url",
    "don",
    "university",
    "lessons",
    "weeklything",
}
# Sites that are where a link lives, not what the issue is about, and
# Jamie's own.
SITE_TOPIC_NOT_DOMAINS = {
    "en.wikipedia.org",
    "linkedin.com",
    "youtube.com",
    "github.com",
    "medium.com",
    "twitter.com",
    "reddit.com",
    "apps.apple.com",
    "itunes.apple.com",
    "apple.com",
    "web.archive.org",
    "archive.org",
    "amazon.com",
    "goodreads.com",
    "imdb.com",
    "rottentomatoes.com",
    "buttondown.email",
    "app.ens.domains",
    "app.poap.xyz",
    "collectors.poap.xyz",
    "members.onepeloton.com",
    "world.hey.com",
    "blog.google",
}
# One topic under several names.
SITE_TOPIC_ALIASES = {
    "mnufc": "minnesota united",
    "mn united": "minnesota united",
    "covid": "covid-19",
    "coronavirus": "covid-19",
    "apple watch series": "apple watch",
    "nytimes.com": "the new york times",
    "startribune.com": "star tribune",
}


def site_topic_slug(name: str) -> str:
    """The topic page slug; the same as the site's slugify (topics.js)."""
    lowered = re.sub(r"['‘’]", "", str(name).lower())
    return re.sub(r"[^a-z0-9]+", "-", lowered).strip("-")


def _is_own_domain(key: str) -> bool:
    return key == "thingelstad.com" or key.endswith(".thingelstad.com")


def _is_domain(key: str) -> bool:
    return " " not in key and re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", key) is not None


def _twin_key(key: str) -> str:
    """What makes two names one topic: no leading "the", no possessive, no
    punctuation ("The Verge", "the verge", "Apple's")."""
    key = re.sub(r"^the\s+", "", key)
    key = re.sub(r"['’]s$", "", key)
    return re.sub(r"[^a-z0-9]", "", key)


def _domain_twin_keys(domain: str) -> list[str]:
    """The twin keys a domain's name could have: theverge.com is "theverge"
    or "verge" ("The Verge"). A subdomain other than blog. or m. is its own
    site and has none."""
    if domain in SITE_TOPIC_ALIASES:
        return [_twin_key(SITE_TOPIC_ALIASES[domain])]
    parts = domain.removeprefix("www.").split(".")
    if len(parts) > 2 and parts[0] in {"blog", "m"}:
        parts = parts[1:]
    if len(parts) != 2:
        return []
    key = _twin_key(parts[0])
    return [key, key.removeprefix("the")] if key.startswith("the") else [key]


class _Capitalization:
    """How the archive writes each word and phrase."""

    _WORD_RE = re.compile(r"(?<![\w'’])[A-Za-z][A-Za-z0-9'’-]*")

    def __init__(self, corpus_issues: list[dict[str, Any]]):
        self.text = "\n".join(
            f"{issue.get('subject') or ''}\n{entity_text(str(issue.get('body') or ''))}"
            for issue in corpus_issues
        )
        self.total: dict[str, int] = {}
        self.lower: dict[str, int] = {}
        self.capital: dict[str, int] = {}
        self.mid_sentence: dict[str, int] = {}
        for match in self._WORD_RE.finditer(self.text):
            word = match.group(0)
            key = word.lower()
            self.total[key] = self.total.get(key, 0) + 1
            if word == key:
                self.lower[key] = self.lower.get(key, 0) + 1
                continue
            self.capital[key] = self.capital.get(key, 0) + 1
            before = self.text[max(0, match.start() - 3) : match.start()]
            if re.search(r"[a-z0-9,;:)]\s{1,2}$", before):
                self.mid_sentence[key] = self.mid_sentence.get(key, 0) + 1

    def lowercase_share(self, key: str) -> float:
        if " " not in key and key in self.total:
            return self.lower.get(key, 0) / self.total[key]
        pattern = re.compile(r"(?<![\w'’])" + re.escape(key) + r"(?![\w'’])", re.I)
        found = [match.group(0) for match in pattern.finditer(self.text)]
        return sum(1 for text in found if text == text.lower()) / len(found) if found else 0.0

    def mid_sentence_share(self, key: str) -> float:
        capital = self.capital.get(key, 0)
        return self.mid_sentence.get(key, 0) / capital if capital else 1.0


def site_topics(
    corpus_issues: list[dict[str, Any]],
    issues: dict[str, dict[str, Any]],
    entity_index: dict[str, list[str]],
) -> list[dict[str, Any]]:
    """The site's topics: names (not words) filed by TOPIC_MIN_ISSUES issues,
    twins folded into one, kept at SITE_TOPIC_MIN_ISSUES issues. Each is
    {slug, name, keys, issues}: keys are the entity_index keys it folds,
    which map an issue's entities onto its topics."""
    capitalization = _Capitalization(corpus_issues)
    candidates = {
        key: numbers for key, numbers in entity_index.items() if len(numbers) >= TOPIC_MIN_ISSUES
    }
    groups: dict[str, list[str]] = {}
    domains = sorted(key for key in candidates if _is_domain(key))
    # A name a linked site goes by is a name, however the archive writes it:
    # Wired and TechCrunch mostly open a line, as a link's source.
    site_names = {
        twin
        for domain in domains
        if domain not in SITE_TOPIC_NOT_DOMAINS
        for twin in _domain_twin_keys(domain)
    }
    for key in candidates:
        if _is_domain(key):
            continue
        if key in SITE_TOPIC_NOT_NAMES or key.removesuffix("s") in SITE_TOPIC_NOT_NAMES:
            continue
        # An alias is a name by decision; the tests would drop MNUFC, which
        # mostly opens a line.
        if (
            key not in SITE_TOPIC_ALIASES
            and _twin_key(key) not in site_names
            and (
                capitalization.lowercase_share(key) >= SITE_TOPIC_MAX_LOWERCASE
                or (
                    " " not in key
                    and capitalization.mid_sentence_share(key) < SITE_TOPIC_MIN_MID_SENTENCE
                )
            )
        ):
            continue
        twin = _twin_key(SITE_TOPIC_ALIASES.get(key, key))
        if twin:
            groups.setdefault(twin, []).append(key)
    # A plural folds into its singular (NFTs, NFT).
    for twin in sorted(groups):
        singular = twin.removesuffix("s")
        if singular != twin and singular in groups:
            groups[singular] += groups.pop(twin)
    for domain in domains:
        if domain in SITE_TOPIC_NOT_DOMAINS or _is_own_domain(domain):
            continue
        twin = next((key for key in _domain_twin_keys(domain) if key in groups), None)
        groups.setdefault(twin or _twin_key(domain), []).append(domain)

    # The most frequent spelling across the issues' entities names a topic.
    spellings: dict[str, dict[str, int]] = {}
    for entry in issues.values():
        for entity in entry.get("entities", []):
            bucket = spellings.setdefault(str(entity).lower(), {})
            bucket[str(entity)] = bucket.get(str(entity), 0) + 1

    def display(key: str) -> str:
        bucket = spellings.get(key)
        return max(sorted(bucket.items()), key=lambda item: item[1])[0] if bucket else key

    topics: dict[str, dict[str, Any]] = {}
    for keys in groups.values():
        numbers: set[str] = set()
        for key in keys:
            numbers.update(str(number) for number in candidates[key])
        if len(numbers) < SITE_TOPIC_MIN_ISSUES:
            continue
        # An alias's target, then a name before a domain, then the key with
        # the most issues.
        lead = min(
            keys,
            key=lambda key: (
                key in SITE_TOPIC_ALIASES,
                _is_domain(key),
                -len(candidates[key]),
                key,
            ),
        )
        name = display(lead)
        slug = site_topic_slug(name)
        if not slug:
            continue
        if slug in topics:
            topics[slug]["keys"] = sorted(set(topics[slug]["keys"]) | set(keys))
            numbers |= set(topics[slug]["issues"])
        else:
            topics[slug] = {"slug": slug, "name": name, "keys": sorted(keys)}
        topics[slug]["issues"] = sorted(numbers, key=_issue_sort_key)
    return sorted(topics.values(), key=lambda topic: (-len(topic["issues"]), topic["name"].lower()))


def _issue_sort_key(number: str) -> tuple[float, str]:
    try:
        return (float(number.split("-")[0]), number)
    except ValueError:
        return (math.inf, number)


def heuristic_tropes(issue: dict[str, Any]) -> list[str]:
    text = f"{issue.get('subject', '')} {entity_text(issue.get('body', ''))}".lower()
    result = []
    for trope, keywords in TROPE_KEYWORDS.items():
        score = sum(1 for keyword in keywords if keyword in text)
        if score >= 2:
            result.append(trope)
    return result


def issue_vectors(corpus: dict[str, Any]) -> dict[str, list[float]]:
    sums: dict[str, list[float]] = {}
    counts: dict[str, int] = {}
    for chunk in corpus.get("chunks", []):
        embedding = chunk.get("embedding")
        # Site-page and FAQ chunks carry no issue number; bucketing them under
        # "None" made a phantom issue that could surface as a similar issue.
        if not embedding or chunk.get("issue_number") in (None, ""):
            continue
        issue = str(chunk.get("issue_number"))
        if issue not in sums:
            sums[issue] = [0.0] * len(embedding)
        for index, value in enumerate(embedding):
            sums[issue][index] += float(value)
        counts[issue] = counts.get(issue, 0) + 1
    return {
        issue: [value / max(counts.get(issue, 1), 1) for value in vector]
        for issue, vector in sums.items()
    }


def cosine(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    return dot / (left_norm * right_norm) if left_norm and right_norm else 0.0


def similarity_edges(corpus: dict[str, Any], top_k: int = 6) -> dict[str, list[dict[str, Any]]]:
    vectors = issue_vectors(corpus)
    edges: dict[str, list[dict[str, Any]]] = {}
    for issue, vector in vectors.items():
        scored = [
            {"number": other, "score": round(cosine(vector, other_vector), 4)}
            for other, other_vector in vectors.items()
            if other != issue
        ]
        scored.sort(key=lambda item: item["score"], reverse=True)
        edges[issue] = scored[:top_k]
    return edges


def extract_with_bedrock(issue: dict[str, Any], model: str) -> dict[str, list[str]]:
    body = str(issue.get("body") or "")
    prompt = (
        "Extract archive metadata from this Weekly Thing issue. Return only JSON with keys "
        "entities and tropes. entities should include people, companies, products, places, and projects. "
        "tropes should be recurring stances or themes expressed in plain noun phrases.\n\n"
        f"Issue #{issue.get('number')}: {issue.get('subject')}\nDate: {issue.get('publish_date')}\n\n{body}"
    )
    response = boto3.client("bedrock-runtime").converse(
        modelId=model,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        inferenceConfig={"maxTokens": 900, "temperature": 0.1},
    )
    text = "\n".join(
        block.get("text", "")
        for block in response.get("output", {}).get("message", {}).get("content", [])
        if "text" in block
    )
    match = re.search(r"\{.*\}", text, re.S)
    data = json.loads(match.group(0) if match else text)
    return {
        "entities": [
            clean_entity(str(item)) for item in data.get("entities", []) if str(item).strip()
        ][:50],
        "tropes": [
            clean_entity(str(item)).lower() for item in data.get("tropes", []) if str(item).strip()
        ][:20],
    }


def build_graph(
    corpus: dict[str, Any], *, use_bedrock: bool = False, model: str = DEFAULT_MODEL
) -> dict[str, Any]:
    similarities = similarity_edges(corpus)
    issues: dict[str, dict[str, Any]] = {}
    entity_index: dict[str, list[str]] = {}
    trope_index: dict[str, list[str]] = {}
    twice: dict[str, set[str]] = {}
    for issue in corpus.get("issues", []):
        number = str(issue.get("number"))
        twice[number] = named_twice(issue)
        if use_bedrock:
            try:
                extracted = extract_with_bedrock(issue, model)
            except Exception as exc:
                print(
                    f"Bedrock extraction failed for #{number}: {type(exc).__name__}; using heuristics"
                )
                extracted = {
                    "entities": heuristic_entities(issue),
                    "tropes": heuristic_tropes(issue),
                }
        else:
            extracted = {"entities": heuristic_entities(issue), "tropes": heuristic_tropes(issue)}
        issues[number] = {
            "entities": extracted["entities"],
            "tropes": extracted["tropes"],
            "similar_issues": similarities.get(number, []),
        }
        # Once per issue: "Micro.blog" the name and micro.blog the domain
        # are one key, which listed WT255 twice (QA 2026-09-30, ingest F13).
        for key in dict.fromkeys(entity.lower() for entity in extracted["entities"]):
            entity_index.setdefault(key, []).append(number)
        for key in dict.fromkeys(trope.lower() for trope in extracted["tropes"]):
            trope_index.setdefault(key, []).append(number)
    # A topic's issues are every issue that names it twice or more, not only
    # the issues whose 40 most-extracted names hold it (Jamie, 2026-10-01,
    # QA2 Q18): 351 of 352 issues fill the 40, so Tesla counted 14 issues
    # against the 25 that name it twice. Which names are topics stays the
    # 40-name rule: uncapped, 1,000 more names (mostly domains linked once in
    # three issues) would pass 3 issues and each get a public topic page.
    for key, numbers in entity_index.items():
        if len(numbers) < TOPIC_MIN_ISSUES:
            continue
        filed = set(numbers)
        entity_index[key] = [n for n in twice if n in filed or key in twice[n]]
    return {
        "version": 1,
        "source": "data/librarian/corpus.json",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "extraction_model": model if use_bedrock else "heuristic",
        "issue_count": len(issues),
        "issues": issues,
        "entity_index": entity_index,
        # Marks a graph whose topic issue lists are uncapped (list_topics
        # stops calling its counts a top-40 sample).
        "entity_index_uncapped": True,
        "trope_index": trope_index,
        "topics": site_topics(corpus.get("issues", []), issues, entity_index),
    }
