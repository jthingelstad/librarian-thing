# Plan: the semantic leg on a DynamoDB vector index (2026-11-01)

Jamie, 2026-11-01: "I think DynamoDB vector index is going to be the way to
go… OpenSearch doesn't work at our scale, and S3 Vectors had issues. Lets move
forward with that path."

This follows `PLAN-2026-11-01-embeddings.md` (Embed v4 at 1024). The model
switch ships first and alone, so its effect is measured alone.

## What changes

Today every Librarian environment loads about 675 MB of corpus JSON, 80% of
it vectors, holds them as float64 (about 320 MB resident), and scans every
corpus exactly on each question. After: the vectors live in a DynamoDB table
with a vector index, the Lambda loads the corpora without them, and the
semantic leg asks the index. The lexical leg, the fusion, the rerank and the
`/retrieve` contract do not change.

## What the bake-off showed

[`BAKEOFF-2026-11-01-dynamodb-vectors.md`](BAKEOFF-2026-11-01-dynamodb-vectors.md)
has the runs (38,866 v4 vectors, 266 public questions) and the index facts:

- **Unfiltered, the index matches the exact scan:** recall@100 0.989, no
  target lost.
- **An inline filter is only as good as it is wide:** a year loses 6
  targets (0.981); an issue loses 19 of 77 (0.725). Fetching an issue's
  vectors by key and scoring them is exact.
- **One partition per corpus,** not per corpus and year (0.977 unfiltered).
- **The index:** `TopK` at most 100, no pagination, filters equality only,
  immutable once made, about 50 ms a search, cents a month.

## The design

**Table.** `weekly-thing-librarian-passages`, in the Librarian stack, named
explicitly so the IAM documents can name it. On demand, no stream, no
point-in-time recovery (it is derived: rebuilt from the corpus vectors in S3
in minutes). Item key `vid` = `<corpus>|<model tag>|<chunk id>|<input hash>`;
`part` = `<corpus>|<model tag>` (`blog|v4-1024`); `v` the vector; the inline
filter values. One vector index `passages`: 1024, COSINE, `HASH` `part`,
`KEYS_ONLY` projection.

**Inline filters** (fixed at creation, 5 of 18): `year` (N), `kind` (the public
source kind, for the reference base's mixed kinds), `jamie` (1 when the
chunk passes the jamie voice filter, `VOICE_MIN_CHARS`), `family` (section
family), `ckind` (content kind). Anything else is a post-filter.

**Search.** Per corpus pool, the filter runs first, exactly, over the loaded
metadata (today's `keep`), which gives the member set. Then:

1. No filter: one search, `TopK` 100.
2. At most `FETCH_MAX` members (start at 1,000, about 7 MB): fetch their
   vectors by key and score exactly. One issue, a calendar window, a blog
   category, most topic and section filters land here.
3. More members, and the filter is made of inline values (a year, a range,
   a source kind, voice, a family or content kind list): one search per
   value combination, in parallel, merged by score, then `keep` as the final
   word. Cap the fan-out (32); past it, step 4.
4. More members, and the filter is not expressible (a broad topic, `before`
   inside its boundary year, `excludeIssues`): search, keep the members,
   and check completeness: if fewer than the depth survive and the search
   came back full, members can hide below its 100th result, so fetch the
   unseen members of that slice by key (step 2's path) up to a ceiling. Past
   the ceiling the response notes that the semantic leg is partial, never
   silently.

`candidateLimit` is `max(limit * 5, 100)`: 100 for every tool (`search_archive`
caps `limit` at 12) and up to 200 for `/retrieve` (k up to 40). Past 100,
fan out over years (step 3) to reach the depth.

**Generations.** A result counts only if its `vid` is in the loaded corpus,
so the table may hold the next and the previous corpus's vectors at once.
The deploy writes the candidate's new `vid`s before the corpus gate (an
unchanged chunk keeps its item), waits until a sample finds itself, and
after promotion deletes the `vid`s in neither the live nor the
rollback-pinned corpus (the diff of the artifacts, no scan). A model switch
writes a new `part` and removes the old one the same way.

**Artifacts.** Each corpus gains a binary vectors file beside it (float32,
with the ids and input hashes `embed_variant.py` already writes), and the
corpus JSON loses `embedding`. The pipeline's embedding cache, `similar_posts`
and the graph read the binary file; the Lambda never loads it.

**The corpus gate** keeps the exact scan as its oracle, run on the
candidate's binary vectors, and adds an index check: the meaning eval through
the index backend fails the gate when unfiltered recall@100 is below 0.97 or
reranked source MRR is more than 0.01 below the exact run.

**IAM** (an administrator apply, Jamie's go, after the v4 one):
`cloudformation.json` lets the stack's role create and update the passages
table; `runtime-boundary.json` allows `SearchVectors` on its index and
`BatchGetItem` on the table; `deploy.json` allows CI to write, delete,
describe, fetch and search it. The runtime role's statements live in the
template.

**Memory.** Without the vectors an environment holds about 320 MB less and
parses about 540 MB less JSON at a cold start. Measure with
`profile-memory.mjs`, then raise `MaxConcurrencyPerEnvironment` (`NATIVE-WEB.md`).

**Approximate, and gated.** Unfiltered the index lost no target here and the
reranker sees 100 candidates; the gate's index check keeps a worse index
from shipping. Photo descriptions (13,714) would later be one more
partition, not a new system.

## Steps (each a PR; Codex builds, this plan is the brief)

1. **The v4 switch** (`PLAN-2026-11-01-embeddings.md`), after Jamie's IAM
   apply and a day with quota for the full embed.
2. **Binary vectors.** Write `<corpus>.vectors.f32` + ids + hashes beside each
   corpus; the embed cache, `similar_posts` and the graph read them. The
   JSON keeps `embedding` for now, so nothing served changes.
3. **The table.** Template, the three IAM documents with their simulations,
   `iam_setup.py validate` clean. Jamie applies; then a deploy creates it.
4. **The writer.** The deploy writes new vectors before the gate, probes
   freshness, collects old generations after promotion. A test pins that an
   unchanged chunk is not rewritten and a rollback-pinned one survives.
5. **The backend.** SDK to 3.1161 or later; `SEMANTIC_BACKEND=memory|dynamodb`;
   the search rules above with tests per rule (a narrow filter never reaches
   the index; an incomplete slice is fetched; a stale `vid` never surfaces);
   the meaning eval runs both backends; the gate's index check. Ship with
   `memory`.
6. **Switch.** Flip to `dynamodb`, compare a week of `/health` and latency,
   then drop `embedding` from the corpus JSON, measure memory, raise the
   per-environment concurrency. MCP minor version bump at the flip.
7. **BM25** keyword leg on FTS5 (`PLAN-2026-11-01-embeddings.md`, What's left),
   its own plan.
