import { compileQuery } from './matcher.mjs';
import type { CanonicalMatcher } from './matcher.mjs';
import { countsByPublishYear, yearCountSummary, yearFromPublishDate } from './corpus-stats.mjs';

const DEFAULT_LIMIT = 18;

export interface LensItem {
  source_kind?: string;
  issue_number?: string | number | null;
  episode_number?: string | number;
  microblog_id?: string | number;
  show?: string;
  subject?: string;
  title?: string;
  publish_date?: string;
  section?: string;
  summary?: string;
  text?: string;
  url?: string;
  transcript_url?: string;
  audio_url?: string;
  also_in_issues?: unknown;
  topics?: string[] | Set<string>;
  domains?: string[] | Set<string>;
  [key: string]: unknown;
}

interface LensSource extends LensItem {
  match_count: number;
  strict: boolean;
  sections: Set<string>;
  topics: Set<string>;
  domains: Set<string>;
  match_reasons: Set<string>;
  evidence: Array<{ section: string; text: string; matched: string; matched_term: string; match_mode: string }>;
}

interface ArchiveLensInput {
  aliases?: string[];
  matchMode?: unknown;
  caseSensitive?: boolean;
  topic?: unknown;
  operation?: unknown;
  records?: LensItem[];
  chunks?: LensItem[];
  yearRange?: unknown;
  limit?: number;
}

interface YearBucket {
  year: number;
  source_count: number;
  evidence_count: number;
  sources: string[];
  sections: Map<string, number>;
  domains: Map<string, number>;
}

interface SourceBucket {
  source_kind: string;
  source_count: number;
  evidence_count: number;
  dates: string[];
  sources: string[];
}

function compactWhitespace(value: unknown) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeLensOperation(value: unknown) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (['first', 'last', 'first_last', 'first_and_last', 'earliest_latest'].includes(raw)) return 'first_last';
  if (['year', 'years', 'by_year', 'yearly', 'themes_by_year'].includes(raw)) return 'by_year';
  if (['sources', 'source', 'source_compare', 'compare_sources', 'by_source'].includes(raw)) return 'source_compare';
  if (['reading_path', 'path', 'tour', 'route'].includes(raw)) return 'reading_path';
  return 'timeline';
}

export function parseLensYearRange(value: unknown): [number | null, number | null] {
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

function inYearRange(item: LensItem, yearRange: unknown) {
  const [start, end] = parseLensYearRange(yearRange);
  const year = yearFromPublishDate(item.publish_date);
  if (start && (!year || year < start)) return false;
  if (end && (!year || year > end)) return false;
  return true;
}

// The lens matching layer is an adapter over the canonical matcher
// (shared/matcher.mts). No lens-private comparison semantics remain.
export interface TopicMatcher extends CanonicalMatcher {
  findMatch: (text: string) => { index: number; match: string; term: string; mode: string } | null;
  findIndex: (text: string) => number;
}

function adapt(matcher: CanonicalMatcher): TopicMatcher {
  return {
    ...matcher,
    findMatch(text: string) {
      const hit = matcher.firstHit(text);
      return hit ? { index: hit.offset, match: hit.span, term: hit.term, mode: hit.mode } : null;
    },
    findIndex(text: string) {
      return matcher.firstHit(text)?.offset ?? -1;
    }
  };
}

export function compileTopicMatcher(
  topic: unknown,
  options: { mode?: unknown; aliases?: unknown[]; caseSensitive?: boolean } = {}
): TopicMatcher {
  return adapt(
    compileQuery({
      term: topic,
      aliases: options.aliases || [],
      mode: options.mode,
      caseSensitive: options.caseSensitive === true
    })
  );
}

export function compileMultiTopicMatcher(terms: unknown[]): TopicMatcher {
  const [primary, ...aliases] = terms.filter((term) => String(term || '').trim());
  return adapt(compileQuery({ term: primary || '', aliases }));
}

function lensHaystack(item: LensItem) {
  return compactWhitespace(
    [
      item.subject,
      item.title,
      item.section,
      item.summary,
      item.text,
      Array.from(item.topics || []).join(' '),
      Array.from(item.domains || []).join(' ')
    ].join(' ')
  );
}

export function matchesLensTopic(item: LensItem, topic: unknown, matcher?: TopicMatcher) {
  const compiled = matcher || compileTopicMatcher(topic);
  if (compiled.isEmpty) return true;
  return compiled.matches(lensHaystack(item));
}

// Reasons attribute the SPECIFIC span that hit - "text: 'ethereum name
// service'" - never a bag of query tokens.
export function lensMatchReasons(item: LensItem, topic: unknown, matcher?: TopicMatcher) {
  const compiled = matcher || compileTopicMatcher(topic);
  if (compiled.isEmpty) return [] as Array<{ field: string; match: string }>;
  const fields: Array<[string, unknown]> = [
    ['subject', item.subject],
    ['title', item.title],
    ['section', item.section],
    ['summary', item.summary],
    ['text', item.text],
    ['topics', Array.from(item.topics || []).join(' ')],
    ['domains', Array.from(item.domains || []).join(' ')]
  ];
  const reasons: Array<{ field: string; match: string }> = [];
  for (const [field, value] of fields) {
    const text = compactWhitespace(value);
    if (!text) continue;
    // Every matched variant, deduped case-insensitively, so two sources
    // with the same underlying hits report the same reasons regardless of
    // occurrence order (wt-178 once omitted the literal variant wt-179
    // reported).
    const spans = [];
    const seen = new Set();
    for (const hit of compiled.hits(text)) {
      const key = hit.span.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      spans.push(`'${hit.span}'`);
    }
    if (spans.length) reasons.push({ field, match: spans.slice(0, 3).join(', ') });
  }
  return reasons;
}

// Readable stable id for the sources_by_id map: wt-300, blog-987,
// ep-4, or the url tail.
export function lensSourceId(item: LensItem) {
  if (item.issue_number !== undefined && item.issue_number !== null && String(item.issue_number) !== '') {
    return `wt-${item.issue_number}`;
  }
  if (item.episode_number !== undefined && item.episode_number !== null && String(item.episode_number) !== '') {
    return `ep-${item.episode_number}`;
  }
  if (item.microblog_id !== undefined && item.microblog_id !== null && String(item.microblog_id) !== '') {
    return `blog-${item.microblog_id}`;
  }
  const tail = String(item.url || '')
    .replace(/\/+$/, '')
    .split('/')
    .at(-1);
  return `${normalizeLensSourceKind(item.source_kind)}-${tail || 'unknown'}`;
}

function sourceKey(item: LensItem) {
  // One identity per real source: a chunk that carries a url and a record
  // that carries the same url plus a microblog_id must collapse into one
  // entry (they previously produced duplicate results with different
  // match_reasons).
  const identity =
    String(item.issue_number ?? '') ||
    String(item.episode_number ?? '') ||
    String(item.url || '').replace(/\/+$/, '') ||
    String(item.microblog_id ?? '');
  return [normalizeLensSourceKind(item.source_kind), identity].join('\0');
}

// "chunk" is an internal storage type; the public enum is
// weekly_thing | blog | podcast (defect: chunk leaked into lens results).
const PUBLIC_SOURCE_KINDS = new Set(['weekly_thing', 'blog', 'podcast']);
function normalizeLensSourceKind(value: unknown) {
  const raw = String(value || '').toLowerCase();
  return PUBLIC_SOURCE_KINDS.has(raw) ? raw : 'weekly_thing';
}

function sourceFromChunk(chunk: LensItem): LensItem {
  return {
    source_kind: normalizeLensSourceKind(chunk.source_kind),
    issue_number: chunk.issue_number ?? null,
    microblog_id: chunk.microblog_id,
    episode_number: chunk.episode_number,
    show: chunk.show,
    subject: chunk.subject || '',
    publish_date: chunk.publish_date || '',
    section: chunk.section || '',
    url: chunk.url || (chunk.issue_number ? `/archive/${chunk.issue_number}/` : ''),
    transcript_url: chunk.transcript_url,
    audio_url: chunk.audio_url,
    also_in_issues: chunk.also_in_issues,
    topics: chunk.topics || [],
    domains: chunk.domains || []
  };
}

function mergeSource(existing: LensSource, chunk: LensItem, topic: unknown, matcher?: TopicMatcher) {
  existing.match_count += 1;
  const compiledForStrict = matcher || compileTopicMatcher(topic);
  if (!existing.strict && compiledForStrict.matchesStrict(lensHaystack(chunk))) existing.strict = true;
  existing.sections.add(chunk.section || '');
  for (const domain of chunk.domains || []) existing.domains.add(domain);
  for (const sourceTopic of chunk.topics || []) existing.topics.add(sourceTopic);
  for (const reason of lensMatchReasons(chunk, topic, matcher))
    existing.match_reasons.add(`${reason.field}: ${reason.match}`);
  // Evidence must DEMONSTRATE the match: only chunks whose text actually
  // contains the term contribute a snippet, the window centers on the
  // match offset, and the matched span rides along so an agent can verify
  // the hit. (Previously snippets were cut from the chunk start even when
  // the match was in subject/topics, producing evidence without the term.)
  if (existing.evidence.length < 3) {
    const compiled = matcher || compileTopicMatcher(topic);
    const clean = compactWhitespace(chunk.text || '');
    // Matching runs on the original-case text: the matched span is the
    // canonical text at its actual offset (a lowercased haystack once made
    // every span read as lowercase).
    const found = clean ? compiled.findMatch(clean) : null;
    if (found) {
      // Front-load the window: at most 60 chars of context BEFORE the match
      // so no downstream text cap can slice the matched span out of its own
      // snippet (a 140-char prefix once put the match past a 120-char cap -
      // snippets that ended exactly where the proof began).
      existing.evidence.push({
        section: chunk.section || '',
        text: clean.slice(Math.max(0, found.index - 60), Math.min(clean.length, found.index + 180)),
        matched: found.match,
        matched_term: found.term,
        match_mode: found.mode
      });
    }
  }
}

function compactLensSource(item: LensSource) {
  return {
    id: lensSourceId(item),
    source_kind: item.source_kind,
    issue_number: item.issue_number ?? null,
    microblog_id: item.microblog_id,
    episode_number: item.episode_number,
    show: item.show,
    subject: item.subject,
    publish_date: item.publish_date,
    year: yearFromPublishDate(item.publish_date) || null,
    section: item.section || '',
    sections: Array.from(item.sections || [])
      .filter(Boolean)
      .slice(0, 8),
    url: item.url,
    transcript_url: item.transcript_url,
    audio_url: item.audio_url,
    also_in_issues: item.also_in_issues,
    match_count: item.match_count || 0,
    strict_match: Boolean(item.strict),
    topics: Array.from(item.topics || [])
      .filter(Boolean)
      .slice(0, 12),
    domains: Array.from(item.domains || [])
      .filter(Boolean)
      .slice(0, 12),
    match_reasons: Array.from(item.match_reasons || []).slice(0, 8),
    evidence: item.evidence || []
  };
}

function sortByDateAsc<T extends LensItem>(items: T[]): T[] {
  return [...items].sort((a, b) => String(a.publish_date || '').localeCompare(String(b.publish_date || '')));
}

function topCounts(map: Map<string, number>, key: string, limit = 10) {
  return Array.from(map.entries())
    .filter(([name]) => name)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ [key]: name, count }));
}

function yearBuckets(items: LensSource[]) {
  const buckets = new Map<number, YearBucket>();
  for (const item of items) {
    const year = yearFromPublishDate(item.publish_date);
    if (!year) continue;
    if (!buckets.has(year)) {
      buckets.set(year, {
        year,
        source_count: 0,
        evidence_count: 0,
        sources: [],
        sections: new Map(),
        domains: new Map()
      });
    }
    const bucket = buckets.get(year)!;
    bucket.source_count += 1;
    bucket.evidence_count += item.match_count || 0;
    for (const section of item.sections || []) bucket.sections.set(section, (bucket.sections.get(section) || 0) + 1);
    for (const domain of item.domains || []) bucket.domains.set(domain, (bucket.domains.get(domain) || 0) + 1);
    if (bucket.sources.length < 5) bucket.sources.push(lensSourceId(item));
  }
  return Array.from(buckets.values())
    .sort((a, b) => b.year - a.year)
    .map((bucket) => ({
      year: bucket.year,
      source_count: bucket.source_count,
      evidence_count: bucket.evidence_count,
      top_sections: topCounts(bucket.sections, 'section', 6),
      top_domains: topCounts(bucket.domains, 'domain', 6),
      sample_sources: bucket.sources
    }));
}

function sourceBuckets(items: LensSource[]) {
  const buckets = new Map<string, SourceBucket>();
  for (const item of items) {
    const key = item.source_kind || 'unknown';
    if (!buckets.has(key)) {
      buckets.set(key, {
        source_kind: key,
        source_count: 0,
        evidence_count: 0,
        dates: [],
        sources: []
      });
    }
    const bucket = buckets.get(key)!;
    bucket.source_count += 1;
    bucket.evidence_count += item.match_count || 0;
    if (item.publish_date) bucket.dates.push(item.publish_date);
    if (bucket.sources.length < 6) bucket.sources.push(lensSourceId(item));
  }
  return Array.from(buckets.values())
    .sort((a, b) => b.source_count - a.source_count || a.source_kind.localeCompare(b.source_kind))
    .map((bucket) => ({
      source_kind: bucket.source_kind,
      source_count: bucket.source_count,
      evidence_count: bucket.evidence_count,
      first_publish_date: bucket.dates.sort()[0] || '',
      latest_publish_date: bucket.dates.sort().at(-1) || '',
      sample_sources: bucket.sources
    }));
}

function readingPath(items: LensSource[], limit: number) {
  const chronological = sortByDateAsc(items);
  if (!chronological.length) return [];
  const chosen = new Map<string, { id: string; reason: string }>();
  const add = (item: LensSource | undefined, reason: string) => {
    if (!item) return;
    chosen.set(sourceKey(item), { id: lensSourceId(item), reason });
  };
  add(chronological[0], 'earliest matched source');
  const buckets = yearBuckets(items).sort((a, b) => b.evidence_count - a.evidence_count);
  const densestYear = buckets[0]?.year;
  add(
    densestYear ? items.find((item) => yearFromPublishDate(item.publish_date) === densestYear) : undefined,
    'densest year for this topic'
  );
  add(chronological[Math.floor(chronological.length / 2)], 'middle-era bridge');
  add(chronological.at(-1), 'latest matched source');
  for (const item of chronological) {
    if (chosen.size >= limit) break;
    add(item, 'additional representative source');
  }
  return Array.from(chosen.values()).slice(0, limit);
}

export function buildArchiveLens({
  topic = '',
  aliases = [],
  matchMode = null,
  caseSensitive = false,
  operation = 'timeline',
  records = [],
  chunks = [],
  yearRange = null,
  limit = DEFAULT_LIMIT
}: ArchiveLensInput = {}) {
  const normalizedOperation = normalizeLensOperation(operation);
  const maxResults = Math.min(Math.max(Number(limit || DEFAULT_LIMIT), 1), 40);
  const sources = new Map<string, LensSource>();
  // One compiled matcher per scan - the regexes are built once, not per item.
  const matcher = adapt(
    compileQuery({ term: topic, aliases: aliases || [], mode: matchMode, caseSensitive: caseSensitive === true })
  );
  let consideredCount = 0;

  for (const record of records || []) {
    if (!inYearRange(record, yearRange)) continue;
    consideredCount += 1;
    if (!matchesLensTopic(record, topic, matcher)) continue;
    const source: LensSource = {
      ...record,
      source_kind: normalizeLensSourceKind(record.source_kind),
      strict: matcher.matchesStrict(lensHaystack(record)),
      match_count: 1,
      sections: new Set([record.section || '']),
      topics: new Set(record.topics || []),
      domains: new Set(record.domains || []),
      match_reasons: new Set(
        lensMatchReasons(record, topic, matcher).map((reason) => `${reason.field}: ${reason.match}`)
      ),
      evidence: []
    };
    sources.set(sourceKey(source), source);
  }

  for (const chunk of chunks || []) {
    if (!inYearRange(chunk, yearRange) || !matchesLensTopic(chunk, topic, matcher)) continue;
    const key = sourceKey(chunk);
    if (!sources.has(key)) {
      const source = sourceFromChunk(chunk);
      sources.set(key, {
        ...source,
        strict: false,
        match_count: 0,
        sections: new Set([source.section || '']),
        topics: new Set(source.topics || []),
        domains: new Set(source.domains || []),
        match_reasons: new Set(
          lensMatchReasons(chunk, topic, matcher).map((reason) => `${reason.field}: ${reason.match}`)
        ),
        evidence: []
      });
    }
    mergeSource(sources.get(key)!, chunk, topic, matcher);
  }

  const matched = sortByDateAsc(Array.from(sources.values()).filter((item) => item.publish_date));
  // first/latest may be determined ONLY by exact/phrase matches - one
  // spurious stem hit rewriting the headline answer is the round-five
  // failure this makes structurally impossible.
  const strictMatched = matched.filter((item) => item.strict);
  const countsByYear = countsByPublishYear(matched);
  const timelineIds = matched.slice(0, maxResults).map(lensSourceId);
  const latestIds = [...matched].reverse().slice(0, maxResults).map(lensSourceId);
  const years = yearBuckets(matched);
  const bySource = sourceBuckets(matched);
  const path = readingPath(matched, Math.min(maxResults, 8));
  const resultIds =
    normalizedOperation === 'first_last'
      ? Array.from(
          new Set(
            [strictMatched[0], strictMatched.at(-1)]
              .filter((item): item is LensSource => Boolean(item))
              .map(lensSourceId)
          )
        )
      : normalizedOperation === 'reading_path'
        ? path.map((entry) => entry.id)
        : normalizedOperation === 'source_compare'
          ? bySource.flatMap((bucket) => bucket.sample_sources).slice(0, maxResults)
          : normalizedOperation === 'by_year'
            ? years.flatMap((bucket) => bucket.sample_sources.slice(0, 2)).slice(0, maxResults)
            : timelineIds;

  // Every full source record appears exactly once, keyed by id; every
  // other section references ids. (Previously the identical record - with
  // evidence and domains - could be serialized six times per response.)
  const referenced = new Set<string>([
    ...timelineIds,
    ...latestIds,
    ...resultIds,
    ...path.map((entry) => entry.id),
    ...years.flatMap((bucket) => bucket.sample_sources),
    ...bySource.flatMap((bucket) => bucket.sample_sources)
  ]);
  // Insertion order = citation priority (results, then timeline/latest,
  // then bucket samples) so a downstream size cap drops the least
  // important records first.
  const byId = new Map(matched.map((item) => [lensSourceId(item), item]));
  const priorityOrder = [
    ...resultIds,
    ...timelineIds,
    ...latestIds,
    ...path.map((entry) => entry.id),
    ...years.flatMap((bucket) => bucket.sample_sources),
    ...bySource.flatMap((bucket) => bucket.sample_sources)
  ];
  const sourcesById: Record<string, ReturnType<typeof compactLensSource>> = {};
  for (const id of priorityOrder) {
    const item = byId.get(id);
    if (item && referenced.has(id) && !sourcesById[id]) sourcesById[id] = compactLensSource(item);
  }

  return {
    operation: normalizedOperation,
    topic: compactWhitespace(topic),
    total_sources: matched.length,
    total_evidence_matches: matched.reduce((sum, item) => sum + (item.match_count || 0), 0),
    counts_by_year: countsByYear,
    year_count_summary: yearCountSummary(countsByYear),
    sources_by_id: sourcesById,
    match_mode: matcher.appliedMode,
    case_sensitive: caseSensitive === true || undefined,
    // Common-word advisory: when the term hits most in-scope sources the
    // ranking is undifferentiated - tell the agent to reformulate instead
    // of trusting first_last (MATCHER.md, common-word-term policy).
    term_frequency_note:
      consideredCount >= 10 && matched.length / consideredCount > 0.5
        ? `'${compactWhitespace(topic)}' matches ${Math.round((matched.length / consideredCount) * 100)}% of in-scope sources; results are likely undifferentiated - consider a more specific phrase, case_sensitive: true, or a narrower year_range`
        : undefined,
    first: strictMatched[0] ? lensSourceId(strictMatched[0]) : null,
    latest: strictMatched.at(-1) ? lensSourceId(strictMatched.at(-1)!) : null,
    results: resultIds,
    timeline: timelineIds,
    latest_sources: latestIds,
    years,
    sources: bySource,
    reading_path: path
  };
}
