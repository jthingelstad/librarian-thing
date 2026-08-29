#!/usr/bin/env bash
# Preflight for AGENT-TEAM runs. Reports the checkout state and exits non-zero
# when an automated run must stay read-only (fetch failure, dirty tree,
# detached HEAD, off-main, no upstream, ahead, behind, or diverged). On a
# non-zero exit: stop and report; never pull, rebase, stash, or push.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

if ! git fetch origin --prune >/dev/null 2>&1; then
  echo "preflight: FAIL - git fetch origin failed; upstream unknown, stay read-only"
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
commit="$(git rev-parse --short HEAD)"
echo "preflight: branch=$branch commit=$commit"

ok=0

if [ "$branch" = "HEAD" ]; then
  echo "preflight: FAIL - detached HEAD, stay read-only"
  ok=1
elif [ "$branch" != "main" ]; then
  echo "preflight: FAIL - automated work runs only from main (on $branch)"
  ok=1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "preflight: FAIL - worktree is dirty; do not act on unexpected local changes"
  git status --short | sed 's/^/  /'
  ok=1
fi

if upstream="$(git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null)"; then
  ahead="$(git rev-list --count '@{upstream}..HEAD')"
  behind="$(git rev-list --count 'HEAD..@{upstream}')"
  if [ "$ahead" -gt 0 ] && [ "$behind" -gt 0 ]; then
    echo "preflight: FAIL - diverged from $upstream ($ahead ahead / $behind behind)"
    ok=1
  elif [ "$behind" -gt 0 ]; then
    echo "preflight: FAIL - behind $upstream by $behind; do not pull in an automated run"
    ok=1
  elif [ "$ahead" -gt 0 ]; then
    echo "preflight: FAIL - ahead of $upstream by $ahead; never push pre-existing commits"
    ok=1
  fi
else
  echo "preflight: FAIL - no upstream configured for $branch"
  ok=1
fi

if [ "$ok" -eq 0 ]; then
  echo "preflight: OK - clean and in sync with origin"
fi
exit "$ok"
