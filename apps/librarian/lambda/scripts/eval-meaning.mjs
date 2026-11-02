#!/usr/bin/env node
/**
 * Meaning-retrieval eval: recall@k and MRR per corpus for the lexical leg
 * alone, the semantic leg alone, the two fused, and fused then reranked,
 * over the questions pipeline/eval/build_meaning_set.py writes.
 *
 * It runs the real retrieve() from dist over corpora read from a folder, so
 * a candidate (another model, another chunking) is measured exactly as the
 * Lambda would serve it. Bedrock is called through a cache: the query
 * embeddings and rerank answers live in tmp/eval/bedrock-cache/, keyed on
 * the whole request, so a rerun costs nothing and a changed request (a new
 * model, new candidates for the reranker) is the only thing that calls out.
 *
 *   AWS_PROFILE=cloud-engineer AWS_REGION=us-east-1 \
 *   node --max-old-space-size=12288 scripts/eval-meaning.mjs \
 *     --corpus-dir ../../../tmp/live --label v3-live \
 *     --set eval/meaning-set.json --set ../../../tmp/eval/meaning-set-private.json
 *
 * A hit is judged two ways, both of which survive re-chunking: the source
 * (the issue, post, page, link, document, thing or episode the question was
 * written from) and the span (a returned chunk holds the answer quote).
 * The reranked mode also records where the source sat in the pool the
 * reranker was given (pool rank 0: it never reached the reranker).
 *
 * Another model's vectors, from pipeline/eval/embed_variant.py, replace the
 * corpora's own with --vectors <dir>; --dims N keeps their first N values
 * (Embed v4's shorter vectors are prefixes of its 1536) and --int8 uses its
 * int8 vectors. Each corpus then records that model and length, so the
 * query is embedded to match, as the Lambda would. --fusion
 * semanticWeight=1,lexicalWeight=0.5,poolSize=200 measures another fusion,
 * and --query-input-type search_document another query input type.
 * --lexical fts5:tokenizer=porter,weights=3:2:1,query=phrase replaces the
 * TF-IDF keyword leg with SQLite full-text search (scripts/fts5-lexical.mjs);
 * the semantic leg, the fusion and the rerank are unchanged.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..', '..');

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function flags(name) {
  const values = [];
  process.argv.forEach((arg, index) => {
    if (arg === `--${name}`) values.push(process.argv[index + 1]);
  });
  return values;
}

const corpusDir = path.resolve(flag('corpus-dir', path.join(repo, 'tmp', 'live')));
const label = flag('label', path.basename(corpusDir));
const setPaths = flags('set').length ? flags('set') : [path.join(here, '..', 'eval', 'meaning-set.json')];
const outPath = path.resolve(flag('out', path.join(repo, 'tmp', 'eval', 'results', `${label}.json`)));
const cacheDir = path.resolve(flag('cache-dir', path.join(repo, 'tmp', 'eval', 'bedrock-cache')));
const modes = (flag('modes', 'lexical,semantic,fused,reranked') || '').split(',').filter(Boolean);
const scopeOverride = flag('scope', '');
const limit = Number(flag('limit', '20'));
const concurrency = Number(flag('concurrency', '6'));
const distDir = process.env.EVAL_DIST_DIR || path.join(here, '..', 'dist');
const vectorsDir = flag('vectors', '');
const vectorDims = Number(flag('dims', '0'));
const useInt8 = process.argv.includes('--int8');
// The query's input type. The Lambda sends search_query on v3 and
// search_document on v4 (2026-11-01); another one is rewritten into the
// request here.
const queryInputType = flag('query-input-type', '');
// Which keyword engine the lexical leg runs: tf-idf (the Lambda's) or
// fts5:<options>.
const lexicalSpec = flag('lexical', 'tf-idf');
const fusion = Object.fromEntries(
  (flag('fusion', '') || '')
    .split(',')
    .filter(Boolean)
    .map((pair) => {
      const [key, value] = pair.split('=');
      return [key, Number(value)];
    })
);

const { bedrock, bedrockAgentRuntime } = await import(path.join(distDir, 'shared/aws-clients.mjs'));
const { primeCorpusCachesForTests, retrieve } = await import(path.join(distDir, 'shared/retrieval.mjs'));
let lexicalEngine;
if (lexicalSpec.startsWith('fts5')) {
  const { fts5Engine } = await import(path.join(here, 'fts5-lexical.mjs'));
  lexicalEngine = fts5Engine(lexicalSpec.slice('fts5'.length).replace(/^:/, ''));
} else if (lexicalSpec !== 'tf-idf') {
  console.error(`eval-meaning: --lexical ${lexicalSpec} is not tf-idf or fts5:<options>`);
  process.exit(2);
}

// --- Bedrock, cached ------------------------------------------------------
mkdirSync(cacheDir, { recursive: true });
function openCache(name) {
  const file = path.join(cacheDir, `${name}.jsonl`);
  const entries = new Map();
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      entries.set(row.key, row.value);
    }
  }
  return {
    get: (key) => entries.get(key),
    set: (key, value) => {
      entries.set(key, value);
      appendFileSync(file, `${JSON.stringify({ key, value })}\n`);
    }
  };
}
const embedCache = openCache('embed');
const rerankCache = openCache('rerank');
const calls = { embed: 0, embed_cached: 0, rerank: 0, rerank_cached: 0, rerank_failed: 0 };
const sha = (text) => createHash('sha256').update(text).digest('hex');

const realBedrockSend = bedrock.send.bind(bedrock);
bedrock.send = async (command) => {
  if (queryInputType) {
    const body = JSON.parse(command.input.body);
    command.input.body = JSON.stringify({ ...body, input_type: queryInputType });
  }
  const key = sha(`${command.input.modelId}\0${command.input.body}`);
  let value = embedCache.get(key);
  if (value) calls.embed_cached += 1;
  else {
    const response = await realBedrockSend(command);
    value = new TextDecoder().decode(response.body);
    embedCache.set(key, value);
    calls.embed += 1;
  }
  return { body: new TextEncoder().encode(value) };
};

const realRerankSend = bedrockAgentRuntime.send.bind(bedrockAgentRuntime);
bedrockAgentRuntime.send = async (command) => {
  const key = sha(JSON.stringify(command.input));
  let value = rerankCache.get(key);
  if (value) calls.rerank_cached += 1;
  else {
    try {
      const response = await realRerankSend(command);
      value = { results: response.results };
    } catch (error) {
      calls.rerank_failed += 1;
      throw error;
    }
    rerankCache.set(key, value);
    calls.rerank += 1;
  }
  return value;
};

// --- corpora --------------------------------------------------------------
const CORPUS_FILES = {
  weekly_thing: 'corpus.json',
  blog: 'blog_corpus.json',
  podcast: 'podcast_corpus.json',
  reference: 'reference_corpus.json',
  link: 'links_corpus.json'
};
function readJson(file) {
  const bytes = readFileSync(file);
  return JSON.parse(
    bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8')
  );
}
// Each chunk's vector from another model's run, matched by chunk id. A
// chunk the run does not hold is a stop: the comparison would be unfair. A
// corpus the run left out (--only) keeps its own vectors, and says so.
function swapVectors(kind, corpus) {
  const dir = path.resolve(vectorsDir);
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  if (!existsSync(path.join(dir, `${kind}.ids.json`))) {
    console.error(`eval-meaning: ${kind} keeps its own vectors (${corpus.embedding_model}); ${dir} has none`);
    return;
  }
  const ids = JSON.parse(readFileSync(path.join(dir, `${kind}.ids.json`), 'utf8'));
  const full = Number(meta.dimensions);
  const dims = vectorDims || full;
  if (dims > full) throw new Error(`--dims ${dims} is longer than the run's ${full}`);
  const bytes = readFileSync(path.join(dir, `${kind}.${useInt8 ? 'i8' : 'f32'}`));
  const values = useInt8
    ? new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length)
    : new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  if (values.length !== ids.length * full) throw new Error(`${kind}: ${values.length} values for ${ids.length} ids`);
  const row = new Map(ids.map((id, index) => [id, index]));
  for (const chunk of corpus.chunks || []) {
    const index = row.get(String(chunk.id));
    if (index === undefined) throw new Error(`${kind}: no vector for ${chunk.id}`);
    // Float32 holds the eval's corpora in memory; cosine reads any array.
    chunk.embedding = Float32Array.from(values.subarray(index * full, index * full + dims));
  }
  corpus.embedding_model = meta.model;
  corpus.embedding_dimensions = dims;
}

const corpora = {};
const signatures = {};
for (const [kind, name] of Object.entries(CORPUS_FILES)) {
  const file = path.join(corpusDir, name);
  if (!existsSync(file)) {
    console.error(`eval-meaning: ${file} is missing`);
    process.exit(2);
  }
  corpora[kind] = readJson(file);
  if (vectorsDir) swapVectors(kind, corpora[kind]);
  signatures[kind] = {
    model: corpora[kind].embedding_model,
    dimensions: corpora[kind].embedding_dimensions,
    chunks: corpora[kind].chunks?.length || 0
  };
}
primeCorpusCachesForTests(corpora);
// A global keyword index sees every corpus's rows before the first question.
if (lexicalEngine?.options?.merge === 'global') {
  lexicalEngine.collect(true);
  await retrieve(
    'collect',
    1,
    { scope: 'all', sourceKinds: Object.keys(CORPUS_FILES).filter((kind) => kind !== 'reference') },
    { rerank: false, engines: ['lexical'], lexicalEngine }
  );
  lexicalEngine.collect(false);
}

// --- judging --------------------------------------------------------------
// The generator's source_key and normalize, written again here (an oracle
// shares no code with what it checks, and these are a few lines).
function sourceOf(row) {
  const kind = row.source_kind;
  if (kind === 'document') return `document:${row.doc_id}`;
  if (kind === 'link') return `link:${row.link_id}`;
  if (kind === 'thing') return `thing:${row.thing_id}`;
  if (kind === 'faq' || kind === 'site_page') return `${kind}:${row.url}:${row.subject}`;
  if (kind === 'blog') return row.page_id ? `page:${row.page_id}` : `blog:${row.microblog_id || row.url}`;
  if (kind === 'podcast') return `podcast:${row.episode_number || row.url}`;
  return `weekly_thing:${row.issue_number}`;
}
function normalize(text) {
  return String(text || '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const MODE_OPTS = {
  lexical: { rerank: false, engines: ['lexical'], lexicalEngine },
  semantic: { rerank: false, engines: ['semantic'] },
  fused: { rerank: false, fusion, lexicalEngine },
  reranked: { fusion, lexicalEngine }
};

async function judge(item, mode) {
  const filters = { ...item.run, ...(scopeOverride ? { scope: scopeOverride } : {}) };
  let pool = [];
  const opts = { ...MODE_OPTS[mode], inspectPool: (rows) => (pool = rows) };
  const rows = await retrieve(item.question, limit, filters, opts);
  const quote = normalize(item.answer_quote);
  let source = 0;
  let span = 0;
  rows.forEach((row, index) => {
    if (!source && sourceOf(row) === item.target_source) source = index + 1;
    if (!span && normalize(row.text).includes(quote)) span = index + 1;
  });
  const result = { source, span, top: rows.slice(0, 3).map(sourceOf) };
  if (mode === 'reranked') {
    result.pool = pool.findIndex((row) => sourceOf(row) === item.target_source) + 1;
    result.pool_size = pool.length;
  }
  return result;
}

const items = setPaths.flatMap((file) => {
  const resolved = path.resolve(file);
  if (!existsSync(resolved)) {
    console.error(`eval-meaning: no set at ${resolved}; skipped`);
    return [];
  }
  return readJson(resolved).items;
});

// Run each question in every mode, a few at a time.
const results = [];
let next = 0;
async function worker() {
  while (next < items.length) {
    const item = items[next++];
    const ranks = {};
    for (const mode of modes) {
      try {
        ranks[mode] = await judge(item, mode);
      } catch (error) {
        ranks[mode] = { source: 0, span: 0, error: String(error?.message || error).slice(0, 200) };
      }
    }
    results.push({ id: item.id, corpus: item.corpus, kind: item.kind, ranks });
  }
}
const quietLog = console.log;
console.log = () => {};
await Promise.all(Array.from({ length: concurrency }, worker));
console.log = quietLog;
results.sort((a, b) => a.id.localeCompare(b.id));

// --- metrics --------------------------------------------------------------
const KS = [1, 5, 10, 20];
function metrics(rows, mode, level) {
  const ranks = rows.map((row) => row.ranks[mode]?.[level] || 0);
  const n = ranks.length || 1;
  const out = { n: ranks.length };
  for (const k of KS) out[`r@${k}`] = ranks.filter((rank) => rank && rank <= k).length / n;
  out.mrr = ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / n;
  return out;
}
function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = key(row);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
}

const summary = {};
const corpusGroups = groupBy(results, (row) => row.corpus);
corpusGroups.set('ALL', results);
for (const [corpus, rows] of corpusGroups) {
  const kinds = groupBy(rows, (row) => row.kind);
  kinds.set('all', rows);
  summary[corpus] = {};
  for (const [kind, kindRows] of kinds) {
    summary[corpus][kind] = {};
    for (const mode of modes) {
      summary[corpus][kind][mode] = {
        source: metrics(kindRows, mode, 'source'),
        span: metrics(kindRows, mode, 'span')
      };
      if (mode === 'reranked') {
        const reached = kindRows.filter((row) => row.ranks.reranked?.pool > 0).length;
        summary[corpus][kind][mode].pool_recall = reached / (kindRows.length || 1);
      }
    }
  }
}

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  `${JSON.stringify({ label, corpus_dir: corpusDir, lexical: lexicalSpec, vectors: vectorsDir || null, int8: useInt8, query_input_type: queryInputType || 'as the Lambda sends it', fusion, signatures, limit, scope: scopeOverride || 'per item', modes, calls, summary, results }, null, 1)}\n`
);

const pct = (value) => `${Math.round(value * 100)}`.padStart(3);
console.log(`\n${label}  (${results.length} questions, limit ${limit}, scope ${scopeOverride || 'per item'})`);
console.log(
  Object.entries(signatures)
    .map(([kind, s]) => `${kind}: ${s.model}/${s.dimensions}`)
    .join('  ')
);
if (Object.keys(fusion).length) console.log('fusion:', fusion);
console.log('lexical:', lexicalSpec);
console.log(
  'corpus        kind        mode       | source r@1 r@5 r@10 r@20  mrr | span r@1 r@5 r@10 r@20  mrr |  n | pool'
);
for (const [corpus, kinds] of Object.entries(summary)) {
  for (const [kind, byMode] of Object.entries(kinds)) {
    for (const mode of modes) {
      const { source, span } = byMode[mode];
      console.log(
        `${corpus.padEnd(13)} ${kind.padEnd(11)} ${mode.padEnd(10)} |       ${pct(source['r@1'])} ${pct(source['r@5'])}  ${pct(source['r@10'])}  ${pct(source['r@20'])} ${source.mrr.toFixed(2)} |     ${pct(span['r@1'])} ${pct(span['r@5'])}  ${pct(span['r@10'])}  ${pct(span['r@20'])} ${span.mrr.toFixed(2)} | ${String(source.n).padStart(3)} | ${byMode[mode].pool_recall === undefined ? '' : pct(byMode[mode].pool_recall)}`
      );
    }
  }
}
console.log('bedrock calls:', calls);
console.log(`wrote ${outPath}`);
