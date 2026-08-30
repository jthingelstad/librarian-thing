interface CorpusRecord {
  publish_date?: unknown;
  subject?: unknown;
  title?: unknown;
  domains?: unknown[];
  section?: unknown;
  post_kind?: unknown;
  source_kind?: unknown;
  url?: unknown;
  summary?: unknown;
  text?: unknown;
}

interface YearCount {
  year: number;
  count: number;
}

interface YearBucket {
  year: number;
  count: number;
  chunk_count: number;
  subjectTerms: Map<string, number>;
  textTerms: Map<string, number>;
  domains: Map<string, number>;
  sections: Map<string, number>;
  samples: Array<{ subject: string; publish_date: string; url: string; section: string }>;
}

interface YearlyContentOptions {
  listLimit?: number;
  topYearLimit?: number;
  sampleLimit?: number;
  chunks?: CorpusRecord[];
}

export function yearFromPublishDate(value: unknown) {
  const match = String(value || '').match(/\b(?:19|20)\d{2}\b/);
  return match ? Number(match[0]) : 0;
}

export function countsByPublishYear(records: Array<{ publish_date?: unknown }> = []) {
  const counts = new Map<number, number>();
  for (const record of records || []) {
    const year = yearFromPublishDate(record?.publish_date);
    if (!year) continue;
    counts.set(year, (counts.get(year) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([year, count]) => ({ year, count }));
}

export function yearCountSummary(countsByYear: YearCount[] = []) {
  const rows = (countsByYear || [])
    .filter((row) => Number.isFinite(Number(row?.year)) && Number.isFinite(Number(row?.count)))
    .map((row) => ({ year: Number(row.year), count: Number(row.count) }));
  if (!rows.length) return { highest_years: [], lowest_years: [] };
  const highestCount = Math.max(...rows.map((row) => row.count));
  const lowestCount = Math.min(...rows.map((row) => row.count));
  return {
    highest_years: rows.filter((row) => row.count === highestCount).sort((a, b) => b.year - a.year),
    lowest_years: rows.filter((row) => row.count === lowestCount).sort((a, b) => b.year - a.year)
  };
}

const STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'and',
  'another',
  'because',
  'before',
  'being',
  'been',
  'blog',
  'but',
  'can',
  'could',
  'did',
  'does',
  'doing',
  'don',
  'from',
  'had',
  'has',
  'have',
  'into',
  'its',
  'jamie',
  'just',
  'like',
  'more',
  'not',
  'one',
  'our',
  'out',
  'over',
  'post',
  'she',
  'some',
  'than',
  'that',
  'the',
  'their',
  'there',
  'these',
  'they',
  'thing',
  'this',
  'was',
  'were',
  'with',
  'weekly',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'will',
  'would',
  'you',
  'your'
]);

function increment(map: Map<string, number>, key: unknown, amount = 1) {
  const normalized = String(key || '').trim();
  if (!normalized) return;
  map.set(normalized, (map.get(normalized) || 0) + amount);
}

function topCounts(map: Map<string, number>, key: string, limit = 8) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ [key]: name, count }));
}

// Frequent function words and URL fragments that were dominating
// top_text_terms ("for" 488, "https" 463, "com" 434).
const EXTRA_STOPWORDS = new Set([
  'for',
  'the',
  'with',
  'this',
  'that',
  'from',
  'are',
  'was',
  'were',
  'has',
  'have',
  'had',
  'you',
  'your',
  'not',
  'all',
  'can',
  'will',
  'one',
  'two',
  'its',
  'out',
  'get',
  'got',
  'more',
  'new',
  'now',
  'how',
  'what',
  'when',
  'where',
  'some',
  'they',
  'them',
  'their',
  'then',
  'than',
  'just',
  'like',
  'over',
  'only',
  'very',
  'into',
  'off',
  'our',
  'who',
  'why',
  'his',
  'her',
  'she',
  'him',
  'way',
  'via',
  'per',
  'here',
  'there',
  'these',
  'those',
  'https',
  'http',
  'www',
  'com',
  'org',
  'net',
  'html',
  'href',
  'amp',
  'utm'
]);

function terms(value: unknown, { maxChars = 0 }: { maxChars?: number } = {}): string[] {
  const text = String(value || '').replace(/https?:\/\/\S+/g, ' ');
  const input = maxChars ? text.slice(0, maxChars) : text;
  return (
    input
      .toLowerCase()
      .match(/[a-z][a-z0-9'-]{2,}/g)
      ?.filter((term) => !STOPWORDS.has(term) && !EXTRA_STOPWORDS.has(term) && !/^\d+$/.test(term)) || []
  );
}

function subjectTerms(value: unknown) {
  return terms(value);
}

function textTerms(value: unknown) {
  return Array.from(new Set(terms(value, { maxChars: 1800 })));
}

function bucketFor(buckets: Map<number, YearBucket>, year: number): YearBucket {
  if (!buckets.has(year)) {
    buckets.set(year, {
      year,
      count: 0,
      chunk_count: 0,
      subjectTerms: new Map(),
      textTerms: new Map(),
      domains: new Map(),
      sections: new Map(),
      samples: []
    });
  }
  return buckets.get(year)!;
}

export function yearlyContentSignals(records: CorpusRecord[] = [], options: YearlyContentOptions = {}) {
  const topYearLimit = Math.max(Number(options.topYearLimit || 40), 1);
  const sampleLimit = Math.max(Number(options.sampleLimit || 4), 0);
  // One limit governs every nested list so the caller's `limit` actually
  // controls what the truncation note claims it controls.
  const listLimit = Math.max(Number(options.listLimit || 0), 0);
  const chunks = Array.isArray(options.chunks) ? options.chunks : [];
  const buckets = new Map<number, YearBucket>();
  for (const record of records || []) {
    const year = yearFromPublishDate(record?.publish_date);
    if (!year) continue;
    const bucket = bucketFor(buckets, year);
    bucket.count += 1;
    for (const term of subjectTerms([record.subject, record.title].join(' '))) {
      increment(bucket.subjectTerms, term);
    }
    for (const domain of record.domains || []) increment(bucket.domains, domain);
    increment(bucket.sections, record.section || record.post_kind || record.source_kind || 'item');
    if (bucket.samples.length < sampleLimit) {
      bucket.samples.push({
        subject: String(record.subject || ''),
        publish_date: String(record.publish_date || ''),
        url: String(record.url || ''),
        section: String(record.section || '')
      });
    }
  }
  for (const chunk of chunks) {
    const year = yearFromPublishDate(chunk?.publish_date);
    if (!year) continue;
    const bucket = bucketFor(buckets, year);
    bucket.chunk_count += 1;
    for (const term of textTerms([chunk.subject, chunk.section, chunk.summary, chunk.text].join(' '))) {
      increment(bucket.textTerms, term);
    }
  }
  const allBuckets = Array.from(buckets.values());
  // "Signals" should surface what is DISTINCTIVE about a year, not the
  // corpus-wide baseline vocabulary (great/good/time/people ranked top for
  // every single year). Score = year count x idf across year buckets.
  const yearsWithTerm = new Map<string, number>();
  for (const bucket of allBuckets) {
    for (const term of bucket.textTerms.keys()) {
      yearsWithTerm.set(term, (yearsWithTerm.get(term) || 0) + 1);
    }
  }
  const totalYears = Math.max(allBuckets.length, 1);
  const distinctiveTerms = (bucket: YearBucket, limit: number) =>
    Array.from(bucket.textTerms.entries())
      .map(([term, count]) => ({
        term,
        count,
        score: count * Math.log(1 + totalYears / (yearsWithTerm.get(term) || 1))
      }))
      .sort((a, b) => b.score - a.score || b.count - a.count)
      .slice(0, limit)
      .map(({ term, count }) => ({ term, count }));

  return allBuckets
    .sort((a, b) => b.year - a.year)
    .slice(0, topYearLimit)
    .map((bucket) => ({
      year: bucket.year,
      count: bucket.count,
      chunk_count: bucket.chunk_count,
      top_subject_terms: topCounts(bucket.subjectTerms, 'term', listLimit || 10),
      top_text_terms: distinctiveTerms(bucket, listLimit || 12),
      top_domains: topCounts(bucket.domains, 'domain', listLimit || 8),
      counts_by_section: topCounts(bucket.sections, 'section', listLimit || 8),
      sample_items: bucket.samples
    }));
}
