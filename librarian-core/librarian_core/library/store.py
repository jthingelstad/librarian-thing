"""library.db in S3: download it with its ETag, upload it only over that copy.

One current copy lives at ``s3://weekly-thing-librarian/artifacts/library.db``.
The bucket is versioned and keeps a replaced copy under ``artifacts/`` for 30
days, the window to undo a bad round. A run uploads with ``If-Match`` on the
ETag it downloaded (``If-None-Match: *`` for the very first copy), so a second
writer fails instead of overwriting: it downloads again and redoes its round.
"""

from __future__ import annotations

import os
import sqlite3
import tempfile
import warnings
from contextlib import closing
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

from librarian_core.library.registry import snapshot_metadata

DEFAULT_BUCKET = "weekly-thing-librarian"
KEY = "artifacts/library.db"
# Where each corpus the Librarian serves lives, and the S3 metadata key its
# upload records the library fingerprint it was built from under.
CORPUS_KEYS = {
    "corpus": "artifacts/corpus.json",
    "blog_corpus": "artifacts/blog_corpus.json",
    "podcast_corpus": "artifacts/podcast_corpus.json",
    "reference_corpus": "artifacts/reference_corpus.json",
    "links_corpus": "artifacts/links_corpus.json",
}
FINGERPRINT_META = "library-fingerprint"
_CONFLICT_CODES = {"PreconditionFailed", "ConditionalRequestConflict"}
_REGISTRY_METADATA_ERRORS = (ValueError, TypeError, UnicodeError, OverflowError)


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
    # StreamingBody's context manager yields the raw urllib3 stream, which
    # has no iter_chunks, so close it by hand.
    body = response["Body"]
    try:
        with partial.open("wb") as out:
            for chunk in body.iter_chunks(1 << 20):
                out.write(chunk)
    finally:
        body.close()
    partial.replace(dest)
    return response["ETag"]


def upload(src: str | Path, etag: str | None, *, client=None, key: str = KEY) -> str:
    """Put ``src`` as library.db only if S3 still holds the copy with ``etag``
    (or holds none, when ``etag`` is None). Returns the new ETag; raises
    LibraryConflict when another run got there first."""
    s3 = client or boto3.client("s3")
    condition = {"IfMatch": etag} if etag else {"IfNoneMatch": "*"}
    # One immutable SQLite backup supplies both the metadata and the bytes.
    # Reading a live local DB and later opening it for upload would race a writer
    # (and miss WAL contents). This does not change the S3 compare-and-swap.
    try:
        with tempfile.TemporaryDirectory(prefix="library-upload-") as tmp:
            frozen = Path(tmp) / "library.db"
            with (
                closing(
                    sqlite3.connect(Path(src).resolve().as_uri() + "?mode=ro", uri=True)
                ) as source,
                closing(sqlite3.connect(frozen)) as snapshot,
            ):
                source.backup(snapshot)
                try:
                    metadata = snapshot_metadata(snapshot)
                except _REGISTRY_METADATA_ERRORS:
                    warnings.warn(
                        "Public registry revision unavailable for this snapshot.", stacklevel=2
                    )
                    metadata = {}
            with frozen.open("rb") as body:
                response = s3.put_object(
                    Bucket=bucket(),
                    Key=key,
                    Body=body,
                    ContentType="application/vnd.sqlite3",
                    Metadata=metadata,
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


def built_from(corpus: str, *, client=None) -> str | None:
    """The library fingerprint the live ``corpus`` was built from, or None
    when it records none (built before the library, or from a tree no export
    wrote) or does not exist."""
    s3 = client or boto3.client("s3")
    try:
        head = s3.head_object(Bucket=bucket(), Key=CORPUS_KEYS[corpus])
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
            return None
        raise
    return head.get("Metadata", {}).get(FINGERPRINT_META)
