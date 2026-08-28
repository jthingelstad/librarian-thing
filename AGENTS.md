# AGENTS.md — Librarian

Orientation for agents working in this repo. Read `README.md` for the human
overview and `ALIGNMENT.md` for the cross-repo map.

## What this repo is

The **Librarian API and the corpora it answers from** — the archive side of
The Weekly Thing. Canonical issue, blog, and podcast content lives in
`data/`; the corpus builds live in `pipeline/`; the API lives in
`apps/librarian/`.

This repo does not publish. WT Builder authors and sends each issue, and
commits the canonical issue text into `data/issues/` afterwards. Blog and
podcast content is ingested by the sync workflow. This repo's job is to keep
the archive true, build the corpora, and serve retrieval.

Until 2026-08-28 this repo was Studio, the publishing system. The workshop
bot, Eddy, the site handoff, and the audio pipeline are preserved in git
history at the rename boundary (studio-thing → librarian-thing), not here.

## Layout

- `apps/librarian/` — Librarian API (Lambda + infra + admin). Deployed from here.
- `librarian-core/` — shared `librarian_core` package (corpus/graph/retrieval/links).
- `pipeline/corpus/`, `pipeline/graph/`, `pipeline/deploy/` — builds and deploys.
- `pipeline/blog/`, `pipeline/podcast/` — content ingest and maintenance.
- `pipeline/audits/`, `pipeline/one-shot/` — archive maintenance, completed migrations.
- `data/issues/` — canonical issue content. **WT Builder writes new issues here.**
- `data/blog/`, `data/podcast/` — ingested content.
- `data/librarian/` — built corpus and graph artifacts.
- `tests/` — Python tests (corpus / content shape / dashboard).

## Hard constraints

- **The Librarian API `/retrieve` is a versioned contract.** Thingy is a live
  client across a repo boundary — casual changes break it. Version before
  changing.
- **`data/issues/` is written by WT Builder.** Do not hand-edit new issues
  here; fix them in WT Builder and re-send the archive leg. Historical
  repairs (pre-Builder issues) are fine and are what `pipeline/audits/` is
  for.
- **One cross-repo push remains:** `data/librarian/graph.json` to
  `weekly.thingelstad.com` (topic pages). Do not add others — publishing
  handoffs belong to WT Builder.
- **Secrets:** corpus/Lambda deploy credentials live in this repo's CI
  secrets. Nothing here holds publishing credentials anymore.
- **Preserve history.** Never copy-paste code between repos; move with
  history or write fresh.

## First checks

```sh
git status --short
```

There may be user work in progress. Do not revert unrelated changes.

## Python environment

uv with a locked `.venv/` on Python 3.14:

```sh
uv sync --locked
uv run pytest tests/ -q
```

Do not use bare `python`, `python3`, or pip-managed environments here.

## Thingy / Librarian

The Lambda lives in `apps/librarian/`. For Lambda work, read
`apps/librarian/CLAUDE.md`. Lambda tests are Node tests:

```sh
npm --prefix apps/librarian/lambda test
```

Deploy code-only Librarian changes with the corpus upload skipped:

```sh
make librarian-deploy ARGS="--skip-corpus-upload"
```
