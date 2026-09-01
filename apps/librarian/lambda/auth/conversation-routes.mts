import crypto from 'node:crypto';
import { BatchWriteItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue, QueryCommandOutput, WriteRequest } from '@aws-sdk/client-dynamodb';
import { dynamodb } from '../shared/aws-clients.mjs';
import { jsonResponse } from '../shared/http.mjs';
import type { LibrarianHttpEvent } from '../shared/http.mjs';
import { emailHash, normalizeEmail, verifyToken } from '../shared/session.mjs';
import { resolveSessionToken } from '../shared/web-session.mjs';
import { sessionAllowedForThingyProfile } from '../shared/profile-deletion.mjs';
import { logEvent } from '../shared/logging.mjs';
import {
  availableConversationModes,
  canUseConversationMode,
  isOwnerSubscriberHash,
  normalizeConversationMode
} from '../shared/conversation-modes.mjs';
import { consumeDailyQuota, emailDailyQuota } from '../shared/quota.mjs';
import { jmapConfigured, sendJmapEmail } from '../shared/jmap-mail.mjs';
import { answerEmailHtml, answerEmailSubject, answerEmailText } from '../shared/answer-email.mjs';
import {
  createUserConversation,
  getUserConversation,
  loadUserConversationSummaries,
  renameUserConversation
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
    return jsonResponse(401, { error: 'Please validate your subscriber email to use Thingy.' }, event);
  }
  const subscriberHash = String(payload.sub || '');
  if (!subscriberHash)
    return jsonResponse(401, { error: 'Please validate your subscriber email to use Thingy.' }, event);
  const entitlements = entitlementsForSessionPayload(payload);
  const modes = availableConversationModes(entitlements);
  const tableName = process.env.TABLE_NAME;
  if (!tableName) return conversationTableUnavailable(event);

  const action = String(body.action || 'list')
    .trim()
    .toLowerCase();
  try {
    if (action === 'list') {
      const conversations = await loadUserConversationSummaries({
        dynamodb,
        tableName,
        subscriberHash,
        limit: Number(body.limit || USER_CONVERSATION_LIMIT),
        logEvent
      });
      logEvent('info', 'user_conversations_listed', {
        subscriber_hash: subscriberHash,
        count: conversations.length,
        duration_ms: Math.round(performance.now() - start)
      });
      return jsonResponse(200, { conversations, entitlements, modes }, event);
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

    if (action === 'email_answer') {
      const conversationId = validConversationId(body.conversation_id || body.id);
      if (!conversationId) return jsonResponse(400, { error: 'conversation_id is required.' }, event);
      // Self-send only: the address must hash to the signed-in subject, so
      // Thingy can never be used to mail an answer to someone else and the
      // server never needs a plaintext address at rest.
      const email = normalizeEmail(body.email);
      if (!email || emailHash(email) !== subscriberHash) {
        return jsonResponse(403, { error: 'Answers can only be emailed to your own signed-in address.' }, event);
      }
      if (!jmapConfigured()) {
        return jsonResponse(503, { error: 'Email is not available right now.' }, event);
      }
      const result = await getUserConversation({ dynamodb, tableName, subscriberHash, conversationId });
      if (!result) return jsonResponse(404, { error: 'Conversation not found.' }, event);
      const requestId = String(body.request_id || '').trim();
      const answers = (result.messages || []).filter(
        (message) => message.role === 'assistant' && String(message.content || '').trim()
      );
      const target = requestId
        ? answers.find((message) => String(message.request_id || '') === requestId)
        : answers.at(-1);
      if (!target) return jsonResponse(404, { error: 'No answer found to email.' }, event);
      const questionFor = (result.messages || []).find(
        (message) => message.role === 'user' && String(message.request_id || '') === String(target.request_id || '')
      );
      if (!isOwnerSubscriberHash(subscriberHash)) {
        const quota = await consumeDailyQuota('email', subscriberHash, emailDailyQuota());
        if (!quota.allowed) {
          return jsonResponse(
            429,
            { error: `Daily email limit reached (${quota.max} per day). It resets at midnight UTC.` },
            event
          );
        }
      }
      const emailInput = {
        conversationTitle: result.conversation?.title,
        question: questionFor?.content || '',
        answer: target.content,
        citations: Array.isArray(target.citations) ? (target.citations as Record<string, unknown>[]) : []
      };
      await sendJmapEmail({
        to: email,
        subject: answerEmailSubject(result.conversation?.title),
        text: answerEmailText(emailInput),
        html: answerEmailHtml(emailInput)
      });
      logEvent('info', 'answer_emailed', {
        subscriber_hash: subscriberHash,
        conversation_id: conversationId,
        request_id: String(target.request_id || ''),
        duration_ms: Math.round(performance.now() - start)
      });
      return jsonResponse(200, { ok: true }, event);
    }

    if (action === 'delete' || action === 'trash') {
      const conversationId = validConversationId(body.conversation_id || body.id);
      if (!conversationId) return jsonResponse(400, { error: 'conversation_id is required.' }, event);
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
            ExclusiveStartKey: exclusiveStartKey
          })
        );
        for (const item of response.Items || []) keys.push({ pk: item.pk, sk: item.sk });
        exclusiveStartKey = response.LastEvaluatedKey;
      } while (exclusiveStartKey);

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
