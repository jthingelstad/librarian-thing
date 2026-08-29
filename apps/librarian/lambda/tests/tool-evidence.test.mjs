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

test('a single source-shaped result (get_source/get_issue) is its own evidence', () => {
  const summary = summarizeToolEvidence({
    issue_number: 219,
    source_kind: 'issue',
    subject: 'Weekly Thing 219',
    url: 'https://weekly.thingelstad.com/archive/219/',
    publish_date: '2022-06-11',
    text: 'The fifth anniversary issue.'
  });
  assert.equal(summary.sources.length, 1);
  assert.equal(summary.sources[0].issue_number, '219');
  assert.match(summary.sources[0].excerpt, /anniversary/);
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
