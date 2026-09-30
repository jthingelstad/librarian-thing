import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS, chicagoToday, onThisDayYear } from '../dist/shared/archive-tools.mjs';
import { primeCorpusCachesForTests } from '../dist/shared/retrieval.mjs';

function fixtures() {
  return {
    weekly_thing: {
      issues: [
        {
          number: 300,
          subject: 'Weekly Thing 300',
          publish_date: '2024-09-29T12:00:00Z',
          url: '/archive/300/',
          summary: { abstract: 'Jamie on tidepools and the fall.' }
        },
        {
          number: 250,
          subject: 'Weekly Thing 250',
          publish_date: '2023-10-01T12:00:00Z',
          url: '/archive/250/',
          summary: { abstract: 'Two days late.' }
        },
        {
          number: 350,
          subject: 'Weekly Thing 350',
          publish_date: '2026-09-29T12:00:00Z',
          url: '/archive/350/',
          summary: { abstract: 'This year, so never on this day.' }
        }
      ],
      chunks: [],
      links: [],
      media: [
        {
          url: 'https://files.thingelstad.com/weekly-thing/300/cover.jpg',
          alt: 'A tidepool',
          issue_number: 300,
          description: 'A rocky tidepool at low tide.'
        }
      ]
    },
    blog: {
      posts: [
        {
          microblog_id: 987,
          subject: 'A post from 2019',
          publish_date: '2019-09-29',
          url: 'https://www.thingelstad.com/2019/09/29/a-post.html',
          post_kind: 'post'
        },
        {
          microblog_id: 988,
          subject: '',
          publish_date: '2019-09-29',
          url: 'https://www.thingelstad.com/2019/09/29/micro.html',
          post_kind: 'micropost'
        },
        {
          microblog_id: 40,
          subject: 'Leap day',
          publish_date: '2020-02-29',
          url: 'https://www.thingelstad.com/2020/02/29/leap.html',
          post_kind: 'post'
        },
        {
          microblog_id: 41,
          subject: 'New Year',
          publish_date: '2020-01-02',
          url: 'https://www.thingelstad.com/2020/01/02/new-year.html',
          post_kind: 'post'
        }
      ],
      chunks: [
        {
          source_kind: 'blog',
          url: 'https://www.thingelstad.com/2019/09/29/a-post.html',
          section: 'post',
          text: 'The first chunk of the 2019 post.\n\nIt ends on this sentence.'
        },
        {
          source_kind: 'blog',
          url: 'https://www.thingelstad.com/2019/09/29/a-post.html',
          section: 'post',
          text: 'It ends on this sentence.\n\nAnd the second chunk carries on.'
        },
        {
          source_kind: 'blog',
          url: 'https://www.thingelstad.com/2019/09/29/micro.html',
          section: 'post',
          text: 'A short micropost.'
        }
      ],
      links: [],
      media: []
    },
    podcast: {
      episodes: [
        {
          number: 3,
          show: 'Another Thing',
          subject: 'Episode 3',
          publish_date: '2025-09-29',
          url: 'https://another.thingelstad.com/3/',
          summary: 'An episode about agents.'
        }
      ],
      chunks: [],
      links: []
    }
  };
}

test('onThisDayYear matches the month-day, folds Feb 29, and spans a year boundary', () => {
  assert.equal(onThisDayYear('2019-09-29', 9, 29, 0, 2026), 2019);
  assert.equal(onThisDayYear('2019-09-30', 9, 29, 0, 2026), null);
  assert.equal(onThisDayYear('2019-09-30', 9, 29, 1, 2026), 2019);
  // A Feb 29 source is Feb 28 in a target year without one, and only then.
  assert.equal(onThisDayYear('2020-02-29', 2, 28, 0, 2026), 2020);
  assert.equal(onThisDayYear('2020-02-29', 2, 28, 0, 2028), null);
  assert.equal(onThisDayYear('2020-02-29', 2, 29, 0, 2028), 2020);
  // 02-29 anchors on Feb 28 in a year without one, never on March 1.
  assert.equal(onThisDayYear('2021-02-28', 2, 29, 0, 2028), 2021);
  assert.equal(onThisDayYear('2021-03-01', 2, 29, 0, 2028), null);
  assert.equal(onThisDayYear('2020-02-28', 2, 29, 0, 2028), null);
  // A window around Dec 31 reaches into January of the next year.
  assert.equal(onThisDayYear('2020-01-02', 12, 31, 2, 2026), 2019);
  assert.equal(onThisDayYear('not a date', 9, 29, 0, 2026), null);
  assert.match(chicagoToday(), /^\d{4}-\d{2}-\d{2}$/);
});

test('on_this_day returns past years newest first across all three corpora', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.on_this_day({ date: '2026-09-29' }, { scope: 'all' });
  assert.equal(out.applied.date, '2026-09-29');
  assert.equal(out.applied.timezone, 'America/Chicago');
  assert.equal(out.applied.window_days, 0);
  assert.equal(out.applied.limit_per_year, 5);
  assert.equal(out.applied.limit, undefined, 'on_this_day takes limit_per_year, not limit');
  assert.deepEqual(
    out.years.map((row) => [row.year, row.years_ago]),
    [
      [2025, 1],
      [2024, 2],
      [2019, 7]
    ]
  );
  const [wt] = out.years[1].items;
  assert.deepEqual(
    { id: wt.id, label: wt.label, url: wt.url, excerpt: wt.excerpt },
    {
      id: 'wt-300',
      label: 'WT300',
      url: 'https://weekly.thingelstad.com/archive/300/',
      excerpt: 'Jamie on tidepools and the fall.'
    }
  );
  assert.deepEqual(wt.photo, {
    url: 'https://files.thingelstad.com/weekly-thing/300/cover.jpg',
    alt: 'A tidepool',
    description: 'A rocky tidepool at low tide.'
  });
  const blog = out.years[2].items;
  assert.equal(blog[0].id, 'blog-987');
  assert.match(blog[0].excerpt, /^The first chunk of the 2019 post/);
  assert.equal(blog[1].micropost, true, 'microposts sort after posts');
  assert.equal(out.years[0].items[0].excerpt, 'An episode about agents.');
  assert.ok(!out.years.some((row) => row.year === 2026), 'the date year itself is never on this day');
});

test('on_this_day honours window, microposts, source_kind, year_range and limit_per_year', async () => {
  primeCorpusCachesForTests(fixtures());
  const windowed = await ARCHIVE_TOOLS.on_this_day({ date: '09-29', window_days: 2 }, { scope: 'all' });
  assert.ok(windowed.years.some((row) => row.items.some((item) => item.id === 'wt-250')));

  const noMicro = await ARCHIVE_TOOLS.on_this_day(
    { date: '2026-09-29', include_microposts: false, source_kind: 'blog' },
    { scope: 'all' }
  );
  assert.deepEqual(
    noMicro.years.map((row) => row.items.map((item) => item.id)),
    [['blog-987']]
  );

  const capped = await ARCHIVE_TOOLS.on_this_day({ date: '2026-09-29', limit_per_year: 1 }, { scope: 'all' });
  const y2019 = capped.years.find((row) => row.year === 2019);
  assert.equal(y2019.items.length, 1);
  assert.equal(y2019.more, 1);

  const ranged = await ARCHIVE_TOOLS.on_this_day({ date: '2026-09-29', year_range: [2024, 2025] }, { scope: 'all' });
  assert.deepEqual(
    ranged.years.map((row) => row.year),
    [2025, 2024]
  );

  const folded = await ARCHIVE_TOOLS.on_this_day({ date: '2026-02-28' }, { scope: 'blog' });
  assert.deepEqual(
    folded.years.map((row) => row.items[0].id),
    ['blog-40'],
    'the leap-day post shows on Feb 28 of a year without one'
  );
  const leapYear = await ARCHIVE_TOOLS.on_this_day({ date: '2028-02-28' }, { scope: 'blog' });
  assert.deepEqual(leapYear.years, [], 'a leap year has its own Feb 29');
  const leapDay = await ARCHIVE_TOOLS.on_this_day({ date: '2028-02-29' }, { scope: 'blog' });
  assert.deepEqual(
    leapDay.years.map((row) => row.items[0].id),
    ['blog-40']
  );

  const asked = await ARCHIVE_TOOLS.on_this_day({ date: '2026-02-29' }, { scope: 'blog' });
  assert.equal(asked.applied.month_day, '02-28', '02-29 in a year without one is Feb 28');
  assert.deepEqual(
    asked.years.map((row) => row.items[0].id),
    ['blog-40']
  );

  for (const date of ['September 29', '2026-02-31', '13-01']) {
    const bad = await ARCHIVE_TOOLS.on_this_day({ date }, { scope: 'all' });
    assert.equal(bad.code, 'bad_request', date);
  }
});

test('every id on_this_day emits is accepted by get_source and source_neighborhood', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.on_this_day({ date: '2026-09-29' }, { scope: 'all' });
  const ids = out.years.flatMap((row) => row.items.map((item) => item.id));
  assert.ok(ids.length >= 4);
  for (const id of ids) {
    const source = await ARCHIVE_TOOLS.get_source({ id }, { scope: 'all' });
    assert.equal(source.error, undefined, `get_source resolves ${id}`);
    assert.equal(source.source.id, id);
    const near = await ARCHIVE_TOOLS.source_neighborhood({ id }, { scope: 'all' });
    assert.equal(near.error, undefined, `source_neighborhood resolves ${id}`);
  }
  const missing = await ARCHIVE_TOOLS.get_source({ id: 'wt-9999' }, { scope: 'all' });
  assert.ok(missing.error);
});

test('get_source reads a continuation chunk without repeating its lead-in', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.get_source({ id: 'blog-987' }, { scope: 'all' });
  assert.equal(
    out.source.body,
    'The first chunk of the 2019 post.\n\nIt ends on this sentence.\n\nAnd the second chunk carries on.'
  );
  assert.equal(out.source.url, 'https://www.thingelstad.com/2019/09/29/a-post.html');
});

test('currently_history folds "installing more" into its kind', async () => {
  primeCorpusCachesForTests({
    weekly_thing: {
      issues: [],
      chunks: [],
      links: [],
      currently: [
        { kind: 'installing', text: 'An app', issue_number: 1, publish_date: '2024-01-06' },
        { kind: 'installing more', text: 'More apps', issue_number: 2, publish_date: '2024-01-13' },
        { kind: 'reading', text: 'A book', issue_number: 3, publish_date: '2024-01-20' }
      ]
    }
  });
  const out = await ARCHIVE_TOOLS.currently_history({ kind: 'installing' });
  assert.equal(out.total, 2);
  assert.deepEqual(out.counts_by_kind, { installing: 2 });
  assert.deepEqual(
    out.entries.map((entry) => [entry.kind, entry.label]),
    [
      ['installing', undefined],
      ['installing', 'installing more']
    ]
  );
});
