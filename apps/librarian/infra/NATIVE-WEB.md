# Librarian native HTTP releases

Two Node 24 HTTP servers replace the auth and streaming HTTP entry points.
Thingy's static site, API contract, OAuth issuer, sessions, archive tools and
DynamoDB rows keep their existing contracts. The evaluator remains an Event
Function. The daily subscription digest has a separate Event Function on the
existing schedule.

The native archive loads gzip JSON incrementally, stores embeddings in
binary64 arrays, and shares pending corpus/index loads. The archive ceiling is
four requests per environment and five environments.

`profile-memory.mjs <directory> [parallel=8]` replays downloaded public artifacts
with SDK fakes; every client that could write, spend or reach the network
refuses, so no model calls or reader records are involved. Before increasing
concurrency again, rerun it with all corpora, links, the keyword index and the
tool indexes loaded, inside a 2 GB, two-CPU Linux arm64 container, and read the
archive path again for per-request state outside the request.

Measured 2026-11-04 on live artifact versions (`node:24-slim`, Apple M4), at 1 / 4 / 8
parallel. The pass rule, set before measuring: peak RSS at 4 at most 1,500 MB
(75% of the 2 GB environment), retrieval p95 at 4 not both over twice p95 at 1
and more than 250 ms above it, longest event-loop stall under 1,000 ms.

| Measure | 1 | 4 | 8 |
| --- | --- | --- | --- |
| Peak RSS | 1,117 MB | 1,125 MB | 1,097 MB |
| Retrieval p95, 30 questions | 280 to 293 ms | 344 to 372 ms | 509 ms |
| Warm tools p95, 20 calls | 569 to 620 ms | 786 to 787 ms | 876 ms |
| Longest stall, warm tools | 440 ms | 475 ms | 432 ms |
| Longest stall, first tool-index build | 581 to 741 ms | 764 to 789 ms | 718 ms |

Answers matched between alone and in flight (`archive_gems` is random by design
and is not compared). Lambda runs slower than this Mac, 1.1 to 3 times on the
same steps, so the first tool-index build in an environment may stall its other
requests for more than a second. The profile does not cover chat model streams
or `view_photo`.

## Source and promotion

For templates exceeding the inline API limit, the deployer uploads them under `code/templates/<content-sha256>.yaml` in the existing private
artifact bucket and supplies its S3 URL; the execution role's existing artifact
read grant covers it. Small templates still use the inline path.

`NativeSourceBucket` retains versioned immutable code. It has no expiration
rules. Never delete referenced code versions or remove Lambda's source read
access. `native_release.py` records exact source VersionIds. A corpus change
also changes the configuration build ID so new environments load that generation.

`NativeWebEnabled=false` bootstraps the source bucket, edge policies and logs.
Once bootstrapped, `aws.py --native --native-prepare-only --skip-corpus-upload`
creates private candidates while retaining the current live/rollback targets.
The Node owner installs only the two live endpoint policies, scoped to the two
existing CloudFront distributions. Candidate endpoints permit IAM-authorized
health reads, have no CloudFront grant, and remain private.

Routine deployments detect enabled native compute, snapshot live and rollback
revision IDs before replacing artifacts, publish candidates, probe candidate
HTTP health, then explicitly promote through CloudFormation. Auto deployment is
disabled. Rollback endpoints have zero rate and protect the previous live
revision from automatic cleanup. CloudFormation owns weights; the policy writer
never changes them. GitHub's production concurrency group serializes releases;
local exceptional releases must first establish that no production run is active.

The one-time native CloudFormation grants are a separate scoped managed policy:
the existing two inline policies together would exceed IAM's role policy limit
if the native grants were added inline. The reviewed OIDC policy gains source
upload, endpoint-policy ownership and candidate health invocation only. No deploy
reads, writes or rotates application secrets; runtime Secrets Manager loading
is unchanged.

## Native-only routing and rollback

Thingy's stack owns its distribution. `NativeAuthDomain` and `NativeArchiveDomain`
are required on creation and preserved on updates. Both origins always use the
native live endpoints; there is no legacy routing selector. Keep its origin marker,
HttpOnly cookie and contract-header requirements. Native origins use regional
SigV4 OAC with `always-amz-auth`, explicit Authorization forwarding and no-store
responses. Trusted viewer addresses replace the final X-Forwarded-For proxy hop.

The Librarian distribution (librarian.thingelstad.com) is `LibrarianDistribution`
in this stack. It was made by hand in 2026-08 and kept by a release script,
`front-door.mjs`, until 2026-11-02, when it, its `/mcp` headers policy and its
access log were imported into the stack unchanged. Every piece is Retain:
deleting the stack or setting `NativeWebEnabled=false` leaves the hostname
serving. A route change is a template change and ships with the next deploy;
`tests/test_deployment_security.py` pins the rules here. `WebACLId` is
projects-sysadmin's shared `edge` web ACL (count mode), from the export
`edge-waf-WebAclArn`. The access log is CloudWatch Logs vended delivery to
`/librarian/web-access`, kept 24 months (731 days), with no client IP, query
string or path (`/share/{token}` carries a share token). External requests
forward no cookies or X-Thingy-Origin, and `/tools` remains outside this door.
The one exception is the `/authorize` behavior, first in the list:
`NativeAuthorizeRequestPolicy` forwards exactly `thingy_email`, the remembered
sign-in email, so the page can prefill it and the consent response's Set-Cookie
reaches the browser (CloudFront strips Set-Cookie where no cookie is forwarded).
It never forwards the web session cookie. The authorization query function
normalizes form-encoded spaces while preserving literal pluses and repeated
values. `/mcp` alone adds the `WWW-Authenticate` challenge naming the protected
resource metadata (`McpChallengeHeaders`), which the Lambda origin's own answer
does not keep; it never overrides a challenge the server sends.
The auth origin's behaviors (the default and `/authorize`) use
`NativeCompressedCachePolicy` with compression on; archive behaviors keep
`NativeExternalCachePolicy` with compression off so SSE is never buffered.
User-Agent is forwarded by both origin request policies and is in no cache
policy. Retired routes (`/curiosity-map`) have no behavior. Native responses are no-store unless a route sets its own
cache-control on a GET/HEAD with no Authorization, Cookie, Origin or query
string and no Set-Cookie (`responseCacheControl` in `lambda/web/server.mts`).
No alarm watches this distribution since 2026-11-03; its 5xxErrorRate is a
standard CloudFront metric and its access logs are in CloudWatch Logs.

For a rollback, preserve current artifact parameters and set live revision IDs
to the protected previous native IDs through CloudFormation, then read both
public surfaces back. API Gateway, the legacy HTTP Event Functions and raw
Function URL were retired on 2026-10-13 at Jamie's direction. The evaluator and
digest remain Event Functions; WT Builder uses the stable Librarian hostname.

## Acceptance

Run `AGENT-TEAM/scripts/verify.sh`, both CloudFormation schema checks, Thingy's
web/infra gates and browser smoke. Cover actual HTTP handling, request isolation,
secure cookies, raw OAuth queries, refusal headers, SSE backpressure/cancellation,
CORS, corpus single-flight failure/retry, and exact retrieval behavior. Run live
retrieval goldens and read-only OAuth/MCP probes after deployment. Never sign in,
send email, modify conversations or create reader records as production QA.

This stack has one CloudWatch alarm since 2026-11-03:
`weekly-thing-librarian-sign-in-failures` (`LibrarianSignInFailuresAlarm`),
web-auth's live-endpoint `HTTPResponseStatusClass5XX`, at least one in two of
twelve five-minute windows, missing data not breaching. Every sign-in step
that fails on our side, on `/auth` or the MCP connector's `/authorize` pages,
answers a 5xx (Buttondown lookup on request or redeem, the sign-in email, the
runtime secret, anything unhandled; `/authorize` renders its usual page with a
502); correct refusals never do. Application metric filters follow the native log groups; archive 5xx,
capacity and rate are standard Lambda Web metrics with no alarm.
Web Function control-plane Active state does not establish HTTP readiness.
