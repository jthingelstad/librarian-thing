# Featured posts

How a journal post gets promoted to its own standalone section. The key idea is a clean split:
**classify upstream, arrange at render.**

## Classify (upstream, editorial)

A post becomes Featured by being in micro.blog's **`Featured` category** — Jamie's editorial call,
made where he writes. Nothing in the workshop *decides* what's featured; it reads the category.
(This is deliberate: the same reason Eddy's reorder pass is ordering-only — the human classifies,
the machine arranges. Eddy is retired; its spec is in git history.)

## Arrange (at render)

At render time a Featured post is lifted out of the Journal flow and spliced in as its own
**H2 section** (`## {heading}`), placed after its parent section based on the row's
`promoted_position`. So a Featured post can sit as a standalone section after Notable, Journal, or
Briefly rather than buried in the day's entries.

## Why split it this way

Classification is a *content* decision (Build phase, upstream); arrangement is a *rendering*
decision (the shared body assembly). Keeping them apart means the featured choice travels with the
post (it's just a micro.blog category) and the layout logic stays in one place
(`tools/renderers.py`) — neither has to know about the other beyond the category flag.

See also: [`journal-handling.md`](journal-handling.md) · [`sections.md`](sections.md).
