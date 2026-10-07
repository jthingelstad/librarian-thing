import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS, availableToolSpecs } from '../dist/shared/archive-tools.mjs';

const fetchPage = ARCHIVE_TOOLS.fetch_page;

test('fetch_page rejects unsafe urls without touching the network', async () => {
  for (const url of [
    'http://www.thingelstad.com/post.html', // not https
    'https://192.168.1.10/admin',
    'https://localhost/x',
    'https://internal.corp/x',
    'https://user:pass@example.com/x',
    'https://example.com:8443/x',
    'not a url',
    ''
  ]) {
    const result = await fetchPage({ url });
    assert.ok(result.error, `expected rejection for ${url}`);
  }
});

// Stands in for fetch, counting calls, so no test touches the network.
async function withFetch(responses, run) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return responses.shift();
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = saved;
  }
}

test("fetch_page reads only Jamie's own sites (Jamie, 2026-10-07)", async () => {
  for (const url of [
    'https://example.com/article',
    'https://escape.thingelstad.com/', // Jamie's, but not his writing
    'https://micro.blog/thingles',
    'https://thingelstad.com.evil.example/x',
    'https://evilthingelstad.com/x'
  ]) {
    await withFetch([], async (calls) => {
      const result = await fetchPage({ url });
      assert.match(String(result.error), /only Jamie\u2019s own sites/, url);
      assert.equal(calls.length, 0, `${url} must be refused before any request`);
    });
  }
});

test("fetch_page refuses a redirect off Jamie's sites before following it", async () => {
  const redirect = new Response(null, { status: 302, headers: { location: 'https://example.com/elsewhere' } });
  await withFetch([redirect], async (calls) => {
    const result = await fetchPage({ url: 'https://www.thingelstad.com/2026/10/07/new-post.html' });
    assert.match(String(result.error), /redirected off Jamie/);
    assert.deepEqual(calls, ['https://www.thingelstad.com/2026/10/07/new-post.html']);
  });
});

test("fetch_page reads a fresh post on Jamie's blog", async () => {
  const page = new Response('<html><head><title>New post</title></head><body><p>Fresh words.</p></body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
  await withFetch([page], async () => {
    const result = await fetchPage({ url: 'https://www.thingelstad.com/2026/10/07/new-post.html' });
    assert.equal(result.error, undefined);
    assert.equal(result.first_party, true);
    assert.equal(result.source.source_kind, 'live_page');
    assert.equal(result.source.subject, 'New post');
    assert.match(result.source.text, /Fresh words\./);
  });
});

test('the chat binds fetch_page and no web search tool', () => {
  const names = availableToolSpecs().map((spec) => spec.toolSpec?.name);
  assert.ok(names.includes('fetch_page'));
  assert.ok(!names.includes('web_search'));
});
