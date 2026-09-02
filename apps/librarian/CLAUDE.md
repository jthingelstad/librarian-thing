# librarian — project memory

Operational notes for the Thingy Lambda stack. Human-facing overview lives in [`README.md`](README.md). The full runtime guide (env vars, IAM cleanup plan, retrieval architecture in depth, Tinylytics events, deployment checklist) is at [`../../reference/librarian.md`](../../reference/librarian.md). This file is the "what to keep in mind when editing here" memory.

## Architecture: three Lambdas, one CloudFormation stack

The Lambda code is **Node.js** (Node 24 runtime, arm64). Everything else in this monorepo is Python — that's intentional: the Lambda needs the AWS SDK v3 + response-streaming primitives, both of which are smoother in Node.

Three Lambdas in `infra/cloudformation.yaml`:

- **`LibrarianFunction`** (`lambda/auth/handler.mts`) — REST API behind API Gateway. Handles Buttondown subscriber lookup, Fastmail/JMAP magic-link login, HMAC session mint/redeem, user conversation list/get/create/rename/share/unshare/delete, the public GET /share/{token} snapshot, and profile updates. Memory 1024 MB, timeout 35s.
- **`LibrarianStreamFunction`** (`lambda/chat/handler.mts` → `runtime.mts`) — Function URL with `RESPONSE_STREAM`. Handles `/chat` (SSE-streamed agent loop with server-side history), `/welcome`, `/feedback`, `/retrieve` (hybrid JSON-only retrieval for wt-builder), `/mcp` (MCP streamable HTTP in stateless mode: OAuth bearer auth via validateAccessToken, the ARCHIVE_TOOLS registry as MCP tools, per-user daily mcp quota pool), and `/tools` (the WebMCP page-tool door: house-style list/call actions over WEB_TOOLS - the MCP set minus fetch_page/web_search - session-authenticated via resolveSessionToken, per-user daily web_tools quota, reached by the web app same-origin as /api/tools; deliberately not routed on librarian.thingelstad.com). Memory 3008 MB, timeout 300s, ReservedConcurrentExecutions = 5.
- **`LibrarianEvalFunction`** (`lambda/eval/handler.mts`) — DynamoDB Stream consumer. Reviews server-side conversations out of band and writes summary/quality/flags back to canonical conversation rows. Memory 1024 MB, timeout 180s, ReservedConcurrentExecutions = 1.

All Lambdas share the same IAM role (`LibrarianFunctionRole`) and `shared/` helpers. The two deployment artifacts also include the `prompts/` directory.

### The `/chat` agent loop

`lambda/chat/runtime.mts` is the main request loop. On each turn:

1. Resolve the session credential (`resolveSessionToken`: explicit Bearer wins, else the `__Host-thingy_session` HttpOnly cookie when the request carries the `X-Thingy-Origin` marker and contract header) and verify it (`verifyToken`, `SESSION_SECRET`).
2. Rate-limit per subscriber hash (DynamoDB, hourly).
3. Resolve requested conversation mode from token entitlements and existing conversation metadata.
4. Load the relevant server-side conversation turns and the basic user profile (preferred name, turn count).
5. Load scoped corpus artifacts from S3 (cached on warm starts).
6. Run prompt preflight for privacy/scope handling.
7. Run the Bedrock Converse agent loop with tool use against the 23-tool `ARCHIVE_TOOLS` registry (`shared/archive-tools.mts`); 18 tools carry published specs (`prompts/tool-specs.json`) and display titles (`prompts/tool-titles.json`), and the same set is exposed over MCP (`web_search` binds only when `BRAVE_SEARCH_API_KEY` is set) and - minus the two outbound-network tools - over `/tools` for the WebMCP page module; both external doors share one audited invoker (`archiveToolInvoker`) and result serializer (`renderToolResultText`), with audit rows stamped `surface: 'mcp' | 'web'`. Five tools are registry-internal with no published spec: `get_issue`, `get_section`, `domain_history`, `list_issues`, `compare_eras`. All lexical filtering goes through the canonical matcher (`shared/matcher.mts`, spec in [`MATCHER.md`](MATCHER.md)).
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
5. CloudFormation `update-stack` with the new code keys + secrets from `.env` (`SESSION_SECRET`, `LIBRARIAN_RETRIEVE_SECRET`, `BUTTONDOWN_API_KEY`, `THINGY_WEB_ORIGIN_TOKEN`).
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
| `THINGY_WEB_ORIGIN_TOKEN` | both | Marker the thingy.thingelstad.com distribution stamps as `X-Thingy-Origin`; cookie-based web sessions require it (empty disables cookie auth - the kill switch; Bearer unaffected) |
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
| `BRAVE_SEARCH_API_KEY` | stream | Optional; enables the `web_search` tool (spec binds only when set) |
| `LIBRARIAN_SOURCE_REVISION` | stream | Set by CFN to `StreamCodeKey`; stamped onto tool traces |
| `CHAT_DAILY_QUOTA`, `MCP_DAILY_QUOTA`, `WEB_TOOLS_DAILY_QUOTA` | both | Optional overrides; defaults 50 / 500 / 200 per reader per day (doubled for supporting members, owner exempt) |
| `LIBRARIAN_OAUTH_ISSUER` | auth | Optional; OAuth issuer, default `https://librarian.thingelstad.com` |

## Bedrock model gotchas

- **Rerank lives in us-west-2 only.** The rest of the stack is us-east-1. `BedrockAgentRuntimeClient` is constructed with explicit `region: 'us-west-2'` override. Don't move it.
- **Embedding model is Cohere v3** at 1024 dimensions. Bumping to v4 would invalidate the entire embedded corpus — re-embed cost is $1-2 + ~3 minutes. Plan for it; don't drift accidentally.
- **Thingy models** use cross-region inference profiles. Default is Sonnet 4.6 for main chat/persona work, fast is Haiku 4.5 for structured/background work, and advanced is Opus 4.6 for high-synthesis work. The deploy smoke test checks all three before CloudFormation runs.

## OAuth authorization server (for the live MCP surface)

`lambda/auth/oauth-routes.mts` + `lambda/shared/oauth-store.mts` implement an
OAuth 2.1 authorization server on the auth Lambda for the MCP server at
`/mcp` on the stream Lambda. Public clients only: dynamic registration (`/register`), PKCE S256
enforced, no client secrets. The `/authorize` flow reuses the magic-code login
machinery (extracted to `lambda/shared/magic-login.mts` so the handler and
oauth-routes share it without an import cycle) and renders small inline HTML
pages. All OAuth rows live in the shared table (`oauthclient#`, `oauthpending#`,
`oauthcode#`, `oauthaccess#`, `oauthrefresh#`, `oauthfamily#` pk prefixes) with
secrets stored as sha256 hex and ttl set; refresh tokens rotate and reuse
revokes the whole family via the family row (no GSI). Token/authorize responses
deliberately skip CORS and the contract header; metadata endpoints are cached
five minutes. Issuer comes from `LIBRARIAN_OAUTH_ISSUER` (default
`https://librarian.thingelstad.com`). The authorization response carries the
RFC 9207 `iss` parameter; the consent redirect is a 303; the sign-in pages use
Thingy's design tokens, prefill the verified email from a first-party
`thingy_email` cookie (CloudFront forwards only that cookie), and the pages'
CSP `form-action` must keep `https:` - `'self'` alone silently blocks the
consent redirect in Chromium.

## Evals gate the deploy

Three layers run in `.github/workflows/deploy.yml` and block it on failure:
`tests/matcher.test.mjs` (matcher fixtures - every shipped matching bug as a
negative), `scripts/eval-tools.mjs` (response invariants + known answers over
the real corpora from S3), and the committed recall baseline
(`lambda/eval/baseline.json`, 10% band; run `node scripts/eval-tools.mjs
--update-baseline` to accept a REVIEWED recall change, e.g. after corpus
growth). Locally: `EVAL_CORPUS_DIR=<dir-with-corpus.json>` runs it against
local corpus files; `EVAL_DIST_DIR` points it at an older build for
pre/post-change reports. Tool responses carry `server_version`
(`1.1.0+tools.<prompt fingerprint>`), the cache key MCP clients use to detect
a stale tools/list.

## Conventions

- **Prompts live in `prompts/`** as `.md` files. `loadToolSpecs()` reads them. Edits need a redeploy.
- **All structured logging via `logEvent(level, message, fields)`** — JSON output, CloudWatch-Insights-readable.
- **Magic-link auth is mandatory.** Public `/auth` always sends a Fastmail/JMAP magic link before minting an email session; there is no direct session fallback after subscriber validation.
- **Session tokens are HMAC-signed** (not encrypted). The `sub` claim is the SHA256 hash of the subscriber email (`emailHash()`). Since 2026-09-01 the web app carries the token in the `__Host-thingy_session` HttpOnly cookie (`shared/web-session.mts`); Bearer remains the permanent path for qa-real, local dev, and non-browser clients, and always wins over the cookie. Sessions last nine days and SLIDE server-side: `/auth` `action=session` (the UI's signed-in probe; answers 200 `authenticated:false` when signed out) and `action=refresh_session` re-mint and re-set the cookie, re-verifying Buttondown entitlements near staleness (lapsed = cookie cleared / 401; Buttondown outages fail open). A cookie-sourced response never echoes the token into the JSON body. A privileged session whose verification expired with no self-bound email to re-verify against is signed out rather than silently downgraded to reader (owner exempt). `action=sign_out` clears the cookie and requires the contract header.
- **Privacy guarding** lives in `chat/runtime.mts#privacyGuardAnswer`. Don't bypass; readers ask questions that leak their own PII and we don't echo it.
- **Conversation modes are retired as a user-facing feature** (mode picker removed 2026-08; retirement confirmed 2026-09-01). Every new conversation is `thingy`. The entitlement gating in `conversation-modes.mts` stays as vestigial enforcement so old conversations keep their stored mode - do not extend it or add modes without an explicit product decision.
- **Tool traces are structured evidence (schema v2).** `shared/tool-evidence.mts` summarizes every tool call into allow-listed, bounded evidence refs; `toolTraceDynamoString` degrades per call to fit, never `{omitted: true}` for an oversized trace. Turn rows carry cumulative loop usage and `prompt_fingerprint`/`source_revision` stamps - keep those fields when touching turn persistence.
- **Citations use `#NNN` for Weekly Thing sources.** Blog and podcast sources should be cited by title/permalink because they do not have issue numbers.
- **Retrieval-secret checks use `crypto.timingSafeEqual`** in `chat/runtime.mts`; preserve constant-time comparison when changing `/retrieve` authentication.

## Known follow-ups

- **No end-to-end handler tests.** Mocking Bedrock + DynamoDB + S3 in Node test is non-trivial; the agent-loop path is exercised in production via real reader Q&A.
- **No automated live QA harness for chat.** Mode/auth/conversation checks are still run manually against the live API when needed. Retrieval has a live golden suite: `lambda/scripts/golden-retrieval.mjs` (`npm run golden` in `lambda/`). Improve Thingy does not call either HTTP surface during its scheduled review.
- **Codex conversation and MCP review.** `admin/conversation_review.py` is the private, read-only production-evidence path for Improve Thingy. `list` / `show <conversation-id>` review native conversations; `mcp-list` / `mcp-show <request-id>` review real MCP tool calls recorded with a 14-day TTL. MCP lifecycle traffic is excluded, tool arguments and result evidence are bounded, and the reviewer explicitly marks the external client's prompt/final synthesis/feedback unavailable. It never signs in, sends email, creates traffic, invokes a model grader, or writes evaluator state. Raw output stays only in the active Codex run; durable findings are aggregate and anonymous.
- **Operator reads are private.** Static conversation reports remain available locally (`admin/operator_report.py`). The Studio `/thingy/` dashboard route retired with Studio on 2026-08-28. Any public dashboard still needs stronger owner/admin auth first.
