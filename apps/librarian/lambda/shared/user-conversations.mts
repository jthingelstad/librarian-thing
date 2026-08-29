import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { boundToolTrace } from './tool-evidence.mjs';

export const USER_CONVERSATION_LIMIT = 50;
export const USER_CONVERSATION_TURN_LIMIT = 80;
export const MAX_HISTORY_MESSAGES = 8;
export const MAX_HISTORY_CHARS = 4000;
export const MAX_ARTIFACT_JSON_CHARS = 20000;
// Raised from 16000 when per-call structured evidence landed (schema v2).
// boundToolTrace degrades individual calls to fit; the whole-trace
// {omitted: true} fallback below is only for unserializable input.
export const MAX_TOOL_TRACE_JSON_CHARS = 48000;

const CONVERSATION_ID_RE = /^[A-Za-z0-9_.:-]{1,96}$/;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = Record<string, unknown>;
type DynamoItem = Record<string, AttributeValue>;

export interface ConversationTurn {
  conversation_id?: unknown;
  request_id?: unknown;
  created_at?: unknown;
  scope?: unknown;
  mode?: unknown;
  question?: unknown;
  answer?: unknown;
  citations?: unknown[];
  artifact?: JsonObject | null;
  tool_names?: unknown[];
  [key: string]: unknown;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

export function userConversationPk(subscriberHash: unknown) {
  return `user#${subscriberHash}`;
}

export function conversationSk(conversationId: unknown) {
  return `conversation#${conversationId}`;
}

export function turnSkPrefix(conversationId: unknown) {
  return `turn#${conversationId}#`;
}

export function turnSk(conversationId: unknown, createdAt: unknown, requestId: unknown) {
  return `${turnSkPrefix(conversationId)}${createdAt}#${requestId}`;
}

export function validConversationId(value: unknown) {
  const text = String(value || '').trim();
  return CONVERSATION_ID_RE.test(text) ? text : '';
}

export function conversationTitle(question: unknown) {
  const text = String(question || '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 80) : 'Untitled chat';
}

export function conversationPreview(question: unknown) {
  return String(question || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export function dynamoString(value: unknown): AttributeValue {
  return { S: String(value || '') };
}

export function dynamoNumber(value: unknown): AttributeValue {
  return { N: String(Number(value || 0)) };
}

export function dynamoList(
  values: readonly unknown[] = [],
  mapper: (value: unknown) => AttributeValue = dynamoString
): AttributeValue {
  return { L: values.map(mapper) };
}

export function fromDynamoAttr(av: AttributeValue | undefined): JsonValue {
  if (av == null || typeof av !== 'object') return null;
  if ('S' in av) return av.S ?? '';
  if ('N' in av) return Number(av.N);
  if ('BOOL' in av) return Boolean(av.BOOL);
  if ('NULL' in av) return null;
  if ('L' in av) return (av.L || []).map(fromDynamoAttr);
  if ('M' in av) return Object.fromEntries(Object.entries(av.M || {}).map(([k, v]) => [k, fromDynamoAttr(v)]));
  return null;
}

export function preflightDynamoItem(preflight: unknown): AttributeValue {
  const value = objectValue(preflight);
  return {
    M: {
      action: dynamoString(value.action),
      category: dynamoString(value.category),
      original_question: dynamoString(String(value.original_question || '').slice(0, 1200)),
      rewritten_question: dynamoString(String(value.rewritten_question || '').slice(0, 1200)),
      direct_answer: dynamoString(String(value.direct_answer || '').slice(0, 2000)),
      rationale: dynamoString(String(value.rationale || '').slice(0, 500)),
      answer_guidance: dynamoString(String(value.answer_guidance || '').slice(0, 700))
    }
  };
}

function boundedText(value: unknown, max = 500) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function compactArtifactForStorage(artifact: unknown) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return null;
  const value = artifact as JsonObject;
  return {
    kind: boundedText(value.kind || 'artifact', 80),
    artifact_version: Number(value.artifact_version || value.version || 1),
    compacted: true,
    title: boundedText(value.title, 160),
    summary: boundedText(value.summary || value.description, 1000)
  };
}

export function artifactJsonForStorage(artifact: unknown) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return '';
  const value = artifact as JsonObject;
  const full = JSON.stringify(artifact);
  if (full.length <= MAX_ARTIFACT_JSON_CHARS) return full;
  const compact = compactArtifactForStorage(artifact);
  const compactJson = JSON.stringify(compact || {});
  if (compactJson.length <= MAX_ARTIFACT_JSON_CHARS) return compactJson;
  return JSON.stringify({
    kind: boundedText(value.kind || 'artifact', 80),
    artifact_version: Number(value.artifact_version || value.version || 1),
    compacted: true,
    title: boundedText(value.title, 160),
    omitted: true
  });
}

export function artifactDynamoString(artifact: unknown) {
  return dynamoString(artifactJsonForStorage(artifact));
}

export function boundedJsonForStorage(value: unknown, maxChars = MAX_TOOL_TRACE_JSON_CHARS) {
  if (value == null) return '';
  try {
    const json = JSON.stringify(value);
    if (json.length <= maxChars) return json;
    return JSON.stringify({
      compacted: true,
      omitted: true,
      original_chars: json.length
    });
  } catch {
    return '';
  }
}

export function toolTraceDynamoString(trace: unknown) {
  if (trace == null) return dynamoString('');
  try {
    const bounded = boundToolTrace(trace, MAX_TOOL_TRACE_JSON_CHARS);
    return dynamoString(JSON.stringify(bounded));
  } catch {
    return dynamoString(boundedJsonForStorage(trace, MAX_TOOL_TRACE_JSON_CHARS));
  }
}

export function citationDynamoItem(citation: JsonObject): AttributeValue {
  return {
    M: {
      issue_number: dynamoString(citation.issue_number),
      source_kind: dynamoString(citation.source_kind),
      subject: dynamoString(citation.subject),
      publish_date: dynamoString(citation.publish_date),
      section: dynamoString(citation.section),
      url: dynamoString(citation.url)
    }
  };
}

function itemObject(item: DynamoItem | undefined): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(item || {}).map(([key, value]) => [key, fromDynamoAttr(value)]));
}

export function conversationSummaryFromItem(item: DynamoItem | undefined) {
  const o = itemObject(item);
  const id = o.conversation_id || String(o.sk || '').replace(/^conversation#/, '');
  const tags = Array.isArray(o.tags) ? o.tags : [];
  const evalFlags = Array.isArray(o.eval_flags) ? o.eval_flags : [];
  const evalImprovements = Array.isArray(o.eval_improvements) ? o.eval_improvements : [];
  const titleSource = o.title_source || '';
  const title = titleSource === 'user' ? o.title : titleSource === 'eval' ? o.title : o.eval_topic || o.title;
  return {
    id: String(id || ''),
    conversation_id: String(id || ''),
    title: String(title || 'Untitled chat'),
    title_source: String(titleSource),
    preview: String(o.preview || ''),
    summary: String(o.summary || ''),
    topic: String(o.topic || ''),
    tags: tags.map(String),
    scope: String(o.scope || 'all'),
    mode: String(o.mode || 'thingy'),
    created_at: String(o.created_at || ''),
    updated_at: String(o.updated_at || o.created_at || ''),
    last_message_at: String(o.last_message_at || o.updated_at || ''),
    last_request_id: String(o.last_request_id || ''),
    turn_count: Number(o.turn_count || 0),
    eval_status: String(o.eval_status || ''),
    eval_quality: String(o.eval_quality || ''),
    eval_flags: evalFlags.map(String),
    eval_improvements: evalImprovements.map(String),
    eval_assessed_at: String(o.eval_assessed_at || ''),
    eval_model: String(o.eval_model || ''),
    eval_last_request_id: String(o.eval_last_request_id || ''),
    eval_topic: String(o.eval_topic || ''),
    eval_reader: String(o.eval_reader || ''),
    eval_thingy: String(o.eval_thingy || ''),
    eval_takeaway: String(o.eval_takeaway || '')
  };
}

export function conversationTurnFromItem(item: DynamoItem | undefined): ConversationTurn {
  const o = itemObject(item);
  let artifact = null;
  if (typeof o.artifact_json === 'string' && o.artifact_json) {
    try {
      const parsed = JSON.parse(o.artifact_json);
      artifact = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (error) {
      artifact = null;
    }
  }
  return {
    conversation_id: o.conversation_id || '',
    request_id: o.request_id || '',
    created_at: o.created_at || '',
    scope: o.scope || 'all',
    mode: o.mode || 'thingy',
    question: o.question || '',
    answer: o.answer || '',
    question_chars: Number(o.question_chars || 0),
    answer_chars: Number(o.answer_chars || 0),
    citation_count: Number(o.citation_count || 0),
    citations: Array.isArray(o.citations) ? o.citations : [],
    preflight: o.preflight && typeof o.preflight === 'object' ? o.preflight : null,
    feedback_reaction: o.feedback_reaction || '',
    feedback_at: o.feedback_at || '',
    feedback_comment: o.feedback_comment || '',
    model: o.model || '',
    duration_ms: Number(o.duration_ms || 0),
    output_tokens: Number(o.output_tokens || 0),
    stop_reason: o.stop_reason || '',
    tool_count: Number(o.tool_count || 0),
    tool_names: Array.isArray(o.tool_names) ? o.tool_names : [],
    tool_trace:
      typeof o.tool_trace_json === 'string' && o.tool_trace_json
        ? (() => {
            try {
              const parsed = JSON.parse(o.tool_trace_json);
              return parsed && typeof parsed === 'object' ? parsed : null;
            } catch {
              return null;
            }
          })()
        : null,
    artifact
  };
}

export function messagesFromTurns(turns: ConversationTurn[] = []) {
  const messages: Array<Record<string, unknown>> = [];
  for (const turn of [...turns].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
    if (turn.question) {
      messages.push({
        role: 'user',
        content: turn.question,
        scope: turn.scope,
        created_at: turn.created_at,
        request_id: turn.request_id
      });
    }
    if (turn.answer) {
      messages.push({
        role: 'assistant',
        content: turn.answer,
        citations: turn.citations || [],
        created_at: turn.created_at,
        request_id: turn.request_id,
        artifact: turn.artifact || null,
        tool_names: turn.tool_names || []
      });
    } else if (turn.artifact) {
      messages.push({
        role: 'assistant',
        content: '',
        citations: [],
        created_at: turn.created_at,
        request_id: turn.request_id,
        artifact: turn.artifact,
        tool_names: turn.tool_names || []
      });
    }
  }
  return messages;
}

export function historyFromTurns(
  turns: ConversationTurn[] = [],
  options: { maxMessages?: number; maxChars?: number } = {}
) {
  const maxMessages = Number(options.maxMessages || MAX_HISTORY_MESSAGES);
  const maxChars = Number(options.maxChars || MAX_HISTORY_CHARS);
  const messages = messagesFromTurns(turns);
  let chars = 0;
  const result: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const item of messages.slice(-maxMessages).reverse()) {
    const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : '';
    const content = String(item.content || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 700);
    if (!role || !content) continue;
    chars += content.length;
    if (chars > maxChars) break;
    result.unshift({ role, content });
  }
  return result;
}
