// Where a blog post appears in The Weekly Thing, as two lists (Jamie,
// 2026-10-01; QA2 I2-1, links Q1): also_in_issues, the issues whose Journal
// reprints the post; linked_from_issues, the issues that link it without
// reprinting it. A blog corpus built before the split is split at load from
// the Weekly Thing's Journal copies and the issue-week window; a corpus
// built with both lists (appearance_stats) is read as stored.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS } from '../dist/shared/archive-tools.mjs';
import { journalCopyPosts, primeCorpusCachesForTests, withBlogAppearances } from '../dist/shared/retrieval.mjs';

process.env.LIBRARIAN_RERANK_ENABLED = '0';
const CTX = { scope: 'all' };
const BASE = 'https://www.thingelstad.com';

function post(id, day, issues, title) {
  return {
    microblog_id: id,
    subject: title,
    publish_date: day,
    post_year: Number(day.slice(0, 4)),
    published: `${day}T18:00:00+00:00`,
    url: `${BASE}/${day.replaceAll('-', '/')}/${id}.html`,
    post_kind: 'post',
    domains: [],
    links: [],
    ...(issues ? { also_in_issues: issues } : {})
  };
}

// The shape live before the split: one also_in_issues per post, mixing a
// reprint (900 in WT212), a Journal link to an older post (800, December
// 2021, in WT212's prose) and a plain link (700 from WT211).
function fixtures({ built = false } = {}) {
  const posts = [
    post(900, '2022-02-11', [212], 'We escaped'),
    post(800, '2021-12-19', [212], 'NFTs are a new thing'),
    post(700, '2020-01-01', [211], 'An old favourite'),
    post(600, '2022-02-10', null, 'Never in an issue')
  ];
  const weekly = {
    issues: [
      { number: 211, subject: 'WT211', publish_date: '2022-02-05T13:00:00Z', url: '/archive/211/', body: 'Links.' },
      { number: 212, subject: 'WT212', publish_date: '2022-02-12T13:00:00Z', url: '/archive/212/', body: 'Journal.' }
    ],
    chunks: [
      {
        id: 'wt-212-journal',
        issue_number: 212,
        publish_date: '2022-02-12T13:00:00Z',
        section: 'Journal',
        source_kind: 'chunk',
        text: 'We escaped. Also see the NFT post.',
        journal_posts: [
          { url: posts[0].url, copy_of_microblog_id: '900', canonical_url: posts[0].url, matched_by: 'permalink' },
          ...(built
            ? []
            : [
                { url: posts[1].url, copy_of_microblog_id: '800', canonical_url: posts[1].url, matched_by: 'permalink' }
              ])
        ]
      }
    ],
    links: [],
    media: [],
    ...(built ? { journal_copy_stats: { references: 1 } } : {})
  };
  const blog = {
    posts: built
      ? posts.map((row) =>
          row.microblog_id === 900
            ? row
            : row.also_in_issues
              ? { ...row, also_in_issues: undefined, linked_from_issues: row.also_in_issues }
              : row
        )
      : posts,
    chunks: posts.map((row) => ({
      id: `blog:${row.microblog_id}:0:x`,
      source_kind: 'blog',
      microblog_id: row.microblog_id,
      subject: row.subject,
      publish_date: row.publish_date,
      url: row.url,
      text: row.subject,
      ...(row.also_in_issues ? { also_in_issues: row.also_in_issues } : {})
    })),
    links: [],
    media: [],
    post_count: posts.length,
    ...(built ? { appearance_stats: { also_in_issues: 1, linked_from_issues: 2 } } : {})
  };
  return { weekly_thing: weekly, blog };
}

test('an old blog corpus splits at load: a reprint from the week stays, every other issue is a link', () => {
  const { weekly_thing: weekly, blog } = fixtures();
  withBlogAppearances(blog, weekly);
  const lists = Object.fromEntries(
    blog.posts.map((row) => [row.microblog_id, [row.also_in_issues ?? null, row.linked_from_issues ?? null]])
  );
  assert.deepEqual(lists, {
    900: [[212], null],
    // WT212's Journal named the December post in prose: a link, not a copy.
    800: [null, [212]],
    700: [null, [211]],
    600: [null, null]
  });
  const chunk = blog.chunks.find((row) => row.microblog_id === 800);
  assert.deepEqual([chunk.also_in_issues, chunk.linked_from_issues], [undefined, [212]]);
  assert.deepEqual(blog.appearance_stats, { also_in_issues: 1, linked_from_issues: 2, split_at_load: true });
});

test('a corpus built with both lists is read as stored', () => {
  const { weekly_thing: weekly, blog } = fixtures({ built: true });
  // An issue the build calls a reprint stays one, Journal copy or not.
  blog.posts.find((row) => row.microblog_id === 700).also_in_issues = [211];
  withBlogAppearances(blog, weekly);
  const old = blog.posts.find((row) => row.microblog_id === 700);
  assert.deepEqual([old.also_in_issues, old.linked_from_issues], [[211], [211]]);
  assert.equal(blog.appearance_stats.split_at_load, undefined);
});

for (const built of [false, true]) {
  const shape = built ? 'built' : 'split at load';
  test(`list_content and latest_content filter on either list (${shape})`, async () => {
    primeCorpusCachesForTests(fixtures({ built }));
    const ids = (out) => out.results.map((row) => row.id ?? row.source_id).sort();
    for (const tool of ['list_content', 'latest_content']) {
      assert.deepEqual(ids(await ARCHIVE_TOOLS[tool]({ has_also_in_issues: true }, CTX)), ['blog-900']);
      assert.deepEqual(ids(await ARCHIVE_TOOLS[tool]({ has_linked_from_issues: true }, CTX)), ['blog-700', 'blog-800']);
      assert.deepEqual(ids(await ARCHIVE_TOOLS[tool]({ linked_from_issue: 212 }, CTX)), ['blog-800']);
      assert.deepEqual(ids(await ARCHIVE_TOOLS[tool]({ also_in_issue: 212 }, CTX)), ['blog-900']);
      assert.deepEqual(
        ids(await ARCHIVE_TOOLS[tool]({ has_also_in_issues: false, has_linked_from_issues: false }, CTX)),
        ['blog-600'],
        'the two filters combine'
      );
    }
    const listed = await ARCHIVE_TOOLS.list_content({ source_kind: 'blog' }, CTX);
    const row = listed.results.find((item) => item.id === 'blog-800');
    assert.deepEqual([row.also_in_issues, row.linked_from_issues], [undefined, [212]]);
  });

  test(`corpus_stats counts the posts each list holds (${shape})`, async () => {
    primeCorpusCachesForTests(fixtures({ built }));
    const stats = await ARCHIVE_TOOLS.corpus_stats({ source_kind: 'blog' }, CTX);
    const blog = stats.sources.find((source) => source.source_kind === 'blog');
    assert.equal(blog.posts_with_also_in_issues_count, 1);
    assert.equal(blog.posts_with_linked_from_issues_count, 2);
    assert.equal(blog.issues_linking_count, 2);
  });
}

test('has_audio refuses a linked_from_issues filter, as it does also_in_issues', async () => {
  primeCorpusCachesForTests(fixtures());
  for (const args of [{ has_linked_from_issues: true }, { linked_from_issue: 212 }]) {
    const out = await ARCHIVE_TOOLS.list_content({ has_audio: true, ...args }, CTX);
    assert.match(String(out.error), /linked_from_issues keep blog posts/);
  }
});

test('the Journal window applies to an old corpus only; a built one holds copies only', () => {
  const old = fixtures();
  primeCorpusCachesForTests(old);
  const chunk = old.weekly_thing.chunks[0];
  assert.deepEqual(
    journalCopyPosts(chunk).map((copy) => copy.copy_of_microblog_id),
    ['900'],
    'the December post is a reference'
  );
  const built = fixtures({ built: true });
  built.weekly_thing.chunks[0].journal_posts.push({ url: null, copy_of_microblog_id: '700', matched_by: 'date_text' });
  primeCorpusCachesForTests(built);
  assert.deepEqual(
    journalCopyPosts(built.weekly_thing.chunks[0]).map((copy) => copy.copy_of_microblog_id),
    ['900', '700'],
    'the build applied its window; the Lambda does not apply a second one'
  );
});
