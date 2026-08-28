# docs/ — project memory

`docs/` is the **editorial reference for how The Weekly Thing works**, written as Studio's
north star. Publishing now lives in WT Builder, whose own contracts are current where they
overlap; these documents remain the reference for the newsletter's sections, voice, and
conventions. The human-facing index is [`README.md`](README.md).

## What this is (and isn't)

- **This is the spec, Jamie-authored.** Agents may *seed* or *consolidate* these docs from canonical
  sources (the persona prompts, the per-app CLAUDE.md, the renderers), but **Jamie owns the voice**
  — especially [`voice-and-style.md`](voice-and-style.md) and anything marked *"draft — refine in
  your voice."* Don't silently rewrite his editorial declarations; propose and let him decide.
- **Distinct from the per-app `CLAUDE.md`s** (e.g. `apps/librarian/CLAUDE.md`): those are
  *runtime* memory — how the code is built and what to keep in mind editing it. `docs/` is the
  *editorial* model the code serves.
- **Distinct from [`../notes/`](../notes/README.md)** (point-in-time history, non-canonical) and
  [`../reference/`](../reference/README.md) (durable technical reference). When `notes/` conflicts
  with `docs/`, `docs/` wins.

## The discipline

- **Verify against this.** When building or changing a surface/job/persona, the test is *does it
  respect this model?* When `docs/` and the code disagree, that's a flag to resolve deliberately —
  either the doc is the target (change the code) or the doc is stale (update it). Don't let them
  drift silently.
- **Keep docs small.** One concern per file, ~1 screen each (≤~120 lines); scannable bullets/tables
  over prose; **link, don't duplicate** — each doc owns its slice and cross-links the rest.

## Voice

[`voice-and-style.md`](voice-and-style.md) is the **canonical human voice declaration**. The
machine-maintained marketing brief that used to track it retired with the content pipeline.
