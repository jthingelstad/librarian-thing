// QA round 2, retrieval family: the Journal dedupe works on the returned
// page, not the candidate pool.
import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesFilters, pageWithoutTwins, primeCorpusCachesForTests, retrieve } from '../dist/shared/retrieval.mjs';

// retrieve() reranks through Bedrock; a test never calls out. The fixture
// chunks carry no embeddings, so the semantic leg is skipped too.
process.env.LIBRARIAN_RERANK_ENABLED = '0';

const POST_URL = 'https://www.thingelstad.com/2020/05/06/connecting-online.html';

function journalFixtures() {
  return {
    weekly_thing: {
      issues: [{ number: 147, publish_date: '2020-05-09T12:00:00Z' }],
      chunks: [
        {
          id: 'wt-147-copy',
          issue_number: 147,
          source_kind: 'chunk',
          section: 'mini minnebar',
          text: 'Minnebar session Minnebar session Minnebar session attended remotely.',
          journal_posts: [{ url: POST_URL, copy_of_microblog_id: '1088967', canonical_url: POST_URL }]
        },
        {
          id: 'wt-150-other',
          issue_number: 150,
          source_kind: 'chunk',
          section: 'Notable',
          text: 'A Minnebar session recap from somebody else entirely, about a session.'
        }
      ]
    },
    blog: {
      posts: [{ microblog_id: 1088967, url: POST_URL, publish_date: '2020-05-06' }],
      chunks: [
        {
          id: 'blog:1088967:0:a',
          microblog_id: 1088967,
          source_kind: 'blog',
          url: POST_URL,
          section: 'Blog post',
          text: `Fully remote work. ${'Other words about connecting online and inclusivity. '.repeat(30)} One Minnebar mention.`
        }
      ]
    }
  };
}

test('a Journal copy on the page stays when its post ranks below the cut (QA2 R2-3)', async () => {
  primeCorpusCachesForTests(journalFixtures());
  const page = await retrieve('Minnebar session', 1, { scope: 'all' });
  assert.deepEqual(
    page.map((chunk) => chunk.id),
    ['wt-147-copy'],
    'the copy or its post must be on the page; the copy ranks first'
  );
  const deeper = await retrieve('Minnebar session', 3, { scope: 'all' });
  assert.deepEqual(
    deeper.map((chunk) => chunk.id),
    ['wt-150-other', 'blog:1088967:0:a'],
    'with the post on the page, the post wins and the page is refilled'
  );
});

test('pageWithoutTwins refills a page the dedupe shrank, and never past the ranked list', () => {
  const copy = { id: 'copy', source_kind: 'chunk', journal_posts: [{ copy_of_microblog_id: '9', url: POST_URL }] };
  const post = { id: 'post', source_kind: 'blog', microblog_id: 9, url: POST_URL };
  const others = ['a', 'b', 'c'].map((id) => ({ id, source_kind: 'blog', url: `https://x/${id}` }));
  const ids = (list) => list.map((chunk) => chunk.id);
  assert.deepEqual(ids(pageWithoutTwins([copy, post, ...others], 3)), ['post', 'a', 'b']);
  assert.deepEqual(ids(pageWithoutTwins([copy, others[0], post], 2)), ['copy', 'a']);
  assert.deepEqual(ids(pageWithoutTwins([copy, post], 5)), ['post']);
  // A post below the cut never drops the copy above it.
  assert.deepEqual(ids(pageWithoutTwins([copy, others[0], others[1], post], 3)), ['copy', 'a', 'b']);
});

test('section matches every passage under its H2 group heading (QA2 R2-2)', () => {
  const body = [
    '## Must Read',
    '',
    '### [Article One](https://a.com)',
    '',
    'About one.',
    '',
    '## Stream',
    '',
    'Lead-in.',
    '',
    '### Ms. PAC-MAN',
    '',
    'Tammy loves Ms. PAC-MAN.',
    '',
    '```',
    '## not a heading',
    '```'
  ].join('\n');
  const chunks = [
    { id: 'c1', issue_number: 146, section: 'Article One', section_family: 'Featured', text: 'About one.' },
    { id: 'c2', issue_number: 146, section: 'Stream', section_family: 'Journal', text: 'Lead-in.' },
    { id: 'c3', issue_number: 146, section: 'Ms. PAC-MAN', section_family: 'Journal', text: 'Tammy loves Ms. PAC-MAN.' }
  ];
  primeCorpusCachesForTests({ weekly_thing: { issues: [{ number: 146, body }], chunks } });
  const kept = (section) => chunks.filter((chunk) => matchesFilters(chunk, { section })).map((chunk) => chunk.id);
  assert.deepEqual(kept('Stream'), ['c2', 'c3']);
  assert.deepEqual(kept('must read'), ['c1']);
  assert.deepEqual(kept('**Must  Read**'), ['c1'], 'heading marks and spaces fold');
  assert.deepEqual(kept('Article One'), ['c1']);
  assert.deepEqual(kept('PAC'), ['c3'], 'any other name still matches inside headings');
  assert.deepEqual(kept('not a heading'), [], 'a heading-shaped line in a fence is not a group');
});
