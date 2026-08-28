"""GitHub Git Data API client — atomic multi-file commits to another repo.

Promoted out of the retired workshop_bot: the graph handoff to
weekly.thingelstad.com is the one cross-repo push this repository still makes.
It bundles every file in a single commit via the Git Data API rather than the
Contents API, so a push lands as one atomic commit (one push, one CI trigger,
one diff to review) instead of a per-file commit storm.

Idempotent: if every file's content already matches what's at HEAD, no commit
is created and the existing HEAD SHA is returned. Re-running a ship is safe
and silent on the second invocation.

Conflict-tolerant: if someone else pushes between our tree/commit construction
and the ref update, GitHub returns 422 on the PATCH. The client refetches the
ref, rebuilds the tree against the new base, and retries once. Two consecutive
losses raise RefUpdateConflict — by then we're probably in a real fight, not a
race.

Auth: GITHUB_PAT_TOKEN env var. Repo: GITHUB_REPO_NWO env var (defaults to
jthingelstad/weekly.thingelstad.com). Branch defaults to main.

Surface:
  put_tree(files, message, branch="main") -> commit_sha
    files: list of (repo_relative_path, content_bytes) tuples
"""

from __future__ import annotations

import hashlib
import logging
import os
from typing import Optional

import requests

logger = logging.getLogger("workshop.github_repo")

DEFAULT_REPO = "jthingelstad/weekly.thingelstad.com"
DEFAULT_BRANCH = "main"
API_BASE = "https://api.github.com"
USER_AGENT = "weekly-thing-workshop_bot"


class GitHubRepoError(RuntimeError):
    """Base class for github_repo problems."""


class MissingTokenError(GitHubRepoError):
    """GITHUB_PAT_TOKEN is not set."""


class RefUpdateConflict(GitHubRepoError):
    """Ref PATCH lost to a concurrent push twice in a row."""


def _token() -> str:
    raw = (os.environ.get("GITHUB_PAT_TOKEN") or "").strip()
    if not raw:
        raise MissingTokenError(
            "GITHUB_PAT_TOKEN is not set. Workshop_bot needs a fine-grained PAT "
            "with Contents: write on the website repo to commit ship artifacts."
        )
    return raw


def _repo() -> str:
    return (os.environ.get("GITHUB_REPO_NWO") or DEFAULT_REPO).strip()


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_token()}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
    }


def git_blob_sha(content: bytes) -> str:
    """Compute the SHA-1 a Git blob would have for this content. Lets us
    decide whether a file actually changed without a round trip per file."""
    h = hashlib.sha1()
    h.update(b"blob " + str(len(content)).encode("ascii") + b"\x00")
    h.update(content)
    return h.hexdigest()


def _ensure_bytes(content) -> bytes:
    if isinstance(content, bytes):
        return content
    return str(content).encode("utf-8")


# ---------- low-level API wrappers ----------


def _get(path: str, params: Optional[dict] = None) -> dict:
    url = f"{API_BASE}/repos/{_repo()}{path}"
    resp = requests.get(url, headers=_headers(), params=params, timeout=30)
    if resp.status_code >= 400:
        raise GitHubRepoError(f"GET {path} → {resp.status_code}: {resp.text[:300]}")
    return resp.json()


def _post(path: str, payload: dict) -> dict:
    url = f"{API_BASE}/repos/{_repo()}{path}"
    resp = requests.post(url, headers=_headers(), json=payload, timeout=30)
    if resp.status_code >= 400:
        raise GitHubRepoError(f"POST {path} → {resp.status_code}: {resp.text[:300]}")
    return resp.json()


def _patch(path: str, payload: dict) -> requests.Response:
    """Returns the raw response so the caller can inspect status_code for 422."""
    url = f"{API_BASE}/repos/{_repo()}{path}"
    return requests.patch(url, headers=_headers(), json=payload, timeout=30)


# ---------- semantic operations ----------


def _get_head(branch: str) -> tuple[str, str]:
    """Returns (commit_sha, tree_sha) for the tip of branch."""
    ref = _get(f"/git/ref/heads/{branch}")
    commit_sha = ref["object"]["sha"]
    commit = _get(f"/git/commits/{commit_sha}")
    return commit_sha, commit["tree"]["sha"]


def _get_tree_recursive(tree_sha: str) -> dict[str, str]:
    """Returns {path: blob_sha} for every blob entry reachable from this tree.
    Trees larger than GitHub's truncation threshold (~100k entries) come back
    with truncated=True; we treat that as "can't decide locally" and force a
    full upload by returning an empty map."""
    tree = _get(f"/git/trees/{tree_sha}", params={"recursive": "1"})
    if tree.get("truncated"):
        logger.warning("github_repo: tree %s truncated; cannot prove no-op", tree_sha)
        return {}
    return {
        entry["path"]: entry["sha"] for entry in tree.get("tree", []) if entry.get("type") == "blob"
    }


def _create_blob(content: bytes) -> str:
    """POST a blob and return its SHA. GitHub dedupes by content hash so
    posting an existing blob is a cheap no-op on their side."""
    import base64

    payload = {
        "content": base64.b64encode(content).decode("ascii"),
        "encoding": "base64",
    }
    result = _post("/git/blobs", payload)
    return result["sha"]


def _create_tree(base_tree_sha: str, entries: list[dict]) -> str:
    payload = {"base_tree": base_tree_sha, "tree": entries}
    return _post("/git/trees", payload)["sha"]


def _create_commit(message: str, tree_sha: str, parent_sha: str) -> str:
    payload = {"message": message, "tree": tree_sha, "parents": [parent_sha]}
    return _post("/git/commits", payload)["sha"]


def _update_ref(branch: str, commit_sha: str) -> requests.Response:
    return _patch(f"/git/refs/heads/{branch}", {"sha": commit_sha, "force": False})


# ---------- public entry point ----------


def put_tree(
    files: list[tuple[str, bytes | str]],
    message: str,
    branch: str = DEFAULT_BRANCH,
) -> str:
    """Commit ``files`` as one atomic commit to ``branch``.

    ``files`` is a list of (repo_relative_path, content) tuples. content can be
    bytes or str (str gets UTF-8 encoded). Paths use forward slashes from repo
    root, e.g. ``data/issues/458/archive.md``.

    Returns the resulting HEAD commit SHA. If every file already matches the
    blob at its path, no commit is created and the existing HEAD SHA is
    returned.

    Raises:
      MissingTokenError — GITHUB_PAT_TOKEN unset.
      RefUpdateConflict — lost the ref-update race twice; caller decides
        whether to retry or surface the failure.
      GitHubRepoError — any other API failure.
    """
    if not files:
        raise ValueError("put_tree requires at least one file")

    normalized = [(path, _ensure_bytes(content)) for path, content in files]
    last_error: Optional[Exception] = None

    for attempt in range(2):
        commit_sha, tree_sha = _get_head(branch)
        existing_blobs = _get_tree_recursive(tree_sha)

        # Skip files that already match exactly. If nothing's left, the commit
        # would be empty — return the existing HEAD instead.
        changed = []
        for path, content in normalized:
            local_sha = git_blob_sha(content)
            if existing_blobs.get(path) == local_sha:
                continue
            changed.append((path, content))

        if not changed:
            logger.info(
                "github_repo: no-op — all %d files already match HEAD %s",
                len(normalized),
                commit_sha[:7],
            )
            return commit_sha

        # Build blobs + tree + commit.
        tree_entries = []
        for path, content in changed:
            blob_sha = _create_blob(content)
            tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": blob_sha})

        new_tree_sha = _create_tree(tree_sha, tree_entries)
        new_commit_sha = _create_commit(message, new_tree_sha, commit_sha)

        resp = _update_ref(branch, new_commit_sha)
        if resp.status_code < 400:
            logger.info(
                "github_repo: committed %d file(s) as %s on %s",
                len(changed),
                new_commit_sha[:7],
                branch,
            )
            return new_commit_sha

        # 422 = fast-forward refused (someone else pushed). On the first
        # attempt, refetch the ref and retry. On the second, give up with a
        # distinct error so the caller can decide what to do about the race.
        if resp.status_code == 422:
            logger.warning(
                "github_repo: ref update 422 on attempt %d (concurrent push)",
                attempt + 1,
            )
            last_error = GitHubRepoError(f"422 on attempt {attempt + 1}: {resp.text[:200]}")
            continue

        raise GitHubRepoError(
            f"PATCH /git/refs/heads/{branch} → {resp.status_code}: {resp.text[:300]}"
        )

    raise RefUpdateConflict(f"Lost ref-update race on {branch} twice in a row: {last_error}")
