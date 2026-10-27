"""The freshness fact each corpus artifact carries as S3 metadata."""

import json
from pathlib import Path

from pipeline.deploy.corpus_fact import corpus_fact, fact_path, read_fact, write_fact

BUILT = "2026-10-26T20:12:37Z"


def test_weekly_corpus_names_its_newest_issue_by_number():
    fact = corpus_fact(
        "corpus.json",
        {
            "generated_at": BUILT,
            "issues": [
                {"number": 354, "publish_date": "2026-10-24T12:00:00Z", "subject": "WT354 — x"},
                {"number": 353, "publish_date": "2026-10-17T12:00:00Z"},
                {"number": 9, "publish_date": "2019-01-05T12:00:00Z"},
            ],
        },
    )
    assert fact == {
        "newest-id": "wt-354",
        "newest-at": "2026-10-24T12:00:00Z",
        "item-count": "3",
        "built-at": BUILT,
    }


def test_blog_corpus_names_its_newest_post_and_leaves_pages_out():
    fact = corpus_fact(
        "blog_corpus.json",
        {
            "generated_at": BUILT,
            "post_count": 2,
            "posts": [
                {
                    "microblog_id": "1",
                    "published": "2026-10-25T14:03:00Z",
                    "publish_date": "2026-10-25",
                },
                {
                    "microblog_id": "2",
                    "published": "2026-10-26T02:39:58Z",
                    "publish_date": "2026-10-25",
                },
                # A page's published is its last edit, so it never wins.
                {"page_id": "71862", "published": "2026-10-27T00:00:00Z"},
            ],
        },
    )
    assert fact["newest-id"] == "blog-2"
    assert fact["newest-at"] == "2026-10-26T02:39:58Z"
    assert fact["item-count"] == "2"


def test_podcast_and_links_and_reference_facts():
    podcast = corpus_fact(
        "podcast_corpus.json",
        {
            "generated_at": BUILT,
            "episodes": [
                {"number": 1, "publish_date": "2025-10-05"},
                {"number": 7, "publish_date": "2026-10-19"},
            ],
        },
    )
    assert (podcast["newest-id"], podcast["newest-at"], podcast["item-count"]) == (
        "ep-7",
        "2026-10-19",
        "2",
    )
    links = corpus_fact(
        "links_corpus.json",
        {
            "generated_at": BUILT,
            "chunks": [
                {"link_id": "aaaaaaaaaaaa", "published": "2026-10-20T01:00:00Z"},
                {"link_id": "bbbbbbbbbbbb", "published": "2026-10-26T01:00:00Z"},
            ],
        },
    )
    assert (links["newest-id"], links["newest-at"]) == ("link-bbbbbbbbbbbb", "2026-10-26T01:00:00Z")
    reference = corpus_fact("reference_corpus.json", {"generated_at": BUILT, "chunk_count": 41})
    assert reference == {"item-count": "41", "built-at": BUILT}
    assert corpus_fact("graph.json", {"nodes": []}) == {}


def test_an_empty_corpus_carries_only_its_count():
    assert corpus_fact("links_corpus.json", {"chunks": [], "missing": True}) == {"item-count": "0"}


def test_the_fact_rides_beside_the_staged_file(tmp_path: Path):
    staged = tmp_path / "corpus.json"
    staged.write_text("{}")
    assert fact_path(staged) == tmp_path / "corpus.fact.json"
    assert write_fact(staged, {}) is None
    assert read_fact(staged) == {}
    write_fact(staged, {"newest-id": "wt-354", "item-count": "354"})
    assert json.loads((tmp_path / "corpus.fact.json").read_text()) == {
        "item-count": "354",
        "newest-id": "wt-354",
    }
    assert read_fact(staged) == {"newest-id": "wt-354", "item-count": "354"}
