"""micro.blog's Micropub, as the blog round uses it: read one post's live
categories and body, replace its categories, replace its body.

Every call names the blog (``mp-destination``), and a read is trusted only
when micro.blog answers for the post asked about: seven early posts share an
address with another, and Micropub answers for that one. Both writes check
``guards.check_running`` themselves, so nothing reaches micro.blog while
writes are off or the round is paused, whoever calls them.
"""

from __future__ import annotations

import os
from typing import Any

import guards
import requests

MICROPUB = "https://micro.blog/micropub"
DESTINATION = "https://jthingelstad.micro.blog/"
TIMEOUT = 20
USER_AGENT = "WeeklyThing-Librarian/1.0 (blog round)"


class MicropubError(RuntimeError):
    """micro.blog refused or failed a call."""


class Micropub:
    def __init__(self, token: str | None = None, session: requests.Session | None = None):
        self.token = token or os.environ.get("MICROBLOG_API_KEY") or ""
        if not self.token:
            raise MicropubError("MICROBLOG_API_KEY is not set")
        self.session = session or requests.Session()

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "User-Agent": USER_AGENT}

    def source(self, url: str, uid: str) -> dict[str, Any] | None:
        """``{"categories": [...], "content": str | None}`` for the post at
        ``url``, or None when micro.blog has no such post or answers for
        another (``uid`` is the micro.blog id, without ``blog-``)."""
        response = self.session.get(
            MICROPUB,
            params={"q": "source", "url": url, "mp-destination": DESTINATION},
            headers={**self._headers(), "Accept": "application/json"},
            timeout=TIMEOUT,
        )
        if response.status_code in (401, 403):
            raise MicropubError(f"micro.blog refused the token ({response.status_code})")
        if response.status_code >= 500 or response.status_code == 429:
            raise MicropubError(f"micro.blog answered {response.status_code}")
        if not response.ok:
            return None
        properties = (response.json() or {}).get("properties")
        if not isinstance(properties, dict):
            return None
        if str((properties.get("uid") or [""])[0]) != str(uid):
            return None
        content = (properties.get("content") or [None])[0]
        return {
            "categories": list(properties.get("category") or []),
            # A body micro.blog hands back as HTML rather than its markdown
            # source is never edited.
            "content": content if isinstance(content, str) else None,
        }

    def _update(self, url: str, change: dict[str, Any]) -> None:
        guards.check_running(writing=True)
        response = self.session.post(
            MICROPUB,
            json={"action": "update", "url": url, "mp-destination": DESTINATION, **change},
            headers={**self._headers(), "Content-Type": "application/json"},
            timeout=TIMEOUT,
        )
        if response.status_code >= 400:
            raise MicropubError(
                f"micro.blog refused the update to {url}: {response.status_code} "
                f"{response.text[:200]}"
            )

    def replace_categories(self, url: str, categories: list[str]) -> None:
        if not categories:
            raise MicropubError("the round never empties a post's categories")
        self._update(url, {"replace": {"category": categories}})

    def replace_content(self, url: str, content: str) -> None:
        self._update(url, {"replace": {"content": [content]}})
