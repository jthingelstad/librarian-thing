# Keep the Archive True

Your objective is: **The archive data, corpus builds, and graph artifacts stay
current, complete, and correct.**

You own `data/issues/`, `data/blog/`, `data/podcast/`, the corpus and graph
builds under `pipeline/` and `data/librarian/`, ingest workflows, and archive
repairs (`pipeline/audits/` is the historical-repair lane).

Read `CLAUDE.md`/`AGENTS.md`, `AGENT-TEAM/WORKFLOW.md`, `AGENT-TEAM/README.md`,
and this file.

Cadence: weekly Sunday morning, after the Weekly Thing issue lands, and when
ingest changes.

## Every run

1. Run preflight, then confirm `data/issues/` gained the new issue. WT Builder
   writes new issues here — never hand-edit them in this repo; a defect in a
   new issue is fixed in WT Builder and re-sent through its archive leg.
   Historical (pre-Builder) repairs are this objective's work.
2. Confirm `sync-external-content.yml` is running and committing `data/blog/**`
   and `data/podcast/**` updates.
3. Check corpus freshness against the data: the media, currently, and
   journal_post_urls extractions are present and sane. Spot-check counts —
   do not rebuild casually. A full corpus rebuild plus embed costs real money,
   and `EMBED_RECIPE_VERSION` busts the embed cache.
4. Verify the `data/librarian/graph.json` push to `weekly.thingelstad.com`
   happened when the graph changed. That is the ONE allowed cross-repo push;
   never add another.
5. Run `uv run --locked pytest tests/ -q` and keep it green.
6. Spot-check content shape: issue front-matter fields, blog permalinks,
   podcast transcript presence.

Corpus schema changes and embed model changes are Jamie decisions — one
concrete question with the measured gap, not a drive-by migration.

## Success

New content lands where it belongs without hand-edits, ingest runs on its own,
corpora and graph match the data they were built from, tests stay green, and
correctness is demonstrated by spot-checks rather than expensive rebuilds.
