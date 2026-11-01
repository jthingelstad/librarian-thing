"""Thingy's related-post picks (pipeline/blog/thingy_related.py).

The model call is not exercised here; these pin what surrounds it: the post
text Thingy reads (chunks joined without their overlap), the prompt shape,
the input hash a re-run skips on, and the checks on Thingy's answer.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "pipeline" / "blog" / "thingy_related.py"

spec = importlib.util.spec_from_file_location("pipeline_blog_thingy_related", SCRIPT)
script = importlib.util.module_from_spec(spec)
spec.loader.exec_module(script)

WHY = "Nineteen years later Jamie is back in the Engadine, climbing to a hut."


def candidate(microblog_id: int) -> dict:
    return {
        "microblog_id": microblog_id,
        "url": f"https://www.thingelstad.com/{microblog_id}.html",
        "subject": f"Post {microblog_id}",
        "publish_date": "2023-07-17",
        "post_kind": "post",
        "categories": ["Outdoors"],
    }


def test_chunks_join_without_their_overlap():
    first = "Opening line.\n\nPhoto alt\n_Caption one._\n\nPhoto two\n_Caption two._"
    second = "_Caption one._\n\nPhoto two\n_Caption two._\n\nClosing line."
    joined = script.join_chunks([first, second])
    assert joined.count("Caption one") == 1
    assert joined.count("Caption two") == 1
    assert joined.startswith("Opening line.") and joined.endswith("Closing line.")


def test_chunks_with_no_overlap_keep_a_paragraph_break():
    assert script.join_chunks(["One.", "Two."]) == "One.\n\nTwo."


def test_post_texts_follow_chunk_order_and_ignore_pages():
    corpus = {
        "chunks": [
            {"microblog_id": 1, "text": "First."},
            {"page_id": 9, "text": "A page."},
            {"microblog_id": 1, "text": "Second."},
        ]
    }
    assert script.post_texts(corpus) == {1: "First.\n\nSecond."}


def test_prompt_numbers_the_candidates_and_keeps_generated_summaries_only():
    post = candidate(1) | {"subject": "Zuoz to Chamanna Des-Cha Hut"}
    found = candidate(2) | {"abstract": "A hike in Guarda.", "abstract_source": "generated"}
    own = candidate(3) | {"abstract": "Jamie's own words.", "abstract_source": "post"}
    texts = {1: "The post text.", 2: "Guarda text.", 3: "Third text."}
    prompt = script.build_prompt(post, [found, own], texts)
    assert prompt.startswith("<post>\nTitle: Zuoz to Chamanna Des-Cha Hut")
    assert '<candidate n="1">' in prompt and '<candidate n="2">' in prompt
    assert "Summary: A hike in Guarda." in prompt
    assert "Jamie's own words." not in prompt
    digest = script.input_hash(prompt, [found, own])
    assert digest == script.input_hash(prompt, [found, own])
    assert digest != script.input_hash(prompt + " ", [found, own])


def test_input_hash_follows_candidate_ids_urls_and_order():
    post, first, second = candidate(1), candidate(2), candidate(3)
    texts = {1: "Post.", 2: "Same words.", 3: "Same words."}
    prompt = script.build_prompt(post, [first, second], texts)
    digest = script.input_hash(prompt, [first, second])
    moved = first | {"url": "https://www.thingelstad.com/moved.html"}
    assert script.build_prompt(post, [moved, second], texts) == prompt
    assert script.input_hash(prompt, [moved, second]) != digest
    assert script.input_hash(prompt, [second, first]) != digest
    swapped = first | {"microblog_id": 99}
    assert script.input_hash(prompt, [swapped, second]) != digest


def test_validate_resolves_picks_and_refuses_bad_ones():
    candidates = [candidate(n) for n in (10, 20, 30, 40)]
    raw = {
        "picks": [
            {"candidate": 2, "why": WHY},
            {"candidate": 2, "why": WHY},
            {"candidate": 9, "why": WHY},
            {"candidate": 1, "why": "x"},
            {"candidate": 3, "why": WHY + " " + WHY},
            {"candidate": 4, "why": "  Jamie's   first   take on the  new screen, a week later.  "},
        ]
    }
    picks, notes = script.validate(raw, candidates)
    assert [pick["microblog_id"] for pick in picks] == [20, 40]
    assert picks[1]["why"] == "Jamie's first take on the new screen, a week later."
    assert picks[0]["url"] == "https://www.thingelstad.com/20.html"
    assert sum(note.startswith("dropped") for note in notes) == 4


def test_validate_flags_long_lines_and_exclamations_and_caps_at_three():
    candidates = [candidate(n) for n in (10, 20, 30, 40)]
    long_why = "Jamie " + "climbs " * 16
    raw = {
        "picks": [
            {"candidate": 1, "why": long_why.strip()},
            {"candidate": 2, "why": "Jamie reaches the summit of Black Elk Peak!"},
            {"candidate": 3, "why": WHY},
            {"candidate": 4, "why": WHY},
        ]
    }
    picks, notes = script.validate(raw, candidates)
    assert len(picks) == 3
    assert any("over 110" in note for note in notes)
    assert any("exclamation" in note for note in notes)
    assert any("kept the first 3" in note for note in notes)


def test_an_empty_answer_is_a_good_answer():
    assert script.validate({"picks": []}, [candidate(1)]) == ([], [])
