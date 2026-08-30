import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildArchiveLens,
  lensMatchReasons,
  matchesLensTopic,
  normalizeLensOperation
} from '../dist/shared/archive-lens.mjs';

const records = [
  {
    source_kind: 'weekly_thing',
    issue_number: '10',
    subject: 'RSS and blogs',
    publish_date: '2017-01-05',
    url: '/archive/10/',
    section: 'Issue',
    topics: ['RSS'],
    domains: ['example.com']
  },
  {
    source_kind: 'blog',
    microblog_id: 'p1',
    subject: 'Reading feeds again',
    publish_date: '2020-06-01',
    url: 'https://www.thingelstad.com/2020/06/reading-feeds/',
    section: 'Blog post',
    domains: ['feedly.com']
  },
  {
    source_kind: 'podcast',
    episode_number: 2,
    subject: 'Why personal publishing still matters',
    publish_date: '2026-02-01',
    url: 'https://another.thingelstad.com/2/',
    section: 'Episode',
    domains: ['thingelstad.com']
  }
];

const chunks = [
  {
    source_kind: 'weekly_thing',
    issue_number: '10',
    subject: 'RSS and blogs',
    publish_date: '2017-01-05',
    section: 'Notable',
    url: '/archive/10/',
    text: 'RSS readers make the open web feel durable and personal.',
    domains: ['example.com']
  },
  {
    source_kind: 'blog',
    microblog_id: 'p1',
    subject: 'Reading feeds again',
    publish_date: '2020-06-01',
    section: 'Blog post',
    url: 'https://www.thingelstad.com/2020/06/reading-feeds/',
    text: 'I keep coming back to RSS because it gives me a calmer way to read.',
    domains: ['feedly.com']
  },
  {
    source_kind: 'podcast',
    episode_number: 2,
    subject: 'Why personal publishing still matters',
    publish_date: '2026-02-01',
    section: 'Transcript',
    url: 'https://another.thingelstad.com/2/',
    text: 'A personal archive and RSS are ways to keep a durable record.',
    domains: ['thingelstad.com']
  }
];

test('normalizeLensOperation maps common aliases', () => {
  assert.equal(normalizeLensOperation('first and last'), 'first_last');
  assert.equal(normalizeLensOperation('themes by year'), 'by_year');
  assert.equal(normalizeLensOperation('compare sources'), 'source_compare');
  assert.equal(normalizeLensOperation('tour'), 'reading_path');
  assert.equal(normalizeLensOperation(''), 'timeline');
});

test('matchesLensTopic uses canonical semantics: phrases are contiguous, no token bags', () => {
  assert.equal(matchesLensTopic(chunks[0], 'open web'), true);
  // "RSS durability" as a phrase requires the contiguous sequence - the
  // old token-overlap acceptance was the round-five alias bug family.
  assert.equal(matchesLensTopic(chunks[0], 'RSS durability'), false);
  assert.equal(matchesLensTopic(chunks[0], 'RSS'), true);
  assert.equal(matchesLensTopic(chunks[0], 'Big Green Egg'), false);
  const reasons = lensMatchReasons(chunks[0], 'open web');
  assert.deepEqual(
    reasons.map((reason) => reason.field),
    ['text']
  );
  assert.match(reasons[0].match, /open web/, 'reason carries the actual span');
});

test('buildArchiveLens returns first latest year and source structure', () => {
  const lens = buildArchiveLens({ topic: 'RSS', operation: 'timeline', records, chunks });

  const resolve = (id) => lens.sources_by_id[id];
  assert.equal(lens.total_sources, 3);
  assert.equal(resolve(lens.first).issue_number, '10');
  assert.equal(resolve(lens.latest).source_kind, 'podcast');
  assert.deepEqual(
    lens.counts_by_year.map((row) => row.year),
    [2026, 2020, 2017]
  );
  assert.equal(lens.years.find((row) => row.year === 2020).source_count, 1);
  assert.equal(lens.sources.find((row) => row.source_kind === 'blog').source_count, 1);
  assert.match(resolve(lens.timeline[0]).evidence[0].text, /open web/);
  assert.ok(
    resolve(lens.timeline[0]).match_reasons.some((reason) => reason.startsWith('topics:') || reason.startsWith('text:'))
  );
});

test('buildArchiveLens filters by year and shapes reading paths', () => {
  const lens = buildArchiveLens({
    topic: 'RSS',
    operation: 'reading_path',
    records,
    chunks,
    yearRange: [2020, 2026],
    limit: 4
  });

  const resolve = (id) => lens.sources_by_id[id];
  assert.equal(resolve(lens.first).source_kind, 'blog');
  assert.equal(resolve(lens.latest).source_kind, 'podcast');
  assert.ok(lens.reading_path.length >= 2);
  assert.ok(lens.results.every((id) => ['blog', 'podcast'].includes(resolve(id).source_kind)));
});
