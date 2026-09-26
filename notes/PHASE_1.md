# Phase 1 — Stand Up Studio (Completed)

Phase 1 moved the producer half of the old Weekly monorepo into Studio and
verified that Studio could reproduce the generated website inputs.

## What Landed

- `.github/workflows/deploy.yml` runs Studio production: archive build, tests,
  corpus, graph, corpus upload, Lambda deploy on change, status generation, and
  the cross-repo handoff.
- `pipeline/deploy/push_site_inputs.py` gathers generated site inputs
  (`apps/site/archive/*.md`, `apps/site/_data/{emails,status}.json`,
  `data/librarian/graph.json`) and commits them atomically to
  `weekly.thingelstad.com` when called with `--push`.
- `stats.json` was deliberately removed from the Studio handoff. Weekly owns
  its own landing-page stats fetch.

## Current Behavior

Studio is no longer a dry-run-only parallel copy. Normal pushes to `main` run
the production workflow and push generated site inputs to Weekly. Manual
workflow runs remain useful for inspection: leave `push_to_weekly` unchecked for
a dry-run diff, or check it to force a handoff.

## Notes

- The handoff reuses `apps/workshop_bot/tools/github_repo.py`, the same atomic
  Git Data API helper used by the ship sequence.
- Generated `apps/site/...` files are transient in Studio CI. They are built
  here, handed to Weekly, and not committed to Studio.
- `data/librarian/corpus.json` goes to S3 for the Lambda. Only `graph.json`
  goes to Weekly for topic pages.
