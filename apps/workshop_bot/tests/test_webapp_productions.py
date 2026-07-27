"""Web app newsletter issue registry.

Drives the real aiohttp app (routes + identity middleware) over a TestClient
against a temp DB. The Studio web surface is now newsletter-only.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))

from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

from apps.workshop_bot.tests import test_pure_helpers  # noqa: F401, E402
from apps.workshop_bot.tools import db  # noqa: E402
from apps.workshop_bot.webapp import routes, server  # noqa: E402

LOGIN = "jthingelstad@github"
H = {server.IDENTITY_HEADER: LOGIN}


class WebappProductionsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self._orig = os.environ.get("WORKSHOP_DB_PATH")
        os.environ["WORKSHOP_DB_PATH"] = str(Path(self._tmpdir.name) / "test.db")
        os.environ.setdefault("TAILSCALE_ALLOWED_LOGIN", LOGIN)
        db.run_migrations()

    def tearDown(self):
        if self._orig is None:
            os.environ.pop("WORKSHOP_DB_PATH", None)
        else:
            os.environ["WORKSHOP_DB_PATH"] = self._orig
        self._tmpdir.cleanup()

    async def _client(self):
        app = web.Application(middlewares=[server._identity_mw])
        app[server.DEPS] = None
        routes.add_routes(app)
        client = TestClient(TestServer(app))
        await client.start_server()
        self.addAsyncCleanup(client.close)
        return client

    async def test_create_newsletter_issue_records_creator_and_redirects(self):
        c = await self._client()
        r = await c.post(
            "/productions/new",
            headers=H,
            allow_redirects=False,
            data={
                "production_type": "newsletter",
                "title": "WT360",
                "seq": "360",
                "pub_date": "2026-07-11",
                "day_count": "7",
            },
        )
        self.assertEqual(r.status, 302)
        self.assertEqual(r.headers["Location"], "/productions/WT360")
        row = db.get_production("WT360")
        self.assertEqual(row["created_by"], LOGIN)
        self.assertEqual(row["production_type"], "newsletter")
        self.assertEqual(row["phase"], "planned")

    async def test_new_form_and_edit_form_render(self):
        c = await self._client()
        self.assertEqual((await c.get("/productions/new", headers=H)).status, 200)
        db.create_production(production_type="newsletter", title="WT360", seq=360)
        r = await c.get("/productions/WT360/edit", headers=H)
        self.assertIn("WT360", await r.text())

    async def test_edit_changes_newsletter_phase(self):
        c = await self._client()
        db.plan_issue_window(
            issue_number=360,
            pub_date="2026-07-11",
            end_date="2026-07-10",
            start_date="2026-07-03",
            day_count=7,
        )
        r = await c.post(
            "/productions/WT360/edit",
            headers=H,
            allow_redirects=False,
            data={"title": "WT360 edited", "phase": "write"},
        )
        self.assertEqual(r.status, 302)
        row = db.get_production("WT360")
        self.assertEqual(row["phase"], "write")
        self.assertEqual(row["title"], "WT360 edited")

    async def test_list_hides_shipped_archive_by_default(self):
        c = await self._client()
        db.create_production(production_type="newsletter", title="WT360", seq=360)
        db.create_production(
            production_type="newsletter", title="WT359", seq=359, phase="share", status="done"
        )
        body = await (await c.get("/productions", headers=H)).text()
        self.assertIn("WT360", body)
        self.assertNotIn("WT359", body)
        self.assertIn("1 shipped", body)
        all_body = await (await c.get("/productions?all=1", headers=H)).text()
        self.assertIn("WT359", all_body)

    async def test_bulk_status_pauses_selected(self):
        c = await self._client()
        db.create_production(production_type="newsletter", title="WT360", seq=360)
        db.create_production(production_type="newsletter", title="WT361", seq=361)
        r = await c.post(
            "/productions/bulk-status",
            headers=H,
            allow_redirects=False,
            data=[("action", "pause"), ("pid", "WT360")],
        )
        self.assertEqual(r.status, 302)
        self.assertEqual(db.get_production("WT360")["status"], "paused")
        self.assertEqual(db.get_production("WT361")["status"], "active")

    async def test_single_status_route_and_validation(self):
        c = await self._client()
        db.create_production(production_type="newsletter", title="WT360", seq=360)
        r = await c.post(
            "/productions/WT360/status", headers=H, allow_redirects=False, data={"status": "paused"}
        )
        self.assertEqual(r.status, 302)
        self.assertEqual(db.get_production("WT360")["status"], "paused")
        r = await c.post(
            "/productions/WT360/status", headers=H, allow_redirects=False, data={"status": "bogus"}
        )
        self.assertEqual(r.status, 400)
        r = await c.post(
            "/productions/WT999/status", headers=H, allow_redirects=False, data={"status": "paused"}
        )
        self.assertEqual(r.status, 404)

    async def test_invalid_create_inputs_are_400(self):
        c = await self._client()
        r = await c.post(
            "/productions/new",
            headers=H,
            allow_redirects=False,
            data={"production_type": "article", "title": "x"},
        )
        self.assertEqual(r.status, 400)
        r = await c.post(
            "/productions/new",
            headers=H,
            allow_redirects=False,
            data={"production_type": "newsletter", "title": ""},
        )
        self.assertEqual(r.status, 400)
        r = await c.post(
            "/productions/new",
            headers=H,
            allow_redirects=False,
            data={
                "production_type": "newsletter",
                "title": "WT360",
                "seq": "360",
                "pub_date": "2026-07-10",
            },
        )
        self.assertEqual(r.status, 400)

    async def test_foreign_origin_post_is_403(self):
        c = await self._client()
        r = await c.post(
            "/productions/new",
            headers={**H, "Origin": "https://evil.example"},
            allow_redirects=False,
            data={"production_type": "newsletter", "title": "WT360"},
        )
        self.assertEqual(r.status, 403)

    async def test_no_identity_is_403(self):
        c = await self._client()
        r = await c.get("/productions", allow_redirects=False)
        self.assertEqual(r.status, 403)

    async def test_edit_unknown_production_is_404(self):
        c = await self._client()
        r = await c.get("/productions/WT999/edit", headers=H, allow_redirects=False)
        self.assertEqual(r.status, 404)

    async def test_publish_ack_requires_buttondown_before_delivery_confirmation(self):
        c = await self._client()
        db.plan_issue_window(
            issue_number=360,
            pub_date="2026-07-11",
            end_date="2026-07-10",
            start_date="2026-07-03",
            day_count=7,
        )
        r = await c.post(
            "/productions/WT360/publish-ack",
            headers=H,
            allow_redirects=False,
            data={"action": "confirm-email"},
        )
        self.assertEqual(r.status, 400)

    async def test_publish_ack_records_audio_waiver(self):
        c = await self._client()
        db.plan_issue_window(
            issue_number=360,
            pub_date="2026-07-11",
            end_date="2026-07-10",
            start_date="2026-07-03",
            day_count=7,
        )
        r = await c.post(
            "/productions/WT360/publish-ack",
            headers=H,
            allow_redirects=False,
            data={"action": "waive-audio"},
        )
        self.assertEqual(r.status, 302)
        self.assertEqual(db.get_publish_legs(360)["audio"]["status"], "waived")


if __name__ == "__main__":
    unittest.main()
