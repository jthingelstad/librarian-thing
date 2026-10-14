# Librarian native HTTP releases

Two Node 24 HTTP servers replace the auth and streaming HTTP entry points.
Thingy's static site, API contract, OAuth issuer, sessions, archive tools and
DynamoDB rows keep their existing contracts. The evaluator remains an Event
Function. The daily subscription digest has a separate Event Function on the
existing schedule.

The native archive loads gzip JSON incrementally, stores embeddings in
binary64 arrays, and shares pending corpus/index loads. `profile-memory.mjs`
replays downloaded public artifacts with SDK fakes and eight parallel requests;
no model calls or reader records are involved. Before increasing concurrency,
measure peak RSS and latency with all corpora and indexes loaded. The initial
archive ceiling is one request per environment and five environments.

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

The existing Librarian distribution is manually managed. `front-door.mjs` owns
its release changes with ETag compare-and-swap and a private original-config
receipt. Its sole `native` command preserves the hostname and route inventory.
Legacy `auth`/`rollback` modes are refused. External requests forward no cookies or X-Thingy-Origin, and
`/tools` remains outside this door. The authorization query function normalizes
form-encoded spaces while preserving literal pluses and repeated values.

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

Native error, capacity and rate alarms feed the existing ops topic. Application
filters also follow native log groups; evaluator/DLQ and digest alarms remain.
Web Function control-plane Active state does not establish HTTP readiness.
