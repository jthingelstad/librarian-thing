# Phase 2 — Cutover & Weekly Slim-Down (Completed)

> Historical record: Studio and the Workshop bot have since been retired. See
> `README.md` and `ALIGNMENT.md` for the current Librarian architecture.

Phase 2 turned Studio into the live producer and reduced
`weekly.thingelstad.com` to a render surface.

## Final Shape at Phase 2 Completion

- The authoring bot commits canonical `data/issues/{N}/*` to `studio-thing`.
- Studio builds archive inputs, corpus, graph, and status artifacts.
- Studio deploys Librarian Lambda changes when needed.
- Studio commits generated 11ty inputs to `weekly.thingelstad.com`.
- Weekly refreshes only its own landing-page stats, then builds Eleventy +
  Pagefind and deploys GitHub Pages.

## Weekly Keeps

- `apps/site/` — the Eleventy render surface.
- `apps/files-cdn/` — static CDN support files.
- Node package files, Playwright tests, and site-owned scripts.
- Generated inputs pushed by Studio:
  `apps/site/archive/*.md`, `apps/site/_data/{emails,status}.json`, and
  `data/librarian/graph.json`.
- Site-owned `apps/site/_data/stats.json`.

## Weekly No Longer Owns

- `apps/workshop_bot/`
- `apps/librarian/`
- `apps/thingy_bridge/`
- `content/buttondown/`
- `data/issues/`, `data/audio/`, `data/blog/`
- `pipeline/`
- `librarian-core/`
- Brain docs, reference, notes, and Python tests

## Rollback Reference

The pre-split code remains recoverable from this repository's Git history. A
practical rollback would repoint the bot's `GITHUB_REPO_NWO`, restore
Weekly's old deploy workflow from history, and re-add any removed Weekly
secrets. That should be treated as an emergency path, not normal operation.

## Thingy Coordination

Thingy is now a separate query surface at `thingy.thingelstad.com`. The
Librarian CORS configuration lives in
`apps/librarian/infra/cloudformation.yaml` and deploys from Studio.
