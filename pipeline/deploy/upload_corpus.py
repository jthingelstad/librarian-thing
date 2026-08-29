"""Build the embedded librarian corpus and upload it to S3.

Incremental by default: fetches the existing corpus from S3 once at the
start, copies cached embeddings onto unchanged chunks (matched by
content-deterministic chunk_id), and only sends the leftover chunks to
Bedrock. Pass --full to skip the cache and re-embed everything.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path

import boto3
from botocore.exceptions import ClientError, NoCredentialsError
from dotenv import load_dotenv
from librarian_core.corpus import (
    DEFAULT_EMBEDDING_DIMENSIONS,
    DEFAULT_EMBEDDING_MODEL,
    EMBED_RECIPE_VERSION,
    add_bedrock_embeddings,
    build_corpus,
)
from librarian_core.graph import build_graph


def upload_json_gzip(bucket: str, key: str, path) -> None:
    """Upload a JSON artifact gzip-compressed with ContentEncoding: gzip.

    The corpus is ~10x smaller compressed, which is most of the Lambda cold
    start. The Lambda loader sniffs the gzip magic bytes, so plain and
    compressed objects both work during the transition.
    """
    import gzip as _gzip

    data = Path(path).read_bytes()
    boto3.client("s3").put_object(
        Bucket=bucket,
        Key=key,
        Body=_gzip.compress(data, 6),
        ContentType="application/json",
        ContentEncoding="gzip",
    )


def fetch_existing_corpus(bucket: str, key: str) -> dict | None:
    """Pull the previously-deployed corpus from S3 to use as an embedding cache.

    Returns None on any failure (missing object, network, credentials, parse
    error). Callers fall through to a full re-embed when None is returned.
    """
    try:
        response = boto3.client("s3").get_object(Bucket=bucket, Key=key)
        body = response["Body"].read()
        if body[:2] == b"\x1f\x8b":
            import gzip as _gzip

            body = _gzip.decompress(body)
        corpus = json.loads(body)
    except (ClientError, NoCredentialsError) as exc:
        code = (
            getattr(exc, "response", {}).get("Error", {}).get("Code", "")
            if hasattr(exc, "response")
            else ""
        )
        if code in {"NoSuchKey", "404", "NotFound"}:
            print(f"No existing corpus on s3://{bucket}/{key}; doing full embed")
        else:
            print(
                f"Could not fetch existing corpus from s3://{bucket}/{key}: {exc}; doing full embed"
            )
        return None
    except (json.JSONDecodeError, ValueError) as exc:
        print(f"Existing corpus on s3://{bucket}/{key} did not parse: {exc}; doing full embed")
        return None
    chunk_count = len(corpus.get("chunks", []))
    print(f"Loaded existing corpus from s3://{bucket}/{key} ({chunk_count} chunks)")
    return corpus


def build_chunk_cache(old_corpus: dict, model: str, dimensions: int) -> dict[str, list[float]]:
    """Build a {chunk_id: embedding} map from the previously-deployed corpus.

    Returns an empty dict when the cached corpus's embedding model or
    dimensions don't match the requested ones — that forces a full re-embed
    which is the safe behavior on a model swap.
    """
    cached_model = old_corpus.get("embedding_model")
    cached_dims = old_corpus.get("embedding_dimensions")
    cached_recipe = old_corpus.get("embed_recipe")
    if cached_recipe != EMBED_RECIPE_VERSION:
        print(
            f"Cached corpus embed recipe {cached_recipe!r} != current {EMBED_RECIPE_VERSION!r}; "
            "ignoring cache and doing full embed"
        )
        return {}
    if cached_model != model or cached_dims != dimensions:
        print(
            f"Cached corpus uses {cached_model}/{cached_dims}, requested {model}/{dimensions}; "
            "ignoring cache and doing full embed"
        )
        return {}
    return {
        chunk["id"]: chunk["embedding"]
        for chunk in old_corpus.get("chunks", [])
        if chunk.get("id") and chunk.get("embedding")
    }


def merge_cached_embeddings(corpus: dict, cache: dict[str, list[float]]) -> int:
    """Attach cached embeddings to chunks whose chunk_id is in the cache.

    Returns the number of embeddings reused. Chunks already carrying an
    embedding are left alone (idempotent).
    """
    if not cache:
        return 0
    reused = 0
    for chunk in corpus.get("chunks", []):
        if chunk.get("embedding"):
            continue
        cached = cache.get(chunk.get("id"))
        if cached:
            chunk["embedding"] = cached
            reused += 1
    total = len(corpus.get("chunks", []))
    print(f"Reused {reused} of {total} chunk embeddings (incremental refresh)")
    return reused


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bucket", default=os.environ.get("LIBRARIAN_BUCKET") or "weekly-thing-librarian"
    )
    parser.add_argument(
        "--key", default=os.environ.get("LIBRARIAN_CORPUS_KEY", "artifacts/corpus.json")
    )
    parser.add_argument(
        "--graph-key", default=os.environ.get("LIBRARIAN_GRAPH_KEY", "artifacts/graph.json")
    )
    parser.add_argument("--embedding-model", default=DEFAULT_EMBEDDING_MODEL)
    parser.add_argument("--embedding-dimensions", type=int, default=DEFAULT_EMBEDDING_DIMENSIONS)
    parser.add_argument("--keep-output", help="Optional local path for the embedded corpus JSON")
    parser.add_argument(
        "--skip-graph", action="store_true", help="Only upload the corpus, not the graph artifact"
    )
    parser.add_argument(
        "--full", action="store_true", help="Skip the incremental cache and re-embed every chunk"
    )
    args = parser.parse_args()

    if not args.bucket:
        raise RuntimeError("Provide --bucket or LIBRARIAN_BUCKET")

    corpus = build_corpus(include_issue_bodies=True)

    if not args.full:
        existing = fetch_existing_corpus(args.bucket, args.key)
        if existing is not None:
            cache = build_chunk_cache(existing, args.embedding_model, args.embedding_dimensions)
            merge_cached_embeddings(corpus, cache)

    add_bedrock_embeddings(corpus, args.embedding_model, args.embedding_dimensions)

    if args.keep_output:
        upload_path = Path(args.keep_output)
        upload_path.parent.mkdir(parents=True, exist_ok=True)
        upload_path.write_text(
            json.dumps(corpus, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    else:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", suffix=".json", delete=False
        ) as handle:
            handle.write(json.dumps(corpus, ensure_ascii=False) + "\n")
            upload_path = Path(handle.name)

    upload_json_gzip(args.bucket, args.key, upload_path)
    print(f"Uploaded embedded librarian corpus to s3://{args.bucket}/{args.key}")
    if not args.skip_graph:
        graph = build_graph(corpus)
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", suffix=".json", delete=False
        ) as handle:
            handle.write(json.dumps(graph, ensure_ascii=False) + "\n")
            graph_path = Path(handle.name)
        upload_json_gzip(args.bucket, args.graph_key, graph_path)
        print(f"Uploaded librarian graph to s3://{args.bucket}/{args.graph_key}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
