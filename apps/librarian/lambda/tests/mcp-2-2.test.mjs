// MCP 2.2.0: Jamie's answers to the 2026-09-30 QA questions (Chicago days,
// editorial links, the blog post as canonical over its Weekly Thing copy,
// photo copies, exact sections, slash-or topics, voice) and the last QA
// findings (get_source paging and sections, neighbourhood counts, clipped
// passages, unknown topics and categories).
import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS, headingKey, passageWindow } from '../dist/shared/archive-tools.mjs';
import { aliasesFor } from '../dist/shared/matcher.mjs';
import { dedupeJournalTwins, localDay, primeCorpusCachesForTests, voicedText } from '../dist/shared/retrieval.mjs';

// search_archive reranks through Bedrock; a test never calls out.
process.env.LIBRARIAN_RERANK_ENABLED = '0';
const CTX = { scope: 'all' };
const LONG_BODY = Array.from(
  { length: 1400 },
  (_v, index) => `Paragraph ${index} has ten words of text in it, near enough.`
).join('\n\n');

function fixtures() {
  return {
    weekly_thing: {
      topics: [{ name: 'Crypto and web3' }, { name: 'AI and agents' }],
      issues: [
        {
          number: 35,
          subject: 'WT35',
          publish_date: '2018-01-07T01:28:00Z',
          url: '/archive/35/',
          body: [
            '## Coffee',
            '',
            'Espresso notes.',
            '',
            '## Coffee Gear',
            '',
            'Grinders.',
            '',
            '## Links 📌',
            '',
            '### Article One',
            '',
            'About one.',
            '',
            '### #MNTech meetup',
            '',
            'About two.'
          ].join('\n'),
          sections: [
            { name: 'Coffee', section_family: 'Intro', text: 'Espresso notes.' },
            { name: 'Coffee Gear', section_family: 'Notable', text: 'Grinders.' },
            { name: 'Article One', section_family: 'Notable', text: 'About one.' },
            { name: 'MNTech meetup', section_family: 'Notable', text: 'About two.' }
          ]
        },
        { number: 36, subject: 'WT36', publish_date: '2018-01-13T13:00:00Z', url: '/archive/36/', body: LONG_BODY }
      ],
      chunks: [
        {
          id: 'wt:36:journal',
          issue_number: 36,
          source_kind: 'weekly_thing',
          section: 'Journal',
          text: 'A copy of the espresso post.',
          journal_post_urls: ['https://www.thingelstad.com/2018/01/10/old-permalink.html'],
          journal_posts: [
            {
              url: 'https://www.thingelstad.com/2018/01/10/old-permalink.html',
              copy_of_microblog_id: '501',
              canonical_url: 'https://www.thingelstad.com/2018/01/10/espresso.html',
              matched_by: 'date_text'
            }
          ]
        }
      ],
      links: [
        {
          issue_number: 35,
          issue_year: 2018,
          publish_date: '2018-01-07T01:28:00Z',
          domain: 'a.com',
          url: 'https://a.com/1',
          link_role: 'headline'
        },
        {
          issue_number: 35,
          issue_year: 2018,
          publish_date: '2018-01-07T01:28:00Z',
          domain: 'b.com',
          url: 'https://b.com/1',
          link_role: 'headline'
        },
        {
          issue_number: 35,
          issue_year: 2018,
          publish_date: '2018-01-07T01:28:00Z',
          domain: 'c.com',
          url: 'https://c.com/1',
          link_role: 'headline'
        }
      ],
      media: [
        {
          url: 'https://cdn.uploads.micro.blog/1/2018/espresso-wt.jpg',
          alt: 'Espresso',
          source_kind: 'weekly_thing',
          issue_number: 36,
          publish_date: '2018-01-13T13:00:00Z',
          copy_of_microblog_id: '501',
          canonical_url: 'https://cdn.uploads.micro.blog/1/2018/espresso.jpg'
        },
        {
          url: 'https://cdn.uploads.micro.blog/1/2018/espresso-only-wt.jpg',
          alt: 'Latte art',
          context: 'espresso',
          source_kind: 'weekly_thing',
          issue_number: 36,
          publish_date: '2018-01-13T13:00:00Z',
          copy_of_microblog_id: '502',
          canonical_url: 'https://cdn.uploads.micro.blog/1/2018/latte.jpg'
        }
      ]
    },
    blog: {
      posts: [
        {
          microblog_id: 501,
          subject: 'Espresso',
          publish_date: '2018-01-10',
          url: 'https://www.thingelstad.com/2018/01/10/espresso.html',
          categories: ['Coffee']
        }
      ],
      chunks: [
        {
          id: 'blog:501:0:abc',
          microblog_id: 501,
          source_kind: 'blog',
          url: 'https://www.thingelstad.com/2018/01/10/espresso.html',
          text: 'The espresso post.'
        }
      ],
      links: [
        {
          source_kind: 'blog',
          microblog_id: 501,
          post_year: 2018,
          publish_date: '2018-01-10',
          url: 'https://youtube.com/watch?v=1',
          domain: 'youtube.com',
          link_kind: 'external'
        },
        {
          source_kind: 'blog',
          microblog_id: 501,
          post_year: 2018,
          publish_date: '2018-01-10',
          url: 'https://jthingelstad.micro.blog/2017/05/01/old.html',
          domain: 'jthingelstad.micro.blog'
        }
      ],
      media: [
        {
          url: 'https://cdn.uploads.micro.blog/1/2018/espresso.jpg',
          alt: 'Espresso',
          source_kind: 'blog',
          subject: 'Espresso',
          microblog_id: 501,
          source_url: 'https://www.thingelstad.com/2018/01/10/espresso.html',
          publish_date: '2018-01-10'
        }
      ]
    }
  };
}

test('localDay: a source is on its Chicago day', () => {
  assert.equal(
    localDay({ publish_date: '2018-01-07T01:28:00Z' }),
    '2018-01-06',
    'WT35 went out on the evening of Jan 6'
  );
  assert.equal(localDay({ publish_date: '2019-09-29' }), '2019-09-29');
  assert.equal(localDay({ published: '2024-07-01T04:30:00Z', publish_date: '2024-07-01' }), '2024-06-30');
});

test('voice: image markup is nobody s words, and FAQ or site copy is no voice at all', () => {
  const chunk = { text: 'Look ![a machine caption](https://x/y.jpg) here <img src="z.jpg" alt="more"> now.' };
  assert.equal(voicedText(chunk, ['jamie']), 'Look here now.');
  assert.equal(voicedText({ text: 'An answer.', source_kind: 'faq' }, ['jamie']), '');
  assert.equal(voicedText({ text: 'About.', content_kind: 'site_page' }, ['jamie']), '');
  assert.equal(voicedText({ text: 'Untouched.', source_kind: 'faq' }, []), 'Untouched.', 'no voice filter, no change');
});

test('a slash in a topic means or; a url keeps its slashes', () => {
  const sides = aliasesFor('Twitter/X');
  assert.ok(sides.includes('Twitter'));
  assert.ok(sides.includes('X'));
  assert.deepEqual(aliasesFor('https://x.com/jamie'), []);
  assert.deepEqual(aliasesFor('/archive/'), []);
});

test('archive_lens keeps the built-in aliases when the caller passes its own', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.archive_lens({ topic: 'Minnebar', aliases: ['MNTech'] }, CTX);
  assert.ok(out.aliases_checked.includes('MNTech'));
  assert.ok(out.aliases_checked.includes('Minnedemo'), 'the built-in alias stays');
});

test('top_references counts Weekly Thing picks only and says what it measured', async () => {
  primeCorpusCachesForTests(fixtures());
  const all = await ARCHIVE_TOOLS.top_references({}, CTX);
  assert.deepEqual(
    all.top.map((row) => row.domain),
    ['a.com', 'b.com', 'c.com']
  );
  assert.equal(all.excluded_blog_and_podcast_links, 1, 'the blog youtube link is not a pick');
  assert.match(all.measure, /editorial picks/);
  const blog = await ARCHIVE_TOOLS.top_references({ source_kind: 'blog' }, CTX);
  assert.deepEqual(
    blog.top.map((row) => row.domain),
    ['youtube.com']
  );
  assert.match(blog.measure, /not editorial picks/);
});

test('jthingelstad.micro.blog is Jamie s own blog', async () => {
  primeCorpusCachesForTests(fixtures());
  const internal = await ARCHIVE_TOOLS.find_links({ link_kind: 'internal', source_kind: 'blog' }, CTX);
  assert.equal(internal.total_count, 1);
  assert.equal(internal.results[0].link_url, 'https://jthingelstad.micro.blog/2017/05/01/old.html');
});

test('get_source: an exact section wins, any body heading reads, and a miss lists the sections', async () => {
  primeCorpusCachesForTests(fixtures());
  const coffee = await ARCHIVE_TOOLS.get_source({ id: 'wt-35', section: 'coffee', format: 'text' }, CTX);
  assert.deepEqual(
    coffee.source.sections.map((section) => section.name),
    ['Coffee'],
    'Coffee, not Coffee Gear'
  );
  const group = await ARCHIVE_TOOLS.get_source({ id: 'wt-35', section: 'Links 📌', format: 'text' }, CTX);
  assert.match(group.source.body, /About one\.[\s\S]*About two\./);
  const marked = await ARCHIVE_TOOLS.get_source({ id: 'wt-35', section: '#MNTech meetup', format: 'text' }, CTX);
  assert.match(marked.source.body, /About two\./, 'markdown marks and no-break spaces do not count');
  const missing = await ARCHIVE_TOOLS.get_source({ id: 'wt-35', section: 'Nonexistent' }, CTX);
  assert.equal(missing.code, 'bad_request');
  assert.deepEqual(missing.available_sections, ['Coffee', 'Coffee Gear', 'Article One', 'MNTech meetup']);
  assert.equal(headingKey('*Not* `yes`  #1'), 'not yes 1');
});

test('get_source: offset pages through a body longer than one result', async () => {
  primeCorpusCachesForTests(fixtures());
  let offset = 0;
  let text = '';
  let calls = 0;
  for (;;) {
    const page = await ARCHIVE_TOOLS.get_source({ id: 'wt-36', format: 'text', ...(offset ? { offset } : {}) }, CTX);
    calls += 1;
    text += page.source.body;
    if (!page.truncated?.next_offset) break;
    assert.match(page.truncated.hint, /call again with offset \d+ for the rest/);
    offset = page.truncated.next_offset;
  }
  assert.ok(calls > 1);
  assert.equal(text, LONG_BODY);
  const past = await ARCHIVE_TOOLS.get_source({ id: 'wt-36', format: 'text', offset: LONG_BODY.length }, CTX);
  assert.equal(past.code, 'bad_request');
});

test('source_neighborhood counts every link, and find_links id pages through one source', async () => {
  const many = fixtures();
  many.weekly_thing.links = Array.from({ length: 45 }, (_v, index) => ({
    issue_number: 35,
    issue_year: 2018,
    publish_date: '2018-01-07T01:28:00Z',
    domain: `site${index}.com`,
    url: `https://site${index}.com/`,
    link_role: 'headline'
  }));
  primeCorpusCachesForTests(many);
  const near = await ARCHIVE_TOOLS.source_neighborhood({ id: 'wt-35' }, CTX);
  assert.equal(near.outgoing_count, 45);
  assert.equal(near.outgoing_links.length, 30);
  assert.equal(near.truncated.omitted.outgoing_links, 15);
  assert.match(near.truncated.hint, /find_links with id wt-35/);
  const links = await ARCHIVE_TOOLS.find_links({ id: 'wt-35', limit: 50 }, CTX);
  assert.equal(links.total_count, 45);
  assert.deepEqual(
    links.results.slice(0, 2).map((row) => row.domain),
    ['site0.com', 'site1.com'],
    'in the order the source carries them'
  );
  const none = await ARCHIVE_TOOLS.find_links({ id: 'wt-999' }, CTX);
  assert.match(none.error, /not found/);
});

test('passageWindow shows where the rare query words are, and says it clipped', () => {
  const text = `Winnipeg Folk Fest. ${'Winnipeg music filler. '.repeat(120)}Then a crazy nap in the shade. ${'More. '.repeat(50)}`;
  const shown = passageWindow({ text }, 'Winnipeg Folk Fest crazy nap in the shade', 400);
  assert.match(shown.text, /crazy nap in the shade/);
  assert.equal(shown.clipped.chars, text.length);
  assert.equal(shown.text, text.slice(shown.clipped.start, shown.clipped.end));
  assert.deepEqual(passageWindow({ text: 'Short.' }, 'short', 400), { text: 'Short.' });
});

test('search_archive refuses an unknown topic or category, and takes a topic slug', async () => {
  primeCorpusCachesForTests(fixtures());
  const slug = await ARCHIVE_TOOLS.search_archive({ query: 'espresso', topic: 'crypto-and-web3' }, CTX);
  assert.equal(slug.error, undefined);
  const topic = await ARCHIVE_TOOLS.search_archive({ query: 'espresso', topic: 'crypto' }, CTX);
  assert.equal(topic.code, 'bad_request');
  assert.match(topic.error, /Crypto and web3, AI and agents/);
  const typo = await ARCHIVE_TOOLS.search_archive({ query: 'espresso', category: 'Cofee' }, CTX);
  assert.equal(typo.code, 'bad_request');
  assert.match(typo.error, /Coffee/);
  const wrongKind = await ARCHIVE_TOOLS.search_archive(
    { query: 'espresso', category: 'Coffee', source_kind: 'weekly_thing' },
    CTX
  );
  assert.equal(wrongKind.code, 'bad_request');
});

test('the blog post wins over its Weekly Thing Journal copy, by microblog id when the permalink moved', () => {
  const copy = fixtures().weekly_thing.chunks[0];
  const post = fixtures().blog.chunks[0];
  assert.deepEqual(dedupeJournalTwins([copy, post]), [post]);
  assert.deepEqual(dedupeJournalTwins([copy]), [copy], 'a copy alone stays');
});

test('a Journal chunk that copies two posts stays until both posts are in the pool', () => {
  const one = 'https://www.thingelstad.com/2018/01/10/one.html';
  const two = 'https://www.thingelstad.com/2018/01/10/two.html';
  const copy = {
    id: 'wt-36-journal',
    source_kind: 'chunk',
    journal_post_urls: [one],
    // The second entry is a heading with no link: matched by date and text.
    journal_posts: [
      { url: one, copy_of_microblog_id: '601', canonical_url: one, matched_by: 'permalink' },
      { url: null, copy_of_microblog_id: '602', canonical_url: two, matched_by: 'date_text' }
    ]
  };
  const postOne = { id: 'blog-601', source_kind: 'blog', url: one, microblog_id: '601' };
  const postTwo = { id: 'blog-602', source_kind: 'blog', url: two, microblog_id: 602 };
  assert.deepEqual(
    dedupeJournalTwins([copy, postOne]).map((chunk) => chunk.id),
    ['wt-36-journal', 'blog-601'],
    'post two is only in the copy'
  );
  assert.deepEqual(dedupeJournalTwins([copy, postOne, postTwo]).map((chunk) => chunk.id), ['blog-601', 'blog-602']);
  const unmatched = { ...copy, journal_posts: [copy.journal_posts[0], { url: null, matched_by: null }] };
  assert.deepEqual(
    dedupeJournalTwins([unmatched, postOne, postTwo]).map((chunk) => chunk.id),
    ['wt-36-journal', 'blog-601', 'blog-602'],
    'an entry tied to no post keeps its copy'
  );
});

test('search_archive names the canonical post on a Journal copy', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.search_archive({ query: 'copy espresso', source_kind: 'weekly_thing' }, CTX);
  const passage = out.results.flatMap((group) => group.passages).find((item) => item.copy_of);
  assert.deepEqual(passage.copy_of, [{ id: 'blog-501', url: 'https://www.thingelstad.com/2018/01/10/espresso.html' }]);
});

test('media_search folds a Weekly Thing photo copy into its blog photo, and keeps a lone copy', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.media_search({ query: 'espresso' }, CTX);
  assert.equal(out.collapsed_copies, 1);
  assert.equal(out.total_count, 2);
  const blog = out.results.find((row) => row.source_kind === 'blog');
  assert.deepEqual(blog.also_in_issues, [36]);
  const lone = out.results.find((row) => row.source_kind === 'weekly_thing');
  assert.equal(lone.copy_of, 'blog-502', 'its blog photo did not match, so it stays and names its post');
  const wt = await ARCHIVE_TOOLS.media_search({ query: 'espresso', source_kind: 'weekly_thing' }, CTX);
  assert.equal(wt.total_count, 2, 'asked for Weekly Thing photos, the copies are what there is');
  assert.equal(wt.collapsed_copies, undefined);
});

test('search_faq says when nothing matches', async () => {
  const out = await ARCHIVE_TOOLS.search_faq({ query: 'zxqvbn florp' }, CTX);
  assert.deepEqual(out.results, []);
  assert.match(out.note, /No FAQ entry matches/);
});

test('compare_eras counts each era and says when one is empty', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.compare_eras({ topic: 'espresso', year_a: [2005, 2005], year_b: [2018, 2018] }, CTX);
  assert.equal(out.era_a.sources_published, 0);
  assert.match(out.era_a.note, /No content was published in this era/);
  assert.equal(out.era_b.sources_published, 3, 'WT35, WT36 and the espresso post');
  assert.ok(out.era_b.sources_naming_topic >= 1);
  assert.equal(out.era_b.note, undefined);
});

test('on_this_day: within a day, the issue, then the episode, then blog posts', async () => {
  primeCorpusCachesForTests({
    weekly_thing: {
      issues: [{ number: 100, subject: 'WT100', publish_date: '2019-09-29T13:00:00Z', url: '/archive/100/' }],
      chunks: [],
      links: []
    },
    blog: {
      posts: [
        {
          microblog_id: 9,
          subject: 'Post',
          publish_date: '2019-09-29',
          url: 'https://www.thingelstad.com/2019/09/29/p.html'
        }
      ],
      chunks: [],
      links: []
    },
    podcast: {
      episodes: [
        {
          number: 4,
          show: 'Another Thing',
          subject: 'Ep 4',
          publish_date: '2019-09-29',
          url: 'https://another.thingelstad.com/4/'
        }
      ],
      chunks: [],
      links: []
    }
  });
  const out = await ARCHIVE_TOOLS.on_this_day({ date: '2026-09-29' }, CTX);
  const kinds = out.years.flatMap((year) => year.items.map((item) => item.source_kind));
  assert.deepEqual(kinds, ['weekly_thing', 'podcast', 'blog']);
});

test('archive_gems: every mode draws, and a theme path says how many sources it chose from', async () => {
  const issues = Array.from({ length: 60 }, (_v, index) => ({
    number: index + 1,
    subject: `WT${index + 1} on espresso`,
    publish_date: `${2010 + Math.floor(index / 5)}-01-07T13:00:00Z`,
    url: `https://weekly.thingelstad.com/archive/${index + 1}/`,
    body: 'Espresso, again.',
    domains: ['a.com']
  }));
  primeCorpusCachesForTests({ weekly_thing: { issues, chunks: [], links: [] } });
  for (const mode of ['forgotten', 'recent']) {
    const draws = new Set();
    for (let round = 0; round < 8; round += 1) {
      const out = await ARCHIVE_TOOLS.archive_gems({ mode, limit: 2 }, { scope: 'weekly_thing' });
      draws.add(out.results.map((item) => item.id ?? item.issue_number).join(','));
    }
    assert.ok(draws.size > 1, `${mode}: eight draws must not all be the same`);
  }
  const theme = await ARCHIVE_TOOLS.archive_gems({ theme: 'espresso', limit: 4 }, { scope: 'weekly_thing' });
  assert.ok(theme.total_count > theme.results.length);
  assert.match(theme.truncated.hint, /A reading path is \d+ of the \d+ sources that mention espresso/);
});
