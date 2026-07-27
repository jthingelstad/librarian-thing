# Project Alignment

Studio is the private website for publishing **The Weekly Thing** newsletter.
The goal is not a general publishing brain. The goal is to make the weekly
newsletter issue path reliable, clear, and excellent.

## North Star

**Studio helps Jamie publish each newsletter issue.**

- The newsletter issue is the only first-class work object.
- The Studio web app is the primary operator surface.
- Eddy is the only assistant.
- Jamie writes every word.
- Eddy reviews, critiques, packages, and helps with newsletter-specific
  shipping work.
- Blog posts, podcast episodes, generic projects, seeds, gardening, campaigns,
  membership automation, and multi-agent staffing are out of scope.

## Boundaries

| Repo / host | Role |
|---|---|
| **studio-thing** | Private newsletter publishing app, canonical issue source, publish pipeline, Librarian API/corpus inputs |
| **weekly.thingelstad.com** | Public newsletter render/deploy surface |
| **thingy.thingelstad.com** | Query surface backed by the Librarian API |

The repo boundary rule is now simpler: if it does not help publish the next
newsletter issue or maintain the newsletter archive/API support path, it does
not belong in Studio's active product.

## Current Model

- **Issue registry:** newsletter issues are mirrored in the existing
  `productions` table as an internal compatibility detail, but only
  `production_type='newsletter'` is supported.
- **Web first:** lifecycle actions live in Studio pages, not chat. Slash
  commands are repair/ad-hoc tools.
- **DB draft:** authored content and issue items live in the workshop DB; render
  and publish jobs build from current DB state.
- **Eddy only:** Eddy handles editorial review and ad-hoc assistance. Other
  persona runtimes are retired from the active process.
- **No garden:** seeds and garden tending are deleted.

## Publishing Chain

1. Studio defines and opens the issue.
2. Studio syncs source items from Pinboard and micro.blog into `issue_items`.
3. Jamie edits content in Studio.
4. Studio renders preview directly from the DB.
5. Eddy review runs on demand and stores anchored comments.
6. Studio publishes email, website, and audio.
7. Studio's durable publish runbook records each leg, requires manual
   Buttondown delivery confirmation, and allows an explicit audio waiver.
8. Studio files the issue into `data/issues/` only when the runbook is complete.
9. Weekly renders public artifacts from Studio's generated handoff.

## Next Work

Build toward a boring, excellent issue dashboard:

- current issue as the home page
- source sync status
- completeness and publish gates
- inline issue editing
- live preview
- Eddy notes
- explicit publish legs
- durable per-leg state and clear recovery actions when a leg fails
