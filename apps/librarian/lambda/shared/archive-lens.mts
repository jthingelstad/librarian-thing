import { compileQuery } from './matcher.mjs';
import type { CanonicalMatcher } from './matcher.mjs';
import { countsByPublishYear, yearCountSummary, yearFromPublishDate } from './corpus-stats.mjs';
import { blogKeyPart, blogSourceId, hasBlogIdentity } from './source-identity.mjs';

const DEFAULT_LIMIT = 18;

export interface LensItem {
  source_kind?: string;
  issue_number?: string | number | null;
  episode_number?: string | number;
  microblog_id?: string | number;
  page_id?: string | number;
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
  linked_from_issues?: unknown;
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
  offset?: number;
  linkDomains?: Map<string, Map<string, number>>;
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
  namesLabel: (labels: unknown) => string | null;
}

function labelKey(value: unknown) {
  return compactWhitespace(value).toLowerCase();
}

function adapt(matcher: CanonicalMatcher): TopicMatcher {
  const termKeys = new Set(matcher.terms.map((entry) => labelKey(entry.term)).filter(Boolean));
  return {
    ...matcher,
    // Topic labels ("Open web and RSS") are issue-level keyword counts
    // (librarian-core detect_topics), not evidence: the RSS label sits on
    // 8,856 of 8,930 Weekly Thing chunks. Matched as text they made "RSS"
    // hit 349 issues when 89 say it. A label matches only when the query
    // names the WHOLE label, so a lens over a list_topics cluster works.
    namesLabel(labels: unknown) {
      if (!termKeys.size) return null;
      for (const label of Array.from((labels as Iterable<unknown>) || [])) {
        if (termKeys.has(labelKey(label))) return String(label);
      }
      return null;
    },
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

// Section names the corpus build or the tools made up, not headings Jamie
// wrote: every micropost "mentioned" micropost (8,059 lens hits, 0 in
// text) until they left the haystack (QA 2026-09-30 L8).
export const SYNTHETIC_SECTIONS = new Set(
  ['Issue', 'Blog post', 'Micropost', 'Episode', 'Transcript', 'Show notes', 'Page', 'Source', 'post'].map((name) =>
    name.toLowerCase()
  )
);

// The fields a topic is matched in, with their names for match_reasons -
// the one haystack archive_lens and list_content share. Topic labels are
// NOT in it (see namesLabel). A voiced passage (voice=quoted) matches in its
// voiced text only: a heading or a domain is nobody's voice (L2).
export function matchFields(item: LensItem): Array<[string, string]> {
  const section = String(item.section || '');
  const fields: Array<[string, unknown]> = item.voiced
    ? [['text', item.text]]
    : [
        ['subject', item.subject],
        ['title', item.title],
        ['section', SYNTHETIC_SECTIONS.has(section.toLowerCase()) ? '' : section],
        ['summary', item.summary],
        ['text', item.text],
        ['domains', Array.from(item.domains || []).join(' ')]
      ];
  return fields
    .map(([field, value]) => [field, compactWhitespace(value)] as [string, string])
    .filter(([, value]) => value);
}

function lensHaystack(item: LensItem) {
  return matchFields(item)
    .map(([, value]) => value)
    .join(' ');
}

export function matchesLensTopic(item: LensItem, topic: unknown, matcher?: TopicMatcher) {
  const compiled = matcher || compileTopicMatcher(topic);
  if (compiled.isEmpty) return true;
  return compiled.matches(lensHaystack(item)) || (!item.voiced && Boolean(compiled.namesLabel(item.topics)));
}

// A whole-label hit is exact by construction, so it counts as strict.
function matchesLensStrict(item: LensItem, matcher: TopicMatcher) {
  return matcher.matchesStrict(lensHaystack(item)) || (!item.voiced && Boolean(matcher.namesLabel(item.topics)));
}

// Reasons attribute the SPECIFIC span that hit - "text: 'ethereum name
// service'" - never a bag of query tokens.
export function lensMatchReasons(item: LensItem, topic: unknown, matcher?: TopicMatcher) {
  const compiled = matcher || compileTopicMatcher(topic);
  if (compiled.isEmpty) return [] as Array<{ field: string; match: string }>;
  const reasons: Array<{ field: string; match: string }> = [];
  for (const [field, text] of matchFields(item)) {
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
  const label = item.voiced ? '' : compiled.namesLabel(item.topics);
  if (label) reasons.push({ field: 'topics', match: `'${label}'` });
  return reasons;
}

// Readable stable id for the sources_by_id map: wt-300, blog-987, page-57851, ep-4,
// site-about / site-members / site-faq for the Weekly Thing's own pages
// (they had come out as weekly_thing-about, which nothing opened), or the
// url tail.
export function lensSourceId(item: LensItem) {
  if (item.issue_number !== undefined && item.issue_number !== null && String(item.issue_number) !== '') {
    return `wt-${item.issue_number}`;
  }
  if (item.episode_number !== undefined && item.episode_number !== null && String(item.episode_number) !== '') {
    return `ep-${item.episode_number}`;
  }
  const blogId = blogSourceId(item);
  if (blogId) return blogId;
  const tail = String(item.url || '')
    .replace(/\/+$/, '')
    .split('/')
    .at(-1);
  if (isSitePage(item)) return `site-${tail || 'unknown'}`;
  return `${normalizeLensSourceKind(item.source_kind)}-${tail || 'unknown'}`;
}

// The about, members and FAQ pages ride the Weekly Thing corpus with no
// issue number (source_kind site_page / faq, a site-relative url).
export function isSitePage(item: LensItem) {
  const kind = String(item.source_kind || '');
  if (kind === 'site_page' || kind === 'faq') return true;
  const hasId =
    hasBlogIdentity(item) ||
    [item.issue_number, item.episode_number].some(
      (value) => value !== undefined && value !== null && String(value) !== ''
    );
  return !hasId && /^\/(?!archive\/)[^/]/.test(String(item.url || ''));
}

// A blog chunk with a url but no microblog_id (a corpus built before
// 2026-09-30, or a fixture) joins the one post at that url, as a record or
// another chunk names it; a url several posts share leaves it keyed by url,
// never merged into one of them.
function postIdFiller(records: LensItem[]) {
  const ids = new Map<string, Set<string>>();
  for (const record of records) {
    if (normalizeLensSourceKind(record.source_kind) !== 'blog' || !record.url) continue;
    if (record.microblog_id === undefined || record.microblog_id === null || record.microblog_id === '') continue;
    const url = String(record.url).replace(/\/+$/, '');
    ids.set(url, (ids.get(url) || new Set()).add(String(record.microblog_id)));
  }
  return (item: LensItem): LensItem => {
    if (hasBlogIdentity(item) || normalizeLensSourceKind(item.source_kind) !== 'blog') return item;
    const found = ids.get(String(item.url || '').replace(/\/+$/, ''));
    return found?.size === 1 ? { ...item, microblog_id: [...found][0] } : item;
  };
}

function sourceKey(item: LensItem) {
  // One identity per real source: a chunk that carries a url and a record
  // that carries the same url plus a microblog_id must collapse into one
  // entry (they previously produced duplicate results with different
  // match_reasons).
  // A blog post is its microblog_id before its url: several posts share
  // one permalink.
  const identity =
    String(item.issue_number ?? '') ||
    String(item.episode_number ?? '') ||
    blogKeyPart(item) ||
    String(item.url || '').replace(/\/+$/, '');
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
    page_id: chunk.page_id,
    episode_number: chunk.episode_number,
    show: chunk.show,
    subject: chunk.subject || '',
    publish_date: chunk.publish_date || '',
    section: chunk.section || '',
    url: chunk.url || (chunk.issue_number ? `/archive/${chunk.issue_number}/` : ''),
    transcript_url: chunk.transcript_url,
    audio_url: chunk.audio_url,
    also_in_issues: chunk.also_in_issues,
    linked_from_issues: chunk.linked_from_issues,
    topics: chunk.topics || [],
    domains: chunk.domains || []
  };
}

function mergeSource(existing: LensSource, chunk: LensItem, topic: unknown, matcher?: TopicMatcher) {
  existing.match_count += 1;
  const compiledForStrict = matcher || compileTopicMatcher(topic);
  if (!existing.strict && matchesLensStrict(chunk, compiledForStrict)) existing.strict = true;
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
    page_id: item.page_id,
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
    linked_from_issues: item.linked_from_issues,
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

// The most linked domains a year shows; domain_count says of how many.
export const LENS_YEAR_TOP_DOMAINS = 6;

// linkDomains (lens source id -> host -> links) counts each year's domains
// in links, the measure find_links and top_references use (QA2 links L9,
// L10: record domains counted documents and kept www.macstories.net apart
// from macstories.net). Without it, record domains stand in (fixtures).
function yearBuckets(items: LensSource[], linkDomains?: Map<string, Map<string, number>>) {
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
    if (linkDomains) {
      for (const [domain, count] of linkDomains.get(lensSourceId(item)) || []) {
        bucket.domains.set(domain, (bucket.domains.get(domain) || 0) + count);
      }
    } else {
      for (const domain of item.domains || []) bucket.domains.set(domain, (bucket.domains.get(domain) || 0) + 1);
    }
    if (bucket.sources.length < 5) bucket.sources.push(lensSourceId(item));
  }
  return Array.from(buckets.values())
    .sort((a, b) => b.year - a.year)
    .map((bucket) => ({
      year: bucket.year,
      source_count: bucket.source_count,
      evidence_count: bucket.evidence_count,
      top_sections: topCounts(bucket.sections, 'section', 6),
      top_domains: topCounts(bucket.domains, 'domain', LENS_YEAR_TOP_DOMAINS),
      domain_count: Array.from(bucket.domains.keys()).filter(Boolean).length,
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
  // A source chosen twice keeps both reasons ("earliest matched source;
  // densest year"); the fill loop never overwrites an anchor's reason.
  const add = (item: LensSource | undefined, reason: string) => {
    if (!item) return;
    const key = sourceKey(item);
    const existing = chosen.get(key);
    if (!existing) chosen.set(key, { id: lensSourceId(item), reason });
    else if (reason !== 'additional representative source' && !existing.reason.includes(reason))
      existing.reason = `${existing.reason}; ${reason}`;
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

// A reading path is a short tour, at most this many stops.
export const READING_PATH_MAX = 12;

export function buildArchiveLens({
  topic = '',
  aliases = [],
  matchMode = null,
  caseSensitive = false,
  operation = 'timeline',
  records = [],
  chunks = [],
  yearRange = null,
  limit = DEFAULT_LIMIT,
  offset = 0,
  linkDomains
}: ArchiveLensInput = {}) {
  const normalizedOperation = normalizeLensOperation(operation);
  const maxResults = Math.min(Math.max(Number(limit || DEFAULT_LIMIT), 1), 40);
  const requestedOffset = Math.max(0, Math.floor(Number(offset) || 0));
  // offset pages operation timeline only; the other operations answer for
  // the whole match, so a page past the first held the same answer (QA2
  // lexical L2-2: reading_path offered 22 pages and reached 7 of 148).
  const start = normalizedOperation === 'timeline' ? requestedOffset : 0;
  const sources = new Map<string, LensSource>();
  // One compiled matcher per scan - the regexes are built once, not per item.
  const matcher = adapt(
    compileQuery({ term: topic, aliases: aliases || [], mode: matchMode, caseSensitive: caseSensitive === true })
  );
  let consideredCount = 0;
  const withPostId = postIdFiller([...(records || []), ...(chunks || [])]);

  for (const record of records || []) {
    if (!inYearRange(record, yearRange)) continue;
    consideredCount += 1;
    if (!matchesLensTopic(record, topic, matcher)) continue;
    const source: LensSource = {
      ...record,
      source_kind: normalizeLensSourceKind(record.source_kind),
      strict: matchesLensStrict(record, matcher),
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

  for (const rawChunk of chunks || []) {
    if (!inYearRange(rawChunk, yearRange) || !matchesLensTopic(rawChunk, topic, matcher)) continue;
    const chunk = withPostId(rawChunk);
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
  // offset pages the timeline (2.1.0): oldest first, [offset, offset + limit).
  const timelineIds = matched.slice(start, start + maxResults).map(lensSourceId);
  const latestIds = [...matched].reverse().slice(0, maxResults).map(lensSourceId);
  const years = yearBuckets(matched, linkDomains);
  const domainsOmitted = years.reduce((sum, bucket) => sum + bucket.domain_count - bucket.top_domains.length, 0);
  const bySource = sourceBuckets(matched);
  // A reading path is a short tour: at most 12 stops (archive_gems' most).
  const path = readingPath(matched, Math.min(maxResults, READING_PATH_MAX));
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
  // `limit` bounds the map: the headline ids (results - which ARE the
  // reading path for that operation - then first and latest) always resolve, then
  // the rest fill in priority order up to `limit`. Id lists and the
  // reading path keep only ids the map holds; the counts (total_count,
  // counts_by_year, years[].source_count) stay whole.
  const firstId = strictMatched[0] ? lensSourceId(strictMatched[0]) : null;
  const latestId = strictMatched.at(-1) ? lensSourceId(strictMatched.at(-1)!) : null;
  const headline = [...resultIds, firstId, latestId].filter((id): id is string => Boolean(id));
  const fill = [
    ...path.map((entry) => entry.id),
    ...latestIds,
    ...timelineIds,
    ...years.flatMap((bucket) => bucket.sample_sources),
    ...bySource.flatMap((bucket) => bucket.sample_sources)
  ];
  // Insertion order = citation priority, so a downstream size cap drops
  // the least important records first.
  const byId = new Map(matched.map((item) => [lensSourceId(item), item]));
  const kept = new Set<string>(headline.filter((id) => byId.has(id)));
  for (const id of fill) {
    if (kept.size >= maxResults) break;
    if (byId.has(id)) kept.add(id);
  }
  const sourcesById: Record<string, ReturnType<typeof compactLensSource>> = {};
  for (const id of kept) sourcesById[id] = compactLensSource(byId.get(id)!);
  const keptOnly = (ids: string[]) => ids.filter((id) => kept.has(id));

  const payload = {
    operation: normalizedOperation,
    topic: compactWhitespace(topic),
    total_count: matched.length,
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
    first: firstId,
    latest: latestId,
    results: resultIds,
    // With operation timeline, results IS the timeline; sending both read
    // as two answers.
    ...(normalizedOperation === 'timeline' ? {} : { timeline: keptOnly(timelineIds) }),
    latest_sources: keptOnly(latestIds),
    years: years.map((bucket) => ({ ...bucket, sample_sources: keptOnly(bucket.sample_sources) })),
    sources: bySource.map((bucket) => ({ ...bucket, sample_sources: keptOnly(bucket.sample_sources) })),
    reading_path: path.filter((entry) => kept.has(entry.id)),
    ...(domainsOmitted ? { truncated: { omitted: { 'years[].top_domains': domainsOmitted } } } : {})
  };
  return settleLensTruncation(payload, { offset: requestedOffset, limit: maxResults });
}

// What a lens left out and how to read it, counted from the payload as it
// stands: archive_lens settles it again after compaction cuts
// sources_by_id, so the hint names what was sent (QA L11: it said 41 held
// when 19 were). offset pages the timeline (results, under operation
// timeline); first and latest always answer for the whole match. Under
// any other operation the answer is already whole, so no next_offset is
// offered and the hint names operation timeline as the way through every
// source (QA2 lexical L2-2).
export function settleLensTruncation<T extends object>(value: T, { offset = 0, limit = DEFAULT_LIMIT } = {}): T {
  const payload = value as Record<string, unknown>;
  const total = Number(payload.total_count) || 0;
  const held = Object.keys((payload.sources_by_id as object) || {}).length;
  const prior = (payload.truncated || {}) as { omitted?: Record<string, number>; clipped?: string[] };
  const omitted: Record<string, number> = { ...(prior.omitted || {}) };
  delete omitted.sources_by_id;
  delete omitted.results;
  if (total > held) omitted.sources_by_id = total - held;
  const paged = payload.operation === 'timeline';
  const pageEnd = Math.min(offset + limit, total);
  const pageLength = Math.max(0, pageEnd - offset);
  if (paged && total > pageLength) omitted.results = total - pageLength;
  const nextOffset = paged && pageEnd < total ? pageEnd : null;
  const hints: string[] = [];
  if (total > held) hints.push(`sources_by_id holds ${held} of ${total} matched sources.`);
  if (!paged) {
    if (total > held || offset) {
      hints.push(
        `operation ${payload.operation} answers for all ${total} and does not page${offset ? ` (offset ${offset} was not applied)` : ''}; archive_lens with operation timeline pages through every matched source with offset.`
      );
    }
  } else if (offset >= total && offset && total) {
    hints.push(`offset ${offset} is past the last of ${total} matched sources.`);
  } else if (nextOffset !== null) {
    hints.push(
      `The timeline shows ${offset + 1}-${pageEnd} of ${total}; call again with offset ${nextOffset} for the next ${Math.min(limit, total - pageEnd)}.`
    );
  } else if (offset && total) {
    hints.push(`The timeline shows ${offset + 1}-${pageEnd} of ${total}; this is the last page.`);
  }
  if (omitted['years[].top_domains']) {
    hints.push(`years[].top_domains holds each year's ${LENS_YEAR_TOP_DOMAINS} most linked of its domain_count.`);
  }
  if (Object.keys(omitted).some((path) => !['sources_by_id', 'results', 'years[].top_domains'].includes(path))) {
    hints.push('Narrow with year_range or source_kind for the rest.');
  }
  delete payload.truncated;
  if (!Object.keys(omitted).length && !prior.clipped?.length && !hints.length) return value;
  payload.truncated = {
    ...(Object.keys(omitted).length ? { omitted } : {}),
    ...(prior.clipped?.length ? { clipped: prior.clipped } : {}),
    ...(nextOffset !== null ? { next_offset: nextOffset } : {}),
    hint: hints.join(' ')
  };
  return value;
}
