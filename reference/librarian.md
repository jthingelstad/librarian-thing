# Archive Librarian

Thingy is an authenticated chat interface for Jamie Thingelstad's public archive: The Weekly Thing, thingelstad.com, and Another Thing. The code name in this repo is "Librarian"; the reader-facing product is Thingy.

## Local Artifacts

- `make librarian-corpus` builds `data/librarian/corpus.json` from the canonical archive in `data/issues/`.
- The local corpus is text-only and citation-ready. It includes issue summaries, topic metadata, and chunk-level retrieval metadata. It is gitignored and rebuilt on demand.
- Embedded corpus files should not be committed. `make librarian-corpus-upload` generates Bedrock Cohere embeddings and pushes the deployable corpus to S3. **Incremental by default**: it fetches the existing S3 corpus once at the start, copies cached embeddings onto unchanged chunks (matched by content-deterministic chunk_id), and only sends the leftover chunks to Bedrock. Pass `--full` (`uv run --locked python pipeline/deploy/upload_corpus.py --full`) to skip the cache and re-embed everything — needed only after a chunking-schema change or to repair a corrupted cache. The cache is automatically invalidated if the deployed corpus's `embedding_model` or `embedding_dimensions` no longer match the current request, with a warning.
- `make librarian-graph` builds `data/librarian/graph.json`, the offline entity/trope/similarity artifact used by the archive tools.
- `pipeline/deploy/bedrock_logging.py` inspects or enables account-level Bedrock invocation logging to the private Librarian bucket.

The previous Python eval pipeline under `pipeline/eval/` was removed. Conversation quality review now happens through the event-driven Eval Lambda described below.

## AWS Runtime

The backend is defined in `apps/librarian/infra/cloudformation.yaml`. Auth and auth health checks run behind API Gateway/Lambda. Streaming chat and stream health checks run through a Lambda Function URL with response streaming enabled. It uses:

- Buttondown API for subscriber lookup.
- Amazon Bedrock Claude Sonnet 4.6 for premium messages and the agent loop.
- Amazon Bedrock Cohere Embed v3 for query-to-archive retrieval.
- Amazon Bedrock Cohere Rerank 3.5 after archive searches.
- DynamoDB for magic-link tokens, sessions, rate limits, canonical conversations, turns, artifacts, feedback, eval metadata, and per-user memory.
- S3 for embedded Weekly Thing, blog, and podcast corpora plus the offline graph artifact.
- CloudWatch Logs for structured JSON request, retrieval, upstream, and error logs.

Chat streams from `site.librarianStreamUrl + /chat`; there is no buffered API Gateway chat fallback. Welcome messages are generated agentically by `/welcome`, using authenticated profile, local-time context, previous conversations, and active entitlements. Conversations are server-side and canonical; the browser no longer sends the full history as the source of truth.

The auth Lambda also serves an OAuth 2.1 authorization server for the live
MCP server (`/mcp` on the stream Lambda). Endpoints: `/.well-known/oauth-authorization-server`,
`/.well-known/oauth-protected-resource`, `/register`, `/authorize` (HTML
email/code/consent flow reusing the Thingy sign-in code email), and `/token`
(authorization_code + PKCE S256 and rotating refresh tokens with family
revocation on reuse). OAuth records share the DynamoDB table with sha256-hashed
secrets and ttl. Issuer defaults to `https://librarian.thingelstad.com`; set
`LIBRARIAN_OAUTH_ISSUER` to override. The auth Lambda also serves the domain
identity: `GET /` is a small Librarian page and `/favicon.ico` /
`/apple-touch-icon.png` redirect to Thingy's image (MCP clients fetch these
for the connector icon). The authorize pages prefill the verified email from
a first-party `thingy_email` cookie (CloudFront forwards only that cookie).

The FAQ content lives in `apps/librarian/lambda/shared/faq.json`. The streaming Lambda packages that file so Thingy can answer site, subscription, membership, RSS, privacy, and logistics questions through the `search_faq` tool. (The Eleventy `/faq/` page retired with the Studio site; the Lambda is now the file's only consumer.)

## Commands

```sh
make librarian-corpus
make librarian-graph
make librarian-corpus-upload
make librarian-corpora-upload
make librarian-deploy
uv run --locked python pipeline/deploy/bedrock_logging.py
```

After deployment, the deploy script writes the CloudFormation `LibrarianApiUrl` and `LibrarianStreamUrl` outputs to `.env` as `LIBRARIAN_API_URL` and `LIBRARIAN_STREAM_URL`. Production traffic goes through `librarian.thingelstad.com` (CloudFront in front of both origins); the Thingy web app reads its API URLs from repo variables in its own CI.

## Required Secrets

CloudFormation parameters:

- `ButtondownApiKey`
- `SessionSecret`
- `CorpusBucket`

Local `.env` values used by upload/build scripts:

- `BUTTONDOWN_API_KEY`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN` (only if using temporary credentials)
- `TINYLYTICS_SITE_UID` or `TINYLYTICS_SITE_ID` for the static website embed, not the API.
- `WEEKLY_THING_ASSETS_BUCKET` for public archive assets under `files.thingelstad.com/weekly-thing/`.
- `LIBRARIAN_BUCKET` for private Thingy code, corpus, and log artifacts. Defaults to `weekly-thing-librarian`.
- `LIBRARIAN_CORPUS_KEY` (optional; defaults to `artifacts/corpus.json`)
- `LIBRARIAN_GRAPH_KEY` (optional; defaults to `artifacts/graph.json`)
- `LIBRARIAN_BLOG_CORPUS_KEY` (optional; defaults to `artifacts/blog_corpus.json`)
- `LIBRARIAN_PODCAST_CORPUS_KEY` (optional; defaults to `artifacts/podcast_corpus.json`)
- `AWS_DEFAULT_REGION`
- `LIBRARIAN_API_URL` (written by deploy; the Thingy web repo reads its copy from its own CI variables)
- `LIBRARIAN_STREAM_URL` (written by deploy; same)
- `THINGY_DEFAULT_MODEL` (optional; defaults to `us.anthropic.claude-sonnet-4-6`, the US Bedrock inference profile for Claude Sonnet 4.6)
- `THINGY_FAST_MODEL` (optional; defaults to `us.anthropic.claude-haiku-4-5-20251001-v1:0`, used for small structured/background work)
- `THINGY_ADVANCED_MODEL` (CloudFormation sets `us.anthropic.claude-opus-4-6-v1` for high-synthesis work; code fallback remains Sonnet)
- `BEDROCK_EMBEDDING_MODEL` (optional; defaults to `cohere.embed-english-v3`)
- `BEDROCK_RERANK_MODEL` (optional; defaults to `cohere.rerank-v3-5:0`)
- `BEDROCK_RERANK_REGION` (optional; defaults to `us-west-2`, where the Bedrock Rerank API exposes Cohere Rerank 3.5)
- `LIBRARIAN_LOG_LEVEL` (optional; defaults to `INFO`)
- `LIBRARIAN_AUTH_RATE_LIMIT_MAX` (optional; defaults to 30 auth attempts per client identity per hour)
- `LIBRARIAN_RETRIEVE_SECRET` for trusted service-to-service retrieval.
- `FASTMAIL_JMAP_TOKEN` / `THINGY_FASTMAIL_JMAP_TOKEN` / `THINGY_JMAP_TOKEN` for magic-link email.
- `THINGY_MAGIC_LINK_FROM_EMAIL` and `THINGY_MAGIC_LINK_BASE_URL` for login email construction.
- `LIBRARIAN_USER_MEMORY_TTL_DAYS` (optional; defaults to 365 days.)
- `BRAVE_SEARCH_API_KEY` (optional; enables the `web_search` tool — the tool's schema binds in chat and MCP only when this is set)
- `CHAT_DAILY_QUOTA` / `MCP_DAILY_QUOTA` (optional; per-reader daily pools, defaults 50 / 500)
- `THINGY_GUEST_CHAT` / `GUEST_DAILY_QUOTA` / `GUEST_GLOBAL_DAILY_QUOTA` (guest chat lane, 2026-09: kill switch plus per-visitor 3/day and global 100/day fail-closed caps; the global cap is the cost circuit breaker with its own CloudWatch alarm)

Deploy and corpus upload scripts load AWS credentials from `.env` through `python-dotenv` before creating `boto3` clients. They do not intentionally fall back to AWS CLI profile authentication.

## Permanent IAM Setup

Routine deploys run in GitHub Actions (`.github/workflows/deploy.yml`), which assumes the `WeeklyThingLibrarianDeployOidc` OIDC role. Local manual deploys use the AWS credentials loaded from `.env`: the `wt-archive` IAM user with an attached `WeeklyThingLibrarianDeploy` managed policy (these static keys stay so local deploys never require an interactive login). That policy grants enough access to create or harden the private `weekly-thing-librarian` bucket, upload `s3://weekly-thing-librarian/code/*` and `s3://weekly-thing-librarian/artifacts/*`, and update the `weekly-thing-librarian` CloudFormation stack.

`files.thingelstad.com` is the public website asset bucket. Thingy code packages, corpus files, and Bedrock invocation logs belong in the private `LIBRARIAN_BUCKET`.

The long-term cleanup is still a dedicated CloudFormation service role.

The stack already creates a Lambda execution role for Thingy. The remaining production cleanup is a dedicated deployment path:

- Create a `weekly-thing-librarian-cloudformation` service role trusted by CloudFormation.
- Give that service role permissions only for the Librarian stack resources: Lambda, API Gateway HTTP API, DynamoDB table, the Lambda execution role, CloudWatch log groups, CloudWatch alarms/dashboard, and `s3://$LIBRARIAN_BUCKET/*`.
- (Done) The narrow deploy identity exists: the `WeeklyThingLibrarianDeployOidc` GitHub Actions OIDC role uploads private Librarian S3 artifacts and updates only the `weekly-thing-librarian` CloudFormation stack.
- Set `LIBRARIAN_CLOUDFORMATION_ROLE_ARN` to the service role ARN before running `make librarian-deploy`.

The deploy script passes `LIBRARIAN_CLOUDFORMATION_ROLE_ARN` to CloudFormation when present, so the caller only needs permission to upload artifacts, update the stack, and pass that one service role.

## Access Model

Thingy uses mandatory email magic-link authentication. A visitor enters an email address, Lambda checks Buttondown for an active subscriber, stores a one-time token hash in DynamoDB, and sends a sign-in link from `thingy@thingelstad.com` through Fastmail JMAP. Redeeming that link proves inbox possession and returns an HMAC-signed session token. Tokens last nine days and slide: the web app re-mints on every visit via `/auth` `action=refresh_session`, which also re-verifies Buttondown entitlements when they near staleness — a lapsed subscription gets 401 and must sign in again. Once a token expires, the only public email auth path is a new sign-in code.

Premium subscribers get a small Bedrock-generated Supporting Member thank-you before entering chat, with a fixed fallback if Bedrock is unavailable. Unknown email addresses can opt in from the sign-in page; those signups are created in Buttondown and must confirm before using Thingy. The logout control clears the browser's stored session token and returns to the sign-in page.

### Conversation modes (retired 2026-09)

Modes were retired as a user-facing feature: the web mode picker was removed
in the 2026-08 chat streamline and Jamie confirmed the retirement on
2026-09-01. Every new conversation is `thingy`. The entitlement gating in
`conversation-modes.mts` (reader / supporting_member / owner /
trusted_circle) remains as vestigial enforcement so old conversations keep
their stored mode; entitlements themselves stay live for quota doubling and
owner checks. Do not add modes or new mode UI without an explicit product
decision.

### Per-user memory

Auth returns a `profile` field populated from a per-user memory row in the existing DynamoDB table (key `user#{sub}` / `memory`). The chat handler updates this row at the end of each turn and Bedrock-summarizes previous conversations, rolling them into a compact per-user history.

The `profile` shape is:

```json
{
  "returning": true,
  "first_seen_at": "...",
  "last_seen_at": "...",
  "turn_count": 7,
  "entitlements": ["reader", "supporting_member"],
  "modes": [{"id": "thingy", "label": "Thingy"}],
  "current_session_questions": [{"ts": "...", "question": "..."}],
  "prior_session_summaries": [{"summary": "...", "started_at": "...", "ended_at": "...", "turn_count": 3}]
}
```

The chat handler also injects a compact memory-context block as a second (uncached) system message, so Thingy can naturally reference what a returning reader has been exploring in past sessions. The static system prompt stays cached.

Memory rows carry a one-year TTL (`LIBRARIAN_USER_MEMORY_TTL_DAYS`, default 365); the row is rewritten on every turn so active users effectively never expire.

## Link Parameters

`thingy.thingelstad.com/chat/` accepts optional query parameters for subscriber-friendly deep links:

- `email`: pre-fills the subscriber email field. The visitor still has to submit the gate, and the backend still validates the address against Buttondown.
- `prompt`: queues a first question. Once the visitor has a valid session, Thingy submits that question automatically and suppresses the generated welcome so the prompt is the first conversation event.

Both parameters are independent. `/thingy/?prompt=What%20has%20Jamie%20written%20about%20RSS%3F` lets the visitor enter their own email, then auto-starts the prompt after validation. `/thingy/?email=reader%40example.com` only pre-fills the email. `/thingy/?email=reader%40example.com&prompt=What%20has%20Jamie%20written%20about%20RSS%3F` does both.

## Logging And Review

Lambda writes structured JSON logs to CloudWatch. Logs include request ID, route, status code, duration, subscriber email hash, retrieval mode, citation count, upstream status/duration, and error type. Raw email addresses, API keys, and session tokens are not logged. The backend does not call Tinylytics; server-side activity should come from CloudWatch logs, metrics, and DynamoDB conversation review.

Every API response includes an `x-request-id` header. Browser-visible errors include that reference so the matching CloudWatch request can be found quickly.

Successful conversations are stored as canonical server-side rows in DynamoDB:

- `conversation#<id>` metadata rows with title, preview, source scope, mode, timestamps, eval fields, and latest request ID
- `turn#<conversation>#<timestamp>#<request>` rows with prompt, answer, citations, source scope, tool trace, feedback reaction/comment, runtime metadata, and artifacts. The tool trace (schema v2, `shared/tool-evidence.mts`) records per call a bounded structured evidence summary - stable source ids, issue/kind/title/url/date/section, rank and score, short excerpts, counts, and explicit truncation metadata - degrading per call under the 48KB storage bound instead of omitting the whole trace; the bound is absolute (under pathological input whole calls drop from the end with a `calls_dropped` marker). Preflight-direct and deadline-fallback turns carry the same stamps, and preflight-direct turns record the preflight call's real token usage. Turns also carry cumulative Bedrock usage across the whole agent loop (`input_tokens`/`output_tokens`/`total_tokens`/cache read+write/`bedrock_calls`), plus `trace_schema_version`, a deterministic `prompt_fingerprint` of the packaged prompts, and `source_revision` from the deployed code key (`LIBRARIAN_SOURCE_REVISION`). Rows written before schema v2 have only final-call `output_tokens` and lossy per-call summaries; `admin/conversation_review.py show` exposes both generations.
- `memory` rows with per-user continuity data

The Eval Lambda is triggered by DynamoDB Streams. It reviews updated conversations out of band, writes `eval_*` fields back to the conversation row, and updates generated titles when appropriate. The local operator report (`apps/librarian/admin/operator_report.py`) reads these same canonical rows and generates a static HTML report on Jamie's Desktop.

The reader UI lets users upvote/downvote responses and optionally explain downvotes. Feedback is stored on the matching turn and appears in operator review.

`GET /health` is available as a cheap smoke-test endpoint. It verifies API Gateway and Lambda routing without calling Buttondown, Bedrock, DynamoDB, or S3.

`POST /feedback` is served by the streaming Lambda Function URL and requires a valid session token. It accepts `request_id`, `reaction` (`up` or `down`), and optional `comment`, then updates the matching turn when it belongs to the same subscriber hash.

Thingy uses hybrid retrieval. Every query runs two engines over the scoped corpora — TF-IDF lexical scoring and cosine similarity over the pre-embedded chunks — with year/section filters applied inside each engine's scan, not as a post-filter. The two ranked lists are merged by reciprocal-rank fusion into a pool of up to 100 candidates, which is reranked once with Cohere Rerank 3.5 through the Bedrock Agent Runtime rerank API. Results carry age labels so answers can weigh recency; if the embedding call fails, fusion degrades gracefully to lexical-only.

Chat requests run through a tool-using Claude Sonnet 4.6 loop capped by `MAX_TOOL_TURNS` (default 8) against the `ARCHIVE_TOOLS` registry in `apps/librarian/lambda/shared/archive-tools.mts`. Published tools (schemas in `prompts/tool-specs.json`, display titles in `prompts/tool-titles.json`, same set over MCP):

- `search_archive`, `get_source`, `search_faq`, `quote_search`
- `archive_lens`, `entity_lens` (topic/entity history: `match_mode`, `case_sensitive`, `operation`, `year_range`)
- `list_content`, `find_links`, `latest_content`, `corpus_stats`
- `source_neighborhood`, `archive_gems`, `claim_check`
- `media_search` (photo index), `currently_history` (Currently entries), `top_references` (domain aggregation)
- `fetch_page` (live public pages, SSRF-guarded) and `web_search` (Brave; binds only when `BRAVE_SEARCH_API_KEY` is set)

Registry-internal, no published spec: `get_issue`, `get_section`, `domain_history`, `list_issues`, `compare_eras`.

All lexical filtering runs through the canonical matcher (`shared/matcher.mts`); semantics, the alias table, and per-tool coverage are specified in `apps/librarian/MATCHER.md`. Match reasons and evidence attribute the exact span found; `first`/`latest` come only from strict (exact/phrase) hits.

Thingy uses magic-link auth, rate limits, server-side history, and DynamoDB logging. Tool status is emitted over the streaming Function URL as `status` events, and the UI keeps the archive work visible/collapsible after completion.

The graph artifact is built offline from the corpus and archive front matter. It stores per-issue entities, recurring tropes/stances, and top-K similar issues from issue-level embedding averages. `pipeline/graph/build.py --use-bedrock-extraction` can use Sonnet for entity/trope extraction; the default heuristic mode is available for cheap local refreshes.

Typical cost is controlled by prompt caching on the stable system prompt and tool definitions, reranking only the top search candidates, limiting tool turns, and clipping tool result text. The target remains under $0.20 for typical questions and under $0.50 for worst-case multi-hop questions.

Thingy answers cite Weekly Thing issue numbers inline when using newsletter sources, and cite blog/podcast sources by title/permalink because they do not have issue numbers. The API returns citation metadata and the web client renders rich markdown, tables, horizontal rules, citations, inline photo thumbnails, copy/share/email actions, and tool-work traces.

Follow-up questions use server-side conversation history. The browser sends the active `conversation_id`; the stream Lambda loads the relevant turns, compacts them when needed, and injects recent context into the model.

## Tinylytics Events

The site loads Tinylytics with `events` and `beacon` enabled. Thingy emits these events:

- `librarian.auth_submit`
- `librarian.auth_success`
- `librarian.auth_error` with value `client` or `server`
- `librarian.auth_not_found`
- `librarian.auth_unconfirmed`
- `librarian.auth_subscribe_success`
- `librarian.auth_reminder_success`
- `librarian.auth_inactive`
- `librarian.logout`
- `librarian.session_resume`
- `librarian.question_submit`
- `librarian.answer_success` with value `{question-size}.{citation-count}`
- `librarian.answer_error` with value `client` or `server`
- `librarian.feedback_submit` with value `up` or `down`
- `librarian.feedback_error` with value `client` or `server`
- `librarian.source_click` with the cited issue number
- voice input and conversation events may also be emitted by the web client; keep this list aligned with the Thingy web repo when changing the UI. (Mode picker, source picker, and curiosity map events retired 2026-08-29 with the chat streamline.)

Tinylytics is only used by the website/browser. The Librarian API does not emit server-side Tinylytics events.

## Deployment Checklist

For a normal code-only Thingy deployment:

```sh
make librarian-deploy ARGS="--skip-corpus-upload"
```

For a full corpus refresh and deploy:

```sh
make librarian-deploy
```

`make librarian-deploy` (`uv run --locked python pipeline/deploy/aws.py`) packages both Lambdas, uploads their zip files, builds/uploads all three embedded corpus artifacts, builds/uploads the Weekly Thing graph artifact, and updates the CloudFormation stack. Use `make librarian-corpora-upload` by itself only when the deployed code is unchanged and only API corpus artifacts need to be refreshed.

New external publishing content has its own ingest step before corpus upload:

- Blog posts: `.github/workflows/sync-external-content.yml` runs `pipeline/blog/ingest_blog.py --since-last` against Micro.blog and commits changes to `data/blog/**`.
- Podcast episodes: the same workflow checks out `another.thingelstad.com`, runs `pipeline/podcast/import_another_thing.py`, and commits changes to `data/podcast/**`.

Those commits trigger the production workflow, which rebuilds and uploads the updated corpus artifacts. A newly published blog post will not reach Thingy unless this sync workflow runs successfully with `MICROBLOG_API_KEY` configured.

The deploy script packages both Lambda entrypoints from one Node source tree:

- `apps/librarian/lambda/auth/`: API Gateway Lambda for Buttondown auth and auth health checks.
- `apps/librarian/lambda/chat/`: Lambda Function URL for streaming chat and stream health checks.
- `apps/librarian/lambda/eval/`: DynamoDB Stream evaluator packaged with the auth bundle.
- `apps/librarian/lambda/shared/` and `apps/librarian/lambda/prompts/`: shared code and editable prompt files included in both packages.

After deploy:

```sh
curl -sS -i https://k0yklt9vg3.execute-api.us-east-1.amazonaws.com/health
curl -sS -i -X OPTIONS https://jcvud66qqpq53frvno5stoqntm0zqntw.lambda-url.us-east-1.on.aws/
```

The Thingy web app deploys from its own repo (`thingy.thingelstad.com`, GitHub Pages) after frontend changes; nothing in this repo deploys it.


The `/mcp` endpoint serves MCP streamable HTTP (stateless, protocol 2025-06-18/2025-03-26) from the stream Lambda. It binds every published tool above (18; `web_search` only when configured) with human display titles; auth is a Librarian OAuth bearer token with the `archive:read` scope; each tools/call spends one unit of the per-user daily mcp quota (`MCP_DAILY_QUOTA`, default 500, doubled for supporting members), independent of the chat pool (`CHAT_DAILY_QUOTA`, default 50). Every MCP tool response and `corpus_stats` carry `server_version` (`1.1.0+tools.<prompt fingerprint>`), the cache key clients use to detect a stale tools/list; `initialize` declares `tools.listChanged: true`.

The `/tools` endpoint (2026-09) is the WebMCP page-tool door on the same stream Lambda: house-style JSON actions (`list`, `call`) over `WEB_TOOLS` (the MCP set minus the outbound-network tools), authenticated like the other web surfaces (`resolveSessionToken`: HttpOnly session cookie via the thingy distribution, or Bearer), with its own daily pool (`WEB_TOOLS_DAILY_QUOTA`, default 200) and a 120/hr rate limit. It shares the audited invoker and result serializer with `/mcp` (audit rows carry `surface: 'web'`), and is deliberately unreachable via librarian.thingelstad.com - the web app calls it same-origin as `/api/tools`.

Deploys are gated by a three-layer eval (`lambda/tests/matcher.test.mjs`, `lambda/scripts/eval-tools.mjs` invariants and known answers against the real corpora, and the committed recall baseline `lambda/eval/baseline.json`); a failing check blocks the deploy. Accept a reviewed recall change with `node scripts/eval-tools.mjs --update-baseline`.
