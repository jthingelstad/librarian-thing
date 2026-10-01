import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS, canonicalSourceInput } from '../dist/shared/archive-tools.mjs';
import { parseResourceUri, readResource } from '../dist/shared/mcp-resources.mjs';
import { primeCorpusCachesForTests } from '../dist/shared/retrieval.mjs';
import { blogKeyPart, blogSourceId } from '../dist/shared/source-identity.mjs';

// micro.blog numbers pages and posts separately: page 71862 "Charlie Brown
// Tree" shares its uid with a post. Pages are their own ids (page-<uid>).
const POST_URL = 'https://www.thingelstad.com/2019/12/01/tree-post.html';
const PAGE_URL = 'https://www.thingelstad.com/charlie-brown-tree/';

function fixtures() {
  return {
    weekly_thing: { issues: [], chunks: [], links: [], media: [] },
    blog: {
      post_count: 1,
      page_count: 1,
      posts: [
        {
          microblog_id: 71862,
          subject: 'A post about the tree',
          publish_date: '2019-12-01',
          url: POST_URL,
          post_kind: 'post',
          categories: []
        },
        {
          page_id: 71862,
          subject: 'Charlie Brown Tree',
          publish_date: null,
          updated: '2024-12-15T10:00:00-06:00',
          url: PAGE_URL,
          post_kind: 'page',
          section: 'Page',
          categories: []
        }
      ],
      chunks: [
        {
          id: 'blog:71862:0:aaa',
          source_kind: 'blog',
          microblog_id: 71862,
          url: POST_URL,
          subject: 'A post about the tree',
          publish_date: '2019-12-01',
          section: 'Blog post',
          text: 'We put up the little tree again. See the page for its history.'
        },
        {
          id: 'page:71862:0:bbb',
          source_kind: 'blog',
          page_id: 71862,
          url: PAGE_URL,
          subject: 'Charlie Brown Tree',
          publish_date: null,
          updated: '2024-12-15T10:00:00-06:00',
          section: 'Page',
          text: 'The Charlie Brown tree has stood in our window every December since 2009.'
        }
      ],
      links: [
        {
          corpus_kind: 'blog',
          microblog_id: 71862,
          post_url: POST_URL,
          publish_date: '2019-12-01',
          url: PAGE_URL,
          target_page_id: 71862,
          section: 'Blog post'
        }
      ],
      media: []
    },
    podcast: { episodes: [], chunks: [], links: [] }
  };
}

test('page and post ids never collide', () => {
  assert.equal(blogSourceId({ page_id: 71862 }), 'page-71862');
  assert.equal(blogSourceId({ microblog_id: 71862 }), 'blog-71862');
  assert.notEqual(blogKeyPart({ page_id: 71862 }), blogKeyPart({ microblog_id: 71862 }));
  assert.equal(blogSourceId({}), '');
});

test('get_source resolves page-<id> to the page and blog-<id> to the post', async () => {
  primeCorpusCachesForTests(fixtures());
  const page = await ARCHIVE_TOOLS.get_source({ id: 'page-71862' }, { scope: 'all' });
  assert.equal(page.source.id, 'page-71862');
  assert.equal(page.source.url, PAGE_URL);
  assert.match(JSON.stringify(page.source), /every December since 2009/);
  assert.doesNotMatch(JSON.stringify(page.source), /put up the little tree/);

  const post = await ARCHIVE_TOOLS.get_source({ id: 'blog-71862' }, { scope: 'all' });
  assert.equal(post.source.id, 'blog-71862');
  assert.equal(post.source.url, POST_URL);
  assert.doesNotMatch(JSON.stringify(post.source), /every December since 2009/);
});

test('canonicalSourceInput accepts a page id in any case', () => {
  const input = canonicalSourceInput({ id: 'PAGE-5' });
  assert.match(JSON.stringify(input), /page/i);
  assert.match(JSON.stringify(input), /5/);
});

test('list_content names the page by its page id', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.list_content({ source_kind: 'blog' }, { scope: 'all' });
  const ids = out.results.map((row) => row.id);
  assert.ok(ids.includes('page-71862'), JSON.stringify(ids));
  assert.deepEqual(ids, ['blog-71862', 'page-71862'], 'undated pages list after every dated source');
  assert.equal(out.undated_count, 1, 'the page is in total_count and in no year');
  assert.equal(out.counts_by_year.reduce((sum, row) => sum + row.count, 0) + out.undated_count, out.total_count);
  const stats = await ARCHIVE_TOOLS.corpus_stats({ source_kind: 'blog' }, { scope: 'all' });
  assert.equal(stats.sources[0].item_count, 2, 'item_count is posts and pages');
});

test('quote_search finds a phrase on a page, and corpus_stats counts pages', async () => {
  primeCorpusCachesForTests(fixtures());
  const quote = await ARCHIVE_TOOLS.quote_search({ phrase: 'every December since 2009' }, { scope: 'all' });
  assert.match(JSON.stringify(quote), /page-71862/);
  const stats = await ARCHIVE_TOOLS.corpus_stats({ source_kind: 'blog' }, { scope: 'all' });
  const blog = stats.sources.find((row) => row.source_kind === 'blog');
  assert.equal(blog.page_count, 1);
  assert.equal(blog.post_count, 1);
});

test('undated pages stay out of latest_content, on_this_day and year filters', async () => {
  primeCorpusCachesForTests(fixtures());
  const latest = await ARCHIVE_TOOLS.latest_content({ source_kind: 'blog' }, { scope: 'all' });
  assert.deepEqual(
    latest.results.map((row) => row.id),
    ['blog-71862']
  );
  const otd = await ARCHIVE_TOOLS.on_this_day({ date: '2026-12-15' }, { scope: 'all' });
  assert.ok(!JSON.stringify(otd).includes('page-71862'));
  const year = await ARCHIVE_TOOLS.list_content({ source_kind: 'blog', year: 2024 }, { scope: 'all' });
  assert.ok(!JSON.stringify(year).includes('page-71862'), 'updated is not a publish date');
});

test('a post linking a page reaches it as the page, not the same-numbered post', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.source_neighborhood({ id: 'page-71862' }, { scope: 'all' });
  assert.match(JSON.stringify(out), /blog-71862/, 'the linking post appears as incoming');
  const post = await ARCHIVE_TOOLS.source_neighborhood({ id: 'blog-71862' }, { scope: 'all' });
  assert.ok(!JSON.stringify(post.incoming || []).includes('blog-71862'), 'the post does not link itself');
});

test('librarian://page/{id} reads page-<id>', async () => {
  const resource = parseResourceUri('librarian://page/71862');
  assert.equal(resource.kind, 'page');
  const calls = [];
  const reader = {
    invoke: async (name, input) => {
      calls.push({ name, ...input });
      return { source: { id: 'page-71862', subject: 'Charlie Brown Tree', body: 'The tree.' } };
    },
    render: () => ({ text: '', isError: false })
  };
  const read = await readResource(resource, reader);
  assert.equal(calls[0].id, 'page-71862');
  assert.match(read.text, /The tree\./);
});
