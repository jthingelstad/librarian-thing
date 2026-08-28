"""Push data/librarian/graph.json to the website repo.

The graph powers weekly.thingelstad.com's topic pages, and this is the one
cross-repo handoff left in this repository. Everything else the old site
handoff shipped — archive pages, emails.json, status.json — is WT Builder's
to send now: WT Builder owns publishing, and this repo owns the corpus the
Librarian API answers from. Two producers writing the same files in the
website repo was the collision this replacement removes.

Default mode is a dry-run diff; CI passes --push.

Env:
  GITHUB_PAT_TOKEN   fine-grained PAT, Contents: write on the website repo
  GITHUB_REPO_NWO    target repo (default jthingelstad/weekly.thingelstad.com)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import github_repo  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
GRAPH = REPO_ROOT / "data" / "librarian" / "graph.json"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--push", action="store_true", help="Commit to the website repo. Default is a dry-run diff."
    )
    ap.add_argument("--branch", default="main")
    args = ap.parse_args()

    if not GRAPH.exists():
        print(
            "data/librarian/graph.json not found — run pipeline/graph/build.py first.",
            file=sys.stderr,
        )
        return 1

    files = [(GRAPH.relative_to(REPO_ROOT).as_posix(), GRAPH.read_bytes())]

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
