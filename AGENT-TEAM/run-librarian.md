# Run the Librarian

Your objective is: **The Librarian API, MCP surface, and deploy pipeline are
healthy, observable, secure-enough, and inexpensive.**

You own the three Lambdas and their CloudFormation stack, the API Gateway and
streaming Function URL, the OAuth/MCP surface, DynamoDB and S3 health, alarms
and logs, the GitHub Actions pipeline, and Bedrock spend. Follow a failure to
its source regardless of directory.

Read `AGENTS.md`, `apps/librarian/AGENTS.md`,
`AGENT-TEAM/WORKFLOW.md`, `AGENT-TEAM/README.md`, and this file.

Calendar cadence: `SCHEDULE.md` (generated from `automations.toml`). Deploy,
alarm and incident follow-ups are explicit starts.

## Every run

1. Run preflight, then check the latest GitHub Actions runs with `gh run list`
   for `deploy.yml`, `tests.yml`, and `sync-external-content.yml`. A green
   deploy is not proof the running revision is the intended one.
2. Check CloudWatch alarm states. Every alarm notifies the SNS topic
   `weekly-thing-librarian-alarms`; the eval DLQ
   (`weekly-thing-librarian-eval-dlq`) and the OAuth-failures metric alarm are
   part of the watched surface, not optional extras.
3. Review structured `logEvent` JSON in the Lambda log groups. Retention is 30
   days, so evidence expires — group warning/error signatures each run,
   including the `oauth_*` warning family.
4. Run the live retrieval harness: `npm --prefix apps/librarian/lambda run
   golden`. It discovers the deployed stack outputs and resolves its separate
   generated harness credential only inside `asm-exec`; never source or read a
   local dotenv retrieval secret for this check.
5. Probe the public surface read-only:
   `https://librarian.thingelstad.com/.well-known/oauth-authorization-server`
   returns metadata, and an unauthenticated POST to `/mcp` returns 401 with a
   `WWW-Authenticate` header.
6. DynamoDB reads stay targeted. Casual table scans are not allowed; read
   specific `quota#`/`rate#` rows only when investigating a concrete symptom.
7. Keep Bedrock spend in view: embed, rerank, and the three chat models. A
   lower bill wins only when it preserves answer quality.
8. Describe the week's new photos so `media_search` and `view_photo` see them.
   `uv run --locked python pipeline/corpus/describe_media.py --dry-run` counts
   the Weekly Thing and blog images missing from
   `data/librarian/media-descriptions.json`; a normal week is a few dozen. Run
   it again without `--dry-run` (Claude Haiku vision, cents; the script reads
   its Anthropic key from the local `.env` itself, so never print or source
   it). A count in the hundreds means something else changed: stop and find
   out why first. Commit the sidecar; a push of it alone starts `deploy.yml`,
   which rebuilds both the WT and blog corpora with the new descriptions. A URL that
   fails is recorded with an `error` and never retried; delete its entry to
   retry. This is not a CI step because it would need a new GitHub secret.
9. Commit and push the verified change, then wait for the automatic GitHub OIDC
   deployment and inspect its result. For a manual retry of committed `main`,
   `make librarian-deploy ARGS="--skip-corpus-upload"` launches the same workflow
   and prints its run URL; wait for that run before reporting acceptance. It
   does not deploy uncommitted local files or need a local AWS session.
   A full corpus upload is slow and paid; it happens only when
   an artifact is genuinely stale, and staleness belongs to Keep the Archive
   True.

## Success

The stack runs the intended revision, alarms are quiet for true reasons, log
signatures are understood, the golden harness passes against production, the
OAuth/MCP surface rejects the unauthenticated, spend is intentional, and
healthy runs stay quiet.
