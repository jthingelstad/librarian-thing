import { PutItemCommand } from '@aws-sdk/client-dynamodb';
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
  surface = 'mcp'
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
    ttl: dynamoNumber(mcpAuditTtlSeconds(createdAt))
  };
}

export async function recordMcpToolCall({ dynamodb, tableName, ...input }: RecordMcpToolCallInput): Promise<void> {
  if (!tableName) throw new Error('TABLE_NAME is required');
  await dynamodb.send(new PutItemCommand({ TableName: tableName, Item: mcpAuditItem(input) }));
}
