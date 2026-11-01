# Bake-off: a DynamoDB vector index for the Librarian (2026-11-01)

The measurements behind
[`PLAN-2026-11-01-dynamodb-vectors.md`](PLAN-2026-11-01-dynamodb-vectors.md).
Rerun with `pipeline/eval/ddb_vector_bakeoff.py` (`load`, `run`, `delete`;
`--layout year` for the second table); results land in `tmp/eval/results/`.

## The index (checked against the AWS docs, 2026-11-01)

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
  3.1161 does. boto3 1.43.51 had no `search_vectors`; the lock has 1.43.123.
- Price (us-east-1): $0.52 per GB of vector writes, $0.002 per GB of vector
  data searched, writes and storage as any table.

## The runs

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
