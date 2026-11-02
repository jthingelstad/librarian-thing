"""Upload the keyword index the deploy built and checked to S3.

The keyword index (apps/librarian/lambda/shared/keyword-index.mts) is one
SQLite full-text file over every corpus, the keyword leg of retrieval. The
deploy builds it after the embeds, from the candidate corpora and the live
copy of the rest (apps/librarian/lambda/scripts/build-keyword-index.mjs, which
checks it covers every row), the corpus gate evals the retrievals it serves,
and this uploads exactly that file to ``artifacts/keyword_index.db``: gzipped,
with its fact (built-at, item-count, index-schema, index-sha256, and
from-<corpus>: the generated_at of each corpus it was built from) as object
metadata. It builds nothing and needs no Bedrock.

    uv run --locked python pipeline/deploy/upload_keyword_index.py --upload-staged .candidate
"""

from __future__ import annotations

import argparse
import gzip
import os
import sys
from pathlib import Path

import boto3
from dotenv import load_dotenv

# Sibling import, as the corpus uploaders do: run as a script its directory
# is on sys.path; loaded by a test from its path, it is not.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from corpus_fact import read_fact  # noqa: E402

STAGED_NAME = "keyword_index.db"
DEFAULT_KEY = "artifacts/keyword_index.db"
# What the build writes beside the index; an upload without them is refused,
# since a fact-less object cannot say what it was built from.
REQUIRED_FACTS = ("built-at", "item-count", "index-schema", "index-sha256")
SQLITE_MAGIC = b"SQLite format 3\x00"


def staged_index(stage_dir: str | Path) -> tuple[Path, dict[str, str]]:
    """The staged index and its fact; missing or not SQLite means the build
    step never ran or did not finish."""
    path = Path(stage_dir) / STAGED_NAME
    if not path.is_file():
        raise FileNotFoundError(f"{path} was not built; run scripts/build-keyword-index.mjs first")
    with path.open("rb") as handle:
        if handle.read(len(SQLITE_MAGIC)) != SQLITE_MAGIC:
            raise ValueError(f"{path} is not a SQLite file")
    fact = read_fact(path)
    missing = [key for key in REQUIRED_FACTS if not fact.get(key)]
    if missing:
        raise ValueError(f"{path} has no {', '.join(missing)} in its fact file")
    return path, fact


def upload_index(bucket: str, key: str, stage_dir: str | Path) -> dict[str, str]:
    """Upload the staged index gzipped (about a third of its 46 MB); the
    Lambda sniffs the gzip bytes, so a plain object would work too."""
    path, fact = staged_index(stage_dir)
    boto3.client("s3").put_object(
        Bucket=bucket,
        Key=key,
        Body=gzip.compress(path.read_bytes(), 6),
        ContentType="application/vnd.sqlite3",
        ContentEncoding="gzip",
        Metadata=fact,
    )
    return fact


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bucket", default=os.environ.get("LIBRARIAN_BUCKET") or "weekly-thing-librarian"
    )
    parser.add_argument("--key", default=os.environ.get("LIBRARIAN_KEYWORD_INDEX_KEY", DEFAULT_KEY))
    parser.add_argument(
        "--upload-staged",
        metavar="DIR",
        required=True,
        help=f"Upload DIR/{STAGED_NAME} as built and checked; build nothing",
    )
    args = parser.parse_args()
    fact = upload_index(args.bucket, args.key, args.upload_staged)
    print(
        f"Uploaded keyword index to s3://{args.bucket}/{args.key} "
        f"({fact['item-count']} rows, built {fact['built-at']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
