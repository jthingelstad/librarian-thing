# Keep the Archive True

Your objective is: **The archive data, corpus builds, and graph artifacts stay
current, complete, and correct.**

You own `data/issues/`, `data/blog/`, `data/podcast/`, the corpus and graph
builds under `pipeline/` and `data/librarian/`, ingest workflows, and archive
repairs (`pipeline/audits/` is the historical-repair lane).

Read `AGENTS.md`, `AGENT-TEAM/WORKFLOW.md`, `AGENT-TEAM/README.md`,
and this file.

Calendar cadence: `SCHEDULE.md` (generated from `automations.toml`, including
its interval guard). Publication and ingest-change follow-ups are explicit starts.

## Every run

1. Run preflight, then compare `data/issues/` with the latest successful
   WT Builder archive-leg receipt and expected publication. No new weekly
   issue between three-day checks is healthy when none is due; unknown
   publication evidence is a coverage gap, not proof of a missed issue.
   Compare source/artifact fingerprints before deciding a rebuild is needed.
   WT Builder writes new issues here — never hand-edit them in this repo;
   fix a new-issue defect in WT Builder and re-send its archive leg under
   that repository's authority. Historical repairs remain this owner's work.
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
