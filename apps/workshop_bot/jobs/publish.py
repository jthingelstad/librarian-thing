"""Ship the active newsletter issue to audio, Buttondown, and the website.

**Render-then-ship.** The DB is the draft; each subcommand renders exactly
the artifacts it ships, at ship time, from current DB state — there is no
daily projection to be stale against. Each is independently idempotent. The
The all-destination path runs all three in the right order:

1. **audio** — render the transcript from DB, TTS the per-block files,
   concat with bumpers + loudnorm, upload the MP3 to S3, update the local
   ``data/audio/manifest.json``. Runs first so the archive can carry the
   audio fields in its front matter.
2. **buttondown** — render ``buttondown.md`` from DB, POST or PATCH it to
   Buttondown's API. Captures ``buttondown_id`` + ``absolute_url`` onto the
   issue window, then re-renders the archive so its front matter carries
   the freshly-minted URL.
3. **website** — render archive + transcript from DB, then a single atomic
   GitHub commit of ``data/issues/{N}/{archive.md, metadata.json,
   links.json, transcript/*.txt}`` + ``data/audio/manifest.json``. The
   commit triggers the static-site deploy workflow.

Pre-flight gates (``haiku.md``, ``metadata.json``, ``intro.md`` in the DB
content store; ``cover.jpg`` on S3) refuse in ``#editorial`` before any
destructive call.

Idempotent end-to-end. ``publish audio`` no-ops when the transcript hash
matches the manifest; ``publish buttondown`` PATCHes the same draft on
re-run; ``publish website``'s GitHub put_tree no-ops when every blob SHA
already matches the tree.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Any

from ..tools import db, github_repo, renderers, s3
from . import _base, render_audio

logger = logging.getLogger("workshop.jobs.publish")

REPO = Path(__file__).resolve().parents[3]
# Same env-aware location the renderers write to (WORKSHOP_ISSUES_DIR
# redirects both in tests), so render-then-ship reads what was just rendered.
ISSUES_ROOT = renderers.ISSUES_LOCAL_DIR
AUDIO_MANIFEST = REPO / "data" / "audio" / "manifest.json"

# Required atoms before the destructive Buttondown POST fires. The .md/.json
# atoms live in the DB content store; cover.jpg is an S3 binary.
REQUIRED_FOR_BUTTONDOWN = ("haiku.md", "metadata.json", "intro.md", "cover.jpg")
_FIX_HINT = {
    "haiku.md": "→ `/eddy issue haiku`",
    "metadata.json": "→ `/eddy issue subject`",
    "intro.md": "→ write it on the web editor",
    "cover.jpg": "→ upload it on the web production page",
}


def _import_pipeline_content():
    """Lazy-load ``pipeline/content/content.py`` via ``sys.path``. The
    pipeline isn't a Python package (no ``__init__.py``)."""
    pipeline_content_dir = str(REPO / "pipeline" / "content")
    if pipeline_content_dir not in sys.path:
        sys.path.insert(0, pipeline_content_dir)
    import content  # noqa: F401

    return content


def _draft_url(buttondown_id: str) -> str:
    return f"https://buttondown.com/emails/{buttondown_id}"


def _collect_ship_files(issue_number: int) -> list[tuple[str, bytes]]:
    """Read every shipable artifact from the local repo + pair each
    with its repo-relative destination path. ``publish_website`` renders
    to ``data/issues/{N}/`` immediately before calling this, so the disk
    reads are always fresh.

    Includes: archive.md, metadata.json, links.json, transcript/*.txt,
    optional echoes.md, and the updated data/audio/manifest.json.
    """
    files: list[tuple[str, bytes]] = []
    issue_dir = ISSUES_ROOT / str(issue_number)

    archive_path = issue_dir / "archive.md"
    if not archive_path.exists():
        raise RuntimeError(
            f"archive.md missing locally — refusing to publish website. "
            f"Expected {archive_path} (rendered by this publish leg just now)."
        )
    files.append((f"data/issues/{issue_number}/archive.md", archive_path.read_bytes()))

    metadata_path = issue_dir / "metadata.json"
    if not metadata_path.exists():
        raise RuntimeError(
            f"metadata.json missing at {metadata_path} — refusing to publish website."
        )
    files.append((f"data/issues/{issue_number}/metadata.json", metadata_path.read_bytes()))

    links_path = issue_dir / "links.json"
    if links_path.exists():
        files.append((f"data/issues/{issue_number}/links.json", links_path.read_bytes()))

    echoes_path = issue_dir / "echoes.md"
    if echoes_path.exists():
        files.append((f"data/issues/{issue_number}/echoes.md", echoes_path.read_bytes()))

    transcript_dir = issue_dir / "transcript"
    if transcript_dir.is_dir():
        for path in sorted(transcript_dir.glob("*.txt")):
            files.append(
                (
                    f"data/issues/{issue_number}/transcript/{path.name}",
                    path.read_bytes(),
                )
            )

    if AUDIO_MANIFEST.exists():
        files.append(("data/audio/manifest.json", AUDIO_MANIFEST.read_bytes()))

    return files


def _required_missing(issue_number: int) -> list[str]:
    """Return the required atoms not yet present. Authored atoms are checked
    in the DB content store (the draft); ``cover.jpg`` is an S3 binary."""
    from ..tools import content_store

    missing: list[str] = []
    for name in REQUIRED_FOR_BUTTONDOWN:
        if name == "cover.jpg":
            continue
        body = content_store.read_issue(issue_number, name)
        if not (body and body.strip()):
            missing.append(name)
    try:
        listing = s3.list_issue(issue_number)
        files = {o.get("filename") for o in listing.get("objects", []) if o.get("filename")}
    except Exception:  # noqa: BLE001
        files = set()
    if "cover.jpg" not in files:
        missing.append("cover.jpg")
    return missing


def _missing_list_message(issue_number: int, missing: list[str], dest: str) -> str:
    labels = {"buttondown": "Email", "website": "Website", "audio": "Audio"}
    lines = [f"⛔ Publish {labels.get(dest, dest)} for **WT{issue_number}** can't run — missing:"]
    for r in missing:
        lines.append(f"  ❌ `{r}` {_FIX_HINT.get(r, '')}".rstrip())
    return "\n".join(lines)


# ---------- publish audio ----------


async def _run_tracked(
    ctx: "_base.JobContext",
    leg: str,
    operation,
    *,
    issue_number: int | None = None,
) -> "_base.JobResult":
    """Run one publish leg while persisting progress and recovery evidence."""
    window = db.get_active_issue_window(issue_number)
    if window is None:
        return _base.JobResult(False, "❌ no active issue window — start one in Studio first.")
    n = int(window["issue_number"])
    db.publish_leg_start(n, leg)
    try:
        result = await operation(ctx, issue_number=n)
    except Exception as exc:
        db.publish_leg_finish(
            n,
            leg,
            ok=False,
            message=f"{type(exc).__name__}: {exc}",
        )
        raise
    db.publish_leg_finish(
        n,
        leg,
        ok=result.ok,
        message=result.message,
        evidence=result.data or {},
    )
    return result


async def _publish_audio(
    ctx: "_base.JobContext", *, issue_number: int | None = None
) -> "_base.JobResult":
    """Render the transcript from current DB state, then TTS + upload the
    MP3. Idempotent on transcript hash (no-ops when the manifest entry
    matches)."""
    window = db.get_active_issue_window(issue_number)
    if window is None:
        return _base.JobResult(False, "❌ no active issue window — start one in Studio first.")
    n = int(window["issue_number"])
    try:
        await asyncio.to_thread(renderers.render_transcript_for_issue, n, window=window)
    except Exception as exc:  # noqa: BLE001
        return _base.JobResult(
            False,
            f"❌ couldn't render the transcript for #{n}: `{type(exc).__name__}: {exc}`",
            data={"issue_number": n},
        )
    return await render_audio.run(ctx)


async def publish_audio(
    ctx: "_base.JobContext", *, issue_number: int | None = None
) -> "_base.JobResult":
    return await _run_tracked(ctx, "audio", _publish_audio, issue_number=issue_number)


# ---------- publish buttondown ----------


async def _publish_buttondown(
    ctx: "_base.JobContext", *, issue_number: int | None = None
) -> "_base.JobResult":
    """POST/PATCH the daily-rendered buttondown.md to Buttondown.
    Captures id + absolute_url into metadata.json, then re-renders the
    archive so its front matter carries the freshly-minted URL.
    Refuses with a missing-list if any required atom isn't yet
    present."""
    window = db.get_active_issue_window(issue_number)
    if window is None:
        return _base.JobResult(False, "❌ no active issue window — start one in Studio first.")
    n = int(window["issue_number"])

    missing = _required_missing(n)
    if missing:
        msg = _missing_list_message(n, missing, "buttondown")
        await ctx.post("DISCORD_CHANNEL_EDITORIAL", msg, persona="eddy")
        return _base.JobResult(False, msg, data={"issue_number": n, "missing": missing})

    # Render-then-ship: buttondown.md is rendered fresh from current DB
    # state right now — the POST always ships what the DB says.
    try:
        await asyncio.to_thread(renderers.render_email_for_issue, n, window=window)
    except Exception as exc:  # noqa: BLE001
        return _base.JobResult(
            False,
            f"❌ couldn't render buttondown.md for #{n}: `{type(exc).__name__}: {exc}`",
            data={"issue_number": n},
        )

    pipeline_content = await asyncio.to_thread(_import_pipeline_content)
    try:
        bd_result: dict[str, Any] = await asyncio.to_thread(
            pipeline_content.buttondown_publish_idempotent,
            str(n),
        )
    except pipeline_content.ButtondownPublishError as exc:
        msg = f"❌ Buttondown publish for **WT{n}** failed: {exc}"
        await ctx.post("DISCORD_CHANNEL_EDITORIAL", msg, persona="eddy")
        return _base.JobResult(
            False, msg, data={"issue_number": n, "stage": "buttondown POST/PATCH"}
        )

    action = bd_result["action"]
    bid = bd_result["id"]
    absolute_url = bd_result.get("absolute_url", "") or ""
    subject = bd_result.get("subject") or f"WT{n}"

    # Stamp the publish record onto the issue window (the canonical store for
    # these publish-path fields now — not the authored content). The archive
    # re-render + status gate read them from here.
    db.set_issue_publish_record(n, buttondown_id=bid, absolute_url=absolute_url)

    # Re-render archive so its front matter carries the absolute_url
    # Buttondown just returned. Best-effort — a render failure here
    # doesn't undo the Buttondown publish.
    try:
        await asyncio.to_thread(renderers.render_archive_for_issue, n, window=window)
    except Exception:  # noqa: BLE001
        logger.exception("publish_buttondown: post-publish archive refresh failed for #%d", n)

    head_emoji = "✅" if action == "created" else "♻️"
    head_verb = "Created" if action == "created" else "Updated"
    draft_url = _draft_url(bid)
    lines = [f"{head_emoji} {head_verb} Buttondown draft for **WT{n}** — `{subject}`"]
    lines.append(f"📨 [open in Buttondown]({draft_url}) — review, schedule, send.")
    lines.append("_Re-run Publish Email in Studio to push edits — idempotent._")
    await ctx.post("DISCORD_CHANNEL_EDITORIAL", "\n".join(lines), persona="eddy")
    return _base.JobResult(
        True,
        f"Buttondown {action} for WT{n} (id=`{bid}`).",
        data={
            "issue_number": n,
            "action": action,
            "buttondown_id": bid,
            "draft_url": draft_url,
            "absolute_url": absolute_url,
            "subject": subject,
        },
    )


async def publish_buttondown(
    ctx: "_base.JobContext", *, issue_number: int | None = None
) -> "_base.JobResult":
    return await _run_tracked(ctx, "email", _publish_buttondown, issue_number=issue_number)


# ---------- publish website ----------


async def _publish_website(
    ctx: "_base.JobContext", *, issue_number: int | None = None
) -> "_base.JobResult":
    """Render archive + transcript from current DB state, then commit them +
    the manifest to GitHub. Idempotent — put_tree no-ops when every blob
    SHA matches the existing tree."""
    window = db.get_active_issue_window(issue_number)
    if window is None:
        return _base.JobResult(False, "❌ no active issue window — start one in Studio first.")
    n = int(window["issue_number"])

    # Render-then-ship: the committed tree always reflects current DB state.
    try:
        await asyncio.to_thread(renderers.render_archive_for_issue, n, window=window)
        await asyncio.to_thread(renderers.render_transcript_for_issue, n, window=window)
    except Exception as exc:  # noqa: BLE001
        msg = f"❌ Publish Website for **WT{n}** couldn't render: `{type(exc).__name__}: {exc}`"
        await ctx.post("DISCORD_CHANNEL_EDITORIAL", msg, persona="eddy")
        return _base.JobResult(False, msg, data={"issue_number": n})

    try:
        files = await asyncio.to_thread(_collect_ship_files, n)
    except RuntimeError as exc:
        msg = f"❌ Publish Website for **WT{n}** can't run: {exc}"
        await ctx.post("DISCORD_CHANNEL_EDITORIAL", msg, persona="eddy")
        return _base.JobResult(False, msg, data={"issue_number": n})

    # Subject for the commit message — read the metadata.
    subject = f"WT{n}"
    try:
        metadata_path = ISSUES_ROOT / str(n) / "metadata.json"
        if metadata_path.exists():
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            subject = metadata.get("subject") or subject
    except Exception:  # noqa: BLE001
        pass

    try:
        commit_sha = await asyncio.to_thread(
            github_repo.put_tree,
            files,
            f"Ship WT{n} — {subject}",
        )
    except github_repo.MissingTokenError:
        msg = (
            f"⚠️ Publish Website for **WT{n}** — `GITHUB_PAT_TOKEN` "
            "isn't set; commit skipped. Set the env var and re-run."
        )
        await ctx.post("DISCORD_CHANNEL_EDITORIAL", msg, persona="eddy")
        return _base.JobResult(False, msg, data={"issue_number": n})
    except Exception as exc:  # noqa: BLE001
        logger.exception("publish_website: GitHub commit failed for WT%d", n)
        msg = f"⚠️ Publish Website for **WT{n}** failed: `{type(exc).__name__}: {exc}`"
        await ctx.post("DISCORD_CHANNEL_EDITORIAL", msg, persona="eddy")
        return _base.JobResult(False, msg, data={"issue_number": n})

    commit_url = f"https://github.com/{github_repo._repo()}/commit/{commit_sha}"
    await ctx.post(
        "DISCORD_CHANNEL_EDITORIAL",
        f"🌐 Website commit for **WT{n}** — [`{commit_sha[:7]}`]({commit_url}) on main.",
        persona="eddy",
    )
    return _base.JobResult(
        True,
        f"Website commit {commit_sha[:7]} for WT{n}.",
        data={"issue_number": n, "commit_sha": commit_sha, "commit_url": commit_url},
    )


async def publish_website(
    ctx: "_base.JobContext", *, issue_number: int | None = None
) -> "_base.JobResult":
    return await _run_tracked(ctx, "website", _publish_website, issue_number=issue_number)


# ---------- publish all (default no-arg) ----------


async def publish_all(
    ctx: "_base.JobContext", *, issue_number: int | None = None
) -> "_base.JobResult":
    """Run audio → buttondown → website, the standard ship order. Each
    stage is the same subcommand function called individually — so a
    failure mid-sequence stops the chain but leaves a clean partial
    state (e.g. audio + buttondown shipped, website failed; just
    re-run Publish Website in Studio to finish)."""
    window = db.get_active_issue_window(issue_number)
    if window is None:
        return _base.JobResult(False, "❌ no active issue window — start one in Studio first.")
    n = int(window["issue_number"])

    progress = await ctx.progress(
        "DISCORD_CHANNEL_EDITORIAL",
        f"🚀 Shipping **WT{n}**…\n"
        f"⏳ `publish audio` _(slowest step — TTS + bumpers + S3 upload)_\n"
        f"⏳ `publish buttondown`\n"
        f"⏳ `publish website`",
        persona="eddy",
    )

    async def _refresh(text: str) -> None:
        if progress is not None:
            await progress.update(text)

    # Step 1: audio.
    await _refresh(
        f"🚀 Shipping **WT{n}**…\n"
        f"🎙️ `publish audio` _(rendering…)_\n"
        f"⏳ `publish buttondown`\n"
        f"⏳ `publish website`"
    )
    audio_result = await publish_audio(ctx, issue_number=n)
    if not audio_result.ok:
        await _refresh(
            f"❌ Ship failed for **WT{n}** at `publish audio` — see #editorial above.\n"
            f"❌ `publish audio`\n"
            f"⏸ `publish buttondown` (skipped)\n"
            f"⏸ `publish website` (skipped)"
        )
        return audio_result

    # Step 2: buttondown.
    await _refresh(
        f"🚀 Shipping **WT{n}**…\n"
        f"✅ `publish audio`\n"
        f"📨 `publish buttondown` _(posting…)_\n"
        f"⏳ `publish website`"
    )
    bd_result = await publish_buttondown(ctx, issue_number=n)
    if not bd_result.ok:
        await _refresh(
            f"❌ Ship failed for **WT{n}** at `publish buttondown` — see #editorial above.\n"
            f"✅ `publish audio`\n"
            f"❌ `publish buttondown`\n"
            f"⏸ `publish website` (skipped — re-run Publish Website in Studio after fix)"
        )
        return bd_result

    # Step 3: website.
    await _refresh(
        f"🚀 Shipping **WT{n}**…\n"
        f"✅ `publish audio`\n"
        f"✅ `publish buttondown`\n"
        f"🌐 `publish website` _(committing…)_"
    )
    web_result = await publish_website(ctx, issue_number=n)
    if not web_result.ok:
        await _refresh(
            f"⚠️ Ship for **WT{n}** mostly done — website commit failed.\n"
            f"✅ `publish audio`\n"
            f"✅ `publish buttondown`\n"
            f"❌ `publish website` — re-run Publish Website in Studio after fix"
        )
        return web_result

    # Success — collapse the progress card into a one-line summary.
    bd_data = bd_result.data or {}
    web_data = web_result.data or {}
    await _refresh(
        f"✅ **WT{n}** shipped — "
        f"[Buttondown draft]({bd_data.get('draft_url', '')}) · "
        f"[website commit]({web_data.get('commit_url', '')}) · audio rendered"
    )
    return _base.JobResult(
        True,
        f"Shipped WT{n}: audio ✅, buttondown ✅ (id=`{bd_data.get('buttondown_id', '?')}`), "
        f"website ✅ (commit `{web_data.get('commit_sha', '?')[:7]}`)",
        data={"issue_number": n, "buttondown": bd_data, "website": web_data},
    )
