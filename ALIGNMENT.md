# Project Alignment

This repository is the **Librarian**: the library (its copy of Jamie's
publishing), the corpora built from it, and the API that answers questions
from them. It is deliberately not a publishing system anymore.

## North Star

**The Librarian keeps the archive true and answerable.**

- The sources keep the content and its history (weekly.thingelstad.com for
  issues, micro.blog for the blog); the library holds the Librarian's copy
  and what it makes, in `library.db` in S3, not git.
- The corpus builds and the `/retrieve` contract are the product.
- Publishing belongs to WT Builder; rendering belongs to the surfaces.
- Nothing here writes to a reader.

## Boundaries

| Repo / host | Role |
|---|---|
| **librarian-thing** | The library, corpus builds, Librarian API |
| **wt-builder** | Authors and publishes each issue; its send nudges the library round to pull it from weekly |
| **weekly.thingelstad.com** | Public newsletter render/deploy surface |
| **another.thingelstad.com** | Podcast publish surface; episodes are ingested here |
| **thingy.thingelstad.com** | Query surface — live client of the Librarian API (S3/CloudFront, same-origin `/api/*`, cookie sessions; registers WebMCP page tools via `/tools`) |

The boundary rule: if it publishes, it is downstream in its own repo. If it
is the archive, the corpus, or the retrieval path, it lives here.

## Content flow

1. WT Builder publishes an issue to weekly.thingelstad.com, then nudges the
   library round (`repository_dispatch` `issue-sent`).
2. The library round pulls weekly's issue pages, micro.blog, the podcast and
   Things I've built into `library.db` (daily, and when a source publishes).
3. When the library moves past what a corpus was built from, the production
   workflow rebuilds that corpus, embeds it, uploads to S3, and hands the
   topic graph to `weekly.thingelstad.com`. Friday and Saturday it waits for
   the send.
4. Thingy chat answers from the deployed corpus through the Librarian's
   agent loop; WT Builder retrieves through the versioned `/retrieve`
   contract; MCP clients (Claude, ChatGPT, Codex) use the same tool
   registry via `librarian.thingelstad.com/mcp`.

## What was retired

Studio — the workshop web app, Eddy and the persona staff, the site handoff,
the audio pipeline, and the Buttondown config — is preserved in git history
at the rename boundary (studio-thing → librarian-thing, 2026-08-28).
Publishing machinery that is still needed lives in WT Builder, written fresh.
