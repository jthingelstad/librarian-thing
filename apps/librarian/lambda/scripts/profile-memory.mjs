// Replay downloaded published corpus artifacts with SDK fakes. No AWS or model calls.
// node scripts/profile-memory.mjs <directory> [parallel=8]
// Every client a request could write or spend through refuses here, so this
// can never touch a reader record, a model or the network.
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import v8 from 'node:v8';
import { s3, bedrock, bedrockAgentRuntime, dynamodb } from '../dist/shared/aws-clients.mjs';
import { loadCorpus, loadGraph, retrieve } from '../dist/shared/retrieval.mjs';
import { ARCHIVE_TOOLS } from '../dist/shared/archive-tools.mjs';
const directory = process.argv[2];
if (!directory) throw new Error('Supply a directory with the *.json.gz artifacts');
const parallel = Number(process.argv[3] || 8);
if (!Number.isInteger(parallel) || parallel < 1) throw new Error('parallel must be a positive whole number');
process.env.CORPUS_BUCKET = 'fixture';
process.env.CORPUS_KEY = 'corpus.json';
process.env.BLOG_CORPUS_KEY = 'blog_corpus.json';
process.env.PODCAST_CORPUS_KEY = 'podcast_corpus.json';
process.env.REFERENCE_CORPUS_KEY = 'reference_corpus.json';
process.env.LINKS_CORPUS_KEY = 'links_corpus.json';
process.env.GRAPH_KEY = 'graph.json';
// The served keyword leg. Without this object retrieval scans TF-IDF instead.
if (existsSync(resolve(directory, 'keyword_index.db.gz'))) process.env.KEYWORD_INDEX_KEY = 'keyword_index.db';
const reads = {};
s3.send = async ({ input }) => {
  reads[input.Key] = (reads[input.Key] || 0) + 1;
  return { Body: createReadStream(resolve(directory, input.Key + '.gz')) };
};
// The live embed's p50 (186 ms) is a real wait the requests interleave across.
// The vector comes from the query, so different questions rank differently.
const EMBED_WAIT_MS = 186;
bedrock.send = async ({ input }) => {
  await sleep(EMBED_WAIT_MS);
  const digest = createHash('sha256').update(String(input.body)).digest();
  const embedding = Array.from({ length: 1024 }, (_, i) => digest[i % digest.length] - 127.5 + (i % 7));
  return { body: Buffer.from(JSON.stringify({ embeddings: [embedding] })) };
};
const refuse = (name) => () => {
  throw new Error(`The profile must not call ${name}`);
};
// retrieve() keeps the fused order when a rerank fails, so tools still answer.
bedrockAgentRuntime.send = refuse('the reranker');
dynamodb.send = refuse('DynamoDB');
globalThis.fetch = refuse('the network');
const stall = monitorEventLoopDelay({ resolution: 5 });
stall.enable();
const began = performance.now();
const report = (phase, fields = {}) =>
  console.log(
    JSON.stringify({
      phase,
      parallel,
      elapsed_ms: Math.round(performance.now() - began),
      memory: process.memoryUsage(),
      max_rss_kib: process.resourceUsage().maxRSS,
      heap_limit: v8.getHeapStatistics().heap_size_limit,
      reads,
      ...fields
    })
  );
const assertSingleReads = () => {
  if (Object.values(reads).some((count) => count !== 1)) throw new Error('Concurrent loading duplicated an S3 read');
};
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// At most `limit` calls in flight, in order; each result with its wall clock.
async function inFlight(items, limit, call) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const at = next++;
        // A real request arrives on its own turn of the event loop, and the
        // wait for that turn is part of what its caller feels.
        const start = performance.now();
        await new Promise(setImmediate);
        const value = await call(items[at]);
        results[at] = { value, ms: performance.now() - start };
      }
    })
  );
  return results;
}
const percentile = (values, share) =>
  Math.round([...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * share))]);
const latency = (results) => ({
  requests: results.length,
  p50_ms: percentile(
    results.map((r) => r.ms),
    0.5
  ),
  p95_ms: percentile(
    results.map((r) => r.ms),
    0.95
  ),
  max_ms: Math.round(Math.max(...results.map((r) => r.ms)))
});
// One measured stretch: latency plus the longest the event loop stood still,
// which is how long every other request in the environment waited.
async function measured(items, limit, call) {
  // The monitor records a stall when its timer next fires: let it, both sides.
  await sleep(50);
  stall.reset();
  const results = await inFlight(items, limit, call);
  await sleep(50);
  return { results, latency: latency(results), longest_stall_ms: Math.round(stall.max / 1e6) };
}

report('start');
await Promise.all(
  Array.from({ length: parallel }, () =>
    Promise.all(['weekly_thing', 'blog', 'podcast', 'reference'].map((kind) => loadCorpus(kind)))
  )
);
await loadGraph();
report('loaded', { longest_stall_ms: Math.round(stall.max / 1e6) });
const results = await Promise.all(
  Array.from({ length: parallel }, () =>
    retrieve('Minnebar technology community', 8, { scope: 'all' }, { rerank: false })
  )
);
assertSingleReads();
const hashes = results.map(hash);
if (new Set(hashes).size !== 1) throw new Error('Parallel retrieval results differ');
report('parallel_indexed');
global.gc?.();
report('gc');
// The links corpus loads only when a request names source kind link: the
// phases above never read it. A link retrieval loads and indexes it on top.
if (existsSync(resolve(directory, 'links_corpus.json.gz'))) {
  const linkStart = performance.now();
  const linkResults = await Promise.all(
    Array.from({ length: parallel }, () =>
      retrieve('Minnebar technology community', 8, { scope: 'all', sourceKinds: ['link'] }, { rerank: false })
    )
  );
  assertSingleReads();
  const linkHashes = linkResults.map(hash);
  if (new Set(linkHashes).size !== 1) throw new Error('Parallel link retrieval results differ');
  if (!linkResults[0].some((row) => row.source_kind === 'link')) throw new Error('A link retrieval found no link');
  console.log(JSON.stringify({ phase: 'links_load_ms', ms: Math.round(performance.now() - linkStart) }));
  report('links_indexed');
  global.gc?.();
  report('links_gc');
}

// Latency, warm: the same questions one at a time, then `parallel` in flight.
// A question must get the same answer however many others run beside it.
const questions = JSON.parse(readFileSync(new URL('./bench-questions.json', import.meta.url), 'utf8'));
const ask = (question) => retrieve(question, 8, { scope: 'all' }, { rerank: false });
const alone = await measured(questions, 1, ask);
report('latency_one_at_a_time', { latency: alone.latency, longest_stall_ms: alone.longest_stall_ms });
const shared = await measured(questions, parallel, ask);
questions.forEach((question, at) => {
  if (hash(alone.results[at].value) !== hash(shared.results[at].value)) {
    throw new Error(`Parallel requests changed the answer to: ${question}`);
  }
});
report('latency_parallel', { latency: shared.latency, longest_stall_ms: shared.longest_stall_ms });

// The tools build their own indexes over the corpora (records, links, photos,
// topics), which retrieval never touches: run every read-only tool, so the
// peak holds those too. fetch_page reads live pages and stays out.
const TOOL_CALLS = [
  ['search_faq', { query: 'membership' }],
  ['search_archive', { query: 'the open web and RSS' }],
  ['search_archive', { query: 'the open web and RSS', source_kind: 'link' }],
  ['get_source', { id: 'wt-351' }],
  ['find_links', { domain: 'github.com' }],
  ['list_content', { topic: 'RSS' }],
  ['corpus_stats', {}],
  ['corpus_stats', { source_kind: 'link' }],
  ['list_topics', {}],
  ['latest_content', {}],
  ['quote_search', { phrase: 'open web' }],
  ['archive_lens', { topic: 'RSS' }],
  ['compare_eras', { topic: 'RSS', year_a: 2015, year_b: 2024 }],
  ['source_neighborhood', { id: 'wt-351' }],
  ['archive_gems', {}],
  ['find_evidence', { claims: ['Jamie writes about the open web'] }],
  ['media_search', { query: 'minnebar' }],
  ['currently_history', {}],
  ['top_references', {}],
  ['on_this_day', { date: '11-04' }]
];
const callTool = ([name, input]) => ARCHIVE_TOOLS[name](input, { scope: 'all' });
const coldTools = await measured(TOOL_CALLS, parallel, callTool);
const failed = coldTools.results.flatMap((result, at) =>
  result.value?.error ? [`${TOOL_CALLS[at][0]}: ${result.value.error}`] : []
);
if (failed.length) throw new Error(`A profile tool call failed:\n${failed.join('\n')}`);
report('tools_cold', { latency: coldTools.latency, longest_stall_ms: coldTools.longest_stall_ms });
const toolsAlone = await measured(TOOL_CALLS, 1, callTool);
const toolsShared = await measured(TOOL_CALLS, parallel, callTool);
TOOL_CALLS.forEach(([name], at) => {
  // archive_gems draws at random, by design.
  if (name === 'archive_gems') return;
  if (hash(toolsAlone.results[at].value) !== hash(toolsShared.results[at].value)) {
    throw new Error(`Parallel requests changed what ${name} answers`);
  }
});
const slowest = toolsAlone.results
  .map((result, at) => [TOOL_CALLS[at][0], Math.round(result.ms)])
  .sort((a, b) => b[1] - a[1])
  .slice(0, 4);
report('tools_warm', {
  alone: toolsAlone.latency,
  alone_longest_stall_ms: toolsAlone.longest_stall_ms,
  shared: toolsShared.latency,
  shared_longest_stall_ms: toolsShared.longest_stall_ms,
  slowest_alone: slowest
});
assertSingleReads();
