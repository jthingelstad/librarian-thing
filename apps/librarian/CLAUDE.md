# librarian — project memory

Operational notes for the Thingy Lambda stack. Human-facing overview lives in [`README.md`](README.md). The full runtime guide (env vars, IAM cleanup plan, retrieval architecture in depth, Tinylytics events, deployment checklist) is at [`../../reference/librarian.md`](../../reference/librarian.md). This file is the "what to keep in mind when editing here" memory.

## Architecture: three Lambdas, one CloudFormation stack

The Lambda code is **Node.js** (Node 24 runtime, arm64). Everything else in this monorepo is Python — that's intentional: the Lambda needs the AWS SDK v3 + response-streaming primitives, both of which are smoother in Node.

Three Lambdas in `infra/cloudformation.yaml`:

- **`LibrarianFunction`** (`lambda/auth/handler.mts`) — REST API behind API Gateway. Handles Buttondown subscriber lookup, Fastmail/JMAP magic-link login, HMAC session mint/redeem, user conversation list/get/create/rename/delete, and profile updates. Memory 1024 MB, timeout 35s.
- **`LibrarianStreamFunction`** (`lambda/chat/handler.mts` → `runtime.mts`) — Function URL with `RESPONSE_STREAM`. Handles `/chat` (SSE-streamed agent loop with server-side history), `/welcome`, `/feedback`, `/retrieve` (hybrid JSON-only retrieval for wt-builder), and `/mcp` (MCP streamable HTTP in stateless mode: OAuth bearer auth via validateAccessToken, the ARCHIVE_TOOLS registry as MCP tools, per-user daily mcp quota pool). Memory 3008 MB, timeout 300s, ReservedConcurrentExecutions = 5.
- **`LibrarianEvalFunction`** (`lambda/eval/handler.mts`) — DynamoDB Stream consumer. Reviews server-side conversations out of band and writes summary/quality/flags back to canonical conversation rows. Memory 1024 MB, timeout 180s, ReservedConcurrentExecutions = 1.

All Lambdas share the same IAM role (`LibrarianFunctionRole`) and `shared/` helpers. The two deployment artifacts also include the `prompts/` directory.

### The `/chat` agent loop

`lambda/chat/runtime.mts` is the main request loop. On each turn:

1. Verify bearer token (HMAC-signed session JWT — `verifyToken`, `SESSION_SECRET`).
2. Rate-limit per subscriber hash (DynamoDB, hourly).
3. Resolve requested conversation mode from token entitlements and existing conversation metadata.
4. Load the relevant server-side conversation turns and the basic user profile (preferred name, turn count).
5. Load scoped corpus artifacts from S3 (cached on warm starts).
6. Run prompt preflight for privacy/scope handling.
7. Run the Bedrock Converse agent loop with tool use. Tools include `search_faq`, `search_archive`, `get_source`, `find_links`, `corpus_stats`, `latest_content`, `list_content`, `archive_lens`, `entity_lens`, `source_neighborhood`, `archive_gems`, `claim_check`, `media_search`, `currently_history`, `top_references`.
8. Stream answer deltas, archive-work status, final citations, and experience artifacts via SSE; record the turn to DynamoDB; bump the per-user profile counters.

The retrieval pipeline lives in `lambda/shared/retrieval.mts`:

- **`embedQuery`** — Bedrock Cohere `embed-english-v3` (us-east-1).
- **`semanticScore`** — cosine similarity against pre-embedded corpus chunks; year/section filters run inside the scan (before the top-K slice), not as a post-filter.
- **`retrieveLexical`** — TF-IDF term-vector scoring over an in-memory index, with the same in-scan filters. Not a fallback: it always runs (free, and carries proper nouns dense retrieval misses).
- **`fuseCandidates`** — reciprocal-rank fusion (RRF, k=60) of the semantic and lexical lists; rank-based because cosine and TF-IDF scores aren't on a comparable scale.
- **`rerankSources`** — Bedrock Cohere `rerank-v3-5:0` (us-west-2 — only region with rerank) over the fused pool, capped at max(limit×5, 100) candidates.
- **`retrieve`** — orchestrator: both engines scan every query, RRF merges, one rerank orders the fused pool; degrades to lexical-only if the embedding call fails.

### The `/retrieve` endpoint

Added in May 2026. Same `retrieve()` function `/chat` uses, exposed as a JSON-only POST with service-retrieval auth (no per-user session token). Returns `{passages, embedding_model, rerank_model, request_id}`. Called by `wt-builder` (`src/server/integrations/librarian.ts`) — e.g. the Echoes retrieval in the compose flow. workshop_bot, the original client, was retired with Studio on 2026-08-28.

The `retrieveSecretOk` helper in `chat/runtime.mts` compares against `LIBRARIAN_RETRIEVE_SECRET` via `crypto.timingSafeEqual`. The request body still accepts the historical `bridge_secret` field so existing trusted clients keep the versioned `/retrieve` contract.

## Deploy

Always via `make librarian-deploy` or `uv run --locked python pipeline/deploy/aws.py`.
The deploy script must run through the locked uv environment so dependencies such as
`boto3` and `python-dotenv` are available; do not invoke it with bare system Python.

```bash
# Default: skip corpus reupload — code+infra only
make librarian-deploy ARGS="--skip-corpus-upload"

# Full deploy (rebuilds + embeds + uploads Weekly Thing, blog, and podcast corpora)
make librarian-deploy

# Direct equivalent when bypassing make
uv run --locked python pipeline/deploy/aws.py --skip-corpus-upload
```

The `--skip-corpus-upload` flag is the **default for any code-only change**. Full corpus reupload is slow and paid (Bedrock embed cost); only do it when one or more corpus artifacts are stale (new source content, schema change, embed model change).

Deploy steps:

1. Smoke-test the three Thingy model buckets — refuses to deploy if any configured default/fast/advanced model isn't invokable from this account.
2. Package the shared auth/eval artifact and the separate streaming chat artifact.
3. Upload zip to `s3://weekly-thing-librarian/code/{auth,chat}-lambda/<ts>.zip`.
4. If not `--skip-corpus-upload`: upload all three API corpora — Weekly Thing corpus + graph, blog corpus, and podcast corpus.
5. CloudFormation `update-stack` with the new code keys + secrets from `.env` (`SESSION_SECRET`, `LIBRARIAN_RETRIEVE_SECRET`, `BUTTONDOWN_API_KEY`).
6. Configure 30-day log retention on the auto-created log groups.
7. Update `.env` with the latest stack outputs (`LIBRARIAN_API_URL`, `LIBRARIAN_STREAM_URL`).

CI auto-detects code/infra changes in `apps/librarian/` and runs the deploy step (`.github/workflows/deploy.yml`). New blog/podcast content enters through `.github/workflows/sync-external-content.yml`, which commits `data/blog/**` / `data/podcast/**` updates so the production workflow can rebuild and upload corpora. Manual deploys are for local validation before commit.

## Tests

`lambda/tests/*.test.mjs` — Node tests for shared modules (`session`, `conversations`, `attribution`, FAQ search, Bedrock stream parsing, etc.). No end-to-end handler invocation tests — handlers depend on Bedrock + S3 + DynamoDB mocks that don't exist yet.

```bash
npm --prefix apps/librarian/lambda test
# or from lambda/: npm test; make test-lambda runs the fuller `npm run verify`
```

Python tests don't cover this directory — the Lambda is pure Node.

## Env vars set in CloudFormation

These are set at deploy time from `.env`, written into the Lambda environment by CloudFormation. Don't try to read them from `process.env` outside the Lambda.

| Var | Used by | Notes |
|---|---|---|
| `ALLOWED_ORIGIN` | both | Comma-separated CORS origins |
| `TABLE_NAME` | both | DynamoDB conversation table |
| `CORPUS_BUCKET`, `CORPUS_KEY`, `GRAPH_KEY` | stream | S3 corpus/graph location |
| `BLOG_CORPUS_KEY`, `PODCAST_CORPUS_KEY` | stream | Optional source-specific corpora loaded lazily |
| `BUTTONDOWN_API_KEY` | auth | Email subscriber verification |
| `SESSION_SECRET` | both | HMAC secret for session JWTs |
| `LIBRARIAN_RETRIEVE_SECRET` | stream | Trusted service auth for `/retrieve` |
| `FASTMAIL_JMAP_TOKEN` | auth | Fastmail JMAP bearer token for sending magic links; aliases `THINGY_FASTMAIL_JMAP_TOKEN` / `THINGY_JMAP_TOKEN` also work locally |
| `THINGY_MAGIC_LINK_FROM_EMAIL` | auth | Magic-link From address, default `thingy@thingelstad.com` |
| `THINGY_MAGIC_LINK_BASE_URL` | auth | Public URL used when building `?login_token=` links, default `https://thingy.thingelstad.com/` |
| `THINGY_TINYLYTICS_EMAIL_SITE_UID` | auth | Optional Tinylytics site UID override for email tracking pixels; defaults to Thingy's public site UID |
| `LOG_LEVEL` | both | `INFO` default |
| `AUTH_RATE_LIMIT_MAX` | auth | Hourly cap per IP |
| `THINGY_DEFAULT_MODEL` | all | `us.anthropic.claude-sonnet-4-6`; main chat/default persona work |
| `THINGY_FAST_MODEL` | all | `us.anthropic.claude-haiku-4-5-20251001-v1:0`; small structured/background work |
| `THINGY_ADVANCED_MODEL` | all | `us.anthropic.claude-opus-4-6-v1`; high-synthesis work |
| `BEDROCK_EMBEDDING_MODEL` | stream | `cohere.embed-english-v3` |
| `BEDROCK_RERANK_MODEL` | stream | `cohere.rerank-v3-5:0` |
| `BEDROCK_RERANK_REGION` | stream | `us-west-2` (only region with the rerank model) |

## Bedrock model gotchas

- **Rerank lives in us-west-2 only.** The rest of the stack is us-east-1. `BedrockAgentRuntimeClient` is constructed with explicit `region: 'us-west-2'` override. Don't move it.
- **Embedding model is Cohere v3** at 1024 dimensions. Bumping to v4 would invalidate the entire embedded corpus — re-embed cost is $1-2 + ~3 minutes. Plan for it; don't drift accidentally.
- **Thingy models** use cross-region inference profiles. Default is Sonnet 4.6 for main chat/persona work, fast is Haiku 4.5 for structured/background work, and advanced is Opus 4.6 for high-synthesis work. The deploy smoke test checks all three before CloudFormation runs.

## OAuth authorization server (Phase 2 of the MCP plan)

`lambda/auth/oauth-routes.mts` + `lambda/shared/oauth-store.mts` implement an
OAuth 2.1 authorization server on the auth Lambda for the upcoming MCP surface
(Phase 3). Public clients only: dynamic registration (`/register`), PKCE S256
enforced, no client secrets. The `/authorize` flow reuses the magic-code login
machinery (extracted to `lambda/shared/magic-login.mts` so the handler and
oauth-routes share it without an import cycle) and renders small inline HTML
pages. All OAuth rows live in the shared table (`oauthclient#`, `oauthpending#`,
`oauthcode#`, `oauthaccess#`, `oauthrefresh#`, `oauthfamily#` pk prefixes) with
secrets stored as sha256 hex and ttl set; refresh tokens rotate and reuse
revokes the whole family via the family row (no GSI). Token/authorize responses
deliberately skip CORS and the contract header; metadata endpoints are cached
five minutes. Issuer comes from `LIBRARIAN_OAUTH_ISSUER` (default
`https://librarian.thingelstad.com`).

## Conventions

- **Prompts live in `prompts/`** as `.md` files. `loadToolSpecs()` reads them. Edits need a redeploy.
- **All structured logging via `logEvent(level, message, fields)`** — JSON output, CloudWatch-Insights-readable.
- **Magic-link auth is mandatory.** Public `/auth` always sends a Fastmail/JMAP magic link before minting an email session; there is no direct session fallback after subscriber validation.
- **Session tokens are HMAC-signed** (not encrypted). The `sub` claim is the SHA256 hash of the subscriber email (`emailHash()`). Reader sessions last ten days, and a still-valid session can be refreshed by `/auth` `action=refresh_session`.
- **Privacy guarding** lives in `chat/runtime.mts#privacyGuardAnswer`. Don't bypass; readers ask questions that leak their own PII and we don't echo it.
- **Conversation modes are entitlement-gated.** `thingy` is for all readers, `research_guide` requires `supporting_member`, `thought_partner` requires `owner`, and `trusted_circle` requires `trusted_circle`.
- **Citations use `#NNN` for Weekly Thing sources.** Blog and podcast sources should be cited by title/permalink because they do not have issue numbers.
- **Retrieval-secret checks use `crypto.timingSafeEqual`** in `chat/runtime.mts`; preserve constant-time comparison when changing `/retrieve` authentication.

## Known follow-ups

- **No end-to-end handler tests.** Mocking Bedrock + DynamoDB + S3 in Node test is non-trivial; the agent-loop path is exercised in production via real reader Q&A.
- **No automated live QA harness for chat.** Mode/auth/conversation/eval checks are still run manually against the live API when needed. Retrieval now has one: `lambda/scripts/golden-retrieval.mjs` (`npm run golden` in `lambda/`) runs golden questions against the live `/retrieve` endpoint.
- **Operator reads are private.** Static conversation reports remain available locally (`admin/operator_report.py`). The Studio `/thingy/` dashboard route retired with Studio on 2026-08-28. Any public dashboard still needs stronger owner/admin auth first.
