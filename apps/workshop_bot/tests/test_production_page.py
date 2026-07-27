"""The per-production web page /productions/{id} — the work surface."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))

from apps.workshop_bot.tests import _stubs  # noqa: E402

_stubs.install()

from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

from apps.workshop_bot.tests._fixtures import FakeWorkspace, patch_s3  # noqa: E402
from apps.workshop_bot.tools import content_store, db, issue_items  # noqa: E402
from apps.workshop_bot.tools.db.connection import connect  # noqa: E402
from apps.workshop_bot.webapp import routes, server  # noqa: E402

LOGIN = "jthingelstad@github"
H = {server.IDENTITY_HEADER: LOGIN}


class ProductionPageTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig = os.environ.get("WORKSHOP_DB_PATH")
        os.environ["WORKSHOP_DB_PATH"] = str(Path(self._tmp.name) / "t.db")
        os.environ.setdefault("TAILSCALE_ALLOWED_LOGIN", LOGIN)
        db.run_migrations()
        self.ws = FakeWorkspace()
        self._patchers = patch_s3(self.ws)
        for p in self._patchers:
            p.start()

    def tearDown(self):
        for p in self._patchers:
            p.stop()
        if self._orig is None:
            os.environ.pop("WORKSHOP_DB_PATH", None)
        else:
            os.environ["WORKSHOP_DB_PATH"] = self._orig
        self._tmp.cleanup()

    async def _client(self):
        app = web.Application(middlewares=[server._identity_mw])
        app[server.DEPS] = None
        routes.add_routes(app)
        client = TestClient(TestServer(app))
        await client.start_server()
        self.addAsyncCleanup(client.close)
        return client

    async def test_planned_page_offers_start_working(self):
        c = await self._client()
        db.plan_issue_window(
            issue_number=360,
            pub_date="2026-06-27",
            end_date="2026-06-26",
            start_date="2026-06-19",
            day_count=7,
        )
        body = await (await c.get("/productions/WT360", headers=H)).text()
        self.assertIn("Start working", body)
        self.assertNotIn(">Content<", body)  # no editing until started
        self.assertIn("Next action", body)
        self.assertIn("Thursday target 2026-06-25", body)
        self.assertIn("Sources never synced", body)

    async def test_empty_home_proposes_computed_post_break_issue(self):
        c = await self._client()
        body = await (await c.get("/productions", headers=H)).text()
        self.assertIn("Next issue: WT1", body)
        form = await (await c.get("/productions/new", headers=H)).text()
        self.assertIn('name="seq" min="1" value="1"', form)

    async def test_build_page_edits_content(self):
        c = await self._client()
        db.plan_issue_window(
            issue_number=360,
            pub_date="2026-06-27",
            end_date="2026-06-26",
            start_date="2026-06-19",
            day_count=7,
        )
        db.set_issue_phase(360, "build")
        # save the intro via the atom handler
        r = await c.post(
            "/productions/WT360/atom",
            headers=H,
            allow_redirects=False,
            data={"name": "intro.md", "value": "Hello intro"},
        )
        self.assertEqual(r.status, 302)
        self.assertEqual(content_store.read_issue(360, "intro.md"), "Hello intro")
        body = await (await c.get("/productions/WT360", headers=H)).text()
        self.assertIn("Hello intro", body)
        self.assertIn(">Issue Canvas<", body)
        self.assertIn(">Edit text<", body)
        self.assertNotIn(">Content<", body)

    async def test_currently_and_cover_handlers(self):
        c = await self._client()
        db.plan_issue_window(
            issue_number=360,
            pub_date="2026-06-27",
            end_date="2026-06-26",
            start_date="2026-06-19",
            day_count=7,
        )
        db.set_issue_phase(360, "build")
        await c.post(
            "/productions/WT360/currently",
            headers=H,
            allow_redirects=False,
            data={"op": "set", "label": "Reading", "value": "A book"},
        )
        self.assertEqual(
            [(e["type_label"], e["value"]) for e in db.currently_get_entries(360)],
            [("Reading", "A book")],
        )
        await c.post(
            "/productions/WT360/cover",
            headers=H,
            allow_redirects=False,
            data={"caption": "A creek", "location": "MPLS", "timestamp": "", "alt": ""},
        )
        import json

        self.assertEqual(
            json.loads(content_store.read_issue(360, "cover.json"))["caption"], "A creek"
        )

    async def test_editorial_comment_can_be_resolved_in_page(self):
        c = await self._client()
        db.plan_issue_window(
            issue_number=360,
            pub_date="2026-06-27",
            end_date="2026-06-26",
            start_date="2026-06-19",
            day_count=7,
        )
        db.set_issue_phase(360, "build")
        comment = issue_items.write_comment(
            issue_number=360,
            scope="issue",
            body_md="Clarify the ending.",
        )
        body = await (await c.get("/productions/WT360", headers=H)).text()
        self.assertIn("Clarify the ending.", body)
        self.assertIn(">Resolve<", body)
        response = await c.post(
            "/productions/WT360/comments/resolve",
            headers=H,
            allow_redirects=False,
            data={"comment_id": str(comment["id"]), "return_to": "#eddy-notes"},
        )
        self.assertEqual(response.status, 302)
        self.assertEqual(issue_items.list_open_comments(360), [])

    async def test_package_surface_edits_haiku_and_echoes(self):
        c = await self._client()
        db.plan_issue_window(
            issue_number=360,
            pub_date="2026-06-27",
            end_date="2026-06-26",
            start_date="2026-06-19",
            day_count=7,
        )
        db.set_issue_phase(360, "build")
        body = await (await c.get("/productions/WT360", headers=H)).text()
        self.assertIn(">Package<", body)
        self.assertIn("generated option · Jamie-selected", body)
        await c.post(
            "/productions/WT360/atom",
            headers=H,
            allow_redirects=False,
            data={"name": "haiku.md", "value": "Three quiet lines"},
        )
        self.assertEqual(content_store.read_issue(360, "haiku.md"), "Three quiet lines")

    async def test_legacy_non_newsletter_page_is_gone(self):
        c = await self._client()
        with connect() as conn:
            conn.execute(
                "INSERT INTO productions (id, production_type, seq, title, phase, status) "
                "VALUES ('ART1', 'article', 1, 'legacy article', 'draft', 'active')"
            )
        r = await c.get("/productions/ART1", headers=H)
        self.assertEqual(r.status, 410)

    async def test_foreign_origin_post_is_403(self):
        c = await self._client()
        db.plan_issue_window(
            issue_number=360,
            pub_date="2026-06-27",
            end_date="2026-06-26",
            start_date="2026-06-19",
            day_count=7,
        )
        db.set_issue_phase(360, "build")
        r = await c.post(
            "/productions/WT360/atom",
            headers={**H, "Origin": "https://evil.example"},
            allow_redirects=False,
            data={"name": "intro.md", "value": "y"},
        )
        self.assertEqual(r.status, 403)


if __name__ == "__main__":
    unittest.main()
