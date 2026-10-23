"""The blog round (pipeline/blog/round/): the guards in code, the labeller's
request, a dry round over a small library, and the write path behind its
switch. micro.blog is a fake HTTP session under the real Micropub client,
so the gate that refuses writes is the one the round uses; no network."""

import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from librarian_core.library import absorb_tree, connect, reindex

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [
    str(ROOT / "pipeline" / "blog" / "round"),
    str(ROOT / "pipeline" / "blog"),
    str(ROOT / "pipeline" / "library"),
]

import alt_text  # noqa: E402
import blog_round  # noqa: E402
import filing  # noqa: E402
import guards  # noqa: E402
from micropub import Micropub, MicropubError  # noqa: E402

TODAY = date(2026, 10, 17)
LAKE = "https://www.thingelstad.com/2026/10/10/lake-day.html"
COFFEE = "https://www.thingelstad.com/2026/10/16/coffee.html"
CHANGED = "https://www.thingelstad.com/2026/10/12/changed.html"
SHARED = "https://www.thingelstad.com/2000/01/01/shared.html"
LAKE_PHOTO = "https://www.thingelstad.com/uploads/2026/a.jpg"
LAKE_BODY = f'A day at the lake.\n\n<img src="{LAKE_PHOTO}" alt="">\n'


def _post(mid: int, url: str, title: str, published: str, categories: list[str], body: str) -> str:
    lines = [
        "---",
        f"microblog_id: {mid}",
        f'url: "{url}"',
        f'title: "{title}"' if title else 'title: ""',
        f'published: "{published}"',
        f"post_kind: {'post' if title else 'micropost'}",
        "categories:" if categories else "categories: []",
        *[f"  - {name}" for name in categories],
        "---",
        body,
    ]
    return "\n".join(lines)


TREE = {
    "blog/posts/2026/10/lake.md": _post(
        100, LAKE, "Lake day", "2026-10-10T15:00:00+00:00", ["Family"], LAKE_BODY
    ),
    "blog/posts/2026/10/coffee.md": _post(
        200, COFFEE, "", "2026-10-16T14:00:00+00:00", [], "Coffee on the North Shore.\n"
    ),
    "blog/posts/2026/10/changed.md": _post(
        300, CHANGED, "Changed", "2026-10-12T15:00:00+00:00", ["Coffee", "Family"], "A post.\n"
    ),
    "blog/posts/2000/01/shared.md": _post(
        377970, SHARED, "Shared", "2000-01-01T15:00:00+00:00", [], "An early post.\n"
    ),
    "blog/index.json": "{}\n",
    "librarian/media-descriptions.json": json.dumps(
        {LAKE_PHOTO: {"description": "A dock on a calm lake", "model": "m"}}
    ),
}

CATALOG = [
    ("Coffee", "coffee", "topic", "Posts about coffee: brewing, beans, cafés."),
    ("Family", "family", "topic", "Posts about Jamie's family."),
    ("North Shore 2025", "north-shore-2025", "trip", ""),
    ("Weekly Thing", "weekly-thing", "project", ""),
    ("Featured", "featured", "featured", ""),
    ("Gallery", "gallery", "kept", ""),
]


class FakeResponse:
    def __init__(self, status: int, body: dict | None = None):
        self.status_code = status
        self.ok = status < 400
        self._body = body or {}
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


class FakeSession:
    """micro.blog's Micropub endpoint, holding each post's categories and body."""

    def __init__(self, posts: dict[str, dict]):
        self.posts = posts
        self.posted: list[dict] = []

    def get(self, url, params=None, headers=None, timeout=None):
        post = self.posts.get(params["url"])
        if post is None:
            return FakeResponse(404)
        return FakeResponse(
            200,
            {
                "properties": {
                    "uid": [post["uid"]],
                    "category": list(post["categories"]),
                    "content": [post["content"]],
                }
            },
        )

    def post(self, url, json=None, headers=None, timeout=None):
        self.posted.append(json)
        replace = json["replace"]
        if "category" in replace:
            self.posts[json["url"]]["categories"] = list(replace["category"])
        if "content" in replace:
            self.posts[json["url"]]["content"] = replace["content"][0]
        return FakeResponse(202)


def _live() -> dict[str, dict]:
    return {
        LAKE: {"uid": "100", "categories": ["Family"], "content": LAKE_BODY},
        COFFEE: {"uid": "200", "categories": [], "content": "Coffee on the North Shore.\n"},
        CHANGED: {"uid": "300", "categories": ["Coffee", "Family"], "content": "A post.\n"},
        # Micropub answers for the earlier post at the same address.
        SHARED: {"uid": "377969", "categories": [], "content": "Another post.\n"},
    }


def _filing(source_id: str, picks: list[str], **extra) -> filing.Filing:
    labels = {
        "topics": ["coffee"],
        "subjects": [],
        "gist": "Coffee on the North Shore",
        "kind": "note",
        "place": "North Shore",
        "substance": 2,
        "evergreen": False,
    }
    return filing.Filing(
        source_id=source_id,
        labels=labels,
        picks=picks,
        new_trip=extra.get("new_trip", ""),
        missing=extra.get("missing", ""),
        reason="It is about coffee.",
        model="claude-opus-5-5",
        usage={"input_tokens": 1000, "output_tokens": 100},
        stop=extra.get("stop"),
    )


class Library(unittest.TestCase):
    """A small library: three blog posts, one sharing an address, a catalog."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        for rel, text in TREE.items():
            path = tmp / "tree" / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        self.conn = connect(tmp / "library.db", create=True)
        absorb_tree(self.conn, tmp / "tree", seed=True)
        reindex(self.conn)
        for name, slug, kind, why in CATALOG:
            self.conn.execute(
                "INSERT INTO categories (name, slug, kind, why, made_by, created_at) "
                "VALUES (?, ?, ?, ?, 'jamie', '2026-10-21')",
                (name, slug, kind, why),
            )
        self.conn.execute(
            "INSERT INTO categories (name, slug, kind, made_by, created_at, retired_at) "
            "VALUES ('Book', 'book', 'kept', 'jamie', '2010-01-01', '2026-10-21')"
        )
        for source_id, cats in (("blog-100", ["Family"]), ("blog-300", ["Coffee"])):
            self.conn.execute(
                "INSERT INTO filings (source_id, categories, filed_by, filed_at) "
                "VALUES (?, ?, 'overhaul', '2026-10-21')",
                (source_id, json.dumps(cats)),
            )
        self.conn.execute(
            "INSERT INTO labels (source_id, gist, kind, substance, evergreen, model) "
            "VALUES ('blog-100', 'A day at the lake', 'essay', '4', 1, 'claude-opus-5-5')"
        )
        self.conn.commit()
        self.session = FakeSession(_live())
        self.micropub = Micropub(token="test", session=self.session)
        pause = mock.patch.object(guards, "PAUSE_FILE", tmp / "PAUSED")
        pause.start()
        self.addCleanup(pause.stop)
        self.pause_file = tmp / "PAUSED"
        self.labelled: list[str] = []
        self.picks = {"blog-200": ["Coffee"], "blog-100": ["Family"], "blog-300": ["Coffee"]}
        self.drafts: list[str] = []

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def labeller(self, catalog, source_id):
        self.labelled.append(source_id)
        return _filing(source_id, self.picks[source_id])

    def alt_writer(self, src, context):
        self.drafts.append(context)
        return "A dock on a calm lake at dusk"

    def round(self, **kwargs):
        return blog_round.run_round(
            self.conn,
            micropub=self.micropub,
            labeller=self.labeller,
            alt_writer=self.alt_writer,
            today=TODAY,
            **kwargs,
        )


class NameTests(unittest.TestCase):
    def test_names_compare_by_slug_without_accents(self):
        self.assertEqual(guards.slug("Pokémon"), "pokemon")
        self.assertEqual(
            guards.slug("Tammy's NYC Birthday Trip 2023"), "tammy-s-nyc-birthday-trip-2023"
        )
        self.assertTrue(guards.same_set(["Coffee", "Pokémon"], ["pokemon", "COFFEE"]))

    def test_twins_are_refused_but_another_year_is_a_new_trip(self):
        existing = ["Coffee", "Pokémon", "North Shore 2025", "Smart Home"]
        self.assertEqual(guards.twin_of("Coffees", existing), "Coffee")
        self.assertEqual(guards.twin_of("Pokemon", existing), "Pokémon")
        self.assertEqual(guards.twin_of("Smart-Home", existing), "Smart Home")
        self.assertIsNone(guards.twin_of("North Shore 2026", existing))
        self.assertIsNone(guards.twin_of("Lisbon 2026", existing))

    def test_new_names(self):
        self.assertIn("subfolder", guards.check_new_name("Food/Drink", []))
        self.assertIn("retired", guards.check_new_name("Travel Log", []))
        self.assertIn("twin", guards.check_new_name("coffee", ["Coffee"]))
        self.assertIsNone(guards.check_new_name("Switzerland & Italy 2027", ["Coffee"]))


class TargetTests(unittest.TestCase):
    KINDS = {"lisbon-2026": "trip", "coffee": "topic", "gallery": "kept", "weekly-thing": "project"}

    def test_order_is_trip_series_project_topics_kept_and_live_is_kept(self):
        target = guards.target_categories(
            ["Gallery", "Weekly Thing"], ["Coffee", "Lisbon 2026"], self.KINDS
        )
        self.assertEqual(target, ["Lisbon 2026", "Weekly Thing", "Coffee", "Gallery"])

    def test_weekly_thing_featured_and_retired_are_never_added(self):
        target = guards.target_categories(
            [], ["Weekly Thing", "Featured", "Book", "Coffee"], self.KINDS
        )
        self.assertEqual(target, ["Coffee"])

    def test_refusals(self):
        self.assertIn("empty", guards.check_target([], []))
        self.assertIn("remove", guards.check_target(["Coffee", "Family"], ["Coffee"]))
        self.assertIn("Weekly Thing", guards.check_target([], ["Weekly Thing"]))
        self.assertIn("retired", guards.check_target(["Coffee"], ["Coffee", "Book"]))
        self.assertIsNone(guards.check_target(["Coffee"], ["Pokémon", "coffee"]))


class AltSpliceTests(unittest.TestCase):
    SRC = "https://www.thingelstad.com/uploads/2026/a.jpg"

    def test_fills_an_empty_alt_and_nothing_else(self):
        body = f'Before.\n<img src="{self.SRC}" alt="" width="600">\nAfter.'
        edited, why = guards.splice_alt(body, self.SRC, "A dock")
        self.assertEqual(why, "ok")
        self.assertEqual(edited, body.replace('alt=""', 'alt="A dock"'))

    def test_adds_a_missing_alt_attribute_and_keeps_the_img_tag(self):
        body = f"<p><img src='{self.SRC}'></p>"
        edited, _why = guards.splice_alt(body, self.SRC, "A dock")
        self.assertEqual(edited, f"<p><img src='{self.SRC}' alt=\"A dock\"></p>")
        self.assertNotIn("![", edited)

    def test_markdown_image(self):
        edited, _why = guards.splice_alt(f"![]({self.SRC})", self.SRC, "A dock")
        self.assertEqual(edited, f"![A dock]({self.SRC})")

    def test_an_escaped_source_matches(self):
        src = "https://www.thingelstad.com/uploads/2026/a.jpg?w=1&h=2"
        body = '<img src="https://www.thingelstad.com/uploads/2026/a.jpg?w=1&amp;h=2" alt="">'
        edited, _why = guards.splice_alt(body, src, "A dock")
        self.assertIn('alt="A dock"', edited)

    def test_leaves_alt_jamie_wrote_and_images_shown_twice(self):
        filled = f'<img src="{self.SRC}" alt="Jamie wrote this">'
        self.assertEqual(guards.splice_alt(filled, self.SRC, "A dock")[0], None)
        twice = f'<img src="{self.SRC}" alt=""> and ![]({self.SRC})'
        self.assertEqual(
            guards.splice_alt(twice, self.SRC, "A dock")[1],
            "the image is in the post more than once",
        )

    def test_refuses_an_alt_that_would_break_the_markup(self):
        body = f'<img src="{self.SRC}" alt="">'
        self.assertIsNone(guards.splice_alt(body, self.SRC, 'A "dock"')[0])
        self.assertIsNone(guards.splice_alt(body, self.SRC, "A [dock]")[0])

    def test_only_alt_changed(self):
        before = f'Hello.\n<img src="{self.SRC}" alt="">'
        self.assertTrue(
            guards.only_alt_changed(before, before.replace('alt=""', 'alt="A dock"'), "A dock")
        )
        self.assertFalse(
            guards.only_alt_changed(
                before, before.replace("Hello", "Hallo").replace('alt=""', 'alt="A dock"'), "A dock"
            )
        )
        self.assertFalse(
            guards.only_alt_changed(before, f"Hello.\n![A dock]({self.SRC})", "A dock")
        )


class GateTests(Library):
    def test_paused_stops_the_round(self):
        self.pause_file.write_text("")
        with self.assertRaises(guards.RoundStop):
            self.round()

    def test_writes_are_refused_while_off_and_nothing_is_posted(self):
        off = mock.patch.object(guards, "WRITES_ON", False)
        off.start()
        self.addCleanup(off.stop)
        with self.assertRaises(guards.RoundStop):
            self.micropub.replace_categories(COFFEE, ["Coffee"])
        with self.assertRaises(guards.RoundStop):
            self.micropub.replace_content(LAKE, "x")
        work = blog_round.Round(
            self.conn,
            micropub=self.micropub,
            labeller=self.labeller,
            alt_writer=self.alt_writer,
            today=TODAY,
        )
        with self.assertRaises(guards.RoundStop):
            work.write({"categories": [], "alt": []})
        self.assertEqual(self.session.posted, [])

    def test_a_read_for_another_post_is_not_trusted(self):
        self.assertIsNone(self.micropub.source(SHARED, "377970"))
        self.assertIsNone(self.micropub.source("https://www.thingelstad.com/nope.html", "1"))

    def test_the_round_never_empties_a_post(self):
        with self.assertRaises(MicropubError):
            self.micropub.replace_categories(COFFEE, [])


class DryRoundTests(Library):
    def test_proposes_for_new_posts_and_writes_nothing_to_micro_blog(self):
        work, result = self.round()
        self.assertEqual(self.session.posted, [])
        self.assertEqual(self.labelled, ["blog-200"])  # the shared-address post is left out
        [proposal] = result["categories"]
        self.assertEqual(proposal["source_id"], "blog-200")
        self.assertEqual(proposal["target"], ["Coffee"])
        self.assertIsNone(proposal["problem"])
        self.assertEqual([row["source_id"] for row in work.made.labels], ["blog-200"])
        [event] = [e for e in work.made.events if e["action"] == "categories"]
        self.assertEqual((event["dry_run"], event["result"]), (1, "proposed"))
        self.assertEqual(json.loads(event["after"]), ["Coffee"])

    def test_someone_elses_change_is_reported_not_adopted(self):
        work, result = self.round()
        [drift] = result["drift"]
        self.assertEqual(drift["source_id"], "blog-300")
        self.assertFalse(work.made.filings)

    def test_drafts_alt_from_the_description_and_the_post(self):
        _work, result = self.round()
        [alt] = result["alt"]
        self.assertEqual(alt["alt"], "A dock on a calm lake at dusk")
        self.assertIsNone(alt["problem"])
        self.assertIn("A dock on a calm lake", self.drafts[0])
        self.assertIn("A day at the lake", self.drafts[0])

    def test_a_dry_run_draft_is_reused_not_paid_twice(self):
        work, _result = self.round()
        blog_round.apply(self.conn, work.made)
        _work, result = self.round()
        self.assertEqual(len(self.drafts), 1)
        self.assertEqual(result["alt"][0]["context"], "drafted by an earlier dry run")

    def test_a_gone_image_goes_to_alt_skips(self):
        with mock.patch.object(alt_text, "known_dead", return_value=True):
            work, result = blog_round.run_round(
                self.conn,
                micropub=self.micropub,
                labeller=self.labeller,
                alt_writer=lambda src, context: "",
                today=TODAY,
            )
        self.assertEqual([row["url"] for row in work.made.skips], [LAKE_PHOTO])
        blog_round.apply(self.conn, work.made)
        self.assertEqual(blog_round.Round.alt_candidates(work), [])

    def test_recheck_refiles_without_recording_labels_or_events(self):
        work, result = self.round(recheck=1)
        checks = [p for p in result["categories"] if p["check"]]
        self.assertEqual([p["source_id"] for p in checks], ["blog-300"])
        self.assertEqual([row["source_id"] for row in work.made.labels], ["blog-200"])
        self.assertFalse([e for e in work.made.events if e["target"] == "blog-300"])

    def test_a_missing_category_the_catalog_has_is_dropped(self):
        def labeller(catalog, source_id):
            return _filing(source_id, ["Coffee"], missing="Weekly Thing")

        _work, result = blog_round.run_round(
            self.conn,
            micropub=self.micropub,
            labeller=labeller,
            alt_writer=self.alt_writer,
            today=TODAY,
        )
        self.assertEqual(result["categories"][0]["missing"], "")

    def test_featured_candidates_are_a_week_old_titled_posts(self):
        _work, result = self.round()
        [candidate] = result["featured"]
        self.assertEqual(candidate["source_id"], "blog-100")
        self.assertEqual((candidate["substance"], candidate["evergreen"]), ("4", True))

    def test_apply_records_what_the_round_made(self):
        work, result = self.round()
        blog_round.apply(self.conn, work.made)
        gist = self.conn.execute("SELECT gist FROM labels WHERE source_id = 'blog-200'").fetchone()
        self.assertEqual(gist["gist"], "Coffee on the North Shore")
        n = self.conn.execute("SELECT count(*) AS n FROM events WHERE dry_run = 1").fetchone()["n"]
        self.assertEqual(n, 2)  # one category write, one alt
        text = blog_round.report("2026-10-17", result)
        self.assertIn("nothing reaches micro.blog until `--write`", text)
        self.assertIn("blog-300", text)


class WriteTests(Library):
    """The write path, with writes switched on against the fake session."""

    def setUp(self):
        super().setUp()
        on = mock.patch.object(guards, "WRITES_ON", True)
        on.start()
        self.addCleanup(on.stop)
        self.work = blog_round.Round(
            self.conn,
            micropub=self.micropub,
            labeller=self.labeller,
            alt_writer=self.alt_writer,
            today=TODAY,
        )

    def _proposals(self):
        _work, result = blog_round.run_round(
            self.conn,
            micropub=self.micropub,
            labeller=self.labeller,
            alt_writer=self.alt_writer,
            today=TODAY,
        )
        return result

    def test_writes_categories_and_alt_and_reads_them_back(self):
        said = self.work.write(self._proposals())
        self.assertEqual(self.session.posts[COFFEE]["categories"], ["Coffee"])
        self.assertIn('alt="A dock on a calm lake at dusk"', self.session.posts[LAKE]["content"])
        self.assertEqual(len(said["written"]), 2)
        filings = {row["source_id"]: row for row in self.work.made.filings}
        self.assertEqual(json.loads(filings["blog-200"]["categories"]), ["Coffee"])
        self.assertEqual(filings["blog-200"]["filed_by"], "librarian")
        self.assertEqual(json.loads(filings["blog-100"]["alt_filled"]), [LAKE_PHOTO])
        self.assertEqual(filings["blog-100"]["filed_by"], "overhaul")

    def test_compare_and_set_adopts_a_change_made_since_the_proposal(self):
        proposals = self._proposals()
        self.session.posts[COFFEE]["categories"] = ["Family"]
        said = self.work.write(proposals)
        self.assertEqual(self.session.posts[COFFEE]["categories"], ["Family"])
        self.assertTrue(any("someone else changed" in line for line in said["left"]))
        filings = {row["source_id"]: row for row in self.work.made.filings}
        self.assertEqual(
            (filings["blog-200"]["jamie_set"], filings["blog-200"]["filed_by"]), (1, "jamie")
        )

    def test_a_pick_outside_the_catalog_is_never_written(self):
        proposals = self._proposals()
        proposals["categories"][0]["picks"] = ["Cofee"]
        said = self.work.write(proposals)
        self.assertEqual(self.session.posts[COFFEE]["categories"], [])
        self.assertTrue(any("not in the catalog" in line for line in said["left"]))

    def test_a_new_trip_needs_acceptance_and_a_description(self):
        self.picks["blog-200"] = ["Coffee"]
        proposals = self._proposals()
        proposals["categories"][0]["new_trip"] = "North Shore 2026"
        entry = {"name": "North Shore 2026", "kind": "trip", "description": "", "accept": True}
        proposals["new_categories"] = [entry]
        said = self.work.write(dict(proposals, alt=[]))
        self.assertEqual(self.session.posts[COFFEE]["categories"], ["Coffee"])
        self.assertTrue(any("description" in line for line in said["left"]))

        self.session.posts[COFFEE]["categories"] = []
        entry["description"] = "Jamie's 2026 trip up the North Shore of Lake Superior."
        self.work.write(dict(proposals, alt=[]))
        self.assertEqual(self.session.posts[COFFEE]["categories"], ["North Shore 2026", "Coffee"])
        self.assertEqual([row["name"] for row in self.work.made.categories], ["North Shore 2026"])

    def test_the_pace_cap_stops_and_asks_jamie(self):
        proposals = self._proposals()
        with mock.patch.object(guards, "CATEGORY_CAP", 0):
            said = self.work.write(proposals)
        self.assertEqual(self.session.posts[COFFEE]["categories"], [])
        self.assertEqual(said["needs_jamie"], ["past 0 category writes today"])

    def test_alt_waits_for_a_post_to_be_filed(self):
        proposals = {
            "categories": [],
            "alt": [
                {
                    "source_id": "blog-200",
                    "url": COFFEE,
                    "src": LAKE_PHOTO,
                    "alt": "x",
                    "problem": None,
                }
            ],
        }
        said = self.work.write(proposals)
        self.assertEqual(self.session.posted, [])
        self.assertIn("file it first", said["left"][0])


class LabellerTests(Library):
    def test_the_schema_offers_only_the_catalog_and_never_weekly_thing_or_featured(self):
        catalog = filing.load_catalog(self.conn)
        schema = filing.schema(catalog)
        props = schema["properties"]
        self.assertEqual(props["project"]["enum"], [""])
        self.assertEqual(props["topics_filed"]["items"]["enum"], ["Coffee", "Family"])
        self.assertEqual(props["trip"]["enum"], ["", "North Shore 2025"])
        self.assertNotIn("Book", json.dumps(schema))
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(sorted(schema["required"]), sorted(props))
        self.assertIn("Coffee: Posts about coffee", catalog.text)

    def test_request_and_answer(self):
        catalog = filing.load_catalog(self.conn)
        request = filing.request(self.conn, catalog, "blog-100")
        self.assertEqual(request["model"], "claude-opus-5-5")
        self.assertEqual(request["fallbacks"], "default")
        self.assertEqual(request["system"][0]["cache_control"], {"type": "ephemeral"})
        self.assertIn("[Photo: A dock on a calm lake]", request["messages"][0]["content"])
        answer = {
            "topics": ["lakes"],
            "subjects": [],
            "gist": "A day at the lake",
            "kind": "photo",
            "place": "",
            "substance": 2,
            "evergreen": True,
            "trip": "",
            "new_trip": "",
            "series": "",
            "project": "",
            "topics_filed": ["Family"],
            "others": ["Gallery"],
            "missing": "",
            "reason": "A family day out.",
        }
        message = SimpleNamespace(
            model="claude-opus-5-5",
            stop_reason="end_turn",
            content=[SimpleNamespace(type="text", text=json.dumps(answer))],
            usage=SimpleNamespace(input_tokens=10, output_tokens=5),
        )
        client = SimpleNamespace(
            beta=SimpleNamespace(messages=SimpleNamespace(create=lambda **kwargs: message))
        )
        result = filing.file_post(client, self.conn, catalog, "blog-100")
        self.assertEqual(result.picks, ["Family", "Gallery"])
        self.assertEqual(result.labels["kind"], "photo")
        message.stop_reason = "refusal"
        self.assertEqual(filing.file_post(client, self.conn, catalog, "blog-100").picks, [])


if __name__ == "__main__":
    unittest.main()
