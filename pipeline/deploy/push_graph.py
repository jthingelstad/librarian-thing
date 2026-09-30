"""Push the librarian graph to the website repo.

The graph powers weekly.thingelstad.com's topic pages, and this is the one
cross-repo handoff left in this repository. Everything else the old site
handoff shipped — archive pages, emails.json, status.json — is WT Builder's
to send now: WT Builder owns publishing, and this repo owns the corpus the
Librarian API answers from. Two producers writing the same files in the
website repo was the collision this replacement removes.

CI passes --from-s3: the graph pushed is the one upload_corpus.py built from
the embedded corpus and uploaded beside it, so the site gets real
`similar_issues` (they need chunk embeddings, which a local
pipeline/graph/build.py run over an unembedded corpus does not have) and
the same graph the Librarian API serves. Without it the local
data/librarian/graph.json is pushed.

Default mode is a dry-run diff; CI passes --push.

Env:
  GITHUB_PAT_TOKEN     fine-grained PAT, Contents: write on the website repo
  GITHUB_REPO_NWO      target repo (default jthingelstad/weekly.thingelstad.com)
  LIBRARIAN_BUCKET     --from-s3 bucket (default weekly-thing-librarian)
  LIBRARIAN_GRAPH_KEY  --from-s3 key (default artifacts/graph.json)
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
from pathlib import Path

import boto3

sys.path.insert(0, str(Path(__file__).resolve().parent))
import github_repo  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
GRAPH = REPO_ROOT / "data" / "librarian" / "graph.json"


def fetch_s3_graph(bucket: str, key: str) -> bytes:
    """The uploaded graph, re-serialized the way pipeline/graph/build.py
    writes it (indented) so the website repo's diffs stay readable. Raises on
    any failure: pushing nothing beats pushing a degraded graph."""
    body = boto3.client("s3").get_object(Bucket=bucket, Key=key)["Body"].read()
    if body[:2] == b"\x1f\x8b":
        body = gzip.decompress(body)
    graph = json.loads(body)
    issues = graph.get("issues") or {}
    similar = sum(1 for issue in issues.values() if issue.get("similar_issues"))
    print(f"Pulled s3://{bucket}/{key}: similar_issues on {similar} of {len(issues)} issues.")
    return (json.dumps(graph, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--push", action="store_true", help="Commit to the website repo. Default is a dry-run diff."
    )
    ap.add_argument("--branch", default="main")
    ap.add_argument(
        "--from-s3",
        action="store_true",
        help="Push the graph uploaded to S3 with the embedded corpus, not the local file.",
    )
    ap.add_argument(
        "--bucket", default=os.environ.get("LIBRARIAN_BUCKET") or "weekly-thing-librarian"
    )
    ap.add_argument(
        "--graph-key", default=os.environ.get("LIBRARIAN_GRAPH_KEY", "artifacts/graph.json")
    )
    args = ap.parse_args()

    if args.from_s3:
        content = fetch_s3_graph(args.bucket, args.graph_key)
    elif GRAPH.exists():
        content = GRAPH.read_bytes()
    else:
        print(
            "data/librarian/graph.json not found — run pipeline/graph/build.py first.",
            file=sys.stderr,
        )
        return 1

    files = [(GRAPH.relative_to(REPO_ROOT).as_posix(), content)]

    if args.push:
        sha = github_repo.put_tree(files, "Refresh librarian graph", branch=args.branch)
        print(f"Pushed graph @ {sha[:7]} on {args.branch} (no-op if unchanged).")
        return 0

    tree = github_repo._get(f"/git/trees/{args.branch}", {"recursive": "1"})
    remote = {e["path"]: e["sha"] for e in tree.get("tree", []) if e.get("type") == "blob"}
    path, content = files[0]
    local = github_repo.git_blob_sha(content)
    state = "added" if path not in remote else "changed" if remote[path] != local else "unchanged"
    print(f"DRY RUN vs {github_repo._repo()}@{args.branch}: graph.json {state}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
