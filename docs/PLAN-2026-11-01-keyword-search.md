# Plan: keyword search on SQLite full-text search (2026-11-01)

Jamie, 2026-11-01: "What is the plan for the keyword search -- I agree that
is our weakest link right now. OpenSearch seemed not tenable for our hobby
scale." And then: "Approved: start keyword search in librarian-thing: write
the keyword test set now, measure SQLite BM25 after tomorrow's re-embed, then
hand the build to Codex".

It is the only active retrieval project after the v4 re-embed (Jamie,
2026-11-01: "Approved: park the DynamoDB vector plan in librarian-thing; keyword search is the only active retrieval project after the v4 re-embed"); a change
belongs on the list only when it moves the meaning or keyword set, or fixes a
problem someone has seen.

This follows `PLAN-2026-11-01-embeddings.md`. The Embed v4 re-embed lands
first and alone, so the keyword change is measured against the baseline
readers get.

## Why

The lexical leg (`retrieveLexical` in `apps/librarian/lambda/shared/retrieval.mts`)
is a TF-IDF cosine over an index built in the Lambda's memory at each cold
start, with no stemming, no phrases and no field weights. On the meaning set
(2026-11-01) it scores 0.26 MRR alone, and fusing it with Embed v4 drops the
semantic leg's 0.55 to 0.41 before the reranker restores the order. A quarter
of the Weekly Thing answers never reach the reranker's pool.

## The keyword set

`pipeline/eval/build_keyword_set.py` cuts questions from the archive by rule,
with no model, so it is free to rebuild. Each one leads to exactly one source
in all five corpora, and so does its answer quote (Codex review, #113). It
writes `apps/librarian/lambda/eval/keyword-set.json`
(150 questions) and, for the unpublished reference documents,
`tmp/eval/keyword-set-private.json` (11, never committed). The items have the
meaning set's shape, so `scripts/eval-meaning.mjs --set eval/keyword-set.json`
scores them in every mode.

| Kind | What the reader types | n |
|---|---|---|
| `phrase` | four to six common words of the passage's wording | 30 |
| `quoted` | the same, in double quotes | 16 |
| `name` | a name and a word near it, the pair in no other source | 34 |
| `inflected` | a name pair with the word's other form, one the source never uses | 18 |
| `title` | a post's, saved link's, section's or page's title | 31 |
| `question` | a name pair inside "what did Jamie write about ..." | 21 |

Today's lexical leg on it (v3 corpora from 2026-11-01, no Bedrock calls),
source MRR:

| | phrase | quoted | name | inflected | title | question | all |
|---|---|---|---|---|---|---|---|
| all corpora | 0.37 | 0.44 | 0.76 | 0.31 | 0.87 | 0.52 | **0.58** |

By corpus: Weekly Thing 0.48 (phrase 0.21, question 0.20), blog 0.56,
reference 0.53, links 0.72. A word in its other form is found first only 6%
of the time. Weekly Thing is weakest, as the meaning set's pool
recall said: one source is a whole issue, and common words drown in it.

## The design

SQLite's FTS5 is built into Node's `node:sqlite` and Python's `sqlite3`, so
the index is one file and needs no server. Checked 2026-11-01 on Node
24.22.2 (SQLite 3.53.4), the runtime's major version: FTS5 is there; the
`porter unicode61` tokenizer matches "session" to "sessions"; a quoted
phrase matches only that phrase; `bm25()` takes column weights.

- **Build:** the corpus build writes the FTS5 file beside the corpus (subject,
  section and text columns; the chunk id). It is a corpus artifact: staged in
  `.candidate/`, checked by the corpus gate, uploaded with `--upload-staged`,
  carrying its fact metadata, and counted in `NativeBuildId`.
- **Serve:** the Lambda downloads it to `/tmp` at cold start, as it reads the
  corpora now, opens it read-only, and asks it for the lexical leg's top
  candidates with the scan's filters. `fuseCandidates`, the rerank and the
  `/retrieve` contract do not change. The in-memory TF-IDF index goes.
- **Release:** an MCP version bump; the gate holds both sets.

## Measure first (after the re-embed)

The measurement runs offline in the eval harness against the v4 corpora:

1. Today's TF-IDF against FTS5 variants: `unicode61` against `porter`;
   column weights for subject and section; what a full question becomes
   (every term OR'd, stopwords dropped, a quoted span kept as a phrase).
   FTS5's `bm25()` fixes k1 at 1.2 and b at 0.75; they are not tuned.
2. Each one alone, fused with v4 (and other `lexicalWeight` values), and
   fused then reranked, on the keyword set and the meaning set, with the
   Weekly Thing pool recall.
3. Pick the variant by the numbers. Ship only if the keyword set improves
   and the meaning set's reranked order does not get worse.

## Open questions

- The index file's size, and the cold start's time to fetch and open it.
- `/tmp` room on the Web Functions.
- `node:sqlite` on the Lambda's own Node 24 build: the release probe asks a
  keyword question of the candidate before it is promoted.

## Who builds

Design and measurement here; the build is one PR for Codex, written from this
plan and the measurement's numbers.
