# Librarian

This repository is the **Librarian API and the corpora it answers from** —
the archive side of *The Weekly Thing*.

It used to be Studio, the publishing system. Publishing moved to
[WT Builder](https://github.com/jthingelstad/wt-builder), which authors and
sends each issue directly to the website, Buttondown, and the podcast, then
nudges the Librarian to pull it, so Thingy can retrieve and cite it. What
remains in this repo is exactly that boundary: the library (the Librarian's
copy of the archive), the corpus builds, and the API that serves them.

## Architecture

| Repo / host | Role |
|---|---|
| **librarian-thing** (this repo) | The library, corpus builds, Librarian API |
| wt-builder | Authors and publishes each issue; its send nudges the library round |
| weekly.thingelstad.com | Public newsletter site and archive render surface |
| thingy.thingelstad.com | Query surface backed by the Librarian API |
| librarian.thingelstad.com | The API's public domain: chat/auth endpoints, OAuth 2.1, and the MCP server at `/mcp` |

## What's here

| Path | What it is |
|---|---|
| `apps/librarian/` | Librarian API Lambda + infra + admin |
| `librarian-core/` | Shared corpus/graph/retrieval/links package |
| `pipeline/corpus/` | Corpus builds (Weekly Thing, podcast) |
| `pipeline/blog/` | Blog ingest from Micro.blog, and maintenance utilities |
| `pipeline/podcast/` | Another Thing episode import |
| `pipeline/things/` | Things I've built registry snapshot (thingelstad.xyz) |
| `pipeline/graph/` | Topic graph build (powers the site's topic pages) |
| `pipeline/deploy/` | Corpus uploads, Lambda deploy, graph handoff |
| `pipeline/library/` | The library: `library.db` in S3, its pulls, export and upload |
| `pipeline/audits/`, `pipeline/one-shot/` | Archive maintenance and completed migrations |
| `data/` (not in git) | The library's export, and the built corpus and graph beside it |
| `docs/`, `notes/`, `reference/` | Architecture and editorial reference |

## How content flows

- **The library** (`library.db` in S3, `pipeline/library/README.md`) holds
  the Librarian's copy of every source. The library round pulls them daily,
  on demand, and when one publishes: **issues** from weekly.thingelstad.com's
  archive pages (WT Builder's send nudges it), **the blog** from micro.blog,
  **the podcast** from `another.thingelstad.com`, and **Things I've built**
  from thingelstad.xyz's `things.json` (undated `thing` chunks, `thing-<id>`).
- When the library moves past what a corpus was built from, the production
  workflow exports it, rebuilds that corpus, embeds, uploads to S3, and hands
  the topic graph to `weekly.thingelstad.com` — the one cross-repo push this
  repo still makes. Friday and Saturday the build waits for the send.
- The Lambda redeploys when its code changes or any corpus rebuilds (it
  caches each corpus for a container's life). The `/retrieve` endpoint is a
  versioned contract; Thingy is a live client across a repo boundary.
- The same tool registry that answers Thingy's chat is published as an
  **MCP server** (`librarian.thingelstad.com/mcp`, OAuth 2.1 sign-in), so
  Claude, ChatGPT, and other MCP clients query the archive with identical
  tools, plus resources and prompts. It is for Jamie and for readers:
  Weekly Thing subscribers connect with the steps on
  [thingy.thingelstad.com/connect/](https://thingy.thingelstad.com/connect/),
  at 500 tool calls a day (1,000 for Supporting Members) and 300 an hour.
  The contract is MCP 2.0.0 (`reference/librarian.md`). Matching semantics
  live in one canonical component
  (`apps/librarian/MATCHER.md`), enforced by an eval suite that runs on
  every deploy and blocks it on failure.

## Working here

```sh
uv sync --locked
uv run pytest tests/ -q          # Python tests
make test-lambda                 # Lambda tests
make build                       # corpus + graph
```

Deploy committed `main` without a local AWS session:

```sh
gh workflow run deploy.yml --ref main -f scope=code
```

See `pipeline/deploy/iam/README.md` for deployment permissions and recovery.
See `AGENTS.md` for constraints and `ALIGNMENT.md` for the cross-repo map.

## History

Studio's full history is preserved in this repository — the workshop bot,
Eddy and the personas, the site handoff, and the audio pipeline are all in
git history at the rename boundary. The workshop's local database was
preserved off-repo before removal.
