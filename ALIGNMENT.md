# Project Alignment

This repository is the **Librarian**: the canonical archives of Jamie's
publishing, the corpora built from them, and the API that answers questions
from them. It is deliberately not a publishing system anymore.

## North Star

**The Librarian keeps the archive true and answerable.**

- Canonical issue, blog, and podcast content lives here.
- The corpus builds and the `/retrieve` contract are the product.
- Publishing belongs to WT Builder; rendering belongs to the surfaces.
- Nothing here writes to a reader.

## Boundaries

| Repo / host | Role |
|---|---|
| **librarian-thing** | Canonical archives, corpus builds, Librarian API |
| **wt-builder** | Authors and publishes each issue; commits issue text into `data/issues/` after publication |
| **weekly.thingelstad.com** | Public newsletter render/deploy surface |
| **another.thingelstad.com** | Podcast publish surface; episodes are ingested here |
| **thingy.thingelstad.com** | Query surface — live client of the Librarian API |

The boundary rule: if it publishes, it is downstream in its own repo. If it
is the archive, the corpus, or the retrieval path, it lives here.

## Content flow

1. WT Builder publishes an issue, then commits its canonical text into
   `data/issues/{N}/`.
2. The sync workflow pulls blog posts from Micro.blog and podcast episodes
   from `another.thingelstad.com` into `data/`.
3. Any `data/` change rebuilds the affected corpora, embeds them, uploads to
   S3, and hands the topic graph to `weekly.thingelstad.com`.
4. Thingy chat answers from the deployed corpus through the Librarian's
   agent loop; WT Builder retrieves through the versioned `/retrieve`
   contract; MCP clients (Claude, ChatGPT, Codex) use the same tool
   registry via `librarian.thingelstad.com/mcp`.

## What was retired

Studio — the workshop web app, Eddy and the persona staff, the site handoff,
the audio pipeline, and the Buttondown config — is preserved in git history
at the rename boundary (studio-thing → librarian-thing, 2026-08-28).
Publishing machinery that is still needed lives in WT Builder, written fresh.
