import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { RerankCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import type { RerankSource } from '@aws-sdk/client-bedrock-agent-runtime';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync } from 'node:zlib';
import { bedrock, bedrockAgentRuntime, embeddingModel, rerankModel, s3 } from './aws-clients.mjs';
import { errorFields, logEvent as sharedLogEvent, truthyEnv } from './logging.mjs';
import { normalizeScope, scopeKinds } from './scope.mjs';

const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
const TOKEN_RE = /[a-z0-9][a-z0-9'-]{1,}/gi;
const EMPTY_CORPUS = { version: 0, chunks: [], issues: [], topics: [], links: [] };
const SERVICE_NAME = 'weekly-thing-librarian-stream';

export interface CorpusChunk {
  issue_number?: string | number | null;
  source_kind?: string;
  subject?: string;
  publish_date?: string;
  issue_year?: string | number;
  section?: string;
  url?: string;
  transcript_url?: string;
  audio_url?: string;
  episode_number?: string | number;
  show?: string;
  topics?: string[];
  domains?: string[];
  also_in_issues?: unknown;
  text?: string;
  summary?: string;
  embedding?: number[];
  age_label?: string;
  retrieval_reason?: string;
  retrieval_modes?: string[];
  _rerank_score?: number;
  _retrieval_score?: number;
  _terms?: Map<string, number>;
  _vector?: Map<string, number>;
  _norm?: number;
  [key: string]: unknown;
}

export interface Corpus {
  version?: number;
  chunks?: CorpusChunk[];
  issues?: Array<Record<string, unknown>>;
  topics?: unknown[];
  links?: unknown[];
  chunk_count?: number;
  embedding_dimensions?: number;
  embedding_model?: string;
  [key: string]: unknown;
}

interface LoadOptionalCorpusInput {
  kind: string;
  envKey: string;
  disabledEvent: string;
  failedEvent: string;
  cache?: Corpus;
  setCache: (value: Corpus) => void;
}

export interface RetrievalFilters {
  scope?: unknown;
  yearRange?: unknown;
  section?: unknown;
}

let corpusCache: Corpus | undefined;
let blogCorpusCache: Corpus | undefined;
let podcastCorpusCache: Corpus | undefined;
let graphCache: Record<string, unknown> | undefined;
let indexedCache: CorpusChunk[] | undefined;
let blogIndexedCache: CorpusChunk[] | undefined;
let podcastIndexedCache: CorpusChunk[] | undefined;

function logEvent(level: string, message: string, fields: Record<string, unknown> = {}) {
  sharedLogEvent(level, message, fields, SERVICE_NAME);
}

function rerankModelArn() {
  const model = rerankModel();
  if (model.startsWith('arn:')) return model;
  const region = process.env.BEDROCK_RERANK_REGION || 'us-west-2';
  return `arn:aws:bedrock:${region}::foundation-model/${model}`;
}

// Corpus artifacts upload gzip-compressed (ContentEncoding: gzip) since
// 2026-08; sniff the magic bytes so plain objects keep working too.
async function bodyToJsonString(body: { transformToByteArray: () => Promise<Uint8Array> }) {
  const bytes = await body.transformToByteArray();
  const buffer = Buffer.from(bytes);
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return gunzipSync(buffer).toString('utf8');
  return buffer.toString('utf8');
}

export async function loadCorpus(kind = 'weekly_thing'): Promise<Corpus> {
  if (kind === 'blog') return loadBlogCorpus();
  if (kind === 'podcast') return loadPodcastCorpus();
  if (corpusCache) return corpusCache;
  const bucket = process.env.CORPUS_BUCKET;
  const key = process.env.CORPUS_KEY || 'librarian/corpus.json';
  if (!bucket) throw new Error('CORPUS_BUCKET is required');
  const start = performance.now();
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error('Corpus object body is empty');
  corpusCache = JSON.parse(await bodyToJsonString(response.Body)) as Corpus;
  logEvent('info', 'corpus_loaded', {
    source: 's3',
    scope: 'weekly_thing',
    bucket,
    key,
    chunk_count: corpusCache.chunk_count || corpusCache.chunks?.length || 0,
    embedding_dimensions: corpusCache.embedding_dimensions,
    duration_ms: Math.round(performance.now() - start)
  });
  return corpusCache;
}

async function loadOptionalCorpus({
  kind,
  envKey,
  disabledEvent,
  failedEvent,
  cache,
  setCache
}: LoadOptionalCorpusInput): Promise<Corpus> {
  if (cache) return cache;
  const bucket = process.env.CORPUS_BUCKET;
  const key = process.env[envKey];
  if (!bucket || !key) {
    logEvent('info', disabledEvent, { has_bucket: Boolean(bucket), has_key: Boolean(key) });
    const empty: Corpus = { ...EMPTY_CORPUS };
    setCache(empty);
    return empty;
  }
  const start = performance.now();
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body) throw new Error(`${kind} corpus object body is empty`);
    const loaded = JSON.parse(await bodyToJsonString(response.Body)) as Corpus;
    setCache(loaded);
    logEvent('info', 'corpus_loaded', {
      source: 's3',
      scope: kind,
      bucket,
      key,
      chunk_count: loaded.chunk_count || loaded.chunks?.length || 0,
      embedding_dimensions: loaded.embedding_dimensions,
      duration_ms: Math.round(performance.now() - start)
    });
  } catch (error) {
    logEvent('warning', failedEvent, {
      key,
      error_type: error instanceof Error ? error.constructor.name : 'Error'
    });
    return { ...EMPTY_CORPUS };
  }
  return cache || (kind === 'blog' ? blogCorpusCache : podcastCorpusCache) || { ...EMPTY_CORPUS };
}

// Optional non-WT corpora load lazily and cache separately from the WT corpus.
// When an env key is unset, return an empty corpus so source-specific requests
// degrade to no hits.
async function loadBlogCorpus() {
  return loadOptionalCorpus({
    kind: 'blog',
    envKey: 'BLOG_CORPUS_KEY',
    disabledEvent: 'blog_corpus_disabled',
    failedEvent: 'blog_corpus_load_failed',
    cache: blogCorpusCache,
    setCache: (value) => {
      blogCorpusCache = value;
    }
  });
}

async function loadPodcastCorpus() {
  return loadOptionalCorpus({
    kind: 'podcast',
    envKey: 'PODCAST_CORPUS_KEY',
    disabledEvent: 'podcast_corpus_disabled',
    failedEvent: 'podcast_corpus_load_failed',
    cache: podcastCorpusCache,
    setCache: (value) => {
      podcastCorpusCache = value;
    }
  });
}

export async function loadGraph(): Promise<Record<string, unknown>> {
  if (graphCache) return graphCache;
  const bucket = process.env.CORPUS_BUCKET;
  const key = process.env.GRAPH_KEY || 'librarian/graph.json';
  if (!bucket) {
    graphCache = {};
    return graphCache;
  }
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body) throw new Error('Graph object body is empty');
    graphCache = JSON.parse(await bodyToJsonString(response.Body)) as Record<string, unknown>;
    const issues =
      graphCache.issues && typeof graphCache.issues === 'object' && !Array.isArray(graphCache.issues)
        ? graphCache.issues
        : {};
    logEvent('info', 'graph_loaded', {
      source: 's3',
      bucket,
      key,
      issue_count: Object.keys(issues).length
    });
  } catch (error) {
    graphCache = {};
    logEvent('warning', 'graph_load_failed', {
      key,
      error_type: error instanceof Error ? error.constructor.name : 'Error'
    });
  }
  return graphCache;
}

export function tokenize(text: unknown) {
  return Array.from(String(text || '').matchAll(TOKEN_RE), (match) => match[0].toLowerCase());
}

function buildLexicalIndex(corpus: Corpus): CorpusChunk[] {
  const documentFrequency = new Map<string, number>();
  const indexed = (corpus.chunks || []).map((chunk) => {
    const terms = tokenize([chunk.subject, chunk.section, chunk.text].join(' '));
    const termCounts = new Map<string, number>();
    for (const term of terms) termCounts.set(term, (termCounts.get(term) || 0) + 1);
    for (const term of termCounts.keys()) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    return { ...chunk, _terms: termCounts };
  });
  const total = Math.max(indexed.length, 1);
  for (const chunk of indexed) {
    const vector = new Map<string, number>();
    let norm = 0;
    for (const [term, count] of chunk._terms.entries()) {
      const weight = (1 + Math.log(count)) * Math.log(1 + total / (1 + (documentFrequency.get(term) || 0)));
      vector.set(term, weight);
      norm += weight * weight;
    }
    chunk._vector = vector;
    chunk._norm = Math.sqrt(norm) || 1;
  }
  return indexed;
}

async function indexedChunks(kind = 'weekly_thing'): Promise<CorpusChunk[]> {
  if (kind === 'blog') {
    if (!blogIndexedCache) blogIndexedCache = buildLexicalIndex(await loadCorpus('blog'));
    return blogIndexedCache;
  }
  if (kind === 'podcast') {
    if (!podcastIndexedCache) podcastIndexedCache = buildLexicalIndex(await loadCorpus('podcast'));
    return podcastIndexedCache;
  }
  if (!indexedCache) indexedCache = buildLexicalIndex(await loadCorpus('weekly_thing'));
  return indexedCache;
}

function cosine(left: number[] | undefined, right: number[] | undefined) {
  if (!left?.length || !right?.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  return leftNorm && rightNorm ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : 0;
}

async function embedQuery(query: unknown, model: string, dimensions: number): Promise<number[]> {
  const start = performance.now();
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: model,
      accept: 'application/json',
      contentType: 'application/json',
      body: JSON.stringify({ texts: [query], input_type: 'search_query', truncate: 'END' })
    })
  );
  const data = JSON.parse(new TextDecoder().decode(response.body)) as { embeddings?: number[][] };
  if (!data.embeddings?.length) throw new Error('Bedrock embedding response did not include embeddings');
  logEvent('info', 'query_embedded', { model, dimensions, duration_ms: Math.round(performance.now() - start) });
  return data.embeddings[0];
}

function publicChunk(chunk: CorpusChunk): CorpusChunk {
  return Object.fromEntries(Object.entries(chunk).filter(([key]) => key !== 'embedding' && !key.startsWith('_')));
}

function sourceAgeLabel(source: CorpusChunk) {
  const value = source.publish_date || '';
  const published = value ? new Date(String(value)) : null;
  if (!published || Number.isNaN(published.getTime())) return 'unknown age';
  const days = Math.max(0, (Date.now() - published.getTime()) / 86400000);
  if (days < 45) return 'recent';
  if (days < 365) return `about ${Math.max(Math.round(days / 30), 1)} months old`;
  return `about ${Math.max(Math.round(days / 365), 1)} years old`;
}

export function compactSource(source: CorpusChunk, textLimit = 2000) {
  return {
    issue_number: source.issue_number,
    source_kind: source.source_kind,
    subject: source.subject,
    publish_date: source.publish_date,
    issue_year: source.issue_year,
    section: source.section,
    age: source.age_label || sourceAgeLabel(source),
    score: source._rerank_score || source._retrieval_score,
    reason: source.retrieval_reason || (source.retrieval_modes || []).join(', '),
    url: source.url,
    transcript_url: source.transcript_url,
    audio_url: source.audio_url,
    episode_number: source.episode_number,
    show: source.show,
    topics: source.topics || [],
    // Present only on blog chunks that a WT issue Journal linked back to -
    // lets the agent cross-reference ("Jamie also featured this in WT###").
    also_in_issues: source.also_in_issues,
    text: String(source.text || '').slice(0, textLimit)
  };
}

function sourceKind(item: CorpusChunk) {
  if (item?.source_kind) return item.source_kind;
  if (!item?.issue_number && item?.url) return 'external';
  return 'chunk';
}

function sourceHeader(source: CorpusChunk) {
  const kind = sourceKind(source);
  if (kind === 'blog') return `thingelstad.com blog: ${source.subject || ''}`;
  if (kind === 'podcast') {
    const episode = source.episode_number ? ` episode ${source.episode_number}` : '';
    return `Another Thing podcast${episode}: ${source.subject || ''}`;
  }
  return `Weekly Thing #${source.issue_number}: ${source.subject || ''}`;
}

async function rerankSources(query: unknown, sources: CorpusChunk[], limit = 8): Promise<CorpusChunk[]> {
  if (!sources.length || !truthyEnv('LIBRARIAN_RERANK_ENABLED', '1')) return sources.slice(0, limit);
  const start = performance.now();
  const top = sources.slice(0, Math.max(limit * 5, 100));
  const rerankInputs: RerankSource[] = top.map((source) => {
    const header = sourceHeader(source);
    return {
      type: 'INLINE',
      inlineDocumentSource: {
        type: 'TEXT',
        textDocument: {
          // No Topics line: WT topics are issue-level, identical for every
          // chunk in an issue, and only diluted the rerank signal.
          text: [
            header,
            `Date: ${source.publish_date || ''}`,
            `Section: ${source.section || ''}`,
            // Cover the whole chunk: max_words=400 chunking produces up to
            // ~2,600 chars, and a term past the slice is invisible to the
            // reranker (found live: a query term at the tail of a chunk
            // ranked below unrelated semantic noise).
            String(source.text || '')
              .replace(/\s+/g, ' ')
              .slice(0, 3000)
          ].join('\n')
        }
      }
    };
  });
  try {
    const data = await bedrockAgentRuntime.send(
      new RerankCommand({
        queries: [{ type: 'TEXT', textQuery: { text: String(query || '') } }],
        sources: rerankInputs,
        rerankingConfiguration: {
          type: 'BEDROCK_RERANKING_MODEL',
          bedrockRerankingConfiguration: {
            numberOfResults: Math.min(rerankInputs.length, Math.max(limit, 8)),
            modelConfiguration: { modelArn: rerankModelArn() }
          }
        }
      })
    );
    const ordered: CorpusChunk[] = [];
    for (const item of data.results || []) {
      const index = Number(item.index);
      if (index >= 0 && index < top.length) {
        ordered.push({ ...top[index], _rerank_score: Number(item.relevanceScore ?? 0) });
      }
    }
    if (ordered.length) {
      logEvent('info', 'rerank_completed', {
        model: rerankModel(),
        candidate_count: top.length,
        result_count: ordered.length,
        duration_ms: Math.round(performance.now() - start)
      });
      return ordered;
    }
  } catch (error) {
    logEvent('warning', 'rerank_failed', {
      model: rerankModel(),
      error_type: error instanceof Error ? error.constructor.name : 'Error'
    });
  }
  return sources.slice(0, limit);
}

async function embedForCorpus(query: unknown, corpus: Corpus) {
  const model = corpus.embedding_model || embeddingModel();
  const dimensions = Number(corpus.embedding_dimensions || DEFAULT_EMBEDDING_DIMENSIONS);
  return embedQuery(query, model, dimensions);
}

// Pure cosine scoring over one corpus's embedded chunks. Attaches
// _retrieval_score so callers can merge candidates from multiple corpora and
// re-sort before a single rerank (mixed scopes). The keep predicate runs
// BEFORE the top-K slice - year/section filters must narrow the scan itself,
// or a filtered query only ever sees survivors of the unfiltered top-K.
export function semanticScore(
  corpus: Corpus,
  queryEmbedding: number[],
  limit: number,
  keep: (chunk: CorpusChunk) => boolean = () => true
): CorpusChunk[] {
  const chunks = (corpus.chunks || []).filter((chunk) => chunk.embedding && keep(chunk));
  if (!chunks.length) return [];
  return chunks
    .map((chunk) => ({ score: cosine(queryEmbedding, chunk.embedding), chunk }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ score, chunk }) => ({ ...publicChunk(chunk), _retrieval_score: score }));
}

async function retrieveLexical(
  query: unknown,
  limit = 8,
  kind = 'weekly_thing',
  keep: (chunk: CorpusChunk) => boolean = () => true
): Promise<CorpusChunk[]> {
  const start = performance.now();
  const queryTerms = new Map<string, number>();
  for (const term of tokenize(query)) queryTerms.set(term, (queryTerms.get(term) || 0) + 1);
  if (!queryTerms.size) return [];
  const scored: Array<{ score: number; chunk: CorpusChunk }> = [];
  for (const chunk of await indexedChunks(kind)) {
    if (!keep(chunk)) continue;
    let score = 0;
    for (const [term, count] of queryTerms.entries()) score += (chunk._vector?.get(term) || 0) * count;
    if (score > 0) scored.push({ score: score / (chunk._norm || 1), chunk });
  }
  const result = scored
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ score, chunk }) => ({ ...publicChunk(chunk), _retrieval_score: score }));
  logEvent('info', 'retrieval_completed', {
    mode: 'lexical',
    scope: kind,
    result_count: result.length,
    duration_ms: Math.round(performance.now() - start)
  });
  return result;
}

export function parseYearRange(value: unknown): [number | null, number | null] {
  if (!value) return [null, null];
  if (Array.isArray(value) && value.length >= 2) return [Number(value[0]) || null, Number(value[1]) || null];
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return [Number(record.start || record.from) || null, Number(record.end || record.to) || null];
  }
  const years =
    String(value)
      .match(/\b(?:19|20)\d{2}\b/g)
      ?.map(Number) || [];
  if (years.length > 1) return [Math.min(...years), Math.max(...years)];
  if (years.length === 1) return [years[0], years[0]];
  return [null, null];
}

export function matchesFilters(source: CorpusChunk, { yearRange, section }: RetrievalFilters = {}) {
  const [startYear, endYear] = parseYearRange(yearRange);
  const year = Number(source.issue_year || 0);
  if (startYear && (!year || year < startYear)) return false;
  if (endYear && (!year || year > endYear)) return false;
  if (
    section &&
    !String(source.section || '')
      .toLowerCase()
      .includes(String(section).toLowerCase())
  )
    return false;
  return true;
}

function withAgeLabel(sources: CorpusChunk[]) {
  return sources.map((source) => ({ ...source, age_label: source.age_label || sourceAgeLabel(source) }));
}

function chunkKey(source: CorpusChunk) {
  if (source.id != null) return `id:${String(source.id)}`;
  return [
    sourceKind(source),
    String(source.issue_number ?? ''),
    String(source.section ?? ''),
    String(source.text || '').slice(0, 80)
  ].join('|');
}

// Reciprocal-rank fusion of the semantic and lexical candidate lists. Rank-
// based (not score-based) because cosine and TF-IDF scores are not on a
// comparable scale. A chunk found by both engines gets both contributions;
// the single downstream rerank then orders the fused pool on relevance.
const RRF_K = 60;
export function fuseCandidates(semantic: CorpusChunk[], lexical: CorpusChunk[], limit: number): CorpusChunk[] {
  const fused = new Map<string, CorpusChunk>();
  const lists: Array<[CorpusChunk[], string]> = [
    [semantic, 'semantic'],
    [lexical, 'lexical']
  ];
  for (const [list, mode] of lists) {
    list.forEach((source, rank) => {
      const key = chunkKey(source);
      const existing = fused.get(key);
      const contribution = 1 / (RRF_K + rank + 1);
      if (existing) {
        existing._retrieval_score = (existing._retrieval_score || 0) + contribution;
        existing.retrieval_modes = [...new Set([...(existing.retrieval_modes || []), mode])];
      } else {
        fused.set(key, { ...source, _retrieval_score: contribution, retrieval_modes: [mode] });
      }
    });
  }
  return [...fused.values()].sort((a, b) => (b._retrieval_score || 0) - (a._retrieval_score || 0)).slice(0, limit);
}

// Scope is enforced HERE - by which corpus/corpora we scan, not by a
// post-filter. weekly_thing scans the WT corpus (identical to today);
// blog/podcast scan their own corpora; mixed scopes gather candidates from
// each and rerank the union once. Year/section filters are pushed into each
// engine's scan via the keep predicate. Lexical always contributes (it is
// in-memory and free, and carries proper nouns dense retrieval misses);
// semantic is best-effort and the fusion degrades to lexical-only when the
// embedding call fails.
export async function retrieve(query: unknown, limit = 8, filters: RetrievalFilters = {}) {
  const kinds = scopeKinds(filters.scope);
  const candidateLimit = Math.max(limit * 5, 100);
  const byScore = (a: CorpusChunk, b: CorpusChunk) => (b._retrieval_score || 0) - (a._retrieval_score || 0);
  const keep = (chunk: CorpusChunk) => matchesFilters(chunk, filters);

  const lexical: CorpusChunk[] = [];
  for (const kind of kinds) lexical.push(...(await retrieveLexical(query, candidateLimit, kind, keep)));
  lexical.sort(byScore);

  const semantic: CorpusChunk[] = [];
  try {
    let queryEmbedding = null;
    for (const kind of kinds) {
      const corpus = await loadCorpus(kind);
      if (!(corpus.chunks || []).some((chunk) => chunk.embedding)) continue;
      if (!queryEmbedding) queryEmbedding = await embedForCorpus(query, corpus);
      semantic.push(...semanticScore(corpus, queryEmbedding, candidateLimit, keep));
    }
    semantic.sort(byScore);
  } catch (error) {
    logEvent(
      'error',
      'semantic_retrieval_failed',
      errorFields(error, {
        scope: normalizeScope(filters.scope),
        source_kinds: kinds,
        query_chars: String(query || '').length
      })
    );
  }

  const fused = dedupeJournalTwins(fuseCandidates(semantic, lexical, candidateLimit));
  return withAgeLabel((await rerankSources(query, fused, limit)).slice(0, limit));
}

// A Weekly Thing Journal chunk reprints blog posts; when both the journal
// chunk and a standalone blog chunk for the same post URL surface as
// candidates, keep the higher-scored one (Jamie's dedup ask - the URL is
// the join key, stamped as journal_post_urls at corpus build).
export function dedupeJournalTwins(candidates: CorpusChunk[]): CorpusChunk[] {
  const journalOwners = new Map<string, CorpusChunk>();
  for (const candidate of candidates) {
    for (const url of (candidate.journal_post_urls as string[] | undefined) || []) {
      journalOwners.set(String(url), candidate);
    }
  }
  if (!journalOwners.size) return candidates;
  const dropped = new Set<CorpusChunk>();
  for (const candidate of candidates) {
    if (candidate.source_kind !== 'blog' || !candidate.url) continue;
    const twin = journalOwners.get(String(candidate.url));
    if (!twin || dropped.has(twin)) continue;
    if ((twin._retrieval_score || 0) >= (candidate._retrieval_score || 0)) dropped.add(candidate);
    else dropped.add(twin);
  }
  return candidates.filter((candidate) => !dropped.has(candidate));
}
