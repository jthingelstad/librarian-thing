import nodeCrypto from 'node:crypto';
import { DeleteItemCommand, GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { dynamodb } from './aws-clients.mjs';
import { fetchSubscriber, subscriberStatus } from './buttondown.mjs';
import { clientSourceIp, userAgent } from './http.mjs';
import type { LibrarianHttpEvent } from './http.mjs';
import { sendMagicLinkEmail } from './jmap-mail.mjs';
import { errorFields, logEvent } from './logging.mjs';
import {
  buildMagicLink,
  createMagicCode,
  createMagicToken,
  magicCodeHash,
  magicLinkTtlSeconds,
  magicTokenHash
} from './magic-link.mjs';
import { checkRateLimit } from './rate-limit.mjs';
import { emailHash, normalizeEmail, stableHash } from './session.mjs';
import { dynamoNumber, dynamoString } from './user-conversations.mjs';
import { authProfile, getUserMemory } from './user-memory.mjs';

// Magic-link/code login machinery shared by the Thingy /auth actions and the
// OAuth /authorize flow. Extracted from auth/handler.mts so oauth-routes can
// reuse it without importing the handler (which would create an import cycle).

const MAGIC_LINK_RATE_LIMIT_MAX = 6;
export const MAGIC_CODE_MAX_ATTEMPTS = 5;

export type Subscriber = Awaited<ReturnType<typeof fetchSubscriber>>;

export type MagicSendResult = { status: 'rate_limited' } | { status: 'sent'; email: string; expiresAt: number };

export type MagicRedeemResult =
  | { status: 'link_invalid' }
  | { status: 'subscriber_unavailable' }
  | { status: 'not_active'; subscriberStatus: string }
  | { status: 'ok'; email: string; subscriber: Subscriber; subscriberStatus: string };

export type MagicCodeResult = MagicRedeemResult | { status: 'rate_limited' } | { status: 'code_invalid' };

function errorName(error: unknown) {
  return error instanceof Error ? error.constructor.name : 'Error';
}

export function clientIdentityHash(event: LibrarianHttpEvent) {
  return stableHash(`${clientSourceIp(event) || 'unknown'}\0${userAgent(event) || ''}`);
}

export function magicLinkBaseWithReturnPath(returnPath = '') {
  const raw = String(returnPath || '').trim();
  const safeReturnPath = raw && raw.startsWith('/') && !raw.startsWith('//') ? raw.slice(0, 500) : '/chat/';
  try {
    const base = new URL(process.env.THINGY_MAGIC_LINK_BASE_URL || 'https://thingy.thingelstad.com/');
    base.pathname = '/signin/';
    base.search = '';
    base.searchParams.set('return', safeReturnPath);
    base.hash = '';
    return base.toString();
  } catch {
    return undefined;
  }
}

async function storeMagicLink({
  token,
  email,
  source,
  event,
  subscriberStatusValue,
  nowSeconds,
  expiresAt
}: {
  token: string;
  email: string;
  source: string;
  event: LibrarianHttpEvent;
  subscriberStatusValue: string;
  nowSeconds: number;
  expiresAt: number;
}) {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME is required');
  const tokenHash = magicTokenHash(token);
  await dynamodb.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        pk: dynamoString(`magic#${tokenHash}`),
        sk: dynamoString('magic'),
        email: dynamoString(normalizeEmail(email)),
        email_hash: dynamoString(emailHash(email)),
        source: dynamoString(source),
        subscriber_status: dynamoString(subscriberStatusValue),
        client_hash: dynamoString(clientIdentityHash(event)),
        created_at: dynamoNumber(nowSeconds),
        expires_at: dynamoNumber(expiresAt),
        ttl: dynamoNumber(expiresAt)
      }
    })
  );
}

// Rate limit + magic row + pending-code row + email send. Returns a structured
// result so both the /auth JSON action and the OAuth authorize HTML flow can
// shape their own responses.
export async function sendLoginCodeEmail({
  email,
  subscriber,
  source,
  event,
  start,
  returnPath = ''
}: {
  email: string;
  subscriber: Subscriber;
  source: string;
  event: LibrarianHttpEvent;
  start: number;
  returnPath?: string;
}): Promise<MagicSendResult> {
  const hashedEmail = emailHash(email);
  const magicLimit = Number(process.env.THINGY_MAGIC_LINK_RATE_LIMIT_MAX || MAGIC_LINK_RATE_LIMIT_MAX);
  if (!(await checkRateLimit(`auth#magic:${hashedEmail}`, magicLimit))) {
    logEvent('warning', 'auth_magic_link_rate_limited', { email_hash: hashedEmail });
    return { status: 'rate_limited' };
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttlSeconds = magicLinkTtlSeconds();
  const expiresAt = nowSeconds + ttlSeconds;
  const token = createMagicToken();
  const link = buildMagicLink(token, magicLinkBaseWithReturnPath(returnPath));
  const status = subscriberStatus(subscriber);
  let memory = null;
  try {
    memory = await getUserMemory(hashedEmail);
  } catch (error) {
    logEvent('warning', 'auth_magic_link_memory_lookup_failed', errorFields(error, { email_hash: hashedEmail }));
  }
  const emailContext = {
    ...authProfile(memory),
    subscriber_status: status,
    source
  };
  const code = createMagicCode();
  await storeMagicLink({ token, email, source, event, subscriberStatusValue: status, nowSeconds, expiresAt });
  // The pending-code row lets the reader type the emailed code instead of
  // clicking the link. One per email (latest send wins); it references the
  // magic row so both paths redeem the same one-shot record.
  await dynamodb.send(
    new PutItemCommand({
      TableName: process.env.TABLE_NAME,
      Item: {
        pk: dynamoString(`magiccode#${hashedEmail}`),
        sk: dynamoString('magiccode'),
        code_hash: dynamoString(magicCodeHash(code)),
        token_hash: dynamoString(magicTokenHash(token)),
        attempts: dynamoNumber(0),
        created_at: dynamoNumber(nowSeconds),
        expires_at: dynamoNumber(expiresAt),
        ttl: dynamoNumber(expiresAt)
      }
    })
  );
  await sendMagicLinkEmail({
    to: normalizeEmail(email),
    magicLink: link,
    expiresMinutes: Math.max(1, Math.round(ttlSeconds / 60)),
    context: emailContext,
    code
  });
  logEvent('info', 'auth_magic_link_sent', {
    email_hash: hashedEmail,
    subscriber_status: status,
    returning: Boolean(emailContext.returning),
    has_preferred_name: Boolean(emailContext.preferred_name),
    expires_at: expiresAt,
    duration_ms: Math.round(performance.now() - start)
  });
  return { status: 'sent', email: normalizeEmail(email), expiresAt };
}

// Shared one-shot redemption used by the link (login_token), the emailed code
// (action verify_code), and the OAuth authorize code step - all burn the same
// magic row.
export async function redeemMagicRowByTokenHash(
  tokenHash: string,
  event: LibrarianHttpEvent
): Promise<MagicRedeemResult> {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME is required');
  const key = {
    pk: dynamoString(`magic#${tokenHash}`),
    sk: dynamoString('magic')
  };
  const loaded = await dynamodb.send(new GetItemCommand({ TableName: tableName, Key: key }));
  const item = loaded.Item || null;
  const email = normalizeEmail(item?.email?.S || '');
  const expiresAt = Number(item?.expires_at?.N || 0);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!item || !email || expiresAt < nowSeconds || item.used_at) {
    logEvent('info', 'auth_magic_link_rejected', {
      token_hash_prefix: tokenHash.slice(0, 10),
      reason: !item ? 'not_found' : expiresAt < nowSeconds ? 'expired' : 'used'
    });
    return { status: 'link_invalid' };
  }
  try {
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: key,
        UpdateExpression: 'SET #used_at = :used_at, #used_client_hash = :client_hash',
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#used_at) AND #expires_at >= :now',
        ExpressionAttributeNames: {
          '#used_at': 'used_at',
          '#used_client_hash': 'used_client_hash',
          '#expires_at': 'expires_at'
        },
        ExpressionAttributeValues: {
          ':used_at': dynamoNumber(nowSeconds),
          ':client_hash': dynamoString(clientIdentityHash(event)),
          ':now': dynamoNumber(nowSeconds)
        }
      })
    );
  } catch (error) {
    logEvent('info', 'auth_magic_link_redeem_race', {
      token_hash_prefix: tokenHash.slice(0, 10),
      error_type: errorName(error)
    });
    return { status: 'link_invalid' };
  }

  let subscriber;
  try {
    subscriber = await fetchSubscriber(email);
  } catch (error) {
    logEvent('error', 'auth_magic_link_buttondown_lookup_failed', {
      email_hash: emailHash(email),
      error_type: errorName(error)
    });
    return { status: 'subscriber_unavailable' };
  }
  const status = subscriberStatus(subscriber);
  if (status !== 'active' && status !== 'premium') {
    logEvent('info', 'auth_magic_link_subscriber_not_active', {
      email_hash: emailHash(email),
      subscriber_status: status
    });
    return { status: 'not_active', subscriberStatus: status };
  }
  return { status: 'ok', email, subscriber, subscriberStatus: status };
}

// Verify an emailed six-digit code against the pending magiccode row and, on a
// match, redeem the referenced magic row. Callers already validated the email
// and code formats.
export async function verifyPendingCode(
  email: string,
  code: string,
  event: LibrarianHttpEvent
): Promise<MagicCodeResult> {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME is required');
  const hashedEmail = emailHash(email);
  const codeLimit = Number(process.env.THINGY_MAGIC_LINK_RATE_LIMIT_MAX || MAGIC_LINK_RATE_LIMIT_MAX);
  if (!(await checkRateLimit(`auth#code:${hashedEmail}`, codeLimit * MAGIC_CODE_MAX_ATTEMPTS))) {
    logEvent('warning', 'auth_code_rate_limited', { email_hash: hashedEmail });
    return { status: 'rate_limited' };
  }
  const key = { pk: dynamoString(`magiccode#${hashedEmail}`), sk: dynamoString('magiccode') };
  const nowSeconds = Math.floor(Date.now() / 1000);
  let attempts = 0;
  try {
    // Count the attempt atomically BEFORE comparing, so parallel guesses
    // cannot dodge the cap.
    const bumped = await dynamodb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: key,
        UpdateExpression: 'ADD #attempts :one',
        ConditionExpression: 'attribute_exists(pk) AND #expires_at >= :now',
        ExpressionAttributeNames: { '#attempts': 'attempts', '#expires_at': 'expires_at' },
        ExpressionAttributeValues: { ':one': dynamoNumber(1), ':now': dynamoNumber(nowSeconds) },
        ReturnValues: 'ALL_NEW'
      })
    );
    attempts = Number(bumped.Attributes?.attempts?.N || 0);
    const storedCodeHash = String(bumped.Attributes?.code_hash?.S || '');
    const tokenHash = String(bumped.Attributes?.token_hash?.S || '');
    if (attempts > MAGIC_CODE_MAX_ATTEMPTS) {
      // Burn the record; a fresh email is required.
      await dynamodb.send(new DeleteItemCommand({ TableName: tableName, Key: key }));
      logEvent('warning', 'auth_code_attempts_exhausted', { email_hash: hashedEmail });
      return { status: 'code_invalid' };
    }
    const expected = Buffer.from(storedCodeHash, 'hex');
    const actual = Buffer.from(magicCodeHash(code), 'hex');
    if (expected.length !== actual.length || !nodeCrypto.timingSafeEqual(expected, actual)) {
      logEvent('info', 'auth_code_mismatch', { email_hash: hashedEmail, attempts });
      return { status: 'code_invalid' };
    }
    await dynamodb.send(new DeleteItemCommand({ TableName: tableName, Key: key }));
    logEvent('info', 'auth_code_verified', { email_hash: hashedEmail, attempts });
    return await redeemMagicRowByTokenHash(tokenHash, event);
  } catch (error) {
    logEvent('info', 'auth_code_rejected', {
      email_hash: hashedEmail,
      error_type: errorName(error)
    });
    return { status: 'code_invalid' };
  }
}
