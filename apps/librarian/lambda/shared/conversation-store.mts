import { GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient, QueryCommandOutput } from '@aws-sdk/client-dynamodb';
import {
  activeChainTurns,
  artifactDynamoString,
  citationDynamoItem,
  conversationPreview,
  conversationSk,
  conversationSummaryFromItem,
  conversationTitle,
  conversationTurnFromItem,
  dynamoList,
  dynamoNumber,
  dynamoString,
  historyFromTurns,
  messagesFromTurns,
  preflightDynamoItem,
  toolTraceDynamoString,
  turnSk,
  turnSkPrefix,
  USER_CONVERSATION_LIMIT,
  userConversationPk,
  validConversationId
} from './user-conversations.mjs';
import { conversationTtlSeconds } from './retention.mjs';

type LogEvent = (level: string, message: string, fields?: Record<string, unknown>) => void;
type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

interface StoreContext {
  dynamodb: DynamoDBClient;
  tableName?: string;
  subscriberHash?: unknown;
}

interface ConversationContext extends StoreContext {
  conversationId?: unknown;
}

interface LoadHistoryInput extends ConversationContext {
  // Branch anchor: build context from the chain ENDING at this turn, so a
  // branched conversation never leaks abandoned-branch turns into the
  // model's context. Absent = the active (newest) chain.
  parentRequestId?: unknown;
  logEvent?: LogEvent;
}

interface LoadSummariesInput extends StoreContext {
  limit?: number;
  logEvent?: LogEvent;
}

interface LoadMessagesInput extends ConversationContext {
  limit?: number;
  // Restrict to the active branch chain (share/eval views) instead of the
  // full tree (the client rebuilds the tree itself from parent ids).
  chainOnly?: boolean;
}

interface CreateConversationInput extends ConversationContext {
  title?: unknown;
  preview?: unknown;
  scope?: unknown;
  mode?: unknown;
  now?: string;
}

interface RenameConversationInput extends ConversationContext {
  title?: unknown;
  now?: string;
}

interface PutTurnInput extends ConversationContext {
  requestId?: unknown;
  parentRequestId?: unknown;
  createdAt: string;
  scope?: unknown;
  mode?: unknown;
  question?: unknown;
  answer?: unknown;
  citations?: JsonObject[];
  preflight?: unknown;
  artifact?: JsonObject | null;
  toolTrace?: JsonObject | null;
  metrics?: JsonObject;
}

interface UpsertConversationInput extends ConversationContext {
  title?: unknown;
  preview?: unknown;
  scope?: unknown;
  mode?: unknown;
  requestId?: unknown;
  now: string;
  lastQuestion?: unknown;
  incrementTurns?: boolean;
  preservePreview?: boolean;
  preserveLastQuestion?: boolean;
}

interface RecordTurnInput extends Omit<PutTurnInput, 'createdAt' | 'artifact'> {
  logEvent?: LogEvent;
}

interface RecordFeedbackInput extends StoreContext {
  requestId?: unknown;
  reaction?: unknown;
  comment?: unknown;
  feedbackAt?: string;
  logEvent?: LogEvent;
}

interface EvaluationInput extends ConversationContext {
  summary?: JsonObject;
  assessment?: JsonObject;
  model?: unknown;
  evaluator?: unknown;
  lastRequestId?: unknown;
  now?: string;
  logEvent?: LogEvent;
}

function noopLog() {}

function logger(logEvent?: LogEvent): LogEvent {
  return typeof logEvent === 'function' ? logEvent : noopLog;
}

function errorName(error: unknown) {
  return error instanceof Error ? error.constructor.name : 'Error';
}

function tableReady({ tableName, subscriberHash }: Pick<StoreContext, 'tableName' | 'subscriberHash'>) {
  return Boolean(tableName && subscriberHash);
}

function boundedList(values: readonly unknown[] = [], limit = 12, chars = 80) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values || []) {
    const text = String(value || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, chars);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function dynamoStringList(values: readonly unknown[] = [], limit = 12, chars = 80) {
  return dynamoList(boundedList(values, limit, chars), dynamoString);
}

export async function loadUserConversationHistory({
  dynamodb,
  tableName,
  subscriberHash,
  conversationId,
  parentRequestId,
  logEvent
}: LoadHistoryInput) {
  const log = logger(logEvent);
  const validId = validConversationId(conversationId);
  if (!tableReady({ tableName, subscriberHash }) || !validId) return [];
  // A root turn follows nothing: every stored turn is another branch, not
  // context. Branching-aware clients mark it explicitly ('' in the request
  // becomes the 'root' sentinel) so it never falls back to the linear chain.
  if (String(parentRequestId || '') === 'root') return [];
  try {
    const response = await dynamodb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
        ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: {
          ':pk': dynamoString(userConversationPk(subscriberHash)),
          ':prefix': dynamoString(turnSkPrefix(validId))
        },
        ScanIndexForward: false,
        // Enough raw turns to reconstruct a chain even in a branchy
        // conversation; historyFromTurns re-bounds to the prompt budget.
        Limit: 48
      })
    );
    const turns = (response.Items || []).map(conversationTurnFromItem);
    const anchor = String(parentRequestId || '');
    let chain = activeChainTurns(turns);
    if (anchor && turns.some((turn) => String(turn.request_id || '') === anchor)) {
      // Walk from the anchor instead of the newest turn.
      const upTo = turns.filter(
        (turn) =>
          String(turn.created_at || '') <=
          String(turns.find((t) => String(t.request_id || '') === anchor)?.created_at || '')
      );
      const anchored = [...upTo].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      // activeChainTurns walks from the newest entry; make the anchor
      // newest by slicing everything after it away.
      const anchorIndex = anchored.findIndex((turn) => String(turn.request_id || '') === anchor);
      chain = activeChainTurns(anchored.slice(0, anchorIndex + 1));
    }
    return historyFromTurns(chain);
  } catch (error) {
    log('warning', 'user_conversation_history_load_failed', {
      subscriber_hash: subscriberHash,
      conversation_id: validId,
      error_type: errorName(error)
    });
    return [];
  }
}

// Full-content conversation search: scan the user's turn rows (bounded by
// USER_CONVERSATION_LIMIT conversations) for a case-insensitive substring
// in questions or answers. Personal-archive scale - a single-partition
// query, not an index.
export async function searchUserConversationTurns({
  dynamodb,
  tableName,
  subscriberHash,
  query,
  logEvent
}: {
  dynamodb: DynamoDBClient;
  tableName: string | undefined;
  subscriberHash: string;
  query: string;
  logEvent?: LogEvent;
}) {
  const log = logger(logEvent);
  const needle = String(query || '')
    .trim()
    .toLowerCase();
  if (!tableReady({ tableName, subscriberHash }) || needle.length < 2) return [];
  const matches = new Map<string, string>();
  try {
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    for (let page = 0; page < 10; page += 1) {
      const response: QueryCommandOutput = await dynamodb.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
          ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
          ExpressionAttributeValues: {
            ':pk': dynamoString(userConversationPk(subscriberHash)),
            ':prefix': dynamoString('turn#')
          },
          ProjectionExpression: 'sk, question, answer',
          ExclusiveStartKey: exclusiveStartKey
        })
      );
      for (const item of response.Items || []) {
        const sk = String(item.sk?.S || '');
        const conversationId = sk.split('#')[1] || '';
        if (!conversationId || matches.has(conversationId)) continue;
        const haystacks = [String(item.question?.S || ''), String(item.answer?.S || '')];
        for (const text of haystacks) {
          const index = text.toLowerCase().indexOf(needle);
          if (index >= 0) {
            const from = Math.max(0, index - 40);
            const snippet = `${from > 0 ? '…' : ''}${text.slice(from, index + needle.length + 60).trim()}${index + needle.length + 60 < text.length ? '…' : ''}`;
            matches.set(conversationId, snippet);
            break;
          }
        }
        if (matches.size >= 30) break;
      }
      exclusiveStartKey = response.LastEvaluatedKey;
      if (!exclusiveStartKey || matches.size >= 30) break;
    }
  } catch (error) {
    log('warning', 'user_conversation_search_failed', {
      subscriber_hash: subscriberHash,
      error_type: errorName(error)
    });
  }
  return Array.from(matches.entries(), ([conversation_id, snippet]) => ({ conversation_id, snippet }));
}

// Every conversation row for the user, newest first. One partition, tiny
// rows; the LastEvaluatedKey loop matters only past ~1000 conversations.
export async function fetchAllConversationSummaries({
  dynamodb,
  tableName,
  subscriberHash,
  logEvent
}: LoadSummariesInput) {
  const log = logger(logEvent);
  if (!tableReady({ tableName, subscriberHash })) return [];
  try {
    const items: NonNullable<QueryCommandOutput['Items']> = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    for (let page = 0; page < 10; page += 1) {
      const response: QueryCommandOutput = await dynamodb.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
          ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
          ExpressionAttributeValues: {
            ':pk': dynamoString(userConversationPk(subscriberHash)),
            ':prefix': dynamoString('conversation#')
          },
          ExclusiveStartKey: exclusiveStartKey
        })
      );
      items.push(...(response.Items || []));
      exclusiveStartKey = response.LastEvaluatedKey;
      if (!exclusiveStartKey) break;
    }
    return items
      .map(conversationSummaryFromItem)
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  } catch (error) {
    log('warning', 'user_conversation_summaries_load_failed', {
      subscriber_hash: subscriberHash,
      error_type: errorName(error)
    });
    return [];
  }
}

export async function loadUserConversationSummaries(input: LoadSummariesInput) {
  const limit = Math.max(1, Math.min(Number(input.limit) || 8, USER_CONVERSATION_LIMIT));
  return (await fetchAllConversationSummaries(input)).slice(0, limit);
}

// Paged window over the full history plus the total - the rail keeps its
// bounded working set while the All-chats browser walks the rest.
export async function listUserConversationPage(input: LoadSummariesInput & { offset?: number }) {
  const all = await fetchAllConversationSummaries(input);
  const limit = Math.max(1, Math.min(Number(input.limit) || USER_CONVERSATION_LIMIT, 100));
  const offset = Math.max(0, Number(input.offset) || 0);
  return { conversations: all.slice(offset, offset + limit), total: all.length };
}

export async function getUserConversationMetadata({
  dynamodb,
  tableName,
  subscriberHash,
  conversationId
}: ConversationContext) {
  const validId = validConversationId(conversationId);
  if (!tableReady({ tableName, subscriberHash }) || !validId) return null;
  const response = await dynamodb.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        pk: dynamoString(userConversationPk(subscriberHash)),
        sk: dynamoString(conversationSk(validId))
      }
    })
  );
  return response.Item ? conversationSummaryFromItem(response.Item) : null;
}

export async function loadUserConversationMessages({
  dynamodb,
  tableName,
  subscriberHash,
  conversationId,
  limit = 80,
  chainOnly = false
}: LoadMessagesInput) {
  const validId = validConversationId(conversationId);
  if (!tableReady({ tableName, subscriberHash }) || !validId) return [];
  const response = await dynamodb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: {
        ':pk': dynamoString(userConversationPk(subscriberHash)),
        ':prefix': dynamoString(turnSkPrefix(validId))
      },
      ScanIndexForward: false,
      Limit: Math.max(1, Math.min(Number(limit) || 80, 80))
    })
  );
  const turns = (response.Items || [])
    .map(conversationTurnFromItem)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return messagesFromTurns(chainOnly ? activeChainTurns(turns) : turns);
}

export async function getUserConversation({
  dynamodb,
  tableName,
  subscriberHash,
  conversationId,
  limit = 80,
  chainOnly = false
}: LoadMessagesInput) {
  const conversation = await getUserConversationMetadata({ dynamodb, tableName, subscriberHash, conversationId });
  if (!conversation) return null;
  const messages = await loadUserConversationMessages({
    dynamodb,
    tableName,
    subscriberHash,
    conversationId,
    limit,
    chainOnly
  });
  return { conversation, messages };
}

export async function createUserConversation({
  dynamodb,
  tableName,
  subscriberHash,
  conversationId,
  title,
  preview,
  scope,
  mode = 'thingy',
  now = new Date().toISOString()
}: CreateConversationInput) {
  const validId = validConversationId(conversationId);
  if (!tableReady({ tableName, subscriberHash }) || !validId) return null;
  await dynamodb.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        pk: dynamoString(userConversationPk(subscriberHash)),
        sk: dynamoString(conversationSk(validId)),
        item_type: dynamoString('conversation'),
        conversation_id: dynamoString(validId),
        title: dynamoString(conversationTitle(title || '')),
        title_source: dynamoString('auto'),
        preview: dynamoString(conversationPreview(preview || title || '')),
        scope: dynamoString(scope || 'all'),
        mode: dynamoString(mode || 'thingy'),
        created_at: dynamoString(now),
        updated_at: dynamoString(now),
        last_message_at: dynamoString(''),
        turn_count: dynamoNumber(0),
        ttl: dynamoNumber(conversationTtlSeconds(now))
      },
      ConditionExpression: 'attribute_not_exists(pk)'
    })
  );
  return await getUserConversationMetadata({ dynamodb, tableName, subscriberHash, conversationId: validId });
}

export async function renameUserConversation({
  dynamodb,
  tableName,
  subscriberHash,
  conversationId,
  title,
  now = new Date().toISOString()
}: RenameConversationInput) {
  const validId = validConversationId(conversationId);
  if (!tableReady({ tableName, subscriberHash }) || !validId) return null;
  await dynamodb.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: {
        pk: dynamoString(userConversationPk(subscriberHash)),
        sk: dynamoString(conversationSk(validId))
      },
      UpdateExpression:
        'SET #title = :title, #title_source = :title_source, #updated_at = :updated_at, #ttl = if_not_exists(#ttl_floor, :ttl)',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: {
        '#title': 'title',
        '#title_source': 'title_source',
        '#updated_at': 'updated_at',
        '#ttl': 'ttl',
        '#ttl_floor': 'ttl_floor'
      },
      ExpressionAttributeValues: {
        ':title': dynamoString(conversationTitle(title)),
        ':title_source': dynamoString('user'),
        ':updated_at': dynamoString(now),
        ':ttl': dynamoNumber(conversationTtlSeconds(now))
      }
    })
  );
  return await getUserConversationMetadata({ dynamodb, tableName, subscriberHash, conversationId: validId });
}

async function putTurn({
  dynamodb,
  tableName,
  subscriberHash,
  conversationId,
  requestId,
  parentRequestId,
  createdAt,
  scope,
  mode = 'thingy',
  question = '',
  answer = '',
  citations = [],
  preflight = null,
  artifact = null,
  toolTrace = null,
  metrics = {}
}: PutTurnInput) {
  const citationItems = (citations || []).slice(0, 24).map(citationDynamoItem);
  const toolCalls = Array.isArray(toolTrace?.calls) ? toolTrace.calls : [];
  const toolNames = boundedList(
    toolCalls.map((call) => (call && typeof call === 'object' ? (call as JsonObject).name : '')),
    20,
    80
  );
  const item: Record<string, AttributeValue> = {
    pk: dynamoString(userConversationPk(subscriberHash)),
    sk: dynamoString(turnSk(conversationId, createdAt, requestId)),
    item_type: dynamoString('turn'),
    conversation_id: dynamoString(conversationId),
    request_id: dynamoString(requestId),
    // Branch edge: which prior turn this one answers after. Empty for the
    // first turn of a conversation (and for turns from pre-4.3 clients).
    parent_request_id: dynamoString(parentRequestId),
    created_at: dynamoString(createdAt),
    scope: dynamoString(scope || 'all'),
    mode: dynamoString(mode || 'thingy'),
    question: dynamoString(String(question || '').slice(0, 4000)),
    answer: dynamoString(String(answer || '').slice(0, 12000)),
    question_chars: dynamoNumber(String(question || '').length),
    answer_chars: dynamoNumber(String(answer || '').length),
    citation_count: dynamoNumber((citations || []).length),
    citations: dynamoList(citationItems, (value) => value as AttributeValue),
    preflight: preflightDynamoItem(preflight),
    model: dynamoString(metrics.model),
    duration_ms: dynamoNumber(metrics.duration_ms),
    // Cumulative across every Bedrock call in the agent loop (schema v2);
    // rows older than the change carry the final call's output only.
    output_tokens: dynamoNumber(metrics.output_tokens),
    input_tokens: dynamoNumber(metrics.input_tokens),
    total_tokens: dynamoNumber(metrics.total_tokens),
    cache_read_input_tokens: dynamoNumber(metrics.cache_read_input_tokens),
    cache_write_input_tokens: dynamoNumber(metrics.cache_write_input_tokens),
    bedrock_calls: dynamoNumber(metrics.bedrock_calls),
    trace_schema_version: dynamoNumber(objectValue(toolTrace).schema_version),
    prompt_fingerprint: dynamoString(objectValue(toolTrace).prompt_fingerprint),
    source_revision: dynamoString(objectValue(toolTrace).source_revision),
    stop_reason: dynamoString(metrics.stop_reason),
    tool_count: dynamoNumber(toolNames.length),
    tool_names: dynamoStringList(toolNames, 20, 80),
    tool_trace_json: toolTraceDynamoString(toolTrace),
    ttl: dynamoNumber(conversationTtlSeconds(createdAt))
  };
  if (artifact) {
    item.artifact_kind = dynamoString(artifact.kind || 'artifact');
    item.artifact_version = dynamoNumber(artifact.artifact_version || artifact.version || 1);
    item.artifact_json = artifactDynamoString(artifact);
  }
  await dynamodb.send(new PutItemCommand({ TableName: tableName, Item: item }));
}

async function upsertConversation({
  dynamodb,
  tableName,
  subscriberHash,
  conversationId,
  title,
  preview,
  scope,
  mode = 'thingy',
  requestId,
  now,
  lastQuestion,
  incrementTurns,
  preservePreview = false,
  preserveLastQuestion = false
}: UpsertConversationInput) {
  const response = await dynamodb.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: {
        pk: dynamoString(userConversationPk(subscriberHash)),
        sk: dynamoString(conversationSk(conversationId))
      },
      UpdateExpression: [
        'SET #item_type = :item_type',
        '#conversation_id = :conversation_id',
        '#title = if_not_exists(#title, :title)',
        '#title_source = if_not_exists(#title_source, :title_source)',
        preservePreview ? '#preview = if_not_exists(#preview, :preview)' : '#preview = :preview',
        '#scope = :scope',
        '#mode = if_not_exists(#mode, :mode)',
        '#created_at = if_not_exists(#created_at, :now)',
        '#updated_at = :now',
        '#last_message_at = :now',
        '#last_request_id = :request_id',
        preserveLastQuestion
          ? '#last_question = if_not_exists(#last_question, :question)'
          : '#last_question = :question',
        '#turn_count = if_not_exists(#turn_count, :zero) + :turn_increment',
        '#ttl = if_not_exists(#ttl_floor, :ttl)'
      ].join(', '),
      ExpressionAttributeNames: {
        '#item_type': 'item_type',
        '#conversation_id': 'conversation_id',
        '#title': 'title',
        '#title_source': 'title_source',
        '#preview': 'preview',
        '#scope': 'scope',
        '#mode': 'mode',
        '#created_at': 'created_at',
        '#updated_at': 'updated_at',
        '#last_message_at': 'last_message_at',
        '#last_request_id': 'last_request_id',
        '#last_question': 'last_question',
        '#turn_count': 'turn_count',
        '#ttl': 'ttl',
        '#ttl_floor': 'ttl_floor'
      },
      ExpressionAttributeValues: {
        ':item_type': dynamoString('conversation'),
        ':conversation_id': dynamoString(conversationId),
        ':title': dynamoString(title),
        ':title_source': dynamoString('auto'),
        ':preview': dynamoString(preview),
        ':scope': dynamoString(scope || 'all'),
        ':mode': dynamoString(mode || 'thingy'),
        ':now': dynamoString(now),
        ':request_id': dynamoString(requestId),
        ':question': dynamoString(String(lastQuestion || '').slice(0, 500)),
        ':zero': dynamoNumber(0),
        ':turn_increment': dynamoNumber(incrementTurns ? 1 : 0),
        ':ttl': dynamoNumber(conversationTtlSeconds(now))
      },
      ReturnValues: 'ALL_NEW'
    })
  );
  return response.Attributes ? conversationSummaryFromItem(response.Attributes) : null;
}

export async function recordUserConversationTurn({
  dynamodb,
  tableName,
  subscriberHash,
  conversationId,
  question,
  answer,
  scope,
  mode = 'thingy',
  requestId,
  parentRequestId,
  citations,
  preflight,
  toolTrace,
  metrics,
  logEvent
}: RecordTurnInput) {
  const log = logger(logEvent);
  const validId = validConversationId(conversationId);
  if (!tableReady({ tableName, subscriberHash }) || !validId) return null;
  const now = new Date().toISOString();
  try {
    await putTurn({
      dynamodb,
      tableName,
      subscriberHash,
      conversationId: validId,
      requestId,
      parentRequestId,
      createdAt: now,
      scope,
      mode,
      question,
      answer,
      citations,
      preflight,
      toolTrace,
      metrics
    });
    return await upsertConversation({
      dynamodb,
      tableName,
      subscriberHash,
      conversationId: validId,
      title: conversationTitle(question),
      preview: conversationPreview(question),
      scope,
      mode,
      requestId,
      now,
      lastQuestion: question,
      incrementTurns: true
    });
  } catch (error) {
    log('warning', 'user_conversation_turn_record_failed', {
      subscriber_hash: subscriberHash,
      conversation_id: validId,
      request_id: requestId,
      error_type: errorName(error)
    });
    return null;
  }
}

export async function recordUserConversationFeedback({
  dynamodb,
  tableName,
  subscriberHash,
  requestId,
  reaction,
  comment = '',
  feedbackAt = new Date().toISOString(),
  logEvent
}: RecordFeedbackInput) {
  const log = logger(logEvent);
  if (!tableReady({ tableName, subscriberHash }) || !requestId || !reaction) return { found: false };
  try {
    const items: Array<Record<string, AttributeValue>> = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const response: QueryCommandOutput = await dynamodb.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
          FilterExpression: '#request_id = :request_id',
          ExpressionAttributeNames: {
            '#pk': 'pk',
            '#sk': 'sk',
            '#request_id': 'request_id'
          },
          ExpressionAttributeValues: {
            ':pk': dynamoString(userConversationPk(subscriberHash)),
            ':prefix': dynamoString('turn#'),
            ':request_id': dynamoString(requestId)
          },
          ExclusiveStartKey: exclusiveStartKey
        })
      );
      items.push(...(response.Items || []));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey && items.length === 0);
    if (!items.length) return { found: false };
    for (const item of items) {
      await dynamodb.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { pk: item.pk, sk: item.sk },
          UpdateExpression:
            'SET #feedback_reaction = :reaction, #feedback_at = :feedback_at, #feedback_comment = :feedback_comment ADD #feedback_revision :one',
          ExpressionAttributeNames: {
            '#feedback_reaction': 'feedback_reaction',
            '#feedback_at': 'feedback_at',
            '#feedback_comment': 'feedback_comment',
            '#feedback_revision': 'feedback_revision'
          },
          ExpressionAttributeValues: {
            ':reaction': dynamoString(reaction),
            ':feedback_at': dynamoString(feedbackAt),
            ':feedback_comment': dynamoString(String(comment || '').slice(0, 1000)),
            ':one': dynamoNumber(1)
          }
        })
      );
    }
    return { found: true, updated: items.length };
  } catch (error) {
    log('warning', 'user_conversation_feedback_record_failed', {
      subscriber_hash: subscriberHash,
      request_id: requestId,
      error_type: errorName(error)
    });
    throw error;
  }
}

export async function updateUserConversationEvaluation({
  dynamodb,
  tableName,
  subscriberHash,
  conversationId,
  summary = {},
  assessment = {},
  model = '',
  evaluator = 'thingy_eval',
  lastRequestId = '',
  now = new Date().toISOString(),
  logEvent
}: EvaluationInput) {
  const log = logger(logEvent);
  const validId = validConversationId(conversationId);
  if (!tableReady({ tableName, subscriberHash }) || !validId) return null;
  const quality = String(assessment.quality || '')
    .trim()
    .toLowerCase();
  const safeQuality = ['clean', 'watch', 'problem'].includes(quality) ? quality : 'watch';
  const evaluatedTitle = conversationTitle(summary.title || summary.topic || assessment.topic || '');
  try {
    const response = await dynamodb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: {
          pk: dynamoString(userConversationPk(subscriberHash)),
          sk: dynamoString(conversationSk(validId))
        },
        UpdateExpression: [
          'SET #summary = :summary',
          '#topic = :topic',
          '#tags = :tags',
          '#preview = :preview',
          '#eval_status = :eval_status',
          '#eval_quality = :eval_quality',
          '#eval_flags = :eval_flags',
          '#eval_improvements = :eval_improvements',
          '#eval_assessed_at = :eval_assessed_at',
          '#eval_model = :eval_model',
          '#eval_last_request_id = :eval_last_request_id',
          '#eval_evaluator = :eval_evaluator',
          '#eval_topic = :eval_topic',
          '#eval_reader = :eval_reader',
          '#eval_thingy = :eval_thingy',
          '#eval_takeaway = :eval_takeaway',
          '#updated_at = :updated_at',
          '#ttl = if_not_exists(#ttl_floor, :ttl)'
        ].join(', '),
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: {
          '#summary': 'summary',
          '#topic': 'topic',
          '#tags': 'tags',
          '#preview': 'preview',
          '#eval_status': 'eval_status',
          '#eval_quality': 'eval_quality',
          '#eval_flags': 'eval_flags',
          '#eval_improvements': 'eval_improvements',
          '#eval_assessed_at': 'eval_assessed_at',
          '#eval_model': 'eval_model',
          '#eval_last_request_id': 'eval_last_request_id',
          '#eval_evaluator': 'eval_evaluator',
          '#eval_topic': 'eval_topic',
          '#eval_reader': 'eval_reader',
          '#eval_thingy': 'eval_thingy',
          '#eval_takeaway': 'eval_takeaway',
          '#updated_at': 'updated_at',
          '#ttl': 'ttl',
          '#ttl_floor': 'ttl_floor'
        },
        ExpressionAttributeValues: {
          ':summary': dynamoString(String(summary.summary || '').slice(0, 1000)),
          ':topic': dynamoString(String(summary.topic || assessment.topic || '').slice(0, 120)),
          ':tags': dynamoStringList(Array.isArray(summary.tags) ? summary.tags : [], 8, 40),
          ':preview': dynamoString(
            conversationPreview(summary.preview || summary.summary || assessment.takeaway || '')
          ),
          ':eval_status': dynamoString('reviewed'),
          ':eval_quality': dynamoString(safeQuality),
          ':eval_flags': dynamoStringList(Array.isArray(assessment.flags) ? assessment.flags : [], 10, 80),
          ':eval_improvements': dynamoStringList(
            Array.isArray(assessment.improvements) ? assessment.improvements : [],
            6,
            180
          ),
          ':eval_assessed_at': dynamoString(now),
          ':eval_model': dynamoString(model),
          ':eval_last_request_id': dynamoString(lastRequestId),
          ':eval_evaluator': dynamoString(evaluator),
          ':eval_topic': dynamoString(String(assessment.topic || summary.topic || '').slice(0, 120)),
          ':eval_reader': dynamoString(String(assessment.reader || '').slice(0, 1000)),
          ':eval_thingy': dynamoString(String(assessment.thingy || '').slice(0, 1000)),
          ':eval_takeaway': dynamoString(String(assessment.takeaway || '').slice(0, 600)),
          ':updated_at': dynamoString(now),
          ':ttl': dynamoNumber(conversationTtlSeconds(now))
        },
        ReturnValues: 'ALL_NEW'
      })
    );
    let conversation = response.Attributes ? conversationSummaryFromItem(response.Attributes) : null;
    if (conversation && conversation.title_source !== 'user' && evaluatedTitle !== 'Untitled chat') {
      try {
        const titleResponse = await dynamodb.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: {
              pk: dynamoString(userConversationPk(subscriberHash)),
              sk: dynamoString(conversationSk(validId))
            },
            UpdateExpression:
              'SET #title = :title, #title_source = :title_source, #updated_at = :updated_at, #ttl = if_not_exists(#ttl_floor, :ttl)',
            ConditionExpression:
              'attribute_exists(pk) AND (attribute_not_exists(#title_source) OR #title_source <> :user_title_source)',
            ExpressionAttributeNames: {
              '#title': 'title',
              '#title_source': 'title_source',
              '#updated_at': 'updated_at',
              '#ttl': 'ttl',
              '#ttl_floor': 'ttl_floor'
            },
            ExpressionAttributeValues: {
              ':title': dynamoString(evaluatedTitle),
              ':title_source': dynamoString('eval'),
              ':user_title_source': dynamoString('user'),
              ':updated_at': dynamoString(now),
              ':ttl': dynamoNumber(conversationTtlSeconds(now))
            },
            ReturnValues: 'ALL_NEW'
          })
        );
        conversation = titleResponse.Attributes ? conversationSummaryFromItem(titleResponse.Attributes) : conversation;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') {
          log('warning', 'user_conversation_eval_title_update_failed', {
            subscriber_hash: subscriberHash,
            conversation_id: validId,
            error_type: errorName(error)
          });
        }
      }
    }
    return conversation;
  } catch (error) {
    log('warning', 'user_conversation_evaluation_update_failed', {
      subscriber_hash: subscriberHash,
      conversation_id: validId,
      error_type: errorName(error)
    });
    return null;
  }
}
