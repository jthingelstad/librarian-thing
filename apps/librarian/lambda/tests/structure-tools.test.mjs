// Phase 3 structure tools (MCP 1.5.0): the skim layer, list_topics,
// similar_issues, the topic and category filters, voiced quote_search, the
// media_search issue filter, and yearly terms scored against the whole
// corpus.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS, audioChapterFor, siteTopics, siteTopicSlug } from '../dist/shared/archive-tools.mjs';
import { yearlyContentSignals } from '../dist/shared/corpus-stats.mjs';
import { validateToolArguments } from '../dist/shared/mcp.mjs';
import { blogCategoryPostIds, matchesFilters, primeCorpusCachesForTests } from '../dist/shared/retrieval.mjs';

const QUOTE = 'the best way to predict the future is to invent it';
const FRAMING = 'I keep returning to this line from Alan Kay about building things.';

function graph() {
  return {
    issues: {
      1: { entities: ['Claude', 'AWS', 'Coffee'], similar_issues: [{ number: '2', score: 0.91234 }] },
      2: { entities: ['claude', 'AWS', 'Coffee'], similar_issues: [{ number: '1', score: 0.9 }] },
      3: { entities: ['Claude', 'AWS', "Jamie's Kubb"] },
      4: { entities: ['Coffee', "Jamie's Kubb", 'Kubb'] }
    },
    entity_index: {
      claude: ['1', '2', '3'],
      aws: ['1', '2', '3'],
      coffee: ['1', '2', '4'],
      "jamie's kubb": ['3', '4'],
      kubb: ['4']
    }
  };
}

function fixtures() {
  const text = `${FRAMING}\n\n> ${QUOTE}`;
  return {
    weekly_thing: {
      issues: [
        {
          number: 1,
          subject: 'Weekly Thing 1',
          publish_date: '2018-05-01T12:00:00Z',
          url: '/archive/1/',
          description: 'The dek Jamie wrote for issue one.',
          summary: { abstract: 'Opening lines of issue one.', key_points: ['Notable: a pick'] },
          audio: { url: 'https://cdn.example/1.mp3', duration_seconds: 600, chapters: [{ start: 0, title: 'Intro' }] }
        },
        { number: 2, subject: 'Weekly Thing 2', publish_date: '2019-05-01T12:00:00Z', url: '/archive/2/' }
      ],
      chunks: [
        {
          id: 'c1',
          issue_number: 1,
          issue_year: 2018,
          publish_date: '2018-05-01T12:00:00Z',
          section: 'Notable',
          section_family: 'Notable',
          topics: ['AI and agents'],
          text,
          spans: [
            { voice: 'jamie', start: 0, end: FRAMING.length + 2 },
            { voice: 'quoted', start: FRAMING.length + 2, end: text.length }
          ]
        }
      ],
      links: [],
      media: [
        { url: 'https://files.thingelstad.com/1/a.jpg', alt: 'A lake', issue_number: 1, publish_date: '2018-05-01' },
        { url: 'https://files.thingelstad.com/2/b.jpg', alt: 'A lake', issue_number: 2, publish_date: '2019-05-01' }
      ],
      topics: [
        {
          name: 'AI and agents',
          description: 'Archive material related to ai and agents.',
          first_seen: '2018-05-01T12:00:00Z',
          last_seen: '2019-05-01T12:00:00Z',
          issue_numbers: [1, 2],
          representative_issues: [2, 1],
          related_topics: ['Software development']
        }
      ]
    },
    blog: {
      posts: [
        {
          microblog_id: 77,
          subject: 'Pour-over notes',
          publish_date: '2020-01-02',
          url: 'https://www.thingelstad.com/2020/01/02/pour-over.html',
          post_kind: 'post',
          categories: ['Coffee'],
          abstract: 'A generated summary of the pour-over post.',
          abstract_source: 'generated'
        },
        {
          microblog_id: 78,
          subject: 'Kubb day',
          publish_date: '2020-01-03',
          url: 'https://www.thingelstad.com/2020/01/03/kubb.html',
          post_kind: 'post',
          categories: ['Kubb']
        }
      ],
      chunks: []
    },
    graph: graph()
  };
}

test('site topics follow the site: 3+ issues, most frequent spelling, merged slugs, co-mentions', () => {
  const topics = siteTopics(graph());
  assert.deepEqual(
    topics.map((topic) => [topic.name, topic.slug, topic.count]),
    [
      ['AWS', 'aws', 3],
      ['Claude', 'claude', 3],
      ['Coffee', 'coffee', 3]
    ]
  );
  assert.deepEqual(topics.find((topic) => topic.slug === 'claude').related, ['AWS', 'Coffee']);
  assert.equal(siteTopicSlug("Jamie's Kubb"), 'jamies-kubb');
  assert.equal(siteTopicSlug('C++ / Rust'), 'c-rust');
});

test('list_topics returns the clusters and the site pages with urls, and narrows by query', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.list_topics({});
  assert.equal(out.clusters.length, 1);
  assert.deepEqual(out.clusters[0].representative_issues, ['wt-2', 'wt-1']);
  assert.equal(out.clusters[0].first_seen, '2018-05-01');
  assert.equal(out.topic_count, 3);
  const claude = out.topics.find((topic) => topic.name === 'Claude');
  assert.equal(claude.url, 'https://weekly.thingelstad.com/topics/claude/');
  assert.equal(claude.first_issue, 'wt-1');
  assert.equal(claude.last_issue, 'wt-3');
  const coffee = await ARCHIVE_TOOLS.list_topics({ query: 'coffee' });
  assert.deepEqual(
    coffee.topics.map((topic) => topic.name),
    ['Coffee']
  );
  assert.equal(coffee.total_count, 1);
  assert.equal(coffee.clusters.length, 0);
  // The canonical matcher (2.1.0): a word fragment names nothing, and a
  // punctuation query is not its slug ("C++" was slug "c", 289 topics).
  assert.equal((await ARCHIVE_TOOLS.list_topics({ query: 'coff' })).total_count, 0);
  assert.equal((await ARCHIVE_TOOLS.list_topics({ query: 'C++' })).total_count, 0);
  // An exact page slug still names its topic.
  assert.deepEqual(
    (await ARCHIVE_TOOLS.list_topics({ query: 'claude' })).topics.map((topic) => topic.name),
    ['Claude']
  );
  // Paging: every topic is reachable, and the pages add up.
  const first = await ARCHIVE_TOOLS.list_topics({ limit: 2 });
  assert.equal(first.total_count, 3);
  assert.equal(first.truncated.omitted.topics, 1);
  assert.equal(first.truncated.next_offset, 2);
  const second = await ARCHIVE_TOOLS.list_topics({ limit: 2, offset: first.truncated.next_offset });
  assert.deepEqual(
    [...first.topics, ...second.topics].map((topic) => topic.name),
    out.topics.map((topic) => topic.name)
  );
  assert.equal(second.truncated.omitted.topics, 2);
  assert.equal(second.truncated.next_offset, undefined);
  assert.match(second.truncated.hint, /last page/);
  primeCorpusCachesForTests({ ...fixtures(), graph: {} });
  const noGraph = await ARCHIVE_TOOLS.list_topics({});
  assert.equal(noGraph.clusters.length, 1);
  assert.deepEqual(noGraph.topics, []);
  assert.match(noGraph.note, /not loaded/);
});

test('source_neighborhood gives a Weekly Thing issue its similar_issues from the graph', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.source_neighborhood({ id: 'wt-1' }, { scope: 'weekly_thing' });
  assert.deepEqual(out.similar_issues, [
    {
      id: 'wt-2',
      label: 'WT2',
      subject: 'Weekly Thing 2',
      publish_date: '2019-05-01T12:00:00Z',
      url: 'https://weekly.thingelstad.com/archive/2/',
      score: 0.912
    }
  ]);
});

test('source records carry the skim; get_source adds key_points and audio chapters', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.get_source({ id: 'wt-1' }, { scope: 'weekly_thing' });
  assert.equal(out.source.description, 'The dek Jamie wrote for issue one.');
  assert.equal(out.source.abstract, undefined, "an issue's opening lines are a greeting, not sent (1.5.1)");
  assert.deepEqual(out.source.key_points, ['Notable: a pick']);
  assert.equal(out.source.audio_url, 'https://cdn.example/1.mp3');
  assert.deepEqual(out.source.audio_chapters, [{ start: 0, title: 'Intro' }]);
  const post = await ARCHIVE_TOOLS.get_source({ id: 'blog-77' }, { scope: 'blog' });
  assert.equal(post.source.abstract_source, 'generated', 'a generated abstract says so');
  assert.deepEqual(post.source.categories, ['Coffee']);
});

test('a section finds its audio chapter: name, then family, then the older chapter name (2.3.0)', () => {
  const record = {
    audio_url: 'https://cdn.example/9.mp3',
    audio_chapters: [
      { start: 0, title: 'Welcome' },
      { start: 105.9, title: 'Must Read' },
      { start: 300.2, title: 'Interview with 612 Series creator Erik Halaas' },
      { start: 410, title: 'Route and Logs' },
      { start: 520.6, title: 'Kicking off the 8th annual Team SPS Kubb Tournament with a quick ru…' },
      { start: 785.5, title: 'Journal' }
    ]
  };
  const at = (...names) => audioChapterFor(record, names);
  assert.deepEqual(at('Friday', 'Journal'), { url: 'https://cdn.example/9.mp3#t=785', start: 785, chapter: 'Journal' });
  assert.equal(
    at('💬 Interview with 612 Series creator Erik Halaas', 'x').start,
    300,
    'an emoji prefix does not count'
  );
  assert.equal(at('Route & Logs').start, 410, '& reads as and');
  assert.equal(
    at('Kicking off the 8th annual Team SPS Kubb Tournament with a quick run through the rules', 'Journal').start,
    520,
    'a chapter title cut with … matches its section by prefix'
  );
  assert.equal(
    at('The Revolution in Classic Tetris', 'Featured').chapter,
    'Must Read',
    'WT180 called Featured Must Read'
  );
  assert.deepEqual(at('Issue', 'Intro'), { url: 'https://cdn.example/9.mp3', start: 0, chapter: 'Welcome' });
  assert.equal(at('Fortune'), undefined, 'no chapter, no start');
  assert.equal(audioChapterFor({ audio_chapters: record.audio_chapters }, ['Journal']), undefined, 'no audio url');
});

test('has_audio keeps Weekly Thing issues with (or without) an audio edition (2.3.0)', async () => {
  primeCorpusCachesForTests(fixtures());
  const yes = await ARCHIVE_TOOLS.list_content({ has_audio: true }, { scope: 'all' });
  assert.deepEqual(
    yes.results.map((item) => item.id),
    ['wt-1']
  );
  assert.equal(yes.scope, 'weekly_thing');
  const no = await ARCHIVE_TOOLS.latest_content({ has_audio: 'false' }, { scope: 'all' });
  assert.ok(
    no.results.length > 0 && no.results.every((item) => item.source_kind === 'weekly_thing' && !item.audio_url)
  );
  const refused = await ARCHIVE_TOOLS.list_content({ has_audio: true, source_kind: 'podcast' }, { scope: 'all' });
  assert.equal(refused.code, 'bad_request');
  const stats = await ARCHIVE_TOOLS.corpus_stats({ source_kind: 'weekly_thing' }, { scope: 'all' });
  assert.deepEqual(stats.sources[0].audio_editions, {
    count: 1,
    total_seconds: 600,
    first: { id: 'wt-1', issue_number: 1, publish_date: stats.sources[0].audio_editions.first.publish_date },
    last: { id: 'wt-1', issue_number: 1, publish_date: stats.sources[0].audio_editions.last.publish_date }
  });
});

test('topic matches a chunk cluster; category resolves to blog post ids', async () => {
  const chunk = { topics: ['AI and agents'] };
  assert.equal(matchesFilters(chunk, { topic: 'ai and agents' }), true);
  assert.equal(matchesFilters(chunk, { topic: 'Crypto and web3' }), false);
  assert.equal(matchesFilters({}, { topic: 'AI and agents' }), false);
  primeCorpusCachesForTests(fixtures());
  const ids = await blogCategoryPostIds('coffee');
  assert.deepEqual([...ids], ['77']);
  assert.equal(matchesFilters({ id: 'blog:77:0:abc' }, { categoryPostIds: ids }), true);
  assert.equal(matchesFilters({ id: 'blog:78:0:abc' }, { categoryPostIds: ids }), false);
  assert.equal(matchesFilters({ id: 'c1', issue_number: 1 }, { categoryPostIds: ids }), false);
  // A JSON body cannot build a Set: a stray categoryPostIds is ignored.
  assert.equal(matchesFilters({ id: 'blog:78:0:abc' }, { categoryPostIds: ['77'] }), true);
});

test('quote_search with voice=jamie never finds a phrase Jamie quoted', async () => {
  primeCorpusCachesForTests(fixtures());
  const plain = await ARCHIVE_TOOLS.quote_search({ phrase: 'predict the future' }, { scope: 'weekly_thing' });
  assert.equal(plain.results.length, 1);
  const jamie = await ARCHIVE_TOOLS.quote_search(
    { phrase: 'predict the future', voice: 'jamie' },
    { scope: 'weekly_thing' }
  );
  assert.equal(jamie.results.length, 0);
  const quoted = await ARCHIVE_TOOLS.quote_search(
    { phrase: 'predict the future', voice: 'quoted' },
    { scope: 'weekly_thing' }
  );
  assert.equal(quoted.results.length, 1);
  assert.equal(quoted.results[0].section, 'Notable');
  assert.deepEqual(quoted.results[0].voice, ['quoted']);
  const framing = await ARCHIVE_TOOLS.quote_search({ phrase: 'Alan Kay', voice: 'jamie' }, { scope: 'weekly_thing' });
  assert.equal(framing.results.length, 1);
});

test('media_search narrows to one issue', async () => {
  primeCorpusCachesForTests(fixtures());
  const all = await ARCHIVE_TOOLS.media_search({ query: 'lake' }, { scope: 'all' });
  assert.equal(all.total_count, 2);
  const one = await ARCHIVE_TOOLS.media_search({ query: 'lake', issue_number: 2 }, { scope: 'all' });
  assert.deepEqual(
    one.results.map((item) => item.issue_number),
    [2]
  );
});

test('compare_eras needs two forward year ranges', () => {
  assert.deepEqual(
    validateToolArguments('compare_eras', { topic: 'ai', year_a: [2018, 2019], year_b: [2024, 2025] }),
    []
  );
  assert.match(
    validateToolArguments('compare_eras', { topic: 'ai', year_a: [2019, 2018], year_b: [2024, 2025] }).join(' '),
    /year_a runs backwards/
  );
  assert.match(validateToolArguments('compare_eras', { topic: 'ai' }).join(' '), /year_a is required/);
});

test('yearly terms are scored against the whole corpus, not just the requested years', () => {
  const chunk = (year, text) => ({ publish_date: `${year}-06-01`, text });
  const all = [
    chunk(2018, 'coffee coffee kubernetes'),
    chunk(2019, 'coffee espresso'),
    chunk(2020, 'coffee grinder'),
    chunk(2021, 'coffee beans')
  ];
  const terms = (options) =>
    yearlyContentSignals([], { chunks: [all[0]], listLimit: 5, ...options })[0].top_text_terms.map((row) => row.term);
  // Scored against 2018 alone every term is in every year, so raw counts win.
  assert.deepEqual(terms({}), ['coffee', 'kubernetes']);
  // Against the whole corpus coffee is in every year and kubernetes in one.
  assert.deepEqual(terms({ baselineChunks: all }), ['kubernetes', 'coffee']);
});
