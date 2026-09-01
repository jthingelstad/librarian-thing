import assert from 'node:assert/strict';
import { test } from 'node:test';

const { MCP_LAUNCH_TOOLS, MCP_RESULT_MAX_CHARS, WEB_TOOLS, renderToolResultText, serverVersion } = await import(
  '../dist/shared/mcp.mjs'
);
const { DEFAULT_WEB_TOOLS_DAILY_QUOTA, webToolsDailyQuota } = await import('../dist/shared/quota.mjs');

test('the web tool surface is the MCP surface minus the outbound-network tools', () => {
  assert.ok(!WEB_TOOLS.includes('fetch_page'));
  assert.ok(!WEB_TOOLS.includes('web_search'));
  assert.equal(WEB_TOOLS.length, MCP_LAUNCH_TOOLS.length - 2);
  for (const name of WEB_TOOLS) assert.ok(MCP_LAUNCH_TOOLS.includes(name));
});

test('tool results stamp server_version and pass through untruncated when small', () => {
  const { text, truncated } = renderToolResultText('search_archive', { items: [1, 2] });
  assert.equal(truncated, false);
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.items, [1, 2]);
  assert.equal(parsed.server_version, serverVersion());
});

test('oversized results truncate with a parameter hint', () => {
  const { text, truncated } = renderToolResultText('search_archive', { blob: 'x'.repeat(MCP_RESULT_MAX_CHARS + 100) });
  assert.equal(truncated, true);
  assert.ok(text.length < MCP_RESULT_MAX_CHARS + 200);
  assert.match(text, /truncated at 48000 characters/);
  assert.match(text, /narrow the arguments \(/);
});

test('web tools daily quota defaults to its own pool and honors the env override', () => {
  assert.equal(DEFAULT_WEB_TOOLS_DAILY_QUOTA, 200);
  const saved = process.env.WEB_TOOLS_DAILY_QUOTA;
  try {
    delete process.env.WEB_TOOLS_DAILY_QUOTA;
    assert.equal(webToolsDailyQuota(), 200);
    process.env.WEB_TOOLS_DAILY_QUOTA = '50';
    assert.equal(webToolsDailyQuota(), 50);
    process.env.WEB_TOOLS_DAILY_QUOTA = 'junk';
    assert.equal(webToolsDailyQuota(), 200);
  } finally {
    if (saved === undefined) delete process.env.WEB_TOOLS_DAILY_QUOTA;
    else process.env.WEB_TOOLS_DAILY_QUOTA = saved;
  }
});
