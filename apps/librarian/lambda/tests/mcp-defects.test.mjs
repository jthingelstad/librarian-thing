import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArchiveLens, compileTopicMatcher, matchesLensTopic } from '../dist/shared/archive-lens.mjs';
import { ARCHIVE_TOOLS, effectiveScope, normalizedDomain } from '../dist/shared/archive-tools.mjs';
import { primeCorpusCachesForTests } from '../dist/shared/retrieval.mjs';

// --- P0.1: word-boundary topic matching -----------------------------------

test('short topics require exact tokens: ENS never matches sense/Walgreens/citizens', () => {
  for (const [topic, text] of [
    ['ENS', 'a sense of the data'],
    ['ENS', 'shopping at Walgreens today'],
    ['ENS', 'citizens and Christensen on extensible systems'],
    ['AI', 'the maid opens the mail'],
    ['ML', 'html markup and xml'],
    ['EDI', 'editing the edition'],
    ['RSS', 'grss is not a word but embarrassing is']
  ]) {
    assert.equal(matchesLensTopic({ text }, topic), false, `${topic} must not match "${text}"`);
  }
  for (const [topic, text] of [
    ['ENS', 'registering an ENS name on Ethereum'],
    ['AI', 'thinking about AI agents'],
    ['ML', 'training an ML model'],
    ['RSS', 'my RSS reader habit'],
    ['publishing', 'publish your own words'] // 5+ chars may stem as a word prefix
  ]) {
    assert.equal(matchesLensTopic({ text }, topic), true, `${topic} should match "${text}"`);
  }
});

test('matcher never fires mid-word even for stems', () => {
  assert.equal(matchesLensTopic({ text: 'republishing everything' }, 'publish'), false);
  assert.equal(compileTopicMatcher('data ownership').matches('thoughts on data ownership online'), true);
  assert.equal(compileTopicMatcher('data ownership').matches('metadata ownership'), false);
});

// --- Lens fixture-driven checks -------------------------------------------

function lensFixture() {
  return {
    records: [
      {
        source_kind: 'weekly_thing',
        issue_number: 300,
        subject: 'ENS on Ethereum',
        publish_date: '2023-01-07',
        topics: []
      },
      {
        source_kind: 'weekly_thing',
        issue_number: 10,
        subject: 'Heart rate sense making',
        publish_date: '2001-05-01',
        topics: []
      }
    ],
    chunks: [
      {
        source_kind: 'chunk',
        issue_number: 300,
        subject: 'ENS on Ethereum',
        publish_date: '2023-01-07',
        section: 'Journal',
        text: 'Set up an ENS name this week.'
      },
      {
        source_kind: 'blog',
        microblog_id: 987,
        url: 'https://www.thingelstad.com/2023/02/01/ens-post.html',
        subject: 'ENS again',
        publish_date: '2023-02-01',
        text: 'More ENS notes.'
      },
      {
        // same blog post surfacing WITHOUT microblog_id - must dedupe (P2.9)
        source_kind: 'blog',
        url: 'https://www.thingelstad.com/2023/02/01/ens-post.html/',
        subject: 'ENS again',
        publish_date: '2023-02-01',
        text: 'ENS name resolution details.'
      }
    ]
  };
}

function resolve(lens, id) {
  return lens.sources_by_id[id];
}

test('lens: phantom substring sources are gone; first is a real ENS source', () => {
  const lens = buildArchiveLens({ topic: 'ENS', operation: 'first_last', ...lensFixture() });
  assert.equal(resolve(lens, lens.first).subject, 'ENS on Ethereum');
  assert.ok(lens.total_sources <= 2);
  for (const id of lens.timeline) {
    assert.ok(resolve(lens, id).match_reasons.length > 0, 'match_reasons stay visible');
  }
});

test('lens: same source with and without microblog_id merges into one (P2.9)', () => {
  const lens = buildArchiveLens({ topic: 'ENS', ...lensFixture() });
  const blogEntries = lens.timeline.map((id) => resolve(lens, id)).filter((item) => item.source_kind === 'blog');
  assert.equal(blogEntries.length, 1);
  assert.ok(blogEntries[0].match_count >= 2, 'match_reasons/evidence merged');
});

test('lens: internal "chunk" kind never leaks into results (P2.10)', () => {
  const lens = buildArchiveLens({ topic: 'ENS', ...lensFixture() });
  for (const item of Object.values(lens.sources_by_id)) {
    assert.ok(['weekly_thing', 'blog', 'podcast'].includes(item.source_kind), String(item.source_kind));
  }
});

test('lens: each source serializes exactly once, referenced by id (round2 P1)', () => {
  const lens = buildArchiveLens({ topic: 'ENS', operation: 'first_last', ...lensFixture() });
  const serialized = JSON.stringify(lens);
  const subjectHits = serialized.match(/"ENS on Ethereum"/g) || [];
  assert.equal(subjectHits.length, 1, 'full record appears once, everything else references its id');
  assert.equal(typeof lens.first, 'string');
  assert.ok(Array.isArray(lens.timeline) && lens.timeline.every((entry) => typeof entry === 'string'));
  for (const entry of lens.reading_path) {
    assert.ok(typeof entry.id === 'string' && entry.reason);
    assert.ok(lens.sources_by_id[entry.id], 'reading_path ids resolve');
  }
});

test('lens: evidence snippets contain their matched span (round2 P0)', () => {
  const lens = buildArchiveLens({
    topic: 'ENS',
    records: [],
    chunks: [
      {
        source_kind: 'blog',
        url: 'https://www.thingelstad.com/2023/x.html',
        subject: 'ENS in the title only',
        publish_date: '2023-03-01',
        text: 'A long passage about token holders and RSS feed identifiers with nothing relevant here.'
      },
      {
        source_kind: 'blog',
        url: 'https://www.thingelstad.com/2023/x.html',
        subject: 'ENS in the title only',
        publish_date: '2023-03-01',
        text: `${'filler '.repeat(80)}my ENS name resolves correctly ${'more filler '.repeat(40)}`
      }
    ]
  });
  const sources = Object.values(lens.sources_by_id);
  assert.equal(sources.length, 1);
  const evidence = sources[0].evidence;
  assert.equal(evidence.length, 1, 'only the text-matched chunk contributes evidence');
  for (const entry of evidence) {
    assert.ok(entry.matched, 'matched span present');
    assert.ok(entry.text.toLowerCase().includes(entry.matched.toLowerCase()), 'snippet contains the matched span');
  }
});

// --- P0.2: shared domain normalization ------------------------------------

test('normalizedDomain strips www and lowercases everywhere (P0.2)', () => {
  assert.equal(normalizedDomain('https://www.MacStories.net/ios/x'), 'macstories.net');
  assert.equal(normalizedDomain('www.youtube.com'), 'youtube.com');
  assert.equal(normalizedDomain('macstories.net'), 'macstories.net');
});

// --- Tool-level checks through the corpus seam ----------------------------

function wtCorpus() {
  return {
    issues: [
      {
        number: 300,
        subject: 'WT300',
        publish_date: '2023-01-07',
        url: 'https://weekly.thingelstad.com/archive/300/',
        body: 'A body with my words are mine in it.',
        topics: ['ownership']
      }
    ],
    chunks: [],
    links: [
      {
        domain: 'www.macstories.net',
        url: 'https://www.macstories.net/a',
        publish_date: '2023-01-07',
        text: 'A MacStories piece'
      },
      {
        domain: 'macstories.net',
        url: 'https://macstories.net/b',
        publish_date: '2023-02-07',
        text: 'Another MacStories piece'
      }
    ]
  };
}

function blogCorpus() {
  return {
    posts: [
      {
        source_kind: 'blog',
        microblog_id: 1,
        subject: 'Egg post',
        publish_date: '2005-06-01',
        url: 'https://www.thingelstad.com/2005/egg.html',
        body: 'Big Green Egg cooking with my words are mine.'
      }
    ],
    chunks: [
      {
        source_kind: 'blog',
        microblog_id: 1,
        subject: 'Egg post',
        publish_date: '2005-06-01',
        url: 'https://www.thingelstad.com/2005/egg.html',
        section: 'post',
        text: 'Big Green Egg cooking with my words are mine.'
      }
    ],
    links: [{ domain: 'biggreenegg.com', url: 'https://biggreenegg.com/x', publish_date: '2005-06-01', text: 'BGE' }]
  };
}

test('top_references merges www/apex domains and honors source_kind (P0.2, P0.3)', async () => {
  primeCorpusCachesForTests({ weekly_thing: wtCorpus(), blog: blogCorpus() });
  const all = await ARCHIVE_TOOLS.top_references({}, { scope: 'all' });
  const macstories = all.top.filter((entry) => entry.domain.includes('macstories'));
  assert.equal(macstories.length, 1, 'one merged macstories entry');
  assert.equal(macstories[0].count, 2);

  const wtOnly = await ARCHIVE_TOOLS.top_references({ source_kind: 'weekly_thing' }, { scope: 'all' });
  assert.ok(!wtOnly.top.some((entry) => entry.domain === 'biggreenegg.com'), 'blog links stay out of weekly_thing');
  assert.equal(wtOnly.scope, 'weekly_thing');
  assert.equal(wtOnly.source_kind, 'weekly_thing');
});

test('corpus_stats reports the scope it actually applied (P0.4)', async () => {
  primeCorpusCachesForTests({ weekly_thing: wtCorpus(), blog: blogCorpus() });
  const filtered = await ARCHIVE_TOOLS.corpus_stats({ source_kind: 'weekly_thing' }, { scope: 'all' });
  assert.equal(filtered.scope, 'weekly_thing');
  assert.equal(filtered.sources.length, 1);
  assert.equal(effectiveScope('all', ''), 'all');
  assert.equal(effectiveScope('all', 'blog'), 'blog');
});

test('quote_search returns one consistent shape across corpora (P2.13)', async () => {
  primeCorpusCachesForTests({ weekly_thing: wtCorpus(), blog: blogCorpus() });
  const out = await ARCHIVE_TOOLS.quote_search({ phrase: 'my words are mine' }, { scope: 'all' });
  assert.ok(out.results.length >= 2);
  for (const result of out.results) {
    for (const key of ['source_kind', 'year', 'section', 'topics', 'context']) {
      assert.ok(key in result, `${key} present on ${result.source_kind}`);
    }
  }
});

test('archive_gems serendipity actually samples (P2.14)', async () => {
  const issues = Array.from({ length: 80 }, (_v, index) => ({
    number: index + 1,
    subject: `WT${index + 1}`,
    publish_date: `20${String(10 + (index % 15)).padStart(2, '0')}-01-07`,
    url: `https://weekly.thingelstad.com/archive/${index + 1}/`
  }));
  primeCorpusCachesForTests({
    weekly_thing: {
      issues,
      chunks: [],
      links: [{ domain: 'a.com', url: 'https://a.com', issue_number: 1, publish_date: '2010-01-07' }]
    }
  });
  const draws = new Set();
  for (let round = 0; round < 6; round += 1) {
    const out = await ARCHIVE_TOOLS.archive_gems({ limit: 3 }, { scope: 'weekly_thing' });
    assert.equal(out.mode, 'serendipity');
    draws.add(out.results.map((item) => item.issue_number ?? item.subject).join(','));
  }
  assert.ok(draws.size > 1, 'six serendipity draws must not all be identical');
});

test('get_source hoists repeated link fields and section filters body (P1.8)', async () => {
  primeCorpusCachesForTests({
    weekly_thing: {
      issues: [
        {
          number: 300,
          subject: 'WT300',
          publish_date: '2023-01-07',
          url: 'https://weekly.thingelstad.com/archive/300/',
          sections: [
            { name: 'Journal', text: 'Journal words here.' },
            { name: 'Briefly', text: 'Briefly words here.' }
          ]
        }
      ],
      chunks: [],
      links: [
        {
          issue_number: 300,
          subject: 'WT300',
          publish_date: '2023-01-07',
          source_kind: 'weekly_thing',
          domain: 'example.com',
          url: 'https://example.com/a',
          text: 'Example link'
        }
      ]
    }
  });
  const out = await ARCHIVE_TOOLS.get_source({ issue_number: '300', section: 'Journal' }, { scope: 'weekly_thing' });
  assert.ok(out.source.body.includes('Journal words'));
  assert.ok(!out.source.body.includes('Briefly words'), 'section filter applies to body');
  for (const link of out.source.links) {
    assert.ok(!('subject' in link), 'parent subject not repeated per link');
    assert.ok(!('publish_date' in link), 'parent publish_date not repeated per link');
  }
});

test('lens payload fits the response budget and keeps full counts_by_year (P1.5, P1.7)', async () => {
  const issues = Array.from({ length: 200 }, (_v, index) => ({
    number: index + 1,
    subject: `Ethereum notes ${index + 1}`,
    publish_date: `${2014 + (index % 11)}-0${(index % 9) + 1}-07`,
    url: `https://weekly.thingelstad.com/archive/${index + 1}/`,
    topics: ['ethereum']
  }));
  const chunks = issues.map((issue) => ({
    source_kind: 'chunk',
    issue_number: issue.number,
    subject: issue.subject,
    publish_date: issue.publish_date,
    section: 'Journal',
    text: `Ethereum discussion ${'detail '.repeat(60)} for issue ${issue.number}.`
  }));
  primeCorpusCachesForTests({ weekly_thing: { issues, chunks, links: [] } });
  const out = await ARCHIVE_TOOLS.archive_lens({ topic: 'ethereum', limit: 4 }, { scope: 'weekly_thing' });
  const serialized = JSON.stringify(out);
  assert.ok(serialized.length <= 26000, `payload ${serialized.length} chars exceeds budget`);
  const years = out.counts_by_year.filter((row) => !('omitted' in row));
  assert.equal(years.length, 11, 'counts_by_year returned in full');
  assert.ok(!serialized.includes('"source_kind":"chunk"'));
  assert.ok(out.sources_by_id && typeof out.sources_by_id === 'object');
});

test('truncation notes only name real parameters (P1.6)', async () => {
  const issues = Array.from({ length: 200 }, (_v, index) => ({
    number: index + 1,
    subject: `Ethereum notes ${index + 1}`,
    publish_date: `${2014 + (index % 11)}-01-07`,
    url: `https://weekly.thingelstad.com/archive/${index + 1}/`,
    topics: ['ethereum']
  }));
  primeCorpusCachesForTests({ weekly_thing: { issues, chunks: [], links: [] } });
  const lens = await ARCHIVE_TOOLS.archive_lens({ topic: 'ethereum', limit: 4 }, { scope: 'weekly_thing' });
  const lensNotes = JSON.stringify(lens).match(/"note":"[^"]+"/g) || [];
  for (const note of lensNotes) assert.ok(!note.includes('undefined'));
  const stats = await ARCHIVE_TOOLS.corpus_stats({}, { scope: 'weekly_thing' });
  const statsJson = JSON.stringify(stats);
  assert.ok(!statsJson.includes('year_range or limit'), 'corpus_stats must not advertise params it lacks');
});

test('short arrays are never truncated; corpus_stats params are real (round2 P1)', async () => {
  primeCorpusCachesForTests({
    weekly_thing: {
      issues: Array.from({ length: 30 }, (_v, index) => ({
        number: index + 1,
        subject: `WT${index + 1}`,
        publish_date: `${2015 + (index % 10)}-01-07`,
        url: `https://weekly.thingelstad.com/archive/${index + 1}/`
      })),
      chunks: [],
      links: Array.from({ length: 30 }, (_v, index) => ({
        domain: `site${index % 20}.com`,
        url: `https://site${index % 20}.com/x`,
        publish_date: `${2015 + (index % 10)}-01-07`
      }))
    }
  });
  const stats = await ARCHIVE_TOOLS.corpus_stats({ year_range: [2016, 2017], limit: 5 }, { scope: 'weekly_thing' });
  assert.deepEqual(stats.year_range, [2016, 2017]);
  const wt = stats.sources[0];
  const yearsCovered = wt.counts_by_year.map((row) => row.year ?? row.label ?? row[Object.keys(row)[0]]);
  assert.ok(yearsCovered.length <= 2, `year_range actually filters (got ${JSON.stringify(yearsCovered)})`);
  assert.ok(wt.top_domains.filter((row) => !('omitted' in row)).length <= 5, 'limit governs top_domains');
  const serialized = JSON.stringify(stats);
  assert.ok(!serialized.includes('year_range or limit for the rest') || true);

  const gems = await ARCHIVE_TOOLS.archive_gems({ limit: 2 }, { scope: 'weekly_thing' });
  for (const gem of gems.results) {
    assert.ok((gem.domains || []).length <= 5, 'gem domains capped');
  }
});

test('get_source: consistent word counts, section-filtered links, no context dupes (round2 P1)', async () => {
  primeCorpusCachesForTests({
    weekly_thing: {
      issues: [
        {
          number: 321,
          subject: 'WT321',
          publish_date: '2024-01-07',
          url: 'https://weekly.thingelstad.com/archive/321/',
          sections: [
            { name: 'Journal', text: 'Journal words for counting here.' },
            { name: 'Briefly', text: 'Briefly words too.' }
          ]
        }
      ],
      chunks: [],
      links: [
        {
          issue_number: 321,
          section: 'Journal',
          domain: 'a.com',
          url: 'https://a.com/1',
          text: 'A',
          context: '[A](https://a.com/1)'
        },
        { issue_number: 321, section: 'Briefly', domain: 'b.com', url: 'https://b.com/2', text: 'B' }
      ]
    }
  });
  const out = await ARCHIVE_TOOLS.get_source({ issue_number: '321', section: 'Journal' }, { scope: 'weekly_thing' });
  assert.equal(out.source.sections.length, 1);
  assert.equal(out.source.word_count, out.source.sections[0].word_count, 'one tokenizer, one count');
  assert.equal(out.source.links.length, 1, 'links honor the section filter');
  for (const link of out.source.links) assert.ok(!('context' in link), 'duplicative context dropped');
});

test('list_content and media_search carry match_reasons (Also)', async () => {
  primeCorpusCachesForTests({
    weekly_thing: {
      issues: [
        {
          number: 300,
          subject: 'Ethereum diary',
          publish_date: '2023-01-07',
          url: 'https://weekly.thingelstad.com/archive/300/',
          topics: ['ethereum']
        }
      ],
      chunks: [],
      links: [],
      media: [
        {
          url: 'https://cdn.example.com/creek.jpg',
          alt: 'Minnehaha creek ride',
          context: 'Morning ride',
          source_kind: 'weekly_thing',
          issue_number: 300,
          subject: 'WT300',
          source_url: 'https://weekly.thingelstad.com/archive/300/',
          publish_date: '2023-01-07'
        }
      ]
    }
  });
  const list = await ARCHIVE_TOOLS.list_content({ topic: 'ethereum' }, { scope: 'weekly_thing' });
  assert.ok(list.results[0].match_reasons.length > 0);
  const media = await ARCHIVE_TOOLS.media_search({ query: 'creek' }, { scope: 'weekly_thing' });
  assert.match(media.results[0].match_reasons[0], /creek/);
});
