import { GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { TOOL_TRACE_SCHEMA_VERSION, summarizeToolEvidence } from './tool-evidence.mjs';
import {
  boundedJsonForStorage,
  dynamoNumber,
  dynamoString,
  toolTraceDynamoString,
  userConversationPk
} from './user-conversations.mjs';
import { mcpAuditTtlSeconds } from './retention.mjs';

type JsonRecord = Record<string, unknown>;

export const MCP_AUDIT_ARGUMENT_MAX_CHARS = 4000;

interface McpAuditItemInput {
  subscriberHash?: unknown;
  requestId?: unknown;
  createdAt?: string;
  toolName?: unknown;
  arguments?: unknown;
  result?: unknown;
  status?: 'ok' | 'tool_error';
  durationMs?: unknown;
  sourceRevision?: unknown;
  resultChars?: unknown;
  responseTruncated?: boolean;
  responseMaxChars?: unknown;
  // Which door the call came through: 'mcp' (OAuth connectors) or 'web'
  // (the page's /tools route). Defaults to 'mcp' for existing callers.
  surface?: 'mcp' | 'web';
  // The OAuth client behind an 'mcp' call and its registered name. 'web'
  // calls have no OAuth client, so their rows carry neither.
  clientId?: unknown;
  clientName?: unknown;
  serverVersion?: unknown;
}

interface RecordMcpToolCallInput extends McpAuditItemInput {
  dynamodb: DynamoDBClient;
  tableName?: string;
}

function boundedArguments(value: unknown): JsonRecord {
  const json = boundedJsonForStorage(value ?? {}, MCP_AUDIT_ARGUMENT_MAX_CHARS);
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonRecord) : {};
  } catch {
    return {};
  }
}

export function mcpAuditSk(createdAt: string, requestId: string) {
  return `mcp#${createdAt}#${requestId}`;
}

export function mcpAuditItem({
  subscriberHash,
  requestId,
  createdAt = new Date().toISOString(),
  toolName,
  arguments: toolArguments,
  result,
  status = 'ok',
  durationMs,
  sourceRevision,
  resultChars,
  responseTruncated = false,
  responseMaxChars,
  surface = 'mcp',
  clientId,
  clientName,
  serverVersion
}: McpAuditItemInput): Record<string, AttributeValue> {
  const subscriber = String(subscriberHash || '').trim();
  const request = String(requestId || '').trim();
  const name = String(toolName || '')
    .trim()
    .slice(0, 80);
  if (!subscriber || !request || !name) throw new Error('subscriberHash, requestId, and toolName are required');
  const args = boundedArguments(toolArguments);
  const revision = String(sourceRevision || '')
    .trim()
    .slice(0, 200);
  const duration = Math.max(0, Math.round(Number(durationMs) || 0));
  const resultLength = Math.max(0, Math.round(Number(resultChars) || 0));
  const maxResponseLength = Math.max(0, Math.round(Number(responseMaxChars) || 0));
  const client = String(clientId || '')
    .trim()
    .slice(0, 80);
  const clientLabel = String(clientName || '')
    .trim()
    .slice(0, 100);
  const version = String(serverVersion || '')
    .trim()
    .slice(0, 120);
  const trace = {
    schema_version: TOOL_TRACE_SCHEMA_VERSION,
    surface,
    source_revision: revision,
    external_answer_available: false,
    calls: [
      {
        name,
        input: args,
        ok: status === 'ok',
        duration_ms: duration,
        delivery: {
          result_chars: resultLength,
          response_truncated: responseTruncated,
          max_response_chars: maxResponseLength
        },
        result: summarizeToolEvidence(result)
      }
    ]
  };
  return {
    pk: dynamoString(userConversationPk(subscriber)),
    sk: dynamoString(mcpAuditSk(createdAt, request)),
    item_type: dynamoString('mcp_tool_call'),
    request_id: dynamoString(request),
    created_at: dynamoString(createdAt),
    tool_name: dynamoString(name),
    status: dynamoString(status),
    duration_ms: dynamoNumber(duration),
    result_chars: dynamoNumber(resultLength),
    response_truncated: { BOOL: responseTruncated },
    arguments_json: dynamoString(JSON.stringify(args)),
    trace_schema_version: dynamoNumber(TOOL_TRACE_SCHEMA_VERSION),
    source_revision: dynamoString(revision),
    tool_trace_json: toolTraceDynamoString(trace),
    external_answer_available: { BOOL: false },
    surface: dynamoString(surface),
    ...(client ? { client_id: dynamoString(client) } : {}),
    ...(clientLabel ? { client_name: dynamoString(clientLabel) } : {}),
    ...(version ? { server_version: dynamoString(version) } : {}),
    ttl: dynamoNumber(mcpAuditTtlSeconds(createdAt))
  };
}

// Registered OAuth client names (the oauthclient#<id> rows oauth-store's
// createClient writes), memoized per warm container: an audited call costs
// at most one extra read per client per container, not one per call. A
// failed read is not cached and never blocks the audit row.
const CLIENT_NAME_CACHE_MAX = 200;
const clientNameCache = new Map<string, string>();

export async function registeredClientName({
  dynamodb,
  tableName,
  clientId
}: {
  dynamodb: DynamoDBClient;
  tableName?: string;
  clientId?: unknown;
}): Promise<string> {
  const id = String(clientId || '').trim();
  if (!id || !tableName) return '';
  const cached = clientNameCache.get(id);
  if (cached !== undefined) return cached;
  let name = '';
  try {
    const loaded = await dynamodb.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { pk: dynamoString(`oauthclient#${id}`), sk: dynamoString('client') },
        ProjectionExpression: 'client_name'
      })
    );
    name = String(loaded.Item?.client_name?.S || '');
  } catch {
    return '';
  }
  if (clientNameCache.size >= CLIENT_NAME_CACHE_MAX) clientNameCache.clear();
  clientNameCache.set(id, name);
  return name;
}

export async function recordMcpToolCall({ dynamodb, tableName, ...input }: RecordMcpToolCallInput): Promise<void> {
  if (!tableName) throw new Error('TABLE_NAME is required');
  const clientName =
    input.clientName ?? (await registeredClientName({ dynamodb, tableName, clientId: input.clientId }));
  await dynamodb.send(new PutItemCommand({ TableName: tableName, Item: mcpAuditItem({ ...input, clientName }) }));
}
