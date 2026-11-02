"""The keyword eval set: every question leads to exactly one source."""

import importlib.util
import json
import random
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline/eval"))
spec = importlib.util.spec_from_file_location(
    "build_keyword_set", ROOT / "pipeline/eval/build_keyword_set.py"
)
keyword = importlib.util.module_from_spec(spec)
spec.loader.exec_module(keyword)
meaning = keyword.meaning

POSTS = [
    "Garry Kasparov played chess against the Deep Blue computer in a famous match downtown.",
    "Kasparov wrote a book about chess and the machines that beat him at the club.",
    "Kasparov came back to chess and the club one more time with friends from work.",
    "Another chess match happened at the club with friends and a computer last weekend.",
    "The famous computer club met with friends to talk about the book and the match.",
    "We went to the club to play chess with friends and read a book about computers.",
    "Notes from the sessions I attended at the club with friends and the famous computer.",
    "The match was famous and the book was good, and friends came to the club again.",
]


def chunk(index: int, text: str, **fields) -> dict:
    return {
        "id": f"blog:{index}:0:x",
        "source_kind": "blog",
        "microblog_id": str(index),
        "url": f"https://example.com/{index}",
        "subject": f"Post number {index} about things",
        "section": "Post",
        "text": text,
        "word_count": "25",
        **fields,
    }


@pytest.fixture
def corpora(tmp_path: Path, monkeypatch) -> meaning.Corpora:
    # A toy archive: no word is rare in eight sources, so let pairs use any.
    monkeypatch.setattr(keyword, "PAIR_MAX_SHARE", 1.0)
    blog = [chunk(index, text) for index, text in enumerate(POSTS, 1)]
    document = {
        "id": "doc:bio:0:x",
        "source_kind": "document",
        "doc_id": "bio",
        "url": "doc-bio",
        "subject": "A short biography of someone",
        "section": "Bio",
        "text": "Kasparov is a name in this private document beside a famous chess computer club.",
        "word_count": "25",
    }
    (tmp_path / "blog_corpus.json").write_text(json.dumps({"chunks": blog}))
    (tmp_path / "reference_corpus.json").write_text(json.dumps({"chunks": [document]}))
    return meaning.Corpora(tmp_path)


def test_inflect_gives_the_other_number():
    assert keyword.inflect("session") == "sessions"
    assert keyword.inflect("sessions") == "session"
    assert keyword.inflect("company") == "companies"
    assert keyword.inflect("companies") == "company"
    assert keyword.inflect("match") == "matches"
    assert keyword.inflect("glass") is None
    assert keyword.inflect("holiday") == "holidays"


def test_every_item_leads_to_exactly_one_source(corpora):
    archive = keyword.Archive(corpora)
    public, private = keyword.build(corpora, seed=7)
    assert public, "the toy archive yields questions"
    for item in public + private:
        assert item["target_source"] in archive.text
        quote = item["answer_quote"]
        holders = {key for key, text in archive.text.items() if quote in text}
        assert item["target_source"] in holders
        assert holders == {item["target_source"]}, item
        if item["kind"] in ("name", "inflected", "question"):
            terms = item["terms"]
            pair = archive.holding([terms["name"].lower(), terms["word"]])
            assert pair == {item["target_source"]}, item
            if item["kind"] == "inflected":
                assert terms["typed"] != terms["word"]
                assert terms["typed"] not in archive.text[item["target_source"]].split()
                assert not archive.holding([terms["name"].lower(), terms["typed"]])


def test_quoted_items_are_phrases_in_quotes(corpora):
    archive = keyword.Archive(corpora)
    rng = random.Random(3)
    item = None
    for post in corpora.chunks["blog"]:
        item = keyword.phrase_item(archive, "blog", post, rng, "quoted")
        if item:
            break
    assert item
    assert item["question"] == f'"{item["answer_quote"]}"'


def test_document_questions_stay_private(corpora):
    public, private = keyword.build(corpora, seed=7)
    assert all(item["corpus"] != "document" for item in public)
    assert all(item["corpus"] == "document" for item in private)
    assert all(item["id"].startswith("kp") for item in private)


def test_an_inflected_pair_has_no_competing_source(tmp_path, monkeypatch):
    # Post 1 holds "Kasparov session", post 2 "Kasparov sessions": asking
    # "Kasparov sessions" of post 1 would mark a right answer wrong.
    monkeypatch.setattr(keyword, "PAIR_MAX_SHARE", 1.0)
    texts = [
        "Kasparov ran one session at the club downtown with friends today.",
        "Kasparov ran two sessions at the club with other friends today.",
        "Kasparov again at the club today with friends and nothing else.",
        "A session at the club with friends today and nothing else.",
        "More sessions at the club with friends today and nothing else.",
        "The club met today with friends and talked about a session.",
    ]
    (tmp_path / "blog_corpus.json").write_text(
        json.dumps({"chunks": [chunk(index, text) for index, text in enumerate(texts, 1)]})
    )
    corpora = meaning.Corpora(tmp_path)
    archive = keyword.Archive(corpora)
    # Without the competing source, post 1's pair would qualify.
    assert archive.holding(["kasparov", "session"]) == {"blog:1"}
    assert archive.holding(["kasparov", "sessions"]) == {"blog:2"}
    for post in corpora.chunks["blog"][:2]:
        found = keyword.name_pair(archive, post, random.Random(1), inflected=True)
        assert not found or found[1] not in ("session", "sessions"), found
