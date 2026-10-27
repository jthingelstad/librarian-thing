import copy
import json

from pipeline.deploy.corpus_fact import corpus_fact
from pipeline.library.sync_receipts import announce, arrivals

AT = "2026-10-28T02:16:10Z"
OLD = [{"id": "wt-354", "kind": "issue", "published": "2026-10-24"}]
NEW = OLD + [
    {"id": "wt-355", "kind": "issue", "published": "2026-10-31", "title": "private-canary"}
]


def test_only_newly_held_newest_public_id_is_announced():
    unchanged = copy.deepcopy(NEW)
    events = arrivals(OLD, NEW, AT)
    assert len(events) == 1
    assert events[0]["Source"] == "librarian"
    assert events[0]["DetailType"] == "received"
    assert json.loads(events[0]["Detail"]) == {
        "system": "librarian",
        "kind": "issue",
        "id": "355",
        "at": AT,
        "via": "library-round",
    }
    assert NEW == unchanged
    assert arrivals(None, NEW, AT) == []
    assert arrivals(NEW, NEW, AT) == []
    assert arrivals(NEW, OLD, AT) == []
    assert "private-canary" not in json.dumps(events)


def test_posts_use_exact_public_permalink_and_private_documents_never_enter():
    rows = [
        {
            "id": "blog-1",
            "kind": "photo",
            "url": "https://www.thingelstad.com/2026/10/28/a.html",
            "published": AT,
        },
        {
            "id": "doc-private",
            "kind": "document",
            "url": "https://private.invalid",
            "published": AT,
        },
    ]
    event = json.loads(arrivals([], rows, AT)[0]["Detail"])
    assert event["kind"] == "post"
    assert event["id"] == rows[0]["url"]
    assert event["url"] == rows[0]["url"]
    bad = [{**rows[0], "url": "https://fixture-secret@www.thingelstad.com/a"}]
    assert arrivals([], bad, AT) == []
    assert "private.invalid" not in json.dumps(arrivals([], rows, AT))


def test_links_require_the_published_producer_stamp_instead_of_guessing_from_a_hash():
    rows = [{"id": "link-aaaaaaaaaaaa", "kind": "link", "published": AT}]
    assert arrivals([], rows, AT) == []
    source = {"kind": "link", "origin": "pinboard", "item": {"id": AT}}
    assert json.loads(arrivals([], rows, AT, source)[0]["Detail"])["id"] == AT
    assert arrivals(rows, rows, AT, source) == []
    assert arrivals([], rows, AT, {**source, "origin": "links"}) == []


def test_transport_is_disabled_by_default_and_requires_every_entry_acknowledgement(capsys):
    class Client:
        def __init__(self, fail=False):
            self.entries = []
            self.fail = fail

        def put_events(self, **kwargs):
            self.entries.extend(kwargs["Entries"])
            return (
                {"FailedEntryCount": 1, "Entries": [{"ErrorCode": "private-error"}]}
                if self.fail
                else {"FailedEntryCount": 0, "Entries": [{"EventId": "fixture-event"}]}
            )

    client = Client()
    assert announce(OLD, NEW, "", AT, client=client) == 0
    assert client.entries == []
    assert announce(OLD, NEW, "fixture-bus", AT, client=client) == 1
    assert client.entries[0]["EventBusName"] == "fixture-bus"
    assert announce(OLD, NEW, "fixture-bus", AT, client=Client(True)) == 0
    assert "private-error" not in capsys.readouterr().err


def test_blog_head_metadata_carries_only_a_verified_public_permalink():
    payload = {
        "posts": [
            {
                "microblog_id": "1",
                "published": AT,
                "url": "https://www.thingelstad.com/a",
                "content": "private-canary",
            }
        ]
    }
    fact = corpus_fact("blog_corpus.json", payload)
    assert fact["newest-url"] == "https://www.thingelstad.com/a"
    assert "private-canary" not in json.dumps(fact)
    payload["posts"][0]["url"] = "https://www.thingelstad.com/a?fixture=private"
    assert "newest-url" not in corpus_fact("blog_corpus.json", payload)
