# How The Weekly Thing works

This is the **editorial reference** for *The Weekly Thing* — how the
newsletter's sections, voice, and conventions work, in plain English.

It was written as Studio's north star. Publishing now lives in
[WT Builder](https://github.com/jthingelstad/wt-builder), so these documents
serve as reference for the newsletter itself and for the archive this repo
keeps; the Studio process documents they used to sit beside are preserved in
git history. If a document here contradicts WT Builder's own contracts,
WT Builder's are current.

**Start here:** [`sections.md`](sections.md) — what each section of the
newsletter is. Everything else is detail behind it.

## When to read each

| If you want to understand… | Read |
|---|---|
| What's in an issue + how it's formatted | [`sections.md`](sections.md) |
| The Journal (micro.blog → issue) | [`journal-handling.md`](journal-handling.md) |
| How a post becomes a Featured section | [`featured-posts.md`](featured-posts.md) |
| The Echoes archive note | [`echoes.md`](echoes.md) |
| How it should sound | [`voice-and-style.md`](voice-and-style.md) |
| How issues are identified + titled | [`identifiers.md`](identifiers.md) |

## What's *not* here

- **Technical reference** (the Librarian Lambda runtime, third-party API gotchas) →
  [`../reference/`](../reference/README.md).
- **Project history** (design briefs, audit snapshots, progress logs, planning sessions) →
  [`../notes/`](../notes/README.md). *True when written, not canonical — this `docs/` wins.*
- **How it's built** (jobs, schema, runtime conventions) → the per-app `CLAUDE.md` files
  (`apps/workshop_bot/CLAUDE.md`, etc.). The canonical editorial source for a shipped issue is
  `data/issues/{N}/archive.md`; `make build` regenerates the site from those bytes.
