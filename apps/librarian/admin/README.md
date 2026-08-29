# apps/librarian/admin/

Operator tooling for the deployed Thingy stack lives here.

This is the home for scripts that talk to the *live* librarian stack — DynamoDB conversations, CloudWatch logs, S3 corpus state, eval harnesses — as distinct from `pipeline/` (build-time data → site) and `lambda/` (runtime code).

## Tools

### Studio Thingy Operations

Studio's existing tailnet-only website exposes a read-only **Thingy** section at
`/thingy/`. It uses this admin package to compare the three deployed S3 corpus
artifacts with Studio's source mirrors and to group evaluator flags and reader
downvotes into a prioritized improvement queue.

The page inherits Studio's loopback-only server, `tailscale serve` proxy, and
explicit `jthingelstad@github` identity allowlist. AWS credentials remain in the
server process; the browser receives rendered operational summaries only. Live
reads are cached for five minutes, and an explicit refresh is available on the
page.

### `operator_report.py`

Generates a local, static HTML report from the canonical DynamoDB
conversation/eval rows. It has no public web route and does not expose any
browser-side secrets. By default it writes to Jamie's Desktop so iCloud can
sync it to other devices:

```bash
uv run --locked python apps/librarian/admin/operator_report.py
open ~/Desktop/Thingy\ Operator\ Report.html
```

Useful options:

```bash
# 30-day report
uv run --locked python apps/librarian/admin/operator_report.py --days 30

# Custom output
uv run --locked python apps/librarian/admin/operator_report.py --output tmp/thingy-report.html

# Override the owner/Jamie label if needed
uv run --locked python apps/librarian/admin/operator_report.py --owner-email jamie@thingelstad.com
```

The report includes quality counts, eval flags, explicit feedback, daily
volume, and a client-side filtered conversation review queue. Conversation
cards are the central object: eval notes, feedback, sources, tools, and the
transcript stay together so operator review stays grounded in what the reader
and Thingy actually said. Conversations from the configured owner email
defaulting to `jamie@thingelstad.com` are labeled as Jamie and can be filtered
separately from real reader traffic.

## Planned

- **Log inspection** — convenience wrappers over CloudWatch Insights queries for the streaming, auth, and eval Lambdas.

## Conventions

- Scripts read AWS credentials from `.env` via `python-dotenv` (same pattern as `pipeline/deploy/`).
- Resolve stack resources (DynamoDB table name, Lambda ARNs) from CloudFormation stack outputs rather than hard-coding.
- Output should default to human-readable; offer `--json` for piping into other tools.
