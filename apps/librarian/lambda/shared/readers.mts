// Reader numbers: what Tinylytics counted on each of Jamie's sites, carried
// in each corpus as `readers` (librarian-core library/readers.py builds it
// from the library). Counts only: views per source by month since the site
// was first counted, by day for the last 90 days, email opens and feed reads
// for issues (per issue, never per reader), and kudos with their dates.
//
// A count is never all time: www has been counted since July 2024, so a 2009
// post's views are its views since then, and every summary says so. A corpus
// built before the numbers (CI runs a new Lambda against the previous
// corpora) has no `readers`, and every helper answers null for it.
import type { Corpus } from './retrieval.mjs';

export interface MeasureCounts {
  total?: number;
  months?: Record<string, number>;
  days?: Record<string, number>;
}

export interface SourceReaders {
  site?: string;
  views?: MeasureCounts;
  email_opens?: MeasureCounts;
  feed_reads?: MeasureCounts;
  kudos?: string[];
}

export interface CorpusReaders {
  version?: number;
  sites?: Record<string, { tracked_since?: string; through?: string }>;
  sources?: Record<string, SourceReaders>;
}

export const READER_SORTS = ['most_read', 'most_read_30d', 'most_read_90d', 'most_kudos', 'rising'] as const;
export type ReaderSort = (typeof READER_SORTS)[number];

const MEASURES = ['views', 'email_opens', 'feed_reads'] as const;

// Where each id's numbers come from, for a source the export holds nothing
// for (no counted view yet).
const SITE_BY_PREFIX: Array<[string, string]> = [
  ['wt-', 'weekly'],
  ['site-', 'weekly'],
  ['blog-', 'www'],
  ['page-', 'www'],
  ['ep-', 'another'],
  ['thing-', 'xyz']
];

const SITE_HOSTS: Record<string, string> = {
  www: 'www.thingelstad.com',
  weekly: 'weekly.thingelstad.com',
  another: 'another.thingelstad.com',
  xyz: 'thingelstad.xyz'
};

// Rising or falling needs a real change, not a few stray views: a quarter
// more (or a fifth fewer) and at least three views either way.
const TREND_RATIO_UP = 1.25;
const TREND_RATIO_DOWN = 0.8;
const TREND_MIN_CHANGE = 3;

export function corpusReaders(corpus: Corpus | null | undefined): CorpusReaders | null {
  const readers = corpus?.readers as CorpusReaders | undefined;
  if (!readers || typeof readers !== 'object' || !readers.sites || typeof readers.sites !== 'object') return null;
  return readers;
}

function siteFor(id: string, entry: SourceReaders | undefined) {
  if (entry?.site) return entry.site;
  return SITE_BY_PREFIX.find(([prefix]) => id.startsWith(prefix))?.[1] || '';
}

function dayBefore(day: string, days: number) {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
}

// Views in the `days` days ending `endsBefore` days before `through`
// (inclusive Central days). The corpus keeps 90 days of daily counts.
function windowSum(measure: MeasureCounts | undefined, through: string, days: number, endsBefore = 0) {
  const last = dayBefore(through, endsBefore);
  const first = dayBefore(last, days - 1);
  let sum = 0;
  for (const [day, count] of Object.entries(measure?.days || {})) {
    if (day >= first && day <= last) sum += Number(count) || 0;
  }
  return sum;
}

function trendOf(last: number, prior: number, published: string | null, through: string) {
  if (published && published > dayBefore(through, 60)) return 'new';
  if (!last && !prior) return 'no recent views';
  if (last >= prior * TREND_RATIO_UP && last - prior >= TREND_MIN_CHANGE) return 'rising';
  if (last <= prior * TREND_RATIO_DOWN && prior - last >= TREND_MIN_CHANGE) return 'falling';
  return 'steady';
}

interface SourceNumbers {
  site: string;
  tracked_since: string;
  through: string;
  entry: SourceReaders;
}

function numbersFor(readers: CorpusReaders | null, id: string): SourceNumbers | null {
  if (!readers) return null;
  const entry = readers.sources?.[id];
  const site = siteFor(id, entry);
  const window = readers.sites?.[site];
  if (!window?.tracked_since || !window.through) return null;
  return { site, tracked_since: window.tracked_since, through: window.through, entry: entry || {} };
}

// What get_source shows: every measure the source has, last 30 days against
// the 30 before, by month since counting began, and kudos with their days.
// `published` is the source's Chicago day, so a new source reads as new
// rather than rising. Null when the corpus carries no numbers.
export function readersSummary(corpus: Corpus | null | undefined, id: string, published: string | null = null) {
  const found = numbersFor(corpusReaders(corpus), id);
  if (!found) return null;
  const { site, tracked_since, through, entry } = found;
  const summary: Record<string, unknown> = { site: SITE_HOSTS[site] || site, tracked_since, through };
  for (const name of MEASURES) {
    const measure = entry[name];
    if (!measure && name !== 'views') continue;
    const last = windowSum(measure, through, 30);
    const prior = windowSum(measure, through, 30, 30);
    summary[name] = {
      count: Number(measure?.total) || 0,
      last_30_days: last,
      prior_30_days: prior,
      ...(name === 'views' ? { trend: trendOf(last, prior, published, through) } : {}),
      by_month: Object.entries(measure?.months || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, count]) => ({ month, count }))
    };
  }
  const kudos = (entry.kudos || []).slice().sort();
  summary.kudos = { count: kudos.length, days: kudos };
  summary.note =
    `Counted by Tinylytics on ${SITE_HOSTS[site] || site} since ${tracked_since}, through ${through} ` +
    '(US Central days): not all time.' +
    (entry.email_opens ? ' Email opens are opens of this issue’s email, counted per issue, never per reader.' : '');
  return summary;
}

// What a reader sort orders by, highest first: [group, value]. A source
// the corpus holds nothing for counts zero. rising is the gain in views,
// last 30 days over the 30 before; a source published in the last 60 days
// has no before, so it is new, and new sources sort after the rest.
export function readerSortKey(
  corpus: Corpus | null | undefined,
  id: string,
  sort: ReaderSort,
  published: string | null = null
): [number, number] {
  const found = numbersFor(corpusReaders(corpus), id);
  if (!found) return [1, 0];
  const views = found.entry.views;
  if (sort === 'most_read') return [1, Number(views?.total) || 0];
  if (sort === 'most_read_30d') return [1, windowSum(views, found.through, 30)];
  if (sort === 'most_read_90d') return [1, windowSum(views, found.through, 90)];
  if (sort === 'most_kudos') return [1, (found.entry.kudos || []).length];
  const gain = windowSum(views, found.through, 30) - windowSum(views, found.through, 30, 30);
  return [published && published > dayBefore(found.through, 60) ? 0 : 1, gain];
}

// The compact numbers list_content shows beside each source when sorted
// by them.

export function compactReaders(corpus: Corpus | null | undefined, id: string, published: string | null = null) {
  const found = numbersFor(corpusReaders(corpus), id);
  if (!found) return null;
  const { through, entry } = found;
  const last = windowSum(entry.views, through, 30);
  const prior = windowSum(entry.views, through, 30, 30);
  return {
    views: Number(entry.views?.total) || 0,
    views_last_30_days: last,
    views_prior_30_days: prior,
    views_last_90_days: windowSum(entry.views, through, 90),
    trend: trendOf(last, prior, published, through),
    kudos: (entry.kudos || []).length,
    ...(entry.email_opens ? { email_opens: Number(entry.email_opens.total) || 0 } : {})
  };
}

// The windows a listing's numbers cover, by site host: the sites of the
// sources listed.
export function readersCounted(sources: Array<{ corpus: Corpus | null | undefined; id: string }>) {
  const out: Record<string, { tracked_since: string; through: string }> = {};
  for (const { corpus, id } of sources) {
    const found = numbersFor(corpusReaders(corpus), id);
    if (found)
      out[SITE_HOSTS[found.site] || found.site] = { tracked_since: found.tracked_since, through: found.through };
  }
  return out;
}

export function readerSort(value: unknown): ReaderSort | null {
  const wanted = String(value || '')
    .toLowerCase()
    .trim();
  return (READER_SORTS as readonly string[]).includes(wanted) ? (wanted as ReaderSort) : null;
}
