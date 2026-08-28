"""micro.blog client — Jamie's posts for the issue's Journal section.

Uses the Micropub source query (`GET {MICROBLOG_MICROPUB_URL}?q=source`,
``Authorization: Bearer {MICROBLOG_API_KEY}``), which returns posts as
mf2-JSON with ``properties.content`` carrying the **native markdown Jamie
wrote** (a string for markdown-authored posts — the common case — or an
``{html: …}`` / ``{markdown: …}`` dict otherwise). No round-trip through
rendered HTML. ``MICROBLOG_API_KEY`` is required — there is no fallback;
if micro.blog is unreachable, ``journal.fill`` degrades to a placeholder
line.

micro.blog embeds photo uploads as ``<img src="https://www.thingelstad.com/uploads/…">``
HTML tags inside the markdown; those references are rehosted (downloaded,
resized for email, copied into the issue workspace) by ``tools.journal_images``
at ``update-draft`` time — not here.

``posts_in_window`` returns the in-window posts (``q=source`` is capped at
~100 recent posts, far more than any week needs), oldest first.
"""

from __future__ import annotations

import html
import logging
import os
import re
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

import requests

logger = logging.getLogger("workshop.microblog")

DEFAULT_MICROPUB_URL = "https://micro.blog/micropub"
# The Weekly Thing's issue cadence is Jamie's local day; a post's "issue
# date" is the date in this zone (which is also what micro.blog bakes into
# the post URL slug — that's the primary signal we use).
_LOCAL_TZ = ZoneInfo("America/Chicago")
_URL_DATE_RE = re.compile(r"/(\d{4})/(\d{2})/(\d{2})/")
_TIMEOUT = 20.0
_UA = "WeeklyThing-WorkshopBot/1.0"


def micropub_url() -> str:
    return (os.environ.get("MICROBLOG_MICROPUB_URL") or DEFAULT_MICROPUB_URL).strip()


def _api_key() -> str:
    return (os.environ.get("MICROBLOG_API_KEY") or "").strip()


# --- date parsing / windowing ---


def _parse_dt(raw: Any) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None


def published_local(raw: Any) -> datetime | None:
    """Parse a ``published`` timestamp and convert it to Jamie's local zone
    (``America/Chicago``). micro.blog emits ``published`` in UTC; everything
    reader-facing (the Journal date/time labels, windowing) wants it local.
    A naive (tz-less) value is returned unchanged."""
    dt = _parse_dt(raw)
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(_LOCAL_TZ)
    return dt


def _post_date(post: dict) -> date | None:
    """The post's "issue date" — Jamie's local date. micro.blog's URL slug
    (``/YYYY/MM/DD/…``) is that date verbatim; fall back to converting the
    ``published`` timestamp into the local zone."""
    m = _URL_DATE_RE.search(str(post.get("url") or ""))
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass
    dt = published_local(post.get("published"))
    return dt.date() if dt else None


def _first(props: dict, *keys: str):
    """First value of the first present mf2 property in ``keys``."""
    for k in keys:
        v = props.get(k)
        if isinstance(v, list) and v:
            return v[0]
        if v not in (None, "", [], {}):
            return v
    return None


def _categories(props: dict) -> list[str]:
    """mf2 ``category`` is always a list (zero or more strings). micro.blog
    surfaces each post's category tags here; ``Featured`` drives the
    workshop's Featured-section promotion (above Notable, no Eddy choice)."""
    raw = props.get("category")
    if not isinstance(raw, list):
        return []
    return [str(c).strip() for c in raw if isinstance(c, str) and c.strip()]


# --- HTML → markdown-ish, only for {html:…}-content posts (rare) ---

_TAG_RE = re.compile(r"<[^>]+>")
_A_RE = re.compile(r'<a\b[^>]*?href=["\']([^"\']*)["\'][^>]*>(.*?)</a>', re.DOTALL | re.IGNORECASE)
_BLOCK_END_RE = re.compile(r"</(p|div|li|blockquote|h[1-6]|ul|ol)>", re.IGNORECASE)
_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)


_IMG_TAG_RE = re.compile(r"<img\b[^>]*?>", re.IGNORECASE | re.DOTALL)
# Quote-aware: open with " or ', match anything up to the SAME closing
# quote. Without the back-reference, an apostrophe inside a
# double-quoted attribute (alt="Hand holding a s'more …") would be
# read as a closing quote and the value would truncate at "s".
# Group 1 is the quote char; group 2 is the value.
_IMG_SRC_RE = re.compile(r'\bsrc\s*=\s*(["\'])(.*?)\1', re.IGNORECASE | re.DOTALL)
_IMG_ALT_RE = re.compile(r'\balt\s*=\s*(["\'])(.*?)\1', re.IGNORECASE | re.DOTALL)


def _img_to_md(tag: str) -> str:
    src_m = _IMG_SRC_RE.search(tag)
    if not src_m:
        return ""
    alt_m = _IMG_ALT_RE.search(tag)
    return f"![{(alt_m.group(2).strip() if alt_m else '')}]({src_m.group(2).strip()})"


def html_to_markdownish(content_html: str) -> str:
    """Best-effort HTML → markdown for an HTML-authored micro.blog post:
    keeps links, turns ``<img>`` into ``![alt](src)`` (tools.journal_images
    rehosts the src later), drops other tags, collapses block tags to
    paragraph breaks. Only used on the ``{html:…}``-content path."""
    if not content_html:
        return ""
    s = content_html
    s = _A_RE.sub(lambda m: f"[{_TAG_RE.sub('', m.group(2)).strip()}]({m.group(1).strip()})", s)
    s = _IMG_TAG_RE.sub(lambda m: _img_to_md(m.group(0)), s)
    s = _BR_RE.sub("\n", s)
    s = _BLOCK_END_RE.sub("\n\n", s)
    s = _TAG_RE.sub("", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _content_to_markdown(content: Any) -> str:
    """Coerce an mf2 ``content`` value to markdown. micro.blog returns the
    raw markdown *string* for markdown-authored posts (with ``<img>`` tags
    embedded — left intact here); an ``{html:…}`` / ``{markdown:…}`` dict
    otherwise."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, dict):
        if isinstance(content.get("markdown"), str):
            return content["markdown"].strip()
        if isinstance(content.get("html"), str):
            return html_to_markdownish(content["html"])
        if isinstance(content.get("value"), str):
            return content["value"].strip()
        return ""
    if isinstance(content, list) and content:
        return _content_to_markdown(content[0])
    return ""


# --- the source query ---


def _source_posts() -> list[dict[str, Any]]:
    """All posts from the Micropub ``q=source`` query, as
    ``[{url, title, published, content_md}]``. Skips drafts. Raises on a
    missing key or any transport/parse error."""
    token = _api_key()
    if not token:
        raise RuntimeError("MICROBLOG_API_KEY is required (no fallback)")
    resp = requests.get(
        micropub_url(),
        params={"q": "source"},
        headers={"Authorization": f"Bearer {token}", "User-Agent": _UA},
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    items = data.get("items") if isinstance(data, dict) else None
    if items is None:
        raise ValueError("micro.blog Micropub q=source returned no `items`")
    out: list[dict[str, Any]] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        props = it.get("properties") or {}
        status = _first(props, "post-status")
        if status and str(status).lower() not in ("published", "publish"):
            continue  # drafts etc.
        out.append(
            {
                "url": str(_first(props, "url") or "").strip(),
                "title": str(_first(props, "name") or "").strip(),
                "published": str(_first(props, "published", "publish-date") or ""),
                "content_md": _content_to_markdown(props.get("content")),
                "categories": _categories(props),
            }
        )
    logger.info("microblog: q=source -> %d published posts", len(out))
    return out


def source_for_url(post_url: str) -> dict[str, Any]:
    """Return one post's full mf2 ``properties`` dict via
    ``GET ?q=source&url=…``. Raises on missing key or transport error.

    Used by the Micropub update flow (`update_post_content`) to read the
    full property set both before and after a write, so callers can diff
    every field — not just ``content`` — and verify the server preserved
    everything else.
    """
    token = _api_key()
    if not token:
        raise RuntimeError("MICROBLOG_API_KEY is required (no fallback)")
    resp = requests.get(
        micropub_url(),
        params={"q": "source", "url": post_url},
        headers={"Authorization": f"Bearer {token}", "User-Agent": _UA},
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict):
        raise ValueError("micro.blog Micropub q=source(url) returned non-object")
    props = data.get("properties")
    if not isinstance(props, dict):
        raise ValueError(
            f"micro.blog Micropub q=source(url) returned no properties for {post_url!r}"
        )
    return props


def update_post_content(post_url: str, new_content_md: str) -> None:
    """Send a Micropub ``update`` action that replaces the ``content``
    property of one post. Returns on success; raises on transport / HTTP
    error.

    Micropub ``replace: {content: [body]}`` semantics: the server is
    expected to leave every other property (title, categories, published,
    photo, etc.) alone. We verify this once during integration via
    ``scripts/microblog_update_dryrun.py`` against a throwaway post before
    relying on it for live posts.
    """
    token = _api_key()
    if not token:
        raise RuntimeError("MICROBLOG_API_KEY is required (no fallback)")
    payload = {
        "action": "update",
        "url": post_url,
        "replace": {"content": [new_content_md]},
    }
    resp = requests.post(
        micropub_url(),
        json=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": _UA,
        },
        timeout=_TIMEOUT,
    )
    if resp.status_code >= 400:
        body_snippet = (resp.text or "")[:300]
        raise RuntimeError(
            f"micro.blog Micropub update failed for {post_url!r}: "
            f"HTTP {resp.status_code} — {body_snippet}"
        )
    logger.info("microblog: updated content for %s (HTTP %d)", post_url, resp.status_code)


# --- alt-text fill back to micro.blog (the source of truth) ---

# Whole `src="…"` attribute (including the keyword) — used for splicing
# an alt in right after the src when the tag has no alt attribute at all.
# Same back-reference shape as _IMG_SRC_RE so it handles either quote
# style and tolerates the other quote inside the value.
_IMG_SRC_ATTR_RE = re.compile(r'(\bsrc\s*=\s*(["\']).*?\2)', re.IGNORECASE | re.DOTALL)
# A `![](url)` markdown image with an empty alt.
_MD_IMG_EMPTY_RE = re.compile(r"!\[\]\(([^)]+)\)")


def _splice_alt_into_img(tag: str, alt: str) -> str:
    """Return ``tag`` with ``alt="<alt>"`` either replaced (if it had an
    empty alt) or inserted right after the ``src`` attribute (if no alt
    attribute was present at all). HTML-escapes the alt minimally — drops
    any ``"`` so the attribute can't be broken out of."""
    safe = alt.replace('"', "")
    alt_m = _IMG_ALT_RE.search(tag)
    if alt_m is not None:
        return tag[: alt_m.start()] + f'alt="{safe}"' + tag[alt_m.end() :]
    return _IMG_SRC_ATTR_RE.sub(
        lambda sm: f'{sm.group(1)} alt="{safe}"',
        tag,
        count=1,
    )


def _find_empty_alt_images(content_md: str) -> list[tuple[int, int, str, str]]:
    """Return ``[(start, end, kind, src), …]`` for every image reference
    in ``content_md`` whose alt is missing or empty.

    ``kind`` is ``"html"`` for an ``<img>`` tag, ``"md"`` for a
    markdown ``![](url)`` reference. The slice ``content_md[start:end]``
    is the whole tag/reference the caller can splice over.
    """
    out: list[tuple[int, int, str, str]] = []
    for m in _IMG_TAG_RE.finditer(content_md):
        tag = m.group(0)
        src_m = _IMG_SRC_RE.search(tag)
        if not src_m:
            continue
        alt_m = _IMG_ALT_RE.search(tag)
        if alt_m is None or alt_m.group(2).strip() == "":
            out.append((m.start(), m.end(), "html", src_m.group(2).strip()))
    for m in _MD_IMG_EMPTY_RE.finditer(content_md):
        out.append((m.start(), m.end(), "md", m.group(1).strip()))
    out.sort(key=lambda r: r[0])
    return out


def fill_missing_alts(
    posts: list[dict[str, Any]],
    *,
    vision_call: Any = None,
    write_back: bool = True,
) -> list[dict[str, Any]]:
    """For each post in ``posts``: find every ``<img>`` / ``![]()`` with
    an empty alt, ask vision for one, splice it into the post's
    ``content_md`` *in place*, and POST a Micropub update to the post's
    URL so micro.blog itself carries the alt.

    Returns ``[{post_url, post_title, image_src, alt}, …]`` — one entry
    per alt that was both successfully generated *and* (when
    ``write_back`` is True) successfully written back. Failures of either
    kind are logged and the post is left as it was upstream; the next
    sync will re-attempt.

    ``vision_call`` defaults to :func:`alt_text.generate_alt`. Inject a
    stub in tests. ``write_back=False`` is used by tests + a possible
    future "preview only" mode.
    """
    from .. import alt_text  # local import to keep the module decoupled

    if vision_call is None:
        vision_call = alt_text.generate_alt

    filled: list[dict[str, Any]] = []
    for post in posts:
        url = (post.get("url") or "").strip()
        content_md = post.get("content_md") or ""
        if not url or not content_md:
            continue
        targets = _find_empty_alt_images(content_md)
        if not targets:
            continue
        # Splice from the end so earlier offsets stay valid.
        new_md = content_md
        post_filled: list[dict[str, Any]] = []
        for start, end, kind, src in reversed(targets):
            try:
                alt = (
                    vision_call(
                        image_url=src,
                        context=content_md,
                        caption=(post.get("title") or "").strip() or None,
                    )
                    or ""
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "microblog: alt vision call failed for %s in %s: %s",
                    src,
                    url,
                    exc,
                )
                alt = ""
            if not alt:
                continue
            if kind == "html":
                old_tag = new_md[start:end]
                new_tag = _splice_alt_into_img(old_tag, alt)
                new_md = new_md[:start] + new_tag + new_md[end:]
            else:  # "md" — ![](url) → ![alt](url)
                safe = alt.replace("]", "").replace("[", "")
                new_md = new_md[:start] + f"![{safe}]({src})" + new_md[end:]
            post_filled.append(
                {
                    "post_url": url,
                    "post_title": (post.get("title") or "").strip(),
                    "image_src": src,
                    "alt": alt,
                }
            )
        if not post_filled:
            continue
        if write_back:
            try:
                update_post_content(url, new_md)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "microblog: write-back failed for %s — %d alt(s) "
                    "generated but not persisted; will retry next sync: %s",
                    url,
                    len(post_filled),
                    exc,
                )
                # In-memory copy stays as it was upstream so the current
                # render doesn't carry alts that aren't actually on the
                # post. (The user picked "re-vision next run" over a
                # pending queue.)
                continue
        # Either we wrote back successfully (write_back=True) or the
        # caller asked for in-memory only (write_back=False) — either
        # way it's safe to publish the new content_md to the post dict.
        post["content_md"] = new_md
        # post_filled was accumulated in reverse-source-order; flip back
        # so #chatter logs read top-to-bottom of the post.
        filled.extend(reversed(post_filled))
    return filled


def posts_in_window(start_date: str, end_date: str) -> list[dict[str, Any]]:
    """micro.blog posts whose authored date falls in ``(start_date, end_date]``
    (calendar dates, ``YYYY-MM-DD``), oldest first. Each result:
    ``{url, title, published (ISO), content_md}`` — ``content_md`` is the
    native markdown Jamie wrote (with photo ``<img>`` tags still embedded;
    those are rehosted at update-draft time). Raises if the Micropub call
    fails — ``journal.fill`` catches that and degrades to a placeholder line.
    """
    sd = datetime.strptime(start_date, "%Y-%m-%d").date()
    ed = datetime.strptime(end_date, "%Y-%m-%d").date()
    posts = []
    for p in _source_posts():
        d = _post_date(p)
        if d is not None and sd < d <= ed:
            posts.append(p)
    posts.sort(key=lambda r: r.get("published") or "")
    logger.info("microblog: %d posts in window %s..%s", len(posts), start_date, end_date)
    return posts
