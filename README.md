# Librarian

This repository is the **Librarian API and the corpora it answers from** —
the archive side of *The Weekly Thing*.

It used to be Studio, the publishing system. Publishing moved to
[WT Builder](https://github.com/jthingelstad/wt-builder), which authors and
sends each issue directly to the website, Buttondown, and the podcast — and
commits the canonical issue text *here*, into `data/issues/`, so Thingy can
retrieve and cite it. What remains in this repo is exactly that boundary:
the canonical archives, the corpus builds, and the API that serves them.

## Architecture

| Repo / host | Role |
|---|---|
| **librarian-thing** (this repo) | Canonical archives, corpus builds, Librarian API |
| wt-builder | Authors and publishes each issue; commits issue text into `data/issues/` |
| weekly.thingelstad.com | Public newsletter site and archive render surface |
| thingy.thingelstad.com | Query surface backed by the Librarian API |

## What's here

| Path | What it is |
|---|---|
| `apps/librarian/` | Librarian API Lambda + infra + admin |
| `librarian-core/` | Shared corpus/graph/retrieval/links package |
| `pipeline/corpus/` | Corpus builds (Weekly Thing, podcast) |
| `pipeline/blog/` | Blog ingest from Micro.blog, and maintenance utilities |
| `pipeline/podcast/` | Another Thing episode import |
| `pipeline/graph/` | Topic graph build (powers the site's topic pages) |
| `pipeline/deploy/` | Corpus uploads, Lambda deploy, graph handoff |
| `pipeline/audits/`, `pipeline/one-shot/` | Archive maintenance and completed migrations |
| `data/issues/` | Canonical issue content — written by WT Builder for new issues |
| `data/blog/`, `data/podcast/` | Ingested blog and podcast content |
| `data/librarian/` | Built corpus and graph artifacts |
| `docs/`, `notes/`, `reference/` | Architecture and editorial reference |

## How content flows

- **Issues** arrive as commits from WT Builder after each issue publishes
  (`data/issues/{N}/archive.md`, `links.json`, `metadata.json`).
- **Blog and podcast** content is pulled by the sync workflow from Micro.blog
  and `another.thingelstad.com`.
- Any change under `data/` triggers the production workflow: rebuild the
  affected corpora, embed, upload to S3, and hand the topic graph to
  `weekly.thingelstad.com` — the one cross-repo push this repo still makes.
- The Lambda redeploys when its code changes. The `/retrieve` endpoint is a
  versioned contract; Thingy is a live client across a repo boundary.

## Working here

```sh
uv sync --locked
uv run pytest tests/ -q          # Python tests
make test-lambda                 # Lambda tests
make build                       # corpus + graph
```

See `AGENTS.md` for constraints and `ALIGNMENT.md` for the cross-repo map.

## History

Studio's full history is preserved in this repository — the workshop bot,
Eddy and the personas, the site handoff, and the audio pipeline are all in
git history at the rename boundary. The workshop's local database was
preserved off-repo before removal.
