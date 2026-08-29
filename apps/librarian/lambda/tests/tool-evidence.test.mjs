import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EVIDENCE_MAX_CALL_CHARS,
  EVIDENCE_MAX_SOURCES,
  TOOL_TRACE_SCHEMA_VERSION,
  accumulateUsage,
  boundToolTrace,
  emptyUsageTotals,
  summarizeToolEvidence
} from '../dist/shared/tool-evidence.mjs';
import { MAX_TOOL_TRACE_JSON_CHARS, toolTraceDynamoString } from '../dist/shared/user-conversations.mjs';

function searchResult(count = 3) {
  return {
    query: 'data ownership',
    scope: 'all',
    results: Array.from({ length: count }, (_value, index) => ({
      id: `wt-${300 + index}-journal`,
      issue_number: 300 + index,
      source_kind: 'chunk',
      subject: `Weekly Thing ${300 + index}`,
      publish_date: `2025-0${index + 1}-01`,
      section: 'Journal',
      url: `https://weekly.thingelstad.com/archive/${300 + index}/`,
      score: 0.91 - index * 0.1,
      text: `Passage ${index} about owning your words and publishing on your own site.`
    }))
  };
}

test('search-shaped results become ranked evidence refs with excerpts', () => {
  const summary = summarizeToolEvidence(searchResult());
  assert.equal(summary.counts.results, 3);
  assert.equal(summary.sources.length, 3);
  assert.equal(summary.sources[0].rank, 1);
  assert.equal(summary.sources[0].id, 'wt-300-journal');
  assert.equal(summary.sources[0].issue_number, '300');
  assert.equal(summary.sources[0].section, 'Journal');
  assert.ok(summary.sources[0].score > summary.sources[1].score);
  assert.match(summary.sources[0].excerpt, /owning your words/);
});

test('a flat source-shaped result (get_section) is its own evidence', () => {
  const summary = summarizeToolEvidence({
    issue_number: 219,
    subject: 'Weekly Thing 219',
    url: 'https://weekly.thingelstad.com/archive/219/',
    publish_date: '2022-06-11',
    section: 'Journal',
    text: 'The fifth anniversary issue.'
  });
  assert.equal(summary.sources.length, 1);
  assert.equal(summary.sources[0].issue_number, '219');
  assert.equal(summary.sources[0].section, 'Journal');
  assert.match(summary.sources[0].excerpt, /anniversary/);
});

test('get_issue nested envelope becomes the primary evidence', () => {
  // Real shape from archive-tools.mts toolGetIssue: {issue: {number, ...}}.
  const summary = summarizeToolEvidence({
    issue: {
      number: 219,
      subject: 'Weekly Thing 219',
      publish_date: '2022-06-11',
      url: 'https://weekly.thingelstad.com/archive/219/',
      topics: ['anniversary'],
      sections: [{ name: 'Journal', word_count: 800 }],
      body: 'The fifth anniversary issue opens with a look back.'
    }
  });
  assert.equal(summary.sources.length, 1);
  assert.equal(summary.sources[0].issue_number, '219');
  assert.equal(summary.sources[0].title, 'Weekly Thing 219');
  assert.match(summary.sources[0].excerpt, /anniversary issue opens/);
});

test('get_source nested envelope wins over its inner links array', () => {
  // Real shape from toolGetSource: {source: {...record, links: [...], body}}.
  const summary = summarizeToolEvidence({
    source: {
      issue_number: 300,
      source_kind: 'weekly_thing',
      subject: 'Weekly Thing 300',
      url: 'https://weekly.thingelstad.com/archive/300/',
      publish_date: '2025-01-01',
      word_count: 2400,
      sections: [{ name: 'Journal', word_count: 800 }],
      links: [
        { url: 'https://example.com/linked-a', domain: 'example.com', title: 'Linked A' },
        { url: 'https://example.com/linked-b', domain: 'example.com', title: 'Linked B' }
      ],
      body: 'What Thingy actually read from issue three hundred.',
      section_texts: [{ name: 'Journal', text: 'Journal text.' }]
    }
  });
  assert.equal(summary.sources.length, 1);
  assert.equal(summary.sources[0].issue_number, '300');
  assert.equal(summary.sources[0].url, 'https://weekly.thingelstad.com/archive/300/');
  assert.match(summary.sources[0].excerpt, /actually read/);
  assert.ok(!JSON.stringify(summary.sources).includes('linked-a'));
});

test('link and aggregation shapes are harvested without a results key', () => {
  const links = summarizeToolEvidence({
    incoming_links: [{ url: 'https://example.com/a', domain: 'example.com', title: 'A post' }],
    outgoing_links: [{ url: 'https://other.dev/b', domain: 'other.dev' }],
    total_count: 12
  });
  assert.equal(links.counts.incoming_links, 1);
  assert.equal(links.counts.outgoing_links, 1);
  assert.equal(links.total_count, 12);
  assert.equal(links.sources.length, 2);

  const references = summarizeToolEvidence({
    domains: [
      { domain: 'stratechery.com', count: 55 },
      { domain: 'simonwillison.net', count: 71 }
    ],
    excluded_utility_links: 2421
  });
  assert.equal(references.sources.length, 2);
  assert.equal(references.sources[1].count, 71);
  assert.equal(references.sources[1].id, 'domain:simonwillison.net');
});

test('media_search refs carry the exact image and its source page', () => {
  // Real shape from toolMediaSearch: image_url is the image, source_url the
  // page it appeared on; there is no plain url field.
  const summary = summarizeToolEvidence({
    query: 'minnehaha creek',
    total_matches: 4,
    results: [
      {
        image_url: 'https://cdn.thingelstad.com/img/creek-ride.jpg',
        alt: 'Bike ride along Minnehaha Creek',
        context: 'Morning ride before WT348 went out.',
        source_kind: 'blog',
        subject: 'Creek Ride',
        source_url: 'https://www.thingelstad.com/2026/05/09/creek-ride.html',
        publish_date: '2026-05-09'
      }
    ]
  });
  const ref = summary.sources[0];
  assert.equal(ref.image_url, 'https://cdn.thingelstad.com/img/creek-ride.jpg');
  assert.equal(ref.url, 'https://www.thingelstad.com/2026/05/09/creek-ride.html');
  assert.ok(ref.id);
  assert.match(ref.excerpt, /Morning ride/);
});

test('an image-only media ref still gets a stable id', () => {
  const summary = summarizeToolEvidence({
    results: [{ image_url: 'https://cdn.thingelstad.com/img/only.jpg', alt: 'Only an image' }]
  });
  const ref = summary.sources[0];
  assert.equal(ref.id, 'https://cdn.thingelstad.com/img/only.jpg');
  assert.equal(ref.image_url, 'https://cdn.thingelstad.com/img/only.jpg');
});

test('claim_check topic echo and error results survive', () => {
  const summary = summarizeToolEvidence({ claim: 'Jamie ran a marathon in 2019', results: [] });
  assert.equal(summary.topic, 'Jamie ran a marathon in 2019');
  const failed = summarizeToolEvidence({ error: 'quote_search failed: TimeoutError' });
  assert.match(failed.error, /TimeoutError/);
});

test('arbitrary and private fields never reach evidence refs', () => {
  const summary = summarizeToolEvidence({
    results: [
      {
        issue_number: 300,
        subject: 'WT300',
        subscriber_hash: 'abc123',
        reader_email: 'x@example.com',
        internal_debug: { stack: 'secret' }
      }
    ]
  });
  const json = JSON.stringify(summary);
  assert.ok(!json.includes('abc123'));
  assert.ok(!json.includes('x@example.com'));
  assert.ok(!json.includes('secret'));
  assert.equal(summary.sources[0].issue_number, '300');
});

test('one huge call is bounded independently with truncation metadata', () => {
  const fat = searchResult(40);
  for (const entry of fat.results) entry.text = 'long '.repeat(500);
  const summary = summarizeToolEvidence(fat);
  assert.ok(JSON.stringify(summary).length <= EVIDENCE_MAX_CALL_CHARS);
  assert.ok(summary.sources.length <= EVIDENCE_MAX_SOURCES);
  assert.ok(summary.truncation);
  assert.equal(summary.counts.results, 40);
});

test('a fat trace degrades per call instead of vanishing', () => {
  const calls = Array.from({ length: 20 }, (_value, index) => ({
    name: `search_archive`,
    input: { query: `q${index}` },
    ok: true,
    duration_ms: 100 + index,
    result: summarizeToolEvidence(searchResult(8))
  }));
  const trace = { schema_version: TOOL_TRACE_SCHEMA_VERSION, calls };
  const stored = toolTraceDynamoString(trace).S;
  assert.ok(stored.length <= MAX_TOOL_TRACE_JSON_CHARS);
  const parsed = JSON.parse(stored);
  assert.notEqual(parsed.omitted, true);
  assert.equal(parsed.calls.length, 20);
  assert.equal(parsed.schema_version, TOOL_TRACE_SCHEMA_VERSION);
  for (const [index, call] of parsed.calls.entries()) {
    assert.equal(call.name, 'search_archive');
    assert.equal(call.ok, true);
    assert.equal(call.duration_ms, 100 + index);
    assert.ok(call.result.counts);
  }
});

test('boundToolTrace preserves order and skeletonizes largest calls first', () => {
  const small = { name: 'ping', ok: true, duration_ms: 5, result: { counts: { results: 1 } } };
  const big = {
    name: 'archive_lens',
    ok: true,
    duration_ms: 900,
    result: summarizeToolEvidence(searchResult(8))
  };
  const bounded = boundToolTrace({ calls: [small, big, small] }, 700);
  assert.equal(bounded.calls.length, 3);
  assert.deepEqual(
    bounded.calls.map((call) => call.name),
    ['ping', 'archive_lens', 'ping']
  );
  assert.equal(bounded.calls[1].result.truncation.evidence_dropped, true);
  assert.ok(JSON.stringify(bounded).length <= 700 + 200);
});

test('usage accumulates across every Bedrock turn including cache metrics', () => {
  const totals = emptyUsageTotals();
  accumulateUsage(totals, { inputTokens: 1000, outputTokens: 50, totalTokens: 1050, cacheReadInputTokens: 800 });
  accumulateUsage(totals, { inputTokens: 2000, outputTokens: 300, cacheWriteInputTokens: 1500 });
  accumulateUsage(totals, undefined);
  assert.equal(totals.bedrock_calls, 2);
  assert.equal(totals.input_tokens, 3000);
  assert.equal(totals.output_tokens, 350);
  assert.equal(totals.total_tokens, 1050 + 2300);
  assert.equal(totals.cache_read_input_tokens, 800);
  assert.equal(totals.cache_write_input_tokens, 1500);
});

test('the whole-trace bound is absolute under adversarial input', () => {
  // Skeletons alone cannot save a trace built from enormous inputs; the
  // bound must hold anyway, keeping earliest calls and honest metadata.
  const calls = Array.from({ length: 200 }, (_value, index) => ({
    name: `tool_${index}_${'x'.repeat(500)}`,
    input: { query: 'y'.repeat(1000) },
    ok: true,
    duration_ms: index,
    result: summarizeToolEvidence(searchResult(8))
  }));
  const stored = toolTraceDynamoString({ schema_version: TOOL_TRACE_SCHEMA_VERSION, calls }).S;
  assert.ok(stored.length <= MAX_TOOL_TRACE_JSON_CHARS, `stored ${stored.length} chars`);
  const parsed = JSON.parse(stored);
  assert.notEqual(parsed.omitted, true);
  assert.equal(parsed.schema_version, TOOL_TRACE_SCHEMA_VERSION);
  assert.ok(parsed.calls_dropped > 0);
  if (parsed.calls.length) {
    assert.equal(parsed.calls[0].duration_ms, 0);
  }
});

test('empty and null traces store safely', () => {
  assert.equal(toolTraceDynamoString(null).S, '');
  const parsed = JSON.parse(toolTraceDynamoString({ calls: [] }).S);
  assert.deepEqual(parsed.calls, []);
});

test('prompt fingerprint is deterministic and versionable', async () => {
  const { promptFingerprint } = await import('../dist/shared/prompts.mjs');
  const first = promptFingerprint();
  assert.match(first, /^[0-9a-f]{12}$/);
  assert.equal(promptFingerprint(), first);
});
