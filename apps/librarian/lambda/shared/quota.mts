import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { dynamodb } from './aws-clients.mjs';
import { logEvent } from './logging.mjs';

// Per-user daily budget pools, independent per surface (Jamie's design
// call: chat and MCP each get their own pool so neither can exhaust the
// budget or starve the other). Chat counts agent turns - the expensive
// Claude-loop unit. MCP counts tool invocations - no Claude calls, so the
// pool is wider. Rate limits smooth bursts; these cap total daily spend.
export const DEFAULT_CHAT_DAILY_QUOTA = 50;
export const DEFAULT_MCP_DAILY_QUOTA = 500;

const QUOTA_TTL_SECONDS = 2 * 24 * 60 * 60;

export function chatDailyQuota() {
  const value = Number(process.env.CHAT_DAILY_QUOTA || DEFAULT_CHAT_DAILY_QUOTA);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_CHAT_DAILY_QUOTA;
}

export function mcpDailyQuota() {
  const value = Number(process.env.MCP_DAILY_QUOTA || DEFAULT_MCP_DAILY_QUOTA);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MCP_DAILY_QUOTA;
}

export function utcDayBucket(now: Date = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function quotaKey(surface: string, identity: string, day = utcDayBucket()) {
  return `quota#${surface}#${identity}#${day}`;
}

// Atomically spend one unit from the pool. Fails open on table errors -
// a broken quota counter must never take chat down.
export async function consumeDailyQuota(surface: string, identity: string, max: number) {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) return { allowed: true, count: 0, max };
  const now = Math.floor(Date.now() / 1000);
  try {
    const response = await dynamodb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: { S: quotaKey(surface, identity) }, sk: { S: 'quota' } },
        UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
        ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': { N: '1' },
          ':ttl': { N: String(now + QUOTA_TTL_SECONDS) }
        },
        ReturnValues: 'UPDATED_NEW'
      })
    );
    const count = Number(response.Attributes?.count?.N || '0');
    const allowed = count <= max;
    if (!allowed) {
      logEvent('warning', 'daily_quota_exceeded', { surface, identity_hash: identity, count, max });
    }
    return { allowed, count, max };
  } catch (error) {
    logEvent('warning', 'daily_quota_check_failed', {
      surface,
      identity_hash: identity,
      error_type: error instanceof Error ? error.constructor.name : 'Error'
    });
    return { allowed: true, count: 0, max };
  }
}

// Read-only peek for the account panel - never spends a unit.
export async function readDailyQuota(surface: string, identity: string) {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) return { count: 0 };
  try {
    const response = await dynamodb.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { pk: { S: quotaKey(surface, identity) }, sk: { S: 'quota' } }
      })
    );
    return { count: Number(response.Item?.count?.N || '0') };
  } catch {
    return { count: 0 };
  }
}

// Supporting members get double the daily pools - the entitlement tier is
// the budget tier (design Phase 4).
export function quotaMaxForEntitlements(base: number, entitlements: string[] = []) {
  return entitlements.includes('supporting_member') ? base * 2 : base;
}
