"""HTTP client for the Librarian Lambda's ``/retrieve`` endpoint.

Workshop_bot's in-process archive corpus is BM25 (lexical), which is
fine for most agent jobs but not for ``compose-echoes`` — that job
needs to find an archive entry that *thematically* resonates with the
current issue, and BM25 only matches on shared vocabulary. Librarian's
Lambda runs the high-quality pipeline (Bedrock Cohere embed →
vector search → Cohere rerank) against the pre-embedded corpus; this
client exposes that pipeline as a retrieval-only call (no Sonnet,
no per-user token, operator bridge-secret auth).

Synchronous on purpose: callers wrap the call in ``asyncio.to_thread``
so the bot's gateway loop stays responsive. Matches the rest of
workshop_bot's HTTP tooling (uses ``requests``, not httpx).

Failure is **loud** — a missing secret, a network failure, or a
non-2xx response raises :class:`ThingyRetrieveError`. compose-echoes
depends on this for a quality floor, so silently degrading to BM25
would defeat the point.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

import requests

logger = logging.getLogger("workshop.thingy_retrieve")

# Default points at the production Stream Lambda URL, so a single
# LIBRARIAN_STREAM_URL override flips retrieval to a staging stack.
DEFAULT_STREAM_URL = "https://jcvud66qqpq53frvno5stoqntm0zqntw.lambda-url.us-east-1.on.aws/"

# Bedrock embed + rerank typically completes in 1–3s; the timeout is
# generous so a cold corpus load on the Lambda doesn't trip a false
# error. compose-echoes is not on a tight latency budget — it runs
# inside ``mark-built`` (the Build → Publish phase transition).
DEFAULT_TIMEOUT_SECS = 30


class ThingyRetrieveError(Exception):
    """Raised when the Lambda is unreachable or rejects the request."""


def _stream_base() -> str:
    return (os.environ.get("LIBRARIAN_STREAM_URL") or DEFAULT_STREAM_URL).rstrip("/")


def _retrieve_secret() -> str:
    secret = os.environ.get("LIBRARIAN_RETRIEVE_SECRET", "").strip()
    if not secret:
        raise ThingyRetrieveError(
            "LIBRARIAN_RETRIEVE_SECRET is not set; Librarian retrieval is disabled"
        )
    return secret


def retrieve(
    query: str,
    k: int = 12,
    *,
    filters: Optional[dict[str, Any]] = None,
    timeout_secs: int = DEFAULT_TIMEOUT_SECS,
) -> list[dict[str, Any]]:
    """Fetch the top-``k`` archive passages most relevant to ``query``.

    Each passage carries ``issue_number``, ``subject``, ``publish_date``,
    ``section``, ``url``, ``text`` (a ~1200-char preview), ``score``, and
    ``age`` (e.g. ``"about 3 years old"``). Identical shape to the
    Lambda's ``compactSource`` output — see chat/runtime.mjs.

    Raises ``ThingyRetrieveError`` on any failure: no secret, network
    timeout, non-2xx response, malformed JSON, missing ``passages``
    field. compose-echoes treats this as a fail-loud signal.
    """
    query = (query or "").strip()
    if not query:
        raise ThingyRetrieveError("query must be non-empty")
    url = _stream_base() + "/retrieve"
    payload: dict[str, Any] = {
        "bridge_secret": _retrieve_secret(),
        "query": query,
        "k": int(k),
    }
    if filters:
        payload["filters"] = filters
    try:
        response = requests.post(url, json=payload, timeout=timeout_secs)
    except requests.RequestException as exc:
        raise ThingyRetrieveError(f"Librarian /retrieve unreachable: {exc}") from exc
    if response.status_code >= 400:
        snippet = response.text[:200].replace("\n", " ")
        raise ThingyRetrieveError(f"Librarian /retrieve returned {response.status_code}: {snippet}")
    try:
        data = response.json()
    except ValueError as exc:
        raise ThingyRetrieveError(f"Librarian /retrieve returned non-JSON: {exc}") from exc
    passages = data.get("passages")
    if not isinstance(passages, list):
        raise ThingyRetrieveError("Librarian /retrieve response missing 'passages' list")
    logger.info("thingy_retrieve query=%r k=%d → %d passages", query[:80], k, len(passages))
    return passages
