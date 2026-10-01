import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { RerankCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import type { RerankSource } from '@aws-sdk/client-bedrock-agent-runtime';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync } from 'node:zlib';
import { bedrock, bedrockAgentRuntime, embeddingModel, rerankModel, s3 } from './aws-clients.mjs';
import { errorFields, logEvent as sharedLogEvent, truthyEnv } from './logging.mjs';
import { normalizeScope, scopeKinds } from './scope.mjs';
import { absoluteSourceUrl, blogKeyPart, publicSourceKind, sourceLabel } from './source-identity.mjs';

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
  // Contract 4.11 (additive): narrow by public source kind, drop issues the
  // caller already has (Echoes: this issue and the two before it), keep only
  // sources published before a date, or ask for one issue exactly (WT
  // Builder's "is it indexed yet" probe).
  sourceKinds?: unknown;
  excludeSourceKinds?: unknown;
  excludeIssues?: unknown;
  before?: unknown;
  issueNumber?: unknown;
  // Contract 4.12 (additive): a section family ("Journal" across every
  // era's rename and WT351's day headings), a content kind (links,
  // personal, essay, meta...), whose words (voice), and a calendar window
  // (this week in every past year).
  sectionFamily?: unknown;
  contentKind?: unknown;
  voice?: unknown;
  calendar?: unknown;
  // MCP 1.4: a topic cluster (the nine in corpus.topics, stamped on
  // Weekly Thing chunks) and a blog category (on post records; retrieve()
  // resolves it to post ids before scoring).
  topic?: unknown;
  category?: unknown;
  categoryPostIds?: Set<string>;
}

// Whose words a stretch of chunk text is. Corpus chunks carry
// spans [{voice, start, end}] partitioning their text: blockquotes are
// quoted, headline link titles are link, the rest is Jamie. A chunk from a
// corpus built before spans existed is all Jamie.
export const VOICES = ['jamie', 'quoted', 'link'] as const;
// A voice-filtered chunk with less than this much of the voice left is a
// quote with a line of framing, not a passage in that voice.
export const VOICE_MIN_CHARS = 40;
const CALENDAR_MAX_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

interface ChunkSpan {
  voice?: string;
  start?: number;
  end?: number;
}

let corpusCache: Corpus | undefined;
let blogCorpusCache: Corpus | undefined;
let podcastCorpusCache: Corpus | undefined;
let graphCache: Record<string, unknown> | undefined;

// A blog post's identity is its microblog_id, never its url: micro.blog gave
// several posts one permalink (6 urls, 14 posts, mostly 000000.html imports),
// and keying by url merged them (QA 2026-09-30). Corpora built before
// 2026-09-30 carry the id on posts and links but not on chunks or media, so
// it is filled in once at load: a chunk's from its id (blog:<id>:<n>:<hash>),
// a photo's from the one post at its source url (none when the url is
// shared - better unattached than on the wrong post). A page's rows carry
// page_id and are never given a post's id.
export function withBlogIdentity(corpus: Corpus | undefined) {
  if (!corpus) return corpus;
  type Row = Record<string, unknown>;
  const layer = (name: string) => ((corpus as Record<string, unknown>)[name] || []) as Row[];
  const idsByUrl = new Map<string, unknown[]>();
  for (const post of layer('posts')) {
    if (post.page_id != null) continue;
    const key = postUrlKey(post.url);
    if (key) idsByUrl.set(key, [...(idsByUrl.get(key) || []), post.microblog_id]);
  }
  const uniqueId = (url: unknown) => {
    const ids = idsByUrl.get(postUrlKey(url)) || [];
    return ids.length === 1 && ids[0] ? ids[0] : undefined;
  };
  for (const chunk of layer('chunks')) {
    if (chunk.microblog_id || chunk.page_id != null) continue;
    const match = /^blog:(\d+):/.exec(String(chunk.id || ''));
    const id = match ? Number(match[1]) : uniqueId(chunk.url);
    if (id) chunk.microblog_id = id;
  }
  for (const link of layer('links')) {
    if (link.microblog_id || link.page_id != null) continue;
    const id = uniqueId(link.post_url || link.source_url);
    if (id) link.microblog_id = id;
  }
  for (const item of layer('media')) {
    if (item.microblog_id || item.page_id != null) continue;
    const id = uniqueId(item.source_url);
    if (id) item.microblog_id = id;
  }
  return corpus;
}

// Host and path only: www., micro.thingelstad.com, jthingelstad.micro.blog
// and a trailing slash name the same post (archive-tools urlKey, which
// cannot be imported here).
function postUrlKey(value: unknown) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^jthingelstad\.micro\.blog(?=\/|$)/, 'thingelstad.com')
    .replace(/^(?:www\.|micro\.(?=thingelstad\.com))/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '');
}

// Test seam: prime the module caches with fixture corpora so tool handlers
// can be exercised without S3. Production never calls this.
export function primeCorpusCachesForTests(fixtures: {
  weekly_thing?: Corpus;
  blog?: Corpus;
  podcast?: Corpus;
  graph?: Record<string, unknown>;
}) {
  corpusCache = fixtures.weekly_thing;
  blogCorpusCache = withBlogIdentity(fixtures.blog);
  podcastCorpusCache = fixtures.podcast;
  graphCache = fixtures.graph;
  sectionNamesCache = undefined;
  indexedCache = undefined;
  blogIndexedCache = undefined;
  podcastIndexedCache = undefined;
}
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
  sectionNamesCache = undefined;
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
    setCache(kind === 'blog' ? withBlogIdentity(loaded)! : loaded);
    sectionNamesCache = undefined;
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
  const years = Math.max(Math.round(days / 365), 1);
  return `about ${years} ${years === 1 ? 'year' : 'years'} old`;
}

export function compactSource(source: CorpusChunk, textLimit = 2000) {
  // ~35 live corpus chunks carry explicit nulls in these fields; the
  // /retrieve contract types them as strings, so omit absent values
  // (same normalization citationsFor applies on the /chat side).
  const text = (value: unknown) => (value == null ? undefined : String(value));
  const kind = publicSourceKind(source);
  return {
    id: text(source.id),
    issue_number: source.issue_number ?? undefined,
    source_kind: kind,
    label: sourceLabel(source),
    subject: text(source.subject),
    publish_date: text(source.publish_date),
    issue_year: kind === 'weekly_thing' ? (source.issue_year ?? undefined) : undefined,
    section: text(source.section),
    age: source.age_label || sourceAgeLabel(source),
    score: source._rerank_score || source._retrieval_score,
    reason: source.retrieval_reason || (source.retrieval_modes || []).join(', '),
    url: absoluteSourceUrl(source.url),
    transcript_url: source.transcript_url,
    audio_url: source.audio_url,
    episode_number: source.episode_number,
    show: source.show,
    topics: source.topics || [],
    // Present only on blog chunks that a WT issue Journal linked back to -
    // lets the agent cross-reference ("Jamie also featured this in WT###").
    also_in_issues: source.also_in_issues,
    section_family: text(source.section_family),
    content_kind: text(source.content_kind),
    // Present only when a voice filter rewrote the text to those spans.
    voice: Array.isArray(source.voice) ? source.voice : undefined,
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

// The whole pool comes back in rerank order (depth), not only the page:
// retrieve() cuts the page itself, and a Journal copy dropped from it is
// refilled from below the cut (QA2 R2-3). Rerank cost is per document sent,
// not per result returned.
async function rerankSources(query: unknown, sources: CorpusChunk[], limit = 8, depth = limit): Promise<CorpusChunk[]> {
  if (!sources.length || !truthyEnv('LIBRARIAN_RERANK_ENABLED', '1')) return sources.slice(0, depth);
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
            numberOfResults: Math.min(rerankInputs.length, Math.max(depth, limit, 8)),
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
  return sources.slice(0, depth);
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

function stringList(value: unknown): string[] {
  if (value == null || value === '') return [];
  return (Array.isArray(value) ? value : [value]).map((item) => String(item).trim()).filter(Boolean);
}

function lowerList(value: unknown) {
  return stringList(value).map((item) => item.toLowerCase());
}

export function voiceList(value: unknown) {
  return lowerList(value);
}

// Image markup is nobody's voice: alt text is mostly machine-written
// (Jamie, 2026-09-30), so ![alt](url) and <img alt> leave a voiced passage.
const IMAGE_MARKUP = /!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>/gi;
// Site copy and FAQ answers are the site speaking, not Jamie writing on a
// topic: no voice matches them.
const VOICELESS_KINDS = new Set(['faq', 'site_page']);

// The chunk's text in the wanted voices only, in reading order. No spans
// means the whole chunk is Jamie's.
export function voicedText(chunk: CorpusChunk, voices: string[]) {
  const text = String(chunk.text || '');
  if (!voices.length) return text;
  if (VOICELESS_KINDS.has(String(chunk.content_kind || chunk.source_kind || ''))) return '';
  const spans = Array.isArray(chunk.spans) ? (chunk.spans as ChunkSpan[]) : null;
  const unimaged = (value: string) =>
    value
      .replace(IMAGE_MARKUP, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  if (!spans) return voices.includes('jamie') ? unimaged(text) : '';
  return spans
    .filter((span) => voices.includes(String(span.voice || '')))
    .map((span) => unimaged(text.slice(Number(span.start) || 0, Number(span.end) || 0)))
    .filter(Boolean)
    .join('\n\n');
}

// A source's day is its Chicago date: Jamie lives and publishes in Central
// time (2026-09-30). A timestamp converts (WT35 went out 01:28Z Jan 7, which
// is Jan 6 in Chicago); a bare date (a permalink, an episode date) already
// is local. Blog posts carry `published`, the moment, beside the permalink.
const CHICAGO_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

export function localDay(source: { published?: unknown; publish_date?: unknown } | undefined) {
  const stamp = String(source?.published || source?.publish_date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(stamp)) {
    const time = Date.parse(stamp);
    if (Number.isFinite(time)) return CHICAGO_DAY.format(time);
  }
  return stamp.slice(0, 10);
}

// A section name as a heading reads it, so the name a caller copies from
// the body finds its section: no-break spaces, markdown marks (#MNTech,
// *Not*, `yes`) and doubled spaces do not count (QA F6).
export function headingKey(value: unknown) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Every section heading, family and H2 group the loaded corpora hold, as
// heading keys. A section filter that names one exactly matches it
// exactly: "journal" had also taken any heading containing the word (6 to
// 13 sections an issue).
let sectionNamesCache: Set<string> | undefined;

export function knownSectionNames() {
  if (sectionNamesCache) return sectionNamesCache;
  const names = new Set<string>();
  for (const corpus of [corpusCache, blogCorpusCache, podcastCorpusCache]) {
    for (const chunk of corpus?.chunks || []) {
      if (chunk.section) names.add(headingKey(chunk.section));
      if (chunk.section_family) names.add(headingKey(chunk.section_family));
    }
  }
  if (corpusCache) for (const placed of sectionGroups(corpusCache).values()) for (const key of placed) names.add(key);
  names.delete('');
  sectionNamesCache = names;
  return names;
}

// The H2 groups each Weekly Thing chunk sits under in its issue's body
// ("Notable Links 📌", "Stream", "Now Reading 📚"), by chunk id, as heading
// keys. Chunk sections are the article or H3 names, so a section filter
// naming the group heading a caller sees in the body (and that get_source
// reads) matched 0 chunks or only the group's lead-in (QA2 R2-2: Notable
// Links 📌 in 78 issues, 0 chunks). A chunk is placed by finding its text
// in the body, after the chunk before it, and by its own heading: a chunk
// that starts under a stray H2 ("Oh my…" in WT85) still belongs to the
// group its article heading sits in. One found neither way (11 of 10,016)
// stays under the groups of the chunk before it.
const SECTION_GROUPS = new WeakMap<Corpus, Map<string, string[]>>();

function bodyHeadings(body: string) {
  const heads: Array<{ at: number; level: number; key: string }> = [];
  let fenced = false;
  let at = 0;
  for (const line of body.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    const match = fenced ? null : /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (match) {
      const name = match[2].replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
      heads.push({ at, level: match[1].length, key: headingKey(name) });
    }
    at += line.length + 1;
  }
  return heads;
}

function sectionGroups(corpus: Corpus) {
  let groups = SECTION_GROUPS.get(corpus);
  if (groups) return groups;
  groups = new Map();
  const byIssue = new Map<string, CorpusChunk[]>();
  for (const chunk of corpus.chunks || []) {
    if (chunk.issue_number == null || chunk.id == null) continue;
    const key = String(chunk.issue_number);
    if (!byIssue.has(key)) byIssue.set(key, []);
    byIssue.get(key)!.push(chunk);
  }
  for (const issue of corpus.issues || []) {
    const body = String(issue.body || '');
    const chunks = byIssue.get(String(issue.number)) || [];
    if (!body || !chunks.length) continue;
    const heads = bodyHeadings(body);
    // The H2 a body position falls under ('' above the first, or under an H1).
    const groupAt = (position: number) => {
      let group = '';
      for (const head of heads) {
        if (head.at > position) break;
        if (head.level <= 2) group = head.level === 2 ? head.key : '';
      }
      return group;
    };
    let from = 0;
    let placed: string[] = [];
    for (const chunk of chunks) {
      const probe = String(chunk.text || '').slice(0, 60);
      let at = probe ? body.indexOf(probe, from) : -1;
      if (at < 0 && probe) at = body.indexOf(probe);
      const own = headingKey(chunk.section);
      const heading =
        at >= 0
          ? heads.filter((head) => head.key === own && head.at <= at).pop()
          : heads.find((head) => head.key === own && head.at >= from);
      const found = [at, heading ? heading.at : -1].filter((position) => position >= 0);
      if (found.length) {
        from = Math.max(...found);
        placed = [...new Set(found.map(groupAt))].filter(Boolean);
      }
      if (placed.length) groups.set(String(chunk.id), placed);
    }
  }
  SECTION_GROUPS.set(corpus, groups);
  return groups;
}

// The H2 groups a chunk sits under, as heading keys (none outside a group).
export function sectionGroupsOf(chunk: CorpusChunk): string[] {
  if (!corpusCache || chunk.id == null || chunk.issue_number == null) return [];
  return sectionGroups(corpusCache).get(String(chunk.id)) || [];
}

function isLeapYear(year: number) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// The anchor day in a given year, clamped to the month's last day (02-29
// is Feb 28 in a year without one, never March 1).
function anchorIn(year: number, month: number, day: number) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Date.UTC(year, month - 1, Math.min(day, lastDay));
}

// The past year whose anchor this date falls within `window` days of, or
// null. A Feb 29 source counts as Feb 28 when the target year has no Feb 29.
// When it has one, Feb 29 is its own day: a Feb 28 from a year without one
// stays on Feb 28, or it would be listed on two days.
export function onThisDayYear(published: string, month: number, day: number, window: number, targetYear: number) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(published);
  if (!match) return null;
  const year = Number(match[1]);
  const sourceLeapDay = match[2] === '02' && match[3] === '29';
  if (!window && month === 2 && day === 29 && isLeapYear(targetYear) && !sourceLeapDay) return null;
  const leapDay = sourceLeapDay && !isLeapYear(targetYear);
  const time = Date.UTC(year, Number(match[2]) - 1, leapDay ? 28 : Number(match[3]));
  for (const candidate of [year, year - 1, year + 1]) {
    if (Math.abs(time - anchorIn(candidate, month, day)) <= window * DAY_MS) return candidate;
  }
  return null;
}

interface CalendarWindow {
  month: number;
  day: number;
  window: number;
  targetYear: number;
}

// filters.calendar {date: YYYY-MM-DD, window_days}: sources published within
// window_days of that month-day in an EARLIER year - this week in past years.
// Returns a string for a malformed value so /retrieve can 400 it.
export function parseCalendar(value: unknown): CalendarWindow | string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'calendar must be {date, window_days}.';
  const record = value as Record<string, unknown>;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(record.date || '').trim());
  if (!match) return 'calendar.date must be YYYY-MM-DD.';
  const [targetYear, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(targetYear, month, 0)).getUTCDate()) {
    return 'calendar.date is not a calendar day.';
  }
  const requested = record.window_days == null ? 0 : Number(record.window_days);
  if (!Number.isFinite(requested) || requested < 0) return 'calendar.window_days must be a number from 0 to 7.';
  return { month, day, window: Math.min(Math.floor(requested), CALENDAR_MAX_WINDOW_DAYS), targetYear };
}

// The 4.12 filters a caller can get wrong in a way that would otherwise
// quietly widen the result: an unknown voice or a malformed calendar.
export function retrievalFilterError(filters: RetrievalFilters = {}) {
  const unknownVoice = voiceList(filters.voice).find((voice) => !(VOICES as readonly string[]).includes(voice));
  if (unknownVoice) return `voice must be one of ${VOICES.join(', ')}.`;
  const calendar = parseCalendar(filters.calendar);
  return typeof calendar === 'string' ? calendar : null;
}

export function matchesFilters(
  source: CorpusChunk,
  {
    yearRange,
    section,
    sourceKinds,
    excludeSourceKinds,
    excludeIssues,
    before,
    issueNumber,
    sectionFamily,
    contentKind,
    voice,
    calendar,
    topic,
    categoryPostIds
  }: RetrievalFilters = {}
) {
  const include = stringList(sourceKinds);
  const exclude = stringList(excludeSourceKinds);
  if (include.length || exclude.length) {
    const kind = publicSourceKind(source);
    if (include.length && !include.includes(kind)) return false;
    if (exclude.includes(kind)) return false;
  }
  const issue = source.issue_number == null ? '' : String(source.issue_number);
  if (issueNumber != null && issueNumber !== '' && issue !== String(issueNumber)) return false;
  if (issue && stringList(excludeIssues).includes(issue)) return false;
  if (before != null && before !== '') {
    // Undated sources (site pages, FAQ) cannot be placed before anything.
    const published = String(source.publish_date || '').slice(0, 10);
    if (!published || published >= String(before).slice(0, 10)) return false;
  }
  const [startYear, endYear] = parseYearRange(yearRange);
  const year = Number(source.issue_year || 0);
  if (startYear && (!year || year < startYear)) return false;
  if (endYear && (!year || year > endYear)) return false;
  const family = String(source.section_family || '').toLowerCase();
  if (section) {
    // A name some section, family or H2 group has exactly matches exactly,
    // so section "Journal" finds the Journal family (WT351's day-headed
    // one included) and not every heading with the word in it, and
    // "Notable Links 📌" finds every article under that heading (QA2
    // R2-2); any other name matches inside the heading, as always.
    const wanted = headingKey(section) || String(section).trim().toLowerCase();
    const heading = headingKey(source.section);
    const exact = knownSectionNames().has(wanted);
    const named = heading === wanted || headingKey(family) === wanted || sectionGroupsOf(source).includes(wanted);
    if (!named && (exact || !heading.includes(wanted))) return false;
  }
  const families = lowerList(sectionFamily);
  if (families.length && !families.includes(family)) return false;
  const kinds = lowerList(contentKind);
  if (kinds.length && !kinds.includes(String(source.content_kind || '').toLowerCase())) return false;
  const window = parseCalendar(calendar);
  if (window && typeof window === 'object') {
    const published = localDay(source);
    const year = onThisDayYear(published, window.month, window.day, window.window, window.targetYear);
    if (year === null || year >= window.targetYear) return false;
  }
  const clusters = lowerList(topic);
  if (clusters.length) {
    const topics = Array.isArray(source.topics) ? source.topics.map((item) => String(item).toLowerCase()) : [];
    const filed = issueClusters(source);
    if (!clusters.some((cluster) => topics.includes(cluster) || filed.has(cluster))) return false;
  }
  // A Set only: /retrieve passes request filters through, and a JSON body
  // cannot make one.
  if (categoryPostIds instanceof Set && !categoryPostIds.has(blogPostId(source))) return false;
  const voices = voiceList(voice);
  if (voices.length && voicedText(source, voices).length < VOICE_MIN_CHARS) return false;
  return true;
}

// The clusters a Weekly Thing chunk's issue is filed under. Passages carry
// their own cluster labels (chunk.topics), but the cards, list_topics and
// archive_lens count the issue-level filing (cluster.issue_numbers,
// issue.topics), a different labelling pass: an issue filed only at issue
// level was unreachable by the topic filter (QA2 L2-7: Media and culture
// 67 issues, Software development 56, Privacy and security 50). Either
// filing now admits the chunk.
const ISSUE_CLUSTERS = new WeakMap<Corpus, Map<string, Set<string>>>();
const NO_CLUSTERS = new Set<string>();

function issueClusters(source: CorpusChunk) {
  if (!corpusCache || source.issue_number == null || publicSourceKind(source) !== 'weekly_thing') return NO_CLUSTERS;
  let filed = ISSUE_CLUSTERS.get(corpusCache);
  if (!filed) {
    filed = new Map();
    const file = (issue: unknown, cluster: unknown) => {
      const key = String(issue);
      if (!filed!.has(key)) filed!.set(key, new Set());
      filed!.get(key)!.add(String(cluster).toLowerCase());
    };
    for (const cluster of (corpusCache.topics || []) as Array<Record<string, unknown>>) {
      for (const issue of Array.isArray(cluster?.issue_numbers) ? cluster.issue_numbers : []) file(issue, cluster.name);
    }
    for (const issue of corpusCache.issues || []) {
      for (const cluster of Array.isArray(issue.topics) ? issue.topics : []) file(issue.number, cluster);
    }
    ISSUE_CLUSTERS.set(corpusCache, filed);
  }
  return filed.get(String(source.issue_number)) || NO_CLUSTERS;
}

// The microblog id a blog chunk belongs to (ids are blog:{id}:{index}:{hash}).
// A blog chunk's source key part (blogKeyPart): the microblog_id from
// blog:<id>:<n>:<hash>, page:<id> from a page's page:<id>:<n>:<hash>.
function blogPostId(source: CorpusChunk) {
  const match = /^(blog|page):([^:]+):/.exec(String(source.id || ''));
  if (!match) return '';
  return match[1] === 'page' ? `page:${match[2]}` : match[2];
}

// The blog posts filed under any of these categories (case-insensitive).
export async function blogCategoryPostIds(category: unknown) {
  const wanted = lowerList(category);
  const ids = new Set<string>();
  if (!wanted.length) return ids;
  const corpus = await loadCorpus('blog');
  for (const post of (corpus.posts as Array<Record<string, unknown>> | undefined) || []) {
    const categories = Array.isArray(post.categories) ? post.categories.map((item) => String(item).toLowerCase()) : [];
    if (wanted.some((item) => categories.includes(item))) ids.add(blogKeyPart(post));
  }
  return ids;
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
export async function retrieve(
  query: unknown,
  limit = 8,
  filters: RetrievalFilters = {},
  opts: { rerank?: boolean } = {}
) {
  if (filters.category && !(filters.categoryPostIds instanceof Set)) {
    filters = { ...filters, categoryPostIds: await blogCategoryPostIds(filters.category) };
  }
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

  const voices = voiceList(filters.voice);
  let fused = fuseCandidates(semantic, lexical, candidateLimit);
  // A voice filter rewrites each passage to that voice's spans BEFORE the
  // rerank, so a chunk that matched on a quotation ranks on Jamie's framing
  // alone, and the caller never receives the quoted words as Jamie's.
  if (voices.length) fused = fused.map((chunk) => ({ ...chunk, text: voicedText(chunk, voices), voice: voices }));
  // rerank: false skips the cross-region rerank call - RRF order is good
  // enough for grounding pools (welcome chips) where latency matters more
  // than final ordering precision. Answer-path retrieval always reranks.
  if (opts.rerank === false) return withAgeLabel(pageWithoutTwins(fused, limit));
  return withAgeLabel(pageWithoutTwins(await rerankSources(query, fused, limit, fused.length), limit));
}

// The page: the ranked list cut at limit, less each Journal copy whose
// posts are all on that page, refilled from below the cut until the page
// is full or the list runs out. The dedupe once ran on the whole pool
// before ranking, so a copy inside the limit vanished when its post sat
// at rank 28, and neither showed (QA2 R2-3); and a dedupe after the cut
// would shrink the page below limit with more candidates waiting.
export function pageWithoutTwins(ranked: CorpusChunk[], limit: number): CorpusChunk[] {
  const dropped = new Set<CorpusChunk>();
  for (;;) {
    const page: CorpusChunk[] = [];
    for (const chunk of ranked) {
      if (page.length >= limit) break;
      if (!dropped.has(chunk)) page.push(chunk);
    }
    const kept = new Set(dedupeJournalTwins(page));
    if (kept.size === page.length) return page;
    for (const chunk of page) if (!kept.has(chunk)) dropped.add(chunk);
  }
}

// A Weekly Thing Journal chunk reprints blog posts; when both the journal
// chunk and a standalone blog chunk for the same post surface as
// candidates, the blog chunk always wins - the blog post is the canonical
// home of the writing (Jamie's call, 2026-08-29, restated 2026-09-30). The
// join is the post URL (journal_post_urls) and, where the corpus build tied
// the copy to its post, the post's microblog_id (journal_posts), which
// survives micro.blog changing a permalink after the issue went out. A
// journal chunk drops only when EVERY post it copies has its twin in the
// candidates it is checked against (the returned page, pageWithoutTwins):
// a chunk that reprints two posts, one of which surfaced on its own, still
// carries the other one's words (corpus QA, 2026-10-01). The twin is judged
// per passage (Jamie, 2026-10-01, QA3 Q7): a post long enough to be split
// into several passages twins the copy only when its passages on the page
// show the copy's words (showsCopiedWords), so the post's unrelated
// paragraph never erases the copy of a different one (WT147's "mini
// minnebar" copy is mostly in blog-1088967's third passage, not in the
// "Fully remote" one). A one-passage post is its own passage.
export function journalPostKeys(chunk: CorpusChunk): string[] {
  return [...new Set(journalPostKeySets(chunk).flat())];
}

// One key list per post the chunk copies. journal_posts pairs one to one,
// in order, with journal_post_urls and then lists the chunk's other copies
// (heading entries, Journal sections with no link); a post with no url and
// no microblog id has no keys and can never be twinned.
function journalPostKeySets(chunk: CorpusChunk): string[][] {
  const urls = ((chunk.journal_post_urls as unknown[] | undefined) || []).map(String);
  const posts = (chunk.journal_posts as Array<Record<string, unknown>> | undefined) || [];
  const count = Math.max(urls.length, posts.length);
  const sets: string[][] = [];
  for (let index = 0; index < count; index += 1) {
    const post = posts[index] || {};
    // An older post Jamie linked to is a reference, not a copy (QA2 I2-1).
    if (!journalCopyInWeek(chunk, post)) continue;
    const keys = new Set<string>();
    if (urls[index]) keys.add(`url:${urls[index]}`);
    if (post.url) keys.add(`url:${String(post.url)}`);
    if (post.canonical_url) keys.add(`url:${String(post.canonical_url)}`);
    if (post.copy_of_microblog_id != null) keys.add(`id:${String(post.copy_of_microblog_id)}`);
    sets.push([...keys]);
  }
  return sets;
}

// A Journal copy reprints a post from the issue's own week. The corpus
// build also paired permalinks in Journal prose ("Also see 2021 and
// 2015.", WT337's escape-room list) with the old posts they link to, and
// the dedupe then dropped new writing as a "copy" whenever that old post
// surfaced (QA2 I2-1: wt-212, wt-264, wt-267, wt-274, wt-333). Until the
// build applies its own issue window, a post counts as copied only when
// its Chicago day (or its permalink day) falls in [previous issue - 3
// days, this issue + 1 day]. A chunk, issue or post the loaded corpora do
// not know keeps its pairing.
const JOURNAL_WEEK_BEFORE_DAYS = 3;
const JOURNAL_WEEK_AFTER_DAYS = 1;
const ISSUE_WEEKS = new WeakMap<Corpus, Map<string, [string, string]>>();
const POST_DAYS = new WeakMap<Corpus, Map<string, string[]>>();
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function shiftDay(day: string, days: number) {
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) ? new Date(time + days * DAY_MS).toISOString().slice(0, 10) : day;
}

function issueWeeks(corpus: Corpus) {
  let weeks = ISSUE_WEEKS.get(corpus);
  if (weeks) return weeks;
  const dated = (corpus.issues || [])
    .map((issue) => [String(issue.number), localDay(issue)] as const)
    .filter(([, day]) => DAY_SHAPE.test(day))
    .sort((a, b) => a[1].localeCompare(b[1]));
  weeks = new Map();
  dated.forEach(([number, day], index) => {
    const from = index ? shiftDay(dated[index - 1][1], -JOURNAL_WEEK_BEFORE_DAYS) : '0000-00-00';
    weeks!.set(number, [from, shiftDay(day, JOURNAL_WEEK_AFTER_DAYS)]);
  });
  ISSUE_WEEKS.set(corpus, weeks);
  return weeks;
}

function postDays(corpus: Corpus) {
  let days = POST_DAYS.get(corpus);
  if (days) return days;
  days = new Map();
  for (const post of (corpus.posts as Array<Record<string, unknown>> | undefined) || []) {
    const both = [localDay(post), String(post.publish_date || '').slice(0, 10)].filter((day) => DAY_SHAPE.test(day));
    if (both.length) days.set(String(post.microblog_id), [...new Set(both)]);
  }
  POST_DAYS.set(corpus, days);
  return days;
}

function journalCopyInWeek(chunk: CorpusChunk, post: Record<string, unknown>) {
  if (post?.copy_of_microblog_id == null || !corpusCache || !blogCorpusCache) return true;
  const week = issueWeeks(corpusCache).get(String(chunk.issue_number ?? ''));
  const days = postDays(blogCorpusCache).get(String(post.copy_of_microblog_id));
  if (!week || !days) return true;
  return days.some((day) => day >= week[0] && day <= week[1]);
}

// The journal_posts entries that are copies: the ones from the issue's own
// week (copy_of names only these).
export function journalCopyPosts(chunk: CorpusChunk): Array<Record<string, unknown>> {
  return ((chunk.journal_posts as Array<Record<string, unknown>> | undefined) || []).filter(
    (post) => post && journalCopyInWeek(chunk, post)
  );
}

export function dedupeJournalTwins(candidates: CorpusChunk[]): CorpusChunk[] {
  const postsByKey = new Map<string, CorpusChunk[]>();
  const add = (key: string, candidate: CorpusChunk) => postsByKey.set(key, [...(postsByKey.get(key) || []), candidate]);
  for (const candidate of candidates) {
    if (candidate.source_kind !== 'blog') continue;
    if (candidate.url) add(`url:${String(candidate.url)}`, candidate);
    if (candidate.microblog_id != null) add(`id:${String(candidate.microblog_id)}`, candidate);
  }
  if (!postsByKey.size) return candidates;
  return candidates.filter((candidate) => {
    if (candidate.source_kind === 'blog') return true;
    const posts = journalPostKeySets(candidate);
    if (!posts.length) return true;
    return !posts.every((keys) =>
      showsCopiedWords(candidate, [...new Set(keys.flatMap((key) => postsByKey.get(key) || []))])
    );
  });
}

// Does the page show the words a Journal copy took from one post? A post
// the loaded blog corpus holds as one passage always does. For a longer
// post, the copy's share is every run of PASSAGE_RUN_WORDS words (case,
// punctuation and link targets aside) it has in common with any passage
// of the post, and the page shows the copy when its passages of that post
// hold at least half of the share. A copy that shares no run with any
// passage (a teaser written for the issue) is its own words and stays.
const PASSAGE_RUN_WORDS = 5;
const POST_PASSAGES = new WeakMap<Corpus, Map<string, CorpusChunk[]>>();

function postKey(chunk: CorpusChunk) {
  return chunk.microblog_id != null ? `id:${String(chunk.microblog_id)}` : `url:${String(chunk.url || '')}`;
}

function postPassages(post: CorpusChunk): CorpusChunk[] {
  if (!blogCorpusCache) return [post];
  let passages = POST_PASSAGES.get(blogCorpusCache);
  if (!passages) {
    passages = new Map();
    for (const chunk of blogCorpusCache.chunks || []) {
      if (chunk.source_kind && chunk.source_kind !== 'blog') continue;
      const key = postKey(chunk);
      passages.set(key, [...(passages.get(key) || []), chunk]);
    }
    POST_PASSAGES.set(blogCorpusCache, passages);
  }
  return passages.get(postKey(post)) || [post];
}

export function passageRuns(text: unknown) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/\]\([^)]*\)/g, '] ')
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const runs = new Set<string>();
  for (let index = 0; index + PASSAGE_RUN_WORDS <= words.length; index += 1) {
    runs.add(words.slice(index, index + PASSAGE_RUN_WORDS).join(' '));
  }
  return runs;
}

function showsCopiedWords(copy: CorpusChunk, shown: CorpusChunk[]) {
  const byPost = new Map<string, CorpusChunk[]>();
  for (const passage of shown) byPost.set(postKey(passage), [...(byPost.get(postKey(passage)) || []), passage]);
  let copyRuns: Set<string> | undefined;
  const inAny = (texts: unknown[]) => {
    copyRuns ||= passageRuns(copy.text);
    const found = new Set<string>();
    for (const text of texts) for (const run of passageRuns(text)) if (copyRuns.has(run)) found.add(run);
    return found.size;
  };
  return [...byPost.values()].some((onPage) => {
    const passages = postPassages(onPage[0]);
    if (passages.length <= 1) return true;
    const share = inAny(passages.map((passage) => passage.text));
    return share > 0 && inAny(onPage.map((passage) => passage.text)) * 2 >= share;
  });
}
