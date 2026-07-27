"""Web app routes.

- ``/``                       current newsletter issue, or the issue list.
- ``/productions``           newsletter issue registry (legacy route name).

Forms POST to handlers that route through the same ``db`` helpers + jobs the
Discord surface uses, so the web app and the agents edit the same rows. Identity
is guaranteed by the server middleware; writes additionally require a same-origin
POST (the only residual CSRF vector behind the tailnet + Tailscale-identity gate).
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, timedelta

from aiohttp import web

from apps.librarian.admin import dashboard_data

from ..jobs import _base, production_ops, production_state, publish, put_to_bed, start_issue
from ..tools import content_store, db, issue_items, issue_items_render, s3
from ..tools.content import atoms_view
from ..tools.content import production_types as ptypes
from . import issue_workflow, server
from .render import render


def _login(request: web.Request) -> str:
    """The signed-in Tailscale login (guaranteed present by the middleware)."""
    return request.headers.get(server.IDENTITY_HEADER, "")


def _same_origin(request: web.Request) -> bool:
    """Reject cross-origin POSTs. There's no cookie/session to anchor a CSRF
    token on (the gate is the tailnet + identity header), so an Origin/Referer
    allowlist closes the one residual vector at near-zero cost. A same-origin
    form post (or a non-browser client) typically omits Origin → allowed."""
    origin = request.headers.get("Origin") or request.headers.get("Referer") or ""
    if not origin:
        return True
    return origin.startswith(f"https://{request.host}") or origin.startswith(
        f"http://{request.host}"
    )


# ---------- home ----------


async def healthz(request: web.Request) -> web.Response:
    return web.Response(text="ok\n")


async def home_page(request: web.Request) -> web.Response:
    win = await asyncio.to_thread(db.get_active_issue_window)
    if win:
        raise web.HTTPFound(f"/productions/WT{int(win['issue_number'])}")
    raise web.HTTPFound("/productions")


# ---------- Thingy / Librarian operations ----------


def _thingy_days(value: str) -> int:
    try:
        days = int(value or 90)
    except ValueError:
        return 90
    return days if days in {30, 90, 180} else 90


async def thingy_page(request: web.Request) -> web.Response:
    """Read-only Thingy/Librarian health inside Studio's tailnet boundary."""

    days = _thingy_days(request.query.get("days", "90"))
    refresh = request.query.get("refresh") == "1"
    dashboard = await asyncio.to_thread(
        dashboard_data.load_dashboard, days=days, force_refresh=refresh
    )

    priority = request.query.get("priority", "all")
    if priority not in {"all", "action", "regression", "critical", "high", "medium", "low"}:
        priority = "all"
    mode = request.query.get("mode", "all")
    if mode != "all" and mode not in dashboard.modes:
        mode = "all"
    scope = request.query.get("scope", "__all")
    if scope != "__all" and scope not in dashboard.scopes:
        scope = "__all"

    findings = list(dashboard.findings)
    if priority == "action":
        findings = [item for item in findings if item.priority in {"critical", "high"}]
    elif priority == "regression":
        findings = [item for item in findings if item.regression_candidate]
    elif priority != "all":
        findings = [item for item in findings if item.priority == priority]
    if mode != "all":
        findings = [item for item in findings if mode in item.modes]
    if scope != "__all":
        findings = [item for item in findings if scope in item.scopes]

    return render(
        "thingy.html",
        request,
        dashboard=dashboard,
        findings=findings,
        priority=priority,
        selected_mode=mode,
        selected_scope=scope,
    )


# ---------- newsletter issue registry (add / edit) ----------

# Ordered (key, label) for the type selector / list grouping.
_TYPE_ORDER = ("newsletter",)
_PHASES_JSON = json.dumps({k: list(ptypes.phases_for(k)) for k in _TYPE_ORDER})


async def productions_list(request: web.Request) -> web.Response:
    # The working view shows in-flight issues by default; the shipped archive is
    # tucked behind ?all=1 so the page doesn't drown in 14 years of done issues.
    show_all = request.query.get("all") == "1"
    rows = await asyncio.to_thread(db.list_productions, limit=2000)
    groups = []
    for key in _TYPE_ORDER:
        pt = ptypes.PRODUCTION_TYPES[key]
        items = [r for r in rows if r["production_type"] == key]
        # Working view: active first, then paused (shelved but findable).
        # done/archived/abandoned live behind ?all=1.
        working = [r for r in items if r["status"] == "active"] + [
            r for r in items if r["status"] == "paused"
        ]
        shipped = len(items) - len(working)
        groups.append(
            {
                "key": key,
                "label": pt.label,
                "surface": pt.surface,
                "rows": items if show_all else working,
                "shipped": shipped,
            }
        )
    active = await asyncio.to_thread(db.get_active_issue_window)
    suggestion = None
    if active is None and not show_all:
        suggestion = {
            "seq": await asyncio.to_thread(db.next_production_seq, "newsletter"),
            "pub_date": issue_workflow.suggested_publish_date(),
        }
    return render(
        "productions.html",
        request,
        groups=groups,
        show_all=show_all,
        suggestion=suggestion,
    )


# Bulk lifecycle actions from the registry list (checkbox select → one POST).
_BULK_ACTIONS = {"pause": "paused", "archive": "archived", "activate": "active"}


async def productions_bulk_status(request: web.Request) -> web.Response:
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    data = await request.post()
    login = _login(request)
    status = _BULK_ACTIONS.get(data.get("action", ""))
    if not status:
        raise web.HTTPBadRequest(text=f"unknown bulk action: {data.get('action')!r}")
    pids = [p for p in data.getall("pid", []) if p]
    for pid in pids:
        row = await asyncio.to_thread(db.get_production, pid)
        if row:
            await asyncio.to_thread(db.update_production, pid, status=status, updated_by=login)
    raise web.HTTPFound("/productions")


async def production_status(request: web.Request) -> web.Response:
    """Single-production quick status change (buttons on the production page)."""
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    pid = request.match_info["pid"]
    data = await request.post()
    status = (data.get("status") or "").strip()
    if not ptypes.is_valid_status(status):
        raise web.HTTPBadRequest(text=f"unknown status: {status!r}")
    row = await asyncio.to_thread(db.get_production, pid)
    if not row:
        raise web.HTTPNotFound(text=f"no such production: {pid}")
    await asyncio.to_thread(db.update_production, pid, status=status, updated_by=_login(request))
    raise web.HTTPFound(f"/productions/{pid}")


def _render_form(request, *, mode, row=None, error=None, status=200, defaults=None):
    types = [(k, ptypes.PRODUCTION_TYPES[k].label) for k in _TYPE_ORDER]
    return render(
        "production_form.html",
        request,
        status=status,
        mode=mode,
        row=row,
        error=error,
        types=types,
        phases_json=_PHASES_JSON,
        statuses=ptypes.STATUSES,
        defaults=defaults or {},
    )


async def production_new_form(request: web.Request) -> web.Response:
    defaults = {
        "seq": await asyncio.to_thread(db.next_production_seq, "newsletter"),
        "pub_date": issue_workflow.suggested_publish_date(),
    }
    return _render_form(request, mode="new", defaults=defaults)


async def production_edit_form(request: web.Request) -> web.Response:
    pid = request.match_info["pid"]
    row = await asyncio.to_thread(db.get_production, pid)
    if not row:
        raise web.HTTPNotFound(text=f"no such production: {pid}")
    return _render_form(request, mode="edit", row=row)


async def production_create(request: web.Request) -> web.Response:
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    data = await request.post()
    login = _login(request)
    ptype = data.get("production_type", "newsletter") or "newsletter"
    title = (data.get("title") or "").strip()
    if ptype not in ptypes.PRODUCTION_TYPES:
        return _render_form(request, mode="new", error="Unknown production type.", status=400)
    if not title:
        return _render_form(request, mode="new", error="Title is required.", status=400)

    # Define the newsletter as *planned* — a DB row only, no workspace.
    # "Start working" (on the issue page) opens the live pipeline later.
    try:
        seq = int(data.get("seq") or 0)
    except TypeError, ValueError:
        return _render_form(
            request, mode="new", error="Issue number must be an integer.", status=400
        )
    pub_date = (data.get("pub_date") or "").strip()
    day_count = int(data.get("day_count") or 7)
    ctx = _base.JobContext(deps=request.app.get(server.DEPS), trigger="web")
    res = await start_issue.define(
        ctx, number=seq, pub_date=pub_date, day_count=day_count, set_by=login or "web"
    )
    if not res.ok:
        return _render_form(request, mode="new", error=res.message, status=400)
    raise web.HTTPFound(f"/productions/WT{seq}")


async def production_update(request: web.Request) -> web.Response:
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    pid = request.match_info["pid"]
    data = await request.post()
    login = _login(request)
    row = await asyncio.to_thread(db.get_production, pid)
    if not row:
        raise web.HTTPNotFound(text=f"no such production: {pid}")
    ptype = row["production_type"]
    title = (data.get("title") or "").strip() or None
    phase = data.get("phase") or None

    try:
        if ptype != "newsletter":
            raise ValueError("Studio only supports newsletter issues.")
        # Phase changes go through the window (set_issue_phase mirrors the
        # registry); the live publish state stays authoritative in issue_windows.
        if phase and phase != row["phase"]:
            await asyncio.to_thread(db.set_issue_phase, int(row["seq"]), phase)
        await asyncio.to_thread(db.update_production, pid, title=title, updated_by=login)
    except ValueError as exc:
        return _render_form(request, mode="edit", row=row, error=str(exc), status=400)
    raise web.HTTPFound("/productions")


# ---------- the atom editor (build 1: read-side projection + skeleton) ----------

# Authored atoms whose body the editor may write (content_store names).
_EDITOR_ATOM_NAMES = atoms_view.AUTHORED_NAMES


async def _load_newsletter(request: web.Request) -> tuple[dict, int]:
    """The (production row, issue_number) pair for an editor route; 404 on a
    missing production, 400 on a non-newsletter (build 1 is newsletter-only)."""
    pid = request.match_info["pid"]
    row = await asyncio.to_thread(db.get_production, pid)
    if not row:
        raise web.HTTPNotFound(text=f"no such production: {pid}")
    if row["production_type"] != "newsletter":
        raise web.HTTPBadRequest(text="the atom editor is newsletter-only (build 1)")
    return row, int(row["seq"])


async def editor_page(request: web.Request) -> web.Response:
    row, n = await _load_newsletter(request)
    atoms = await asyncio.to_thread(atoms_view.build, n, row["id"])
    groups = _atom_groups(atoms)
    return render("editor.html", request, row=row, issue_number=n, groups=groups)


def _editor_url(row: dict) -> str:
    return f"/productions/{row['id']}/editor"


def _atom_groups(atoms: list[dict]) -> list[dict]:
    groups: list[dict] = []
    for a in atoms:
        if not groups or groups[-1]["kind"] != a["kind"]:
            groups.append({"kind": a["kind"], "atoms": []})
        groups[-1]["atoms"].append(a)
    return groups


def _post_return(row: dict, data, default: str) -> str:
    target = (data.get("return_to") or "").strip()
    base = f"/productions/{row['id']}"
    if target == base or target.startswith(f"{base}#") or target.startswith(f"{base}/"):
        return target
    return default


async def editor_atom_save(request: web.Request) -> web.Response:
    """Save an atom body from the editor or live issue canvas."""
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    row, n = await _load_newsletter(request)
    data = await request.post()
    key = (data.get("key") or "").strip()
    value = data.get("value") or ""
    login = _login(request)
    if key.startswith("content:"):
        name = key[len("content:") :]
        if name not in _EDITOR_ATOM_NAMES:
            raise web.HTTPBadRequest(text=f"not an editor-writable atom: {name!r}")
        await asyncio.to_thread(content_store.set, row["id"], name, value, by=f"web:{login}")
    elif key.startswith("currently:"):
        label = key[len("currently:") :]
        try:
            await asyncio.to_thread(db.currently_set_entry, n, label, value)
        except ValueError as exc:
            raise web.HTTPBadRequest(text=str(exc))
    elif key.startswith("item:"):
        try:
            item_id = int(key[len("item:") :])
            item = await asyncio.to_thread(issue_items.get_item, item_id)
            if not item or int(item["issue_number"]) != n:
                raise ValueError(f"item_id={item_id!r} not found for WT{n}")
            override = None if data.get("clear_override") == "1" else value
            await asyncio.to_thread(issue_items.set_body_override, item_id, override)
        except ValueError as exc:
            raise web.HTTPBadRequest(text=str(exc))
    else:
        raise web.HTTPBadRequest(text=f"unknown atom key: {key!r}")
    raise web.HTTPFound(_post_return(row, data, _editor_url(row)))


async def editor_item_flip(request: web.Request) -> web.Response:
    """The promotion verb, briefly ↔ notable: sets the editor-owned
    section_override ('clear' reverts to the sync-owned section)."""
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    row, _ = await _load_newsletter(request)
    data = await request.post()
    target = (data.get("target") or "").strip()
    try:
        item_id = int(data.get("item_id") or 0)
        await asyncio.to_thread(
            issue_items.set_section_override, item_id, None if target == "clear" else target
        )
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc))
    raise web.HTTPFound(_post_return(row, data, _editor_url(row)))


async def editor_item_select(request: web.Request) -> web.Response:
    """Select / deselect a derived atom (the Journal filter — reversible)."""
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    row, _ = await _load_newsletter(request)
    data = await request.post()
    try:
        item_id = int(data.get("item_id") or 0)
        await asyncio.to_thread(issue_items.set_excluded, item_id, data.get("selected") == "0")
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc))
    raise web.HTTPFound(_post_return(row, data, _editor_url(row)))


async def editor_item_move(request: web.Request) -> web.Response:
    """Up/down within the atom's effective section (edges are a no-op)."""
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    row, _ = await _load_newsletter(request)
    data = await request.post()
    try:
        item_id = int(data.get("item_id") or 0)
        await asyncio.to_thread(issue_items.move_item, item_id, (data.get("dir") or "").strip())
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc))
    raise web.HTTPFound(_post_return(row, data, _editor_url(row)))


# ---------- the production page (the work surface) ----------


def _ctx(request):
    return _base.JobContext(deps=request.app.get(server.DEPS), trigger="web")


def _json_content(get_value: str) -> dict:
    try:
        return json.loads(get_value) if (get_value or "").strip() else {}
    except ValueError, TypeError:
        return {}


def _newsletter_page_data(row) -> dict:
    n = int(row["seq"])
    phase = row["phase"]
    state = (
        production_state.publish_state(n)
        if phase in ("publish", "share")
        else production_state.build_state(n)
    )
    atoms = atoms_view.build(n, row["id"])
    window = db.get_active_issue_window(n) or {}
    source_sync = db.get_source_sync(n)
    next_action = issue_workflow.next_action(row=row, state=state, source_sync=source_sync)
    thursday_target = ""
    try:
        thursday_target = (
            date.fromisoformat(window.get("pub_date", "")) - timedelta(days=2)
        ).isoformat()
    except ValueError:
        pass
    return {
        "row": row,
        "ptype": "newsletter",
        "n": n,
        "phase": phase,
        "state": state,
        "atoms": atoms,
        "atom_groups": _atom_groups(atoms),
        "notable_preamble": issue_items_render.reddit_tag_line(n),
        "cover": _json_content(content_store.read_issue(n, "cover.json") or ""),
        "meta": _json_content(content_store.read_issue(n, "metadata.json") or ""),
        "currently": db.currently_get_entries(n),
        "currently_types": [t["label"] for t in db.currently_list_types()],
        "comments": issue_items.list_open_comments(n),
        "window": window,
        "source_sync": source_sync,
        "next_action": next_action,
        "thursday_target": thursday_target,
        # Live DB render — the DB is the draft (S3 draft.html is retired).
        "review_url": f"/productions/{row['id']}/preview",
        "phases": list(ptypes.phases_for("newsletter")),
    }


async def production_page(request: web.Request) -> web.Response:
    pid = request.match_info["pid"]
    row = await asyncio.to_thread(db.get_production, pid)
    if not row:
        raise web.HTTPNotFound(text=f"no such production: {pid}")
    if row["production_type"] != "newsletter":
        raise web.HTTPGone(text="Studio now only supports newsletter issues.")
    data = await asyncio.to_thread(_newsletter_page_data, row)
    return render("production.html", request, **data)


async def _load_row(request):
    row = await asyncio.to_thread(db.get_production, request.match_info["pid"])
    if not row:
        raise web.HTTPNotFound(text=f"no such production: {request.match_info['pid']}")
    return row


async def production_start(request: web.Request) -> web.Response:
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    row = await _load_row(request)
    if row["production_type"] != "newsletter":
        raise web.HTTPBadRequest(text="only newsletters have a workspace")
    await start_issue.start_working(_ctx(request), int(row["seq"]), set_by=_login(request))
    raise web.HTTPFound(f"/productions/{row['id']}")


async def production_atom_save(request: web.Request) -> web.Response:
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    row = await _load_row(request)
    data = await request.post()
    name = (data.get("name") or "").strip()
    if not name:
        raise web.HTTPBadRequest(text="missing name")
    value = data.get("value") or ""
    await asyncio.to_thread(content_store.set, row["id"], name, value, by=f"web:{_login(request)}")
    # The DB is the draft — a save IS the update. No projection to refire.
    raise web.HTTPFound(f"/productions/{row['id']}")


async def production_cover_save(request: web.Request) -> web.Response:
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    row = await _load_row(request)
    if row["production_type"] != "newsletter":
        raise web.HTTPBadRequest(text="not a newsletter")
    data = await request.post()
    cover = {k: (data.get(k) or "").strip() for k in ("caption", "location", "timestamp", "alt")}
    await asyncio.to_thread(
        content_store.set,
        row["id"],
        "cover.json",
        json.dumps(cover, indent=2),
        by=f"web:{_login(request)}",
    )
    raise web.HTTPFound(f"/productions/{row['id']}")


async def production_meta_save(request: web.Request) -> web.Response:
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    row = await _load_row(request)
    if row["production_type"] != "newsletter":
        raise web.HTTPBadRequest(text="not a newsletter")
    data = await request.post()
    n = int(row["seq"])
    login = _login(request)

    def _save():
        meta = _json_content(content_store.read_issue(n, "metadata.json") or "")
        meta["subject"] = (data.get("subject") or "").strip()
        meta["description"] = (data.get("description") or "").strip()
        content_store.write_issue(n, "metadata.json", json.dumps(meta, indent=2), by=f"web:{login}")

    await asyncio.to_thread(_save)
    raise web.HTTPFound(f"/productions/{row['id']}")


async def production_currently(request: web.Request) -> web.Response:
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    row = await _load_row(request)
    if row["production_type"] != "newsletter":
        raise web.HTTPBadRequest(text="not a newsletter")
    n = int(row["seq"])
    data = await request.post()
    op = data.get("op", "set")
    try:
        if op == "clear":
            await asyncio.to_thread(db.currently_clear_entry, n, data.get("label", ""))
        else:
            await asyncio.to_thread(
                db.currently_set_entry, n, data.get("label", ""), data.get("value", "")
            )
    except Exception:  # noqa: BLE001 — CurrentlyError etc; redirect back regardless
        logging.getLogger("workshop.webapp").warning("currently op failed for %s", row["id"])
    raise web.HTTPFound(f"/productions/{row['id']}")


async def production_phase(request: web.Request) -> web.Response:
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    row = await _load_row(request)
    data = await request.post()
    target = (data.get("phase") or "").strip()
    ctx = _ctx(request)
    try:
        if row["production_type"] != "newsletter":
            raise ValueError("Studio now only supports newsletter issues.")
        n, cur = int(row["seq"]), row["phase"]
        if target == "publish" and cur == "build":
            await production_ops.mark_built(ctx, n)
        elif target == "build" and cur == "publish":
            await production_ops.reopen(ctx, n)
        elif target == "build" and cur in ("planned", "write"):
            await start_issue.start_working(ctx, n, set_by=_login(request))
        else:
            await asyncio.to_thread(db.set_issue_phase, n, target)
    except ValueError as exc:
        raise web.HTTPBadRequest(text=str(exc))
    raise web.HTTPFound(f"/productions/{row['id']}")


async def production_preview(request: web.Request) -> web.Response:
    """Render a production's body as a styled HTML page (for the in-page
    preview iframe). Newsletters render live from current DB state — the DB
    is the draft, there is no stored preview artifact."""
    from ..tools import render, renderers

    row = await _load_row(request)
    pid = row["id"]
    if row["production_type"] != "newsletter":
        raise web.HTTPGone(text="Studio now only supports newsletter issues.")
    body = await asyncio.to_thread(renderers.render_body_for_issue, int(row["seq"]))
    subtitle = f"{pid} · rendered live from the DB"
    html_doc = await asyncio.to_thread(
        render.markdown_to_html_page,
        body or "_(nothing written yet — this is yours to write)_",
        title=row["title"],
        subtitle=subtitle,
    )
    return web.Response(text=html_doc, content_type="text/html")


async def production_publish(request: web.Request) -> web.Response:
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    row = await _load_row(request)
    if row["production_type"] != "newsletter":
        raise web.HTTPBadRequest(text="not a newsletter")
    data = await request.post()
    leg = data.get("leg", "")
    ctx = _ctx(request)
    legs = {
        "email": publish.publish_buttondown,
        "website": publish.publish_website,
        "audio": publish.publish_audio,
        "podcast": publish.publish_audio,  # legacy form value
        "all": publish.publish_all,
    }
    if leg == "bed":
        await put_to_bed.run(ctx, issue_number=int(row["seq"]))
    elif leg in legs:
        await legs[leg](ctx, issue_number=int(row["seq"]))
    raise web.HTTPFound(f"/productions/{row['id']}")


async def production_publish_ack(request: web.Request) -> web.Response:
    """Record the two human decisions the automated legs cannot observe."""
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    row = await _load_row(request)
    if row["production_type"] != "newsletter":
        raise web.HTTPBadRequest(text="not a newsletter")
    n = int(row["seq"])
    data = await request.post()
    action = (data.get("action") or "").strip()
    if action == "confirm-email":
        if not (db.get_issue_window(n) or {}).get("buttondown_id"):
            raise web.HTTPBadRequest(text="create the Buttondown draft first")
        db.publish_leg_set(
            n,
            "email_delivery",
            "succeeded",
            message="Jamie confirmed the Buttondown email is scheduled or sent.",
            evidence={"confirmed_by": _login(request)},
        )
    elif action == "waive-audio":
        db.publish_leg_set(
            n,
            "audio",
            "waived",
            message="Jamie explicitly waived audio for this issue.",
            evidence={"waived_by": _login(request)},
        )
    elif action == "require-audio":
        db.publish_leg_set(n, "audio", "failed", message="Audio waiver removed; publish Audio.")
    else:
        raise web.HTTPBadRequest(text="unknown publish acknowledgment")
    raise web.HTTPFound(f"/productions/{row['id']}")


async def production_sync(request: web.Request) -> web.Response:
    """Refresh issue_items from upstream (Pinboard + micro.blog) — the DB is
    the draft; this is its inbound mirror."""
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    row = await _load_row(request)
    if row["production_type"] != "newsletter":
        raise web.HTTPBadRequest(text="not a newsletter")
    from ..jobs import sync_issue

    await sync_issue.run(_ctx(request))
    raise web.HTTPFound(f"/productions/{row['id']}")


async def production_review(request: web.Request) -> web.Response:
    """Run Eddy's on-demand editorial review (Opus) over the DB-rendered
    draft; anchored comments land in editorial_comments."""
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    row = await _load_row(request)
    if row["production_type"] != "newsletter":
        raise web.HTTPBadRequest(text="not a newsletter")
    from ..jobs import eddy_review

    await eddy_review.run(_ctx(request))
    raise web.HTTPFound(f"/productions/{row['id']}")


async def production_continuity(request: web.Request) -> web.Response:
    """Continuity-while-you-write for the newsletter intro — the highest-value
    writing surface. Surfaces what Jamie has already published on the intro's
    topic (via ``continuity_check``), excluding this issue so it can't match
    itself. Eddy's note lands in #editorial."""
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    row = await _load_row(request)
    if row["production_type"] != "newsletter":
        raise web.HTTPBadRequest(text="continuity check is newsletter-only")
    n = int(row["seq"])
    intro = await asyncio.to_thread(content_store.read_issue, n, "intro.md")
    from ..jobs import continuity_check

    await continuity_check.run_for_text(
        _ctx(request), text=intro or "", label=f"WT{n} intro", exclude_issue=n
    )
    raise web.HTTPFound(f"/productions/{row['id']}")


# Cover uploads: the web replaces the retired iOS-Shortcuts PUT path.
_COVER_MAX_BYTES = 25 * 1024 * 1024


async def production_cover_upload(request: web.Request) -> web.Response:
    """Upload the issue's cover image binary to the S3 workspace
    (``cover.jpg``). Replaces the retired iOS-Shortcuts upload path."""
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    row = await _load_row(request)
    if row["production_type"] != "newsletter":
        raise web.HTTPBadRequest(text="not a newsletter")
    n = int(row["seq"])
    reader = await request.multipart()
    field = await reader.next()
    while field is not None and field.name != "cover":
        field = await reader.next()
    if field is None:
        raise web.HTTPBadRequest(text="no cover file in upload")
    data = await field.read(decode=False)
    if not data:
        raise web.HTTPBadRequest(text="empty upload")
    if len(data) > _COVER_MAX_BYTES:
        raise web.HTTPBadRequest(text="cover too large (25MB max)")
    await asyncio.to_thread(s3.write_issue_binary, n, "cover.jpg", data, "image/jpeg")
    raise web.HTTPFound(f"/productions/{row['id']}")


# ---------- in-web Eddy chat (secondary/ad-hoc) ----------

_CHAT_TASKS: set = set()
_CHAT_PERSONAS = ("eddy",)


def _chat_context_block(context_key: str) -> str:
    """Tell the agent what it's working on, injected ahead of Jamie's message."""
    row = db.get_production(context_key)
    if not row:
        return ""
    names = content_store.list(row["id"])
    return (
        f"## Context — newsletter issue {row['id']} (phase {row['phase']})\n"
        f"Title: {row['title']}. Content blocks: {', '.join(names) or '(none yet)'}. "
        "Jamie writes the prose; you review, package, and help ship the issue."
    )


async def _run_agent_chat(app, context_key: str, persona: str, message: str, prior: list) -> None:
    log = logging.getLogger("workshop.webapp.chat")
    try:
        deps = app.get(server.DEPS)
        team = getattr(deps, "team", None) if deps is not None else None
        bots = getattr(team, "bots", None) if team is not None else None
        bot = bots.get(persona) if isinstance(bots, dict) else (bots.get(persona) if bots else None)
        if bot is None:
            await asyncio.to_thread(
                db.chat_add,
                context_key,
                "assistant",
                "_(Eddy is not reachable from the web app right now.)_",
                persona=persona,
            )
            return
        ctx_block = await asyncio.to_thread(_chat_context_block, context_key)
        history = [{"role": m["role"], "content": m["content"]} for m in prior]
        latest = f"{ctx_block}\n\n{message}" if ctx_block else message
        reply, _meta = await bot.core(latest=latest, history=history)
        await asyncio.to_thread(
            db.chat_add, context_key, "assistant", reply or "_(no reply)_", persona=persona
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("chat agent run failed for %s/%s", context_key, persona)
        await asyncio.to_thread(
            db.chat_add,
            context_key,
            "assistant",
            f"_(error running {persona}: {type(exc).__name__})_",
            persona=persona,
        )


async def chat_post(request: web.Request) -> web.Response:
    if not _same_origin(request):
        raise web.HTTPForbidden(text="bad origin")
    data = await request.post()
    context_key = (data.get("context_key") or "").strip()
    message = (data.get("message") or "").strip()
    persona = (data.get("persona") or "eddy").strip().lower()
    if not context_key or not message:
        raise web.HTTPBadRequest(text="missing context_key or message")
    # A leading @persona overrides the picker.
    if message.startswith("@"):
        head, _, rest = message[1:].partition(" ")
        if head.lower() in _CHAT_PERSONAS:
            persona, message = head.lower(), rest.strip() or message
    if persona not in _CHAT_PERSONAS:
        persona = "eddy"
    prior = await asyncio.to_thread(db.chat_list, context_key)
    await asyncio.to_thread(db.chat_add, context_key, "user", message)
    task = asyncio.create_task(_run_agent_chat(request.app, context_key, persona, message, prior))
    _CHAT_TASKS.add(task)
    task.add_done_callback(_CHAT_TASKS.discard)
    return web.json_response({"ok": True, "persona": persona})


async def chat_get(request: web.Request) -> web.Response:
    context_key = request.query.get("context_key", "")
    since = int(request.query.get("since") or 0)
    msgs = await asyncio.to_thread(db.chat_list, context_key, since_id=since)
    return web.json_response({"messages": msgs})


def add_routes(app: web.Application) -> None:
    app.add_routes(
        [
            web.get("/healthz", healthz),
            web.get("/", home_page),
            web.get("/thingy/", thingy_page),
            web.get("/chat", chat_get),
            web.post("/chat", chat_post),
            web.get("/productions", productions_list),
            web.post("/productions/bulk-status", productions_bulk_status),
            web.get("/productions/new", production_new_form),
            web.post("/productions/new", production_create),
            web.get("/productions/{pid}", production_page),
            web.get("/productions/{pid}/editor", editor_page),
            web.post("/productions/{pid}/editor/atom", editor_atom_save),
            web.post("/productions/{pid}/editor/flip", editor_item_flip),
            web.post("/productions/{pid}/editor/select", editor_item_select),
            web.post("/productions/{pid}/editor/move", editor_item_move),
            web.get("/productions/{pid}/preview", production_preview),
            web.get("/productions/{pid}/edit", production_edit_form),
            web.post("/productions/{pid}/edit", production_update),
            web.post("/productions/{pid}/start", production_start),
            web.post("/productions/{pid}/atom", production_atom_save),
            web.post("/productions/{pid}/cover", production_cover_save),
            web.post("/productions/{pid}/meta", production_meta_save),
            web.post("/productions/{pid}/currently", production_currently),
            web.post("/productions/{pid}/phase", production_phase),
            web.post("/productions/{pid}/status", production_status),
            web.post("/productions/{pid}/publish", production_publish),
            web.post("/productions/{pid}/publish-ack", production_publish_ack),
            web.post("/productions/{pid}/sync", production_sync),
            web.post("/productions/{pid}/review", production_review),
            web.post("/productions/{pid}/continuity", production_continuity),
            web.post("/productions/{pid}/cover-upload", production_cover_upload),
        ]
    )
