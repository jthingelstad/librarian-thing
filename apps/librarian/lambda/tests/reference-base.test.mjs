// The reference base (Jamie, 2026-10-23): the site pages, the FAQ, Things
// I've built, thingelstad.com's pages and the reference documents about
// Jamie are one corpus that every retrieval consults, whatever the scope or
// source kinds, and that no source kind selects.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS, sourceKeyFromChunk } from '../dist/shared/archive-tools.mjs';
import { lensSourceId } from '../dist/shared/archive-lens.mjs';
import { LIBRARIAN_CONTRACT } from '../dist/shared/librarian-contract.mjs';
import { mcpToolDeclarations, validateToolArguments } from '../dist/shared/mcp.mjs';
import {
  matchesFilters,
  primeCorpusCachesForTests,
  retrievalFilterError,
  retrieve,
  SELECTABLE_SOURCE_KINDS
} from '../dist/shared/retrieval.mjs';

// No rerank call and no embeddings: the lexical leg alone ranks.
process.env.LIBRARIAN_RERANK_ENABLED = '0';

const PAGE_URL = 'https://www.thingelstad.com/charlie-brown-tree/';
const CTX = { scope: 'all' };

const chunk = (fields) => ({
  issue_number: null,
  publish_date: null,
  issue_year: null,
  topics: [],
  ...fields,
  word_count: String(fields.text).split(/\s+/).length
});

// The reference rows, as build_reference_corpus writes them.
const REFERENCE_ROWS = [
  chunk({
    id: 'site:about:0:aaa',
    source_kind: 'site_page',
    subject: 'About',
    url: '/about/',
    section: 'About',
    text: 'The Weekly Thing began in 2017 among the tidepools of curiosity.'
  }),
  chunk({
    id: 'faq:schedule:0:bbb',
    source_kind: 'faq',
    subject: 'When does it come out?',
    url: '/faq/',
    section: 'FAQ',
    text: 'Every Saturday morning, tidepools or not.'
  }),
  chunk({
    id: 'thing:weekly-thing:0:ccc',
    source_kind: 'thing',
    thing_id: 'weekly-thing',
    thing_status: 'active',
    started: '2017-05-13',
    subject: 'Weekly Thing',
    url: 'https://thingelstad.xyz/things/weekly-thing/',
    section: 'Thing',
    content_kind: 'thing',
    text: 'Weekly Thing: a weekly collection of links and tidepools of ideas.'
  }),
  chunk({
    id: 'page:71862:0:ddd',
    source_kind: 'blog',
    page_id: 71862,
    subject: 'Charlie Brown Tree',
    url: PAGE_URL,
    section: 'Page',
    updated: '2024-12-15T10:00:00-06:00',
    text: 'The Charlie Brown tree has stood beside the tidepools photo every December.'
  }),
  // A document's passages are its H2 sections: the text before the first
  // heading carries the title as its section.
  chunk({
    id: 'doc:bio:0:eee',
    doc_id: 'bio',
    source_kind: 'document',
    subject: 'Bio',
    url: null,
    section: 'Bio',
    content_kind: 'document',
    updated: '2026-10-01',
    document_source: null,
    document_date: null,
    text: 'Jamie Thingelstad is a technologist in Minneapolis who writes about tidepools and the web.'
  }),
  chunk({
    id: 'doc:resume:0:fff',
    doc_id: 'resume',
    source_kind: 'document',
    subject: 'Resume',
    url: null,
    section: 'Resume',
    content_kind: 'document',
    updated: '2026-10-01',
    document_source: null,
    document_date: null,
    text: 'Resume: thirty years of building software teams, and a weekend fondness for tidepools.'
  }),
  // An unpublished document with a source and its own date, one heading
  // used twice.
  ...[
    ['Lake weekends', 'Lake weekends with the family: tidepools of a sort along the cabin shore.'],
    ['Winter weekends', 'Winter weekends indoors, the tidepools frozen over, board games all day.'],
    ['Lake weekends', 'The last lake weekend of the year, tidepools and a cold swim.']
  ].map(([section, text], index) =>
    chunk({
      id: `doc:family-weekends:${index}:g${index}`,
      doc_id: 'family-weekends',
      source_kind: 'document',
      subject: 'Family weekends',
      url: null,
      section,
      content_kind: 'document',
      updated: '2026-10-20',
      document_source: 'wiki.thingelstad.com (personal wiki, 2010-2015)',
      document_date: '2011-09-29',
      text
    })
  )
];
const WIKI_SOURCE = 'wiki.thingelstad.com (personal wiki, 2010-2015)';

const REFERENCE_IDS = REFERENCE_ROWS.map((row) => row.id);

function fixtures({ reference = true, staleRows = false } = {}) {
  // An older build carried these rows in the Weekly Thing and blog corpora.
  const stale = (row) => ({ ...row, text: 'A stale copy about tidepools that the reference corpus replaces.' });
  return {
    weekly_thing: {
      issues: [
        {
          number: 300,
          subject: 'Tidepools and the fall',
          publish_date: '2024-09-29T12:00:00Z',
          url: '/archive/300/',
          sections: [{ name: 'Issue', text: 'Tidepools at low tide.' }],
          body: 'Tidepools at low tide.'
        }
      ],
      chunks: [
        chunk({
          id: 'wt:300:0:a',
          source_kind: 'chunk',
          issue_number: 300,
          issue_year: 2024,
          publish_date: '2024-09-29T12:00:00Z',
          subject: 'Tidepools and the fall',
          url: '/archive/300/',
          section: 'Issue',
          text: 'Tidepools at low tide, and the fall coming on.'
        }),
        chunk({
          id: 'wt:300:1:b',
          source_kind: 'chunk',
          issue_number: 300,
          issue_year: 2024,
          publish_date: '2024-09-29T12:00:00Z',
          subject: 'Tidepools and the fall',
          url: '/archive/300/',
          section: 'Lake weekends and tides',
          text: 'A note on lake weekends and the tidepools that are not.'
        }),
        ...(staleRows || !reference ? REFERENCE_ROWS.slice(0, 3).map(staleRows ? stale : (row) => row) : [])
      ],
      links: [],
      media: []
    },
    blog: {
      post_count: 1,
      page_count: 1,
      posts: [
        {
          microblog_id: 5001,
          subject: 'A walk to the tidepools',
          publish_date: '2023-07-04',
          url: 'https://www.thingelstad.com/2023/07/04/tidepools.html',
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
        chunk({
          id: 'blog:5001:0:a',
          source_kind: 'blog',
          microblog_id: 5001,
          publish_date: '2023-07-04',
          issue_year: 2023,
          subject: 'A walk to the tidepools',
          url: 'https://www.thingelstad.com/2023/07/04/tidepools.html',
          section: 'Blog post',
          text: 'We walked down to the tidepools at dawn.'
        }),
        ...(staleRows || !reference ? [REFERENCE_ROWS[3]].map(staleRows ? stale : (row) => row) : [])
      ],
      links: [
        {
          corpus_kind: 'blog',
          page_id: 71862,
          post_url: PAGE_URL,
          url: 'https://example.com/charlie-brown',
          section: 'Page'
        }
      ],
      media: []
    },
    podcast: {
      episodes: [
        {
          number: 3,
          subject: 'Another Thing 3',
          publish_date: '2022-02-02',
          url: 'https://another.thingelstad.com/3/'
        }
      ],
      chunks: [
        chunk({
          id: 'ep:3:0:a',
          source_kind: 'podcast',
          episode_number: 3,
          publish_date: '2022-02-02',
          issue_year: 2022,
          subject: 'Another Thing 3',
          url: 'https://another.thingelstad.com/3/',
          section: 'Episode',
          text: 'We talk about tidepools for a while.'
        })
      ],
      links: []
    },
    ...(reference
      ? {
          reference: {
            version: 2,
            source: 'reference',
            chunks: REFERENCE_ROWS,
            issues: [],
            topics: [],
            links: [],
            media: []
          }
        }
      : {})
  };
}

const ids = (rows) => rows.map((row) => row.id);

test('every scope and every source-kind filter gets the whole reference base', async () => {
  primeCorpusCachesForTests(fixtures());
  const filters = [
    {},
    { sourceKinds: ['podcast'] },
    { sourceKinds: ['weekly_thing'] },
    { excludeSourceKinds: ['site_page', 'faq', 'thing'] },
    { excludeSourceKinds: ['weekly_thing', 'blog', 'podcast'] },
    // WT Builder's Echoes.
    { excludeSourceKinds: ['site_page', 'faq'], excludeIssues: [300, 299, 298] }
  ];
  for (const scope of ['weekly_thing', 'blog', 'podcast', 'all']) {
    for (const filter of filters) {
      const found = ids(await retrieve('tidepools', 30, { scope, ...filter }));
      for (const id of REFERENCE_IDS) {
        assert.ok(found.includes(id), `${id} missing under ${scope} ${JSON.stringify(filter)}: ${found}`);
      }
    }
  }
});

test('the scope and source kinds still choose among the dated sources', async () => {
  primeCorpusCachesForTests(fixtures());
  const found = ids(await retrieve('tidepools', 30, { scope: 'all', sourceKinds: ['podcast'] }));
  assert.ok(found.includes('ep:3:0:a'));
  assert.ok(!found.includes('wt:300:0:a') && !found.includes('blog:5001:0:a'), found.join(', '));
  const blogOnly = ids(await retrieve('tidepools', 30, { scope: 'blog' }));
  assert.ok(blogOnly.includes('blog:5001:0:a') && !blogOnly.includes('wt:300:0:a'), blogOnly.join(', '));
});

test('nothing is searched twice: an older corpus copy of a reference row gives way', async () => {
  primeCorpusCachesForTests(fixtures({ staleRows: true }));
  const found = await retrieve('tidepools', 30, { scope: 'all' });
  assert.equal(new Set(ids(found)).size, found.length, 'one passage per id');
  assert.ok(!found.some((row) => /stale copy/.test(row.text)), 'the reference corpus copy wins');
  for (const id of REFERENCE_IDS) assert.equal(ids(found).filter((found) => found === id).length, 1, id);
});

test('the reference base is undated: a year, before or calendar filter keeps none of it', async () => {
  primeCorpusCachesForTests(fixtures());
  for (const filter of [
    { yearRange: [2017, 2026] },
    { before: '2030-01-01' },
    { calendar: { date: '2026-09-29', window_days: 7 } }
  ]) {
    const found = ids(await retrieve('tidepools', 30, { scope: 'all', ...filter }));
    for (const id of REFERENCE_IDS) assert.ok(!found.includes(id), `${id} under ${JSON.stringify(filter)}`);
  }
  // A content filter holds for it too: a document's sections are its H2s.
  const sectioned = ids(await retrieve('tidepools', 30, { scope: 'all', section: 'Winter weekends' }));
  assert.deepEqual(sectioned, ['doc:family-weekends:1:g1']);
});

test("a document's headings do not change how a section filter reads other sources", async () => {
  primeCorpusCachesForTests(fixtures());
  // "Lake weekends" is a document heading; the issue's "Lake weekends and
  // tides" still matches inside its heading, as a section no source names.
  const found = ids(await retrieve('tidepools', 30, { scope: 'all', section: 'Lake weekends' }));
  assert.deepEqual(found.sort(), ['doc:family-weekends:0:g0', 'doc:family-weekends:2:g2', 'wt:300:1:b']);
});

test('no request can name the reference base as a source kind', () => {
  assert.deepEqual([...SELECTABLE_SOURCE_KINDS], ['weekly_thing', 'blog', 'podcast']);
  for (const kind of ['reference', 'document', 'site_page', 'faq', 'thing', 'page', 'nonsense']) {
    assert.match(String(retrievalFilterError({ sourceKinds: [kind] })), /sourceKinds must name/, kind);
  }
  for (const kind of ['reference', 'document', 'page']) {
    assert.match(String(retrievalFilterError({ excludeSourceKinds: [kind] })), /excludeSourceKinds must name/, kind);
  }
  assert.equal(retrievalFilterError({ sourceKinds: ['weekly_thing', 'podcast'] }), null);
  // Echoes' request, sent before the reference base, is still good.
  assert.equal(retrievalFilterError({ excludeSourceKinds: ['site_page', 'faq'], excludeIssues: [353] }), null);
});

test('the /retrieve contract names only the dated sources (4.18)', () => {
  const filters = LIBRARIAN_CONTRACT.endpoints['/retrieve'].request.properties.filters.properties;
  assert.deepEqual(filters.sourceKinds.items.enum, [...SELECTABLE_SOURCE_KINDS]);
  assert.deepEqual(filters.excludeSourceKinds.items.enum, [...SELECTABLE_SOURCE_KINDS, 'site_page', 'faq', 'thing']);
});

test('no MCP tool offers reference as a source_kind, and one passing it is refused', () => {
  for (const tool of mcpToolDeclarations()) {
    const values = tool.inputSchema?.properties?.source_kind?.enum || [];
    const others = values.filter((kind) => !SELECTABLE_SOURCE_KINDS.includes(kind));
    assert.deepEqual(others, [], tool.name);
  }
  for (const tool of ['search_archive', 'corpus_stats', 'list_content']) {
    const args =
      tool === 'search_archive' ? { query: 'tidepools', source_kind: 'reference' } : { source_kind: 'reference' };
    assert.ok(validateToolArguments(tool, args).length > 0, tool);
  }
});

test('citation labels and ids stay as they were; a document is cited by its title', async () => {
  primeCorpusCachesForTests(fixtures());
  const found = await retrieve('tidepools', 30, { scope: 'weekly_thing' });
  const byId = Object.fromEntries(found.map((row) => [row.id, row]));
  assert.equal(byId['doc:bio:0:eee'].source_kind, 'document');
  assert.equal(lensSourceId(byId['doc:bio:0:eee']), 'doc-bio');
  assert.equal(lensSourceId(byId['page:71862:0:ddd']), 'page-71862');
  assert.equal(lensSourceId(byId['thing:weekly-thing:0:ccc']), 'thing-weekly-thing');
  assert.equal(lensSourceId(byId['site:about:0:aaa']), 'site-about');
  const search = await ARCHIVE_TOOLS.search_archive({ query: 'tidepools', limit: 20 }, CTX);
  const bio = search.results.find((group) => group.id === 'doc-bio');
  assert.equal(bio?.label, 'Bio');
  // Two documents with no url are two sources, never one.
  const resume = search.results.find((group) => group.id === 'doc-resume');
  assert.equal(resume?.label, 'Resume');
  assert.notEqual(sourceKeyFromChunk(REFERENCE_ROWS[4]), sourceKeyFromChunk(REFERENCE_ROWS[5]));
});

test("a document's source and date ride every place it is cited, read or listed", async () => {
  primeCorpusCachesForTests(fixtures());
  const passages = await retrieve('tidepools', 30, { scope: 'podcast' });
  const { compactSource } = await import('../dist/shared/retrieval.mjs');
  const wiki = compactSource(passages.find((row) => row.doc_id === 'family-weekends'));
  assert.equal(wiki.document_source, WIKI_SOURCE);
  assert.equal(wiki.document_date, '2011-09-29');
  assert.equal(wiki.publish_date, undefined, 'never a publish date');
  assert.equal(compactSource(passages.find((row) => row.doc_id === 'bio')).document_source, undefined);
  const search = await ARCHIVE_TOOLS.search_archive({ query: 'tidepools weekends', limit: 20 }, CTX);
  const group = search.results.find((result) => result.id === 'doc-family-weekends');
  assert.equal(group?.document_source, WIKI_SOURCE, JSON.stringify(group).slice(0, 400));
  assert.equal(group?.document_date, '2011-09-29');
  assert.equal(group?.label, 'Family weekends');
  const read = await ARCHIVE_TOOLS.get_source({ id: 'doc-family-weekends' }, CTX);
  assert.equal(read.source.document_source, WIKI_SOURCE);
  assert.equal(read.source.document_date, '2011-09-29');
  assert.equal(read.source.publish_date, undefined);
  const evidence = await ARCHIVE_TOOLS.find_evidence({ claim: 'lake weekends tidepools', limit: 10 }, CTX);
  assert.match(JSON.stringify(evidence), /personal wiki, 2010-2015/);
  const stats = await ARCHIVE_TOOLS.corpus_stats({}, CTX);
  const listed = stats.sources.find((source) => source.source_kind === 'reference').documents;
  assert.deepEqual(
    listed.map((row) => [row.id, row.title, row.document_source ?? null, row.document_date ?? null]),
    [
      ['doc-bio', 'Bio', null, null],
      ['doc-resume', 'Resume', null, null],
      ['doc-family-weekends', 'Family weekends', WIKI_SOURCE, '2011-09-29']
    ]
  );
  const { collectToolCitations } = await import('../dist/shared/archive-tools.mjs');
  const citations = collectToolCitations([search]);
  const cited = JSON.stringify(citations);
  assert.match(cited, /personal wiki, 2010-2015/, cited.slice(0, 400));
  // One citation per document section: two documents never fold into one.
  const documents = citations.filter((row) => row.source_kind === 'document');
  assert.ok(new Set(documents.map((row) => row.subject)).size >= 3, cited.slice(0, 600));
});

test('get_source reads a document H2 by H2, in its own order, headings back', async () => {
  primeCorpusCachesForTests(fixtures());
  const read = await ARCHIVE_TOOLS.get_source({ id: 'doc-family-weekends', format: 'text' }, CTX);
  assert.deepEqual(
    read.source.sections.map((section) => section.name),
    ['Lake weekends', 'Winter weekends', 'Lake weekends']
  );
  assert.match(read.source.body, /^## Lake weekends\n\nLake weekends with the family/);
  assert.ok(read.source.body.indexOf('## Winter weekends') < read.source.body.lastIndexOf('## Lake weekends'));
  // The text before the first heading reads with no heading of its own.
  const bio = await ARCHIVE_TOOLS.get_source({ id: 'doc-bio', format: 'text' }, CTX);
  assert.match(bio.source.body, /^Jamie Thingelstad is a technologist/);
  const one = await ARCHIVE_TOOLS.get_source({ id: 'doc-family-weekends', section: 'winter' }, CTX);
  assert.deepEqual(
    one.source.sections.map((section) => section.name),
    ['Winter weekends']
  );
  assert.doesNotMatch(one.source.body, /cabin shore/);
  const none = await ARCHIVE_TOOLS.get_source({ id: 'doc-family-weekends', section: 'Summer' }, CTX);
  assert.equal(none.code, 'bad_request');
  assert.ok(none.available_sections.includes('Winter weekends'), JSON.stringify(none));
});

test('a long document reads page by page, nothing assumed short', async () => {
  const long = Array.from({ length: 60 }, (_, index) =>
    chunk({
      id: `doc:forum:${index}:h${index}`,
      doc_id: 'forum',
      source_kind: 'document',
      subject: 'Ponder threads',
      url: null,
      section: `Thread ${index}`,
      content_kind: 'document',
      updated: '2026-10-20',
      document_source: 'Ponder group export (Nov-Dec 2025)',
      document_date: '2025-11-01',
      text:
        `_2025-11-${String((index % 28) + 1).padStart(2, '0')} · Ponder thread ${index}_\n\n` +
        'tidepools and ponds '.repeat(90)
    })
  );
  const data = fixtures();
  data.reference.chunks = [...REFERENCE_ROWS, ...long];
  primeCorpusCachesForTests(data);
  const first = await ARCHIVE_TOOLS.get_source({ id: 'doc-forum', format: 'text' }, CTX);
  assert.equal(first.source.sections.length, 60);
  const next = first.truncated?.next_offset;
  assert.ok(next > 0, JSON.stringify(first.truncated));
  const second = await ARCHIVE_TOOLS.get_source({ id: 'doc-forum', format: 'text', offset: next }, CTX);
  assert.ok(second.source.body.length > 0);
  assert.match(second.source.body, /Ponder thread/);
});

test('get_source, source_neighborhood and list_content still reach things, pages and the site', async () => {
  primeCorpusCachesForTests(fixtures());
  const page = await ARCHIVE_TOOLS.get_source({ id: 'page-71862' }, CTX);
  assert.equal(page.source?.id, 'page-71862');
  assert.match(JSON.stringify(page.source), /stood beside the tidepools photo/);
  const thing = await ARCHIVE_TOOLS.get_source({ id: 'thing-weekly-thing' }, CTX);
  assert.equal(thing.source?.id, 'thing-weekly-thing', JSON.stringify(thing).slice(0, 300));
  const site = await ARCHIVE_TOOLS.get_source({ id: 'site-about' }, CTX);
  assert.match(JSON.stringify(site.source), /began in 2017/, JSON.stringify(site).slice(0, 300));
  const listed = await ARCHIVE_TOOLS.list_content({ source_kind: 'blog' }, CTX);
  assert.ok(
    listed.results.some((row) => row.id === 'page-71862'),
    JSON.stringify(listed.results.map((row) => row.id))
  );
  const near = await ARCHIVE_TOOLS.source_neighborhood({ id: 'page-71862' }, CTX);
  assert.ok(!near.error, JSON.stringify(near).slice(0, 300));
  // search_faq reads the FAQ the Lambda ships (shared/faq.json), as before.
  const faq = await ARCHIVE_TOOLS.search_faq({ query: 'Saturday' }, CTX);
  assert.ok(faq.total_count >= 1, JSON.stringify(faq).slice(0, 300));
});

test('get_source reads a reference document by doc-<name>, in any scope', async () => {
  primeCorpusCachesForTests(fixtures());
  for (const scope of ['weekly_thing', 'blog', 'all']) {
    const bio = await ARCHIVE_TOOLS.get_source({ id: 'doc-bio' }, { scope });
    assert.equal(bio.source?.id, 'doc-bio', JSON.stringify(bio).slice(0, 300));
    assert.match(JSON.stringify(bio.source), /technologist in Minneapolis/);
    assert.doesNotMatch(JSON.stringify(bio.source), /thirty years/);
  }
  const upper = await ARCHIVE_TOOLS.get_source({ id: 'DOC-Resume' }, CTX);
  assert.equal(upper.source?.id, 'doc-resume');
  const near = await ARCHIVE_TOOLS.source_neighborhood({ id: 'doc-bio' }, CTX);
  assert.ok(!near.error, JSON.stringify(near).slice(0, 300));
  const missing = await ARCHIVE_TOOLS.get_source({ id: 'doc-nobody' }, CTX);
  assert.ok(missing.error, 'an unknown document is not found');
});

test('date-anchored tools never return the reference base, a dated document included', async () => {
  primeCorpusCachesForTests(fixtures());
  const docs = /doc-bio|doc-resume|doc-family-weekends|family-weekends|Family weekends/;
  const latest = await ARCHIVE_TOOLS.latest_content({ limit: 20 }, CTX);
  assert.doesNotMatch(JSON.stringify(latest), docs);
  // family-weekends was written 2011-09-29: still not on this day.
  for (const date of ['09-29', '2026-09-29', '2011-09-29']) {
    const day = await ARCHIVE_TOOLS.on_this_day({ date }, CTX);
    assert.doesNotMatch(JSON.stringify(day), docs, date);
    assert.doesNotMatch(JSON.stringify(day), /site-about/, date);
  }
  for (const args of [{ topic: 'tidepools' }, { topic: 'tidepools', year_range: [2010, 2012] }]) {
    const lens = await ARCHIVE_TOOLS.archive_lens(args, CTX);
    assert.doesNotMatch(JSON.stringify(lens), docs, JSON.stringify(args));
  }
  const eras = await ARCHIVE_TOOLS.compare_eras(
    { topic: 'tidepools', year_a: [2010, 2012], year_b: [2023, 2026] },
    CTX
  );
  assert.doesNotMatch(JSON.stringify(eras), docs);
  const stats = await ARCHIVE_TOOLS.corpus_stats({}, CTX);
  for (const source of stats.sources) {
    const years = (source.counts_by_year || []).map((row) => Number(row.year));
    assert.ok(!years.includes(2011), `${source.source_kind}: ${years}`);
  }
  const year = await ARCHIVE_TOOLS.corpus_stats({ year: 2011 }, CTX);
  assert.doesNotMatch(JSON.stringify(year), docs);
  const listed = await ARCHIVE_TOOLS.list_content({ year: 2011 }, CTX);
  assert.doesNotMatch(JSON.stringify(listed), docs);
});

test('corpus_stats lists the reference base once, without years', async () => {
  primeCorpusCachesForTests(fixtures());
  const stats = await ARCHIVE_TOOLS.corpus_stats({}, CTX);
  const reference = stats.sources.filter((source) => source.source_kind === 'reference');
  assert.equal(reference.length, 1);
  const [entry] = reference;
  assert.equal(entry.always_searched, true);
  assert.equal(entry.chunk_count, REFERENCE_ROWS.length);
  assert.equal(entry.item_count, 7);
  assert.equal(entry.counts_by_year, undefined);
  assert.equal(entry.yearly_signals, undefined);
  const kinds = Object.fromEntries(entry.counts_by_kind.map((row) => [row.kind, row.count]));
  assert.deepEqual(kinds, { document: 3, faq: 1, page: 1, site_page: 1, thing: 1 });
  for (const args of [{ source_kind: 'weekly_thing' }, { year: 2024 }, { year_range: [2017, 2026] }]) {
    const scoped = await ARCHIVE_TOOLS.corpus_stats(args, CTX);
    assert.ok(!scoped.sources.some((source) => source.source_kind === 'reference'), JSON.stringify(args));
  }
});

test('without a reference corpus, the older corpora still carry the rows as before', async () => {
  primeCorpusCachesForTests(fixtures({ reference: false }));
  const found = ids(await retrieve('tidepools', 30, { scope: 'all' }));
  for (const id of REFERENCE_IDS.slice(0, 4)) assert.ok(found.includes(id), id);
  const echoes = ids(await retrieve('tidepools', 30, { scope: 'all', excludeSourceKinds: ['site_page', 'faq'] }));
  assert.ok(!echoes.includes('site:about:0:aaa') && !echoes.includes('faq:schedule:0:bbb'), echoes.join(', '));
  const stats = await ARCHIVE_TOOLS.corpus_stats({}, CTX);
  assert.ok(!stats.sources.some((source) => source.source_kind === 'reference'));
  const page = await ARCHIVE_TOOLS.get_source({ id: 'page-71862' }, CTX);
  assert.equal(page.source?.id, 'page-71862');
});

test('matchesFilters still reads a reference row like any other', () => {
  const [site] = REFERENCE_ROWS;
  assert.equal(matchesFilters(site, {}), true);
  assert.equal(matchesFilters(site, { yearRange: [2017, 2017] }), false);
});
