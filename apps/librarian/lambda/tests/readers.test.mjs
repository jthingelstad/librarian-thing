// Reader numbers (2.7.0): get_source shows what Tinylytics counted for a
// source, list_content sorts by it, and a corpus built before the numbers
// (CI evals the new Lambda against the previous corpora) still answers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS } from '../dist/shared/archive-tools.mjs';
import { readersSummary } from '../dist/shared/readers.mjs';
import { primeCorpusCachesForTests } from '../dist/shared/retrieval.mjs';

const CTX = { scope: 'all' };
const SITES = {
  www: { tracked_since: '2024-07-09', through: '2026-10-21' },
  weekly: { tracked_since: '2026-01-08', through: '2026-10-21' }
};

function post(id, publish_date, subject) {
  return {
    microblog_id: id,
    subject,
    publish_date,
    url: `https://www.thingelstad.com/post-${id}.html`,
    post_kind: 'post',
    categories: []
  };
}

function fixtures({ readers = true } = {}) {
  const blogReaders = {
    version: 1,
    sites: SITES,
    sources: {
      // An old post found again: nothing in the 30 days before, 100 since.
      'blog-1': {
        site: 'www',
        views: {
          total: 500,
          months: { '2024-08': 400, '2026-10': 100 },
          days: { '2026-10-01': 60, '2026-10-15': 40 }
        },
        kudos: ['2025-01-02', '2026-10-03']
      },
      // Read less than it was.
      'blog-2': {
        site: 'www',
        views: { total: 300, months: { '2026-09': 50, '2026-10': 10 }, days: { '2026-09-01': 50, '2026-10-10': 10 } }
      },
      // Published this month: new, not rising.
      'blog-3': { site: 'www', views: { total: 80, months: { '2026-10': 80 }, days: { '2026-10-12': 80 } } },
      'page-9': {
        site: 'www',
        views: { total: 200, months: { '2026-08': 5, '2026-10': 5 }, days: { '2026-08-01': 5, '2026-10-20': 5 } }
      }
    }
  };
  const weeklyReaders = {
    version: 1,
    sites: SITES,
    sources: {
      'wt-350': {
        site: 'weekly',
        views: { total: 351, months: { '2026-09': 300, '2026-10': 51 }, days: { '2026-09-20': 300, '2026-10-02': 51 } },
        email_opens: { total: 1189, months: { '2026-09': 1117, '2026-10': 72 }, days: { '2026-09-20': 618 } },
        feed_reads: { total: 39, months: { '2026-09': 31, '2026-10': 8 }, days: {} },
        kudos: ['2026-09-21']
      }
    }
  };
  return {
    weekly_thing: {
      issues: [
        {
          number: 350,
          subject: 'Weekly Thing 350',
          publish_date: '2026-09-20T12:00:00Z',
          url: 'https://weekly.thingelstad.com/archive/350/',
          body: 'An issue about reading.'
        },
        {
          number: 351,
          subject: 'Weekly Thing 351',
          publish_date: '2026-09-27T12:00:00Z',
          url: 'https://weekly.thingelstad.com/archive/351/',
          body: 'Another issue.'
        }
      ],
      chunks: [],
      links: [],
      media: [],
      ...(readers ? { readers: weeklyReaders } : {})
    },
    blog: {
      posts: [
        post(1, '2009-03-01', 'An old post'),
        post(2, '2015-05-05', 'A middle post'),
        post(3, '2026-10-10', 'A new post'),
        post(4, '2020-01-01', 'A quiet post'),
        {
          page_id: 9,
          subject: 'About',
          publish_date: null,
          updated: '2025-01-01T10:00:00-06:00',
          url: 'https://www.thingelstad.com/about/',
          post_kind: 'page',
          categories: []
        }
      ],
      chunks: [],
      links: [],
      media: [],
      ...(readers ? { readers: blogReaders } : {})
    },
    podcast: { episodes: [], chunks: [], links: [] }
  };
}

const ids = (out) => out.results.map((row) => row.id);

test('get_source shows a source’s numbers, since counting began', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.get_source({ id: 'blog-1', format: 'outline' }, CTX);
  const readers = out.source.readers;
  assert.equal(readers.site, 'www.thingelstad.com');
  assert.equal(readers.tracked_since, '2024-07-09');
  assert.equal(readers.through, '2026-10-21');
  assert.deepEqual(readers.views, {
    count: 500,
    last_30_days: 100,
    prior_30_days: 0,
    trend: 'rising',
    by_month: [
      { month: '2024-08', count: 400 },
      { month: '2026-10', count: 100 }
    ]
  });
  assert.deepEqual(readers.kudos, { count: 2, days: ['2025-01-02', '2026-10-03'] });
  assert.match(readers.note, /since 2024-07-09/);
  assert.match(readers.note, /not all time/);
  assert.equal(readers.email_opens, undefined, 'a post has no email opens');
});

test('trend: falling, new, and no recent views', async () => {
  primeCorpusCachesForTests(fixtures());
  const trend = async (id) => (await ARCHIVE_TOOLS.get_source({ id, format: 'outline' }, CTX)).source.readers;
  assert.equal((await trend('blog-2')).views.trend, 'falling');
  assert.equal((await trend('blog-3')).views.trend, 'new');
  const quiet = await trend('blog-4');
  assert.equal(quiet.views.count, 0, 'a source nothing was counted for reads zero');
  assert.equal(quiet.views.trend, 'no recent views');
  assert.deepEqual(quiet.kudos, { count: 0, days: [] });
});

test('an issue carries email opens and feed reads, per issue', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.get_source({ id: 'wt-350', format: 'outline' }, CTX);
  const readers = out.source.readers;
  assert.equal(readers.site, 'weekly.thingelstad.com');
  assert.equal(readers.views.count, 351);
  assert.equal(readers.email_opens.count, 1189);
  assert.equal(readers.email_opens.trend, undefined, 'only views carry a trend');
  assert.equal(readers.feed_reads.count, 39);
  assert.match(readers.note, /per issue, never per reader/);
});

test('list_content sorts by what was read', async () => {
  primeCorpusCachesForTests(fixtures());
  const list = (sort) => ARCHIVE_TOOLS.list_content({ source_kind: 'blog', sort }, CTX);
  assert.deepEqual(ids(await list('most_read')), ['blog-1', 'blog-2', 'page-9', 'blog-3', 'blog-4']);
  assert.deepEqual(ids(await list('most_read_30d')), ['blog-1', 'blog-3', 'blog-2', 'page-9', 'blog-4']);
  assert.deepEqual(ids(await list('most_read_90d')), ['blog-1', 'blog-3', 'blog-2', 'page-9', 'blog-4']);
  // Ties keep date order: newest first, the undated page last.
  assert.deepEqual(ids(await list('most_kudos')), ['blog-1', 'blog-3', 'blog-4', 'blog-2', 'page-9']);
  // The biggest gain first, falling last, and the new post after the rest.
  assert.deepEqual(ids(await list('rising')), ['blog-1', 'page-9', 'blog-4', 'blog-2', 'blog-3']);

  const out = await list('most_read');
  assert.equal(out.applied.sort, 'most_read');
  assert.deepEqual(out.readers_counted, { 'www.thingelstad.com': SITES.www });
  assert.deepEqual(out.results[0].readers, {
    views: 500,
    views_last_30_days: 100,
    views_prior_30_days: 0,
    views_last_90_days: 100,
    trend: 'rising',
    kudos: 2
  });
  assert.equal(out.total_count, 5, 'a sort changes the order, never what is listed');
});

test('list_content stays newest first without a reader sort, and carries no numbers', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.list_content({ source_kind: 'blog' }, CTX);
  assert.deepEqual(ids(out), ['blog-3', 'blog-4', 'blog-2', 'blog-1', 'page-9']);
  assert.equal(out.readers_counted, undefined);
  assert.ok(out.results.every((row) => row.readers === undefined));
  assert.equal(out.applied.sort, undefined);
  assert.equal(out.note, undefined);
});

test('a corpus built before the numbers: no readers, and the sort says so', async () => {
  primeCorpusCachesForTests(fixtures({ readers: false }));
  const source = await ARCHIVE_TOOLS.get_source({ id: 'blog-1', format: 'outline' }, CTX);
  assert.equal(source.source.readers, undefined);
  const out = await ARCHIVE_TOOLS.list_content({ source_kind: 'blog', sort: 'most_read' }, CTX);
  assert.deepEqual(ids(out), ['blog-3', 'blog-4', 'blog-2', 'blog-1', 'page-9']);
  assert.equal(out.applied.sort, 'newest');
  assert.match(out.note, /needs reader numbers, and this corpus has none yet/);
  assert.equal(readersSummary({}, 'blog-1'), null);
});

test('across corpora, one without numbers counts zero and is named', async () => {
  const mixed = fixtures();
  delete mixed.weekly_thing.readers;
  primeCorpusCachesForTests(mixed);
  const out = await ARCHIVE_TOOLS.list_content({ sort: 'most_read' }, CTX);
  assert.equal(out.applied.sort, 'most_read');
  assert.equal(ids(out)[0], 'blog-1');
  assert.match(out.note, /No reader numbers yet for weekly_thing/);
  assert.deepEqual(Object.keys(out.readers_counted), ['www.thingelstad.com']);
  const issue = out.results.find((row) => row.id === 'wt-350');
  assert.equal(issue.readers, null, 'no numbers is null, never a made-up zero');
});
