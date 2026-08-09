# Librarian Backend Tasks

Concrete follow-ups for the Librarian API backend — Lambda, auth, entitlements, corpus
pipeline, and the eval loop. The Thingy *product* roadmap and web-surface tasks live in
`thingy.thingelstad.com/docs/ROADMAP.md` and `docs/TASKS.md`; this file is the Studio-side
(backend) half of that partition.

## Entitlements And Auth

- [ ] Audit Jamie's owner entitlement path periodically. Owner mode currently comes from `jamie@thingelstad.com` / owner hash or `thingy-owner`.
- [ ] Add a short operator note listing the active mode tags in Buttondown so future Jamie knows which tags grant which Thingy capabilities.
- [ ] Confirm Fastmail/JMAP token rotation procedure for `thingy@thingelstad.com`.
- [ ] Add monitoring for magic-link send failures and expired/invalid redemption spikes.
- [ ] Consider a dedicated owner/admin auth path before exposing any non-local operator dashboard.
- [ ] Finish the dedicated CloudFormation service-role cleanup described in `reference/librarian.md`.

## Operator Review

- [ ] Add more client-side filters to the operator report if review volume grows: mode, source scope, eval flag, feedback reaction, runtime timeout, and Jamie-vs-reader.
- [x] Add an explicit report section for mode usage and mode-specific eval flags.
- [x] Convert repeated evaluator flags and reader feedback into a lightweight improvement queue.

## Corpus And Pipeline

- [x] Add a corpus freshness/status view that compares source-mirror changes and deployed corpus uploads for Weekly Thing, blog, and podcast.
- [ ] Confirm that the external-content sync workflow runs after new blog posts and podcast episodes and that failures are visible.
- [ ] Add a deploy summary that says whether corpus upload was skipped or refreshed and why.
- [ ] Revisit whether old pre-server-side conversation records can be deleted from DynamoDB now that canonical conversation rows are the only supported structure.

## Agentic Interface (WebMCP) — Proposal, Not Approved

Thingy proposes exposing the archive as callable tools to AI agents in the reader's browser via
WebMCP. The full design lives in `thingy.thingelstad.com/docs/WEBMCP.md`. Phase 1 is web-only and
needs nothing here. Phase 2 is the Studio half and would change the Librarian contract, so it needs
Jamie's sign-off before any work starts.

- [ ] Decide whether to expose archive tools over HTTP at all. Today `ARCHIVE_TOOLS` is only reachable inside the Bedrock agent loop; `/retrieve` is operator-only and bridge-secret gated, so it is not a substitute.
- [ ] If yes: add `POST /tools` (list specs) and `POST /tools/call` (run one tool) to the Stream Lambda, authenticated with the normal reader session token — no new credential.
- [ ] Define a `PUBLIC_ARCHIVE_TOOLS` allowlist rather than exposing all of `ARCHIVE_TOOLS`. Dispatch planner tools stay out.
- [ ] Validate arguments and apply `normalizeScope()` at the route boundary so corpus boundaries hold for external callers.
- [ ] Give tool calls their own rate limit — cheaper than `/chat`, so a higher ceiling, but still bounded.
- [ ] Add the routes to `librarian-contract.mts` as an additive v1 change and regenerate `contracts/librarian-api.v1.json`.
- [ ] Add an optional `client_surface` field on conversation/eval records so the operator report can tell a WebMCP turn from a web-UI turn.
- [ ] Separately decide whether a remote MCP server (non-browser clients) is ever wanted. That needs OAuth or personal access tokens and is a different product decision; WebMCP deliberately defers it.

## Quality And Tests

- [ ] Add end-to-end Lambda handler tests or a repeatable live QA harness for modes, auth, conversations, and evaluator flow.
- [ ] Add golden-answer regression cases for citation-footer consistency and retrospective-vs-contemporaneous timeline evidence. The evaluator criteria now have deterministic guards; response-level cases still need a repeatable model harness.
- [ ] Add timeout-path tests so evaluator reports runtime exhaustion as runtime exhaustion, not answer-quality failure.
