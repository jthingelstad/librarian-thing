import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MCP_LAUNCH_TOOLS,
  MCP_QUOTA_ERROR_CODE,
  handleMcpMessage,
  initializeResult,
  mcpToolDeclarations
} from '../dist/shared/mcp.mjs';

function context(overrides = {}) {
  return {
    subscriberHash: 'sub-1',
    entitlements: ['reader'],
    scope: 'archive:read',
    spendQuota: async () => ({ allowed: true, count: 1, max: 500 }),
    invokeTool: async (name, input) => ({ echoed: name, input }),
    ...overrides
  };
}

test('initialize negotiates a supported protocol version', () => {
  assert.equal(initializeResult('2025-06-18').protocolVersion, '2025-06-18');
  assert.equal(initializeResult('2025-03-26').protocolVersion, '2025-03-26');
  assert.equal(initializeResult('2099-01-01').protocolVersion, '2025-06-18');
  assert.ok(initializeResult().capabilities.tools);
  assert.equal(initializeResult().capabilities.tools.listChanged, true);
  assert.equal(initializeResult().serverInfo.name, 'librarian');
  // The version is the tool-surface cache key: it must change when the
  // packaged prompt/spec set changes, and be stable within one build.
  assert.match(initializeResult().serverInfo.version, /^1\.4\.0\+tools\.[0-9a-f]{12}$/);
  assert.equal(initializeResult().serverInfo.version, initializeResult().serverInfo.version);
});

test('tools/list exposes exactly the launch tools with JSON schemas', async () => {
  // web_search only appears once a Brave key is configured.
  delete process.env.BRAVE_SEARCH_API_KEY;
  const expected = MCP_LAUNCH_TOOLS.filter((name) => name !== 'web_search');
  const declarations = mcpToolDeclarations();
  assert.deepEqual(declarations.map((tool) => tool.name).sort(), [...expected].sort());
  for (const tool of declarations) {
    assert.ok(tool.description.length > 10, tool.name);
    assert.equal(tool.inputSchema.type, 'object', tool.name);
  }
  const reply = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, context());
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.result.tools.length, expected.length);

  process.env.BRAVE_SEARCH_API_KEY = 'test-key';
  const withKey = mcpToolDeclarations().map((tool) => tool.name);
  assert.ok(withKey.includes('web_search'));
  delete process.env.BRAVE_SEARCH_API_KEY;
});

test('tools/call invokes the registry handler and wraps text content', async () => {
  const reply = await handleMcpMessage(
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'search_archive', arguments: { query: 'rss' } } },
    context()
  );
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.result.isError, false);
  const body = JSON.parse(reply.payload.result.content[0].text);
  // Every MCP tool response is stamped with the tool-surface cache key.
  assert.match(String(body.server_version), /^\d+\.\d+\.\d+\+tools\./);
  delete body.server_version;
  assert.deepEqual(body, { echoed: 'search_archive', input: { query: 'rss' } });
});

test('tools/call rejects tools outside the launch surface', async () => {
  const reply = await handleMcpMessage(
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } },
    context()
  );
  assert.equal(reply.payload.error.code, -32602);
});

test('quota exhaustion returns the dedicated error without invoking the tool', async () => {
  let invoked = false;
  const reply = await handleMcpMessage(
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_source', arguments: {} } },
    context({
      spendQuota: async () => ({ allowed: false, count: 501, max: 500 }),
      invokeTool: async () => {
        invoked = true;
        return {};
      }
    })
  );
  assert.equal(invoked, false);
  assert.equal(reply.payload.error.code, MCP_QUOTA_ERROR_CODE);
  assert.match(reply.payload.error.message, /midnight UTC/);
});

test('tool handler failures come back as isError content, not protocol errors', async () => {
  const reply = await handleMcpMessage(
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'get_source', arguments: {} } },
    context({
      invokeTool: async () => {
        throw new Error('boom');
      }
    })
  );
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.result.isError, true);
});

test('notifications are accepted with 202 and no body', async () => {
  const reply = await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, context());
  assert.equal(reply.statusCode, 202);
  assert.equal(reply.payload, null);
});

test('framing errors: batches, non-JSON-RPC, unknown methods', async () => {
  assert.equal((await handleMcpMessage([{}], context())).payload.error.code, -32600);
  assert.equal((await handleMcpMessage({ hello: true }, context())).payload.error.code, -32600);
  const unknown = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'resources/list' }, context());
  assert.equal(unknown.payload.error.code, -32601);
});

test('ping answers an empty result', async () => {
  const reply = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'ping' }, context());
  assert.deepEqual(reply.payload.result, {});
});

test('oversized tool results are cut to valid JSON with an honest note', async () => {
  const reply = await handleMcpMessage(
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_source', arguments: {} } },
    context({ invokeTool: async () => ({ blob: 'x'.repeat(120000) }) })
  );
  const text = reply.payload.result.content[0].text;
  assert.ok(text.length <= 48000);
  const parsed = JSON.parse(text);
  assert.equal(parsed.truncated.max_chars, 48000);
  assert.deepEqual(parsed.truncated.clipped, ['blob']);
  assert.equal(reply.payload.result.isError, false);
});

test('a long list loses whole items off its end, counted, and still parses', async () => {
  const results = Array.from({ length: 300 }, (_v, index) => ({ id: `wt-${index}`, text: 'y'.repeat(400) }));
  const reply = await handleMcpMessage(
    { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'list_content', arguments: { limit: 120 } } },
    context({ invokeTool: async () => ({ results, total: 300 }) })
  );
  const parsed = JSON.parse(reply.payload.result.content[0].text);
  assert.ok(parsed.results.length > 1 && parsed.results.length < 300);
  assert.equal(parsed.results[0].id, 'wt-0', 'the ranked head survives');
  assert.equal(parsed.results.length + parsed.truncated.omitted.results, 300);
  assert.deepEqual(parsed.truncated.clipped, []);
  assert.match(parsed.truncated.hint, /narrow the arguments \(/);
});

test('an {error} result goes out as isError with a code and a next step', async () => {
  const reply = await handleMcpMessage(
    { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'get_source', arguments: { issue_number: '9999' } } },
    context({ invokeTool: async () => ({ error: 'Source not found.' }) })
  );
  assert.equal(reply.payload.result.isError, true);
  const parsed = JSON.parse(reply.payload.result.content[0].text);
  assert.equal(parsed.code, 'not_found');
  assert.ok(parsed.next.length > 10);
  const declared = await handleMcpMessage(
    { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'get_source', arguments: {} } },
    context({ invokeTool: async () => ({ error: 'Nope.', code: 'not_configured', next: 'Ask later.' }) })
  );
  const own = JSON.parse(declared.payload.result.content[0].text);
  assert.deepEqual([own.code, own.next], ['not_configured', 'Ask later.']);
});

test('bad arguments are refused before any quota is spent', async () => {
  let spent = 0;
  const ctx = context({
    spendQuota: async () => {
      spent += 1;
      return { allowed: true, count: 1, max: 500 };
    }
  });
  const call = async (name, args) =>
    handleMcpMessage({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name, arguments: args } }, ctx);
  for (const [name, args, pattern] of [
    ['search_archive', { query: 'rss', limit: 50 }, /limit must be from 1 to 12/],
    ['search_archive', { query: 'rss', lmit: 5 }, /unknown argument "lmit"/],
    ['search_archive', {}, /query is required/],
    ['list_content', { source_kind: 'podcast', year_range: [2026, 2020] }, /year_range runs backwards/],
    ['get_source', { source_kind: 'newsletter' }, /source_kind must be one of/]
  ]) {
    const reply = await call(name, args);
    assert.equal(reply.payload.result.isError, true, name);
    const parsed = JSON.parse(reply.payload.result.content[0].text);
    assert.equal(parsed.code, 'bad_request');
    assert.match(parsed.error, pattern);
    assert.ok(parsed.accepted_arguments.length > 0);
  }
  assert.equal(spent, 0);
  // Either spelling of a scalar passes.
  const ok = await call('search_archive', { query: 'rss', limit: '5', year_range: ['2020', 2021] });
  assert.equal(ok.payload.result.isError, false);
  assert.equal(spent, 1);
});

test('web_search without its key is neither listed nor callable', async () => {
  delete process.env.BRAVE_SEARCH_API_KEY;
  let spent = 0;
  const reply = await handleMcpMessage(
    { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'x' } } },
    context({
      spendQuota: async () => {
        spent += 1;
        return { allowed: true, count: 1, max: 500 };
      }
    })
  );
  assert.equal(reply.payload.error.code, -32602);
  assert.equal(spent, 0);
});

test('tool declarations carry human display titles', () => {
  const declarations = mcpToolDeclarations();
  const byName = new Map(declarations.map((tool) => [tool.name, tool]));
  assert.equal(byName.get('corpus_stats').title, 'Archive statistics');
  assert.equal(byName.get('source_neighborhood').title, 'Related sources');
  assert.equal(byName.get('currently_history').title, 'Reading, playing & watching');
  for (const tool of declarations) {
    assert.ok(tool.title && !tool.title.includes('_'), `${tool.name} has a human title`);
    assert.equal(tool.annotations.title, tool.title);
  }
});
