# Brief: the keyword index (for Codex, 2026-11-02)

One PR. Replace the Librarian's in-memory TF-IDF keyword leg with one SQLite
full-text (FTS5) file over every corpus. The design and the numbers are in
`PLAN-2026-11-01-keyword-search.md` (Measured); this brief fixes the shape.
Read `AGENTS.md`, `apps/librarian/AGENTS.md` and `apps/librarian/MATCHER.md`
first. Jamie approved the work on 2026-11-01: "measure SQLite BM25 after
tomorrow's re-embed, then hand the build to Codex".

## What the index is

- **One file, every corpus.** `keyword_index.db`: an FTS5 table with columns
  `subject`, `section`, `text`, and `kind` and `id` UNINDEXED (`kind` is
  `weekly_thing`, `blog`, `podcast`, `reference` or `link`; `id` is the
  chunk's `id`). Tokenizer `porter unicode61`. One table for all corpora is
  the point: bm25 then shares one set of word counts, and a small corpus is
  not ranked out (one file per corpus scored the podcast 0.00 to 0.50).
- **The rows the Lambda scans.** Index exactly the rows `retrieveLexical`
  reads per corpus: for Weekly Thing and the blog, `ownRows` (reference rows
  stay in the reference corpus). The text as the corpus holds it; URLs kept.
- **Built with `node:sqlite`,** the engine that reads it (a script under
  `apps/librarian/lambda/scripts/`), then `INSERT INTO t(t) VALUES('optimize')`.
  About 45 MB and under a second for 38,906 rows.

## Where it is built and shipped

- It is a corpus artifact. After the embed steps in `.github/workflows/deploy.yml`,
  build `.candidate/keyword_index.db` from the candidate corpora, reading the
  live copy of any corpus not rebuilt (the gate's `EVAL_CORPUS_FALLBACK=s3`
  rule). Rebuild it whenever any corpus is rebuilt, and in any deploy where
  `artifacts/keyword_index.db` is missing (the first one).
- The corpus gate checks it: every row of every served corpus has exactly
  one entry, by `(kind, id)`, and no entry names a row that does not exist.
- `--upload-staged` uploads it to `artifacts/keyword_index.db` with fact
  metadata like the corpora's (built-at, row count, and each corpus's
  built-at it was made from). It joins `NativeCorpusVersions` and
  `NativeBuildId`, so `/health` lists it.
- Corpus rebuilds now reuse the vectors of unchanged chunks, so a deploy
  that rebuilds a corpus costs little; still, do not change a corpus's
  build inputs in this PR.

## How the Lambda serves it

- `KEYWORD_INDEX_KEY` (default `artifacts/keyword_index.db`). At cold start,
  next to the corpora, download it to `/tmp` and open it read-only.
- The query, from the reader's words (`scripts/fts5-lexical.mjs` `ftsQuery`,
  `query=adjacent`; move it to `shared/` and have the eval import it):
  words are `[\p{L}\p{N}]+`, lowercased; stopwords dropped unless that
  leaves none; each word quoted and OR'd. A span in double quotes of two or
  more words is a phrase; with no quoted span, a query of two or more words
  is a phrase. Rows holding a phrase rank first, by bm25 among themselves,
  then the term matches. Equal column weights. A reader's words never
  become FTS5 syntax (the test in `tests/lexical-engine.test.mjs`).
- Per corpus pool, `WHERE t MATCH ? AND kind = ?`, ordered by bm25; map
  `(kind, id)` to the row `indexedChunks(kind)` holds and apply the scan's
  `keep` filter and limit, as `retrieveLexicalWith` does now. `fuseCandidates`,
  the rerank, the fusion weight (1) and the `/retrieve` contract do not change.
- **The TF-IDF index stays for this release only as the logged fallback**:
  if the file is missing or will not open, log `keyword_index_unavailable`
  (error) and use TF-IDF. Remove it in a later PR after a week of serving.
- The release check of the native candidate asks it one keyword question
  (for example "the mini minnebar" finds wt-147) before promotion, so a
  runtime whose `node:sqlite` lacks FTS5 never goes live.

## Done when

- `make check` passes; tests cover the query builder, phrase-first, the
  kind filter, the gate's coverage check, and the fallback's log line.
- MCP `server_version` goes to 2.12.0 with a line in the version history
  (`apps/librarian/AGENTS.md`): retrieval only, no tool, argument or field
  changes. `docs/PLAN-2026-11-01-keyword-search.md` says it shipped.
- After the deploy, the measurement in the plan repeats on the served engine
  (Claude or Jamie runs it; it needs AWS): keyword set about 0.94 alone and
  0.92 reranked, meaning set 0.65 reranked with 88% in the pool. No new CI
  floor (fixed floors break the gate as the archive grows).
- Never verify with a write against live data.
