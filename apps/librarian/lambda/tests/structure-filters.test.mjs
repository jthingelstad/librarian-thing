// Phase 3 structure and voice (MCP 1.4.0, /retrieve 4.12.0): section
// families, content kinds, voice spans, the calendar window, and the
// role-aware link graph. Every filter must also hold on a corpus built
// before these fields existed, because CI's eval runs the new Lambda
// against the old S3 corpora first.
import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateLinkDomains, isHeadlineLink, linkRole, linkUrlKey, matchesSection } from '../dist/shared/archive-tools.mjs';
import {
  compactSource,
  matchesFilters,
  parseCalendar,
  retrievalFilterError,
  voicedText
} from '../dist/shared/retrieval.mjs';

const QUOTE = 'The best way to predict the future is to invent it, said somebody long ago.';
const FRAMING = 'I keep coming back to this line because it explains why I build things.';
const text = `${FRAMING}\n\n> ${QUOTE}`;
const spans = [
  { voice: 'jamie', start: 0, end: FRAMING.length + 2 },
  { voice: 'quoted', start: FRAMING.length + 2, end: text.length }
];

test('section matches the heading by substring or the family exactly', () => {
  const day = { section: 'Sunday', section_family: 'Journal' };
  assert.equal(matchesFilters(day, { section: 'journal' }), true);
  assert.equal(matchesFilters(day, { section: 'sun' }), true);
  assert.equal(matchesFilters(day, { section: 'jour' }), false, 'a family matches whole, not by substring');
  // An old corpus chunk has no family: the heading rule is unchanged.
  assert.equal(matchesFilters({ section: 'Journal' }, { section: 'journal' }), true);
  assert.equal(matchesFilters({ section: 'Sunday' }, { section: 'journal' }), false);
  assert.equal(matchesSection({ name: 'Monday', section_family: 'Journal' }, 'journal'), true);
  assert.equal(matchesSection({ section: 'Briefly' }, ''), true);
});

test('sectionFamily and contentKind match exactly, as a value or a list', () => {
  const chunk = { section: 'Microposts 🎈', section_family: 'Journal', content_kind: 'personal' };
  assert.equal(matchesFilters(chunk, { sectionFamily: 'Journal' }), true);
  assert.equal(matchesFilters(chunk, { sectionFamily: ['notable', 'journal'] }), true);
  assert.equal(matchesFilters(chunk, { sectionFamily: 'Notable' }), false);
  assert.equal(matchesFilters(chunk, { contentKind: 'personal' }), true);
  assert.equal(matchesFilters(chunk, { contentKind: ['links'] }), false);
  assert.equal(matchesFilters({ section: 'Journal' }, { sectionFamily: 'Journal' }), false, 'no family, no match');
});

test('voicedText keeps only the wanted voice, and no spans means all Jamie', () => {
  assert.equal(voicedText({ text, spans }, ['jamie']), FRAMING);
  assert.equal(voicedText({ text, spans }, ['quoted']), `> ${QUOTE}`);
  assert.equal(voicedText({ text, spans }, []), text);
  assert.equal(voicedText({ text }, ['jamie']), text);
  assert.equal(voicedText({ text }, ['quoted']), '');
});

test('a voice filter drops a chunk with too little of that voice', () => {
  assert.equal(matchesFilters({ text, spans }, { voice: 'jamie' }), true);
  assert.equal(matchesFilters({ text, spans }, { voice: 'link' }), false);
  const quoteOnly = {
    text: `Yes.\n\n> ${QUOTE}`,
    spans: [
      { voice: 'jamie', start: 0, end: 6 },
      { voice: 'quoted', start: 6, end: 8 + QUOTE.length }
    ]
  };
  assert.equal(matchesFilters(quoteOnly, { voice: 'jamie' }), false, 'one word of framing is not a passage');
  assert.equal(matchesFilters(quoteOnly, { voice: 'quoted' }), true);
});

test('the calendar window is this week in EARLIER years only', () => {
  const calendar = { date: '2026-10-04', window_days: 7 };
  assert.equal(matchesFilters({ publish_date: '2019-10-01T12:00:00Z' }, { calendar }), true);
  assert.equal(matchesFilters({ publish_date: '2019-10-12' }, { calendar }), false);
  assert.equal(matchesFilters({ publish_date: '2026-10-01' }, { calendar }), false, 'this year is not a past year');
  assert.equal(matchesFilters({ publish_date: '' }, { calendar }), false);
  // Across a year boundary: Dec 30 is within 7 days of Jan 3.
  assert.equal(matchesFilters({ publish_date: '2020-12-30' }, { calendar: { date: '2026-01-03', window_days: 7 } }), true);
  assert.deepEqual(parseCalendar({ date: '2026-10-04', window_days: 30 }), {
    month: 10,
    day: 4,
    window: 7,
    targetYear: 2026
  });
});

test('/retrieve rejects an unknown voice or a malformed calendar instead of widening', () => {
  assert.equal(retrievalFilterError({}), null);
  assert.equal(retrievalFilterError({ voice: 'jamie', calendar: { date: '2026-10-04' } }), null);
  assert.match(retrievalFilterError({ voice: 'thingy' }), /voice must be one of/);
  assert.match(retrievalFilterError({ calendar: '10-04' }), /calendar must be/);
  assert.match(retrievalFilterError({ calendar: { date: '10-04' } }), /YYYY-MM-DD/);
  assert.match(retrievalFilterError({ calendar: { date: '2026-02-30' } }), /not a calendar day/);
  assert.match(retrievalFilterError({ calendar: { date: '2026-10-04', window_days: -1 } }), /window_days/);
});

test('passages carry section_family and content_kind, and voice only when filtered', () => {
  const base = { id: 'c1', issue_number: 351, section: 'Sunday', section_family: 'Journal', content_kind: 'personal', text };
  const plain = compactSource(base);
  assert.equal(plain.section_family, 'Journal');
  assert.equal(plain.content_kind, 'personal');
  assert.equal(plain.voice, undefined);
  assert.equal('spans' in plain, false, 'spans stay internal');
  assert.deepEqual(compactSource({ ...base, voice: ['jamie'] }).voice, ['jamie']);
});

test('linkUrlKey is one key however an issue spelled the URL', () => {
  const key = 'example.com/post';
  assert.equal(linkUrlKey('https://www.example.com/post/'), key);
  assert.equal(linkUrlKey('http://example.com/post#section'), key);
  assert.equal(linkUrlKey('https://example.com/post?utm_source=x&ref=weekly-thing'), key);
  assert.equal(linkUrlKey('example.com/post'), key);
  assert.equal(linkUrlKey('https://example.com/post?id=2'), 'example.com/post?id=2', 'a real query key stays');
  assert.equal(linkUrlKey(''), '');
});

test('link roles: old Weekly Thing links are headlines, and rankings count headlines', () => {
  assert.equal(linkRole({ issue_number: 12, url: 'https://a.com' }), 'headline');
  assert.equal(linkRole({ issue_number: 12, link_role: 'journal' }), 'journal');
  assert.equal(linkRole({ source_kind: 'blog', url: 'https://a.com' }), '');
  assert.equal(isHeadlineLink({ source_kind: 'blog' }), true, 'blog links have no roles and all count');
  assert.equal(isHeadlineLink({ issue_number: 12, link_role: 'commentary' }), false);
  const links = [
    { issue_number: 1, link_role: 'headline', domain: 'a.com' },
    { issue_number: 1, link_role: 'commentary', domain: 'b.com' },
    { issue_number: 2, link_role: 'journal', domain: 'b.com' },
    { issue_number: 3, domain: 'a.com' }
  ];
  assert.deepEqual([...aggregateLinkDomains(links, { excludeInternal: false })], [['a.com', 2]]);
  assert.deepEqual(
    [...aggregateLinkDomains(links, { excludeInternal: false, headlineOnly: false })].sort(),
    [
      ['a.com', 2],
      ['b.com', 2]
    ]
  );
});
