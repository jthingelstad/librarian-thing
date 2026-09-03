import crypto from 'node:crypto';
import { BatchWriteItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue, QueryCommandOutput, WriteRequest } from '@aws-sdk/client-dynamodb';
import { dynamodb } from '../shared/aws-clients.mjs';
import { clientSourceIp, jsonResponse } from '../shared/http.mjs';
import type { LibrarianHttpEvent } from '../shared/http.mjs';
import { verifyToken } from '../shared/session.mjs';
import { resolveSessionToken } from '../shared/web-session.mjs';
import { sessionAllowedForThingyProfile } from '../shared/profile-deletion.mjs';
import { logEvent } from '../shared/logging.mjs';
import { conversationTtlSeconds } from '../shared/retention.mjs';
import {
  availableConversationModes,
  canUseConversationMode,
  normalizeConversationMode
} from '../shared/conversation-modes.mjs';
import { checkRateLimit } from '../shared/rate-limit.mjs';
import {
  deleteShare,
  generateShareToken,
  getShare,
  putShare,
  shareRowKey,
  shareUrl,
  validShareToken
} from '../shared/share-store.mjs';
import {
  createUserConversation,
  getUserConversation,
  getUserConversationMetadata,
  renameUserConversation,
  searchUserConversationTurns,
  listUserConversationPage,
  fetchAllConversationSummaries
} from '../shared/conversation-store.mjs';
import {
  USER_CONVERSATION_LIMIT,
  conversationSk,
  dynamoString as conversationDynamoString,
  turnSkPrefix,
  userConversationPk,
  validConversationId
} from '../shared/user-conversations.mjs';

type RequestBody = Record<string, unknown>;
type Claims = Record<string, unknown>;

interface ConversationRouteOptions {
  start?: number;
  entitlementsForSessionPayload: (payload: Claims) => readonly unknown[];
}

// Hourly caps: creation is per subscriber, viewing is per source IP (the
// viewer is anonymous). Both ride the generic rate#... counter rows.
const SHARE_CREATE_HOURLY_LIMIT = 20;
const SHARE_VIEW_HOURLY_LIMIT = 120;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function batchDeleteKeys(tableName: string, keys: Array<Record<string, AttributeValue>>, maxAttempts = 5) {
  let deleted = 0;
  for (let index = 0; index < keys.length; index += 25) {
    let requests: WriteRequest[] = keys.slice(index, index + 25).map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 1; requests.length && attempt <= maxAttempts; attempt += 1) {
      const response = await dynamodb.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [tableName]: requests
          }
        })
      );
      const unprocessed = response.UnprocessedItems?.[tableName] || [];
      deleted += requests.length - unprocessed.length;
      requests = unprocessed;
      if (requests.length && attempt < maxAttempts) {
        await sleep(50 * 2 ** (attempt - 1));
      }
    }
    if (requests.length) {
      throw new Error(`DynamoDB left ${requests.length} delete request(s) unprocessed`);
    }
  }
  return deleted;
}

async function collectConversationKeys(tableName: string, subscriberHash: string, conversationId: string) {
  const keys: Array<Record<string, AttributeValue>> = [
    {
      pk: conversationDynamoString(userConversationPk(subscriberHash)),
      sk: conversationDynamoString(conversationSk(conversationId))
    }
  ];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const response: QueryCommandOutput = await dynamodb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
        ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: {
          ':pk': conversationDynamoString(userConversationPk(subscriberHash)),
          ':prefix': conversationDynamoString(turnSkPrefix(conversationId))
        },
        ExclusiveStartKey: exclusiveStartKey,
        ProjectionExpression: 'pk, sk'
      })
    );
    for (const item of response.Items || []) keys.push({ pk: item.pk, sk: item.sk });
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return keys;
}

// Sharing pins the conversation: a link that outlives the 45-day retention
// cadence must keep its rows alive. Bounded by the turn cap, so a plain
// per-key update loop is fine.
async function restampConversationTtl(
  tableName: string,
  subscriberHash: string,
  conversationId: string,
  ttlSeconds: number
) {
  const keys = await collectConversationKeys(tableName, subscriberHash, conversationId);
  for (const Key of keys) {
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key,
        UpdateExpression: 'SET #ttl = :ttl',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':ttl': { N: String(ttlSeconds) } }
      })
    );
  }
  return keys.length;
}

async function conversationAuth(event: LibrarianHttpEvent, body: RequestBody) {
  const payload = verifyToken(resolveSessionToken(event, body).token);
  if (!payload || !(await sessionAllowedForThingyProfile(payload))) return null;
  return payload;
}

function conversationTableUnavailable(event: LibrarianHttpEvent) {
  return jsonResponse(500, { error: 'Thingy conversation history is unavailable right now.' }, event);
}

export async function handleUserConversations(
  event: LibrarianHttpEvent,
  body: RequestBody,
  { start = performance.now(), entitlementsForSessionPayload }: ConversationRouteOptions
) {
  const payload = await conversationAuth(event, body);
  if (!payload) {
    return jsonResponse(
      401,
      { error: 'That needs a signed-in reader - sign in free at thingy.thingelstad.com.' },
      event
    );
  }
  const subscriberHash = String(payload.sub || '');
  if (!subscriberHash)
    return jsonResponse(
      401,
      { error: 'That needs a signed-in reader - sign in free at thingy.thingelstad.com.' },
      event
    );
  const entitlements = entitlementsForSessionPayload(payload);
  const modes = availableConversationModes(entitlements);
  const tableName = process.env.TABLE_NAME;
  if (!tableName) return conversationTableUnavailable(event);

  const action = String(body.action || 'list')
    .trim()
    .toLowerCase();
  try {
    if (action === 'list') {
      const { conversations, total } = await listUserConversationPage({
        dynamodb,
        tableName,
        subscriberHash,
        limit: Number(body.limit || USER_CONVERSATION_LIMIT),
        offset: Number(body.offset || 0),
        logEvent
      });
      logEvent('info', 'user_conversations_listed', {
        subscriber_hash: subscriberHash,
        count: conversations.length,
        total,
        offset: Number(body.offset || 0),
        duration_ms: Math.round(performance.now() - start)
      });
      return jsonResponse(200, { conversations, total, entitlements, modes }, event);
    }

    if (action === 'search') {
      const query = String(body.query || '').trim();
      if (query.length < 2) return jsonResponse(400, { error: 'query must be at least 2 characters.' }, event);
      const rawMatches = await searchUserConversationTurns({
        dynamodb,
        tableName,
        subscriberHash,
        query: query.slice(0, 120),
        logEvent
      });
      // Join titles/dates from the conversation rows so matches outside
      // the rail's loaded window are still presentable (and prune matches
      // whose conversation has since been deleted).
      const allSummaries = new Map(
        (await fetchAllConversationSummaries({ dynamodb, tableName, subscriberHash, logEvent })).map((entry) => [
          String(entry.conversation_id || entry.id || ''),
          entry
        ])
      );
      const matches = rawMatches
        .map((match) => {
          const summary = allSummaries.get(match.conversation_id);
          if (!summary) return null;
          return {
            ...match,
            title: String(summary.title || 'Untitled chat'),
            updated_at: String(summary.updated_at || '')
          };
        })
        .filter((match): match is NonNullable<typeof match> => match !== null);
      // Titles are searchable too: a reader searching the exact name they
      // gave a conversation found nothing when the words never appeared in
      // its turns (QA round 2). Content matches keep their snippets; title
      // matches ride along with the title itself as the snippet.
      const needle = query.slice(0, 120).toLowerCase();
      const matchedIds = new Set(matches.map((match) => match.conversation_id));
      for (const [conversationId, summary] of allSummaries) {
        if (matchedIds.has(conversationId)) continue;
        const title = String(summary.title || '');
        if (!title.toLowerCase().includes(needle)) continue;
        matches.push({
          conversation_id: conversationId,
          snippet: title,
          title,
          updated_at: String(summary.updated_at || '')
        });
        if (matches.length >= 30) break;
      }
      logEvent('info', 'user_conversations_searched', {
        subscriber_hash: subscriberHash,
        match_count: matches.length,
        duration_ms: Math.round(performance.now() - start)
      });
      return jsonResponse(200, { matches }, event);
    }

    if (action === 'get') {
      const conversationId = validConversationId(body.conversation_id || body.id);
      if (!conversationId) return jsonResponse(400, { error: 'conversation_id is required.' }, event);
      const result = await getUserConversation({
        dynamodb,
        tableName,
        subscriberHash,
        conversationId,
        limit: body.limit === undefined ? undefined : Number(body.limit)
      });
      if (!result) return jsonResponse(404, { error: 'Conversation not found.' }, event);
      return jsonResponse(200, result, event);
    }

    if (action === 'create') {
      const mode = normalizeConversationMode(body.mode);
      if (!canUseConversationMode(mode, entitlements)) {
        return jsonResponse(403, { error: 'That Thingy mode is not available for this account.' }, event);
      }
      const conversationId = crypto.randomUUID();
      const conversation = await createUserConversation({
        dynamodb,
        tableName,
        subscriberHash,
        conversationId,
        title: body.title || body.message || '',
        preview: body.message || body.title || '',
        scope: body.scope || 'all',
        mode
      });
      return jsonResponse(200, { conversation }, event);
    }

    if (action === 'rename') {
      const conversationId = validConversationId(body.conversation_id || body.id);
      if (!conversationId) return jsonResponse(400, { error: 'conversation_id is required.' }, event);
      const conversation = await renameUserConversation({
        dynamodb,
        tableName,
        subscriberHash,
        conversationId,
        title: body.title
      });
      return jsonResponse(200, { conversation }, event);
    }

    if (action === 'share') {
      const conversationId = validConversationId(body.conversation_id || body.id);
      if (!conversationId) return jsonResponse(400, { error: 'conversation_id is required.' }, event);
      const metadata = await getUserConversationMetadata({ dynamodb, tableName, subscriberHash, conversationId });
      if (!metadata) return jsonResponse(404, { error: 'Conversation not found.' }, event);
      if (!(await checkRateLimit(`sharecreate#${subscriberHash}`, SHARE_CREATE_HOURLY_LIMIT))) {
        return jsonResponse(429, { error: 'Too many share links created; try again in an hour.' }, event);
      }
      // Re-sharing keeps the URL and advances the cutoff; the plaintext
      // token lives only on the owner's conversation row for that reason.
      const existingToken = validShareToken((metadata as Record<string, unknown>).share_token);
      const token = existingToken || generateShareToken();
      const now = new Date();
      const sharedUpTo = now.toISOString();
      const sharedAt = existingToken
        ? String((metadata as Record<string, unknown>).shared_at || sharedUpTo)
        : sharedUpTo;
      const expiresAt = await putShare({ token, subscriberHash, conversationId, sharedUpTo, now });
      await dynamodb.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: {
            pk: conversationDynamoString(userConversationPk(subscriberHash)),
            sk: conversationDynamoString(conversationSk(conversationId))
          },
          ConditionExpression: 'attribute_exists(pk)',
          UpdateExpression:
            'SET #share_token = :share_token, #shared_at = :shared_at, #shared_up_to = :shared_up_to, #ttl_floor = :expires, #ttl = :expires',
          ExpressionAttributeNames: {
            '#share_token': 'share_token',
            '#shared_at': 'shared_at',
            '#shared_up_to': 'shared_up_to',
            '#ttl_floor': 'ttl_floor',
            '#ttl': 'ttl'
          },
          ExpressionAttributeValues: {
            ':share_token': conversationDynamoString(token),
            ':shared_at': conversationDynamoString(sharedAt),
            ':shared_up_to': conversationDynamoString(sharedUpTo),
            ':expires': { N: String(expiresAt) }
          }
        })
      );
      await restampConversationTtl(tableName, subscriberHash, conversationId, expiresAt);
      // Log the minted BASE (never the token): the /signin/c/<token>
      // regression shipped invisibly because nothing recorded what URL
      // shape share responses carried (observability gap 4).
      const shareBase = shareUrl(token).split('/c/')[0];
      if (shareBase !== 'https://thingy.thingelstad.com') {
        logEvent('warning', 'share_url_unexpected_base', { subscriber_hash: subscriberHash, share_base: shareBase });
      }
      logEvent('info', 'share_link_created', {
        subscriber_hash: subscriberHash,
        conversation_id: conversationId,
        refreshed: Boolean(existingToken),
        share_base: shareBase,
        duration_ms: Math.round(performance.now() - start)
      });
      return jsonResponse(
        200,
        {
          share: {
            token,
            url: shareUrl(token),
            shared_at: sharedAt,
            shared_up_to: sharedUpTo,
            expires_at: new Date(expiresAt * 1000).toISOString()
          }
        },
        event
      );
    }

    if (action === 'unshare') {
      const conversationId = validConversationId(body.conversation_id || body.id);
      if (!conversationId) return jsonResponse(400, { error: 'conversation_id is required.' }, event);
      const metadata = await getUserConversationMetadata({ dynamodb, tableName, subscriberHash, conversationId });
      if (!metadata) return jsonResponse(404, { error: 'Conversation not found.' }, event);
      const token = validShareToken((metadata as Record<string, unknown>).share_token);
      if (token) await deleteShare(token);
      await dynamodb.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: {
            pk: conversationDynamoString(userConversationPk(subscriberHash)),
            sk: conversationDynamoString(conversationSk(conversationId))
          },
          ConditionExpression: 'attribute_exists(pk)',
          UpdateExpression: 'REMOVE #share_token, #shared_at, #shared_up_to, #ttl_floor SET #ttl = :ttl',
          ExpressionAttributeNames: {
            '#share_token': 'share_token',
            '#shared_at': 'shared_at',
            '#shared_up_to': 'shared_up_to',
            '#ttl_floor': 'ttl_floor',
            '#ttl': 'ttl'
          },
          ExpressionAttributeValues: {
            ':ttl': { N: String(conversationTtlSeconds(new Date().toISOString())) }
          }
        })
      );
      // Sharing pinned every row to a one-year TTL; revocation restores
      // the normal retention cadence (conversation row above, turn rows
      // here) instead of leaving unshared content stored for a year.
      await restampConversationTtl(
        tableName,
        subscriberHash,
        conversationId,
        conversationTtlSeconds(new Date().toISOString())
      );
      logEvent('info', 'share_link_revoked', {
        subscriber_hash: subscriberHash,
        conversation_id: conversationId,
        had_share: Boolean(token),
        duration_ms: Math.round(performance.now() - start)
      });
      return jsonResponse(200, { ok: true }, event);
    }

    if (action === 'delete' || action === 'trash') {
      const conversationId = validConversationId(body.conversation_id || body.id);
      if (!conversationId) return jsonResponse(400, { error: 'conversation_id is required.' }, event);
      // A deleted conversation must take its share link with it.
      const metadata = await getUserConversationMetadata({ dynamodb, tableName, subscriberHash, conversationId });
      const shareToken = validShareToken((metadata as Record<string, unknown> | null)?.share_token);
      const keys = await collectConversationKeys(tableName, subscriberHash, conversationId);
      if (shareToken) keys.push(shareRowKey(shareToken));

      const deletedItems = await batchDeleteKeys(tableName, keys);
      logEvent('info', 'user_conversation_deleted', {
        subscriber_hash: subscriberHash,
        conversation_id: conversationId,
        deleted_items: deletedItems,
        duration_ms: Math.round(performance.now() - start)
      });
      return jsonResponse(200, { ok: true, conversation_id: conversationId, deleted_items: deletedItems }, event);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return jsonResponse(404, { error: 'Conversation not found.' }, event);
    }
    logEvent('error', 'user_conversations_action_failed', {
      subscriber_hash: subscriberHash,
      action,
      error_type: error instanceof Error ? error.constructor.name : 'Error'
    });
    return jsonResponse(502, { error: 'Thingy could not update conversations right now.' }, event);
  }

  return jsonResponse(400, { error: 'Unsupported conversation action.' }, event);
}

function shareNotFound(event: LibrarianHttpEvent) {
  return jsonResponse(404, { error: 'This shared conversation has been closed up.' }, event);
}

// Public, unauthenticated: GET /share/{token}. Returns a read-only snapshot
// bounded by the share's cutoff, stripped to what the shared page renders.
// Everything else on the turn (feedback, eval fields, tool traces, request
// ids) stays private.
export async function handleSharedConversationView(
  event: LibrarianHttpEvent,
  token: string,
  start = performance.now()
) {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) return conversationTableUnavailable(event);
  const validToken = validShareToken(token);
  if (!validToken) return shareNotFound(event);
  if (!(await checkRateLimit(`shareview#${clientSourceIp(event)}`, SHARE_VIEW_HOURLY_LIMIT))) {
    return jsonResponse(429, { error: 'Too many requests; try again shortly.' }, event);
  }
  try {
    const share = await getShare(validToken);
    if (!share) return shareNotFound(event);
    // The owner viewing their own share link gets a pointer back to the
    // real conversation (the client offers "open the original" instead of
    // forking a copy). Anyone else gets the public snapshot only.
    let owner = false;
    try {
      const sessionPayload = verifyToken(resolveSessionToken(event, {}).token);
      owner = Boolean(
        sessionPayload &&
        String(sessionPayload.sub || '') === share.subscriberHash &&
        // Every authenticated route applies the deleted-profile gate; a
        // session for a deleted profile is signed out everywhere else
        // and must not resolve as the owner here either.
        (await sessionAllowedForThingyProfile(sessionPayload))
      );
    } catch {
      owner = false;
    }
    const result = await getUserConversation({
      dynamodb,
      tableName,
      subscriberHash: share.subscriberHash,
      conversationId: share.conversationId,
      // Shared pages show one line of conversation - the active branch AS
      // OF the share (createdUpTo), so a later root regenerate in the
      // original does not empty the public transcript (QA F02).
      chainOnly: true,
      createdUpTo: share.sharedUpTo
    });
    if (!result) return shareNotFound(event);
    const messages = (result.messages || [])
      .filter(
        (message) =>
          String(message.content || '').trim() &&
          String(message.created_at || '') &&
          String(message.created_at) <= share.sharedUpTo
      )
      .map((message) =>
        message.role === 'assistant'
          ? {
              role: 'assistant',
              content: String(message.content || ''),
              citations: Array.isArray(message.citations) ? message.citations : [],
              created_at: String(message.created_at || ''),
              ...(Number(message.duration_ms) > 0 ? { duration_ms: Number(message.duration_ms) } : {}),
              ...(Number(message.total_tokens) > 0 ? { total_tokens: Number(message.total_tokens) } : {})
            }
          : {
              role: 'user',
              content: String(message.content || ''),
              created_at: String(message.created_at || '')
            }
      );
    logEvent('info', 'share_link_viewed', {
      conversation_id: share.conversationId,
      message_count: messages.length,
      duration_ms: Math.round(performance.now() - start)
    });
    const response = jsonResponse(
      200,
      {
        conversation: {
          title: String(result.conversation?.title || 'A Thingy conversation'),
          created_at: String(result.conversation?.created_at || ''),
          shared_at: share.createdAt,
          shared_up_to: share.sharedUpTo,
          ...(owner ? { owner: true, conversation_id: share.conversationId } : {})
        },
        messages
      },
      event
    );
    // Revocation must be immediate; never let an edge or browser cache
    // outlive the share row.
    response.headers = { ...(response.headers || {}), 'cache-control': 'no-store' };
    return response;
  } catch (error) {
    logEvent('error', 'share_link_view_failed', {
      error_type: error instanceof Error ? error.constructor.name : 'Error'
    });
    return jsonResponse(502, { error: 'Thingy could not load this shared conversation right now.' }, event);
  }
}
