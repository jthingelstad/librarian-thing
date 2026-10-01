import { DeleteItemCommand, GetItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { dynamodb } from './aws-clients.mjs';
import { errorFields, logEvent } from './logging.mjs';
import { registeredClientName } from './mcp-audit-store.mjs';
import { OAUTH_FAMILY_ID_RE, refreshFamilyActive, revokeRefreshFamily } from './oauth-store.mjs';
import { DEFAULT_MCP_AUDIT_RETENTION_DAYS } from './retention.mjs';
import { dynamoNumber, dynamoString, userConversationPk } from './user-conversations.mjs';

// A reader's MCP connections and the log of what they called, for the
// account panel (contract 4.13.0, /memory actions mcp_connections,
// mcp_disconnect and mcp_log).
//
// A connection is one OAuth refresh family: the consent that started it and
// every rotation since. The token rows are keyed by token hash with no
// per-reader index, so each family also gets a row in the reader's own
// partition (user#<sub>, mcpconn#<family id>), written at consent and
// upserted on every refresh - a family granted before this row existed
// appears at its next refresh. The row's ttl slides with the family's
// (30 days from the last refresh, contract 4.14.0), and a family revoked by
// any path is hidden from the list because its family row is gone.

type Item = Record<string, AttributeValue>;
type JsonRecord = Record<string, unknown>;

const CONNECTION_SK_PREFIX = 'mcpconn#';
const AUDIT_SK_PREFIX = 'mcp#';
// The log the panel shows is the whole stored window.
export const MCP_LOG_RETENTION_DAYS = DEFAULT_MCP_AUDIT_RETENTION_DAYS;
export const MCP_LOG_PAGE_DEFAULT = 50;
export const MCP_LOG_PAGE_MAX = 100;
const MAX_CONNECTIONS_LISTED = 50;

export interface McpConnection {
  id: string;
  client_id: string;
  client_name: string;
  connected_at: string;
  last_authorized_at: string;
  last_used_at: string;
  call_count: number;
  expires_at: string;
}

export interface McpLogEntry {
  request_id: string;
  created_at: string;
  tool_name: string;
  status: string;
  duration_ms: number;
  result_chars: number;
  response_truncated: boolean;
  surface: string;
  client_id: string;
  client_name: string;
  connection_id: string;
  arguments: JsonRecord;
  server_version: string;
}

function tableName() {
  const value = process.env.TABLE_NAME;
  if (!value) throw new Error('TABLE_NAME is required');
  return value;
}

function isoFromSeconds(seconds: number) {
  return seconds > 0 ? new Date(seconds * 1000).toISOString() : '';
}

function itemString(item: Item, name: string) {
  return String(item[name]?.S || '');
}

function itemNumber(item: Item, name: string) {
  return Number(item[name]?.N || 0);
}

export function validConnectionId(value: unknown) {
  const raw = String(value || '').trim();
  return OAUTH_FAMILY_ID_RE.test(raw) ? raw : '';
}

function connectionKey(subscriberHash: string, familyId: string) {
  return {
    pk: dynamoString(userConversationPk(subscriberHash)),
    sk: dynamoString(`${CONNECTION_SK_PREFIX}${familyId}`)
  };
}

/**
 * Record (or refresh) a reader's connection row. Called at consent and on
 * every refresh; connected_at keeps the first value it was given.
 */
export async function recordMcpConnection({
  subscriberHash,
  clientId,
  familyId,
  connectedAt,
  expiresAt,
  now = Math.floor(Date.now() / 1000)
}: {
  subscriberHash: string;
  clientId: string;
  familyId: string;
  connectedAt: number;
  // When the family ends if not refreshed again.
  expiresAt: number;
  now?: number;
}) {
  if (!subscriberHash || !validConnectionId(familyId)) return;
  try {
    const clientName = await registeredClientName({ dynamodb, tableName: tableName(), clientId });
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: tableName(),
        Key: connectionKey(subscriberHash, familyId),
        UpdateExpression:
          'SET item_type = :type, client_id = :client, client_name = :name, family_id = :family, connected_at = if_not_exists(connected_at, :connected), last_authorized_at = :now, expires_at = :expires, #ttl = :expires',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':type': dynamoString('mcp_connection'),
          ':client': dynamoString(clientId),
          ':name': dynamoString(clientName),
          ':family': dynamoString(familyId),
          ':connected': dynamoNumber(connectedAt),
          ':now': dynamoNumber(now),
          ':expires': dynamoNumber(expiresAt)
        }
      })
    );
  } catch (error) {
    // The grant itself succeeded; a missing panel row must not fail it.
    logEvent('warning', 'mcp_connection_record_failed', errorFields(error, { client_id: clientId }));
  }
}

/** Count one audited call against its connection (no row is created). */
export async function touchMcpConnection(subscriberHash: string, familyId: string, at = new Date().toISOString()) {
  if (!subscriberHash || !validConnectionId(familyId)) return;
  try {
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: tableName(),
        Key: connectionKey(subscriberHash, familyId),
        UpdateExpression: 'SET last_used_at = :at ADD call_count :one',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':at': dynamoString(at), ':one': dynamoNumber(1) }
      })
    );
  } catch {
    // ConditionalCheckFailed means a pre-row grant; anything else is the
    // panel's counter, never worth failing a tool call over.
  }
}

async function connectionRows(subscriberHash: string): Promise<Item[]> {
  const response = await dynamodb.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': dynamoString(userConversationPk(subscriberHash)),
        ':prefix': dynamoString(CONNECTION_SK_PREFIX)
      },
      Limit: MAX_CONNECTIONS_LISTED
    })
  );
  return response.Items || [];
}

export function connectionFromItem(item: Item): McpConnection {
  return {
    id: itemString(item, 'family_id') || itemString(item, 'sk').slice(CONNECTION_SK_PREFIX.length),
    client_id: itemString(item, 'client_id'),
    client_name: itemString(item, 'client_name'),
    connected_at: isoFromSeconds(itemNumber(item, 'connected_at')),
    last_authorized_at: isoFromSeconds(itemNumber(item, 'last_authorized_at')),
    last_used_at: itemString(item, 'last_used_at'),
    call_count: itemNumber(item, 'call_count'),
    expires_at: isoFromSeconds(itemNumber(item, 'expires_at'))
  };
}

/** The reader's live connections, most recently used first. */
export async function listMcpConnections(subscriberHash: string): Promise<McpConnection[]> {
  const rows = await connectionRows(subscriberHash);
  const live = await Promise.all(
    rows.map(async (item) => {
      const connection = connectionFromItem(item);
      return validConnectionId(connection.id) && (await refreshFamilyActive(connection.id)) ? connection : null;
    })
  );
  const recency = (connection: McpConnection) => connection.last_used_at || connection.last_authorized_at;
  return live
    .filter((connection): connection is McpConnection => connection !== null)
    .sort((a, b) => recency(b).localeCompare(recency(a)));
}

/**
 * Disconnect one of the reader's connections: its refresh tokens and family
 * row go (the live access token dies with the family), then the panel row.
 * The id must name a row in the reader's own partition, so nobody can
 * revoke a family that is not theirs.
 */
export async function disconnectMcpConnection(subscriberHash: string, connectionId: unknown) {
  const id = validConnectionId(connectionId);
  if (!id) return { ok: false as const, reason: 'invalid' as const };
  const key = connectionKey(subscriberHash, id);
  const loaded = await dynamodb.send(new GetItemCommand({ TableName: tableName(), Key: key }));
  if (!loaded.Item) return { ok: false as const, reason: 'not_found' as const };
  await revokeRefreshFamily(id);
  await dynamodb.send(new DeleteItemCommand({ TableName: tableName(), Key: key }));
  logEvent('info', 'mcp_connection_disconnected', {
    subscriber_hash: subscriberHash,
    client_id: itemString(loaded.Item, 'client_id')
  });
  return { ok: true as const };
}

/** Revoke every connection the reader has (profile deletion). */
export async function revokeAllMcpConnections(subscriberHash: string) {
  const rows = await connectionRows(subscriberHash);
  let revoked = 0;
  for (const item of rows) {
    const id = validConnectionId(itemString(item, 'family_id'));
    if (!id) continue;
    await revokeRefreshFamily(id);
    revoked += 1;
  }
  return revoked;
}

export function logEntryFromItem(item: Item): McpLogEntry {
  let args: JsonRecord = {};
  try {
    const parsed: unknown = JSON.parse(itemString(item, 'arguments_json') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as JsonRecord;
  } catch {
    args = {};
  }
  return {
    request_id: itemString(item, 'request_id'),
    created_at: itemString(item, 'created_at'),
    tool_name: itemString(item, 'tool_name'),
    status: itemString(item, 'status') || 'ok',
    duration_ms: itemNumber(item, 'duration_ms'),
    result_chars: itemNumber(item, 'result_chars'),
    response_truncated: Boolean(item.response_truncated?.BOOL),
    surface: itemString(item, 'surface') || 'mcp',
    client_id: itemString(item, 'client_id'),
    client_name: itemString(item, 'client_name'),
    connection_id: itemString(item, 'connection_id'),
    arguments: args,
    server_version: itemString(item, 'server_version')
  };
}

// The cursor is the last row's sort key, opaque to the client.
function encodeCursor(sk: string) {
  return Buffer.from(sk, 'utf8').toString('base64url');
}

function decodeCursor(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 400 || !/^[A-Za-z0-9_-]+$/.test(raw)) return '';
  const sk = Buffer.from(raw, 'base64url').toString('utf8');
  return sk.startsWith(AUDIT_SK_PREFIX) ? sk : '';
}

export function mcpLogPageSize(value: unknown) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 1) return MCP_LOG_PAGE_DEFAULT;
  return Math.min(number, MCP_LOG_PAGE_MAX);
}

/**
 * One page of the reader's MCP log, newest first, inside the retention
 * window. connection_id narrows to one connection (rows written before
 * 2026-10-01 carry none); surface narrows to 'mcp' or 'web'.
 */
export async function readMcpLog(
  subscriberHash: string,
  {
    cursor,
    limit,
    connectionId,
    surface,
    now = new Date()
  }: { cursor?: unknown; limit?: unknown; connectionId?: unknown; surface?: unknown; now?: Date } = {}
) {
  const cutoff = new Date(now.getTime() - MCP_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const pageSize = mcpLogPageSize(limit);
  const connection = validConnectionId(connectionId);
  const door = surface === 'mcp' || surface === 'web' ? String(surface) : '';
  const filters = ['item_type = :type'];
  const values: Record<string, AttributeValue> = {
    ':pk': dynamoString(userConversationPk(subscriberHash)),
    ':from': dynamoString(`${AUDIT_SK_PREFIX}${cutoff}`),
    // '~' sorts after every ISO timestamp character.
    ':to': dynamoString(`${AUDIT_SK_PREFIX}~`),
    ':type': dynamoString('mcp_tool_call')
  };
  if (connection) {
    filters.push('connection_id = :connection');
    values[':connection'] = dynamoString(connection);
  }
  if (door) {
    filters.push('surface = :surface');
    values[':surface'] = dynamoString(door);
  }
  const start = decodeCursor(cursor);
  const entries: McpLogEntry[] = [];
  let exclusiveStartKey: Item | undefined = start
    ? { pk: dynamoString(userConversationPk(subscriberHash)), sk: dynamoString(start) }
    : undefined;
  // A filtered page can come back short; read on until it is full or the
  // window is exhausted, within a bounded number of reads.
  for (let read = 0; read < 5 && entries.length < pageSize; read += 1) {
    const response = await dynamodb.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        FilterExpression: filters.join(' AND '),
        ExpressionAttributeValues: values,
        ScanIndexForward: false,
        Limit: pageSize - entries.length,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {})
      })
    );
    for (const item of response.Items || []) entries.push(logEntryFromItem(item));
    exclusiveStartKey = response.LastEvaluatedKey;
    if (!exclusiveStartKey) break;
  }
  const nextSk = String(exclusiveStartKey?.sk?.S || '');
  return {
    entries,
    next_cursor: nextSk ? encodeCursor(nextSk) : '',
    retention_days: MCP_LOG_RETENTION_DAYS
  };
}
