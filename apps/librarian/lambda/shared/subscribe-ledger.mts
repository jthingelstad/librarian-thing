/**
 * The subscribe ledger.
 *
 * Every address a reader types into the newsletter form is written here
 * BEFORE we ask Buttondown anything, and the row is updated with what
 * happened. Real address, not a hash: the point is that a person who asked
 * to subscribe can be reached back to when the machinery said no — twelve
 * addresses failed in the 30 days before this existed and the only trace
 * was a hash in a log (Jamie, 2026-09-20: "we just lose the subscriber").
 * Storing an address someone gave us in order to subscribe is fulfilment,
 * not measurement; rows expire after LEDGER_TTL_DAYS.
 *
 * Rows share the Librarian table: pk `subscribe#attempt`, sk `<iso>#<id>`.
 * The eval stream mapping filters on `user#`, so these never wake it.
 */

import { PutItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';
import { dynamodb } from './aws-clients.mjs';
import { logEvent } from './logging.mjs';
import { normalizeEmail } from './session.mjs';

export const LEDGER_PK = 'subscribe#attempt';
export const LEDGER_TTL_DAYS = 90;

/** How an attempt ended. `pending` means we never got to write the outcome. */
export type LedgerOutcome =
  | 'pending'
  | 'subscribed'
  | 'already_subscribed'
  | 'reminder_resent'
  | 'resubscribed'
  | 'resubscribe_unavailable'
  | 'suppressed'
  | 'lookup_failed'
  | 'create_failed'
  | 'reminder_failed';

/** Final outcomes that need a person: the reader wanted in and the API could not do it. */
export const NEEDS_JAMIE: ReadonlySet<LedgerOutcome> = new Set(['suppressed', 'resubscribe_unavailable']);
/** Outcomes that were the machinery's fault and may clear on their own. */
export const TRANSIENT: ReadonlySet<LedgerOutcome> = new Set([
  'lookup_failed',
  'create_failed',
  'reminder_failed',
  'pending'
]);

export interface LedgerRow {
  sk: string;
  at: string;
  email: string;
  source: string;
  campaign_ref?: string;
  outcome: LedgerOutcome;
  buttondown_code?: string;
  detail?: string;
}

export interface LedgerKey {
  pk: string;
  sk: string;
}

function tableName() {
  return process.env.TABLE_NAME || '';
}

const S = (value: unknown): AttributeValue => ({ S: String(value ?? '') });
const N = (value: number): AttributeValue => ({ N: String(value) });

/** Write the attempt as `pending`. Never throws: the ledger must not stop a subscribe. */
export async function recordAttempt(input: {
  email: unknown;
  source: unknown;
  campaign_ref?: unknown;
}): Promise<LedgerKey | null> {
  const table = tableName();
  if (!table) return null;
  const at = new Date().toISOString();
  const key = { pk: LEDGER_PK, sk: `${at}#${randomUUID().slice(0, 8)}` };
  const item: Record<string, AttributeValue> = {
    pk: S(key.pk),
    sk: S(key.sk),
    at: S(at),
    email: S(normalizeEmail(input.email)),
    source: S(String(input.source || 'unknown')),
    outcome: S('pending'),
    ttl: N(Math.floor(Date.now() / 1000) + LEDGER_TTL_DAYS * 86_400)
  };
  if (input.campaign_ref) item.campaign_ref = S(input.campaign_ref);
  try {
    await dynamodb.send(new PutItemCommand({ TableName: table, Item: item }));
    return key;
  } catch (error) {
    logEvent('error', 'subscribe_ledger_write_failed', { error_type: (error as Error)?.name || 'Error' });
    return null;
  }
}

/** Update the row with how it ended. Never throws. */
export async function recordOutcome(
  key: LedgerKey | null,
  outcome: LedgerOutcome,
  extra: { buttondown_code?: string; detail?: string } = {}
): Promise<void> {
  const table = tableName();
  if (!table || !key) return;
  const names: Record<string, string> = { '#o': 'outcome' };
  const values: Record<string, AttributeValue> = { ':o': S(outcome) };
  const sets = ['#o = :o'];
  if (extra.buttondown_code) {
    names['#c'] = 'buttondown_code';
    values[':c'] = S(extra.buttondown_code);
    sets.push('#c = :c');
  }
  if (extra.detail) {
    names['#d'] = 'detail';
    values[':d'] = S(String(extra.detail).slice(0, 300));
    sets.push('#d = :d');
  }
  try {
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: table,
        Key: { pk: S(key.pk), sk: S(key.sk) },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values
      })
    );
  } catch (error) {
    logEvent('error', 'subscribe_ledger_update_failed', { error_type: (error as Error)?.name || 'Error' });
  }
}

/** Every attempt since an instant, oldest first. */
export async function listAttemptsSince(sinceIso: string): Promise<LedgerRow[]> {
  const table = tableName();
  if (!table) return [];
  const rows: LedgerRow[] = [];
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const page = await dynamodb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND sk >= :since',
        ExpressionAttributeValues: { ':pk': S(LEDGER_PK), ':since': S(sinceIso) },
        ExclusiveStartKey: startKey
      })
    );
    for (const item of page.Items || []) {
      rows.push({
        sk: item.sk?.S || '',
        at: item.at?.S || '',
        email: item.email?.S || '',
        source: item.source?.S || '',
        campaign_ref: item.campaign_ref?.S,
        outcome: (item.outcome?.S || 'pending') as LedgerOutcome,
        buttondown_code: item.buttondown_code?.S,
        detail: item.detail?.S
      });
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return rows;
}
