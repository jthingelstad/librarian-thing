"""Thingy's related-post picks (pipeline/blog/thingy_related.py).

The model call is not exercised here; these pin what surrounds it: the post
text Thingy reads (chunks joined without their overlap), the prompt shape,
the input hash a re-run skips on, and the checks on Thingy's answer.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

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
    digest = script.input_hash(prompt, [found, own], "claude-sonnet-5-5")
    assert digest == script.input_hash(prompt, [found, own], "claude-sonnet-5-5")
    assert digest != script.input_hash(prompt + " ", [found, own], "claude-sonnet-5-5")


def test_input_hash_follows_candidate_ids_urls_and_order():
    post, first, second = candidate(1), candidate(2), candidate(3)
    texts = {1: "Post.", 2: "Same words.", 3: "Same words."}
    prompt = script.build_prompt(post, [first, second], texts)
    digest = script.input_hash(prompt, [first, second], "claude-sonnet-5-5")
    moved = first | {"url": "https://www.thingelstad.com/moved.html"}
    assert script.build_prompt(post, [moved, second], texts) == prompt
    assert script.input_hash(prompt, [moved, second], "claude-sonnet-5-5") != digest
    assert script.input_hash(prompt, [second, first], "claude-sonnet-5-5") != digest
    swapped = first | {"microblog_id": 99}
    assert script.input_hash(prompt, [swapped, second], "claude-sonnet-5-5") != digest
    assert script.input_hash(prompt, [first, second], "claude-opus-5-5") != digest


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
    long_why = "Jamie " + "climbs " * 16 + "high."
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


class FakeBatches:
    """The Message Batches calls run_batch makes, answering every request."""

    def __init__(self, answers: dict[str, dict]):
        self.answers = answers
        self.created: list[list[str]] = []
        self.runaway: set[str] = set()

    def create(self, *, requests):
        self.created.append([request["custom_id"] for request in requests])
        return SimpleNamespace(id=f"batch-{len(self.created)}")

    def retrieve(self, batch_id):
        counts = SimpleNamespace(processing=0, succeeded=1, errored=0, expired=0, canceled=0)
        return SimpleNamespace(processing_status="ended", request_counts=counts)

    def results(self, batch_id):
        for custom_id in self.created[int(batch_id.split("-")[1]) - 1]:
            text = json.dumps(self.answers[custom_id])
            message = SimpleNamespace(
                stop_reason="max_tokens" if custom_id in self.runaway else "end_turn",
                content=[SimpleNamespace(type="text", text=text)],
                usage=SimpleNamespace(
                    input_tokens=10,
                    output_tokens=5,
                    cache_read_input_tokens=0,
                    cache_creation_input_tokens=0,
                ),
            )
            yield SimpleNamespace(
                custom_id=custom_id, result=SimpleNamespace(type="succeeded", message=message)
            )


class Saved(dict):
    flushes = 0

    def __call__(self, microblog_id, entry, *, write=True):
        self[microblog_id] = entry

    def flush(self):
        self.flushes += 1


def jobs_for(ids):
    jobs = []
    for microblog_id in ids:
        cands = [candidate(microblog_id * 10)]
        seen = (f"Date: 2023-01-01\nText:\nPost {microblog_id}.", [f"Text:\n{WHY}"])
        jobs.append((microblog_id, cands, f"prompt {microblog_id}", f"hash-{microblog_id}", seen))
    return jobs


def test_a_batch_run_goes_in_parts_and_saves_each_part(tmp_path, monkeypatch):
    monkeypatch.setattr(script, "BATCH_REQUESTS", 2)
    jobs = jobs_for([1, 2, 3])
    answers = {
        f"mb-{n}": {"picks": [{"candidate": 1, "evidence": WHY[:40], "why": WHY}]}
        for n in (1, 2, 3)
    }
    batches = FakeBatches(answers)
    client = SimpleNamespace(messages=SimpleNamespace(batches=batches))
    saved, state = Saved(), tmp_path / "out.batch.json"
    usage = script.Usage()
    failures = script.run_batch(client, jobs, usage, "claude-sonnet-5-5", saved, state, 0)
    assert failures == 0
    assert batches.created == [["mb-1", "mb-2"], ["mb-3"]]
    assert sorted(saved) == [1, 2, 3] and saved.flushes == 2
    assert saved[3]["picks"][0]["microblog_id"] == 30
    assert usage.batch["input_tokens"] == 30 and not usage.direct
    assert not state.exists()


def test_a_resumed_batch_skips_posts_whose_inputs_moved(tmp_path):
    jobs = jobs_for([1, 2])
    answers = {
        f"mb-{n}": {"picks": [{"candidate": 1, "evidence": WHY[:40], "why": WHY}]} for n in (1, 2)
    }
    batches = FakeBatches(answers)
    batches.created = [["mb-1", "mb-2"]]
    state = tmp_path / "out.batch.json"
    requests = {"mb-1": {"input_hash": "hash-1"}, "mb-2": {"input_hash": "old"}}
    state.write_text(json.dumps({"batch_id": "batch-1", "requests": requests}))
    client = SimpleNamespace(messages=SimpleNamespace(batches=batches))
    saved = Saved()
    script.run_batch(client, jobs, script.Usage(), "claude-sonnet-5-5", saved, state, 0)
    assert sorted(saved) == [1]
    assert batches.created == [["mb-1", "mb-2"]]


def test_a_runaway_answer_fails_but_its_tokens_are_counted(tmp_path):
    jobs = jobs_for([1, 2])
    answers = {
        f"mb-{n}": {"picks": [{"candidate": 1, "evidence": WHY[:40], "why": WHY}]} for n in (1, 2)
    }
    batches = FakeBatches(answers)
    batches.runaway = {"mb-2"}
    client = SimpleNamespace(messages=SimpleNamespace(batches=batches))
    saved, usage = Saved(), script.Usage()
    state = tmp_path / "out.batch.json"
    failures = script.run_batch(client, jobs, usage, "claude-sonnet-5-5", saved, state, 0)
    assert failures == 1 and sorted(saved) == [1]
    assert usage.batch["output_tokens"] == 10


POST_VIEW = "Title: Hellweek Gear Test 1\nDate: 2001-03-02\nText:\nA 29.8-mile ride with 933 feet of climbing."
ROUTE_VIEW = (
    "Title: RAGBRAI 2009 Full Route Announced\nDate: 2009-03-10\nText:\n"
    "[Texas Hellweek](http://hellweek.com/texas.html) has a **similar** motto. "
    "I hit 10k feet of climbing for the week."
)


def test_a_number_in_neither_post_drops_the_line():
    why = "Jamie looks back at the Hellweek climbing, about 5,000 feet a day."
    reason = script.ungrounded(why, "Texas Hellweek has a similar motto", POST_VIEW, ROUTE_VIEW)
    assert reason == "5000 is in neither post"


def test_numbers_from_either_post_and_the_years_between_are_fine():
    why = "Eight years after the 933-foot ride, 10,000 feet of climbing on the 2009 route."
    why = why.replace("Eight", "8")
    assert (
        script.ungrounded(why, "Texas Hellweek has a similar motto.", POST_VIEW, ROUTE_VIEW) is None
    )


def test_evidence_must_be_the_candidates_own_words():
    why = "Texas Hellweek shares the not-flat motto with the 2009 route."
    assert script.ungrounded(why, "Iowa is flat as a board", POST_VIEW, ROUTE_VIEW) == (
        "evidence not in the candidate"
    )
    assert script.ungrounded(why, "", POST_VIEW, ROUTE_VIEW) == "no evidence"
    # Link syntax, emphasis and curly quotes do not count against a quote.
    assert (
        script.ungrounded(why, "Texas Hellweek has a similar motto", POST_VIEW, ROUTE_VIEW) is None
    )


def test_validate_drops_ungrounded_picks_and_strips_markup():
    candidates = [candidate(10), candidate(20)]
    raw = {
        "picks": [
            {
                "candidate": 1,
                "evidence": "Texas Hellweek has a similar motto",
                "why": WHY + "</br>",
            },
            {"candidate": 2, "evidence": "not there at all, invented", "why": WHY},
        ]
    }
    picks, notes = script.validate(raw, candidates, (POST_VIEW, [ROUTE_VIEW, ROUTE_VIEW]))
    assert [pick["microblog_id"] for pick in picks] == [10]
    assert picks[0]["why"] == WHY and picks[0]["evidence"].startswith("Texas")
    assert "pick 1: markup removed from the line" in notes
    assert "dropped pick 2: evidence not in the candidate" in notes


def test_a_line_with_json_in_it_is_dropped():
    candidates = [candidate(10), candidate(20), candidate(30)]
    raw = {
        "picks": [
            {"candidate": 1, "why": WHY[:-1] + ".','"},
            {"candidate": 2, "why": WHY[:-1] + ".}, {"},
            {"candidate": 3, "why": 'Tammy calls it "the best day of the trip."'},
        ]
    }
    picks, notes = script.validate(raw, candidates)
    assert [pick["microblog_id"] for pick in picks] == [30]
    assert sum("does not end as a sentence" in note for note in notes) == 2


def message(stop_reason: str, answer: dict | None = None):
    return SimpleNamespace(
        stop_reason=stop_reason,
        content=[SimpleNamespace(type="text", text=json.dumps(answer or {}))],
        usage=SimpleNamespace(
            input_tokens=10,
            output_tokens=5,
            cache_read_input_tokens=0,
            cache_creation_input_tokens=0,
        ),
    )


def retry_client(reply):
    create = lambda **_: reply  # noqa: E731
    return SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create)))


FIRST = {
    "picks": [
        {"candidate": 1, "evidence": WHY[:40], "why": WHY},
        {"candidate": 2, "evidence": "not in the post at all", "why": WHY},
    ]
}


def test_a_failed_retry_keeps_the_first_answers_picks():
    job = jobs_for([1])[0]
    job = (job[0], [candidate(10), candidate(20)], job[2], job[3], (job[4][0], job[4][1] * 2))
    usage = script.Usage()
    entry = script.answer_once_more(
        retry_client(message("max_tokens")), job, FIRST, usage, "claude-sonnet-5-5"
    )
    assert [pick["microblog_id"] for pick in entry["picks"]] == [10]
    assert any(note.startswith("second answer: ran out of tokens") for note in entry["notes"])
    assert usage.direct["output_tokens"] == 5


def test_an_empty_retry_does_not_replace_good_picks():
    job = jobs_for([1])[0]
    job = (job[0], [candidate(10), candidate(20)], job[2], job[3], (job[4][0], job[4][1] * 2))
    entry = script.answer_once_more(
        retry_client(message("end_turn", {"picks": []})),
        job,
        FIRST,
        script.Usage(),
        "claude-sonnet-5-5",
    )
    assert [pick["microblog_id"] for pick in entry["picks"]] == [10]


def test_two_unusable_answers_leave_the_post_to_ask_again():
    job = jobs_for([1])[0]
    placeholder = {"picks": [{"candidate": 1, "evidence": WHY[:40], "why": "x"}]}
    with pytest.raises(RuntimeError, match="no usable answer"):
        script.answer_once_more(
            retry_client(message("end_turn", placeholder)),
            job,
            placeholder,
            script.Usage(),
            "claude-sonnet-5-5",
        )


def test_a_valid_empty_retry_is_thingy_choosing_none():
    job = jobs_for([1])[0]
    placeholder = {"picks": [{"candidate": 1, "evidence": WHY[:40], "why": "x"}]}
    entry = script.answer_once_more(
        retry_client(message("end_turn", {"picks": []})),
        job,
        placeholder,
        script.Usage(),
        "claude-sonnet-5-5",
    )
    assert entry["picks"] == []
