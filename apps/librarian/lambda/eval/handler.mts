import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetItemCommand, QueryCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue, ScanCommandOutput } from '@aws-sdk/client-dynamodb';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { bedrock, dynamodb, fastModel } from '../shared/aws-clients.mjs';
import { errorFields, logEvent } from '../shared/logging.mjs';
import { turnForPrompt } from '../shared/eval-transcript.mjs';
import {
  activeChainTurns,
  conversationSummaryFromItem,
  conversationTurnFromItem,
  dynamoString,
  fromDynamoAttr,
  conversationSk,
  turnSkPrefix,
  userConversationPk
} from '../shared/user-conversations.mjs';
import { updateUserConversationEvaluation } from '../shared/conversation-store.mjs';

const DEFAULT_SCAN_PAGES = 20;
const DEFAULT_MAX_CONVERSATIONS = 12;
const DEFAULT_TURN_LIMIT = 80;

type JsonRecord = Record<string, unknown>;
type ConversationSummary = ReturnType<typeof conversationSummaryFromItem>;
type EvalTurn = Parameters<typeof turnForPrompt>[0];

interface DueConversation {
  subscriberHash: string;
  conversation: ConversationSummary;
  needsReview: boolean;
}

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function envBool(name: string, defaultValue = false) {
  const raw = String(process.env[name] || '')
    .trim()
    .toLowerCase();
  if (!raw) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function subscriberHashFromUserPk(pk: unknown) {
  const text = String(pk || '');
  return text.startsWith('user#') ? text.slice('user#'.length) : '';
}

function bedrockMessageText(message: unknown) {
  const content = objectValue(message).content;
  return (Array.isArray(content) ? content : [])
    .map((part) => String(objectValue(part).text || ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseJsonPayload(text: unknown): JsonRecord | null {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : (raw.match(/\{[\s\S]*\}/) || [raw])[0];
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function boundedText(value: unknown, max = 800) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

function boundedList(value: unknown, limit = 8, chars = 80) {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = boundedText(item, chars);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeEvalPayload(value: unknown = {}) {
  const record = objectValue(value);
  const summary = objectValue(record.summary);
  const assessment = objectValue(record.assessment);
  const quality = String(assessment.quality || '')
    .trim()
    .toLowerCase();
  return {
    summary: {
      title: boundedText(summary.title, 80),
      topic: boundedText(summary.topic, 120),
      preview: boundedText(summary.preview, 160),
      summary: boundedText(summary.summary, 1000),
      tags: boundedList(summary.tags, 8, 40)
    },
    assessment: {
      topic: boundedText(assessment.topic || summary.topic, 120),
      reader: boundedText(assessment.reader, 1000),
      thingy: boundedText(assessment.thingy, 1000),
      takeaway: boundedText(assessment.takeaway, 600),
      quality: ['clean', 'watch', 'problem'].includes(quality) ? quality : 'watch',
      flags: boundedList(assessment.flags, 10, 80),
      improvements: boundedList(assessment.improvements, 6, 180)
    }
  };
}

export function evalSystemPrompt() {
  return `You are Thingy's background evaluator for Jamie Thingelstad's public archive agent.

Thingy answers questions only from Jamie's public archive: The Weekly Thing, thingelstad.com, and Another Thing.
Some conversations may run in a named mode:
- "thingy" is the default archive-agent mode: useful, warm, source-grounded, and not overbuilt when the reader asks for a concise answer or one recommendation.
- "research_guide" should give deeper synthesis, timelines, comparisons, reading paths, research questions, and source prioritization. Tables are fine when useful. For timelines, watch whether evidence is contemporaneous or retrospective; flag anachronistic evidence as citation_mismatch or source_gap when it could mislead.
- "thought_partner" should be more candid, reflective, and challenging for Jamie while still staying grounded in the published archive. Do not penalize thoughtful pushback in that mode; do flag unsupported speculation, private-corpus claims, or overreach.
- "trusted_circle" should be warmer, closer, and often briefer. Do not penalize a short, gentle answer if it is grounded enough for the request. Do flag recommendations that rely only on a title or vibe without concrete source detail.

Read the transcript and return ONLY compact JSON:
{
  "summary": {
    "title": "short conversation title",
    "topic": "short topic",
    "preview": "one short rail preview",
    "summary": "operator-facing summary of the conversation arc",
    "tags": ["tag"]
  },
  "assessment": {
    "topic": "≤ 8 words",
    "reader": "what the reader wanted and whether they got it",
    "thingy": "how Thingy did: grounding, citations, tone, misses",
    "takeaway": "one actionable thing Jamie should notice, or 'nothing to act on — clean exchange'",
    "quality": "clean|watch|problem",
    "flags": ["citation_mismatch|unsupported_claim|source_gap|refusal_issue|privacy_boundary|prompt_leak|tool_gap|ux_confusion|runtime_timeout|answer_too_long|answer_too_thin|reader_delight"],
    "improvements": ["concrete implementation idea"]
  }
}

Be specific, do not manufacture criticism, and treat lines labeled Runtime/Preflight/Tools/Reader feedback as operator metadata. Compare the answer's visible source labels or citation footer with the structured Citations metadata: use citation_mismatch when a cited source does not support the nearby claim, a visible source disagrees with the structured citation, or retrospective evidence is presented as if it were contemporaneous. Do not require every retrieved source to appear in the answer; judge only sources the answer actually relies on. If Runtime stop_reason is app_deadline_exceeded or tool_use_exhausted, identify it as runtime exhaustion; prefer runtime_timeout and/or tool_gap over criticizing tone, citations, or answer depth as though Thingy chose to give a normal final answer. Do not call an answer truncated merely because it ends with a suggested follow-up question or "next thread worth pulling" prompt; only flag truncation when the prose visibly cuts off mid-word, mid-sentence, or mid-structure. If the transcript contains "[Evaluator transcript note: ... omitted]", that is evaluator-only compaction, not reader-visible truncation. Use prompt_leak only when internal metadata appeared in Thingy's actual answer text.`;
}

async function evaluateConversation({ conversation, turns }: { conversation: ConversationSummary; turns: EvalTurn[] }) {
  const transcript = turns.map((turn, index) => turnForPrompt(turn, index)).join('\n\n');
  const model = fastModel();
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: model,
      system: [{ text: evalSystemPrompt() }, { cachePoint: { type: 'default' } }],
      messages: [
        {
          role: 'user',
          content: [
            {
              text: [
                `Conversation id: ${conversation.id}`,
                `Current title: ${conversation.title}`,
                `Scope: ${conversation.scope}`,
                `Mode: ${conversation.mode || 'thingy'}`,
                `Turn count: ${turns.length}`,
                '',
                transcript
              ].join('\n')
            }
          ]
        }
      ],
      inferenceConfig: {
        maxTokens: Number(process.env.BEDROCK_EVAL_MAX_TOKENS || '1100'),
        temperature: Number(process.env.BEDROCK_EVAL_TEMPERATURE || '0.1')
      }
    })
  );
  const parsed = parseJsonPayload(bedrockMessageText(response.output?.message || {}));
  const normalized = normalizeEvalPayload(parsed || {});
  return {
    ...normalized,
    model,
    usage: { outputTokens: response.usage?.outputTokens || 0 }
  };
}

async function loadConversationTurns({
  tableName,
  subscriberHash,
  conversationId
}: {
  tableName: string;
  subscriberHash: string;
  conversationId: string;
}): Promise<EvalTurn[]> {
  const response = await dynamodb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: {
        ':pk': dynamoString(userConversationPk(subscriberHash)),
        ':prefix': dynamoString(turnSkPrefix(conversationId))
      },
      ScanIndexForward: false,
      Limit: Number(process.env.EVAL_TURN_LIMIT || DEFAULT_TURN_LIMIT)
    })
  );
  // Evaluate the active branch only: mixed-branch transcripts read as
  // incoherent conversations and produce false evaluator flags.
  return activeChainTurns((response.Items || []).map(conversationTurnFromItem)).filter(
    (turn) => turn.question || turn.answer
  ) as EvalTurn[];
}

function conversationIdFromTurnSk(sk: unknown = '') {
  const text = String(sk || '');
  if (!text.startsWith('turn#')) return '';
  const rest = text.slice('turn#'.length);
  return rest.split('#')[0] || '';
}

function conversationRefsFromStream(event: DynamoDBStreamEvent) {
  const refs = new Map<string, { subscriberHash: string; conversationId: string }>();
  for (const record of event.Records || []) {
    const image = record.dynamodb?.NewImage || record.dynamodb?.OldImage || null;
    if (!image) continue;
    const pk = fromDynamoAttr(image.pk as AttributeValue | undefined);
    const sk = fromDynamoAttr(image.sk as AttributeValue | undefined);
    const subscriberHash = subscriberHashFromUserPk(pk);
    const skText = String(sk || '');
    if (!subscriberHash || !skText) continue;
    let conversationId = '';
    if (skText.startsWith('turn#')) conversationId = conversationIdFromTurnSk(skText);
    if (skText.startsWith('conversation#')) conversationId = skText.slice('conversation#'.length);
    if (!conversationId) continue;
    refs.set(`${subscriberHash}\0${conversationId}`, { subscriberHash, conversationId });
  }
  return [...refs.values()];
}

async function loadConversationMetadata({
  tableName,
  subscriberHash,
  conversationId
}: {
  tableName: string;
  subscriberHash: string;
  conversationId: string;
}) {
  const response = await dynamodb.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        pk: dynamoString(userConversationPk(subscriberHash)),
        sk: dynamoString(conversationSk(conversationId))
      }
    })
  );
  return response.Item ? conversationSummaryFromItem(response.Item) : null;
}

function conversationNeedsWork(conversation: ConversationSummary | null) {
  if (!conversation || Number(conversation.turn_count || 0) <= 0) return false;
  return !conversation.last_request_id || conversation.last_request_id !== conversation.eval_last_request_id;
}

async function dueConversations({
  tableName,
  event
}: {
  tableName: string;
  event: DynamoDBStreamEvent;
}): Promise<DueConversation[]> {
  const eventRefs = conversationRefsFromStream(event);
  if (eventRefs.length) {
    const rows: DueConversation[] = [];
    for (const ref of eventRefs) {
      const conversation = await loadConversationMetadata({ tableName, ...ref });
      const needsReview = conversationNeedsWork(conversation);
      if (conversation && needsReview) {
        rows.push({ ...ref, conversation, needsReview });
      }
    }
    return rows;
  }

  if (!envBool('EVAL_ENABLE_TABLE_SCAN', false)) {
    logEvent('info', 'conversation_eval_scan_disabled');
    return [];
  }

  const maxPages = Number(process.env.EVAL_SCAN_MAX_PAGES || DEFAULT_SCAN_PAGES);
  const maxConversations = Number(process.env.EVAL_MAX_CONVERSATIONS || DEFAULT_MAX_CONVERSATIONS);
  const rows: DueConversation[] = [];
  let exclusiveStartKey: ScanCommandOutput['LastEvaluatedKey'];
  let pages = 0;
  do {
    const response: ScanCommandOutput = await dynamodb.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression:
          'begins_with(#pk, :user_prefix) AND begins_with(#sk, :conversation_prefix) AND #turn_count > :zero',
        ExpressionAttributeNames: {
          '#pk': 'pk',
          '#sk': 'sk',
          '#turn_count': 'turn_count'
        },
        ExpressionAttributeValues: {
          ':user_prefix': { S: 'user#' },
          ':conversation_prefix': { S: 'conversation#' },
          ':zero': { N: '0' }
        },
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    for (const item of response.Items || []) {
      const subscriberHash = subscriberHashFromUserPk(item.pk?.S);
      const conversation = conversationSummaryFromItem(item);
      if (!subscriberHash || !conversation.id) continue;
      const needsReview = conversationNeedsWork(conversation);
      if (!needsReview) continue;
      rows.push({
        subscriberHash,
        conversation,
        needsReview
      });
    }
    exclusiveStartKey = response.LastEvaluatedKey;
    pages += 1;
  } while (exclusiveStartKey && pages < maxPages && rows.length < maxConversations * 4);
  rows.sort((a, b) => String(a.conversation.updated_at || '').localeCompare(String(b.conversation.updated_at || '')));
  return rows.slice(0, maxConversations);
}

export async function handler(event: DynamoDBStreamEvent = { Records: [] }) {
  const start = performance.now();
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME is required');
  const candidates = await dueConversations({ tableName, event });
  let reviewed = 0;
  let skipped = 0;
  let failed = 0;
  for (const { subscriberHash, conversation, needsReview } of candidates) {
    try {
      const conversationId = String(conversation.id || '');
      const turns = await loadConversationTurns({ tableName, subscriberHash, conversationId });
      if (!turns.length) {
        skipped += 1;
        continue;
      }
      if (needsReview) {
        const result = await evaluateConversation({ conversation, turns });
        await updateUserConversationEvaluation({
          dynamodb,
          tableName,
          subscriberHash,
          conversationId,
          summary: result.summary,
          assessment: result.assessment,
          model: result.model,
          lastRequestId: conversation.last_request_id,
          logEvent
        });
        reviewed += 1;
        logEvent('info', 'conversation_evaluated', {
          conversation_id: conversation.id,
          subscriber_hash: subscriberHash,
          quality: result.assessment.quality,
          flags: result.assessment.flags,
          output_tokens: result.usage?.outputTokens
        });
      }
    } catch (error) {
      failed += 1;
      logEvent(
        'warning',
        'conversation_evaluation_failed',
        errorFields(error, {
          conversation_id: conversation.id,
          subscriber_hash: subscriberHash
        })
      );
    }
  }
  const payload = {
    ok: failed === 0,
    reviewed,
    skipped,
    failed,
    candidate_count: candidates.length,
    stream_record_count: Array.isArray(event.Records) ? event.Records.length : 0,
    duration_ms: Math.round(performance.now() - start)
  };
  logEvent('info', 'conversation_eval_completed', payload);
  return payload;
}
