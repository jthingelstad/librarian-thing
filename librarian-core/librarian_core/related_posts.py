"""Related blog posts by meaning: each post's nearest other posts.

Thingy suggests related posts under each blog post (thing-hugo's panel, from
`data/related.json`). The Librarian ranks the candidates here; Thingy chooses
among them and says why. See docs/PLAN-2026-11-01-related-posts.md.

A post's vector is the mean of its chunk embeddings, normalised. For each post
and micropost (pages are undated reference and take no part):

- other posts from the same trip are left out (a trip is a category naming a
  year, "Arizona 2026"; the theme already links a trip's days);
- at most one post from each other trip;
- maximal marginal relevance over the POOL nearest, so the candidates are not
  one series ten times over;
- a cosine floor drops the plainly unrelated. Scores are not comparable across
  posts (a hike's best match scores about 0.50, a POAP claim's about 0.88), so
  the floor is low and judging what is good enough is Thingy's.

The result is `similar_posts: [{microblog_id, score}]` on each post record, in
pick order. Posts with no candidate above the floor carry none.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Any

import numpy as np

SIMILAR_POSTS_VERSION = 1
SIMILAR_POSTS_LIMIT = 10
# On Embed v4 at 1024 (2026-11-01): 0.4365 keeps the share of each post's ten
# nearest that 0.45 kept on v3 (95.7%), docs/PLAN-2026-11-01-embeddings.md.
SIMILAR_POSTS_FLOOR = 0.4365
SIMILAR_POSTS_POOL = 60
SIMILAR_POSTS_LAMBDA = 0.75

POST_KINDS = frozenset({"post", "micropost"})
TRIP_CATEGORY = re.compile(r"\b(?:19|20)\d\d\b")
BLOCK_ROWS = 1024
NEAR_SLACK = 256


def trip_categories(categories: Any) -> frozenset[str]:
    """The trip categories among a post's categories: those naming a year."""
    if not isinstance(categories, list):
        return frozenset()
    return frozenset(str(name) for name in categories if TRIP_CATEGORY.search(str(name)))


def post_vectors(corpus: dict[str, Any]) -> tuple[list[dict[str, Any]], np.ndarray]:
    """The posts that take part, and their normalised mean chunk embeddings."""
    posts: dict[int, dict[str, Any]] = {}
    for post in corpus.get("posts") or []:
        if post.get("post_kind") in POST_KINDS and post.get("microblog_id") is not None:
            posts[int(post["microblog_id"])] = post
    sums: dict[int, np.ndarray] = {}
    counts: Counter[int] = Counter()
    for chunk in corpus.get("chunks") or []:
        key = chunk.get("microblog_id")
        embedding = chunk.get("embedding")
        if key is None or not embedding or int(key) not in posts:
            continue
        vector = np.asarray(embedding, dtype=np.float32)
        key = int(key)
        sums[key] = vector if key not in sums else sums[key] + vector
        counts[key] += 1
    keys = [key for key in posts if key in sums]
    if not keys:
        return [], np.zeros((0, 0), dtype=np.float32)
    matrix = np.stack([sums[key] / counts[key] for key in keys])
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return [posts[key] for key in keys], matrix / norms


def _pick(
    query: int,
    scores: np.ndarray,
    matrix: np.ndarray,
    trips: list[frozenset[str]],
    *,
    limit: int,
    floor: float,
    pool: int,
    lam: float,
) -> list[tuple[int, float]]:
    own = trips[query]
    # The nearest few hundred (room for the post itself and its own trip's
    # days), nearest first; ties go to the earlier post so a rebuild picks
    # the same.
    near = min(len(scores), pool + NEAR_SLACK)
    top = np.argpartition(-scores, near - 1)[:near] if near < len(scores) else np.arange(near)
    order = top[np.lexsort((top, -scores[top]))]
    candidates: list[int] = []
    for index in order:
        index = int(index)
        if scores[index] < floor or len(candidates) >= pool:
            break
        if index == query or (own and own & trips[index]):
            continue
        candidates.append(index)
    if not candidates:
        return []
    vectors = matrix[candidates]
    between = vectors @ vectors.T
    relevance = scores[candidates]
    redundancy = np.zeros(len(candidates), dtype=np.float32)
    open_slots = np.ones(len(candidates), dtype=bool)
    used_trips: set[str] = set()
    chosen: list[tuple[int, float]] = []
    while open_slots.any() and len(chosen) < limit:
        value = np.where(open_slots, lam * relevance - (1 - lam) * redundancy, -np.inf)
        best = int(np.argmax(value))
        open_slots[best] = False
        trip = trips[candidates[best]]
        if trip & used_trips:
            continue
        used_trips |= trip
        chosen.append((candidates[best], float(relevance[best])))
        redundancy = np.maximum(redundancy, between[best])
    return chosen


def annotate_similar_posts(
    corpus: dict[str, Any],
    *,
    limit: int = SIMILAR_POSTS_LIMIT,
    floor: float = SIMILAR_POSTS_FLOOR,
    pool: int = SIMILAR_POSTS_POOL,
    lam: float = SIMILAR_POSTS_LAMBDA,
) -> int:
    """Set `similar_posts` on every post with candidates; return how many have them.

    Runs after embedding. Any earlier `similar_posts` is replaced, so a post
    that lost its candidates loses the field.
    """
    for post in corpus.get("posts") or []:
        post.pop("similar_posts", None)
    posts, matrix = post_vectors(corpus)
    corpus["similar_posts_recipe"] = {
        "version": SIMILAR_POSTS_VERSION,
        "limit": limit,
        "floor": floor,
        "pool": pool,
        "lambda": lam,
    }
    if len(posts) < 2:
        return 0
    trips = [trip_categories(post.get("categories")) for post in posts]
    annotated = 0
    for start in range(0, len(posts), BLOCK_ROWS):
        block = matrix[start : start + BLOCK_ROWS] @ matrix.T
        for offset, scores in enumerate(block):
            query = start + offset
            picks = _pick(
                query, scores, matrix, trips, limit=limit, floor=floor, pool=pool, lam=lam
            )
            if not picks:
                continue
            posts[query]["similar_posts"] = [
                {"microblog_id": int(posts[index]["microblog_id"]), "score": round(score, 4)}
                for index, score in picks
            ]
            annotated += 1
    return annotated
