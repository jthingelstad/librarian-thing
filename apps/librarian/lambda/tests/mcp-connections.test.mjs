// The reader's MCP connections and log (contract 4.13.0): a connection is a
// refresh family with a row in the reader's partition; disconnect revokes
// the family and the live access token with it; only the reader's own rows
// can be revoked; the log pages newest first inside the retention window.
import assert from 'node:assert/strict';
import test from 'node:test';
import { dynamodb } from '../dist/shared/aws-clients.mjs';
import {
  MCP_LOG_PAGE_MAX,
  MCP_LOG_RETENTION_DAYS,
  connectionFromItem,
  disconnectMcpConnection,
  listMcpConnections,
  logEntryFromItem,
  mcpLogPageSize,
  readMcpLog,
  recordMcpConnection,
  revokeAllMcpConnections,
  touchMcpConnection,
  validConnectionId
} from '../dist/shared/mcp-connections.mjs';
import { mcpAuditItem } from '../dist/shared/mcp-audit-store.mjs';
import { DEFAULT_MCP_AUDIT_RETENTION_DAYS } from '../dist/shared/retention.mjs';
import { sha256Hex, validateAccessToken } from '../dist/shared/oauth-store.mjs';
import { LIBRARIAN_CONTRACT } from '../dist/shared/librarian-contract.mjs';

process.env.TABLE_NAME = 'test-table';

const SUB = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const FAMILY = 'Fam1lyIdForTheTestAbCdE';
const FAMILY_2 = 'SecondFamilyIdForTests0';
const CLIENT = 'ClientIdForTheTestsAbCdE';
const S = (value) => ({ S: String(value) });
const N = (value) => ({ N: String(value) });

// A tiny single table: Get/Put/Delete by key, Query by pk with begins_with,
// and every Update/Query recorded for assertions.
function fakeTable(seed = []) {
  const rows = new Map(seed.map((item) => [`${item.pk.S}|${item.sk.S}`, item]));
  const calls = [];
  const original = dynamodb.send;
  dynamodb.send = async (command) => {
    const name = command.constructor.name;
    const input = command.input;
    calls.push({ name, input });
    const key = input.Key ? `${input.Key.pk.S}|${input.Key.sk.S}` : '';
    if (name === 'GetItemCommand') return { Item: rows.get(key) };
    if (name === 'DeleteItemCommand') {
      rows.delete(key);
      return {};
    }
    if (name === 'PutItemCommand') {
      rows.set(`${input.Item.pk.S}|${input.Item.sk.S}`, input.Item);
      return {};
    }
    if (name === 'UpdateItemCommand') return {};
    if (name === 'QueryCommand') {
      const pk = input.ExpressionAttributeValues[':pk'].S;
      const prefix = input.ExpressionAttributeValues[':prefix']?.S;
      const items = [...rows.values()].filter((item) => item.pk.S === pk && (!prefix || item.sk.S.startsWith(prefix)));
      return { Items: items };
    }
    throw new Error(`unexpected ${name}`);
  };
  return { rows, calls, restore: () => (dynamodb.send = original) };
}

function connectionRow(sub, family, extra = {}) {
  return {
    pk: S(`user#${sub}`),
    sk: S(`mcpconn#${family}`),
    item_type: S('mcp_connection'),
    family_id: S(family),
    client_id: S(CLIENT),
    client_name: S('Claude'),
    connected_at: N(1_790_000_000),
    last_authorized_at: N(1_790_000_100),
    ...extra
  };
}

const familyRow = (family) => ({ pk: S(`oauthfamily#${family}`), sk: S('family'), member_hashes: { L: [S('r1')] } });
const refreshRow = (hash) => ({ pk: S(`oauthrefresh#${hash}`), sk: S('refresh') });
const accessToken = `lat_${'x'.repeat(43)}`;
const accessRow = (family) => ({
  pk: S(`oauthaccess#${sha256Hex(accessToken)}`),
  sk: S('access'),
  client_id: S(CLIENT),
  subscriber_hash: S(SUB),
  entitlements: S('[]'),
  scope: S('archive:read'),
  expires_at: N(Math.floor(Date.now() / 1000) + 3600),
  ...(family ? { family_id: S(family) } : {})
});

test('disconnect revokes the family, its refresh tokens, the live access token and the panel row', async () => {
  const table = fakeTable([connectionRow(SUB, FAMILY), familyRow(FAMILY), refreshRow('r1'), accessRow(FAMILY)]);
  try {
    const before = await validateAccessToken(accessToken);
    assert.equal(before.familyId, FAMILY);
    const result = await disconnectMcpConnection(SUB, FAMILY);
    assert.deepEqual(result, { ok: true });
    assert.equal(table.rows.has(`oauthrefresh#r1|refresh`), false);
    assert.equal(table.rows.has(`oauthfamily#${FAMILY}|family`), false);
    assert.equal(table.rows.has(`user#${SUB}|mcpconn#${FAMILY}`), false);
    assert.equal(await validateAccessToken(accessToken), null, 'the access token dies with its family');
  } finally {
    table.restore();
  }
});

test("a reader cannot disconnect someone else's connection", async () => {
  const table = fakeTable([connectionRow(OTHER, FAMILY), familyRow(FAMILY), refreshRow('r1')]);
  try {
    assert.deepEqual(await disconnectMcpConnection(SUB, FAMILY), { ok: false, reason: 'not_found' });
    assert.ok(table.rows.has(`oauthfamily#${FAMILY}|family`));
    assert.ok(table.rows.has('oauthrefresh#r1|refresh'));
    assert.deepEqual(await disconnectMcpConnection(SUB, '../bad id'), { ok: false, reason: 'invalid' });
  } finally {
    table.restore();
  }
});

test('an access token minted before connections existed still validates until it lapses', async () => {
  const table = fakeTable([accessRow('')]);
  try {
    const context = await validateAccessToken(accessToken);
    assert.equal(context.subscriberHash, SUB);
    assert.equal(context.familyId, '');
  } finally {
    table.restore();
  }
});

test('the list hides revoked families and puts the most recently used first', async () => {
  const table = fakeTable([
    connectionRow(SUB, FAMILY, { last_used_at: S('2026-09-30T10:00:00.000Z'), call_count: N(12) }),
    connectionRow(SUB, FAMILY_2, { last_used_at: S('2026-10-01T10:00:00.000Z') }),
    connectionRow(SUB, 'RevokedFamilyIdForTests', {}),
    familyRow(FAMILY),
    familyRow(FAMILY_2)
  ]);
  try {
    const connections = await listMcpConnections(SUB);
    assert.deepEqual(
      connections.map((connection) => connection.id),
      [FAMILY_2, FAMILY]
    );
    assert.equal(connections[1].call_count, 12);
    assert.equal(connections[1].client_name, 'Claude');
    assert.equal(connections[1].connected_at, new Date(1_790_000_000_000).toISOString());
  } finally {
    table.restore();
  }
});

test('revokeAll (profile deletion) revokes every family the reader has', async () => {
  const table = fakeTable([
    connectionRow(SUB, FAMILY),
    connectionRow(SUB, FAMILY_2),
    familyRow(FAMILY),
    familyRow(FAMILY_2)
  ]);
  try {
    assert.equal(await revokeAllMcpConnections(SUB), 2);
    assert.equal(table.rows.has(`oauthfamily#${FAMILY}|family`), false);
    assert.equal(table.rows.has(`oauthfamily#${FAMILY_2}|family`), false);
  } finally {
    table.restore();
  }
});

test('recording keeps the first connected_at, slides the expiry, and touching never creates a row', async () => {
  const table = fakeTable([{ pk: S(`oauthclient#${CLIENT}`), sk: S('client'), client_name: S('Claude') }]);
  try {
    await recordMcpConnection({
      subscriberHash: SUB,
      clientId: CLIENT,
      familyId: FAMILY,
      connectedAt: 1_790_000_000,
      expiresAt: 1_792_592_000
    });
    const update = table.calls.find((call) => call.name === 'UpdateItemCommand').input;
    assert.equal(update.Key.sk.S, `mcpconn#${FAMILY}`);
    assert.match(update.UpdateExpression, /connected_at = if_not_exists\(connected_at, :connected\)/);
    // The expiry and ttl move with every refresh (4.14.0), never pinned to
    // the first one.
    assert.match(update.UpdateExpression, /expires_at = :expires, #ttl = :expires/);
    assert.equal(update.ExpressionAttributeValues[':expires'].N, '1792592000');
    assert.equal(update.ExpressionAttributeValues[':name'].S, 'Claude');
    await touchMcpConnection(SUB, FAMILY, '2026-10-01T12:00:00.000Z');
    const touch = table.calls.filter((call) => call.name === 'UpdateItemCommand')[1].input;
    assert.equal(touch.ConditionExpression, 'attribute_exists(pk)');
    assert.match(touch.UpdateExpression, /ADD call_count :one/);
  } finally {
    table.restore();
  }
});

test('the log reads the retention window newest first and pages by an opaque cursor', async () => {
  const original = dynamodb.send;
  const queries = [];
  const row = (at, id) =>
    mcpAuditItem({
      subscriberHash: SUB,
      requestId: id,
      createdAt: at,
      toolName: 'search_archive',
      arguments: { query: 'rss' },
      result: { results: [] },
      clientId: CLIENT,
      clientName: 'Claude',
      connectionId: FAMILY
    });
  dynamodb.send = async (command) => {
    queries.push(command.input);
    return queries.length === 1
      ? { Items: [row('2026-10-01T10:00:00.000Z', 'r2')], LastEvaluatedKey: row('2026-10-01T10:00:00.000Z', 'r2') }
      : { Items: [row('2026-09-30T10:00:00.000Z', 'r1')] };
  };
  try {
    const now = new Date('2026-10-01T12:00:00.000Z');
    const first = await readMcpLog(SUB, { limit: 1, connectionId: FAMILY, now });
    assert.equal(queries[0].ScanIndexForward, false);
    assert.equal(queries[0].Limit, 1);
    const cutoff = new Date(now.getTime() - MCP_LOG_RETENTION_DAYS * 86_400_000).toISOString();
    assert.equal(queries[0].ExpressionAttributeValues[':from'].S, `mcp#${cutoff}`);
    assert.match(queries[0].FilterExpression, /connection_id = :connection/);
    assert.equal(first.entries[0].tool_name, 'search_archive');
    assert.deepEqual(first.entries[0].arguments, { query: 'rss' });
    assert.equal(first.entries[0].connection_id, FAMILY);
    assert.equal(first.entries[0].client_name, 'Claude');
    assert.ok(first.next_cursor);
    assert.doesNotMatch(first.next_cursor, /mcp#|user#/, 'the cursor is opaque');
    const second = await readMcpLog(SUB, { cursor: first.next_cursor, limit: 1, now });
    assert.equal(queries[1].ExclusiveStartKey.sk.S, 'mcp#2026-10-01T10:00:00.000Z#r2');
    assert.equal(queries[1].ExclusiveStartKey.pk.S, `user#${SUB}`, 'a cursor never reaches another partition');
    assert.equal(second.next_cursor, '');
    assert.equal(second.retention_days, DEFAULT_MCP_AUDIT_RETENTION_DAYS);
  } finally {
    dynamodb.send = original;
  }
});

test('a forged cursor is ignored rather than trusted', async () => {
  const original = dynamodb.send;
  const queries = [];
  dynamodb.send = async (command) => {
    queries.push(command.input);
    return { Items: [] };
  };
  try {
    const forged = Buffer.from('conv#elsewhere', 'utf8').toString('base64url');
    await readMcpLog(SUB, { cursor: forged });
    await readMcpLog(SUB, { cursor: 'not a cursor!' });
    assert.equal(queries[0].ExclusiveStartKey, undefined);
    assert.equal(queries[1].ExclusiveStartKey, undefined);
  } finally {
    dynamodb.send = original;
  }
});

test('pure helpers: ids, page sizes and row shapes', () => {
  assert.equal(validConnectionId(FAMILY), FAMILY);
  assert.equal(validConnectionId('short'), '');
  assert.equal(validConnectionId('has spaces in it here'), '');
  assert.equal(mcpLogPageSize(undefined), 50);
  assert.equal(mcpLogPageSize(10_000), MCP_LOG_PAGE_MAX);
  assert.equal(mcpLogPageSize(-3), 50);
  assert.equal(connectionFromItem(connectionRow(SUB, FAMILY)).id, FAMILY);
  const web = logEntryFromItem(
    mcpAuditItem({ subscriberHash: SUB, requestId: 'w1', toolName: 'list_topics', surface: 'web' })
  );
  assert.equal(web.surface, 'web');
  assert.equal(web.connection_id, '');
  assert.equal(
    mcpAuditItem({ subscriberHash: SUB, requestId: 'm1', toolName: 'x', connectionId: FAMILY }).connection_id.S,
    FAMILY
  );
});

test('the contract (4.13.0, now 4.16.0) declares the /memory MCP actions', () => {
  assert.equal(LIBRARIAN_CONTRACT.version, '4.16.0');
  const actions = LIBRARIAN_CONTRACT.endpoints['/memory'].actions;
  assert.deepEqual(Object.keys(actions).sort(), [
    'mcp_clients',
    'mcp_connections',
    'mcp_delete_client',
    'mcp_disconnect',
    'mcp_log',
    'mcp_register_client'
  ]);
  assert.ok(LIBRARIAN_CONTRACT.$defs.mcpConnection);
  assert.ok(LIBRARIAN_CONTRACT.$defs.mcpLogEntry);
});
