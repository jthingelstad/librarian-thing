"""similar_posts: each blog post's nearest posts by meaning (related_posts.py).

The candidates Thingy chooses its related-post suggestions from
(docs/PLAN-2026-11-01-related-posts.md). Vectors here are hand-made so each
rule is visible: same-trip posts left out, one post a trip, the floor, pages
out, diversity over a series.
"""

from __future__ import annotations

import math

from librarian_core.related_posts import annotate_similar_posts, trip_categories


def unit(*values: float) -> list[float]:
    norm = math.sqrt(sum(value * value for value in values))
    return [value / norm for value in values]


def corpus(posts: list[tuple[int, str, list[str], list[list[float]]]]) -> dict:
    """posts: (microblog_id, post_kind, categories, chunk embeddings)."""
    records, chunks = [], []
    for microblog_id, kind, categories, embeddings in posts:
        key = "page_id" if kind == "page" else "microblog_id"
        records.append({key: microblog_id, "post_kind": kind, "categories": categories})
        for at, embedding in enumerate(embeddings):
            chunks.append(
                {key: microblog_id, "id": f"blog:{microblog_id}:{at}", "embedding": embedding}
            )
    return {"posts": records, "chunks": chunks, "post_count": len(records)}


def picks(data: dict, microblog_id: int) -> list[int]:
    post = next(p for p in data["posts"] if p.get("microblog_id") == microblog_id)
    return [item["microblog_id"] for item in post.get("similar_posts", [])]


def test_trip_categories_are_the_ones_naming_a_year():
    assert trip_categories(["Travel", "Arizona 2021", "Outdoors"]) == {"Arizona 2021"}
    assert trip_categories(["Texas Hellweek 2001", "Europe 2004"]) == {
        "Texas Hellweek 2001",
        "Europe 2004",
    }
    assert trip_categories(["Kubb"]) == frozenset()
    assert trip_categories(None) == frozenset()


def test_nearest_first_self_and_pages_left_out():
    data = corpus(
        [
            (1, "post", [], [unit(1, 0, 0)]),
            (2, "micropost", [], [unit(1, 0.2, 0)]),
            (3, "post", [], [unit(1, 0.6, 0)]),
            (4, "page", [], [unit(1, 0.01, 0)]),
        ]
    )
    assert annotate_similar_posts(data, lam=1.0) == 3
    assert picks(data, 1) == [2, 3]
    page = next(p for p in data["posts"] if p.get("page_id") == 4)
    assert "similar_posts" not in page
    first = data["posts"][0]["similar_posts"][0]
    assert set(first) == {"microblog_id", "score"}
    assert 0.97 < first["score"] <= 1


def test_vector_is_the_mean_of_the_post_chunks():
    data = corpus(
        [
            (1, "post", [], [unit(1, 0, 0), unit(0, 1, 0)]),
            (2, "post", [], [unit(1, 1, 0)]),
            (3, "post", [], [unit(1, 0, 0)]),
        ]
    )
    annotate_similar_posts(data, lam=1.0)
    assert picks(data, 1)[0] == 2


def test_same_trip_left_out_and_one_post_from_each_other_trip():
    data = corpus(
        [
            (1, "post", ["Arizona 2021"], [unit(1, 0, 0)]),
            (2, "post", ["Arizona 2021"], [unit(1, 0.05, 0)]),
            (3, "post", ["Europe 2004"], [unit(1, 0.1, 0)]),
            (4, "post", ["Europe 2004"], [unit(1, 0.15, 0)]),
            (5, "post", ["Hiking"], [unit(1, 0.3, 0)]),
        ]
    )
    annotate_similar_posts(data, lam=1.0)
    assert picks(data, 1) == [3, 5]


def test_floor_drops_the_unrelated_and_a_post_with_none_has_no_field():
    data = corpus(
        [
            (1, "post", [], [unit(1, 0, 0)]),
            (2, "post", [], [unit(1, 1, 0)]),
            (3, "post", [], [unit(0, 0, 1)]),
        ]
    )
    annotate_similar_posts(data, floor=0.5, lam=1.0)
    assert picks(data, 1) == [2]
    post = next(p for p in data["posts"] if p["microblog_id"] == 3)
    assert "similar_posts" not in post


def test_diversity_lets_a_different_post_past_a_series():
    # 2, 3 and 4 are one series, nearly identical; 5 is a little further
    # from the query but about something else.
    series = [unit(1, 0.30, 0.01 * n) for n in range(3)]
    data = corpus(
        [
            (1, "post", [], [unit(1, 0.25, 0.25)]),
            (2, "post", [], [series[0]]),
            (3, "post", [], [series[1]]),
            (4, "post", [], [series[2]]),
            (5, "post", [], [unit(1, 0, 0.6)]),
        ]
    )
    annotate_similar_posts(data, lam=1.0, limit=2)
    assert 5 not in picks(data, 1), "by score alone the series fills the list"
    annotate_similar_posts(data, lam=0.5, limit=2)
    assert picks(data, 1)[1] == 5


def test_limit_recipe_and_rebuild_replace_earlier_candidates():
    data = corpus([(n, "post", [], [unit(1, 0.01 * n, 0)]) for n in range(1, 15)])
    annotate_similar_posts(data, limit=4)
    assert len(picks(data, 1)) == 4
    assert data["similar_posts_recipe"]["limit"] == 4
    annotate_similar_posts(data, floor=1.01)
    assert all("similar_posts" not in post for post in data["posts"])
    assert data["similar_posts_recipe"]["version"] == 1


def test_a_post_with_no_embedded_chunk_takes_no_part():
    data = corpus([(1, "post", [], [unit(1, 0, 0)]), (2, "post", [], [unit(1, 0.1, 0)])])
    data["posts"].append({"microblog_id": 3, "post_kind": "post", "categories": []})
    data["chunks"].append({"microblog_id": 3, "id": "blog:3:0"})
    annotate_similar_posts(data)
    assert picks(data, 1) == [2]
    assert picks(data, 3) == []
