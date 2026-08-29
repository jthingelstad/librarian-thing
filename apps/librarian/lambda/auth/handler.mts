import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { bedrock, dynamodb, agentModel, fastModel } from '../shared/aws-clients.mjs';
import {
  createSubscriber,
  ensureThingyTag,
  fetchSubscriber,
  sanitizeAttribution,
  sendSubscriberReminder,
  subscriberStatus
} from '../shared/buttondown.mjs';
import { eventSummary, jsonResponse, methodAndPath, parseBody } from '../shared/http.mjs';
import type { LibrarianHttpEvent, LibrarianHttpResponse } from '../shared/http.mjs';
import { magicTokenHash, validMagicCode, validMagicToken } from '../shared/magic-link.mjs';
import {
  clientIdentityHash,
  redeemMagicRowByTokenHash,
  sendLoginCodeEmail,
  verifyPendingCode
} from '../shared/magic-login.mjs';
import type { MagicRedeemResult, Subscriber } from '../shared/magic-login.mjs';
import { checkRateLimit } from '../shared/rate-limit.mjs';
import { chatDailyQuota, readDailyQuota, utcDayBucket } from '../shared/quota.mjs';
import {
  createSessionToken,
  createSessionTokenForSub,
  emailHash,
  extractBearer,
  normalizeEmail,
  verifyToken
} from '../shared/session.mjs';
import { authProfile, getUserMemory, recordUserPreferredName } from '../shared/user-memory.mjs';
import { deleteThingyProfile, sessionAllowedForThingyProfile } from '../shared/profile-deletion.mjs';
import {
  availableConversationModes,
  entitlementsForSubscriber,
  isOwnerSubscriberHash
} from '../shared/conversation-modes.mjs';
import { errorFields, logEvent } from '../shared/logging.mjs';
import { premiumThankYouSystemPrompt } from '../shared/prompts.mjs';
import { handleUserConversations } from './conversation-routes.mjs';
import { handleAuthorize, handleOauthMetadata, handleRegister, handleToken } from './oauth-routes.mjs';
import { loadUserConversationSummaries } from '../shared/conversation-store.mjs';
import { dynamoNumber, dynamoString } from '../shared/user-conversations.mjs';
import { LIBRARIAN_CONTRACT_VERSION, supportsRequestedContract } from '../shared/librarian-contract.mjs';

const AUTH_RATE_LIMIT_MAX = 30;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ALLOWED_SOURCES = new Set(['thingy', 'site', 'hero', 'mid1', 'mid2', 'footer', 'about', 'issue']);

type JsonRecord = Record<string, unknown>;

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function errorName(error: unknown) {
  return error instanceof Error ? error.constructor.name : 'Error';
}

function normalizeSource(value: unknown) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return 'site';
  return ALLOWED_SOURCES.has(raw) ? raw : 'site';
}

export { magicLinkBaseWithReturnPath } from '../shared/magic-login.mjs';

async function recordSession(sessionId: string, email: unknown, expiresAt: number) {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) return;
  const start = performance.now();
  await dynamodb.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        pk: dynamoString(`session#${sessionId}`),
        sk: dynamoString('session'),
        email_hash: dynamoString(emailHash(email)),
        expires_at: dynamoNumber(expiresAt),
        ttl: dynamoNumber(expiresAt)
      }
    })
  );
  logEvent('info', 'session_recorded', {
    email_hash: emailHash(email),
    duration_ms: Math.round(performance.now() - start)
  });
}

async function recordSessionForSub(sessionId: string, sub: unknown, expiresAt: number) {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) return;
  const start = performance.now();
  await dynamodb.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        pk: dynamoString(`session#${sessionId}`),
        sk: dynamoString('session'),
        email_hash: dynamoString(String(sub || '')),
        expires_at: dynamoNumber(expiresAt),
        ttl: dynamoNumber(expiresAt)
      }
    })
  );
  logEvent('info', 'session_refreshed_recorded', {
    subscriber_hash: sub,
    duration_ms: Math.round(performance.now() - start)
  });
}

function bedrockMessageText(message: unknown) {
  const content = objectValue(message).content;
  return (Array.isArray(content) ? content : [])
    .map((part) => String(objectValue(part).text || ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function generatePremiumThankYou() {
  const start = performance.now();
  const model = fastModel();
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: model,
      system: [{ text: premiumThankYouSystemPrompt() }, { cachePoint: { type: 'default' } }],
      messages: [{ role: 'user', content: [{ text: 'Generate a fresh thank-you under 28 words.' }] }],
      inferenceConfig: { maxTokens: 120, temperature: 0.7 }
    })
  );
  const text = bedrockMessageText(response.output?.message || {})
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > 220) throw new Error('Bedrock returned invalid premium thank-you');
  logEvent('info', 'premium_thank_you_generated', {
    model,
    duration_ms: Math.round(performance.now() - start),
    message_chars: text.length
  });
  return text;
}

async function authSuccessResponse(
  email: string,
  subscriber: Subscriber,
  source: string,
  event: LibrarianHttpEvent,
  start: number
) {
  const status = subscriberStatus(subscriber);
  const entitlements = entitlementsForSubscriber({ email, subscriber, status });
  const modes = availableConversationModes(entitlements);
  const { sessionId, expiresAt, token } = createSessionToken(email, undefined, { entitlements });
  await recordSession(sessionId, email, expiresAt);
  logEvent('info', 'auth_succeeded', {
    email_hash: emailHash(email),
    subscriber_status: status,
    entitlements,
    duration_ms: Math.round(performance.now() - start)
  });
  if (source === 'thingy') {
    // Best-effort: ensure the wt-thingy user tag is on this subscriber. Don't
    // block the auth response — a transient Buttondown error must not break login.
    ensureThingyTag(subscriber).catch(() => {
      /* swallowed; ensureThingyTag logs internally */
    });
  }
  const memory = await getUserMemory(emailHash(email));
  const payload: JsonRecord = {
    status,
    email: normalizeEmail(email),
    token,
    expires_at: expiresAt,
    entitlements,
    modes,
    profile: {
      ...authProfile(memory),
      entitlements,
      modes
    }
  };
  if (status === 'premium') {
    try {
      payload.message = await generatePremiumThankYou();
    } catch (error) {
      logEvent('warning', 'premium_thank_you_generation_failed', {
        email_hash: emailHash(email),
        error_type: errorName(error)
      });
      payload.message = 'Thanks for being a Weekly Thing Supporting Member!';
    }
  }
  return jsonResponse(200, payload, event);
}

export function entitlementsForSessionPayload(payload: JsonRecord, nowSeconds = Math.floor(Date.now() / 1000)) {
  const entitlementsFresh = Number(payload?.entitlements_verified_until || 0) > nowSeconds;
  const entitlements = new Set<string>(
    entitlementsFresh && Array.isArray(payload.entitlements) ? payload.entitlements.map(String) : ['reader']
  );
  if (isOwnerSubscriberHash(payload?.sub)) {
    entitlements.add('owner');
    entitlements.add('supporting_member');
    entitlements.add('trusted_circle');
  }
  if (!entitlements.size) entitlements.add('reader');
  return Array.from(entitlements);
}

async function refreshSession(event: LibrarianHttpEvent, body: JsonRecord, start: number) {
  const bearer = extractBearer(event, body);
  const payload = verifyToken(bearer);
  if (!payload?.sub || !(await sessionAllowedForThingyProfile(payload))) {
    logEvent('info', 'auth_refresh_rejected');
    return jsonResponse(401, { error: 'Sign in again to continue.' }, event);
  }
  const entitlements = entitlementsForSessionPayload(payload);
  const modes = availableConversationModes(entitlements);
  const verifiedUntil = Number(payload.entitlements_verified_until || 0);
  const claims =
    verifiedUntil > Math.floor(Date.now() / 1000)
      ? { entitlements, entitlements_verified_until: verifiedUntil }
      : { entitlements };
  const subscriberHash = String(payload.sub);
  const { sessionId, expiresAt, token } = createSessionTokenForSub(subscriberHash, undefined, claims);
  await recordSessionForSub(sessionId, payload.sub, expiresAt);
  const memory = await getUserMemory(payload.sub);
  logEvent('info', 'auth_refreshed', {
    subscriber_hash: payload.sub,
    entitlements,
    duration_ms: Math.round(performance.now() - start)
  });
  return jsonResponse(
    200,
    {
      status: 'refreshed',
      token,
      expires_at: expiresAt,
      entitlements,
      modes,
      profile: {
        ...authProfile(memory),
        entitlements,
        modes
      }
    },
    event
  );
}

async function updateProfile(event: LibrarianHttpEvent, body: JsonRecord, start: number) {
  const payload = verifyToken(extractBearer(event, body));
  if (!payload?.sub || !(await sessionAllowedForThingyProfile(payload))) {
    logEvent('info', 'auth_update_profile_rejected');
    return jsonResponse(401, { error: 'Sign in again to continue.' }, event);
  }
  const preferredName = String(body.preferred_name || body.name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  if (!/^[a-z][a-z .'’-]{0,78}$/i.test(preferredName)) {
    return jsonResponse(400, { error: 'Enter a name Thingy should use.' }, event);
  }
  const blocked = new Set(['hello', 'hi', 'hey', 'there', 'thingy', 'thanks', 'thank', 'yes', 'no', 'ok', 'okay']);
  if (preferredName.split(/\s+/).some((word) => blocked.has(word.toLowerCase()))) {
    return jsonResponse(400, { error: 'Enter a name Thingy should use.' }, event);
  }
  const write = await recordUserPreferredName(payload.sub, preferredName);
  if (!write?.ok) {
    logEvent('warning', 'auth_profile_update_failed', {
      subscriber_hash: payload.sub,
      error: write?.error || 'unknown',
      duration_ms: Math.round(performance.now() - start)
    });
    return jsonResponse(500, { error: 'Thingy could not save that name right now. Please try again.' }, event);
  }
  const memory = write.memory || (await getUserMemory(payload.sub));
  const entitlements = entitlementsForSessionPayload(payload);
  const modes = availableConversationModes(entitlements);
  logEvent('info', 'auth_profile_updated', {
    subscriber_hash: payload.sub,
    has_preferred_name: Boolean(preferredName),
    duration_ms: Math.round(performance.now() - start)
  });
  return jsonResponse(
    200,
    {
      status: 'updated',
      entitlements,
      modes,
      profile: {
        ...authProfile(memory),
        preferred_name: memory?.preferred_name || preferredName,
        entitlements,
        modes
      }
    },
    event
  );
}

async function memoryAccountConversations(sub: string) {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) return [];
  return await loadUserConversationSummaries({
    dynamodb,
    tableName,
    subscriberHash: sub,
    limit: 50,
    logEvent
  });
}

async function dailyQuotaOverview(sub: string) {
  const unlimited = isOwnerSubscriberHash(sub);
  const chat = unlimited ? null : await readDailyQuota('chat', sub);
  return {
    day: utcDayBucket(),
    unlimited,
    chat_used: chat?.count ?? 0,
    chat_max: unlimited ? null : chatDailyQuota()
  };
}

async function memoryProfileResponse(sub: string, event: LibrarianHttpEvent, extra: JsonRecord = {}) {
  const memory = await getUserMemory(sub, { consistent: true });
  const conversations = await memoryAccountConversations(sub);
  const conversationDates = conversations
    .flatMap((conversation) => [conversation.created_at, conversation.updated_at, conversation.last_message_at])
    .filter(Boolean)
    .sort();
  const profile = authProfile(memory);
  const account = {
    first_seen_at: memory?.first_seen_at || '',
    last_seen_at: memory?.last_seen_at || '',
    memory_turn_count: Number(memory?.turn_count || 0),
    conversation_count: conversations.length,
    conversation_turn_count: conversations.reduce((sum, conversation) => sum + Number(conversation.turn_count || 0), 0),
    activity_summary: {
      memory_turn_count: Number(memory?.turn_count || 0),
      conversation_count: conversations.length,
      conversation_turn_count: conversations.reduce(
        (sum, conversation) => sum + Number(conversation.turn_count || 0),
        0
      )
    },
    oldest_conversation_at: conversationDates[0] || '',
    newest_conversation_at: conversationDates.at(-1) || '',
    // Per-user daily budget pools, surfaced in the account panel. Additive
    // contract field; the MCP pool joins in Phase 3.
    quota: await dailyQuotaOverview(sub)
  };
  return jsonResponse(200, { status: 'ok', profile, account, ...extra }, event);
}

async function handleMemory(event: LibrarianHttpEvent, body: JsonRecord, start: number) {
  const payload = verifyToken(extractBearer(event, body));
  if (!payload?.sub || !(await sessionAllowedForThingyProfile(payload))) {
    logEvent('info', 'memory_action_rejected');
    return jsonResponse(401, { error: 'Sign in again to continue.' }, event);
  }
  const action = String(body.action || 'get')
    .trim()
    .toLowerCase();
  if (action === 'get') {
    return await memoryProfileResponse(String(payload.sub), event);
  }
  if (action === 'refresh_profile') {
    // No-op kept so web clients deployed before the synthesized-memory
    // removal get a normal profile back instead of an error.
    return await memoryProfileResponse(String(payload.sub), event, { refreshed: false });
  }
  if (action === 'delete_profile') {
    const result = await deleteThingyProfile(payload.sub);
    if (!result.ok)
      return jsonResponse(500, { error: result.error || 'Thingy could not delete this profile right now.' }, event);
    logEvent('info', 'thingy_profile_delete_requested', {
      subscriber_hash: payload.sub,
      duration_ms: Math.round(performance.now() - start)
    });
    return jsonResponse(200, { status: 'deleted', ok: true, deleted_at: result.deleted_at }, event);
  }
  return jsonResponse(400, { error: 'Unsupported memory action.' }, event);
}

async function sendLoginMagicLink({
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
}) {
  const result = await sendLoginCodeEmail({ email, subscriber, source, event, start, returnPath });
  if (result.status === 'rate_limited') {
    return jsonResponse(429, { error: 'Too many sign-in emails. Please wait a bit and try again.' }, event);
  }
  return jsonResponse(
    200,
    {
      status: 'magic_link_sent',
      email: result.email,
      expires_at: result.expiresAt,
      message: 'Check your email for a sign-in link to Thingy.'
    },
    event
  );
}

// Map a shared magic redemption result onto the /auth JSON contract.
async function magicRedeemResponse(result: MagicRedeemResult, event: LibrarianHttpEvent, start: number) {
  if (result.status === 'ok') {
    return authSuccessResponse(result.email, result.subscriber, 'thingy', event, start);
  }
  if (result.status === 'subscriber_unavailable') {
    return jsonResponse(502, { error: 'Could not validate subscriber status right now.' }, event);
  }
  if (result.status === 'not_active') {
    return jsonResponse(403, { status: result.subscriberStatus, error: 'That subscription is not active.' }, event);
  }
  return jsonResponse(400, { status: 'magic_link_invalid', error: 'That sign-in link is invalid or expired.' }, event);
}

async function completeMagicLink(event: LibrarianHttpEvent, body: JsonRecord, start: number) {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) return jsonResponse(500, { error: 'Thingy sign-in is unavailable right now.' }, event);
  const token = validMagicToken(body.login_token || body.magic_token || body.token);
  if (!token) {
    logEvent('info', 'auth_magic_link_invalid_token');
    return jsonResponse(
      400,
      { status: 'magic_link_invalid', error: 'That sign-in link is invalid or expired.' },
      event
    );
  }
  return magicRedeemResponse(await redeemMagicRowByTokenHash(magicTokenHash(token), event), event, start);
}

async function verifyMagicCode(event: LibrarianHttpEvent, body: JsonRecord, start: number) {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) return jsonResponse(500, { error: 'Thingy sign-in is unavailable right now.' }, event);
  const email = normalizeEmail(body.email);
  const code = validMagicCode(body.code);
  const rejected = jsonResponse(
    400,
    {
      status: 'code_invalid',
      error: 'That code is not right or has expired. Check the newest email or request a fresh one.'
    },
    event
  );
  if (!email || !code) return rejected;
  const result = await verifyPendingCode(email, code, event);
  if (result.status === 'rate_limited') {
    return jsonResponse(429, { error: 'Too many code attempts. Please wait a bit and try again.' }, event);
  }
  if (result.status === 'code_invalid') return rejected;
  return magicRedeemResponse(result, event, start);
}

async function authHandler(event: LibrarianHttpEvent) {
  const start = performance.now();
  const body = parseBody(event);
  const email = normalizeEmail(body.email);
  const action = String(body.action || 'check')
    .trim()
    .toLowerCase();
  const source = normalizeSource(body.source);
  const attribution = sanitizeAttribution(body.attribution);
  const hashedEmail = email ? emailHash(email) : undefined;

  const authLimit = Number(process.env.AUTH_RATE_LIMIT_MAX || AUTH_RATE_LIMIT_MAX);
  if (!(await checkRateLimit(`auth#${clientIdentityHash(event)}`, authLimit))) {
    logEvent('warning', 'auth_rate_limited', { email_hash: hashedEmail });
    return jsonResponse(429, { error: 'Too many access attempts. Please try again later.' }, event);
  }
  if (
    ![
      'check',
      'subscribe',
      'resend_confirmation',
      'complete_magic_link',
      'verify_code',
      'refresh_session',
      'update_profile'
    ].includes(action)
  ) {
    logEvent('info', 'auth_rejected_invalid_action', { email_hash: hashedEmail, action });
    return jsonResponse(400, { error: 'Unsupported subscriber action.' }, event);
  }

  if (action === 'verify_code') {
    return verifyMagicCode(event, body, start);
  }
  if (action === 'complete_magic_link') {
    return await completeMagicLink(event, body, start);
  }

  if (action === 'refresh_session') {
    return await refreshSession(event, body, start);
  }

  if (action === 'update_profile') {
    return await updateProfile(event, body, start);
  }

  if (!EMAIL_RE.test(email)) {
    logEvent('info', 'auth_rejected_invalid_email', { email_hash: hashedEmail });
    return jsonResponse(400, { error: 'Enter a valid email address.' }, event);
  }

  if (action === 'subscribe') {
    try {
      const subscriber = await createSubscriber(email, event, source, attribution);
      const status = subscriberStatus(subscriber);
      logEvent('info', 'auth_subscribe_completed', {
        email_hash: hashedEmail,
        subscriber_status: status,
        subscriber_source: source,
        campaign_ref: attribution?.ref || null
      });
      return jsonResponse(
        200,
        {
          status: 'subscribed',
          subscriber_status: status,
          message: 'Check your inbox to confirm your subscription.'
        },
        event
      );
    } catch (error) {
      logEvent('error', 'buttondown_subscriber_create_failed', {
        email_hash: hashedEmail,
        subscriber_source: source,
        error_type: errorName(error)
      });
      return jsonResponse(502, { error: 'Could not add that email right now.' }, event);
    }
  }

  if (action === 'resend_confirmation') {
    try {
      await sendSubscriberReminder(email);
      return jsonResponse(
        200,
        { status: 'reminder_sent', message: 'Confirmation email sent. Check your inbox.' },
        event
      );
    } catch (error) {
      logEvent('error', 'buttondown_subscriber_reminder_failed', {
        email_hash: hashedEmail,
        error_type: errorName(error)
      });
      return jsonResponse(
        502,
        {
          status: 'reminder_unavailable',
          error: 'Could not resend the confirmation email right now. Please look for the original confirmation email.'
        },
        event
      );
    }
  }

  let subscriber;
  try {
    subscriber = await fetchSubscriber(email);
  } catch (error) {
    logEvent('error', 'buttondown_lookup_failed', { email_hash: hashedEmail, error_type: errorName(error) });
    return jsonResponse(502, { error: 'Could not validate subscriber status right now.' }, event);
  }

  const status = subscriberStatus(subscriber);
  if (status === 'not_found') {
    logEvent('info', 'auth_subscriber_not_found', { email_hash: hashedEmail });
    return jsonResponse(200, { status, message: 'That email is not subscribed. Would you like to be added?' }, event);
  }
  if (status === 'unconfirmed') {
    logEvent('info', 'auth_subscriber_unconfirmed', { email_hash: hashedEmail });
    return jsonResponse(200, { status, message: 'Please confirm your email before using Thingy.' }, event);
  }
  if (status === 'inactive') {
    logEvent('info', 'auth_subscriber_inactive', { email_hash: hashedEmail });
    return jsonResponse(403, { status, error: 'That subscription is not active.' }, event);
  }
  try {
    return await sendLoginMagicLink({
      email,
      subscriber,
      source,
      event,
      start,
      returnPath: String(body.return_path || '')
    });
  } catch (error) {
    logEvent('error', 'auth_magic_link_send_failed', errorFields(error, { email_hash: hashedEmail }));
    return jsonResponse(502, { error: 'Could not send a sign-in email right now.' }, event);
  }
}

function healthHandler(event: LibrarianHttpEvent) {
  return jsonResponse(
    200,
    {
      ok: true,
      service: 'weekly-thing-librarian-auth',
      model: agentModel(),
      contract_version: LIBRARIAN_CONTRACT_VERSION
    },
    event
  );
}

export async function handler(event: LibrarianHttpEvent, context: { awsRequestId?: string } = {}) {
  const start = performance.now();
  const summary = eventSummary(event, context);
  logEvent('info', 'request_started', summary, 'weekly-thing-librarian-auth');
  let response: LibrarianHttpResponse;
  try {
    const { method, path } = methodAndPath(event);
    if (!supportsRequestedContract(event.headers || {})) {
      response = jsonResponse(
        409,
        {
          error: 'This Thingy client uses an unsupported Librarian contract version.',
          contract_version: LIBRARIAN_CONTRACT_VERSION
        },
        event
      );
    } else if (method === 'OPTIONS') {
      response = jsonResponse(204, {}, event);
    } else if (method === 'GET' && path.endsWith('/health')) {
      response = healthHandler(event);
    } else if (method === 'POST' && path.endsWith('/auth')) {
      response = await authHandler(event);
    } else if (method === 'POST' && path.endsWith('/memory')) {
      response = await handleMemory(event, parseBody(event), start);
    } else if (method === 'POST' && path.endsWith('/conversations')) {
      response = await handleUserConversations(event, parseBody(event), { start, entitlementsForSessionPayload });
    } else if (method === 'GET' && path.endsWith('/.well-known/oauth-authorization-server')) {
      response = handleOauthMetadata(event);
    } else if (method === 'GET' && path.endsWith('/.well-known/oauth-protected-resource')) {
      response = handleOauthMetadata(event);
    } else if (method === 'POST' && path.endsWith('/register')) {
      response = await handleRegister(event);
    } else if (method === 'POST' && path.endsWith('/token')) {
      response = await handleToken(event);
    } else if ((method === 'GET' || method === 'POST') && path.endsWith('/authorize')) {
      response = await handleAuthorize(event, start);
    } else {
      response = jsonResponse(404, { error: 'Not found.' }, event);
    }
  } catch (error) {
    logEvent('error', 'request_failed', errorFields(error, summary), 'weekly-thing-librarian-auth');
    response = jsonResponse(500, { error: 'Thingy is unavailable right now.' }, event);
  }
  response.headers = { ...(response.headers || {}), 'x-request-id': summary.request_id || '' };
  logEvent(
    'info',
    'request_completed',
    {
      ...summary,
      status_code: response.statusCode,
      duration_ms: Math.round(performance.now() - start)
    },
    'weekly-thing-librarian-auth'
  );
  return response;
}
