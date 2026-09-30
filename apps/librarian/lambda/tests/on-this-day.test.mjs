import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS, chicagoToday } from '../dist/shared/archive-tools.mjs';
import { onThisDayYear } from '../dist/shared/retrieval.mjs';
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
  // In a leap target year 02-29 is its own day: Feb 28 of a year without
  // one stays on 02-28, so no source is listed on two days (QA F13).
  assert.equal(onThisDayYear('2021-02-28', 2, 29, 0, 2028), null);
  assert.equal(onThisDayYear('2021-02-28', 2, 28, 0, 2028), 2021);
  assert.equal(onThisDayYear('2021-03-01', 2, 29, 0, 2028), null);
  assert.equal(onThisDayYear('2020-02-28', 2, 29, 0, 2028), null);
  // With a window, 02-29 still anchors on Feb 28 in a year without one,
  // never on March 1.
  assert.equal(onThisDayYear('2021-02-27', 2, 29, 1, 2028), 2021);
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
  assert.equal(windowed.applied.limit_per_year, 2, 'a windowed call defaults to 2 a year');
  const windowedFive = await ARCHIVE_TOOLS.on_this_day(
    { date: '09-29', window_days: 2, limit_per_year: 5 },
    { scope: 'all' }
  );
  assert.equal(windowedFive.applied.limit_per_year, 5, 'an explicit limit_per_year still wins');
  for (const item of windowed.years.flatMap((row) => row.items)) {
    assert.notEqual(item.title, item.label, 'a title that repeats the label is not sent');
    if (item.photo) assert.ok(!Object.values(item.photo).includes(null), 'no null photo fields');
  }

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
  assert.equal(y2019.total_count, 2);
  assert.ok(capped.truncated.omitted['years[].items'] >= 1);
  assert.match(capped.truncated.hint, /limit_per_year/);

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
  assert.equal(out.total_count, 2);
  assert.deepEqual(out.counts_by_kind, [{ kind: 'installing', count: 2 }]);
  assert.deepEqual(out.counts_by_year, [{ year: 2024, count: 2 }]);
  const year = await ARCHIVE_TOOLS.currently_history({ year: 2024 });
  assert.equal(year.total_count, 3, 'year is year_range [2024, 2024]');
  assert.deepEqual(year.applied.year_range, [2024, 2024]);
  assert.deepEqual(
    out.entries.map((entry) => [entry.kind, entry.label]),
    [
      ['installing', 'installing more'],
      ['installing', undefined]
    ],
    'newest first (2.1.0)'
  );
});

test('currently_history: newest first, whole-word query over text and link titles, cut text marked', async () => {
  const long = `${'Reading slowly. '.repeat(24)}The Rag and Bone Shop of the Heart`;
  primeCorpusCachesForTests({
    weekly_thing: {
      issues: [],
      chunks: [],
      links: [],
      currently: [
        { kind: 'reading', text: 'I tried again and waited.', issue_number: 1, publish_date: '2021-01-02' },
        { kind: 'reading', text: long, issue_number: 2, publish_date: '2022-01-01' },
        {
          kind: 'watching',
          text: 'A show.',
          links: [{ title: '101 Famous Poems', url: 'https://example.com' }],
          issue_number: 3,
          publish_date: '2023-01-07'
        },
        { kind: 'using', text: 'I’m on AI tools now.', issue_number: 4, publish_date: '2024-01-06' }
      ]
    }
  });
  const all = await ARCHIVE_TOOLS.currently_history({ limit: 2 });
  assert.deepEqual(
    all.entries.map((entry) => entry.issue_number),
    [4, 3],
    'the newest page first; the cap drops the oldest'
  );
  assert.equal(all.truncated.next_offset, 2);
  assert.equal((await ARCHIVE_TOOLS.currently_history({ query: 'ai' })).total_count, 1, 'ai is not again');
  assert.equal((await ARCHIVE_TOOLS.currently_history({ query: "I'm" })).total_count, 1, 'straight finds curly');
  assert.equal((await ARCHIVE_TOOLS.currently_history({ query: '101 Famous Poems' })).total_count, 1, 'link titles');
  const cut = await ARCHIVE_TOOLS.currently_history({ query: 'Rag and Bone' });
  assert.equal(cut.total_count, 1, 'the query reads past the displayed text');
  assert.ok(cut.entries[0].text.endsWith('…'));
  assert.deepEqual(cut.truncated.clipped, ['entries[].text']);
});

test('on_this_day: year is the publish year under a window, and offset pages every year', async () => {
  const post = (id, date) => ({
    microblog_id: id,
    subject: `Post ${id}`,
    publish_date: date,
    url: `https://www.thingelstad.com/${date.slice(0, 4)}/${date.slice(5, 7)}/${date.slice(8, 10)}/p${id}.html`,
    abstract: `Post ${id}.`
  });
  primeCorpusCachesForTests({
    weekly_thing: { issues: [], chunks: [] },
    blog: {
      posts: [
        post(1, '2018-12-30'),
        post(2, '2019-01-01'),
        post(3, '2019-12-30'),
        post(4, '2019-12-31'),
        post(5, '2020-01-02'),
        post(6, '2021-01-01'),
        post(7, '2021-01-01'),
        post(8, '2021-01-01')
      ],
      chunks: []
    }
  });
  const y2019 = await ARCHIVE_TOOLS.on_this_day(
    { date: '2028-01-01', window_days: 3, year: 2019, limit_per_year: 20 },
    { scope: 'blog' }
  );
  const dates = y2019.years.flatMap((row) => row.items.map((item) => item.date));
  assert.deepEqual(dates.sort(), ['2019-01-01', '2019-12-30', '2019-12-31'], 'published in 2019, not the 2019 bucket');
  assert.equal(y2019.applied.day_basis.includes('publish year'), true);

  const first = await ARCHIVE_TOOLS.on_this_day({ date: '2028-01-01', limit_per_year: 2 }, { scope: 'blog' });
  const y2021 = first.years.find((row) => row.year === 2021);
  assert.equal(y2021.total_count, 3);
  assert.equal(y2021.items.length, 2);
  assert.equal(first.truncated.next_offset, 2);
  const second = await ARCHIVE_TOOLS.on_this_day(
    { date: '2028-01-01', limit_per_year: 2, offset: 2 },
    { scope: 'blog' }
  );
  const rest = second.years.find((row) => row.year === 2021);
  assert.equal(rest.items.length, 1);
  assert.ok(!y2021.items.some((item) => item.id === rest.items[0].id), 'the next page holds the rest');
  assert.equal(second.truncated.next_offset, undefined);
});
