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

## Measured (2026-11-02, on the v4 corpora)

`scripts/eval-meaning.mjs --lexical fts5:<options>` puts SQLite full-text
search (`scripts/fts5-lexical.mjs`, built in memory with `node:sqlite`) in
place of the TF-IDF leg; `retrieve()` takes it as `opts.lexicalEngine`,
which nothing that serves readers passes. Source MRR, keyword set (161) and
meaning set (282):

| Keyword leg | Alone: keyword / meaning | Fused: keyword / meaning | Reranked: keyword / meaning | Pool (meaning, WT) |
|---|---|---|---|---|
| TF-IDF (today) | 0.60 / 0.27 | 0.61 / 0.41 | 0.91 / 0.64 | 84%, 73% |
| FTS5, chosen | 0.94 / 0.35 | 0.63 / 0.45 | 0.92 / 0.65 | 88%, 75% |
| the same, `lexicalWeight` 0.5 | | 0.55 / 0.47 | 0.92 / 0.65 | 88%, 77% |

Semantic alone is 0.43 / 0.54. The chosen variant: the `porter unicode61`
tokenizer, stopwords dropped, the rest OR'd; a quoted span is a phrase, and
an unquoted query of two or more words is one too, and rows holding a phrase
rank first; equal weights for subject, section and text; and **one index
over every corpus**. Alone on the keyword set:

- **Stemming** carries the other form of a word (inflected 0.35 to 0.91);
  without it 0.45.
- **The in-order phrase** carries the passage's own wording (phrase 0.41 to
  1.00, quoted 0.44 to 0.95). The phrase questions were cut to be unique
  in the archive, so 1.00 flatters it.
- **Subject and section weights** (3:2:1, 1:2:1) lift titles and cost
  phrases and questions: worse overall. Stripping URLs from the text is a
  wash.
- **One index per corpus failed the small ones.** `retrieve()` sorts the
  keyword lists of every corpus it scans together, and bm25 is computed
  from each corpus's own word counts, so the podcast (one episode) fell from
  1.00 to 0.00 to 0.50. Dividing each corpus's scores by its best restored
  the podcast and cost reference and documents. One index over every
  corpus shares one set of counts: podcast 1.00, documents 1.00, and the
  best totals.

**What it means for readers.** Every answer path reranks (only the welcome
suggestions' grounding does not), and the reranker was already covering
for the weak leg: with TF-IDF, 99% of the keyword answers reached its pool.
So the reranked gain is small, +0.01 on each set, and the plan's rule
holds: the keyword set improves and the meaning set's reranked order does
not get worse. The answer reaches the reranker more often (84% to 88%;
Weekly Thing 73% to 75%), and the unreranked order improves. The fusion
weight stays 1: 0.5 helps the meaning set's fused order and costs the
keyword set's, and reranked they are the same.

**The cost side.** Today's TF-IDF index holds 176 MB of heap in every Lambda
environment (peaks run 1.0 to 1.4 GB of 2 GB, `NATIVE-WEB.md`). One FTS5
file over all 38,906 rows is 45 MB on disk, builds in under a second, opens
in 1 ms, and answers a six-word OR query in about 3 ms (Node 26 on the
Mac). The measurement cost about $2.65 of rerank calls (1,323 at $0.002)
and a few thousand embedding tokens.

## Open questions

- `node:sqlite` with FTS5 on the Lambda's own Node 24 build: the release
  probe asks a keyword question of the candidate before it is promoted.
- `/tmp` room on the Web Functions for a 45 MB file.

## Who builds

Codex, from `BRIEF-2026-11-02-keyword-index-build.md`, as one PR.
