# AGENTS.md — Librarian

Orientation for agents working in this repo. Read `README.md` for the human
overview and `ALIGNMENT.md` for the cross-repo map.

## What this repo is

The **Librarian API and the corpora it answers from** — the archive side of
The Weekly Thing. The archive is the library, one SQLite file in S3
(`pipeline/library/README.md`): the pulled copies of every source plus what
the Librarian makes. `data/` is its exported working copy and is not in git;
the corpus builds live in `pipeline/`; the API lives in `apps/librarian/`.

This repo does not publish. WT Builder authors and sends each issue; its send
nudges the library round (`.github/workflows/library-round.yml`), which pulls
the issue from weekly.thingelstad.com. The same round pulls the blog, the
podcast and Things I've built. This repo's job is to keep the archive true,
build the corpora, and serve retrieval.

Until 2026-08-28 this repo was Studio, the publishing system. The workshop
bot, Eddy, the site handoff, and the audio pipeline are preserved in git
history at the rename boundary (studio-thing → librarian-thing), not here.

## Layout

- `apps/librarian/` — Librarian API (Lambda + infra + admin). Deployed from here.
- `librarian-core/` — shared `librarian_core` package (corpus/graph/retrieval/links).
- `pipeline/corpus/`, `pipeline/graph/`, `pipeline/deploy/` — builds and deploys.
- `pipeline/library/` — the library: download, export, the pulls, upload, `stale`.
- `pipeline/blog/`, `pipeline/podcast/`, `pipeline/things/`, `pipeline/reference/`, `pipeline/links/`: the ingesters the pulls run, and maintenance. `pipeline/links/` snapshots Linking Things (links.thingelstad.xyz, every public link Jamie has saved), which the Librarian depends on and which never depends on the Librarian.
- `reference-documents/`: published documents about Jamie (a bio, a resume) for the reference corpus, the base every search consults and no caller selects. This repo is public, so documents that must not be published go in the library's `reference-unpublished/` instead, placed by Jamie by hand. Its README is the guide.
- `pipeline/audits/`, `pipeline/one-shot/` — archive maintenance, completed migrations.
- `data/` (not in git): the library's export: `weekly/archive/` (weekly's issue pages), `issues/` (derived from them), `blog/`, `podcast/`, `site/`, `things/`, `links/`, `reference/`, `reference-unpublished/`, and `librarian/` (the Librarian's sidecars plus the built corpus and graph). `pipeline/library/README.md` has the table.
- `tests/` — Python tests (corpus / content shape / conversation review / deploy security).

## Hard constraints

- **The Librarian API `/retrieve` is a versioned contract.** WT Builder and AT
  Builder are live clients across repo boundaries (Thingy web uses `/chat`,
  not `/retrieve`) — casual changes break them. Version before changing.
- **Thingy's words never enter the corpus.** Blocks WT Builder frames as
  `<div class="from-thingy">` (Echoes, Membership) are stripped before any
  chunk, count, topic, link or summary is built (`strip_thingy_blocks` in
  `librarian-core`). The frame is a cross-repo contract, pinned by tests here
  and in wt-builder `tests/echoes.test.ts`.
- **Fix content at its source.** weekly.thingelstad.com is the source of
  authority for issues and micro.blog for the blog; the library pulls them.
  `data/issues/` is derived on every export, so an edit there is lost: fix a
  new issue in WT Builder and re-send, a past one in weekly's
  `apps/site/archive/<n>.md` (`pipeline/audits/AGENTS.md`).
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

A fresh checkout has no `data/`, and the real-archive tests skip without it.
To build or test against the archive:

```sh
uv run --locked python pipeline/library/library.py download
uv run --locked python pipeline/library/library.py export
```

## Python environment

uv with a locked `.venv/` on Python 3.14:

```sh
uv sync --locked
uv run pytest tests/ -q
```

Before committing, `make check` runs lint, format, Python tests, and the Lambda tests.

Do not use bare `python`, `python3`, or pip-managed environments here.

## Thingy / Librarian

The Lambda lives in `apps/librarian/`. For Lambda work, read
`apps/librarian/AGENTS.md`. Lambda tests are Node tests:

```sh
npm --prefix apps/librarian/lambda test
```

Deploy code-only Librarian changes with the corpus upload skipped:

```sh
make librarian-deploy ARGS="--skip-corpus-upload"
```
