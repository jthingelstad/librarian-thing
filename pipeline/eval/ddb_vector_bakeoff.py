"""DynamoDB vector index bake-off: the approximate index against today's exact scan.

Writes the whole-archive vectors from embed_variant.py's --out folder, cut to
--dims and unit length, to a scratch table with a vector index (one HASH
partition per corpus, year and issue as inline filters). Then, for every
meaning-set question, it compares SearchVectors' top K with the exact cosine
top K over the same float32 vectors: unfiltered, under the question's year,
under a five-year range fanned out one search per year, and under one issue.
It reports neighbour recall, where the question's target chunk lands, latency
and the metered search bytes. Nothing it does touches the Librarian's tables.

  AWS_PROFILE=cloud-engineer uv run --locked python pipeline/eval/ddb_vector_bakeoff.py load
  AWS_PROFILE=cloud-engineer uv run --locked python pipeline/eval/ddb_vector_bakeoff.py run
  AWS_PROFILE=cloud-engineer uv run --locked python pipeline/eval/ddb_vector_bakeoff.py delete

The query vectors come from the meaning eval's Bedrock cache
(tmp/eval/bedrock-cache/embed.jsonl, the key eval-meaning.mjs writes); a
question the cache lacks is embedded once and added to it.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import random
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import boto3
import numpy as np
from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[2]
TABLE = "librarian-vector-bakeoff"
INDEX = "passages"
# corpus: one HASH partition per corpus, year and issue as inline filters.
# year: one HASH partition per corpus and year ("blog#2014", "reference#undated"),
# no inline filters; a search fans out over the years it may read.
LAYOUT = "corpus"
SMALL_SET = 500
REGION = "us-east-1"
CORPUS_FILES = {
    "weekly_thing": "corpus.json",
    "blog": "blog_corpus.json",
    "podcast": "podcast_corpus.json",
    "reference": "reference_corpus.json",
    "link": "links_corpus.json",
}


def dynamodb():
    return boto3.client("dynamodb", region_name=REGION)


def unit(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return (matrix / np.where(norms == 0, 1, norms)).astype(np.float32)


def load_vectors(folder: Path, corpus: str, dims: int) -> tuple[list[str], np.ndarray]:
    meta = json.loads((folder / "meta.json").read_text())
    ids = json.loads((folder / f"{corpus}.ids.json").read_text())
    full = np.fromfile(folder / f"{corpus}.f32", dtype=np.float32).reshape(
        len(ids), int(meta["dimensions"])
    )
    return ids, unit(full[:, :dims])


def chunk_facts(corpus_dir: Path, corpus: str) -> dict[str, dict[str, Any]]:
    """id -> the values the index and the filters read (year, issue, family)."""
    chunks = json.loads((corpus_dir / CORPUS_FILES[corpus]).read_text()).get("chunks", [])
    facts: dict[str, dict[str, int]] = {}
    for chunk in chunks:
        row: dict[str, Any] = {}
        year = chunk.get("issue_year") or str(chunk.get("publish_date") or "")[:4]
        if str(year).isdigit() and int(year) > 0:
            row["year"] = int(year)
        if str(chunk.get("issue_number") or "").isdigit():
            row["issue"] = int(chunk["issue_number"])
        if chunk.get("section_family"):
            row["family"] = str(chunk["section_family"])
        facts[str(chunk["id"])] = row
    return facts


def part_of(corpus: str, year: Any) -> str:
    if LAYOUT == "corpus":
        return corpus
    return f"{corpus}#{year or 'undated'}"


def as_numbers(vector: np.ndarray) -> list[dict[str, str]]:
    return [{"N": text} for text in np.char.mod("%.7g", vector).tolist()]


def create_table(client, dims: int) -> None:
    try:
        client.describe_table(TableName=TABLE)
        return
    except ClientError as error:
        if error.response["Error"]["Code"] != "ResourceNotFoundException":
            raise
    attributes = [("vid", "S"), ("part", "S")]
    schema = [{"AttributeName": "part", "SearchSchemaElementType": "HASH"}]
    if LAYOUT == "corpus":
        attributes += [("year", "N"), ("issue", "N")]
        schema += [
            {"AttributeName": name, "SearchSchemaElementType": "INLINE_FILTER"}
            for name in ("year", "issue")
        ]
    client.create_table(
        TableName=TABLE,
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[
            {"AttributeName": name, "AttributeType": kind} for name, kind in attributes
        ],
        KeySchema=[{"AttributeName": "vid", "KeyType": "HASH"}],
        VectorIndexes=[
            {
                "IndexName": INDEX,
                "VectorAttribute": {"AttributeName": "v"},
                "SearchSchema": schema,
                "Projection": {"ProjectionType": "KEYS_ONLY"},
                "Dimensions": dims,
                "DistanceFunction": "COSINE",
            }
        ],
        Tags=[{"Key": "purpose", "Value": "librarian vector bake-off - delete after"}],
    )
    print(f"creating {TABLE}", flush=True)


def wait_active(client) -> None:
    while True:
        table = client.describe_table(TableName=TABLE)["Table"]
        indexes = table.get("VectorIndexes") or []
        ready = table["TableStatus"] == "ACTIVE" and all(
            index.get("IndexStatus") == "ACTIVE" and not index.get("Backfilling")
            for index in indexes
        )
        if ready:
            return
        print(
            f"  table {table['TableStatus']}, index {[i.get('IndexStatus') for i in indexes]}",
            flush=True,
        )
        time.sleep(15)


def write_batch(client, items: list[dict[str, Any]]) -> int:
    requests = [{"PutRequest": {"Item": item}} for item in items]
    delay = 0.2
    while requests:
        response = client.batch_write_item(RequestItems={TABLE: requests})
        requests = response.get("UnprocessedItems", {}).get(TABLE, [])
        if requests:
            time.sleep(delay)
            delay = min(delay * 2, 5)
    return len(items)


def load(args) -> None:
    client = dynamodb()
    create_table(client, args.dims)
    wait_active(client)
    for corpus in CORPUS_FILES:
        ids, vectors = load_vectors(args.vectors, corpus, args.dims)
        facts = chunk_facts(args.corpus_dir, corpus)
        missing = sum(1 for chunk_id in ids if chunk_id not in facts)
        items = []
        for chunk_id, vector in zip(ids, vectors):
            item = {
                "vid": {"S": f"{corpus}#{chunk_id}"},
                "part": {"S": part_of(corpus, facts.get(chunk_id, {}).get("year"))},
                "v": {"L": as_numbers(vector)},
            }
            for key in ("year", "issue"):
                if key in facts.get(chunk_id, {}):
                    item[key] = {"N": str(facts[chunk_id][key])}
            items.append(item)
        batches = [items[start : start + 25] for start in range(0, len(items), 25)]
        started = time.time()
        with ThreadPoolExecutor(args.workers) as pool:
            written = sum(pool.map(lambda batch: write_batch(client, batch), batches))
        print(
            f"{corpus}: {written} written in {time.time() - started:.0f}s ({missing} with no corpus facts)",
            flush=True,
        )


class QueryVectors:
    """The meaning eval's cached query embeddings, keyed as eval-meaning.mjs keys them."""

    def __init__(self, path: Path, model: str, dims: int, input_type: str):
        self.path, self.model, self.dims, self.input_type = path, model, dims, input_type
        self.cache: dict[str, str] = {}
        if path.exists():
            for line in path.read_text().splitlines():
                row = json.loads(line)
                self.cache[row["key"]] = row["value"]
        self.hits = self.misses = 0
        self.bedrock = None

    def body(self, question: str) -> str:
        request = {
            "texts": [question],
            "input_type": self.input_type,
            "embedding_types": ["float"],
            "output_dimension": self.dims,
            "truncate": "RIGHT",
        }
        return json.dumps(request, separators=(",", ":"), ensure_ascii=False)

    def get(self, question: str) -> np.ndarray:
        body = self.body(question)
        key = hashlib.sha256(f"{self.model}\0{body}".encode()).hexdigest()
        value = self.cache.get(key)
        if value is None:
            self.misses += 1
            self.bedrock = self.bedrock or boto3.client("bedrock-runtime", region_name=REGION)
            response = self.bedrock.invoke_model(
                modelId=self.model,
                body=body,
                accept="application/json",
                contentType="application/json",
            )
            value = response["body"].read().decode()
            self.cache[key] = value
            with self.path.open("a") as handle:
                handle.write(json.dumps({"key": key, "value": value}) + "\n")
        else:
            self.hits += 1
        embeddings = json.loads(value)["embeddings"]
        vector = embeddings["float"][0] if isinstance(embeddings, dict) else embeddings[0]
        return unit(np.asarray([vector], dtype=np.float32))[0]


class Searcher:
    def __init__(self, client, top_k: int):
        self.client, self.top_k = client, top_k
        self.latency: list[float] = []
        self.capacity: list[dict[str, Any]] = []

    def search(
        self, corpus: str, query: list[dict[str, str]], part: str | None = None, **filters: int
    ) -> list[tuple[str, float]]:
        expression = ["part = :part"]
        values: dict[str, Any] = {":part": {"S": part or corpus}}
        names: dict[str, str] = {}
        for key, value in filters.items():
            names[f"#{key}"] = key
            values[f":{key}"] = {"N": str(value)}
            expression.append(f"#{key} = :{key}")
        request: dict[str, Any] = {
            "TableName": TABLE,
            "IndexName": INDEX,
            "SearchVector": query,
            "TopK": self.top_k,
            "SearchConditionExpression": " AND ".join(expression),
            "ExpressionAttributeValues": values,
            "ReturnConsumedCapacity": "TOTAL",
        }
        if names:
            request["ExpressionAttributeNames"] = names
        for attempt in range(6):
            started = time.perf_counter()
            try:
                response = self.client.search_vectors(**request)
                break
            except ClientError as error:
                if error.response["Error"]["Code"] != "ValidationException" or attempt == 5:
                    raise
                time.sleep(2**attempt)
        self.latency.append((time.perf_counter() - started) * 1000)
        if response.get("ConsumedCapacity"):
            self.capacity.append(response["ConsumedCapacity"])
        prefix = f"{corpus}#"
        return [
            (row["Item"]["vid"]["S"].removeprefix(prefix), float(row["Score"]))
            for row in response["SearchResults"]
        ]

    def fan_out(self, corpus: str, query, pool: ThreadPoolExecutor, key: str, values: list[int]):
        started = time.perf_counter()
        lists = list(pool.map(lambda value: self.search(corpus, query, **{key: value}), values))
        wall = (time.perf_counter() - started) * 1000
        merged = sorted((row for rows in lists for row in rows), key=lambda row: row[1])
        return merged[: self.top_k], wall


def exact(
    ids: list[str], vectors: np.ndarray, query: np.ndarray, keep: np.ndarray | None, top_k: int
) -> list[str]:
    scores = vectors @ query
    if keep is not None:
        scores = np.where(keep, scores, -np.inf)
    count = min(top_k, int(np.isfinite(scores).sum()))
    if count == 0:
        return []
    top = np.argpartition(-scores, count - 1)[:count]
    return [ids[i] for i in top[np.argsort(-scores[top])]]


def recall(found: list[str], truth: list[str], k: int) -> float | None:
    truth_k = truth[:k]
    if not truth_k:
        return None
    return len(set(found[:k]) & set(truth_k)) / len(truth_k)


def rank(found: list[str], target: str) -> int:
    return found.index(target) + 1 if target in found else 0


def percentile(values: list[float], share: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(share * len(ordered)))] if ordered else 0.0


def self_probe(client, corpora, sample: int) -> float:
    """Share of sampled stored vectors that find themselves first: below 1.0 the
    index is still taking writes (it is eventually consistent)."""
    searcher = Searcher(client, 1)
    found = total = 0
    for corpus, (ids, vectors, facts) in corpora.items():
        for i in random.Random(7).sample(range(len(ids)), min(sample, len(ids))):
            part = part_of(corpus, int(facts["year"][i]) or None)
            rows = searcher.search(corpus, as_numbers(vectors[i]), part=part)
            found += bool(rows and rows[0][0] == ids[i])
            total += 1
    return found / total


def run(args) -> None:
    client = dynamodb()
    corpora = {}
    for corpus in CORPUS_FILES:
        ids, vectors = load_vectors(args.vectors, corpus, args.dims)
        facts = chunk_facts(args.corpus_dir, corpus)
        years = np.array([facts.get(i, {}).get("year", 0) for i in ids])
        issues = np.array([facts.get(i, {}).get("issue", 0) for i in ids])
        corpora[corpus] = (ids, vectors, {"year": years, "issue": issues})
    probe = self_probe(client, corpora, 20)
    print(f"self probe: {probe:.0%} of sampled vectors find themselves first", flush=True)
    meta = json.loads((args.vectors / "meta.json").read_text())
    queries = QueryVectors(args.cache, meta["model"], args.dims, args.query_input_type)
    items = [item for path in args.set for item in json.loads(Path(path).read_text())["items"]]
    searcher = Searcher(client, args.top_k)
    modes: dict[str, list[dict[str, Any]]] = {
        "unfiltered": [],
        "year": [],
        "year_range_5": [],
        "issue": [],
    }
    fan_wall: list[float] = []
    with ThreadPoolExecutor(8) as pool:
        for item in items:
            corpus = item["corpus"]
            if corpus not in corpora:
                continue
            ids, vectors, facts = corpora[corpus]
            target = str(item.get("target_chunk_id") or "")
            query = queries.get(item["question"])
            query_numbers = as_numbers(query)
            position = ids.index(target) if target in ids else -1
            year = int(facts["year"][position]) if position >= 0 else 0
            issue = int(facts["issue"][position]) if position >= 0 else 0
            runs: list[tuple[str, list[str], list[str]]] = []
            truth = exact(ids, vectors, query, None, args.top_k)
            runs.append(
                ("unfiltered", [r[0] for r in searcher.search(corpus, query_numbers)], truth)
            )
            if year:
                truth = exact(ids, vectors, query, facts["year"] == year, args.top_k)
                runs.append(
                    (
                        "year",
                        [r[0] for r in searcher.search(corpus, query_numbers, year=year)],
                        truth,
                    )
                )
                span = list(range(year - 2, year + 3))
                merged, wall = searcher.fan_out(corpus, query_numbers, pool, "year", span)
                fan_wall.append(wall)
                truth = exact(ids, vectors, query, np.isin(facts["year"], span), args.top_k)
                runs.append(("year_range_5", [r[0] for r in merged], truth))
            if issue:
                truth = exact(ids, vectors, query, facts["issue"] == issue, args.top_k)
                runs.append(
                    (
                        "issue",
                        [r[0] for r in searcher.search(corpus, query_numbers, issue=issue)],
                        truth,
                    )
                )
            for mode, found, truth in runs:
                modes[mode].append(
                    {
                        "corpus": corpus,
                        "recall_10": recall(found, truth, 10),
                        "recall_100": recall(found, truth, args.top_k),
                        "exact_rank": rank(truth, target),
                        "ann_rank": rank(found, target),
                    }
                )
    summary: dict[str, Any] = {
        "questions": len(items),
        "query_cache": {"hits": queries.hits, "misses": queries.misses},
    }
    print(
        f"\n{len(items)} questions; query vectors cached {queries.hits}, embedded {queries.misses}"
    )
    print(
        f"{'mode':<14}{'n':>5}{'recall@10':>11}{'recall@100':>12}{'target@10 exact/ann':>22}{'lost':>6}"
    )
    for mode, rows in modes.items():
        if not rows:
            continue
        r10 = statistics.mean(r["recall_10"] for r in rows if r["recall_10"] is not None)
        r100 = statistics.mean(r["recall_100"] for r in rows if r["recall_100"] is not None)
        hit_exact = sum(1 for r in rows if 0 < r["exact_rank"] <= 10)
        hit_ann = sum(1 for r in rows if 0 < r["ann_rank"] <= 10)
        lost = sum(1 for r in rows if r["exact_rank"] and not r["ann_rank"])
        summary[mode] = {
            "n": len(rows),
            "recall_10": r10,
            "recall_100": r100,
            "target_at_10": [hit_exact, hit_ann],
            "lost": lost,
        }
        print(
            f"{mode:<14}{len(rows):>5}{r10:>11.3f}{r100:>12.3f}{f'{hit_exact}/{hit_ann}':>22}{lost:>6}"
        )
        by_corpus = {}
        for corpus in CORPUS_FILES:
            values = [
                r["recall_100"]
                for r in rows
                if r["corpus"] == corpus and r["recall_100"] is not None
            ]
            if values:
                by_corpus[corpus] = round(statistics.mean(values), 3)
        summary[mode]["recall_100_by_corpus"] = by_corpus
        print(f"{'':<14}recall@100 by corpus: {by_corpus}")
    latency = {
        "calls": len(searcher.latency),
        "p50_ms": percentile(searcher.latency, 0.5),
        "p95_ms": percentile(searcher.latency, 0.95),
        "fan_out_5_p50_ms": percentile(fan_wall, 0.5),
        "fan_out_5_p95_ms": percentile(fan_wall, 0.95),
    }
    summary["latency_from_this_machine"] = latency
    summary["consumed_capacity_sample"] = searcher.capacity[:3]
    print(f"\nlatency from this machine: {json.dumps({k: round(v) for k, v in latency.items()})}")
    print(f"consumed capacity, first calls: {json.dumps(searcher.capacity[:2])}")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(summary, indent=1) + "\n")
    print(f"\nwrote {args.out}")


def fetch_vectors(client, pool, corpus: str, chunk_ids: list[str]) -> dict[str, np.ndarray]:
    """The stored vectors for these chunks, by key (BatchGetItem, 100 a call)."""
    prefix = f"{corpus}#"

    def get(batch: list[str]) -> dict[str, np.ndarray]:
        found: dict[str, np.ndarray] = {}
        keys = [{"vid": {"S": prefix + chunk_id}} for chunk_id in batch]
        request: dict[str, Any] | None = {TABLE: {"Keys": keys, "ProjectionExpression": "vid, v"}}
        while request:
            response = client.batch_get_item(RequestItems=request)
            for item in response["Responses"].get(TABLE, []):
                values = [float(number["N"]) for number in item["v"]["L"]]
                found[item["vid"]["S"].removeprefix(prefix)] = np.asarray(values, dtype=np.float32)
            request = response.get("UnprocessedKeys") or None
        return found

    batches = [chunk_ids[start : start + 100] for start in range(0, len(chunk_ids), 100)]
    merged: dict[str, np.ndarray] = {}
    for found in pool.map(get, batches):
        merged.update(found)
    return merged


def filtered_search(searcher, client, pool, corpus, ids, years, keep, query, top_k):
    """Today's rule (the filter narrows the scan before the top K), without the
    vectors in memory. The filter runs exactly over the loaded metadata. A small
    set is fetched by key and scored exactly. A large one searches every year
    partition it touches, keeps only the set's members, and checks that the
    answer is complete: a partition whose 100th result still beats the merged
    K-th may hide better members, so its members are fetched and scored too."""
    members = {ids[i] for i in np.flatnonzero(keep)}
    stats = {"members": len(members), "searches": 0, "fetched": 0, "saturated": 0}

    def score_exactly(chunk_ids: list[str]) -> list[tuple[str, float]]:
        vectors = fetch_vectors(client, pool, corpus, chunk_ids)
        stats["fetched"] += len(chunk_ids)
        return [(chunk_id, 1.0 - float(vector @ query)) for chunk_id, vector in vectors.items()]

    if len(members) <= SMALL_SET:
        rows = sorted(score_exactly(sorted(members)), key=lambda row: row[1])
        return [row[0] for row in rows[:top_k]], stats
    touched = sorted({int(years[i]) for i in np.flatnonzero(keep)})
    parts = [part_of(corpus, year or None) for year in touched]
    numbers = as_numbers(query)
    lists = list(pool.map(lambda part: searcher.search(corpus, numbers, part=part), parts))
    stats["searches"] = len(parts)
    rows = {row[0]: row[1] for found in lists for row in found if row[0] in members}
    ranked = sorted(rows.items(), key=lambda row: row[1])
    threshold = ranked[top_k - 1][1] if len(ranked) >= top_k else float("inf")
    for year, found in zip(touched, lists):
        if len(found) < searcher.top_k or found[-1][1] >= threshold:
            continue
        stats["saturated"] += 1
        unseen = [ids[i] for i in np.flatnonzero(keep & (years == year)) if ids[i] not in rows]
        rows.update(score_exactly(unseen))
    ranked = sorted(rows.items(), key=lambda row: row[1])
    return [row[0] for row in ranked[:top_k]], stats


def run_years(args) -> None:
    """The year layout: every search reads whole partitions, so no inline filter
    is involved. Unfiltered and year-range searches fan out over partitions; a
    filter the index does not carry (one issue, a section family) goes through
    filtered_search."""
    client = dynamodb()
    corpora = {}
    for corpus in CORPUS_FILES:
        ids, vectors = load_vectors(args.vectors, corpus, args.dims)
        facts = chunk_facts(args.corpus_dir, corpus)
        corpora[corpus] = (
            ids,
            vectors,
            {
                "year": np.array([facts.get(i, {}).get("year", 0) for i in ids]),
                "issue": np.array([facts.get(i, {}).get("issue", 0) for i in ids]),
                "family": np.array([facts.get(i, {}).get("family", "") for i in ids]),
            },
        )
    print(f"self probe: {self_probe(client, corpora, 20):.0%} find themselves first", flush=True)
    meta = json.loads((args.vectors / "meta.json").read_text())
    queries = QueryVectors(args.cache, meta["model"], args.dims, args.query_input_type)
    items = [item for path in args.set for item in json.loads(Path(path).read_text())["items"]]
    searcher = Searcher(client, args.top_k)
    modes: dict[str, list[dict[str, Any]]] = {
        "unfiltered": [],
        "year": [],
        "year_range_5": [],
        "issue": [],
        "family": [],
    }
    walls: dict[str, list[float]] = collections.defaultdict(list)
    work: dict[str, list[dict[str, int]]] = collections.defaultdict(list)
    with ThreadPoolExecutor(16) as pool:
        for item in items:
            corpus = item["corpus"]
            ids, vectors, facts = corpora[corpus]
            target = str(item.get("target_chunk_id") or "")
            query = queries.get(item["question"])
            numbers = as_numbers(query)
            position = ids.index(target) if target in ids else -1
            year = int(facts["year"][position]) if position >= 0 else 0
            all_years = sorted({int(y) for y in facts["year"]})
            runs = []

            def fan(years_read: list[int], mode: str) -> list[str]:
                started = time.perf_counter()
                parts = [part_of(corpus, y or None) for y in years_read]
                lists = pool.map(lambda part: searcher.search(corpus, numbers, part=part), parts)
                merged = sorted((row for rows in lists for row in rows), key=lambda row: row[1])
                walls[mode].append((time.perf_counter() - started) * 1000)
                return [row[0] for row in merged[: args.top_k]]

            runs.append(("unfiltered", fan(all_years, "unfiltered"), None))
            if year:
                runs.append(("year", fan([year], "year"), facts["year"] == year))
                span = [y for y in range(year - 2, year + 3) if y in all_years]
                runs.append(
                    ("year_range_5", fan(span, "year_range_5"), np.isin(facts["year"], span))
                )
            narrow = []
            if position >= 0 and facts["issue"][position]:
                narrow.append(("issue", facts["issue"] == facts["issue"][position]))
            if position >= 0 and facts["family"][position]:
                narrow.append(("family", facts["family"] == facts["family"][position]))
            for mode, keep in narrow:
                started = time.perf_counter()
                found, stats = filtered_search(
                    searcher, client, pool, corpus, ids, facts["year"], keep, query, args.top_k
                )
                walls[mode].append((time.perf_counter() - started) * 1000)
                work[mode].append(stats)
                runs.append((mode, found, keep))
            for mode, found, keep in runs:
                truth = exact(ids, vectors, query, keep, args.top_k)
                modes[mode].append(
                    {
                        "corpus": corpus,
                        "recall_10": recall(found, truth, 10),
                        "recall_100": recall(found, truth, args.top_k),
                        "exact_rank": rank(truth, target),
                        "ann_rank": rank(found, target),
                    }
                )
    summary: dict[str, Any] = {"layout": "year", "questions": len(items)}
    print(f"\n{len(items)} questions, year layout")
    print(
        f"{'mode':<14}{'n':>5}{'recall@10':>11}{'recall@100':>12}{'target@10 exact/ann':>22}{'lost':>6}{'p50 ms':>8}{'p95 ms':>8}"
    )
    for mode, rows in modes.items():
        if not rows:
            continue
        r10 = statistics.mean(r["recall_10"] for r in rows if r["recall_10"] is not None)
        r100 = statistics.mean(r["recall_100"] for r in rows if r["recall_100"] is not None)
        hit_exact = sum(1 for r in rows if 0 < r["exact_rank"] <= 10)
        hit_ann = sum(1 for r in rows if 0 < r["ann_rank"] <= 10)
        lost = sum(1 for r in rows if r["exact_rank"] and not r["ann_rank"])
        p50, p95 = percentile(walls[mode], 0.5), percentile(walls[mode], 0.95)
        summary[mode] = {
            "n": len(rows),
            "recall_10": r10,
            "recall_100": r100,
            "target_at_10": [hit_exact, hit_ann],
            "lost": lost,
            "wall_p50_ms": p50,
            "wall_p95_ms": p95,
        }
        print(
            f"{mode:<14}{len(rows):>5}{r10:>11.3f}{r100:>12.3f}{f'{hit_exact}/{hit_ann}':>22}{lost:>6}{p50:>8.0f}{p95:>8.0f}"
        )
    for mode, stats in work.items():
        line = {
            "fetch_path": sum(1 for s in stats if s["searches"] == 0),
            "index_path": sum(1 for s in stats if s["searches"]),
            "saturated_partitions": sum(s["saturated"] for s in stats),
            "vectors_fetched_mean": round(statistics.mean(s["fetched"] for s in stats)),
            "members_median": statistics.median(s["members"] for s in stats),
        }
        summary[mode]["work"] = line
        print(f"  {mode} work: {line}")
    calls = len(searcher.latency)
    print(
        f"  single search from this machine: p50 {percentile(searcher.latency, 0.5):.0f} ms, p95 {percentile(searcher.latency, 0.95):.0f} ms over {calls} calls"
    )
    summary["search_latency_ms"] = {
        "p50": percentile(searcher.latency, 0.5),
        "p95": percentile(searcher.latency, 0.95),
        "calls": calls,
    }
    bytes_searched = [c.get("VectorSearchRequestBytes", 0) for c in searcher.capacity]
    if bytes_searched:
        summary["search_bytes_mean"] = statistics.mean(bytes_searched)
        print(f"  metered bytes per search: mean {statistics.mean(bytes_searched):,.0f}")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(summary, indent=1) + "\n")
    print(f"\nwrote {args.out}")


def delete(args) -> None:
    dynamodb().delete_table(TableName=TABLE)
    print(f"deleting {TABLE}")


def main(argv: list[str] | None = None) -> None:
    global TABLE, LAYOUT
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("command", choices=["load", "run", "delete"])
    parser.add_argument("--table", default=TABLE)
    parser.add_argument("--layout", choices=["corpus", "year"], default="corpus")
    parser.add_argument("--vectors", type=Path, default=ROOT / "tmp/eval/vectors/v4-live")
    parser.add_argument("--corpus-dir", type=Path, default=ROOT / "tmp/live")
    parser.add_argument("--dims", type=int, default=1024)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--top-k", type=int, default=100)
    parser.add_argument("--set", action="append", default=None)
    parser.add_argument("--cache", type=Path, default=ROOT / "tmp/eval/bedrock-cache/embed.jsonl")
    parser.add_argument("--query-input-type", default="search_document")
    parser.add_argument("--out", type=Path, default=ROOT / "tmp/eval/results/ddb-bakeoff.json")
    args = parser.parse_args(argv)
    args.set = args.set or [str(ROOT / "apps/librarian/lambda/eval/meaning-set.json")]
    TABLE, LAYOUT = args.table, args.layout
    runner = run_years if LAYOUT == "year" else run
    {"load": load, "run": runner, "delete": delete}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
