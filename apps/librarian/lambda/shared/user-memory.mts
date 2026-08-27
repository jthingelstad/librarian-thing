// Per-user profile backed by the existing Librarian DynamoDB table.
//
// Each reader gets one row keyed by
// the session token's `sub`. The row tracks basic account metadata only:
//
//   - first_seen_at / last_seen_at / turn_count
//   - preferred_name                 — what Thingy should call the reader
//
// Conversations themselves are stored server-side per conversation
// (user-conversations.mjs); this row deliberately carries no AI-derived
// memory. The earlier synthesized "learned profile" feature was removed —
// Thingy answers from the archive, not from modeling the reader.

// AWS clients and command classes are imported lazily inside the
// functions that touch DynamoDB. Keeps the pure helpers (`authProfile`,
// the read/write item shapers) loadable in test environments that don't
// have the AWS SDK installed.

import { logEvent } from './logging.mjs';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';

const TTL_DAYS_DEFAULT = 365;

type DynamoItem = Record<string, AttributeValue>;

export interface UserMemory {
  sub?: string;
  version?: number;
  first_seen_at?: string;
  last_seen_at?: string;
  preferred_name?: string;
  turn_count?: number;
}

function errorName(error: unknown) {
  return error instanceof Error ? error.constructor.name : 'Error';
}

function dynamoString(value: unknown): AttributeValue {
  return { S: String(value ?? '') };
}

function dynamoNumber(value: unknown): AttributeValue {
  return { N: String(Number(value || 0)) };
}

function memoryKey(sub: unknown): DynamoItem {
  return { pk: dynamoString(`user#${sub}`), sk: dynamoString('memory') };
}

function ttlFromNow() {
  const days = Number(process.env.LIBRARIAN_USER_MEMORY_TTL_DAYS || TTL_DAYS_DEFAULT);
  return Math.floor(Date.now() / 1000) + days * 86400;
}

export function memoryDynamoItem(
  sub: unknown,
  memory: UserMemory = {},
  nowIso = new Date().toISOString(),
  overrides: UserMemory = {}
): DynamoItem {
  const version = Number(overrides.version ?? memory.version ?? 0);
  return {
    pk: dynamoString(`user#${sub}`),
    sk: dynamoString('memory'),
    version: dynamoNumber(version),
    first_seen_at: dynamoString(memory.first_seen_at || nowIso),
    last_seen_at: dynamoString(overrides.last_seen_at || memory.last_seen_at || nowIso),
    preferred_name: dynamoString(overrides.preferred_name ?? memory.preferred_name ?? ''),
    turn_count: dynamoNumber(overrides.turn_count ?? memory.turn_count ?? 0),
    ttl: dynamoNumber(ttlFromNow())
  };
}

// ---------- public API ----------

export async function getUserMemory(sub: unknown, options: { consistent?: boolean } = {}) {
  const tableName = process.env.TABLE_NAME;
  if (!tableName || !sub) return null;
  try {
    const { GetItemCommand } = await import('@aws-sdk/client-dynamodb');
    const { dynamodb } = await import('./aws-clients.mjs');
    const response = await dynamodb.send(
      new GetItemCommand({
        TableName: tableName,
        Key: memoryKey(sub),
        ConsistentRead: Boolean(options.consistent)
      })
    );
    return memoryFromItem(response?.Item, sub);
  } catch (error) {
    logEvent('warning', 'user_memory_read_failed', {
      error_type: errorName(error)
    });
    return null;
  }
}

export function memoryFromItem(item: DynamoItem | undefined, sub: unknown = ''): UserMemory | null {
  if (!item) return null;
  return {
    sub: String(sub || ''),
    version: Number(item.version?.N || 0),
    first_seen_at: item.first_seen_at?.S || '',
    last_seen_at: item.last_seen_at?.S || '',
    preferred_name: item.preferred_name?.S || '',
    turn_count: Number(item.turn_count?.N || 0)
  };
}

// Record one chat turn. Best-effort — failures don't propagate.
export async function recordUserTurn(sub: unknown, { preferredName }: { preferredName?: unknown } = {}) {
  const tableName = process.env.TABLE_NAME;
  if (!tableName || !sub) return;
  const start = Date.now();
  try {
    const existing = await getUserMemory(sub);
    const nowIso = new Date().toISOString();
    const cleanPreferredName = String(preferredName || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    const priorVersion = Number(existing?.version || 0);
    const nextVersion = priorVersion + 1;
    const item = memoryDynamoItem(sub, existing || {}, nowIso, {
      version: nextVersion,
      last_seen_at: nowIso,
      preferred_name: cleanPreferredName || existing?.preferred_name || '',
      turn_count: (existing?.turn_count || 0) + 1
    });
    const { PutItemCommand } = await import('@aws-sdk/client-dynamodb');
    const { dynamodb } = await import('./aws-clients.mjs');
    // Optimistic lock: only write if `version` is exactly what we read
    // (or absent for a brand-new row). On contention, log and skip —
    // one lost turn count is better than clobbering a concurrent write.
    try {
      await dynamodb.send(
        new PutItemCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression: priorVersion === 0 ? 'attribute_not_exists(version)' : 'version = :prior_version',
          ExpressionAttributeValues: priorVersion === 0 ? undefined : { ':prior_version': dynamoNumber(priorVersion) }
        })
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
        logEvent('info', 'user_memory_write_contended', {
          prior_version: priorVersion
        });
        return;
      }
      throw error;
    }
    logEvent('info', 'user_memory_recorded', {
      turn_count: (existing?.turn_count || 0) + 1,
      version: nextVersion,
      duration_ms: Date.now() - start
    });
  } catch (error) {
    logEvent('warning', 'user_memory_write_failed', {
      error_type: errorName(error)
    });
  }
}

export async function recordUserPreferredName(sub: unknown, name: unknown) {
  const tableName = process.env.TABLE_NAME;
  const cleanName = String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  if (!tableName || !sub || !cleanName) return { ok: false, error: 'Missing memory write context.' };
  const nowIso = new Date().toISOString();
  try {
    const { UpdateItemCommand } = await import('@aws-sdk/client-dynamodb');
    const { dynamodb } = await import('./aws-clients.mjs');
    const response = await dynamodb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: memoryKey(sub),
        UpdateExpression: [
          'SET #preferred_name = :preferred_name',
          '#first_seen_at = if_not_exists(#first_seen_at, :now)',
          '#last_seen_at = :now',
          '#ttl = :ttl',
          '#version = if_not_exists(#version, :zero) + :one'
        ].join(', '),
        ExpressionAttributeNames: {
          '#preferred_name': 'preferred_name',
          '#first_seen_at': 'first_seen_at',
          '#last_seen_at': 'last_seen_at',
          '#ttl': 'ttl',
          '#version': 'version'
        },
        ExpressionAttributeValues: {
          ':preferred_name': dynamoString(cleanName),
          ':now': dynamoString(nowIso),
          ':ttl': dynamoNumber(ttlFromNow()),
          ':zero': dynamoNumber(0),
          ':one': dynamoNumber(1)
        },
        ReturnValues: 'ALL_NEW'
      })
    );
    logEvent('info', 'user_preferred_name_recorded');
    return { ok: true, memory: memoryFromItem(response?.Attributes, sub) };
  } catch (error) {
    logEvent('warning', 'user_preferred_name_write_failed', {
      error_type: errorName(error)
    });
    return { ok: false, error: 'Memory write failed.' };
  }
}

// Shape the profile for an auth response. Returning users get the
// `returning` flag so the frontend can welcome them back.
// The empty arrays are a frozen contract shape: web clients deployed
// before the synthesized-memory removal still read these keys.
export function authProfile(memory: UserMemory | null | undefined) {
  if (!memory) {
    return { returning: false };
  }
  const turnCount = Number(memory.turn_count || 0);
  return {
    returning: turnCount > 0,
    first_seen_at: memory.first_seen_at,
    last_seen_at: memory.last_seen_at,
    preferred_name: memory.preferred_name || '',
    turn_count: turnCount,
    current_session_questions: [],
    recent_prompts: [],
    prior_session_summaries: [],
    learned_profile: [],
    memory_synthesis: {}
  };
}
