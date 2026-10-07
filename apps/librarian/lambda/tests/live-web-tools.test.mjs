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

test('the chat binds fetch_page and no web search tool', () => {
  const names = availableToolSpecs().map((spec) => spec.toolSpec?.name);
  assert.ok(names.includes('fetch_page'));
  assert.ok(!names.includes('web_search'));
});
