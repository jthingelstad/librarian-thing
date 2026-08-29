#!/usr/bin/env bash
# Run the local equivalent of both CI jobs from the repository root. Never pipe
# these through tail or head - a swallowed failure is how a broken commit
# reaches main.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

verification_tmp="$(mktemp -d "${TMPDIR:-/tmp}/librarian-verify.XXXXXX")"
cleanup() {
  rm -rf -- "$verification_tmp"
}
trap cleanup EXIT

echo "==> Python 1/4: ruff check"
uv run --locked ruff check .

echo "==> Python 2/4: ruff format --check"
uv run --locked ruff format --check .

echo "==> Python 3/4: locked dependency audit"
uv export --locked --no-dev --no-emit-project --format requirements-txt \
  | sed '/^-e \.\/librarian-core$/d' \
  > "$verification_tmp/requirements.txt"
uvx --from pip-audit==2.10.1 pip-audit \
  --requirement "$verification_tmp/requirements.txt" --disable-pip

echo "==> Python 4/4: pytest"
uv run --locked pytest tests/ -q

echo "==> Lambda 1/2: npm audit"
npm --prefix apps/librarian/lambda audit --audit-level=high

echo "==> Lambda 2/2: generated contract, format, lint, typecheck, tests"
npm --prefix apps/librarian/lambda run verify
echo "verify: OK"
