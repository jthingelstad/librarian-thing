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
def heuristic_entities(issue: dict[str, Any], limit: int = 40) -> list[str]:
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
            counts[domain] = counts.get(domain, 0) + 2
    return [
        entity for entity, _ in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:limit]
    ]


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
    for issue in corpus.get("issues", []):
        number = str(issue.get("number"))
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
    return {
        "version": 1,
        "source": "data/librarian/corpus.json",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "extraction_model": model if use_bedrock else "heuristic",
        "issue_count": len(issues),
        "issues": issues,
        "entity_index": entity_index,
        "trope_index": trope_index,
    }
