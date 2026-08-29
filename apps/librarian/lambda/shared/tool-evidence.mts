/**
 * Bounded structured evidence from tool results, persisted in the turn's
 * tool trace so the Improve Thingy evaluator can judge grounding from exact
 * production evidence: which sources each successful call surfaced, in what
 * order, with what scores, and a few short supporting excerpts.
 *
 * Two invariants:
 * - Allow-list only. Evidence refs copy a fixed set of archive fields; an
 *   arbitrary/private field on a tool result never reaches DynamoDB.
 * - Bounded per call AND per trace, degrading gracefully. A fat call loses
 *   its excerpts, then its source list - never the whole trace. The old
 *   behavior (one oversized call turning the entire trace into
 *   `{omitted: true}`) is exactly the failure this module removes.
 */

type JsonRecord = Record<string, unknown>;

export const TOOL_TRACE_SCHEMA_VERSION = 2;

// Bounds. A worst-case trace of ~12 calls at the per-call cap stays well
// under the storage cap, and the storage cap stays far below DynamoDB's
// 400KB item limit alongside question/answer/artifact fields.
export const EVIDENCE_MAX_SOURCES = 8;
export const EVIDENCE_EXCERPT_CHARS = 240;
export const EVIDENCE_MAX_CALL_CHARS = 2800;
export const EVIDENCE_MAX_COUNT_KEYS = 12;

const SOURCE_ID_FIELDS = ['id', 'chunk_id', 'source_id'] as const;
const EXCERPT_FIELDS = [
  'text',
  'excerpt',
  'quote',
  'snippet',
  'preview',
  'context',
  'summary',
  'description',
  'alt',
  'body'
] as const;
// Result keys whose arrays are known to carry source-like records, plus a
// shape sniff for everything else so new tools inherit evidence for free.
const SOURCE_SHAPE_FIELDS = [
  'issue_number',
  'url',
  'subject',
  'title',
  'permalink',
  'domain',
  'label',
  'image_url'
] as const;

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function compactText(value: unknown, maxChars: number) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function looksLikeSource(value: unknown): value is JsonRecord {
  const record = objectValue(value);
  return SOURCE_SHAPE_FIELDS.some((field) => record[field] !== undefined && record[field] !== null);
}

function stableSourceId(record: JsonRecord) {
  for (const field of SOURCE_ID_FIELDS) {
    if (record[field] !== undefined && record[field] !== null && record[field] !== '') {
      return compactText(record[field], 120);
    }
  }
  const issue = compactText(record.issue_number ?? record.issue ?? record.number, 12);
  const section = compactText(record.section, 40);
  if (issue) return section ? `wt:${issue}#${section}` : `wt:${issue}`;
  const url = compactText(record.url || record.permalink || record.post_url || record.image_url, 200);
  if (url) return url;
  const domain = compactText(record.domain, 120);
  if (domain) return `domain:${domain}`;
  return '';
}

function firstExcerpt(record: JsonRecord) {
  for (const field of EXCERPT_FIELDS) {
    const text = compactText(record[field], EVIDENCE_EXCERPT_CHARS);
    if (text) return text;
  }
  return '';
}

function scoreOf(record: JsonRecord) {
  const score = record.score ?? record._rerank_score ?? record._retrieval_score;
  const value = Number(score);
  return Number.isFinite(value) && score !== null && score !== undefined && score !== '' ? value : undefined;
}

// One evidence reference: allow-listed archive identity + rank/score + a
// bounded excerpt. Nothing else from the record survives.
export function evidenceRef(value: unknown, rank: number): JsonRecord {
  const record = objectValue(value);
  const ref: JsonRecord = { rank };
  const id = stableSourceId(record);
  if (id) ref.id = id;
  const issue = compactText(record.issue_number ?? record.issue ?? record.number, 12);
  if (issue) ref.issue_number = issue;
  const kind = compactText(record.source_kind || record.corpus_kind || record.kind, 40);
  if (kind) ref.source_kind = kind;
  const title = compactText(record.subject || record.title || record.label || record.entity || record.domain, 160);
  if (title) ref.title = title;
  // media_search names the page an image appeared on source_url; that is
  // the ref's url, while image_url below names the exact image itself.
  const url = compactText(record.url || record.permalink || record.post_url || record.source_url, 300);
  if (url) ref.url = url;
  const imageUrl = compactText(record.image_url, 300);
  if (imageUrl) ref.image_url = imageUrl;
  const date = compactText(record.publish_date || record.date || record.issue_year || record.year, 40);
  if (date) ref.publish_date = date;
  const section = compactText(record.section, 60);
  if (section) ref.section = section;
  const score = scoreOf(record);
  if (score !== undefined) ref.score = Math.round(score * 10000) / 10000;
  const count = Number(record.count ?? record.mentions ?? record.total);
  if (Number.isFinite(count) && count > 0) ref.count = count;
  const excerpt = firstExcerpt(record);
  if (excerpt) ref.excerpt = excerpt;
  return ref;
}

interface HarvestState {
  refs: JsonRecord[];
  seen: number;
}

function harvest(value: unknown, state: HarvestState, depth: number) {
  if (state.refs.length >= EVIDENCE_MAX_SOURCES * 3 || depth > 2) return;
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 40)) {
      if (looksLikeSource(entry)) {
        state.seen += 1;
        if (state.refs.length < EVIDENCE_MAX_SOURCES * 3) state.refs.push(evidenceRef(entry, state.seen));
      } else {
        harvest(entry, state, depth + 1);
      }
    }
    return;
  }
  const record = objectValue(value);
  for (const entry of Object.values(record)) {
    if (Array.isArray(entry) || (entry && typeof entry === 'object')) harvest(entry, state, depth + 1);
  }
}

// Structured, bounded summary of one tool result. Handles list-shaped
// results (search/list/link/lens tools), single-source results
// (get_source/get_issue/get_section), aggregation results
// (top_references/currently_history/corpus_stats), and error results -
// without assuming any particular envelope key.
export function summarizeToolEvidence(result: unknown): JsonRecord {
  const record = objectValue(result);
  const summary: JsonRecord = {};
  const error = compactText(record.error, 300);
  if (error) summary.error = error;

  // Per-key counts for every top-level array - the evaluator's cheapest
  // signal for "what shape came back and how much of it".
  const counts: JsonRecord = {};
  let countKeys = 0;
  for (const [key, value] of Object.entries(record)) {
    if (!Array.isArray(value)) continue;
    if (countKeys < EVIDENCE_MAX_COUNT_KEYS) {
      counts[key] = value.length;
      countKeys += 1;
    }
  }
  if (countKeys) summary.counts = counts;
  const totalCount = Number(record.total_count ?? record.total);
  if (Number.isFinite(totalCount) && totalCount > 0) summary.total_count = totalCount;

  // Scalar echo of what the call was about.
  for (const key of ['scope', 'source_kind', 'mode', 'kind'] as const) {
    const value = compactText(record[key], 60);
    if (value) summary[key] = value;
  }
  const topic = compactText(record.topic || record.theme || record.entity || record.query || record.claim, 160);
  if (topic) summary.topic = topic;

  // Evidence refs. Three shapes, in priority order:
  // - the result itself is source-shaped (get_section);
  // - a top-level envelope key holds one source-shaped object (get_issue's
  //   `issue`, get_source's `source`) - that object is the primary evidence
  //   and its inner arrays (links, section_texts) are NOT harvested as refs,
  //   because they are not what Thingy read;
  // - otherwise harvest source-like records from nested arrays.
  const state: HarvestState = { refs: [], seen: 0 };
  if (looksLikeSource(record)) {
    state.seen = 1;
    state.refs.push(evidenceRef(record, 1));
    // A flat source-shaped result may still carry evidence arrays
    // (domain_history: {domain, results: [...]}); harvest them too.
    harvest(record, state, 0);
  } else {
    const envelopes = Object.values(record).filter(
      (value) => value && typeof value === 'object' && !Array.isArray(value) && looksLikeSource(value)
    );
    for (const envelope of envelopes) {
      state.seen += 1;
      state.refs.push(evidenceRef(envelope, state.seen));
    }
    if (!envelopes.length) harvest(record, state, 0);
  }
  const sources = state.refs.slice(0, EVIDENCE_MAX_SOURCES);
  if (sources.length) summary.sources = sources;
  if (state.seen > sources.length) {
    summary.truncation = { sources_seen: state.seen, sources_kept: sources.length };
  }
  return boundEvidenceSummary(summary, EVIDENCE_MAX_CALL_CHARS);
}

function summaryChars(summary: JsonRecord) {
  try {
    return JSON.stringify(summary).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// Degrade one call's evidence until it fits: shorten excerpts, drop
// excerpts, then shrink the source list. Counts, error, and truncation
// metadata always survive.
export function boundEvidenceSummary(summary: JsonRecord, maxChars = EVIDENCE_MAX_CALL_CHARS): JsonRecord {
  if (summaryChars(summary) <= maxChars) return summary;
  const bounded: JsonRecord = { ...summary };
  const truncation = { ...objectValue(bounded.truncation) };
  let sources = (Array.isArray(bounded.sources) ? bounded.sources : []).map((ref) => ({ ...objectValue(ref) }));
  for (const ref of sources) {
    if (ref.excerpt) ref.excerpt = compactText(ref.excerpt, 80);
  }
  bounded.sources = sources;
  if (summaryChars(bounded) > maxChars) {
    for (const ref of sources) delete ref.excerpt;
    truncation.excerpts_dropped = true;
  }
  while (summaryChars(bounded) > maxChars && sources.length > 1) {
    sources = sources.slice(0, sources.length - 1);
    bounded.sources = sources;
    truncation.sources_kept = sources.length;
  }
  if (summaryChars(bounded) > maxChars) {
    delete bounded.sources;
    truncation.sources_dropped = true;
  }
  bounded.truncation = truncation;
  return bounded;
}

// --- Whole-trace bounding -------------------------------------------------

function callSkeleton(call: JsonRecord): JsonRecord {
  const result = objectValue(call.result);
  const skeleton: JsonRecord = {
    name: call.name,
    ok: call.ok,
    duration_ms: call.duration_ms,
    result: {
      ...(result.error ? { error: result.error } : {}),
      ...(result.counts ? { counts: result.counts } : {}),
      truncation: { ...objectValue(result.truncation), evidence_dropped: true }
    }
  };
  return skeleton;
}

function traceChars(trace: JsonRecord) {
  try {
    return JSON.stringify(trace).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// Fit a whole trace into maxChars without ever discarding the trace: strip
// excerpts everywhere, then reduce the largest calls to skeletons
// (order, name, ok, duration, counts always preserved).
export function boundToolTrace(trace: unknown, maxChars: number): JsonRecord {
  const record = objectValue(trace);
  const calls = (Array.isArray(record.calls) ? record.calls : []).map((call) => ({ ...objectValue(call) }));
  const bounded: JsonRecord = { ...record, calls };
  if (traceChars(bounded) <= maxChars) return bounded;

  for (const call of calls) {
    const result = objectValue(call.result);
    const sources = Array.isArray(result.sources) ? result.sources : [];
    if (!sources.length) continue;
    call.result = {
      ...result,
      sources: sources.map((ref) => {
        const clean = { ...objectValue(ref) };
        delete clean.excerpt;
        return clean;
      }),
      truncation: { ...objectValue(result.truncation), excerpts_dropped: true }
    };
  }
  if (traceChars(bounded) <= maxChars) return bounded;

  // Reduce calls to skeletons starting from the largest until it fits.
  const sized = calls
    .map((call, index) => ({ index, chars: summaryChars(call) }))
    .sort((left, right) => right.chars - left.chars);
  for (const { index } of sized) {
    calls[index] = callSkeleton(calls[index]);
    if (traceChars(bounded) <= maxChars) return bounded;
  }
  // Still oversized (pathological inputs - enormous names/inputs or call
  // counts): drop whole calls from the end, keeping the earliest ones.
  let dropped = 0;
  while (traceChars(bounded) > maxChars && calls.length) {
    calls.pop();
    dropped += 1;
    bounded.calls_dropped = dropped;
  }
  if (traceChars(bounded) <= maxChars) return bounded;
  // Last resort: metadata-only record. The bound is absolute.
  return {
    schema_version: record.schema_version,
    prompt_fingerprint: record.prompt_fingerprint,
    source_revision: record.source_revision,
    calls: [],
    calls_dropped: (Array.isArray(record.calls) ? record.calls.length : 0) || dropped,
    truncation: { trace_overflow: true }
  };
}

// --- Cumulative Bedrock usage --------------------------------------------

export interface UsageTotals extends JsonRecord {
  bedrock_calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_input_tokens: number;
  cache_write_input_tokens: number;
}

export function emptyUsageTotals(): UsageTotals {
  return {
    bedrock_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_read_input_tokens: 0,
    cache_write_input_tokens: 0
  };
}

// Accumulate one Bedrock response's usage block. Tolerates missing blocks
// and missing fields; totals fall back to input+output when the model
// omits totalTokens.
export function accumulateUsage(totals: UsageTotals, usage: unknown): UsageTotals {
  const record = objectValue(usage);
  if (!Object.keys(record).length) return totals;
  const input = Number(record.inputTokens) || 0;
  const output = Number(record.outputTokens) || 0;
  totals.bedrock_calls += 1;
  totals.input_tokens += input;
  totals.output_tokens += output;
  totals.total_tokens += Number(record.totalTokens) || input + output;
  totals.cache_read_input_tokens += Number(record.cacheReadInputTokens) || 0;
  totals.cache_write_input_tokens += Number(record.cacheWriteInputTokens) || 0;
  return totals;
}
