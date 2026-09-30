// MCP 1.5.1 (docs/REVIEW-2026-09-30-mcp-1.5.md): the counting and filtering
// tools return exact sets. Topic labels match only when named whole; every
// chunk is read; a domain filter matches the domain and its subdomains;
// find_links sorts before it cuts and says what it left out; get_source
// sends the body once; source_neighborhood stops repeating cross-source
// links; yearly terms are five a year without the noise words. 1.5.2:
// corpus_stats sends limit years, one sample and three domains a year.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS, GET_SOURCE_RESULT_CHARS } from '../dist/shared/archive-tools.mjs';
import { yearlyContentSignals } from '../dist/shared/corpus-stats.mjs';
import { MCP_RESULT_MAX_CHARS, renderToolResultText, validateToolArguments } from '../dist/shared/mcp.mjs';
import { primeCorpusCachesForTests } from '../dist/shared/retrieval.mjs';

// Every issue carries the label, as detect_topics files nearly every issue
// under it; only WT11's text says RSS.
const LABEL = 'Open web and RSS';

function chunk(issue, date, index, text) {
  return {
    id: `c${issue}-${index}`,
    issue_number: issue,
    issue_year: Number(date.slice(0, 4)),
    publish_date: date,
    section: `S${index}`,
    topics: [LABEL],
    text
  };
}

function link(issue, date, domain, extra = {}) {
  return {
    issue_number: issue,
    issue_year: Number(date.slice(0, 4)),
    publish_date: date,
    subject: `WT${issue}`,
    domain,
    url: `https://${domain}/${issue}`,
    text: `A ${domain} piece`,
    link_kind: 'external',
    link_category: 'external',
    ...extra
  };
}

const D10 = '2024-03-02T12:00:00Z';
const D11 = '2025-03-01T12:00:00Z';
const D12 = '2026-03-07T12:00:00Z';

function fixtures() {
  const longBody = `Good morning! Greeting.\n\n${'word '.repeat(7000)}`;
  return {
    weekly_thing: {
      issues: [
        {
          number: 10,
          subject: 'WT10',
          publish_date: D10,
          url: '/archive/10/',
          topics: [LABEL],
          description: 'Dek ten.',
          summary: { abstract: 'Good morning! Greeting.' },
          body: longBody
        },
        { number: 11, subject: 'WT11', publish_date: D11, url: '/archive/11/', topics: [LABEL], body: 'Feeds.' },
        { number: 12, subject: 'WT12', publish_date: D12, url: '/archive/12/', topics: [LABEL], body: 'Other.' }
      ],
      chunks: [
        // WT10 mentions Mastodon only in its fourteenth chunk.
        ...Array.from({ length: 13 }, (_, index) => chunk(10, D10, index, `Filler passage ${index}.`)),
        chunk(10, D10, 13, 'Trying Mastodon again this week.'),
        chunk(11, D11, 0, 'I read everything via RSS.'),
        chunk(12, D12, 0, 'Nothing about that here.')
      ],
      links: [
        link(10, D10, 'x.com'),
        link(10, D10, 'vox.com'),
        link(11, D11, 'netflix.com'),
        link(12, D12, 'media.netflix.com'),
        link(10, D10, 'example.org'),
        link(11, D11, 'example.org'),
        link(12, D12, 'example.org'),
        link(11, D11, 'www.thingelstad.com', {
          link_kind: 'internal',
          link_category: 'cross_source',
          url: 'https://www.thingelstad.com/2025/03/01/post.html'
        })
      ]
    },
    blog: { posts: [], chunks: [], links: [] }
  };
}

test('a topic label matches only when named whole (archive_lens)', async () => {
  primeCorpusCachesForTests(fixtures());
  const rss = await ARCHIVE_TOOLS.archive_lens({ topic: 'RSS' }, { scope: 'weekly_thing' });
  assert.equal(rss.total_sources, 1, 'only WT11 says RSS; the label on all three is not evidence');
  assert.equal(rss.latest, 'wt-11');
  assert.ok(!JSON.stringify(rss.sources_by_id).includes('topics: '), 'no label match reason');

  const cluster = await ARCHIVE_TOOLS.archive_lens({ topic: LABEL }, { scope: 'weekly_thing' });
  assert.equal(cluster.total_sources, 3, 'the whole label still finds its cluster');
  assert.equal(cluster.latest, 'wt-12', 'a whole-label hit is strict');
  assert.ok(cluster.sources_by_id['wt-12'].match_reasons.includes(`topics: '${LABEL}'`));
});

test('list_content reads every chunk and matches labels only whole', async () => {
  primeCorpusCachesForTests(fixtures());
  const rss = await ARCHIVE_TOOLS.list_content({ topic: 'RSS', source_kind: 'weekly_thing' }, { scope: 'all' });
  assert.equal(rss.total_count, 1);
  assert.equal(rss.results[0].issue_number, 11);

  const mastodon = await ARCHIVE_TOOLS.list_content({ topic: 'Mastodon' }, { scope: 'weekly_thing' });
  assert.equal(mastodon.total_count, 1, 'a mention past the twelfth chunk counts');
  assert.deepEqual(mastodon.results[0].matching_sections, ['S13'], 'only the chunk that says it');

  const cluster = await ARCHIVE_TOOLS.list_content({ topic: LABEL }, { scope: 'weekly_thing' });
  assert.equal(cluster.total_count, 3);
  assert.deepEqual(cluster.results[0].match_reasons, [`topic label: '${LABEL}'`]);
});

test('a domain filter matches the domain and its subdomains, never a substring', async () => {
  primeCorpusCachesForTests(fixtures());
  const x = await ARCHIVE_TOOLS.find_links({ domain: 'x.com' }, { scope: 'weekly_thing' });
  assert.deepEqual(
    x.results.map((row) => row.domain),
    ['x.com'],
    'x.com is not netflix.com or vox.com'
  );
  const netflix = await ARCHIVE_TOOLS.find_links({ domain: 'www.netflix.com' }, { scope: 'weekly_thing' });
  assert.deepEqual(netflix.results.map((row) => row.domain).sort(), ['media.netflix.com', 'netflix.com']);

  const listed = await ARCHIVE_TOOLS.list_content({ domain: 'x.com' }, { scope: 'weekly_thing' });
  assert.deepEqual(
    listed.results.map((row) => row.issue_number),
    [10]
  );
});

test('find_links sorts before the limit, newest first, and says what it left out', async () => {
  primeCorpusCachesForTests(fixtures());
  const newest = await ARCHIVE_TOOLS.find_links({ domain: 'example.org', limit: 2 }, { scope: 'weekly_thing' });
  assert.deepEqual(
    newest.results.map((row) => row.issue_number),
    [12, 11]
  );
  assert.equal(newest.total_count, 3);
  assert.equal(newest.results_omitted, 1);
  assert.match(newest.results_note, /3 links matched; the 2 newest are shown/);
  assert.equal(newest.applied.sort, 'newest');
  assert.equal(newest.results[0].corpus_kind, 'weekly_thing');

  const oldest = await ARCHIVE_TOOLS.find_links(
    { domain: 'example.org', limit: 2, sort: 'oldest' },
    { scope: 'weekly_thing' }
  );
  assert.deepEqual(
    oldest.results.map((row) => row.issue_number),
    [10, 11]
  );
  const all = await ARCHIVE_TOOLS.find_links({ domain: 'example.org' }, { scope: 'weekly_thing' });
  assert.equal(all.results_omitted, undefined, 'nothing left out, nothing said');

  assert.deepEqual(validateToolArguments('find_links', { sort: 'oldest' }), []);
  assert.match(validateToolArguments('find_links', { sort: 'sideways' }).join(' '), /sort/);
});

test('get_source sends the body once and says when it is cut', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.get_source({ id: 'wt-10' }, { scope: 'weekly_thing' });
  assert.equal(out.source.section_texts, undefined, 'section_texts repeated the body');
  // 30K of body as JSON: the greeting's two newlines escape to four.
  assert.equal(JSON.stringify(out.source.body).length - 2, 30000);
  assert.equal(out.source.body_truncated, true);
  assert.match(out.source.body_note, /pass section/);
  assert.equal(out.source.description, 'Dek ten.');
  assert.equal(out.source.abstract, undefined, "a Weekly Thing issue's opening greeting is not an abstract");

  const short = await ARCHIVE_TOOLS.get_source({ id: 'wt-11' }, { scope: 'weekly_thing' });
  assert.equal(short.source.body_truncated, undefined);
});

test('get_source gives the body only the room its links leave (wt-274)', async () => {
  assert.ok(GET_SOURCE_RESULT_CHARS < MCP_RESULT_MAX_CHARS);
  const corpus = fixtures();
  // wt-274: 80 links (24K) beside a long body overflowed the cap and was
  // cut structurally, losing the tail of the record.
  const long = (index) => `A "quoted" headline number ${index} ${'with a long annotation '.repeat(10)}`;
  corpus.weekly_thing.links = Array.from({ length: 80 }, (_, index) =>
    link(10, D10, `site${index}.example`, {
      text: long(index),
      url: `https://site${index}.example/${'path/'.repeat(12)}${index}`,
      link_role: index % 2 ? 'commentary' : 'headline'
    })
  );
  corpus.weekly_thing.issues[0].body = `Good morning!\n\n${'a "line"\n'.repeat(4000)}`;
  primeCorpusCachesForTests(corpus);
  const out = await ARCHIVE_TOOLS.get_source({ id: 'wt-10' }, { scope: 'weekly_thing' });
  assert.equal(out.source.links.length, 40);
  assert.equal(out.source.commentary_links.length, 40);
  assert.ok(out.source.body.length < 30000, 'the links took their share');
  assert.equal(out.source.body_truncated, true);
  const rendered = renderToolResultText('get_source', out);
  assert.equal(rendered.truncated, false, 'the record fits whole');
  assert.ok(rendered.text.length <= MCP_RESULT_MAX_CHARS);
  assert.match(JSON.parse(rendered.text).source.body_note, /pass section/);
});

test('source_neighborhood counts cross-source links without repeating them', async () => {
  primeCorpusCachesForTests(fixtures());
  const out = await ARCHIVE_TOOLS.source_neighborhood({ id: 'wt-11' }, { scope: 'weekly_thing' });
  assert.ok(out.outgoing_links.some((row) => row.link_category === 'cross_source'));
  assert.equal(out.cross_source_count, 1);
  assert.equal(out.cross_source_links, undefined, 'every cross-source link is already in outgoing_links');
  for (const row of out.related_sources) assert.ok((row.domains || []).length <= 5);
});

test('yearly terms: five a year, without section names, issue refs or plain words', () => {
  const chunks = [
    {
      publish_date: '2026-01-01',
      section: 'Micropost',
      text: 'micropost wt350 day great kubernetes kubernetes coffee espresso grinder kettle roaster'
    }
  ];
  const [year] = yearlyContentSignals([{ publish_date: '2026-01-01', subject: 'Great day of kubernetes' }], {
    chunks,
    listLimit: 12,
    termLimit: 5
  });
  const text = year.top_text_terms.map((row) => row.term);
  assert.equal(text.length, 5);
  for (const noise of ['micropost', 'wt350', 'day', 'great']) assert.ok(!text.includes(noise), noise);
  assert.deepEqual(
    year.top_subject_terms.map((row) => row.term),
    ['kubernetes']
  );
});

test('corpus_stats: limit years, one sample a year with its id, three domains', async () => {
  const corpus = fixtures();
  for (let index = 0; index < 4; index += 1) {
    const number = 20 + index;
    const domains = Array.from({ length: 8 }, (_, site) => `d${site}.example`);
    corpus.weekly_thing.issues.push({
      number,
      subject: `WT${number}`,
      publish_date: D12,
      url: `/archive/${number}/`,
      domains
    });
  }
  primeCorpusCachesForTests(corpus);
  const out = await ARCHIVE_TOOLS.corpus_stats({ source_kind: 'weekly_thing' }, { scope: 'weekly_thing' });
  const year = out.sources[0].yearly_signals.find((row) => row.year === 2026);
  assert.equal(year.sample_items.length, 1, 'the citation readers take one a year');
  for (const sample of year.sample_items) {
    assert.match(sample.id, /^wt-\d+$/);
    assert.equal(sample.section, undefined, 'the section repeated on every sample');
    assert.equal(sample.source_kind, undefined, 'the group already says it');
  }
  assert.equal(year.top_domains.length, 3);
  assert.equal(out.sources[0].yearly_signals.length, 3, 'every year when there are fewer than limit');
  assert.equal(out.sources[0].yearly_signals_note, undefined);
  corpus.weekly_thing.issues.push({
    number: 5,
    subject: 'WT5',
    publish_date: '2019-01-05T12:00:00Z',
    url: '/archive/5/'
  });
  primeCorpusCachesForTests(corpus);
  const narrow = await ARCHIVE_TOOLS.corpus_stats({ source_kind: 'weekly_thing', limit: 3 }, { scope: 'weekly_thing' });
  assert.deepEqual(
    narrow.sources[0].yearly_signals.map((row) => row.year),
    [2026, 2025, 2024]
  );
  assert.match(narrow.sources[0].yearly_signals_note, /3 newest of 4 years; pass year_range/);
  const two = await ARCHIVE_TOOLS.corpus_stats(
    { source_kind: 'weekly_thing', year_range: [2025, 2026] },
    { scope: 'weekly_thing' }
  );
  assert.deepEqual(
    two.sources[0].yearly_signals.map((row) => row.year),
    [2026, 2025]
  );
});
