# librarian — project memory

Operational notes for the Thingy Lambda stack. Human-facing overview lives in [`README.md`](README.md). The full runtime guide (env vars, IAM cleanup plan, retrieval architecture in depth, Tinylytics events, deployment checklist) is at [`../../reference/librarian.md`](../../reference/librarian.md). This file is the "what to keep in mind when editing here" memory.

## Architecture: three Lambdas, one CloudFormation stack

The Lambda code is **Node.js** (Node 24 runtime, arm64). Everything else in this monorepo is Python — that's intentional: the Lambda needs the AWS SDK v3 + response-streaming primitives, both of which are smoother in Node.

Three Lambdas in `infra/cloudformation.yaml`:

- **`LibrarianFunction`** (`lambda/auth/handler.mts`) — REST API behind API Gateway. Handles Buttondown subscriber lookup, Fastmail/JMAP magic-link login, HMAC session mint/redeem, user conversation list/get/create/rename/share/unshare/delete, the public GET /share/{token} snapshot, and profile updates. Memory 1024 MB, timeout 35s.
- **`LibrarianStreamFunction`** (`lambda/chat/handler.mts` → `runtime.mts`) — Function URL with `RESPONSE_STREAM`. Handles `/chat` (SSE-streamed agent loop with server-side history; without a valid session it falls through to the guest lane - `handleGuestChat`: no persistence/memory/profile, client-supplied sanitized history, WEB_TOOLS only, IP-keyed rate limit + strict per-visitor and global daily quotas), `/welcome`, `/feedback`, `/retrieve` (hybrid JSON-only retrieval for wt-builder), `/mcp` (MCP streamable HTTP in stateless mode: OAuth bearer auth via validateAccessToken, the ARCHIVE_TOOLS registry as MCP tools plus `view_photo` — an MCP-only tool outside the registry (`shared/photo-view.mts`) that returns archive photos as image content blocks so MCP clients render them inline and get vision over them; allowlisted archive hosts only, max 3 per call, base64 never enters audit rows or the Bedrock loop — per-user daily mcp quota pool), and `/tools` (the WebMCP page-tool door: house-style list/call actions over WEB_TOOLS - the MCP set minus fetch_page/web_search - session-authenticated via resolveSessionToken, per-user daily web_tools quota, reached by the web app same-origin as /api/tools; deliberately not routed on librarian.thingelstad.com). Memory 3008 MB, timeout 300s, ReservedConcurrentExecutions = 5.
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
7. Run the Bedrock Converse agent loop with tool use against the 25-tool `ARCHIVE_TOOLS` registry (`shared/archive-tools.mts`); 21 tools carry published specs (`prompts/tool-specs.json`) and display titles (`prompts/tool-titles.json`), and the same set is exposed over MCP (`web_search` binds only when `BRAVE_SEARCH_API_KEY` is set) and - minus the two outbound-network tools - over `/tools` for the WebMCP page module; both external doors share one audited invoker (`archiveToolInvoker`), argument validation before quota (`validateToolArguments`) and result renderer (`renderToolCallResult`: `isError` + `code` on errors, compact JSON cut structurally to `MCP_RESULT_MAX_CHARS` = 48,000; limits live in `TOOL_LIMITS`, which `tests/mcp-conventions.test.mjs` holds to the specs), `/mcp` under a 300/hr rate limit, with audit rows stamped `surface: 'mcp' | 'web'` and `server_version`; `/mcp` rows also carry the OAuth `client_id` and its registered `client_name` (read once per client per warm container), and `/tools` rows carry no client. The chat loop holds its own calls to the same door rules: `validateToolArguments` refuses an undeclared or out-of-schema argument as a `bad_request` naming `accepted_arguments`, and every `{error}` result reaches the model through `toolErrorRecord` with a `code` and one `next` step (results stay uncapped there; Bedrock context is cheap). Four tools are registry-internal with no published spec: `get_issue`, `get_section`, `domain_history`, `list_issues`. All lexical filtering goes through the canonical matcher (`shared/matcher.mts`, spec in [`MATCHER.md`](MATCHER.md)).
8. Stream answer deltas, archive-work status, final citations, and the done event's receipt ({duration_ms, total_tokens, tool_steps}, contract 4.8) via SSE; record the turn to DynamoDB; bump the per-user profile counters. A `share_token` in the body (contract 4.7) seeds the context with a shared conversation's active chain - the guest lane and a signed-in first turn both use it, and the reader context marks the seeded turns as another reader's.

The retrieval pipeline lives in `lambda/shared/retrieval.mts`:

- **`embedQuery`** — Bedrock Cohere `embed-english-v3` (us-east-1).
- **`semanticScore`** — cosine similarity against pre-embedded corpus chunks; year/section filters run inside the scan (before the top-K slice), not as a post-filter.
- **`retrieveLexical`** — TF-IDF term-vector scoring over an in-memory index, with the same in-scan filters. Not a fallback: it always runs (free, and carries proper nouns dense retrieval misses).
- **`fuseCandidates`** — reciprocal-rank fusion (RRF, k=60) of the semantic and lexical lists; rank-based because cosine and TF-IDF scores aren't on a comparable scale.
- **`rerankSources`** — Bedrock Cohere `rerank-v3-5:0` (us-west-2 — only region with rerank) over the fused pool, capped at max(limit×5, 100) candidates.
- **`retrieve`** — orchestrator: both engines scan every query, RRF merges, one rerank orders the fused pool; degrades to lexical-only if the embedding call fails.

### The `/retrieve` endpoint

Added in May 2026. Same `retrieve()` function `/chat` uses, exposed as a JSON-only POST with service-retrieval auth (no per-user session token). Returns `{passages, embedding_model, rerank_model, request_id}`. Called by `wt-builder` (`src/server/integrations/librarian.ts`: Echoes, the link wand, the archive-leg verify) and `at-builder` (`src/server/librarian.ts`: hooks, prospecting). workshop_bot, the original client, was retired with Studio on 2026-08-28. Since contract 4.11 each passage carries `id`, `label` (WT351 / AT3 / post title), an absolute `url` and a public `source_kind` (`shared/source-identity.mts`); requests take `filters.sourceKinds` / `excludeSourceKinds` / `excludeIssues` / `before` / `issueNumber` and a `caller` name that `retrieve_completed` logs with the scope and filter keys. Contract 4.12 adds `filters.sectionFamily`, `contentKind`, `voice` (`jamie` / `quoted` / `link`: each passage is cut to that voice's `spans` before the rerank, and one with under 40 characters of it is dropped) and `calendar` `{date, window_days}` (sources within `window_days`, capped at 7, of that month-day in an earlier year); an unknown voice or malformed calendar is a 400 (`retrievalFilterError`). `section` also matches the family exactly. Passages carry `section_family`, `content_kind`, and `voice` when filtered. Every filter holds on a corpus built without these fields (no family matches nothing; no spans is all Jamie), because CI runs eval-tools on the new Lambda against the previous corpora.

The `retrieveSecretOk` helper in `chat/runtime.mts` compares against `LIBRARIAN_RETRIEVE_SECRET` via `crypto.timingSafeEqual`. The request body still accepts the historical `bridge_secret` field so existing trusted clients keep the versioned `/retrieve` contract.

### The subscribe path (`/auth`, action `subscribe`)

The site's form calls this before anything reaches Buttondown. Since
2026-09-20 it is built so a reader who asked to subscribe is never lost:

- **The ledger first.** Every attempt is written to the Librarian table
  (`pk subscribe#attempt`, real address, 90-day TTL) before Buttondown is
  asked, and updated with the outcome (`shared/subscribe-ledger.mts`).
  Twelve addresses failed in the 30 days before this and the only trace was
  a hash in the log.
- **Suppressed addresses get the truth.** Buttondown's `GET /subscribers`
  answers 404 for an address on its suppression list, and the create then
  fails `subscriber_suppressed` (bare) or `subscriber_blocked` (with a client
  IP). The handler retries once with `X-Buttondown-Collision-Behavior: add`
  (revives a plain unsubscribe), and if that is refused too answers **200
  `needs_jamie`** with a sentence telling the reader to email Jamie — never a
  502, which made the site re-post the raw form to Buttondown and its
  dead-end page (Patrick, 2026-09-20).
- **The morning digest.** `LibrarianSubscribeDigestRule` invokes this Lambda
  daily at 12:00 UTC with `{task: "subscribe_digest"}`; it mails Jamie every
  attempt of the last day that did not end on the list, plus subscribers the
  firewall accepted-as-blocked, or nothing on a clean day
  (`shared/subscribe-digest.mts`, via JMAP from the magic-link sender).
- **Our-side failures alarm.** `LibrarianSubscribeFailuresAlarm` counts
  lookup/create/reminder/ledger failures (not suppressions) and goes to the
  ops queue within the hour.

## Deploy

Normal deployments run in GitHub Actions after a verified commit/push.
`make librarian-deploy` queues a code-only deploy of remote `main` and prints its
run URL; it needs GitHub authentication but no local AWS CLI session. Wait for
the run before reporting acceptance. Direct
`uv run --locked python pipeline/deploy/aws.py` is an exceptional local operation
requiring valid AWS credentials.
The deploy script must run through the locked uv environment so dependencies such as
`boto3` and `python-dotenv` are available; do not invoke it with bare system Python.

```bash
# Default: skip corpus reupload — code+infra only
make librarian-deploy ARGS="--skip-corpus-upload"

# Full deploy (rebuilds + embeds + uploads Weekly Thing, blog, and podcast corpora)
make librarian-deploy-full

# Exceptional local deployment when bypassing make
uv run --locked python pipeline/deploy/aws.py --skip-corpus-upload
```

The `--skip-corpus-upload` flag is the **default for any code-only change**. Full corpus reupload is slow and paid (Bedrock embed cost); only do it when one or more corpus artifacts are stale (new source content, schema change, embed model change).

Deploy steps:

1. Smoke-test the three Thingy model buckets — refuses to deploy if any configured default/fast/advanced model isn't invokable from this account.
2. Package the shared auth/eval artifact and the separate streaming chat artifact.
3. Upload zip to `s3://weekly-thing-librarian/code/{auth,chat}-lambda/<ts>.zip`.
4. If not `--skip-corpus-upload`: upload all three API corpora — Weekly Thing corpus + graph, blog corpus, and podcast corpus.
5. CloudFormation `update-stack` with the new code keys + credential parameters (`SESSION_SECRET`, `LIBRARIAN_RETRIEVE_SECRET`, `BUTTONDOWN_API_KEY`, `THINGY_WEB_ORIGIN_TOKEN`, ...), which the stack writes into the `weekly-thing-librarian-runtime` secret.
6. Configure 30-day log retention on the auto-created log groups.
7. Update `.env` with the latest stack outputs (`LIBRARIAN_API_URL`, `LIBRARIAN_STREAM_URL`).

CI auto-detects code/infra changes in `apps/librarian/` and runs the deploy step (`.github/workflows/deploy.yml`). It also redeploys after any corpus upload: a container loads each corpus once and keeps it, so a new corpus is only served by fresh containers. New blog/podcast content enters through `.github/workflows/sync-external-content.yml`, which commits `data/blog/**` / `data/podcast/**` updates so the production workflow can rebuild and upload corpora. Manual deploys are for local validation before commit.

## Tests

`lambda/tests/*.test.mjs` — Node tests for shared modules (`session`, `conversations`, `attribution`, FAQ search, Bedrock stream parsing, etc.). No end-to-end handler invocation tests — handlers depend on Bedrock + S3 + DynamoDB mocks that don't exist yet.

```bash
npm --prefix apps/librarian/lambda test
# or from lambda/: npm test; make test-lambda runs the fuller `npm run verify`
```

Python tests don't cover this directory — the Lambda is pure Node.

## Env vars set in CloudFormation

These are set at deploy time from `.env`, written into the Lambda environment by CloudFormation. Don't try to read them from `process.env` outside the Lambda.

**Credentials are the exception (2026-10-01).** `BUTTONDOWN_API_KEY`,
`SESSION_SECRET`, `THINGY_WEB_ORIGIN_TOKEN`, `FASTMAIL_JMAP_TOKEN`,
`LIBRARIAN_RETRIEVE_SECRET`, `BRAVE_SEARCH_API_KEY` and
`LIBRARIAN_GOLDEN_RETRIEVE_SECRET` live in one Secrets Manager secret,
`weekly-thing-librarian-runtime` (a JSON object of those names). The stack
writes it from its NoEcho parameters (the golden value by dynamic reference),
and the functions get only `LIBRARIAN_RUNTIME_SECRET_ARN`. `loadRuntimeSecrets()`
(`shared/runtime-secrets.mts`) reads it once per cold start into `process.env`
before the handler runs, so the readers below are unchanged. It logs
`runtime_secrets_loaded` with key names only and fails closed: no secret and no
value already present is a 503, never an unkeyed run (an empty
`THINGY_WEB_ORIGIN_TOKEN` would switch the origin check off). Do not put a
`{{resolve:secretsmanager}}` reference in a function's `Environment`: it is
resolved into plaintext configuration. A new credential goes into the secret's
`!Sub` JSON, `RUNTIME_SECRET_KEYS`, and an `AllowedPattern` that keeps `"` and
`\` out. The runtime boundary allows reading this secret only
(`pipeline/deploy/iam/runtime-boundary.json`, applied with `setup-oidc.sh`).

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
| `THINGY_MAGIC_LINK_BASE_URL` | auth | The SITE ROOT (default `https://thingy.thingelstad.com/`): `shareUrl()` derives `/c/<token>` links from it, and `magicLinkBaseWithReturnPath()` forces `/signin/` onto emailed magic links regardless - do not point this at a path |
| `THINGY_TINYLYTICS_EMAIL_SITE_UID` | auth | Optional Tinylytics site UID override for email tracking pixels; defaults to Thingy's public site UID |
| `LOG_LEVEL` | both | `INFO` default |
| `AUTH_RATE_LIMIT_MAX` | auth | Hourly cap per IP |
| `THINGY_DEFAULT_MODEL` | all | `us.anthropic.claude-sonnet-4-6` (interim; flip to `claude-sonnet-5` when the AWS support case provisions 5-gen backend quotas - agreements already ACTIVE); main chat/default persona work |
| `THINGY_FAST_MODEL` | all | `us.anthropic.claude-haiku-4-5-20251001-v1:0`; small structured/background work |
| `THINGY_PREMIUM_MODEL` | all | `us.anthropic.claude-opus-4-6-v1` (interim; flip to `claude-opus-5` with the same support case); chat answers for supporting members and the owner (entitlement-routed, 2026-09-02; replaces the never-invoked Dispatch-era THINGY_ADVANCED_MODEL) |
| `BEDROCK_EMBEDDING_MODEL` | stream | `cohere.embed-english-v3` |
| `BEDROCK_RERANK_MODEL` | stream | `cohere.rerank-v3-5:0` |
| `BEDROCK_RERANK_REGION` | stream | `us-west-2` (only region with the rerank model) |
| `BRAVE_SEARCH_API_KEY` | stream | Optional; enables the `web_search` tool (spec binds only when set) |
| `LIBRARIAN_SOURCE_REVISION` | stream | Set by CFN to `StreamCodeKey`; stamped onto tool traces |
| `CHAT_DAILY_QUOTA`, `MCP_DAILY_QUOTA`, `WEB_TOOLS_DAILY_QUOTA` | both | Optional overrides; defaults 50 / 500 / 200 per reader per day (doubled for supporting members, owner exempt) |
| `THINGY_GUEST_CHAT`, `GUEST_DAILY_QUOTA`, `GUEST_GLOBAL_DAILY_QUOTA` | stream | Guest chat lane (2026-09): `off` is the kill switch; per-visitor (3) and global (25, lowered from 100 after the 2026-09-02 scraper fleet) daily caps, both FAIL-CLOSED (`consumeDailyQuotaStrict`) - the global cap is the dollar circuit breaker and trips the `LibrarianGuestBreakerAlarm`. Guest `/chat` additionally requires the `X-Thingy-Origin` marker when `THINGY_WEB_ORIGIN_TOKEN` is configured (`guestOriginOk`) - direct-to-Lambda guest traffic is rejected `guest_origin_required` before any quota spend |
| `LIBRARIAN_OAUTH_ISSUER` | auth | Optional; OAuth issuer, default `https://librarian.thingelstad.com` |

## Bedrock model gotchas

- **Rerank lives in us-west-2 only.** The rest of the stack is us-east-1. `BedrockAgentRuntimeClient` is constructed with explicit `region: 'us-west-2'` override. Don't move it.
- **Embedding model is Cohere v3** at 1024 dimensions. Bumping to v4 would invalidate the entire embedded corpus — re-embed cost is $1-2 + ~3 minutes. Plan for it; don't drift accidentally.
- **Thingy models** use cross-region inference profiles. Default is Sonnet 4.6 for main chat/persona work (readers and guests), fast is Haiku 4.5 for structured/background work, and premium is Opus 4.6 for supporting members and the owner (entitlement-routed in the chat loop). The 5-generation upgrade (Sonnet 5 default, Opus 5 premium) is a two-value CFN env flip once the AWS support case clears the 403 - marketplace agreements are already ACTIVE. The deploy smoke test checks all three before CloudFormation runs.
- **The Claude 5 family rejects sampling params.** `modelAcceptsSamplingParams()` in `shared/aws-clients.mts` gates `temperature` out of inferenceConfig for sonnet-5/opus-5/opus-4.7/opus-4.8/fable - sending it is a ValidationException, not a no-op. New Converse call sites must use the same gate.

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

**Connections (contract 4.13.0, 2026-10-01).** A reader's "MCP connection" is
one refresh family. Every code exchange and refresh upserts a
`user#<hash>` / `mcpconn#<family id>` row (`shared/mcp-connections.mts`:
client id and registered name, connected/last authorized; ttl and
`expires_at` slide with the family's), and each audited `/mcp` call stamps `connection_id` on its
audit row and bumps the row's `last_used_at`/`call_count`. Access tokens carry
their `family_id`, and `validateAccessToken` refuses one whose family row is
gone - so disconnecting (`revokeRefreshFamily`) cuts the client off at once,
not when its access token expires. Tokens minted before 4.13.0 have no
`family_id` and expire within the hour; grants from then show up as
connections at their next refresh. The reader-facing doors are `/memory`
actions on the auth Lambda, always scoped to the caller's own partition:
`mcp_connections` (live families only), `mcp_disconnect` (`connection_id`;
404 if not theirs or gone), and `mcp_log` (their own `mcp#` audit rows inside
the retention window, newest first, filter by `connection_id` or `surface`,
opaque base64url `next_cursor` that must decode to an `mcp#` sort key).
`delete_profile` revokes every connection before deleting the profile. Thingy
renders these in Profile > MCP connections and its request log.

**Sliding connections (contract 4.14.0, 2026-10-01).** A family has no absolute
cap any more. It lives while it is refreshed within `OAUTH_FAMILY_IDLE_SECONDS`
(= the 30-day refresh-token TTL); every refresh slides the family row's ttl and
the connection row's `expires_at`. The 90-day cap (audit A4) existed so a lapsed
reader's grant would decay. Its replacement is the web session's re-check:
- **Membership re-check.** The verified email travels pending → auth code (five
  minutes) → the family row, next to `entitlements_verified_at`. When that is
  older than `MEMBERSHIP_RECHECK_SECONDS` (`ENTITLEMENT_VERIFICATION_SECONDS`,
  nine days), `redeemRefreshToken` calls the route's `checkConnectionMembership`.
  `active` or `premium` re-derives the entitlements and restarts the clock;
  anything else revokes the family, and the client gets `invalid_grant` and must
  re-authorize. A Buttondown error keeps the entitlements and asks again on the
  next refresh. The owner (`isOwnerSubscriberHash`) is never sent to Buttondown.
- **Where the email lives.** Only on the family row, never on token rows and
  never in logs (hashes only). It goes when the family row goes: disconnect,
  reuse, lapse, idle ttl, and `delete_profile`. The family row also carries
  `subscriber_hash`, so profile deletion's `SubscriberHashIndex` sweep finds it
  even without a connection row.
- **Member list.** `member_hashes` keeps only the newest
  `OAUTH_FAMILY_MEMBERS_KEPT` (16). Rotation is serial, so the live token is
  always kept, and a dropped rotated token still trips reuse detection through
  its own `rotated_to`. Untrimmed, an hourly refresher would grow the row
  toward the 400KB item limit.
- **Refusals.** A refresh is refused when its family row is gone or past its
  ttl. The family write is conditional, so a refresh racing a disconnect cannot
  bring the row back.
- **Legacy families.** A family minted before this change has no email, so it
  keeps `LEGACY_FAMILY_MAX_SECONDS` (90 days from consent). The reader's next
  sign-in makes a family that slides.
- **AWS DevOps Agent 3LO.** `/token` also takes `client_id` as HTTP Basic with
  an empty secret (`tokenRequestClientId`; a non-empty secret, or a Basic id
  that disagrees with the body, is a 401 `invalid_client`). The
  `offline_access` scope that DevOps Agent always sends is accepted and dropped
  (`normalizeScope`). DevOps Agent does no dynamic registration; the reader
  sets it up by hand in Thingy (below).

**Apps set up by hand (contract 4.15.0, 2026-10-01).** Some clients ask for a
client ID instead of registering themselves (AWS DevOps Agent's 3LO form shows
a callback URL and asks for client ID, secret, authorization and exchange
URLs, scope, PKCE). Profile > MCP connections in Thingy has a generic "connect
an app that asks for a client ID" form (Jamie: no per-app presets): a name and
the app's callback URL. `/memory` actions (`shared/mcp-registered-clients.mts`):
- `mcp_register_client` `{client_name, redirect_uri}` creates a public client
  whose row carries `owner_hash`, plus a `user#<hash>` / `mcpclient#<id>` panel
  row. At most `MAX_READER_CLIENTS` (10) per reader, 10 per hour. It answers
  the client with `settings`: client id, empty secret, `/authorize`, `/token`,
  `/mcp`, `archive:read`, `pkce: true` - every value the form needs.
- `mcp_clients` lists them (lapsed client rows dropped and cleaned up) with
  their settings and live `connection_count`.
- `mcp_delete_client` `{client_id}` disconnects the reader's connections
  through it, then deletes the client and the panel row.
- An owned client authorizes its owner only (`clientOwnerRefusal`, at the code
  and approve steps): a reader cannot cut someone else off by deleting it.
- `/token` refuses a client that no longer exists (401 `invalid_client`), so a
  deleted app stops refreshing even without a connection row, and the lookup
  renews the client's one-year ttl, so a client that only refreshes never
  lapses.
- `delete_profile` deletes the reader's owned clients.
Tests: `lambda/tests/mcp-registered-clients.test.mjs`.

## Evals gate the deploy

Three layers run in `.github/workflows/deploy.yml` and block it on failure:
`tests/matcher.test.mjs` (matcher fixtures - every shipped matching bug as a
negative), `scripts/eval-tools.mjs` (response invariants + known answers over
the real corpora from S3), and the committed recall baseline
(`lambda/eval/baseline.json`, 10% band; run `node scripts/eval-tools.mjs
--update-baseline` to accept a REVIEWED recall change, e.g. after corpus
growth). Locally: `EVAL_CORPUS_DIR=<dir-with-corpus.json>` runs it against
local corpus files; `EVAL_DIST_DIR` points it at an older build for
pre/post-change reports. The same eval also gates every corpus upload: each
upload script embeds into `.candidate/` with `--stage`, the "Corpus gate"
step evals those candidates (`EVAL_CORPUS_FALLBACK=s3` reads the live copy of
any corpus not rebuilt), and only then does `--upload-staged` ship the exact
files it checked. A corpus that fails never reaches S3. Tool responses carry `server_version`
(`2.4.0+tools.<prompt fingerprint>`), the cache key MCP clients use to detect
a stale tools/list. 2.4.0 (2026-10-01) adds Jamie's micro.blog Pages to the
blog source (see "Pages" below); 2.3.0 (2026-10-01) is the second QA pass: Weekly Thing audio editions (`has_audio`, chapter starts on passages), and the round-2 completeness fixes; 2.2.0 (2026-10-01) carries Jamie's answers to the QA questions (Chicago days, editorial links, the blog post canonical over its Journal copy, whole-source reads with `offset`); 2.1.0 (2026-09-30) pages every list with `offset` and counts what it leaves out; 2.0.0 is the breaking consistency pass (id-only
`get_source`, grouped `search_archive`, `find_evidence`, one `truncated`
block, `outputSchema` and `structuredContent`); `reference/librarian.md` lists
it, and `tests/mcp-conventions.test.mjs` enforces it. Readers connect with the
steps on thingy web `web/connect/index.html`; keep that page's limits and tool
claims in step with the server. Since 1.6.0 the MCP door also serves resources
(`shared/mcp-resources.mts`: `librarian://wt/{n}`, `blog/{id}`, `page/{id}`, `topic/{slug}`,
`year/{yyyy}`, `on-this-day/{mm-dd}`, read through the registry tools, one quota
unit each, audited as `resource:<kind>`) and five prompts
(`shared/mcp-prompts.mts`), which never speak as Jamie.

## Pages (2.4.0, 2026-10-01)

Jamie's micro.blog Pages (About, Lists, Collections, Open Loop) are part of
the blog source. `pipeline/blog/ingest_blog.py` reads the Micropub `pages`
channel every night into `data/blog/pages/`; `data/blog/index.json` names
every page kept (`pages`) and every page left out with its reason
(`pages_excluded`: `/family/`, pages about the website, templates, empty
pages, redirect stubs, link-only navigation). Page uids are a separate number
space from posts (page 71862 shares its number with a post), so a page is
`page_id`, never `microblog_id`: its id is `page-<uid>`, its source key
`page:<uid>`, its chunks `page:<uid>:<n>:<hash>`, and a link to it resolves
as `target_page_id` (`shared/source-identity.mts` holds the helpers). A page's
micro.blog `published` is its last edit, so pages are undated
(`publish_date` null, `updated` shown): `latest_content`, `on_this_day`, year
filters and eras leave them out; `list_content` and `quote_search` list them
after every dated source; `corpus_stats` reports `page_count`. Tests:
`lambda/tests/blog-pages.test.mjs`, `tests/test_blog_pages.py`.

## Conventions

- **Prompts live in `prompts/`**: `agent-system.md`, `agent-user.md`, `answer-style.md`, `premium-thank-you.md`, plus `tool-specs.json`/`tool-titles.json`. Loaders are in `shared/prompts.mts`. Edits need a redeploy. `tests/chat-tool-routing.test.mjs` holds `agent-system.md` to the bound specs: every taught `tool(arg=...)` call must use a declared argument and enum value, and every bound tool must be named, so a schema change that strands the chat's routing fails CI.
- **All structured logging via `logEvent(level, message, fields)`** — JSON output, CloudWatch-Insights-readable.
- **Magic-link auth is mandatory.** Public `/auth` always sends a Fastmail/JMAP magic link before minting an email session; there is no direct session fallback after subscriber validation.
- **Session tokens are HMAC-signed** (not encrypted). The `sub` claim is the SHA256 hash of the subscriber email (`emailHash()`). Since 2026-09-01 the web app carries the token in the `__Host-thingy_session` HttpOnly cookie (`shared/web-session.mts`); Bearer remains the permanent path for qa-real, local dev, and non-browser clients, and always wins over the cookie. Sessions last 30 days (nine until 2026-09-29) and SLIDE server-side, capped at 90 days from the original sign-in; Buttondown entitlements stay trusted for only nine days (`ENTITLEMENT_VERIFICATION_SECONDS`), so a longer session never stretches a lapsed membership: `/auth` `action=session` (the UI's signed-in probe; answers 200 `authenticated:false` when signed out) and `action=refresh_session` re-mint and re-set the cookie, re-verifying Buttondown entitlements near staleness (lapsed = cookie cleared / 401; Buttondown outages fail open). A cookie-sourced response never echoes the token into the JSON body. A privileged session whose verification expired with no self-bound email to re-verify against is signed out rather than silently downgraded to reader (owner exempt). `action=sign_out` clears the cookie and requires the contract header.
- **Privacy guarding** lives in `chat/runtime.mts#privacyGuardAnswer`. Don't bypass; readers ask questions that leak their own PII and we don't echo it.
- **Conversation modes are retired as a user-facing feature** (mode picker removed 2026-08; retirement confirmed 2026-09-01). Every new conversation is `thingy`. The entitlement gating in `conversation-modes.mts` stays as vestigial enforcement so old conversations keep their stored mode - do not extend it or add modes without an explicit product decision.
- **Tool traces are structured evidence (schema v2).** `shared/tool-evidence.mts` summarizes every tool call into allow-listed, bounded evidence refs; `toolTraceDynamoString` degrades per call to fit, never `{omitted: true}` for an oversized trace. Turn rows carry cumulative loop usage and `prompt_fingerprint`/`source_revision` stamps - keep those fields when touching turn persistence.
- **Citations use `WT<N>` for Weekly Thing sources** (never a bare `#N` - the prompt and client autolink agree on this). Blog and podcast sources should be cited by title/permalink because they do not have issue numbers.
- **Retrieval-secret checks use `crypto.timingSafeEqual`** in `chat/runtime.mts`; preserve constant-time comparison when changing `/retrieve` authentication.

## Known follow-ups

- **No end-to-end handler tests.** Mocking Bedrock + DynamoDB + S3 in Node test is non-trivial; the agent-loop path is exercised in production via real reader Q&A.
- **No automated live QA harness for chat.** Mode/auth/conversation checks are still run manually against the live API when needed. Retrieval has a live golden suite: `lambda/scripts/golden-retrieval.mjs` (`npm run golden` in `lambda/`). Improve Thingy does not call either HTTP surface during its scheduled review.
- **Codex conversation and MCP review.** `admin/conversation_review.py` is the private, read-only production-evidence path for Improve Thingy. `list` / `show <conversation-id>` review native conversations; `mcp-list` / `mcp-show <request-id>` review real MCP and `/tools` calls (each labelled with its stored `surface`) recorded with a 45-day TTL (14 days for rows written before 2026-09-29; the TTL is set at insert). `mcp-census --days N` aggregates the same rows per tool, client and surface: calls, owner/reader calls, distinct readers, tool errors, avg/p95/max ms, avg/max result chars, truncations, and argument keys per outcome, never values, hashes or emails. MCP lifecycle traffic is excluded, tool arguments and result evidence are bounded, and the reviewer explicitly marks the external client's prompt/final synthesis/feedback unavailable. It never signs in, sends email, creates traffic, invokes a model grader, or writes evaluator state. Raw output stays only in the active Codex run; durable findings are aggregate and anonymous.
- **Operator reads are private.** Static conversation reports remain available locally (`admin/operator_report.py`). The Studio `/thingy/` dashboard route retired with Studio on 2026-08-28. Any public dashboard still needs stronger owner/admin auth first.
