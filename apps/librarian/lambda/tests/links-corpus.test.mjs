// The links corpus (Jamie, 2026-10-23): every public link Jamie saved on
// Linking Things (links.thingelstad.xyz), one passage a link, source_kind
// link. No scope holds it: a tool reads it only when a call names
// source_kind link, and then only it (beside the reference base).
import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS, argumentProblems, sourceKeyFromChunk } from '../dist/shared/archive-tools.mjs';
import { lensSourceId } from '../dist/shared/archive-lens.mjs';
import { LIBRARIAN_CONTRACT } from '../dist/shared/librarian-contract.mjs';
import { mcpToolDeclarations, validateToolArguments } from '../dist/shared/mcp.mjs';
import { parseResourceUri, sourceMarkdown } from '../dist/shared/mcp-resources.mjs';
import {
  compactSource,
  primeCorpusCachesForTests,
  retrievalFilterError,
  retrievalKinds,
  retrieve,
  SELECTABLE_SOURCE_KINDS
} from '../dist/shared/retrieval.mjs';
import { sourceLabel } from '../dist/shared/source-identity.mjs';

// No rerank call and no embeddings: the lexical leg alone ranks.
process.env.LIBRARIAN_RERANK_ENABLED = '0';

const CTX = { scope: 'all' };
const SAVED = 'abcdef012345';
const SHARED = '0123456789ab';
const VIDEO = 'fedcba987654';

const words = (text) => String(text).split(/\s+/).filter(Boolean).length;

// A saved link's passage as build_links_corpus writes it: the facts in the
// link voice (title, kind and host, the day saved, tags, the issues that
// shared it), then the note in its own voice.
function savedLink({
  id,
  title,
  host,
  url,
  type = 'page',
  saved,
  tags = [],
  note = '',
  voice = null,
  appearances = []
}) {
  const head = [
    title,
    `${type[0].toUpperCase()}${type.slice(1)} from ${host}, saved ${saved}`,
    ...(tags.length ? [`Tags: ${tags.join(', ')}`] : []),
    ...(appearances.length
      ? [`Shared in ${appearances.map((item) => `WT${item.issue_number}, ${item.section}`).join('; ')}`]
      : [])
  ].join('\n');
  const text = note ? `${head}\n\n${note}` : head;
  const spans = [{ voice: 'link', start: 0, end: head.length + (note ? 2 : 0) }];
  if (note) spans.push({ voice: voice === 'excerpt' ? 'quoted' : 'jamie', start: head.length + 2, end: text.length });
  return {
    id: `link:${id}:h${id.slice(0, 4)}`,
    link_id: id,
    source_kind: 'link',
    issue_number: null,
    subject: title,
    section: 'Saved link',
    publish_date: saved,
    issue_year: Number(saved.slice(0, 4)),
    published: `${saved}T12:00:00-05:00`,
    url: `https://links.thingelstad.xyz/links/${id}/`,
    link_url: url,
    host,
    domains: [host],
    link_type: type,
    tags,
    note_voice: voice,
    appearances,
    topics: [],
    content_kind: 'link',
    text,
    spans,
    word_count: words(text)
  };
}

const LINK_ROWS = [
  savedLink({
    id: SHARED,
    title: 'Kelp forests of Monterey Bay',
    host: 'example.org',
    url: 'https://example.org/kelp',
    saved: '2012-10-23',
    tags: ['ocean', '_brief'],
    note: 'I want to dive the kelpforest someday, it looks unreal.',
    voice: 'jamie',
    appearances: [{ issue_number: 300, section: 'Briefly', issue_url: '/archive/300/', publish_date: '2024-09-29' }]
  }),
  savedLink({
    id: SAVED,
    title: 'A field guide to the kelpforest',
    host: 'guide.example.com',
    url: 'https://guide.example.com/kelp.pdf',
    type: 'paper',
    saved: '2024-10-23',
    note: '> Giant kelpforest canopies grow half a meter a day.',
    voice: 'excerpt'
  }),
  savedLink({
    id: VIDEO,
    title: 'Kelpforest timelapse',
    host: 'video.example.net',
    url: 'https://video.example.net/watch?v=kelp',
    type: 'video',
    saved: '2025-03-01'
  })
];

function linksCorpus(chunks = LINK_ROWS) {
  return {
    version: 2,
    source: 'links',
    missing: !chunks.length,
    saved_link_count: chunks.length,
    chunk_count: chunks.length,
    issues: [],
    topics: [],
    links: [],
    media: [],
    chunks
  };
}

const prose = (fields) => ({ topics: [], ...fields, word_count: words(fields.text) });

function fixtures({ links = true, rows = LINK_ROWS } = {}) {
  return {
    weekly_thing: {
      issues: [
        {
          number: 300,
          subject: 'Kelpforest and the fall',
          publish_date: '2024-09-29T12:00:00Z',
          url: '/archive/300/',
          sections: [{ name: 'Briefly', text: 'The kelpforest of Monterey.' }],
          body: 'The kelpforest of Monterey.'
        }
      ],
      chunks: [
        prose({
          id: 'wt:300:0:a',
          source_kind: 'chunk',
          issue_number: 300,
          issue_year: 2024,
          publish_date: '2024-09-29T12:00:00Z',
          subject: 'Kelpforest and the fall',
          url: '/archive/300/',
          section: 'Briefly',
          text: 'The kelpforest of Monterey Bay, a link I could not stop reading.'
        })
      ],
      // The issue's link to the page Jamie saved: Linking Things joined it
      // to the issue, so the row carries the saved link's id.
      links: [
        {
          issue_number: 300,
          subject: 'Kelpforest and the fall',
          publish_date: '2024-09-29T12:00:00Z',
          issue_year: 2024,
          issue_url: '/archive/300/',
          section: 'Briefly',
          url: 'https://example.org/kelp',
          domain: 'example.org',
          text: 'Kelp forests of Monterey Bay',
          link_role: 'headline',
          link_id: SHARED
        }
      ],
      media: []
    },
    blog: {
      post_count: 1,
      page_count: 0,
      posts: [
        {
          microblog_id: 7001,
          subject: 'Saved this week',
          publish_date: '2024-10-25',
          url: 'https://www.thingelstad.com/2024/10/25/saved.html',
          post_kind: 'post',
          categories: []
        }
      ],
      chunks: [
        prose({
          id: 'blog:7001:0:a',
          source_kind: 'blog',
          microblog_id: 7001,
          publish_date: '2024-10-25',
          issue_year: 2024,
          subject: 'Saved this week',
          url: 'https://www.thingelstad.com/2024/10/25/saved.html',
          section: 'Blog post',
          text: 'I saved a kelpforest field guide this week.'
        })
      ],
      // A post that links the saved link's page on Linking Things.
      links: [
        {
          source_kind: 'blog',
          microblog_id: 7001,
          post_url: 'https://www.thingelstad.com/2024/10/25/saved.html',
          post_subject: 'Saved this week',
          subject: 'Saved this week',
          publish_date: '2024-10-25',
          post_year: 2024,
          issue_year: 2024,
          post_kind: 'post',
          section: 'Blog post',
          url: `https://links.thingelstad.xyz/links/${SAVED}/`,
          domain: 'links.thingelstad.xyz',
          text: 'a kelpforest field guide',
          target_source_kind: 'link',
          target_resolved: true,
          target_link_id: SAVED
        }
      ],
      media: []
    },
    podcast: { episodes: [], chunks: [], links: [] },
    ...(links ? { link: linksCorpus(rows) } : {})
  };
}

const ids = (rows) => rows.map((row) => row.id);
const isLinkRow = (row) => String(row.id).startsWith('link:');
const isLinkId = (id) => String(id).startsWith('link-');

test('link is a selectable source kind no scope holds', () => {
  assert.ok(SELECTABLE_SOURCE_KINDS.includes('link'));
  assert.equal(retrievalFilterError({ sourceKinds: ['link'] }), null);
  assert.equal(retrievalFilterError({ excludeSourceKinds: ['link'] }), null);
  assert.equal(retrievalFilterError({ sourceKinds: ['weekly_thing', 'link'] }), null);
  assert.match(String(retrievalFilterError({ sourceKinds: ['links'] })), /sourceKinds must name/);
  for (const scope of ['weekly_thing', 'blog', 'podcast', 'all', undefined]) {
    assert.ok(!retrievalKinds({ scope }).includes('link'), String(scope));
  }
  assert.deepEqual(retrievalKinds({ scope: 'all', sourceKinds: ['link'] }), ['link']);
  assert.deepEqual(retrievalKinds({ scope: 'all', sourceKinds: ['blog', 'link'] }), [
    'weekly_thing',
    'blog',
    'podcast',
    'link'
  ]);
});

test('no retrieval reads a saved link unless sourceKinds names link', async () => {
  primeCorpusCachesForTests(fixtures());
  for (const scope of ['weekly_thing', 'blog', 'podcast', 'all']) {
    for (const filter of [{}, { sourceKinds: ['blog'] }, { excludeSourceKinds: ['weekly_thing'] }]) {
      const found = await retrieve('kelpforest', 30, { scope, ...filter });
      assert.ok(!found.some(isLinkRow), `${scope} ${JSON.stringify(filter)}: ${ids(found)}`);
    }
  }
  const only = await retrieve('kelpforest', 30, { scope: 'all', sourceKinds: ['link'] });
  assert.deepEqual(ids(only).sort(), LINK_ROWS.map((row) => row.id).sort());
  const mixed = ids(await retrieve('kelpforest', 30, { scope: 'all', sourceKinds: ['blog', 'link'] }));
  assert.ok(mixed.includes('blog:7001:0:a') && mixed.some((id) => id.startsWith('link:')), mixed.join(', '));
  assert.ok(!mixed.includes('wt:300:0:a'), 'sourceKinds still narrows the prose');
  const excluded = await retrieve('kelpforest', 30, {
    scope: 'all',
    sourceKinds: ['link'],
    excludeSourceKinds: ['link']
  });
  assert.equal(excluded.length, 0);
});

test('a link passage names itself: link-<id>, its title, its Linking Things page and its facts', async () => {
  primeCorpusCachesForTests(fixtures());
  const [row] = await retrieve('Monterey', 5, { scope: 'all', sourceKinds: ['link'] });
  assert.equal(row.link_id, SHARED);
  assert.equal(lensSourceId(row), `link-${SHARED}`);
  assert.equal(sourceLabel(row), 'Kelp forests of Monterey Bay');
  assert.equal(sourceKeyFromChunk(row), `link\0${SHARED}`);
  const compact = compactSource(row);
  assert.equal(compact.url, `https://links.thingelstad.xyz/links/${SHARED}/`);
  assert.equal(compact.link_url, 'https://example.org/kelp');
  assert.equal(compact.host, 'example.org');
  assert.equal(compact.link_type, 'page');
  assert.deepEqual(compact.tags, ['ocean', '_brief']);
  assert.equal(compact.note_voice, 'jamie');
  assert.deepEqual(compact.shared_in_issues, [300]);
  assert.deepEqual(compact.topics, []);
  // A prose passage carries none of them.
  const [wt] = await retrieve('kelpforest Monterey', 5, { scope: 'weekly_thing' });
  assert.equal(compactSource(wt).link_url, undefined);
});

test("voice jamie keeps a saved link's own note and drops an excerpt", async () => {
  primeCorpusCachesForTests(fixtures());
  const found = await retrieve('kelpforest', 30, { scope: 'all', sourceKinds: ['link'], voice: 'jamie' });
  assert.deepEqual(ids(found), [LINK_ROWS[0].id]);
  assert.match(found[0].text, /^I want to dive the kelpforest/);
  const quoted = await retrieve('kelpforest', 30, { scope: 'all', sourceKinds: ['link'], voice: 'quoted' });
  assert.deepEqual(ids(quoted), [LINK_ROWS[1].id]);
});

test('search_archive and find_evidence read saved links only for source_kind link', async () => {
  primeCorpusCachesForTests(fixtures());
  const plain = await ARCHIVE_TOOLS.search_archive({ query: 'kelpforest', limit: 12 }, CTX);
  assert.ok(!plain.results.some((group) => isLinkId(group.id)), JSON.stringify(ids(plain.results)));
  const saved = await ARCHIVE_TOOLS.search_archive({ query: 'kelpforest', limit: 12, source_kind: 'link' }, CTX);
  assert.deepEqual(saved.results.map((group) => group.id).sort(), [`link-${SHARED}`, `link-${SAVED}`, `link-${VIDEO}`]);
  const group = saved.results.find((result) => result.id === `link-${SAVED}`);
  assert.equal(group.label, 'A field guide to the kelpforest');
  assert.equal(group.url, `https://links.thingelstad.xyz/links/${SAVED}/`);
  assert.equal(group.passages[0].link_type, 'paper');
  // An alias names the same kind.
  const alias = await ARCHIVE_TOOLS.search_archive({ query: 'kelpforest', source_kind: 'links' }, CTX);
  assert.equal(alias.results.length, 3);
  const topic = await ARCHIVE_TOOLS.search_archive({ query: 'kelp', source_kind: 'link', topic: 'Ocean' }, CTX);
  assert.equal(topic.code, 'bad_request');
  assert.match(topic.error, /no topic clusters/);
  const evidence = await ARCHIVE_TOOLS.find_evidence(
    { claim: 'kelpforest canopies grow fast', source_kind: 'link' },
    CTX
  );
  assert.ok(
    evidence.results[0].evidence.every((row) => isLinkId(row.id)),
    JSON.stringify(evidence).slice(0, 400)
  );
  assert.ok(evidence.results[0].evidence.some((row) => row.voices.includes('quoted')));
  const plainEvidence = await ARCHIVE_TOOLS.find_evidence({ claim: 'kelpforest canopies grow fast' }, CTX);
  assert.ok(!plainEvidence.results[0].evidence.some((row) => isLinkId(row.id)));
});

test('get_source reads a saved link by link-<id> or its page, in any scope', async () => {
  primeCorpusCachesForTests(fixtures());
  for (const scope of ['weekly_thing', 'blog', 'podcast', 'all']) {
    const read = await ARCHIVE_TOOLS.get_source({ id: `link-${SHARED}` }, { scope });
    assert.equal(read.source?.id, `link-${SHARED}`, JSON.stringify(read).slice(0, 300));
  }
  const read = await ARCHIVE_TOOLS.get_source({ id: `link-${SHARED}` }, CTX);
  assert.equal(read.source.source_kind, 'link');
  assert.equal(read.source.date, '2012-10-23');
  assert.equal(read.source.link_url, 'https://example.org/kelp');
  assert.equal(read.source.note, 'I want to dive the kelpforest someday, it looks unreal.');
  assert.equal(read.source.note_voice, 'jamie');
  assert.deepEqual(read.source.shared_in_issues, [300]);
  assert.match(read.source.body, /^Kelp forests of Monterey Bay\n/);
  for (const id of [
    `LINK-${SHARED.toUpperCase()}`,
    `https://links.thingelstad.xyz/links/${SHARED}/`,
    `links.thingelstad.xyz/links/${SHARED}`
  ]) {
    const again = await ARCHIVE_TOOLS.get_source({ id }, CTX);
    assert.equal(again.source?.id, `link-${SHARED}`, id);
  }
  const missing = await ARCHIVE_TOOLS.get_source({ id: 'link-000000000000' }, CTX);
  assert.ok(missing.error, 'an unknown saved link is not found');
});

test("a saved link's note stays whole when its title carries an emoji: offsets count code points", async () => {
  const id = 'e0e0e0e0e0e0';
  const emoji = savedLink({
    id,
    title: 'Kelpforest 🌊🐙 field notes 📝',
    host: 'notes.example.org',
    url: 'https://notes.example.org/kelp',
    saved: '2026-10-23',
    tags: ['🌊 ocean', 'kelpforest'],
    note: 'My own opinion: these kelpforest notes are worth reading twice, slowly, with a map.',
    voice: 'jamie'
  });
  // The spans as build_links_corpus writes them: Python's len() counts
  // code points, where String.prototype.slice counts UTF-16 units (an
  // emoji is two). Sliced by units, the note began with the header's tail
  // (Codex review, PR #87).
  const points = (value) => Array.from(value).length;
  const head = emoji.text.slice(0, emoji.text.indexOf('\n\n'));
  emoji.spans = [
    { voice: 'link', start: 0, end: points(head) + 2 },
    { voice: 'jamie', start: points(head) + 2, end: points(emoji.text) }
  ];
  primeCorpusCachesForTests(fixtures({ rows: [...LINK_ROWS, emoji] }));
  const read = await ARCHIVE_TOOLS.get_source({ id: `link-${id}` }, CTX);
  assert.equal(
    read.source?.note,
    'My own opinion: these kelpforest notes are worth reading twice, slowly, with a map.',
    JSON.stringify(read).slice(0, 300)
  );
  const listed = await ARCHIVE_TOOLS.list_content({ source_kind: 'link' }, CTX);
  assert.equal(
    listed.results.find((row) => row.id === `link-${id}`)?.note,
    'My own opinion: these kelpforest notes are worth reading twice, slowly, with a map.'
  );
  const found = await retrieve('kelpforest opinion', 30, { scope: 'all', sourceKinds: ['link'], voice: 'jamie' });
  assert.equal(
    found.find((row) => row.id === emoji.id)?.text,
    'My own opinion: these kelpforest notes are worth reading twice, slowly, with a map.'
  );
});

test('find_links names the saved link a row is, and lists the rows that are one', async () => {
  primeCorpusCachesForTests(fixtures());
  const all = await ARCHIVE_TOOLS.find_links({ limit: 20 }, CTX);
  const issueRow = all.results.find((row) => row.link_url === 'https://example.org/kelp');
  assert.equal(issueRow?.saved_link, `link-${SHARED}`, JSON.stringify(issueRow));
  const postRow = all.results.find((row) => String(row.link_url).includes('links.thingelstad.xyz'));
  assert.equal(postRow?.saved_link, `link-${SAVED}`, JSON.stringify(postRow));
  assert.equal(postRow?.link_category, 'cross_source');
  const one = await ARCHIVE_TOOLS.find_links({ id: `link-${SHARED}` }, CTX);
  assert.deepEqual(
    one.results.map((row) => row.id),
    ['wt-300']
  );
  const page = await ARCHIVE_TOOLS.find_links({ id: `link-${SAVED}`, source_kind: 'blog' }, CTX);
  assert.deepEqual(
    page.results.map((row) => row.id),
    ['blog-7001']
  );
  // find_links reads the links in Jamie's writing: a saved link has none.
  assert.ok(validateToolArguments('find_links', { source_kind: 'link' }).length > 0);
  assert.match(String(argumentProblems('find_links', { source_kind: 'link' })), /not read by find_links/);
  for (const tool of ['media_search', 'top_references', 'archive_gems']) {
    assert.match(String(argumentProblems(tool, { source_kind: 'bookmarks' })), new RegExp(`not read by ${tool}`));
  }
  assert.equal(argumentProblems('latest_content', { source_kind: 'link' }), null);
});

test("source_neighborhood: a saved link's incoming links and its saved neighbours", async () => {
  primeCorpusCachesForTests(fixtures());
  const near = await ARCHIVE_TOOLS.source_neighborhood({ id: `link-${SHARED}` }, CTX);
  assert.ok(!near.error, JSON.stringify(near).slice(0, 300));
  assert.equal(near.source.id, `link-${SHARED}`);
  assert.equal(near.outgoing_count, 0);
  assert.deepEqual(
    near.incoming_links.map((row) => row.id),
    ['wt-300']
  );
  // A prose source's neighbours never include a saved link.
  const wt = await ARCHIVE_TOOLS.source_neighborhood({ id: 'wt-300' }, CTX);
  assert.ok(!JSON.stringify(wt.related_sources || []).includes('"link-'), JSON.stringify(wt).slice(0, 400));
});

test('corpus_stats names the saved links by default and counts them on request', async () => {
  primeCorpusCachesForTests(fixtures());
  const plain = await ARCHIVE_TOOLS.corpus_stats({}, CTX);
  const pointer = plain.sources.filter((source) => source.source_kind === 'link');
  assert.equal(pointer.length, 1);
  assert.equal(pointer[0].searched_by_default, false);
  assert.equal(pointer[0].item_count, undefined);
  assert.match(pointer[0].hint, /source_kind link/);
  for (const args of [{ source_kind: 'blog' }, { year: 2024 }]) {
    const scoped = await ARCHIVE_TOOLS.corpus_stats(args, CTX);
    assert.ok(!scoped.sources.some((source) => source.source_kind === 'link'), JSON.stringify(args));
  }
  const stats = await ARCHIVE_TOOLS.corpus_stats({ source_kind: 'link' }, CTX);
  assert.equal(stats.sources.length, 1);
  const [entry] = stats.sources;
  assert.equal(entry.source_kind, 'link');
  assert.equal(entry.item_count, 3);
  assert.equal(entry.chunk_count, 3);
  assert.deepEqual(entry.counts_by_year, [
    { year: 2012, count: 1 },
    { year: 2024, count: 1 },
    { year: 2025, count: 1 }
  ]);
  assert.equal(entry.oldest.id, `link-${SHARED}`);
  assert.equal(entry.newest.id, `link-${VIDEO}`);
  const types = Object.fromEntries(entry.counts_by_link_type.map((row) => [row.link_type, row.count]));
  assert.deepEqual(types, { page: 1, paper: 1, video: 1 });
  const voices = Object.fromEntries(entry.counts_by_note_voice.map((row) => [row.note_voice, row.count]));
  assert.deepEqual(voices, { excerpt: 1, jamie: 1, none: 1 });
  assert.equal(entry.shared_in_issues_count, 1);
  assert.equal(entry.host_count, 3);
  const ranged = await ARCHIVE_TOOLS.corpus_stats({ source_kind: 'link', year_range: [2024, 2026] }, CTX);
  assert.equal(ranged.sources[0].item_count, 2);
  assert.equal(ranged.sources[0].item_count_total, 3);
});

test('the date and listing tools read saved links only for source_kind link', async () => {
  primeCorpusCachesForTests(fixtures());
  const noLinks = /"link-/;
  assert.doesNotMatch(JSON.stringify(await ARCHIVE_TOOLS.latest_content({ limit: 20 }, CTX)), noLinks);
  assert.doesNotMatch(JSON.stringify(await ARCHIVE_TOOLS.on_this_day({ date: '2026-10-23' }, CTX)), noLinks);
  assert.doesNotMatch(JSON.stringify(await ARCHIVE_TOOLS.list_content({ limit: 50 }, CTX)), noLinks);
  assert.doesNotMatch(JSON.stringify(await ARCHIVE_TOOLS.quote_search({ phrase: 'kelpforest' }, CTX)), noLinks);
  assert.doesNotMatch(JSON.stringify(await ARCHIVE_TOOLS.archive_lens({ topic: 'kelpforest' }, CTX)), noLinks);

  const latest = await ARCHIVE_TOOLS.latest_content({ source_kind: 'link', limit: 2 }, CTX);
  assert.deepEqual(
    latest.results.map((row) => row.id),
    [`link-${VIDEO}`, `link-${SAVED}`]
  );
  assert.equal(latest.total_count, 3);
  const day = await ARCHIVE_TOOLS.on_this_day({ date: '2026-10-23', source_kind: 'link' }, CTX);
  const items = day.years.flatMap((year) => year.items);
  assert.deepEqual(items.map((item) => item.id).sort(), [`link-${SHARED}`, `link-${SAVED}`]);
  assert.match(items.find((item) => item.id === `link-${SHARED}`).excerpt, /dive the kelpforest/);
  const listed = await ARCHIVE_TOOLS.list_content({ source_kind: 'link', domain: 'example.org' }, CTX);
  assert.deepEqual(
    listed.results.map((row) => row.id),
    [`link-${SHARED}`]
  );
  const quotes = await ARCHIVE_TOOLS.quote_search({ phrase: 'half a meter', source_kind: 'link' }, CTX);
  assert.deepEqual(
    quotes.results.map((row) => row.id),
    [`link-${SAVED}`]
  );
  const lens = await ARCHIVE_TOOLS.archive_lens({ topic: 'kelpforest', source_kind: 'link' }, CTX);
  assert.equal(lens.total_count, 3);
  assert.ok(Object.keys(lens.sources_by_id).every(isLinkId));
  const eras = await ARCHIVE_TOOLS.compare_eras(
    { topic: 'kelpforest', source_kind: 'link', year_a: [2010, 2013], year_b: [2024, 2026] },
    CTX
  );
  assert.equal(eras.era_a.sources_published, 1);
  assert.equal(eras.era_b.sources_published, 2);
});

test('without a links corpus, source_kind link answers empty, never an error', async () => {
  primeCorpusCachesForTests(fixtures({ links: false }));
  assert.deepEqual(await retrieve('kelpforest', 10, { scope: 'all', sourceKinds: ['link'] }), []);
  const search = await ARCHIVE_TOOLS.search_archive({ query: 'kelpforest', source_kind: 'link' }, CTX);
  assert.deepEqual(search.results, []);
  const stats = await ARCHIVE_TOOLS.corpus_stats({ source_kind: 'link' }, CTX);
  assert.equal(stats.sources[0].item_count, 0);
  const missing = await ARCHIVE_TOOLS.get_source({ id: `link-${SHARED}` }, CTX);
  assert.ok(missing.error);
});

test('the MCP surface offers link where a tool reads it, and the contract names it', () => {
  const reading = new Set([
    'search_archive',
    'find_evidence',
    'quote_search',
    'list_content',
    'latest_content',
    'on_this_day',
    'corpus_stats',
    'compare_eras',
    'archive_lens'
  ]);
  for (const tool of mcpToolDeclarations()) {
    const values = tool.inputSchema?.properties?.source_kind?.enum;
    if (!values) continue;
    assert.equal(values.includes('link'), reading.has(tool.name), tool.name);
  }
  const filters = LIBRARIAN_CONTRACT.endpoints['/retrieve'].request.properties.filters.properties;
  assert.ok(filters.sourceKinds.items.enum.includes('link'));
  assert.ok(filters.excludeSourceKinds.items.enum.includes('link'));
  assert.equal(LIBRARIAN_CONTRACT.version, '4.19.0');
});

test('librarian://link/{id} reads one saved link as markdown', () => {
  assert.deepEqual(parseResourceUri(`librarian://link/${SHARED}`), {
    uri: `librarian://link/${SHARED}`,
    kind: 'link',
    value: SHARED
  });
  assert.equal(parseResourceUri('librarian://link/not-an-id'), null);
  const markdown = sourceMarkdown({
    id: `link-${SHARED}`,
    source_kind: 'link',
    subject: 'Kelp forests of Monterey Bay',
    publish_date: '2012-10-23',
    url: `https://links.thingelstad.xyz/links/${SHARED}/`,
    link_url: 'https://example.org/kelp',
    shared_in_issues: [300],
    body: 'Kelp forests of Monterey Bay'
  });
  assert.match(markdown, /- Saved: 2012-10-23/);
  assert.match(markdown, /- Saved page: https:\/\/example\.org\/kelp/);
  assert.match(markdown, /- Shared in: WT300/);
  assert.doesNotMatch(markdown, /Published/);
});
