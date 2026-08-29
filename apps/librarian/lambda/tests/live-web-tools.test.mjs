import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS, availableToolSpecs, webSearchConfigured } from '../dist/shared/archive-tools.mjs';

const fetchPage = ARCHIVE_TOOLS.fetch_page;
const webSearch = ARCHIVE_TOOLS.web_search;

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

test('web_search without a key reports unconfigured instead of failing oddly', async () => {
  delete process.env.BRAVE_SEARCH_API_KEY;
  const result = await webSearch({ query: 'anything' });
  assert.match(result.error, /not configured/);
  assert.equal(webSearchConfigured(), false);
});

test('availableToolSpecs hides web_search until a key exists', () => {
  delete process.env.BRAVE_SEARCH_API_KEY;
  const withoutKey = availableToolSpecs().map((spec) => spec.toolSpec?.name);
  assert.ok(!withoutKey.includes('web_search'));
  assert.ok(withoutKey.includes('fetch_page'));
  process.env.BRAVE_SEARCH_API_KEY = 'test-key';
  const withKey = availableToolSpecs().map((spec) => spec.toolSpec?.name);
  assert.ok(withKey.includes('web_search'));
  delete process.env.BRAVE_SEARCH_API_KEY;
});
