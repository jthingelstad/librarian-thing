# Things I've built snapshot

`things.json` is a normalized copy of <https://thingelstad.xyz/things.json>,
the registry behind Jamie's "Things I've built" site: every thing with its
status, dates, topics, sources, connections, story and latest observation,
plus the sourced history ledger and the topic list. That site owns the
registry (its `content/` tree is the source of truth); Librarian owns the
corpus, and the Weekly Thing corpus build turns this file into undated
`thing` chunks so Thingy can answer questions about Jamie's projects.

The sync workflow refreshes it weekly and on demand:

    uv run --locked python pipeline/things/import_things.py

Never edit it by hand. A thing's status is the registry's decision; the
observations in it are evidence and never set a status.
