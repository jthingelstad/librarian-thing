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
revocation on reuse). A connection (refresh family) slides: it lasts while the
client refreshes within 30 days, with no absolute cap, and every nine days a
refresh re-checks the membership with Buttondown using the email stored on the
family row (lapsed revokes; a Buttondown error keeps going; the owner is
exempt). Families from before 2026-10-01 have no email and keep the 90-day cap.
`/token` takes `client_id` in the body or as HTTP Basic with an empty secret,
and `offline_access` is accepted and ignored (AWS DevOps Agent 3LO). OAuth
records share the DynamoDB table with sha256-hashed secrets and ttl. Issuer defaults to `https://librarian.thingelstad.com`; set
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

During a direct local deployment, the deploy script writes the CloudFormation `LibrarianApiUrl` and `LibrarianStreamUrl` outputs to `.env` as `LIBRARIAN_API_URL` and `LIBRARIAN_STREAM_URL`. Production traffic goes through `librarian.thingelstad.com` (CloudFront in front of both origins); the Thingy web app reads its API URLs from repo variables in its own CI.

## Required Secrets

CloudFormation parameters:

- `ButtondownApiKey`
- `SessionSecret`
- `CorpusBucket`

The credential parameters (`ButtondownApiKey`, `SessionSecret`,
`ThingyWebOriginToken`, `LibrarianRetrieveSecret`, `FastmailJmapToken`,
`BraveSearchApiKey`) come from this repo's GitHub Actions secrets. The stack
writes them, with the golden-retrieval secret, into one JSON secret,
`weekly-thing-librarian-runtime`, and the Lambdas read it at cold start
(`shared/runtime-secrets.mts`); they are not in the function configuration.
The parameters may not contain `"` or `\`, which would break the JSON.

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
- `THINGY_PREMIUM_MODEL` (CloudFormation sets `us.anthropic.claude-opus-4-6-v1` for high-synthesis work; code fallback remains Sonnet)
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

## Deployment authentication

Production deploys run in GitHub Actions using the `WeeklyThingLibrarianDeployOidc`
role. They require no active local AWS CLI session. To deploy committed `main`:

```sh
gh workflow run deploy.yml --ref main -f scope=code
```

The OIDC role is limited to Librarian artifacts, model checks/embedding, log setup,
and the one stack. CloudFormation uses `weekly-thing-librarian-cloudformation`;
the deployment script passes its ARN explicitly. Separate administrator-managed
permissions boundaries prevent the application roles from gaining wider access.
Routine deploys inspect bucket security; `--bootstrap-bucket` is administrator-only.

See [deployment IAM](../pipeline/deploy/iam/README.md) for source policies,
validation, rollback, and the remaining legacy-consumer retirement work.

Direct local tooling still loads application settings from `.env`. Legacy
`wt-archive` credentials are transitional for existing local consumers, not a
requirement for GitHub deployment. Do not retire the IAM keys until those
consumers have replacement authentication and successful acceptance.

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
- `archive_lens` (the history of a topic, person, product or idea: `aliases`, `match_mode`, `case_sensitive`, `operation`, `year_range`)
- `list_content`, `find_links`, `latest_content`, `corpus_stats`
- `list_topics` (the topic clusters and the site's topic pages, with counts and URLs), `compare_eras` (one topic across two year ranges)
- `source_neighborhood`, `archive_gems`, `find_evidence` (the passages bearing on one to four claims; no verdict)
- `media_search` (photo index), `currently_history` (Currently entries), `top_references` (domain aggregation)
- `on_this_day` (what was published on this calendar day in past years, all three corpora; America/Chicago "today")
- `fetch_page` (live public pages, SSRF-guarded) and `web_search` (Brave; binds only when `BRAVE_SEARCH_API_KEY` is set)

Registry-internal, no published spec: `get_issue`, `get_section`, `domain_history`, `list_issues`.

All lexical filtering runs through the canonical matcher (`shared/matcher.mts`); semantics, the alias table, and per-tool coverage are specified in `apps/librarian/MATCHER.md`. Match reasons and evidence attribute the exact span found; `first`/`latest` come only from strict (exact/phrase) hits. Since MCP 1.5.1:
- A `list_topics` cluster label matches only when it is named whole.
- A domain filter matches the domain or a subdomain.
- `list_content` reads every chunk.
- `find_links` sorts before it applies the limit (newest first, or `sort: 'oldest'`).
- `get_source` sends the body once, sized to fit the cap.

MCP 2.0.0 (breaking) made the surface consistent:
- `get_source` and `source_neighborhood` take `id` only (`wt-351`; `WT351`, `#351`, a bare number or the url also resolve), and `get_source` takes `format` (`outline`, `text`, `full`).
- `search_archive` groups its passages under their source: each result is one source (id, facts, skim) with its matching `passages`.
- `entity_lens` folded into `archive_lens` (`aliases`, reported with the known ones as `aliases_checked`); `claim_check` became `find_evidence` (`claims`, one to four; evidence with `voices`, no verdict). A client calling either old name gets an error naming the replacement.
- `year` is shorthand for `year_range: [year, year]` on every tool that takes `year_range`; passing both is refused. `year_range` replaced `year_start`/`year_end`.
- What a result leaves out is in one top-level `truncated` block (`omitted` counts by path, `clipped` paths, one `hint`; `max_chars` when the 48,000-character cap cut it) instead of inline `{omitted, note}` markers and `*_omitted`/`*_note` keys. Counts are `[{<key>, count}]` lists and totals are `total_count`.
- Every tool declares an `outputSchema`, and a successful call carries `structuredContent`; a result that cannot be cut to fit is a `too_large` error.

MCP 2.1.0 (2026-09-30, QA completeness pass; nothing is silently left out):
- Every enumerating tool takes `offset` and lists in a stated order; a cut list carries `truncated.next_offset`, and `total_count` is the whole match (`latest_content`, `quote_search`, `list_topics` gained it).
- One matcher everywhere: accents fold both ways (cafe finds café), curly and straight apostrophes, nbsp and `&amp;` fold; `media_search` and `currently_history` use it too (`media_search` takes `match_mode`, stem by default, so dog finds dogs); aliases apply both ways and in `list_content`. Short stems match plurals only.
- `media_search` works without a query (newest first), upgrades http archive images to https, and says why a photo is not viewable.
- Every source id opens in `get_source`; blog posts that share a permalink stay apart.
- Links: a malformed stored host is read from the url or left out; `top_references` counts every excluded link in the asked window (internal, commentary and Journal, utility with subdomains, malformed) and ties by domain; `target_resolved` covers internal links only; more tracking parameters are ignored in url lookups.
- `on_this_day`: year is the publish year under a window; Feb 29 is its own day in a leap target year; `applied.day_basis` says what files a day.
- `corpus_stats`: `counts_by_year` oldest first; `top_domains` and `also_in_issue_counts` follow `limit` and count the rest (`domain_count`, `issues_referenced_count`); the blog source counts posts reprinted in an issue and posts an issue only links (`posts_with_linked_from_issues_count`, `issues_linking_count`); `chunk_count` excludes undated FAQ and site-page chunks (`undated_chunk_count`).

MCP 2.2.0 (2026-10-01, Jamie's answers to the QA questions and the last QA findings):
- Chicago time everywhere: a source's day is its America/Chicago date (WT35 went out 01:28Z Jan 7, which is Jan 6). `on_this_day` includes the date's own year and orders a day's sources as the issue, then the episode, then blog posts.
- Weekly Thing links are editorial; blog and podcast links are not. `top_references` and `top_domains` rank Weekly Thing headline picks only (`excluded_blog_and_podcast_links`, `measure`, `top_domains_measure`); `source_kind: blog` ranks blog links and says they are not picks. jthingelstad.micro.blog is Jamie's own blog.
- The blog post is canonical over its Weekly Thing Journal copy. Search drops the copy when its post also matched, joined by url or by the post's microblog id (`journal_posts` from the corpus build), and a surviving copy names its post in `copy_of`. A Weekly Thing photo that reprints a blog photo folds into it (`also_in_issues`, `collapsed_copies`), and a copy whose post did not match stays and names it. A blog post's `also_in_issues` names the issues that reprint it (Journal copies from the issue's own week); `linked_from_issues` names the issues that only link it, so every issue naming a post is in exactly one list (`list_content` and `latest_content` filter on `has_also_in_issues`/`also_in_issue` and `has_linked_from_issues`/`linked_from_issue`).
- `get_source` reads anything whole: `offset` pages a long body (`truncated.next_offset`); `section` takes any `##`/`###` heading in the body, compares headings without markdown marks or no-break spaces, prefers an exact name, and is a `bad_request` with `available_sections` when nothing matches; section text and word counts are no longer cut at 14,000 characters. `librarian://wt/{n}` and `librarian://blog/{id}` read the whole body as text.
- `source_neighborhood` states `outgoing_count` and `incoming_count` and counts what its 30-link lists leave out; `find_links` takes `id` to page through every link in one source.
- `search_archive` and `find_evidence` show the stretch of a long passage where the query's words gather and mark it `clipped: {start, end, chars}`. An unknown `topic` or `category`, or a category with a non-blog `source_kind`, is a `bad_request` naming the valid values; a topic may be given by its slug.
- A `/` in a topic means or (`Twitter/X`); built-in aliases always stay beside the caller's. An exact section or family name wins over a substring. `voice` never counts image markup (alt text is mostly machine-written) and matches no FAQ or site page.
- `compare_eras` gives each era's `sources_published` and `sources_naming_topic`, with a note when an era is empty. `archive_gems` draws at random in every mode, weighted toward link-rich sources, and a theme path states its `total_count`. `media_search` drops `podcast` (no episode photos are indexed). `search_faq` says when nothing matches. Impossible calendar days are refused by resources and prompts.

Corpus build, 2026-10-01 (the QA pass's ingest fixes; every corpus upload now passes the eval first):
- Chunks are sized so every word fits inside its embedding, and each passage carries its own topic clusters. Blog chunks and photos are keyed by `microblog_id`, and blog chunks carry the post's `published` timestamp, which files a post's Chicago day.
- Each Journal entry is tied to the post it copies, by permalink and otherwise by date and text. Chunks carry `journal_posts: [{url, copy_of_microblog_id, canonical_url, matched_by}]`, paired in order with `journal_post_urls` and then the chunk's unlinked entries. Issues carry `journal_entries`, and the corpus reports `journal_copy_stats` and `journal_unmatched` (28 entries have no post left). A copy must come from the issue's week, from three days before the previous issue to the day after this one; a Journal link to a post outside it is a reference, listed in the issue's `journal_references` and counted in `journal_copy_stats.references` (324), and the blog corpus stores each post's `also_in_issues` and `linked_from_issues` with their pair counts in `appearance_stats`. The Lambda splits an older blog corpus the same way when it loads.
- A Weekly Thing photo that reprints a blog photo carries `copy_of_microblog_id` and `canonical_url`, matched by URL, by micro.blog upload name, or for WT Builder issues by recomputing its rehost name (`wt_builder_rehost_url`, a contract with wt-builder `images.ts`).
- Issue covers and blog video poster stills are media. A media `context` reads as prose. Links come from one scanner, and a doubled scheme no longer gives a link the domain `https`. Currently and Now Reading entries keep their whole text, and graph entities and topics read the whole issue.

MCP 2.5.0 (2026-10-01, contract 4.16.0; Jamie's answers to the round-2 QA questions, and the round-3 corpus fixes):
- Appearances: a blog post's `also_in_issues` names only the issues whose Journal reprinted it (a copy from the issue's own week, [previous issue - 3 days, this issue + 1 day]); the new `linked_from_issues` names the issues that link it without reprinting it (a Notable pick, a link in prose, a Journal reference to an older post). Every issue that named a post is in exactly one list: 4,158 pairs became 3,646 reprints and 512 links. `list_content` takes `has_linked_from_issues` and `linked_from_issue`; `corpus_stats` reports `posts_with_linked_from_issues_count` and `issues_linking_count`.
- Journal dedupe is judged per passage on the returned page: a Journal copy drops only beside the passages of its post that it repeats, so a copy of a long post's opening stays beside the post's other passages.
- `top_references`: a utility site is that host only (after `www.`, `m.`, `mobile.`), so subdomain picks such as aws.amazon.com, code.facebook.com, blog.poap.xyz and other people's micro.blog blogs count; Wikipedia's language editions stay utility, and app.poap.xyz and collectors.poap.xyz join the list.
- A blank or whitespace-only `id`, `url`, `domain`, `topic`, `section`, `section_family`, `category` or `theme` is a `bad_request`, never read as absent.
- `search_archive` says it is a ranked top-N with no paging and points to `quote_search` and `archive_lens` for complete lists; its description states the 40-character floor on `voice: "jamie"`.
- A slash term stays whole when a side is a number, a single letter or a stopword (`9/11`, `24/7`, `I/O`, `and/or`); `Twitter/X` and `micro.blog/Mastodon` still mean either.
- `media_search` matches a photo on either copy's description, and a year-filtered call says per-year totals overlap (a photo counts in its own year and the year an issue ran it).
- `on_this_day` runs a day's blog posts by Chicago time of day (an issue and an episode never share a day).
- `source_neighborhood` `related` means at least three shared distinctive terms (5+-letter title and opening words, or picked domains, used by fewer than max(2%, 20) sources in scope); site-members fell from 10,920 to 630, and `related_count` equals the ranked list.
- `list_topics` counts every issue that names a topic twice or more, uncapped (Tesla 14 to 25 issues), once the loaded graph says `entity_index_uncapped`; the public topic set is unchanged.

Corpus build, 2026-10-01 (third pass):
- A blog post has one date, the Chicago day it was published: `publish_date` and `post_year` follow it (121 posts moved, 11 across a year), `permalink_date` is kept when it differs, and the 8 Blot imports stamped 05:00Z read as Chicago noon.
- Journal copies come from the issue's week; a link to an older post is a `journal_references` entry. An entry's own permalink is matched when an earlier line links the same post, and entries in merged photo series match a sibling post. Unmatched entries 33 to 28; the gate ceiling follows.
- An issue is filed under every topic cluster one of its passages carries (108 missing filings).
- Blog text keeps fenced and inline code, tweets, video and iframe embeds and autolinks, and drops `<style>` CSS (blog links 18,516 to 18,741). The Thingy strip matches nested divs and fails the build on an unclosed frame.
- A link-family item's own link is its headline, not commentary (821 rows). One media row per image per source; 98 more Journal photos tie to their blog photo; the 4 blog videos with no poster still have a media record.
- The build counts embed inputs past Cohere's 512-token cap, and the corpus gate reports them as a warning (1,308 Weekly Thing and 637 blog chunks today); chunks are not yet sized by tokens.
- The corpus gate also fails a blog candidate filed off its Chicago day, a Journal copy from outside its week, and any regression of the ingest fixes above.

MCP 2.4.0 (2026-10-01): Jamie's micro.blog Pages join the blog source as `page-<uid>` (a number space of their own; page 71862 shares its number with a post). Pages are undated: `latest_content`, `on_this_day`, year filters and eras leave them out, `list_content` and `quote_search` list them after the dated sources, `updated` is the last edit, and `corpus_stats` reports `page_count`. `/family/` pages and pages about the website stay out; `data/blog/index.json` `pages_excluded` names each with its reason.

MCP 2.3.0 (2026-10-01, the second QA pass: Weekly Thing audio editions and the round-2 completeness findings; nothing regressed from 2.2.0):
- Audio editions: `list_content` and `latest_content` take `has_audio`; `corpus_stats` reports `audio_editions {count, total_seconds, first, last}`; a Weekly Thing passage in `search_archive` and `find_evidence` carries `audio {url, start, chapter}` for its section's chapter (`#t=` start), and `get_source` with `section` gives `section_audio`; `librarian://wt/{n}` adds a Listen line. Thingy offers the audio only when a reader asks to listen or asks about audio.
- Every source record carries `date`, its Chicago day; `publish_date` stays raw (an issue's UTC send time, a blog post's permalink day). `currently_history` shows the Chicago day, a bare date sorts as Chicago noon, and within a year `corpus_stats` oldest/newest follow the day the filter reads.
- Nothing is cut without a count: a capped `on_this_day` trims every year to one depth so `next_offset` pages them all; `archive_lens` pages operation `timeline` only (the other operations answer for every source and say so); `search_faq` states `total_count` and pages; `archive_lens` `years[].top_domains` count links by host with `domain_count` and omitted counts; `corpus_stats` oldest/newest domains follow `limit`; `source_neighborhood` counts `related_sources` and routes incoming links to `find_links` url; an offset past the end says where the last page starts.
- `get_source` `section` on a body heading reads its whole extent (an H2 group with every H3 under it), skips fenced code when finding headings, lists body headings in `available_sections`, and refuses `##` and `offset` with `outline`. `search_archive` `section` takes an H2 group heading (Notable Links, Stream, Now Reading) and a name that matches nothing is a `bad_request`; its `topic` filter takes issue-level cluster filing; passage windows fold accents and apostrophes.
- Journal dedupe: an entry is a copy only of a post from the issue's own week (Journal prose that links an older post is not a copy), and the dedupe runs on the returned page, refilled from below the cut.
- Matching: a phrase crosses an emoji's variation selector (keycap digits still do not spell numbers); a schemeless url (`github.com/jthingelstad`) stays one term and matches in link urls, while `micro.blog/Mastodon` still means either; `case_sensitive` holds for both sides of a slash term; `list_topics` and `currently_history` use the alias table and the slash rule; topics, aliases and queries are capped at 200 characters and a quote at 1,000, and an over-long input is a `bad_request`, never a crash. `archive_lens` `voice` keeps short posts (no 40-character floor; `search_archive` keeps its floor for ranking).
- Links: a url finds every percent-encoding of its path, and its `m.`/`mobile.`/`amp.`/`www2.` host, AMP-cache, `/amp` and tracking-parameter spellings, keyed exactly as WT Builder's linked-before check keys it (its `canonical-urls.json` fixture is copied into the Lambda tests; 53 of 36,523 links rekeyed, five URL groups merged); site pages count incoming links; an IDN domain is read as its punycode; a schemeless thingelstad.com url is an id; `find_links` `id` refuses a contradicting `source_kind` and echoes `sort: source_order`; neighbourhood links carry `id`.
- Media: plurals fold both ways (dogs finds dog); `match_mode: phrase` and a quoted query match the phrase; photo file-name words are searchable (`filename` match reason); a blog photo's `also_in_issues` names every issue that reprinted it; an unknown `issue_number` is `not_found`.
- `compare_eras` passes `voice` to its counts; `archive_gems` `theme` draws at random from every source that names the theme; `list_topics` says its counts come from each issue's top 40 extracted names and points a 0-match query to `list_content`; arguments the tool does not read go to `applied.ignored`; a backwards `year_range` is refused in-process too.

Corpus build, 2026-10-01 (second pass): Journal clock labels ("Saturday @ 7:16 PM") no longer run into the next line as graph entities, which had made "PM We" and 26 more clock phrases into topics with public pages.

Thingy uses magic-link auth, rate limits, server-side history, and DynamoDB logging. Tool status is emitted over the streaming Function URL as `status` events, and the UI keeps the archive work visible/collapsible after completion.

The graph artifact is built offline from the corpus and archive front matter. It stores per-issue entities, recurring tropes/stances, and top-K similar issues from issue-level embedding averages. `pipeline/graph/build.py --use-bedrock-extraction` can use Sonnet for entity/trope extraction; the default heuristic mode is available for cheap local refreshes.

Typical cost is controlled by prompt caching on the stable system prompt and tool definitions, reranking only the top search candidates, limiting tool turns, and clipping tool result text. The target remains under $0.20 for typical questions and under $0.50 for worst-case multi-hop questions.

Thingy answers cite Weekly Thing issue numbers inline when using newsletter sources, and cite blog/podcast sources by title/permalink because they do not have issue numbers. The API returns citation metadata and the web client renders rich markdown, tables, horizontal rules, citations, inline photo thumbnails, copy/share actions, and tool-work traces.

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
make librarian-deploy-full
```

`make librarian-deploy` queues a code-only GitHub OIDC deployment of committed remote `main`; `make librarian-deploy-full` also rebuilds and uploads all corpora. Neither needs a local AWS session. Both print a run URL: wait for its result before reporting acceptance. The workflow invokes `pipeline/deploy/aws.py` to package and upload Lambda code and update the stack.

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

The Thingy web app deploys from its own repo (`thingy.thingelstad.com`, S3 + CloudFront since 2026-09-01) after frontend changes; nothing in this repo deploys it.


The `/mcp` endpoint serves MCP streamable HTTP (stateless, protocol 2025-06-18/2025-03-26) from the stream Lambda. It is for Jamie and for readers; the reader-facing setup (claude.ai, ChatGPT, Claude Code, any MCP client) and fair-use limits are on `thingy.thingelstad.com/connect/` (thingy web `web/connect/index.html`), which should change whenever the tools, limits or sign-in do. It binds every published tool above (21; `web_search` only when configured) plus the MCP-only `view_photo` (up to 3 archive photos per call as image content blocks, allowlisted hosts) with human display titles; auth is a Librarian OAuth bearer token with the `archive:read` scope; each tools/call spends one unit of the per-user daily mcp quota (`MCP_DAILY_QUOTA`, default 500, doubled for supporting members), independent of the chat pool (`CHAT_DAILY_QUOTA`, default 50), under a 300/hr rate limit. Arguments are checked against the declared schema before any quota is spent: an unknown argument, a limit outside its declared range, a text over its `maxLength`, a bad enum, an inverted `year_range` or `year` with `year_range` is a `bad_request` naming the accepted arguments. A tool that cannot answer returns `isError: true` with a `code` (`bad_request`, `not_found`, `not_configured`, `upstream_error`, `too_large`, `internal_error`) and one `next` step. Results are compact JSON cut to 48,000 characters structurally (trailing list items first, added to the `truncated` block a tool already set), so they always parse, and go out as `structuredContent` too, conforming to each tool's `outputSchema`; every success leads with an `applied` echo of the window, limit and mode used. Source ids (`wt-351`, `blog-<microblog id>`, `page-<page id>`, `ep-<n>`) that any tool emits are accepted by `get_source` and `source_neighborhood` as `id`. Every MCP tool response and `corpus_stats` carry `server_version` (`2.5.0+tools.<prompt fingerprint>`), the cache key clients use to detect a stale tools/list; `initialize` declares `tools.listChanged: true`, `resources` and `prompts`. Every tool is annotated `readOnlyHint: true`, with `openWorldHint` true only on `fetch_page` and `web_search`, and every input schema says `additionalProperties: false`. Urls in results go out absolute (`/archive/351/` becomes `https://weekly.thingelstad.com/archive/351/`). Resources (1.6.0): `librarian://wt/{n}`, `librarian://blog/{id}` and `librarian://page/{id}` (2.4.0) are one source as markdown; `librarian://topic/{slug}` is a topic's catalogue card plus its lens timeline; `librarian://year/{yyyy}` is `corpus_stats` for that year; `librarian://on-this-day/{mm-dd}` is `on_this_day`. `resources/list` offers the 12 newest issues and costs nothing; each `resources/read` spends one quota unit and is audited as `resource:<kind>`; an unknown URI is `-32602`, a missing source `-32002`. Prompts: `thinking_over_time`, `year_in_review`, `reading_path`, `this_week_in_past_years`, `research_brief`.

The `/tools` endpoint (2026-09) is the WebMCP page-tool door on the same stream Lambda: house-style JSON actions (`list`, `call`) over `WEB_TOOLS` (the MCP set minus the outbound-network tools), authenticated like the other web surfaces (`resolveSessionToken`: HttpOnly session cookie via the thingy distribution, or Bearer), with its own daily pool (`WEB_TOOLS_DAILY_QUOTA`, default 200) and a 120/hr rate limit. It shares the audited invoker, argument validation and result serializer with `/mcp` (audit rows carry `surface: 'web'` and `server_version`; `/mcp` rows also carry the OAuth `client_id` and registered `client_name`; rows live 45 days), and is deliberately unreachable via librarian.thingelstad.com - the web app calls it same-origin as `/api/tools`.

Deploys are gated by a three-layer eval (`lambda/tests/matcher.test.mjs`, `lambda/scripts/eval-tools.mjs` invariants and known answers against the real corpora, and the committed recall baseline `lambda/eval/baseline.json`); a failing check blocks the deploy. Accept a reviewed recall change with `node scripts/eval-tools.mjs --update-baseline`. Corpus uploads pass the same eval first: CI embeds each rebuilt corpus into `.candidate/` (`upload_*.py --stage`), evals the candidates beside the live copies of the rest (`EVAL_CORPUS_DIR=.candidate EVAL_CORPUS_FALLBACK=s3`), and uploads with `--upload-staged` only if it passes.
