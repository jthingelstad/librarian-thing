// QA round 3, Lambda family: Jamie's 2026-10-01 answers on search, links,
// photos and time (Q2, Q3, Q6, Q7, Q9, Q10, Q13, Q14, Q17, Q20).
import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS, utilityDomain } from '../dist/shared/archive-tools.mjs';
import { mcpToolDeclarations, validateToolArguments } from '../dist/shared/mcp.mjs';
import { dedupeJournalTwins, pageWithoutTwins, primeCorpusCachesForTests } from '../dist/shared/retrieval.mjs';

// Nothing here calls Bedrock.
process.env.LIBRARIAN_RERANK_ENABLED = '0';

const LONG_URL = 'https://www.thingelstad.com/2020/05/06/connecting-online.html';
const SHORT_URL = 'https://www.thingelstad.com/2020/05/07/espresso.html';
const words = (seed, count) => Array.from({ length: count }, (_v, index) => `${seed}${index}`).join(' ');
const WORK = `Fully remote is a leveler. ${words('work', 120)}`;
const EVENT = `The event had a single track. ${words('event', 120)}`;
const CLOSE = `It filled my day with energy. ${words('close', 120)}`;

function passageFixtures() {
  const passage = (index, text) => ({
    id: `blog:1088967:${index}:x`,
    microblog_id: 1088967,
    source_kind: 'blog',
    url: LONG_URL,
    section: 'Blog post',
    text
  });
  return {
    weekly_thing: { issues: [{ number: 147, publish_date: '2020-05-09T12:00:00Z' }], chunks: [] },
    blog: {
      posts: [
        { microblog_id: 1088967, url: LONG_URL, publish_date: '2020-05-06' },
        { microblog_id: 20001, url: SHORT_URL, publish_date: '2020-05-07' }
      ],
      chunks: [
        passage(0, WORK),
        passage(1, EVENT),
        passage(2, CLOSE),
        { id: 'blog:20001:0:x', microblog_id: 20001, source_kind: 'blog', url: SHORT_URL, text: 'Espresso.' }
      ]
    }
  };
}

const copyOf = (id, url, text, extra = {}) => ({
  id,
  issue_number: 147,
  source_kind: 'chunk',
  section: 'mini minnebar',
  text,
  journal_posts: [{ url, copy_of_microblog_id: id === 'short-copy' ? '20001' : '1088967', canonical_url: url }],
  ...extra
});

test('a Journal copy drops only beside the passage of its post it copies (QA3 Q7)', () => {
  const fixtures = passageFixtures();
  primeCorpusCachesForTests(fixtures);
  const [work, event, close, espresso] = fixtures.blog.chunks;
  const ids = (list) => list.map((chunk) => chunk.id);
  // WT147's "mini minnebar" copy reprints the post's event paragraph.
  const copy = copyOf('mini-copy', LONG_URL, `Last weekend was Minnebar. ${EVENT}`);
  assert.deepEqual(ids(dedupeJournalTwins([copy, work])), ['mini-copy', work.id], 'an unrelated passage keeps it');
  assert.deepEqual(ids(dedupeJournalTwins([copy, close, work])), ['mini-copy', close.id, work.id]);
  assert.deepEqual(ids(dedupeJournalTwins([copy, event])), [event.id], 'the copied passage wins');
  // The page judges it the same way: refilled only when the copy drops.
  assert.deepEqual(ids(pageWithoutTwins([copy, work, close], 2)), ['mini-copy', work.id]);
  assert.deepEqual(ids(pageWithoutTwins([copy, event, close], 2)), [event.id, close.id]);

  // A copy spanning two passages drops when the page shows at least half
  // of what it took from the post.
  const span = copyOf('span-copy', LONG_URL, `${WORK} ${words('event', 40)}`);
  assert.deepEqual(ids(dedupeJournalTwins([span, work])), [work.id]);
  assert.deepEqual(ids(dedupeJournalTwins([span, event])), ['span-copy', event.id], 'a minority of its words');

  // A teaser written for the issue shares no words with any passage.
  const teaser = copyOf('teaser', LONG_URL, 'An introduction to remote events and where they help.');
  assert.deepEqual(ids(dedupeJournalTwins([teaser, work, event, close])), ['teaser', work.id, event.id, close.id]);

  // A one-passage post is its own passage, whatever Jamie edited.
  const short = copyOf('short-copy', SHORT_URL, 'Espresso, again. Edited for the issue.');
  assert.deepEqual(ids(dedupeJournalTwins([short, espresso])), [espresso.id]);
});

test('a utility entry is its own host only; wikipedia.org keeps its language editions (QA3 Q2)', () => {
  for (const host of [
    'amazon.com',
    'www.amazon.com',
    'mobile.twitter.com',
    'm.facebook.com',
    'twitter.com',
    'micro.blog',
    'en.wikipedia.org',
    'en.m.wikipedia.org',
    'de.wikipedia.org',
    'collectors.poap.xyz'
  ]) {
    assert.equal(utilityDomain(host), true, host);
  }
  for (const host of [
    'aws.amazon.com',
    'console.aws.amazon.com',
    'remars.amazon.com',
    'code.facebook.com',
    'blog.poap.xyz',
    'blog.linkedin.com',
    'engineering.linkedin.com',
    'blog.twitter.com',
    'manton.micro.blog',
    'help.micro.blog'
  ]) {
    assert.equal(utilityDomain(host), false, host);
  }
});

test('a blank url, id or domain is refused, never read as absent (QA3 Q3)', async () => {
  for (const [tool, args, key] of [
    ['find_links', { url: '' }, 'url'],
    ['find_links', { url: '   ' }, 'url'],
    ['find_links', { id: '  ' }, 'id'],
    ['find_links', { domain: '' }, 'domain'],
    ['list_content', { domain: ' ' }, 'domain'],
    ['search_archive', { query: 'rss', section: ' ' }, 'section'],
    ['archive_gems', { theme: '' }, 'theme']
  ]) {
    assert.match(
      validateToolArguments(tool, args).join(' '),
      new RegExp(`^${key} is blank`),
      `${tool} ${JSON.stringify(args)}`
    );
  }
  assert.deepEqual(validateToolArguments('get_source', { id: '  ' }), ['id is required']);
  assert.deepEqual(validateToolArguments('find_links', { domain: 'x.com' }), []);

  primeCorpusCachesForTests(passageFixtures());
  for (const args of [{ url: '' }, { id: '  ' }, { domain: '' }]) {
    const out = await ARCHIVE_TOOLS.find_links(args, { scope: 'all' });
    assert.equal(out.code, 'bad_request', JSON.stringify(args));
  }
  assert.equal((await ARCHIVE_TOOLS.list_content({ domain: '  ' }, { scope: 'all' })).code, 'bad_request');
});

test('search_archive says it is a ranked top-N and keeps the voice floor (QA3 Q6, Q9)', async () => {
  primeCorpusCachesForTests(passageFixtures());
  const out = await ARCHIVE_TOOLS.search_archive({ query: 'single track' }, { scope: 'all' });
  assert.ok(out.results.length > 0);
  assert.match(out.note, /not every match/);
  assert.match(out.note, /quote_search/);
  assert.match(out.note, /archive_lens/);
  const [spec] = mcpToolDeclarations(['search_archive']);
  assert.match(spec.description, /does not page/);
  assert.match(spec.inputSchema.properties.voice.description, /under 40 characters/);
  assert.ok('note' in spec.outputSchema.properties);
});

function photoFixtures() {
  const blogUrl = 'https://www.thingelstad.com/uploads/2026/0e514b8635.jpg';
  return {
    weekly_thing: {
      issues: [{ number: 340, publish_date: '2027-02-08T14:44:36Z' }],
      chunks: [],
      media: [
        {
          url: 'https://files.thingelstad.com/weekly-thing/340/journal/0e514b8635.jpg',
          source_kind: 'weekly_thing',
          issue_number: 340,
          source_url: '/archive/340/',
          publish_date: '2027-02-08T14:44:36Z',
          copy_of_microblog_id: '5747260',
          canonical_url: blogUrl,
          description: 'A large indoor sports facility with a domed ceiling.'
        }
      ]
    },
    blog: {
      posts: [{ microblog_id: 5747260, url: 'https://www.thingelstad.com/2026/02/04/give-back.html' }],
      chunks: [],
      media: [
        {
          url: blogUrl,
          source_kind: 'blog',
          microblog_id: 5747260,
          source_url: 'https://www.thingelstad.com/2026/02/04/give-back.html',
          publish_date: '2026-02-04',
          description: 'A large indoor arena hosts an agility dog competition.'
        }
      ]
    }
  };
}

test("a photo matches when either copy's description does, and the blog photo shows (QA3 Q13)", async () => {
  primeCorpusCachesForTests(photoFixtures());
  for (const query of ['agility dog', 'sports facility', 'dog sports facility']) {
    const out = await ARCHIVE_TOOLS.media_search({ query }, { scope: 'all' });
    assert.equal(out.total_count, 1, query);
    assert.equal(out.results[0].source_id, 'blog-5747260', query);
    assert.deepEqual(out.results[0].also_in_issues, [340], query);
  }
  const both = await ARCHIVE_TOOLS.media_search({ query: 'dog sports' }, { scope: 'all' });
  assert.deepEqual(both.results[0].match_reasons, ["description: 'dog'", "description (WT340 copy): 'sports'"]);
  assert.equal(both.collapsed_copies, 1);
  // The blog photo outside the window: the copy shows, found by the blog's words.
  const copy = await ARCHIVE_TOOLS.media_search({ query: 'agility', year: 2027 }, { scope: 'all' });
  assert.equal(copy.results[0].source_id, 'wt-340');
  assert.equal(copy.results[0].copy_of, 'blog-5747260');
  assert.deepEqual(copy.results[0].match_reasons, ["description (blog photo): 'agility'"]);
});

test('per-year photo totals can overlap, and a year listing says so (QA3 Q14)', async () => {
  primeCorpusCachesForTests(photoFixtures());
  const all = await ARCHIVE_TOOLS.media_search({}, { scope: 'all' });
  assert.equal(all.total_count, 1, 'the copy folds into its blog photo');
  assert.equal(all.note, undefined);
  const y2026 = await ARCHIVE_TOOLS.media_search({ year: 2026 }, { scope: 'all' });
  const y2027 = await ARCHIVE_TOOLS.media_search({ year: 2027 }, { scope: 'all' });
  assert.equal(y2026.total_count + y2027.total_count, 2, 'the photo counts in both years');
  assert.equal(y2027.results[0].source_id, 'wt-340');
  assert.match(y2026.note, /year totals can sum past the whole listing/);
});

test('on_this_day runs a day of blog posts by Chicago time of day (QA3 Q17)', async () => {
  const post = (id, published, extra = {}) => ({
    microblog_id: id,
    subject: `Post ${id}`,
    publish_date: '2021-08-06',
    url: `https://www.thingelstad.com/2021/08/06/${id}.html`,
    post_kind: 'post',
    ...(published ? { published } : {}),
    ...extra
  });
  primeCorpusCachesForTests({
    weekly_thing: {
      issues: [
        { number: 150, subject: 'Weekly Thing 150', publish_date: '2021-08-07T03:00:00Z', url: '/archive/150/' }
      ],
      chunks: []
    },
    blog: {
      // Corpus order is not time order (the 2021-08-06 Vermont posts).
      posts: [
        post(1381394, '2021-08-06T19:30:59+00:00'),
        post(1380870, '2021-08-06T13:00:00+00:00', { post_kind: 'micropost', subject: '' }),
        post(1380868, '2021-08-06T17:32:31+00:00'),
        post(1380000, null),
        post(1379999, null),
        // 8:59 pm in Chicago, after midnight UTC: still Aug 6, and last.
        post(1380702, '2021-08-07T01:59:00+00:00'),
        post(1381396, '2021-08-06T21:06:17+00:00')
      ],
      chunks: []
    }
  });
  const out = await ARCHIVE_TOOLS.on_this_day({ date: '2021-08-06', limit_per_year: 20 }, { scope: 'all' });
  assert.deepEqual(
    out.years[0].items.map((item) => item.id),
    [
      'wt-150',
      'blog-1380868',
      'blog-1381394',
      'blog-1381396',
      'blog-1380702',
      // No time of day: last of the posts, by id.
      'blog-1379999',
      'blog-1380000',
      // Microposts after the other posts.
      'blog-1380870'
    ]
  );
  assert.ok(
    out.years[0].items.every((item) => !('published' in item)),
    'the output shape is unchanged'
  );
  const [spec] = mcpToolDeclarations(['on_this_day']);
  assert.match(spec.description, /blog posts by Chicago time of day/);
});
