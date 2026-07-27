# Fall Publication Readiness

**Owner:** Otto  
**Editorial owner:** Jamie  
**Studio specialist:** Eddy  
**Status:** Active readiness program during the July–August 2026 summer break

This document is the control point for preparing Studio to publish the first
post-break issue of **The Weekly Thing**. It is a point-in-time product and
operational assessment, not a replacement for the canonical workflow in
`docs/publishing-process.md` or the runtime contract in
`apps/workshop_bot/CLAUDE.md`.

## Outcome

Starting with no active issue, Jamie can create the next issue, sync its
sources, author and curate it, review it with Eddy, package it, publish every
intended leg, recover from a failed leg, close it, and verify the public
outputs without remembering hidden commands or reconstructing workflow state.

The first post-break publication should exercise the same path rehearsed during
the break. Structural changes freeze before that live issue begins.

## Current Evidence

- The Studio runtime is live and tailnet-only.
- The current product already has issue planning, a live issue canvas, inline
  atom editing, Pinboard and micro.blog sync, Eddy review, packaging fields,
  readiness checks, per-leg publishing, and put-to-bed.
- `weekly.thingelstad.com` is correctly downstream: Studio produces canonical
  issue content and generated inputs; Weekly renders and deploys them.
- `feed.xml` and `podcast.xml` are the authoritative external confirmation of
  publication.
- The workshop test suite passes: 727 tests and 63 subtests as of 2026-07-26.
- WT349 was the last pre-break publication. The July–August gap is planned.
- The current web-first issue workspace landed after WT349 and therefore has
  not yet shipped a live issue end to end.

## Operating Boundaries

| Concern | System of record |
|---|---|
| In-flight issue state and authored atoms | Studio workshop DB |
| Link archive and link commentary | Pinboard |
| Journal posts and Featured classification | micro.blog |
| Frozen shipped issue | `data/issues/{N}/` in Studio |
| Email draft, schedule, and send | Buttondown |
| Audio assets | S3 plus `data/audio/manifest.json` |
| Public presentation | `weekly.thingelstad.com` |
| Publication confirmation | `feed.xml` and `podcast.xml` |
| Editorial discussion and exceptions | Discord `#weekly-thing` |

Eddy is an embedded editorial specialist. Otto owns roadmap, coordination,
verification, and readiness. Neither should create a second copy of live issue
state in Discord, Obsidian, or agent memory.

## Acceptance Scenario

The rehearsal issue must demonstrate all of the following.

### Plan

- With no active issue, Studio presents the computed next issue number and a
  reasonable post-break publication date.
- Jamie can adjust the number, date, and window before creating it.
- A break or non-seven-day issue can be represented without repairing the DB.
- The issue header shows publication target, content cutoff, phase, and the
  next meaningful action.

### Build

- Starting work creates exactly one active issue and performs the first source
  sync.
- Pinboard and micro.blog failures are independent and visible.
- The page shows last sync time and source-specific result.
- Jamie can write Intro, Currently, cover metadata, optional Outro, and other
  authored atoms in the issue canvas.
- Jamie can select, exclude, promote, demote, and reorder derived items.
- Source ownership and Studio overrides are visually unambiguous.
- The resting view is the rendered issue in reading order.
- Refreshing or reopening the page loses no saved state.

### Review and Package

- Eddy review is explicitly invoked and returns anchored findings.
- Findings can be resolved or dismissed in context.
- A clean rerun closes stale findings rather than leaving contradictory advice.
- Subject, description, haiku, Echoes, and cover state are visible before
  Publish.
- The UI distinguishes Jamie-authored fields, generated options,
  deterministic fields, and publish-stamped fields.
- Build readiness explains every missing requirement.

### Publish

- Publish is presented as a runbook, not an undifferentiated button cluster.
- Each leg shows ready, running, succeeded, failed, skipped, or waiting.
- Every live action confirms the exact issue and destination.
- Audio progress remains visible during TTS and upload.
- Buttondown draft creation is distinguishable from Buttondown send/schedule.
- Website publication records the canonical Studio commit and downstream
  handoff.
- Re-running a succeeded leg is idempotent or clearly warns otherwise.
- A deliberately failed leg leaves completed legs intact and gives one precise
  recovery action.

### Close and Verify

- Put-to-bed is blocked until required legs succeed or are explicitly waived.
- Closing files the canonical issue and clears the active issue.
- Studio offers the computed next issue rather than silently creating it.
- The public issue URL is reachable.
- `feed.xml` contains the new issue.
- `podcast.xml` contains the new audio episode when audio was included.
- A concise completion record is posted in `#weekly-thing`.

## Readiness Audit

| Area | Present now | Gap to acceptance | Priority |
|---|---|---|---|
| Current issue landing | `/` redirects to the active issue | No-active state does not yet lead with a computed fall issue | P1 |
| Issue canvas | Main page renders and edits atoms in reading order | Separate `/editor` remains as duplicate surface and terminology | P2 |
| Time model | Publication and due dates are displayed | Cutoff and one computed next action are not prominent | P1 |
| Source sync | Manual and scheduled Pinboard/micro.blog sync exists | Last result/freshness is not operator-visible | P1 |
| Source controls | Reorder, select, exclude, and section override exist | Source ownership and override consequences need clearer UX | P2 |
| Eddy review | On-demand anchored review exists | Resolution and clean-rerun behavior need live rehearsal | P1 |
| Build readiness | Required sections, Intro, and cover are gated | Readiness says what is missing but not always the next action | P1 |
| Package | Subject and description edit in-page; haiku/Echoes are modeled | Field ownership and generation path are not coherent in-page | P1 |
| Publish gates | Per-channel gates and actions exist | `Ship all` is not gated on every leg; buttons do not expose progress state | P0 |
| Partial failure | Jobs are designed to be rerunnable | Recovery evidence is primarily Discord/job output, not durable page state | P0 |
| Buttondown state | Draft ID and URL are stored | Draft creation can be mistaken for email sent | P0 |
| Put-to-bed | Available in Publish phase | UI does not block premature close or require explicit waivers | P0 |
| External verification | Public feeds exist and are monitored | Verification is outside the Studio close workflow | P1 |
| Tests | Workshop suite is healthy | No full rehearsal acceptance harness exists | P1 |

Priority meanings:

- **P0:** could publish incorrectly, close prematurely, or obscure partial
  failure.
- **P1:** prevents Studio from being a self-explanatory weekly workflow.
- **P2:** meaningful usability improvement that can follow a safe rehearsal.
- **Deferred:** architecture or polish not required for the first fall issue.

## Initial Implementation Slices

### Slice A — Safe Publish Runbook

This is first because it contains the highest operational risk.

Scope:

- Persist or derive per-leg state for Audio, Buttondown draft, website, and
  close.
- Show ready/running/succeeded/failed/waiting states in the issue page.
- Gate each action on its true prerequisites.
- Distinguish Buttondown draft creation from confirmation that the email was
  scheduled or sent.
- Block Put-to-bed until required legs succeed or Jamie explicitly waives an
  optional leg.
- Preserve exact recovery guidance after partial failure.

Acceptance:

- A simulated website failure after successful Audio and Buttondown leaves
  those successes visible and offers only the Website retry.
- Put-to-bed cannot silently convert an incomplete publication into a closed
  issue.
- Existing lower-level jobs remain idempotent and available as repair paths.

### Slice B — Current Issue and Next Action

Scope:

- Make the no-active-issue home state propose the computed next number and
  post-break date.
- Show publication target, Thursday cutoff, last source sync, phase, and one
  computed next action in the issue header.
- Convert readiness failures into direct actions where possible.
- Preserve manual date/window adjustment for breaks and special issues.

Acceptance:

- Opening Studio always answers what issue is next and what Jamie should do
  now.
- No hidden Discord command is required to enter the normal issue workflow.

### Slice C — Review and Package Coherence

Scope:

- Keep Eddy findings beside affected atoms and make resolution explicit.
- Put subject, description, haiku, Echoes, and cover state in one package
  surface.
- Label field ownership: Jamie-authored, generated option, deterministic, or
  publish-stamped.
- Provide in-page generation/review actions without making chat the workflow.

Acceptance:

- Jamie can move from a complete draft to a publish-ready package without
  reconstructing the old command sequence.
- A clean Eddy rerun does not leave stale open guidance.

## Deferred Until After a Successful Rehearsal

- New unified atoms table
- Two-way Pinboard editing
- Drag-and-drop
- Generic production types
- Additional Studio agents
- Blog or standalone podcast production
- Obsidian as an issue-authoring surface
- Replacing Buttondown scheduling and sending
- Broad visual redesign

## Verification Strategy

Every implementation slice must include:

1. Existing targeted unit and route tests.
2. The full workshop test suite.
3. A live tailnet UI inspection.
4. A rehearsal issue using real source sync.
5. A before/after render comparison where publishing bytes could change.
6. Explicit confirmation that no historical issue content changed.

The publish runbook also requires a controlled partial-failure exercise. Do
not use a real subscriber send for rehearsal.

## Decision Queue

These need Jamie's judgment before the relevant implementation reaches them,
but they do not block the initial audit:

1. Is audio required for every normal issue, or explicitly optional?
2. What constitutes Buttondown completion: draft created, scheduled, or sent?
3. Should Studio replace the Weekly Thing OmniFocus project entirely, or
   should OmniFocus retain one high-level publication commitment?
4. Should the first post-break issue use the next sequential number after
   WT349, or preserve one of the previously planned windows?
5. What is the target return publication date?

## Change Discipline

- Improve the normal path before adding capabilities.
- Avoid schema unification until the live workflow proves it is needed.
- Keep granular jobs and repair commands beneath the web runbook.
- Freeze structural changes before the first live post-break issue.
- Record rehearsal friction here, prioritize it, and fix only material issues
  before the freeze.

