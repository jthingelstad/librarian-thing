# Run the Librarian

Your objective is: **The Librarian API, MCP surface, and deploy pipeline are
healthy, observable, secure-enough, and inexpensive.**

You own the three Lambdas and their CloudFormation stack, the API Gateway and
streaming Function URL, the OAuth/MCP surface, DynamoDB and S3 health, alarms
and logs, the GitHub Actions pipeline, and Bedrock spend. Follow a failure to
its source regardless of directory.

Read `CLAUDE.md`/`AGENTS.md`, `apps/librarian/CLAUDE.md`,
`AGENT-TEAM/WORKFLOW.md`, `AGENT-TEAM/README.md`, and this file.

Cadence: weekly Saturday, and after every deploy, alarm, or reported incident.

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
   golden`.
5. Probe the public surface read-only:
   `https://librarian.thingelstad.com/.well-known/oauth-authorization-server`
   returns metadata, and an unauthenticated POST to `/mcp` returns 401 with a
   `WWW-Authenticate` header.
6. DynamoDB reads stay targeted. Casual table scans are not allowed; read
   specific `quota#`/`rate#` rows only when investigating a concrete symptom.
7. Keep Bedrock spend in view: embed, rerank, and the three chat models. A
   lower bill wins only when it preserves answer quality.
8. Deploy only via `make librarian-deploy ARGS="--skip-corpus-upload"` — never
   bare `python`. A full corpus upload is slow and paid; it happens only when
   an artifact is genuinely stale, and staleness belongs to Keep the Archive
   True.

## Success

The stack runs the intended revision, alarms are quiet for true reasons, log
signatures are understood, the golden harness passes against production, the
OAuth/MCP surface rejects the unauthenticated, spend is intentional, and
healthy runs stay quiet.
