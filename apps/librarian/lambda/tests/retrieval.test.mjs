import assert from 'node:assert/strict';
import test from 'node:test';
import { fuseCandidates, matchesFilters, parseYearRange, semanticScore } from '../dist/shared/retrieval.mjs';

function chunk(id, overrides = {}) {
  return { id, issue_number: id, text: `chunk ${id}`, ...overrides };
}

test('matchesFilters applies year ranges against issue_year', () => {
  assert.equal(matchesFilters(chunk(1, { issue_year: 2018 }), { yearRange: [2018, 2018] }), true);
  assert.equal(matchesFilters(chunk(1, { issue_year: 2026 }), { yearRange: [2018, 2018] }), false);
  assert.equal(matchesFilters(chunk(1, { issue_year: 2020 }), { yearRange: '2019-2021' }), true);
  assert.equal(matchesFilters(chunk(1, {}), { yearRange: [2018, 2018] }), false);
  assert.equal(matchesFilters(chunk(1, { issue_year: 2020 }), {}), true);
});

test('matchesFilters matches section as a case-insensitive substring', () => {
  assert.equal(matchesFilters(chunk(1, { section: 'Journal' }), { section: 'journal' }), true);
  assert.equal(matchesFilters(chunk(1, { section: 'Briefly' }), { section: 'journal' }), false);
});

test('parseYearRange reads arrays, objects, and prose', () => {
  assert.deepEqual(parseYearRange([2018, 2020]), [2018, 2020]);
  assert.deepEqual(parseYearRange({ start: 2019, end: 2021 }), [2019, 2021]);
  assert.deepEqual(parseYearRange('back in 2018'), [2018, 2018]);
  assert.deepEqual(parseYearRange(null), [null, null]);
});

test('semanticScore applies the keep predicate before the top-K slice', () => {
  // 40 near-perfect matches from 2026 would fill any top-K cut; the two 2018
  // chunks score lower. Filtering must happen inside the scan, so a
  // year-filtered query still surfaces the 2018 chunks.
  const chunks = [];
  for (let index = 0; index < 40; index += 1) {
    chunks.push(chunk(`new-${index}`, { issue_year: 2026, embedding: [1, 0] }));
  }
  chunks.push(chunk('old-1', { issue_year: 2018, embedding: [0.7, 0.7] }));
  chunks.push(chunk('old-2', { issue_year: 2018, embedding: [0.6, 0.8] }));
  const keep = (source) => matchesFilters(source, { yearRange: [2018, 2018] });

  const results = semanticScore({ chunks }, [1, 0], 10, keep);

  assert.equal(results.length, 2);
  assert.deepEqual(results.map((source) => source.id).sort(), ['old-1', 'old-2']);
  assert.ok(results.every((source) => Number(source.issue_year) === 2018));
});

test('semanticScore without a predicate keeps prior behavior', () => {
  const chunks = [
    chunk('a', { embedding: [1, 0] }),
    chunk('b', { embedding: [0, 1] }),
    chunk('c', { embedding: [0.9, 0.1] })
  ];
  const results = semanticScore({ chunks }, [1, 0], 2);
  assert.deepEqual(
    results.map((source) => source.id),
    ['a', 'c']
  );
  assert.ok(results[0]._retrieval_score > results[1]._retrieval_score);
});

test('fuseCandidates merges duplicates by id and records both modes', () => {
  const semantic = [chunk('x'), chunk('y')];
  const lexical = [chunk('x'), chunk('z')];

  const fused = fuseCandidates(semantic, lexical, 10);

  const byId = new Map(fused.map((source) => [source.id, source]));
  assert.equal(fused.length, 3);
  assert.deepEqual(byId.get('x').retrieval_modes.sort(), ['lexical', 'semantic']);
  assert.deepEqual(byId.get('y').retrieval_modes, ['semantic']);
  assert.deepEqual(byId.get('z').retrieval_modes, ['lexical']);
  // A chunk found by both engines outranks single-engine chunks.
  assert.equal(fused[0].id, 'x');
});

test('fuseCandidates respects the limit and rank order within a list', () => {
  const semantic = [chunk('a'), chunk('b'), chunk('c')];
  const fused = fuseCandidates(semantic, [], 2);
  assert.deepEqual(
    fused.map((source) => source.id),
    ['a', 'b']
  );
});

test('fuseCandidates degrades to lexical-only when semantic is empty', () => {
  const lexical = [chunk('l1'), chunk('l2')];
  const fused = fuseCandidates([], lexical, 10);
  assert.deepEqual(
    fused.map((source) => source.id),
    ['l1', 'l2']
  );
  assert.ok(fused.every((source) => source.retrieval_modes.includes('lexical')));
});

test('fuseCandidates falls back to a composite key when chunks have no id', () => {
  const noId = { issue_number: 42, section: 'Journal', text: 'same text' };
  const fused = fuseCandidates([{ ...noId }], [{ ...noId }], 10);
  assert.equal(fused.length, 1);
  assert.deepEqual(fused[0].retrieval_modes.sort(), ['lexical', 'semantic']);
});

test('journal twins dedupe by canonical blog URL - blog always wins', async () => {
  const { dedupeJournalTwins } = await import('../dist/shared/retrieval.mjs');
  const journal = {
    id: 'wt-journal',
    source_kind: 'chunk',
    journal_post_urls: ['https://www.thingelstad.com/2026/05/09/post-one.html'],
    _retrieval_score: 0.4
  };
  const blogTwin = {
    id: 'blog-1',
    source_kind: 'blog',
    url: 'https://www.thingelstad.com/2026/05/09/post-one.html',
    _retrieval_score: 0.9
  };
  const unrelated = { id: 'blog-2', source_kind: 'blog', url: 'https://www.thingelstad.com/other.html', _retrieval_score: 0.5 };

  // Blog scored higher: the journal chunk drops.
  let out = dedupeJournalTwins([journal, blogTwin, unrelated]);
  assert.deepEqual(out.map((c) => c.id).sort(), ['blog-1', 'blog-2']);

  // Journal scored higher: the blog twin STILL wins (Jamie's call - the
  // blog post is the canonical home of the writing).
  out = dedupeJournalTwins([{ ...journal, _retrieval_score: 0.95 }, blogTwin, unrelated]);
  assert.deepEqual(out.map((c) => c.id).sort(), ['blog-1', 'blog-2']);

  // No blog twin in the pool: the journal chunk stays.
  out = dedupeJournalTwins([journal, unrelated]);
  assert.deepEqual(out.map((c) => c.id).sort(), ['blog-2', 'wt-journal']);

  // No journal chunks: untouched.
  out = dedupeJournalTwins([blogTwin, unrelated]);
  assert.equal(out.length, 2);
});
