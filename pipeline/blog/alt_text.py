"""Vision-generated alt text for journal and cover images.

One surface: ``generate_alt(*, image_url, context, caption=None)`` makes
one vision call (Sonnet) and returns a tight one-line description.
Returns ``""`` on cap exhaustion / fetch failure / vision failure. No
cache, no DB I/O — persistence is the *caller's* job (the journal alt
ends up on micro.blog via ``tools.content.microblog.fill_missing_alts``;
the cover alt lands in ``cover.json``).

``begin_run()`` resets the per-run vision-call cap; call at the top of
each ``update-draft`` so a single run can't fan out to dozens of vision
calls. The cap is configurable via ``WORKSHOP_ALT_VISION_CAP`` (default
15). Images that don't get a budget this run fill on the next sync.

Prompt guardrails: ≤120 chars, factual, no "photo of"/"image of"/"picture
of" preamble, no emoji, no quotes / ampersands / angle brackets (so it's
safe to write straight into an ``<img alt="...">`` attribute without
worrying about breaking the tag — defense in depth on top of the
``html.escape`` the caller does).
"""

from __future__ import annotations

import base64
import logging
import os
import re
from typing import Optional

import anthropic_client
import requests

logger = logging.getLogger("workshop.alt_text")

_DEFAULT_CAP = 15
_FETCH_TIMEOUT = 20.0
_FETCH_MAX_BYTES = 6 * 1024 * 1024  # 6 MB — rehosted images are well under

# Anthropic's vision API caps base64 image bodies at 5 MB. Resize any
# image we send to the vision call so we stay well under that and
# also pay fewer image tokens — pricing scales with megapixels, and
# Anthropic's documented sweet spot for resolution is around 1568px
# on the long edge (the model downscales bigger images server-side
# anyway, so larger uploads waste bytes + tokens for nothing).
_VISION_LONG_EDGE_MAX = 1568
# Below this binary size + within the resolution cap, skip the PIL
# round-trip entirely. Headroom below the API's 5 MB base64 cap: 3 MB
# binary → ~4 MB base64 once encoded.
_VISION_BINARY_PASSTHROUGH_MAX = 3 * 1024 * 1024
_VISION_MAX_TOKENS = 200
_VISION_MODEL_KEY = "sonnet"
_UA = "WeeklyThing-WorkshopBot/1.0"

# Module-level counter — reset by begin_run(); workshop_bot is single-process
# and update-draft's _gather_fills runs serially in one thread, so no lock.
_calls_remaining = _DEFAULT_CAP
# Which Anthropic key the vision calls bill to for the current run. Set by
# begin_run(): "eddy" for update-draft, "general" for the blog backfill.
_run_purpose = "general"

# Image URLs that returned 404/410 — recorded so future runs skip them instead
# of spending a vision-budget unit re-fetching a deleted image (the blog
# backfill re-scans thousands of old posts every run, and a deleted upload
# would otherwise block the cursor forever). Populated by _fetch_image_bytes;
# seeded from the on-disk log by begin_run(dead_url_log=...).
_dead_urls: set[str] = set()
_dead_url_log: Optional[str] = None

_PROMPT_BASE = (
    "Generate alt text for the attached image, for a screen-reader user "
    "who cannot see it.\n\n"
    "Constraints:\n"
    "- 120 characters or fewer.\n"
    "- Factual and concrete — describe what's actually visible (the "
    "subject, setting, action).\n"
    '- No preamble like "photo of", "image of", "picture of", "a '
    'view of" — start with the subject itself.\n'
    "- One single line. No emoji. No quote marks, ampersands, or angle "
    "brackets (the text goes straight into an HTML alt attribute).\n"
    "- Skip people's identities you can't be confident about; describe "
    "what they're doing or wearing instead.\n"
)

_RESPONSE_HINT = (
    "Respond with just the alt text on one line — no leading/trailing "
    'quotes, no "alt:" prefix, no explanation.'
)


def _cap() -> int:
    raw = os.environ.get("WORKSHOP_ALT_VISION_CAP")
    if raw is None:
        return _DEFAULT_CAP
    try:
        v = int(raw)
        return v if v >= 0 else _DEFAULT_CAP
    except ValueError:
        return _DEFAULT_CAP


def begin_run(purpose: str = "general", dead_url_log: Optional[str] = None) -> None:
    """Reset the per-run vision-call counter and set which Anthropic key the
    run's vision calls bill to. Call once at the top of ``update-draft``'s
    ``_gather_fills`` (``purpose="eddy"``) or the blog backfill
    (``purpose="general"``).

    ``dead_url_log``: optional path to a newline-delimited file of image URLs
    that previously returned 404/410. When given, those URLs are loaded and
    skipped for free this run (no fetch, no budget), and newly-discovered dead
    URLs are appended to the file. The blog backfill passes this so a block of
    deleted uploads can't re-block the candidate cursor on every run."""
    global _calls_remaining, _run_purpose, _dead_url_log
    _calls_remaining = _cap()
    _run_purpose = purpose
    _dead_url_log = dead_url_log
    if dead_url_log:
        _load_dead_urls(dead_url_log)


def _load_dead_urls(path: str) -> None:
    """Seed the in-memory dead-URL set from the on-disk log (one URL per line).
    Missing file is fine — it's created on the first recorded 404."""
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                u = line.strip()
                if u:
                    _dead_urls.add(u)
    except FileNotFoundError:
        pass
    except OSError as exc:  # noqa: BLE001
        logger.warning("alt_text: couldn't read dead-url log %s: %s", path, exc)


def _record_dead_url(url: str) -> None:
    """Mark a URL dead (404/410) so future runs skip it; append to the log file
    if one was set by begin_run()."""
    if url in _dead_urls:
        return
    _dead_urls.add(url)
    if _dead_url_log:
        try:
            with open(_dead_url_log, "a", encoding="utf-8") as fh:
                fh.write(url + "\n")
        except OSError as exc:  # noqa: BLE001
            logger.warning("alt_text: couldn't append dead url to %s: %s", _dead_url_log, exc)


def calls_remaining() -> int:
    return _calls_remaining


def _sniff_image_type(head: bytes) -> Optional[str]:
    """Identify an image format from its leading magic bytes. micro.blog's
    upload CDN serves some files as ``binary/octet-stream`` (and occasionally
    with no Content-Type at all), so the response header can't be trusted —
    the bytes can. Returns an Anthropic-supported media type or ``None``."""
    if head[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    return None


def _fetch_image_bytes(url: str) -> Optional[tuple[bytes, str]]:
    """Download the image; return ``(bytes, media_type)`` or ``None`` on
    failure. The media type comes from the Content-Type header when it
    declares an image, otherwise from the bytes' magic number — micro.blog's
    upload CDN serves some real images (notably GIFs) as
    ``binary/octet-stream``, so a header-only check wrongly rejects them."""
    try:
        resp = requests.get(url, timeout=_FETCH_TIMEOUT, headers={"User-Agent": _UA}, stream=True)
        resp.raise_for_status()
        header_ctype = (resp.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        header_is_image = header_ctype.startswith("image/")
        ctype = header_ctype if header_is_image else ""
        chunks: list[bytes] = []
        total = 0
        for chunk in resp.iter_content(64 * 1024):
            if not chunks and not header_is_image:
                # Header didn't declare an image — trust the leading bytes.
                sniffed = _sniff_image_type(chunk[:16])
                if not sniffed:
                    logger.warning(
                        "alt_text: %s is not an image (header=%s)", url, header_ctype or "?"
                    )
                    return None
                ctype = sniffed
            total += len(chunk)
            if total > _FETCH_MAX_BYTES:
                logger.warning("alt_text: %s exceeds %d bytes; aborting", url, _FETCH_MAX_BYTES)
                return None
            chunks.append(chunk)
        if not ctype.startswith("image/"):
            logger.warning("alt_text: %s is not an image (header=%s)", url, header_ctype or "?")
            return None
        return b"".join(chunks), ctype
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else None
        if status in (404, 410):
            # The upload is gone for good — record it so future runs skip it
            # instead of re-spending budget on a fetch that can't succeed.
            _record_dead_url(url)
        logger.warning("alt_text: fetch %s failed: %s", url, exc)
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning("alt_text: fetch %s failed: %s", url, exc)
        return None


def _downscale_for_vision(body: bytes, media_type: str) -> tuple[bytes, str]:
    """Resize the fetched image in memory before sending to the vision
    API. Two reasons: (1) Anthropic's 5 MB base64 cap rejects oversized
    uploads (we saw this on 7.6 MB journal photos that the upstream
    micro.blog uploads carry at full resolution), and (2) Anthropic's
    vision pricing scales with megapixels — images bigger than ~1568px
    on the long edge get downscaled server-side anyway, so larger
    uploads waste bytes and tokens.

    Fast path: if the binary is already under the passthrough cap AND
    the resolution is within the long-edge limit, return as-is. Slow
    path: re-encode at ≤1568px long edge as JPEG q85 (plenty for the
    alt-text task — we're describing the scene, not reading text).

    PIL is imported lazily so the module loads in environments without
    it; on any failure the original bytes are returned (the upstream
    API will reject if the image is genuinely too big, which restores
    the prior behaviour — no regression).
    """
    if len(body) <= _VISION_BINARY_PASSTHROUGH_MAX:
        try:
            from io import BytesIO  # noqa: PLC0415

            from PIL import Image  # noqa: PLC0415

            with Image.open(BytesIO(body)) as probe:
                if max(probe.size) <= _VISION_LONG_EDGE_MAX:
                    return body, media_type
        except Exception:  # noqa: BLE001 — Pillow missing or bad image; fall through
            return body, media_type

    try:
        from io import BytesIO  # noqa: PLC0415

        from PIL import Image  # noqa: PLC0415

        with Image.open(BytesIO(body)) as img:
            img.thumbnail(
                (_VISION_LONG_EDGE_MAX, _VISION_LONG_EDGE_MAX),
                Image.LANCZOS,
            )
            # JPEG can't carry alpha; flatten transparent/paletted modes.
            if img.mode in ("RGBA", "LA", "P"):
                img = img.convert("RGB")
            buf = BytesIO()
            img.save(buf, format="JPEG", quality=85, optimize=True)
            new_body = buf.getvalue()
        logger.debug(
            "alt_text: resized %d-byte %s -> %d-byte image/jpeg",
            len(body),
            media_type,
            len(new_body),
        )
        return new_body, "image/jpeg"
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "alt_text: PIL resize failed (%s); sending original %d bytes",
            exc,
            len(body),
        )
        return body, media_type


def _build_messages(
    *, image_b64: str, media_type: str, context: str, caption: Optional[str]
) -> list[dict]:
    """Compose the vision-call user content blocks."""
    text_parts = [_PROMPT_BASE]
    if caption and caption.strip():
        text_parts.append(
            "Do NOT repeat this caption (it appears as text near the "
            f"image, so a screen-reader user already gets it): {caption.strip()!r}"
        )
    if context and context.strip():
        # Cap context at ~1500 chars so we don't ship the whole post.
        ctx = context.strip()
        if len(ctx) > 1500:
            ctx = ctx[:1500].rsplit(" ", 1)[0] + "…"
        text_parts.append("For background, here is the prose around the image:\n\n" + ctx)
    text_parts.append(_RESPONSE_HINT)
    return [
        {
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": media_type, "data": image_b64},
                },
                {"type": "text", "text": "\n\n".join(text_parts)},
            ],
        }
    ]


def _clean_alt(raw: str) -> str:
    """Trim whitespace/quotes/angle brackets/ampersands; collapse to one
    line; cap at 200 chars (the prompt asks for ≤120; this is the hard
    backstop)."""
    if not raw:
        return ""
    s = raw.strip()
    # If the model wrapped the alt in quotes, strip them.
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        s = s[1:-1].strip()
    # Strip any "Alt:" / "Alt text:" prefix the model added despite the hint.
    s = re.sub(r"^(alt(\s+text)?\s*:\s*)", "", s, flags=re.IGNORECASE)
    # Strip the chars that would break the attribute (do this before the
    # whitespace collapse so the " and " replacement doesn't leave double
    # spaces).
    s = s.replace('"', "").replace("&", " and ").replace("<", "").replace(">", "")
    # One line, single-spaced.
    s = " ".join(s.split())
    if len(s) > 200:
        s = s[:200].rsplit(" ", 1)[0]
    return s.strip()


def _generate_via_vision(*, image_url: str, context: str, caption: Optional[str]) -> str:
    """Make one vision call; return the cleaned alt or ``""`` on any failure."""
    fetched = _fetch_image_bytes(image_url)
    if fetched is None:
        return ""
    body, media_type = fetched
    body, media_type = _downscale_for_vision(body, media_type)
    b64 = base64.b64encode(body).decode("ascii")
    try:
        client = anthropic_client.client(_run_purpose)
        resp = client.messages.create(
            model=anthropic_client.MODELS[_VISION_MODEL_KEY],
            max_tokens=_VISION_MAX_TOKENS,
            messages=_build_messages(
                image_b64=b64,
                media_type=media_type,
                context=context,
                caption=caption,
            ),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("alt_text: vision call failed for %s: %s", image_url, exc)
        return ""
    text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
    cleaned = _clean_alt(text)
    if not cleaned:
        logger.warning("alt_text: model returned empty/unusable alt for %s", image_url)
    return cleaned


def generate_alt(
    *,
    image_url: str,
    context: str = "",
    caption: Optional[str] = None,
) -> str:
    """Generate alt text via one vision call. **No cache, no DB I/O** —
    persistence is the caller's responsibility (journal alts ride on
    micro.blog itself via ``microblog.fill_missing_alts``; cover alt
    lands in ``cover.json`` via ``jobs/_cover.alt``).

    Returns the cleaned alt on success, or ``""`` on cap exhaustion /
    image fetch failure / vision failure / a URL already known dead.
    Decrements the per-run vision cap on a real call; a known-dead URL
    (see ``begin_run(dead_url_log=...)``) is skipped for free, and a URL
    discovered dead mid-call (404/410) refunds its reserved budget unit.
    ``begin_run()`` resets the counter at the top of the run.
    """
    global _calls_remaining
    if not image_url:
        return ""
    if image_url in _dead_urls:
        logger.debug("alt_text: skipping known-dead image url %s", image_url)
        return ""
    if _calls_remaining <= 0:
        logger.info("alt_text: vision cap reached; %s left empty for this run", image_url)
        return ""
    _calls_remaining -= 1
    alt = _generate_via_vision(image_url=image_url, context=context, caption=caption)
    if not alt and image_url in _dead_urls:
        # _fetch_image_bytes just discovered this URL is dead (404/410); it made
        # no vision call, so refund the budget unit we reserved above.
        _calls_remaining += 1
    return alt
