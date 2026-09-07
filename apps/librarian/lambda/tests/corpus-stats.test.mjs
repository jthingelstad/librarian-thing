import assert from 'node:assert/strict';
import test from 'node:test';
import { countsByPublishYear, yearCountSummary, yearFromPublishDate, yearlyContentSignals } from '../dist/shared/corpus-stats.mjs';

test('yearFromPublishDate extracts a publication year', () => {
  assert.equal(yearFromPublishDate('2026-06-05T12:00:00Z'), 2026);
  assert.equal(yearFromPublishDate('posted in 1999 sometime'), 1999);
  assert.equal(yearFromPublishDate(''), 0);
});

test('countsByPublishYear counts records newest year first', () => {
  const out = countsByPublishYear([
    { publish_date: '2024-01-01' },
    { publish_date: '2026-06-05' },
    { publish_date: '2024-12-31' },
    { publish_date: '' },
    {}
  ]);
  assert.deepEqual(out, [
    { year: 2026, count: 1 },
    { year: 2024, count: 2 }
  ]);
});

test('yearCountSummary identifies highest and lowest count years', () => {
  assert.deepEqual(yearCountSummary([
    { year: 2025, count: 822 },
    { year: 2008, count: 783 },
    { year: 2000, count: 2 },
    { year: 2001, count: 2 }
  ]), {
    highest_years: [{ year: 2025, count: 822 }],
    lowest_years: [{ year: 2001, count: 2 }, { year: 2000, count: 2 }]
  });
});

test('yearlyContentSignals summarizes terms domains sections and samples', () => {
  const out = yearlyContentSignals([
    {
      source_kind: 'blog',
      publish_date: '2026-01-01',
      subject: 'RSS and personal knowledge systems',
      domains: ['example.com', 'example.com', 'rss.example'],
      section: 'Blog post',
      url: 'https://example.test/a'
    },
    {
      publish_date: '2026-02-01',
      subject: 'Personal archives and RSS',
      domains: ['rss.example'],
      section: 'Micropost',
      url: 'https://example.test/b'
    },
    {
      publish_date: '2025-01-01',
      subject: 'Travel notes',
      domains: [],
      section: 'Blog post',
      url: 'https://example.test/c'
    }
  ], {
    chunks: [
      {
        publish_date: '2026-01-01',
        subject: 'RSS and personal knowledge systems',
        section: 'Blog post',
        text: 'RSS readers and knowledge gardens make personal archives easier to revisit.'
      },
      {
        publish_date: '2026-02-01',
        subject: 'Personal archives and RSS',
        section: 'Micropost',
        text: 'Archive search, RSS, and personal publishing workflows.'
      }
    ]
  });

  assert.equal(out[0].year, 2026);
  assert.equal(out[0].count, 2);
  assert.equal(out[0].chunk_count, 2);
  assert.equal(out[0].top_subject_terms.find((item) => item.term === 'personal')?.count, 2);
  assert.equal(out[0].top_subject_terms.find((item) => item.term === 'rss')?.count, 2);
  assert.equal(out[0].top_text_terms.find((item) => item.term === 'personal')?.count, 2);
  assert.equal(out[0].top_text_terms.find((item) => item.term === 'rss')?.count, 2);
  assert.deepEqual(out[0].top_domains.slice(0, 2), [
    { domain: 'example.com', count: 2 },
    { domain: 'rss.example', count: 2 }
  ]);
  assert.deepEqual(out[0].counts_by_section, [
    { section: 'Blog post', count: 1 },
    { section: 'Micropost', count: 1 }
  ]);
  assert.equal(out[0].sample_items.length, 2);
  assert.equal(out[0].sample_items[0].source_kind, 'blog');
});

test('yearlyContentSignals keeps Weekly Thing identity on sample items', () => {
  const out = yearlyContentSignals([
    {
      source_kind: 'weekly_thing',
      issue_number: 350,
      publish_date: '2026-05-30',
      subject: 'Weekly Thing 350',
      section: 'Issue',
      url: '/archive/350/'
    }
  ]);

  assert.equal(out[0].sample_items[0].issue_number, '350');
  assert.equal(out[0].sample_items[0].source_kind, 'weekly_thing');
});
