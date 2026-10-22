"""library.db in S3: download it with its ETag, upload it only over that copy.

One current copy lives at ``s3://weekly-thing-librarian/artifacts/library.db``.
The bucket is versioned and keeps a replaced copy under ``artifacts/`` for 30
days, the window to undo a bad round. A run uploads with ``If-Match`` on the
ETag it downloaded (``If-None-Match: *`` for the very first copy), so a second
writer fails instead of overwriting: it downloads again and redoes its round.
"""

from __future__ import annotations

import os
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

DEFAULT_BUCKET = "weekly-thing-librarian"
KEY = "artifacts/library.db"
_CONFLICT_CODES = {"PreconditionFailed", "ConditionalRequestConflict"}


class LibraryConflict(RuntimeError):
    """S3 no longer holds the copy this run started from."""


def bucket() -> str:
    return os.environ.get("LIBRARIAN_BUCKET") or DEFAULT_BUCKET


def download(dest: str | Path, *, client=None, key: str = KEY) -> str | None:
    """Fetch library.db to ``dest`` and return its ETag, or None (leaving
    ``dest`` alone) when there is no library yet."""
    s3 = client or boto3.client("s3")
    dest = Path(dest)
    try:
        response = s3.get_object(Bucket=bucket(), Key=key)
    except s3.exceptions.NoSuchKey:
        return None
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_name(dest.name + ".part")
    with response["Body"] as body, partial.open("wb") as out:
        for chunk in body.iter_chunks(1 << 20):
            out.write(chunk)
    partial.replace(dest)
    return response["ETag"]


def upload(src: str | Path, etag: str | None, *, client=None, key: str = KEY) -> str:
    """Put ``src`` as library.db only if S3 still holds the copy with ``etag``
    (or holds none, when ``etag`` is None). Returns the new ETag; raises
    LibraryConflict when another run got there first."""
    s3 = client or boto3.client("s3")
    condition = {"IfMatch": etag} if etag else {"IfNoneMatch": "*"}
    try:
        with Path(src).open("rb") as body:
            response = s3.put_object(
                Bucket=bucket(),
                Key=key,
                Body=body,
                ContentType="application/vnd.sqlite3",
                **condition,
            )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in _CONFLICT_CODES:
            raise LibraryConflict(
                "library.db changed in S3 since this run downloaded it; "
                "download it again and redo the round"
            ) from exc
        raise
    return response["ETag"]
