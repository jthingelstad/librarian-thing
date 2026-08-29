#!/usr/bin/env bash
# Run both repo gates from the repository root and report each result
# explicitly. Never pipe these through tail or head - a swallowed failure is
# how a broken commit reaches main.

set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

echo "==> gate 1/2: uv run --locked pytest tests/ -q"
uv run --locked pytest tests/ -q
py_rc=$?

echo "==> gate 2/2: npm --prefix apps/librarian/lambda run verify"
npm --prefix apps/librarian/lambda run verify
node_rc=$?

echo "verify: python gate exit=$py_rc, lambda gate exit=$node_rc"
if [ "$py_rc" -ne 0 ] || [ "$node_rc" -ne 0 ]; then
  echo "verify: FAIL"
  exit 1
fi
echo "verify: OK"
exit 0
