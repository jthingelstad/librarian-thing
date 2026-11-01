# Plan: the semantic leg on a DynamoDB vector index (2026-11-01)

Jamie, 2026-11-01: "I think DynamoDB vector index is going to be the way to
go… OpenSearch doesn't work at our scale, and S3 Vectors had issues. Lets move
forward with that path."

This follows `PLAN-2026-11-01-embeddings.md` (Embed v4 at 1024, the query
embedded as a document). The model switch ships first and on its own, so its
effect is measured alone; the table is then only ever written with v4.

## What changes

Today every Librarian environment loads about 675 MB of corpus JSON, 80% of
it vectors, holds them as float64 (about 320 MB resident), and scans every
corpus exactly on each question. After: the vectors live in a DynamoDB table
with a vector index, the Lambda loads the corpora without them, and the
semantic leg asks the index. The lexical leg, the fusion, the rerank and the
`/retrieve` contract do not change.

## What the index is (checked against the AWS docs, 2026-11-01)

- `SearchVectors` on `arn:...:table/<table>/index/<index>`: `TopK` 1 to 100,
  no pagination, approximate (ANN), eventually consistent; results carry the
  key, the projected attributes and a `Score` (COSINE: 0 is identical).
- One `HASH` partition key per index (every search names one value) and up
  to 18 inline filters. **Filters are equality only**: no `IN`, no range, no
  `<>`. Several values mean one search per value.
- A vector is an `L` of `N` on the item, stored at float32; a wrong length
  is refused. The index configuration (dimensions, distance, schema,
  projection) is immutable; up to 5 indexes per table, one created or
  deleted per stack operation (`AWS::DynamoDB::Table` `VectorIndexes`).
  On-demand tables only.
- IAM: `dynamodb:SearchVectors` on the index ARN; writes are the usual
  `PutItem`/`BatchWriteItem`. No fine-grained conditions apply to searches.
- SDKs: `@aws-sdk/client-dynamodb` 3.1090 (ours) has no `SearchVectorsCommand`;
  3.1161 does. boto3 1.43.51 had no `search_vectors`; this PR locks 1.43.123.
- Price (us-east-1): $0.52 per GB of vector writes, $0.002 per GB of vector
  data searched, writes and storage as any table.

## The bake-off (`pipeline/eval/ddb_vector_bakeoff.py`)

The whole archive (38,866 vectors: v4 at 1024, unit length) in a scratch
table, the 266 public meaning-set questions, and for each one the index's top
100 against the exact cosine top 100 over the same float32 vectors. "Lost":
the question's target chunk is in the exact top 100 and not in the index's.
Two runs agreed; the second, on a settled index, is shown.

One partition per corpus, year and issue as inline filters:

| Search | Questions | Recall@10 | Recall@100 | Target in top 10, exact / index | Lost |
| --- | --- | --- | --- | --- | --- |
| Unfiltered | 266 | 0.994 | 0.989 | 178 / 178 | 0 |
| One year (inline filter) | 231 | 0.984 | 0.981 | 188 / 182 | 6 |
| Five years, one search per year | 231 | 0.989 | 0.987 | 170 / 167 | 4 |
| One issue (inline filter) | 77 | 0.727 | 0.725 | 77 / 58 | 19 |
| One issue, vectors fetched by key (*) | 77 | 1.000 | 1.000 | 77 / 77 | 0 |

(*) Measured on the second table below; fetching by key does not depend
on the layout.

- **Unfiltered, the index is as good as the scan** where it counts: no
  target lost, every top-10 target still in the top 10.
- **An inline filter is only as good as it is wide.** A year (a tenth of a
  corpus or less) loses 2 to 3% of targets; an issue (27 chunks, the median, of 9,947)
  loses a quarter. A narrow filter must not go through the index.
- **A narrow set is cheap to score exactly.** The Lambda already knows every
  chunk's metadata, so it knows the filtered set; fetching those vectors by
  key (`BatchGetItem`, 100 a call) and scoring them is exact, 131 ms median
  from this Mac for an issue.
- **Partitioning by year is worse,** not better: a second table with one
  partition per corpus and year scored 0.977 unfiltered (fanned out over
  every year) and 0.963 for one year. Small partitions do not make the index
  exact. One partition per corpus it is.
- **Latency** from this Mac (the network to us-east-1 included): one search
  49 ms median, 62 ms p95; five in parallel 60 / 71 ms. In region it is less.
- **Writes and freshness:** 38,866 vectors written in about three minutes
  (8 workers); on the settled index every sampled vector found itself first
  (97% on the per-year table).
- **Cost:** about 63 KB metered per search, so a million searches is about
  $0.13. The whole archive written once is about $0.27 (the item writes
  plus the vector bytes). Storage fits the account's free 25 GB. The
  bake-off cost under $1 and its tables are deleted.

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

## Open

- **ANN is approximate.** Unfiltered it lost no target here, and the
  reranker sees 100 candidates; the gate's index check is what keeps a worse
  index from shipping. The exact scan stays in the pipeline as the oracle.
- **Photo descriptions** (13,714, the embeddings plan's recommendation) would
  be a sixth partition, not a new system.
