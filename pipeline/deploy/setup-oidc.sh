#!/usr/bin/env bash
# Administrator-only IAM setup. Run validate before apply; see iam/README.md.
# GitHub deploys already use OIDC and never need this bootstrap or a local login.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec uv run --locked python pipeline/deploy/iam_setup.py "$@"
