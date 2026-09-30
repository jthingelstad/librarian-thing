import assert from 'node:assert/strict';
import test from 'node:test';
import { MCP_AUDIT_ARGUMENT_MAX_CHARS, mcpAuditItem, recordMcpToolCall } from '../dist/shared/mcp-audit-store.mjs';
import { fromDynamoAttr } from '../dist/shared/user-conversations.mjs';
import { buildArchiveLens } from '../dist/shared/archive-lens.mjs';
import { yearlyContentSignals } from '../dist/shared/corpus-stats.mjs';

function decoded(item) {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, fromDynamoAttr(value)]));
}

test('MCP audit rows keep exact bounded arguments and allow-listed result evidence', () => {
  const item = decoded(
    mcpAuditItem({
      subscriberHash: 'reader-hash',
      requestId: 'request-1',
      createdAt: '2026-08-29T22:30:00.000Z',
      toolName: 'search_archive',
      arguments: { query: 'rss readers', limit: 3 },
      result: {
        results: [
          {
            issue_number: 300,
            subject: 'A source',
            url: '/archive/300/',
            text: 'Bounded public archive evidence.'
          }
        ],
        private_internal_field: 'must not survive'
      },
      status: 'ok',
      durationMs: 125,
      sourceRevision: 'chat-lambda/example',
      resultChars: 48001,
      responseTruncated: true,
      responseMaxChars: 48000
    })
  );

  assert.equal(item.pk, 'user#reader-hash');
  assert.equal(item.item_type, 'mcp_tool_call');
  assert.equal(item.external_answer_available, false);
  assert.deepEqual(JSON.parse(item.arguments_json), { query: 'rss readers', limit: 3 });
  const trace = JSON.parse(item.tool_trace_json);
  assert.equal(trace.surface, 'mcp');
  assert.equal(trace.external_answer_available, false);
  assert.equal(trace.calls[0].name, 'search_archive');
  assert.equal(trace.calls[0].delivery.response_truncated, true);
  assert.equal(trace.calls[0].result.counts.results, 1);
  assert.equal(trace.calls[0].result.sources[0].issue_number, '300');
  assert.doesNotMatch(item.tool_trace_json, /private_internal_field|must not survive/);
  assert.equal(item.response_truncated, true);
  assert.equal(item.result_chars, 48001);
  assert.ok(item.ttl > Math.floor(Date.parse('2026-08-29T22:30:00.000Z') / 1000));
});

test('MCP audit arguments fail closed to omission metadata when oversized', () => {
  const item = decoded(
    mcpAuditItem({
      subscriberHash: 'reader-hash',
      requestId: 'request-2',
      createdAt: '2026-08-29T22:31:00.000Z',
      toolName: 'search_archive',
      arguments: { query: 'x'.repeat(MCP_AUDIT_ARGUMENT_MAX_CHARS + 1000) },
      result: {},
      status: 'ok'
    })
  );
  const args = JSON.parse(item.arguments_json);
  assert.equal(args.compacted, true);
  assert.equal(args.omitted, true);
  assert.ok(args.original_chars > MCP_AUDIT_ARGUMENT_MAX_CHARS);
  assert.doesNotMatch(item.arguments_json, /x{100}/);
});

test('serialized MCP audits retain real lens and yearly aggregate source evidence', () => {
  const source = {
    source_kind: 'blog',
    subject: 'Data ownership',
    publish_date: '2025-01-01',
    url: 'https://www.thingelstad.com/2025/01/01/example.html',
    text: 'Data ownership is a reason to publish on your own site.'
  };
  for (const [toolName, result] of [
    ['archive_lens', buildArchiveLens({ topic: 'data ownership', operation: 'source_compare', chunks: [source] })],
    ['corpus_stats', { sources: [{ source_kind: 'blog', yearly_signals: yearlyContentSignals([source]) }] }]
  ]) {
    const item = decoded(
      mcpAuditItem({
        subscriberHash: 'reader-hash',
        requestId: `request-${toolName}`,
        createdAt: '2026-08-29T22:31:00.000Z',
        toolName,
        result,
        sourceRevision: 'chat-lambda/example'
      })
    );
    const trace = JSON.parse(item.tool_trace_json);
    assert.equal(trace.calls[0].result.sources[0].url, source.url);
    assert.equal(trace.calls[0].result.sources[0].source_kind, 'blog');
    assert.equal(trace.external_answer_available, false);
    assert.equal(trace.source_revision, 'chat-lambda/example');
    assert.equal(item.response_truncated, false);
  }
});

test('recordMcpToolCall sends one PutItem to the configured table', async () => {
  const calls = [];
  const dynamodb = { send: async (command) => calls.push(command.input) };
  await recordMcpToolCall({
    dynamodb,
    tableName: 'table-1',
    subscriberHash: 'reader-hash',
    requestId: 'request-3',
    createdAt: '2026-08-29T22:32:00.000Z',
    toolName: 'corpus_stats',
    arguments: {},
    result: { total: 350 },
    status: 'ok',
    durationMs: 9
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].TableName, 'table-1');
  assert.equal(fromDynamoAttr(calls[0].Item.request_id), 'request-3');
});

test('MCP audit rows carry surface, OAuth client and server version; web rows carry no client', () => {
  const mcpRow = decoded(
    mcpAuditItem({
      subscriberHash: 'reader-hash',
      requestId: 'request-4',
      createdAt: '2026-09-29T22:30:00.000Z',
      toolName: 'find_links',
      surface: 'mcp',
      clientId: 'client-abcdefghijklmnopqrstuv',
      clientName: 'Claude',
      serverVersion: '1.3.0+tools.abc123'
    })
  );
  assert.equal(mcpRow.surface, 'mcp');
  assert.equal(mcpRow.client_id, 'client-abcdefghijklmnopqrstuv');
  assert.equal(mcpRow.client_name, 'Claude');
  assert.equal(mcpRow.server_version, '1.3.0+tools.abc123');
  assert.equal(mcpRow.ttl, Math.floor(Date.parse('2026-09-29T22:30:00.000Z') / 1000) + 45 * 24 * 60 * 60);

  const webRow = decoded(
    mcpAuditItem({
      subscriberHash: 'reader-hash',
      requestId: 'request-5',
      createdAt: '2026-09-29T22:31:00.000Z',
      toolName: 'find_links',
      surface: 'web',
      serverVersion: '1.3.0+tools.abc123'
    })
  );
  assert.equal(webRow.surface, 'web');
  assert.equal(JSON.parse(webRow.tool_trace_json).surface, 'web');
  assert.equal('client_id' in webRow, false);
  assert.equal('client_name' in webRow, false);
  assert.equal(webRow.server_version, '1.3.0+tools.abc123');
});

test('recordMcpToolCall looks up the registered client name once per warm container', async () => {
  const calls = [];
  const dynamodb = {
    send: async (command) => {
      calls.push(command.input);
      return command.input.Key ? { Item: { client_name: { S: 'Claude Code' } } } : {};
    }
  };
  const call = (requestId) =>
    recordMcpToolCall({
      dynamodb,
      tableName: 'table-1',
      subscriberHash: 'reader-hash',
      requestId,
      createdAt: '2026-09-29T22:32:00.000Z',
      toolName: 'corpus_stats',
      surface: 'mcp',
      clientId: 'client-lookup-once-0000000000'
    });
  await call('request-6');
  await call('request-7');
  const reads = calls.filter((input) => input.Key);
  const puts = calls.filter((input) => input.Item);
  assert.equal(reads.length, 1);
  assert.equal(fromDynamoAttr(reads[0].Key.pk), 'oauthclient#client-lookup-once-0000000000');
  assert.equal(reads[0].ProjectionExpression, 'client_name');
  assert.equal(puts.length, 2);
  for (const put of puts) {
    assert.equal(fromDynamoAttr(put.Item.client_id), 'client-lookup-once-0000000000');
    assert.equal(fromDynamoAttr(put.Item.client_name), 'Claude Code');
  }
});

test('a failed client-name read never blocks the audit row', async () => {
  const puts = [];
  const dynamodb = {
    send: async (command) => {
      if (command.input.Key) throw new Error('throttled');
      puts.push(command.input);
      return {};
    }
  };
  await recordMcpToolCall({
    dynamodb,
    tableName: 'table-1',
    subscriberHash: 'reader-hash',
    requestId: 'request-8',
    createdAt: '2026-09-29T22:33:00.000Z',
    toolName: 'corpus_stats',
    surface: 'mcp',
    clientId: 'client-read-fails-00000000000'
  });
  assert.equal(puts.length, 1);
  assert.equal(fromDynamoAttr(puts[0].Item.client_id), 'client-read-fails-00000000000');
  assert.equal('client_name' in puts[0].Item, false);
});
