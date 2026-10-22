"""Reader numbers: Tinylytics counts in the library, the path each belongs
to, what the corpus carries, and the pull that reads them."""

import importlib.util
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from librarian_core.corpus import build_podcast_corpus
from librarian_core.library import connect, export_tree, fingerprints
from librarian_core.library.db import LibraryError
from librarian_core.library.readers import (
    corpus_readers,
    index_readers,
    readers_export,
    store_days,
    store_kudos,
)

ROOT = Path(__file__).resolve().parents[1]


def _load_tinylytics():
    spec = importlib.util.spec_from_file_location(
        "library_tinylytics", ROOT / "pipeline" / "library" / "tinylytics.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tinylytics = _load_tinylytics()

SOURCES = [
    ("wt-12", "issue", "https://weekly.thingelstad.com/archive/12/", "2017-08-05T13:00:00Z"),
    ("wt-53", "issue", "https://weekly.thingelstad.com/archive/53/", "2018-05-12T13:00:00Z"),
    ("blog-1", "post", "https://www.thingelstad.com/2024/07/10/a.html", "2024-07-10T12:00:00Z"),
    ("blog-2", "post", "https://www.thingelstad.com/2014/12/21/010000.html", None),
    ("blog-3", "post", "https://www.thingelstad.com/2014/12/21/010000.html", None),
    ("blog-4", "micropost", "http://micro.thingelstad.com/2019/01/02/123.html", None),
    ("page-9", "page", "https://www.thingelstad.com/about/", None),
    ("ep-1", "episode", "https://another.thingelstad.com/2025/10/05/how-do-you-start-a.html", None),
    ("thing-otto", "thing", "https://thingelstad.xyz/things/otto/", None),
    ("site-support", "site_page", "https://weekly.thingelstad.com/members/", None),
]


def _library(tmp: Path):
    conn = connect(tmp / "library.db", create=True)
    with conn:
        conn.executemany(
            "INSERT INTO sources (id, kind, path, url, title, published, sha256, pulled_at) "
            "VALUES (?, ?, ?, ?, '', ?, '', '')",
            [(sid, kind, f"x/{sid}", url, published) for sid, kind, url, published in SOURCES],
        )
        conn.executemany(
            "INSERT INTO reader_sites (site, tinylytics_id, tracked_since, pulled_through) "
            "VALUES (?, ?, ?, ?)",
            [
                ("www", 1521, "2024-07-09", "2026-10-21"),
                ("weekly", 3063, "2026-01-08", "2026-10-21"),
                ("another", 3059, "2026-01-05", "2026-10-21"),
                ("xyz", 3823, "2026-10-13", "2026-10-21"),
            ],
        )
    store_days(
        conn,
        "weekly",
        "2026-01-08",
        "2026-10-21",
        {
            ("/archive/12/", "2026-10-20"): 3,
            ("/archive/12", "2026-10-21"): 1,
            ("/email/12/", "2026-10-20"): 40,
            ("/feed/12/", "2026-10-20"): 2,
            ("/archive/weekly-thing-for-august-5-2017/", "2026-02-01"): 5,
            ("/archive/weekly-thing-53-may-12-2018/", "2026-07-01"): 7,
            ("/archive/weekly-thing-53", "2026-07-02"): 1,
            ("/members/", "2026-10-21"): 4,
            ("/", "2026-10-21"): 99,
        },
    )
    store_days(
        conn,
        "www",
        "2024-07-09",
        "2026-10-21",
        {
            ("/2024/07/10/a.html", "2024-07-10"): 10,
            ("/2024/07/10/a.html", "2026-10-21"): 2,
            ("/2014/12/21/010000.html", "2026-10-21"): 6,
            ("/2019/01/02/123.html", "2026-10-01"): 1,
            ("/about", "2026-09-30"): 8,
        },
    )
    store_days(
        conn,
        "another",
        "2026-01-05",
        "2026-10-21",
        {("/2025/10/05/how-do-you-start-a.html", "2026-03-04"): 9},
    )
    store_days(conn, "xyz", "2026-10-13", "2026-10-21", {("/things/otto/", "2026-10-15"): 1})
    store_kudos(conn, "www", [(5, "/2024/07/10/a.html", "2026-10-02T03:00:00.000Z")])
    store_kudos(conn, "weekly", [(6, "/archive/12/", "2026-10-20T18:00:00.000Z")])
    index_readers(conn)
    return conn


class ReaderPathsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = _library(Path(self.tmp.name))

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def paths(self):
        return {
            (row["site"], row["path"]): (row["source_id"], row["measure"])
            for row in self.conn.execute("SELECT * FROM reader_paths")
        }

    def test_each_path_finds_its_source_and_measure(self):
        paths = self.paths()
        self.assertEqual(paths[("weekly", "/archive/12/")], ("wt-12", "views"))
        self.assertEqual(paths[("weekly", "/archive/12")], ("wt-12", "views"))
        self.assertEqual(paths[("weekly", "/email/12/")], ("wt-12", "email_opens"))
        self.assertEqual(paths[("weekly", "/feed/12/")], ("wt-12", "feed_reads"))
        self.assertEqual(paths[("www", "/2024/07/10/a.html")], ("blog-1", "views"))
        self.assertEqual(paths[("www", "/about")], ("page-9", "views"))
        self.assertEqual(
            paths[("another", "/2025/10/05/how-do-you-start-a.html")], ("ep-1", "views")
        )
        self.assertEqual(paths[("xyz", "/things/otto/")], ("thing-otto", "views"))

    def test_old_weekly_slugs_resolve_by_number_and_by_date(self):
        paths = self.paths()
        self.assertEqual(paths[("weekly", "/archive/weekly-thing-53-may-12-2018/")][0], "wt-53")
        self.assertEqual(paths[("weekly", "/archive/weekly-thing-53")][0], "wt-53")
        self.assertEqual(paths[("weekly", "/archive/weekly-thing-for-august-5-2017/")][0], "wt-12")

    def test_a_site_page_is_kept_under_the_id_the_lambda_uses(self):
        self.assertEqual(self.paths()[("weekly", "/members/")][0], "site-members")

    def test_an_old_host_matches_by_path(self):
        self.assertEqual(self.paths()[("www", "/2019/01/02/123.html")][0], "blog-4")

    def test_the_faq_and_the_registry_index_are_sources_the_build_makes(self):
        with self.conn:
            self.conn.executemany(
                "INSERT INTO reader_days (site, path, day, views) VALUES (?, ?, '2026-10-21', 1)",
                [("weekly", "/faq/"), ("xyz", "/")],
            )
        index_readers(self.conn)
        paths = self.paths()
        self.assertEqual(paths[("weekly", "/faq/")][0], "site-faq")
        self.assertEqual(paths[("xyz", "/")][0], "thing-index")

    def test_a_shared_address_and_the_home_page_stay_unattributed(self):
        paths = self.paths()
        self.assertIsNone(paths[("www", "/2014/12/21/010000.html")][0])
        self.assertIsNone(paths[("weekly", "/")][0])


class ReadersExportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = _library(Path(self.tmp.name))

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_an_issue_carries_views_opens_reads_and_kudos(self):
        wt12 = readers_export(self.conn)["sources"]["wt-12"]
        self.assertEqual(wt12["site"], "weekly")
        self.assertEqual(wt12["views"]["total"], 9)
        self.assertEqual(wt12["views"]["months"], {"2026-02": 5, "2026-10": 4})
        self.assertEqual(wt12["views"]["days"], {"2026-10-20": 3, "2026-10-21": 1})
        self.assertEqual(wt12["email_opens"]["total"], 40)
        self.assertEqual(wt12["feed_reads"]["total"], 2)
        self.assertEqual(wt12["kudos"], ["2026-10-20"])

    def test_days_cover_only_the_last_ninety_and_months_everything(self):
        blog = readers_export(self.conn)["sources"]["blog-1"]["views"]
        self.assertEqual(blog["total"], 12)
        self.assertEqual(blog["months"], {"2024-07": 10, "2026-10": 2})
        self.assertEqual(blog["days"], {"2026-10-21": 2})

    def test_a_kudo_is_dated_by_its_central_day(self):
        # 03:00 UTC on 2 October is the evening of 1 October in Chicago.
        self.assertEqual(readers_export(self.conn)["sources"]["blog-1"]["kudos"], ["2026-10-01"])

    def test_sites_say_when_tracking_began(self):
        sites = readers_export(self.conn)["sites"]
        self.assertEqual(sites["www"], {"tracked_since": "2024-07-09", "through": "2026-10-21"})

    def test_each_corpus_carries_only_its_own_sources(self):
        export = readers_export(self.conn)
        self.assertEqual(
            sorted(corpus_readers(export, "corpus")["sources"]),
            ["site-members", "thing-otto", "wt-12", "wt-53"],
        )
        self.assertEqual(
            sorted(corpus_readers(export, "blog_corpus")["sources"]),
            ["blog-1", "blog-4", "page-9"],
        )
        self.assertEqual(sorted(corpus_readers(export, "podcast_corpus")["sources"]), ["ep-1"])

    def test_a_count_makes_only_its_own_corpus_stale(self):
        before = fingerprints(self.conn)
        store_days(
            self.conn, "www", "2026-10-21", "2026-10-21", {("/2024/07/10/a.html", "2026-10-21"): 3}
        )
        after = fingerprints(self.conn)
        self.assertNotEqual(before["blog_corpus"], after["blog_corpus"])
        self.assertEqual(before["corpus"], after["corpus"])
        self.assertEqual(before["podcast_corpus"], after["podcast_corpus"])

    def test_the_export_writes_them_and_the_build_carries_them(self):
        tree = Path(self.tmp.name) / "tree"
        export_tree(self.conn, tree)
        written = json.loads((tree / "librarian" / "readers.json").read_text())
        self.assertIn("ep-1", written["sources"])
        episodes = tree / "podcast" / "another-thing" / "episodes"
        episodes.mkdir(parents=True, exist_ok=True)
        corpus = build_podcast_corpus(episodes, readers_path=tree / "librarian" / "readers.json")
        self.assertEqual(list(corpus["readers"]["sources"]), ["ep-1"])
        self.assertEqual(corpus["readers"]["sources"]["ep-1"]["views"]["total"], 9)

    def test_a_tree_without_numbers_builds_without_them(self):
        missing = Path(self.tmp.name) / "none.json"
        episodes = Path(self.tmp.name) / "episodes"
        episodes.mkdir()
        self.assertNotIn("readers", build_podcast_corpus(episodes, readers_path=missing))


class FakeTinylytics:
    """Answers the three endpoints the pull reads, paging by ``per``."""

    def __init__(self, hits, kudos=(), per=2, created=None):
        self.hits = hits
        self.kudos = list(kudos)
        self.per = per
        self.created = created or {}
        self.calls = []

    def __call__(self, path, query):
        self.calls.append((path, dict(query)))
        if path == "/sites":
            return {
                "sites": [
                    {"id": site_id, "created_at": f"{day}T15:00:00Z"}
                    for site_id, day in self.created.items()
                ]
            }
        site_id = int(path.split("/")[2])
        rows = self.hits if path.endswith("/hits") else self.kudos
        rows = [
            row
            for row in rows
            if row.get("site", 1521) == site_id
            and query["start_date"] <= row["created_at"][:10] <= query["end_date"]
        ]
        page = query["page"]
        shown = rows[(page - 1) * self.per : page * self.per]
        key = "hits" if path.endswith("/hits") else "kudos"
        pages = max(1, -(-len(rows) // self.per))
        return {key: shown, "pagination": {"total_pages": pages}}


class TinylyticsPullTest(unittest.TestCase):
    def test_hits_are_counted_by_central_day_once_each(self):
        hits = [
            {"id": 1, "path": "/a/", "created_at": "2026-10-02T04:30:00Z"},  # 1 Oct, Chicago
            {"id": 2, "path": "/a/", "created_at": "2026-10-02T13:00:00Z"},
            {"id": 2, "path": "/a/", "created_at": "2026-10-02T13:00:00Z"},  # a shifted page
            {"id": 3, "path": "/b/", "created_at": "2026-10-03T06:00:00Z"},  # outside
            {"id": 4, "path": "/a/", "created_at": "2026-09-30T12:00:00Z"},  # outside
        ]
        counts = tinylytics.day_counts(
            FakeTinylytics(hits), 1521, date(2026, 10, 1), date(2026, 10, 2)
        )
        self.assertEqual(counts, {("/a/", "2026-10-01"): 1, ("/a/", "2026-10-02"): 1})

    def test_a_long_history_is_read_in_windows_the_api_accepts(self):
        fake = FakeTinylytics([])
        tinylytics.day_counts(fake, 1521, date(2024, 7, 9), date(2026, 10, 21))
        windows = [(q["start_date"], q["end_date"]) for _path, q in fake.calls]
        self.assertGreater(len(windows), 2)
        for start, end in windows:
            self.assertLessEqual((date.fromisoformat(end) - date.fromisoformat(start)).days, 730)
        self.assertEqual(windows[0][0], "2024-07-08")
        self.assertEqual(windows[-1][1], "2026-10-22")

    def test_the_first_pull_reads_from_tracking_and_the_next_rereads_three_days(self):
        with tempfile.TemporaryDirectory() as tmp:
            conn = _library(Path(tmp))
            with conn:
                conn.execute("DELETE FROM reader_sites")
                conn.execute("DELETE FROM reader_days")
                conn.execute("DELETE FROM kudos")
            hits = [
                {
                    "id": 1,
                    "site": 3063,
                    "path": "/archive/12/",
                    "created_at": "2026-10-20T15:00:00Z",
                },
                {"id": 2, "site": 1521, "path": "/about/", "created_at": "2026-10-21T15:00:00Z"},
                {"id": 3, "site": 1521, "path": "/about/", "created_at": "2026-10-22T15:00:00Z"},
            ]
            kudos = [
                {
                    "id": 9,
                    "site": 3063,
                    "path": "/archive/12/",
                    "created_at": "2026-10-20T16:00:00Z",
                }
            ]
            fake = FakeTinylytics(
                hits,
                kudos,
                created={
                    1521: "2024-07-09",
                    3063: "2026-01-08",
                    3059: "2026-01-05",
                    3823: "2026-10-13",
                },
            )
            report = tinylytics.pull_readers(conn, fake, today=date(2026, 10, 22))
            self.assertEqual(report["weekly"]["from"], "2026-01-08")
            self.assertEqual(report["www"]["through"], "2026-10-21")
            self.assertEqual(report["www"]["views"], 1)  # today's hit waits for tomorrow
            export = readers_export(conn)
            self.assertEqual(export["sources"]["wt-12"]["views"]["total"], 1)
            self.assertEqual(export["sources"]["wt-12"]["kudos"], ["2026-10-20"])
            self.assertEqual(export["sources"]["page-9"]["views"]["total"], 1)

            fake.calls.clear()
            report = tinylytics.pull_readers(conn, fake, today=date(2026, 10, 23))
            self.assertEqual(report["www"]["from"], "2026-10-19")
            self.assertEqual(readers_export(conn)["sources"]["page-9"]["views"]["total"], 2)
            self.assertNotIn("/sites", [path for path, _q in fake.calls])
            conn.close()

    def test_a_page_that_is_not_json_is_a_bad_key(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b"<!DOCTYPE html><html>"
        with mock.patch.object(tinylytics.urllib.request, "urlopen", return_value=response):
            with self.assertRaisesRegex(LibraryError, "not JSON"):
                tinylytics.http_fetch("tly-ro-x")("/sites", {})

    def test_no_key_is_an_error_not_an_empty_pull(self):
        with mock.patch.dict(tinylytics.os.environ, {"TINYLYTICS_API_KEY": ""}):
            with self.assertRaisesRegex(LibraryError, "TINYLYTICS_API_KEY"):
                tinylytics.api_key()


if __name__ == "__main__":
    unittest.main()
