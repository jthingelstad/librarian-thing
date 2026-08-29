import crypto from 'node:crypto';
import { ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import type {
  ContentBlock,
  Message,
  SystemContentBlock,
  TokenUsage,
  Tool,
  ToolResultBlock
} from '@aws-sdk/client-bedrock-runtime';
import type { Writable } from 'node:stream';
import type { LibrarianHttpEvent } from '../shared/http.mjs';
import {
  agentModel,
  advancedModel,
  bedrock,
  dynamodb,
  embeddingModel,
  fastModel,
  rerankModel
} from '../shared/aws-clients.mjs';
import { readConverseStream } from '../shared/bedrock-stream.mjs';
import { sanitizeAnswerProse } from '../shared/answer-sanitizer.mjs';
import {
  buildCuriosityMap,
  buildWelcomeSpark,
  experienceFromToolResults,
  generateWelcome
} from '../shared/archive-experience.mjs';
import { ARCHIVE_TOOLS, collectToolCitations, toolSpecs, weeklyIssueCatalog } from '../shared/archive-tools.mjs';
import {
  conversationContext,
  extractPreferredNameFromMessage,
  normalizeUserProfile,
  readerContextPrompt,
  tokenEntitlements
} from '../shared/chat-context.mjs';
import { evidencedIssueNumbers, prioritizeCitationsForAnswer } from '../shared/citations.mjs';
import type { Citation } from '../shared/citations.mjs';
import { normalizeScope, scopePromptLine } from '../shared/scope.mjs';
import { compactSource, retrieve } from '../shared/retrieval.mjs';
import { normalizeFeedbackReaction, validFeedbackRequestId } from '../shared/feedback.mjs';
import {
  PREFLIGHT_SYSTEM_PROMPT,
  normalizePreflightDecision,
  parsePreflightJson,
  passThroughPreflight
} from '../shared/prompt-preflight.mjs';
import { errorFields, truthyEnv } from '../shared/logging.mjs';
import { checkRateLimit } from '../shared/rate-limit.mjs';
import { methodAndPath, normalizeHeaders, parseBody } from '../shared/http.mjs';
import { agentSystemPrompt, agentUserPrompt } from '../shared/prompts.mjs';
import { extractBearer, verifyToken } from '../shared/session.mjs';
import { sessionAllowedForThingyProfile } from '../shared/profile-deletion.mjs';
import { getUserMemory, recordUserPreferredName, recordUserTurn } from '../shared/user-memory.mjs';
import { validConversationId } from '../shared/user-conversations.mjs';
import {
  getUserConversationMetadata,
  loadUserConversationHistory,
  loadUserConversationSummaries,
  recordUserArtifactConversation,
  recordUserConversationFeedback,
  recordUserConversationTurn
} from '../shared/conversation-store.mjs';
import {
  canUseConversationMode,
  conversationModeDefinition,
  conversationModePrompt,
  normalizeConversationMode
} from '../shared/conversation-modes.mjs';
import { LIBRARIAN_CONTRACT_VERSION, supportsRequestedContract } from '../shared/librarian-contract.mjs';

const DEFAULT_MAX_TOOL_TURNS = 7;
const DEFAULT_CHAT_SLOW_NOTICE_MS = 75000;
const DEFAULT_CHAT_DEADLINE_MS = 180000;
const RATE_LIMIT_MAX = 20;

type JsonRecord = Record<string, unknown>;
type Claims = Record<string, unknown>;
type ChatHistory = Parameters<typeof conversationContext>[0];
type ResponseStream = Writable;
type RequestSummary = Record<string, unknown>;
type PreflightDecision = ReturnType<typeof normalizePreflightDecision>;
type BedrockJson = NonNullable<Extract<NonNullable<ToolResultBlock['content']>[number], { json?: unknown }>['json']>;

interface AgentStreamOptions {
  scope?: unknown;
  mode?: unknown;
  readerContext?: unknown;
  preflight?: PreflightDecision | null;
  deadlineExceeded?: () => boolean;
  subscriberHash?: string;
  requestId?: string;
  conversationId?: string;
}

interface ToolTrace extends JsonRecord {
  calls: Array<Record<string, unknown>>;
}

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function errorName(error: unknown) {
  return error instanceof Error ? error.constructor.name : 'Error';
}

function logEvent(level: string, message: string, fields: JsonRecord = {}) {
  console.log(
    JSON.stringify({
      level,
      message,
      service: 'weekly-thing-librarian-stream',
      timestamp: Math.floor(Date.now() / 1000),
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null))
    })
  );
}

function privacyGuardAnswer(question: unknown) {
  const text = String(question || '').toLowerCase();
  const blockedPatterns = [
    /\b(home|street|personal)\s+address\b/,
    /\b(phone|cell|mobile)\s+(number|#)\b/,
    /\bwhere\s+does\s+jamie\s+live\b/,
    /\bwhat\s+city\s+does\s+jamie\s+live\s+in\b/,
    /\bwhere\s+is\s+jamie'?s\s+(home|house|residence)\b/,
    /\bjamie'?s\s+(home|house|residence)\s+(address|location)\b/
  ];
  if (!blockedPatterns.some((pattern) => pattern.test(text))) return '';
  return "I cannot help find or share Jamie's private home address or phone number. For public contact, use the contact links Jamie publishes on thingelstad.com or reply through the newsletter's normal public channels.";
}

function privacyPreflight(question: unknown) {
  const answer = privacyGuardAnswer(question);
  if (!answer) return null;
  return normalizePreflightDecision(
    {
      action: 'direct',
      category: 'privacy_refusal',
      direct_answer: answer,
      rationale: 'Deterministic privacy guard matched an explicit private-address or phone-number request.'
    },
    question
  );
}

export function retrieveSecretOk(body: JsonRecord) {
  const expected = process.env.LIBRARIAN_RETRIEVE_SECRET || '';
  if (!expected) return null;
  const expectedBuf = Buffer.from(expected, 'utf8');
  // Keep bridge_secret as a request-body alias so existing /retrieve clients
  // remain compatible while the deployment credential gets a neutral name.
  const suppliedBuf = Buffer.from(String(body.retrieve_secret || body.bridge_secret || ''), 'utf8');
  return expectedBuf.length === suppliedBuf.length && crypto.timingSafeEqual(expectedBuf, suppliedBuf);
}

async function updateUserMemoryAfterTurn(subscriberHash: string, preferredName: unknown) {
  await recordUserTurn(subscriberHash, { preferredName });
}

async function recordFeedback({
  subscriberHash,
  requestId,
  reaction,
  comment
}: {
  subscriberHash: string;
  requestId: unknown;
  reaction: unknown;
  comment: unknown;
}) {
  const tableName = process.env.TABLE_NAME;
  const validRequestId = validFeedbackRequestId(requestId);
  const validReaction = normalizeFeedbackReaction(reaction);
  const feedbackComment = String(comment || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 1000);
  if (!tableName) return { statusCode: 500, payload: { error: 'Thingy feedback is unavailable right now.' } };
  if (!validRequestId || !validReaction) {
    return { statusCode: 400, payload: { error: 'Feedback requires a valid request_id and reaction.' } };
  }

  const feedbackAt = new Date().toISOString();
  try {
    const result = await recordUserConversationFeedback({
      dynamodb,
      tableName,
      subscriberHash,
      requestId: validRequestId,
      reaction: validReaction,
      comment: feedbackComment,
      feedbackAt,
      logEvent
    });
    if (!result.found) {
      return {
        statusCode: 404,
        payload: { error: 'Conversation not found for feedback.', request_id: validRequestId }
      };
    }
    logEvent('info', 'feedback_recorded', {
      subscriber_hash: subscriberHash,
      request_id: validRequestId,
      reaction: validReaction,
      has_comment: Boolean(feedbackComment)
    });
    return {
      statusCode: 200,
      payload: { ok: true, request_id: validRequestId, reaction: validReaction, has_comment: Boolean(feedbackComment) }
    };
  } catch (error) {
    logEvent('warning', 'feedback_record_failed', { request_id: validRequestId, error_type: errorName(error) });
    return {
      statusCode: 500,
      payload: { error: 'Thingy could not save feedback right now.', request_id: validRequestId }
    };
  }
}

async function resolveRequestedConversationMode({
  body,
  payload,
  subscriberHash,
  conversationId
}: {
  body: JsonRecord;
  payload: Claims;
  subscriberHash: string;
  conversationId: string;
}) {
  const entitlements = tokenEntitlements(payload);
  const existing = conversationId
    ? await getUserConversationMetadata({
        dynamodb,
        tableName: process.env.TABLE_NAME,
        subscriberHash,
        conversationId
      })
    : null;
  const mode = existing?.mode || normalizeConversationMode(body.mode);
  if (!canUseConversationMode(mode, entitlements)) {
    return { ok: false, mode, entitlements, error: 'That Thingy mode is not available for this account.' };
  }
  return { ok: true, mode, entitlements, conversation: existing };
}

function bedrockMessageText(message: Message | undefined) {
  const parts: string[] = [];
  for (const content of message?.content || []) {
    if ('text' in content && content.text) parts.push(content.text);
  }
  return parts.join('\n').trim();
}

function writeSse(stream: ResponseStream, event: string, data: unknown) {
  stream.write(`event: ${event}\n`);
  stream.write(`data: ${JSON.stringify(data)}\n\n`);
}

function activityCommentaryText(value: unknown) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/([.!?])(?=\S)/g, '$1 ')
    .trim();
}

function shortToolValue(value: unknown, max = 80) {
  const text = String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
  return text.length <= max ? text : `${text.slice(0, max - 1).trim()}…`;
}

function quotedToolValue(value: unknown) {
  const text = shortToolValue(value);
  return text ? `“${text}”` : '';
}

function toolActivityCommentary(name: string, input: unknown = {}) {
  const value = objectValue(input);
  const query = quotedToolValue(
    value.query || value.topic || value.theme || value.entity || value.domain || value.claim
  );
  switch (name) {
    case 'search_faq':
      return query ? `Checking the FAQ for ${query}.` : 'Checking the public FAQ first.';
    case 'search_archive':
      return query ? `Searching archive text for ${query}.` : 'Searching the active archive sources.';
    case 'quote_search':
      return query ? `Looking for the exact phrase ${query}.` : 'Looking for exact wording in the archive.';
    case 'get_source':
      return value.url || value.source_id || value.issue_number
        ? 'Opening a promising source for fuller context.'
        : 'Opening source detail for context.';
    case 'get_issue':
      return value.issue_number
        ? `Opening WT${shortToolValue(value.issue_number, 12)} for issue-level context.`
        : 'Opening a Weekly Thing issue.';
    case 'get_section':
      return value.issue_number
        ? `Opening a specific section from WT${shortToolValue(value.issue_number, 12)}.`
        : 'Opening a specific archive section.';
    case 'find_links':
    case 'domain_history':
      return query ? `Tracing link metadata around ${query}.` : 'Tracing link and domain metadata.';
    case 'corpus_stats':
      return 'Checking aggregate corpus metadata and counts.';
    case 'latest_content':
      return 'Checking the freshest indexed sources.';
    case 'list_content':
      return 'Listing matching sources deterministically.';
    case 'archive_lens':
    case 'compare_eras':
      return query ? `Mapping ${query} across time and source types.` : 'Mapping the theme across the archive.';
    case 'source_neighborhood':
      return 'Inspecting the links and nearby sources around this item.';
    case 'entity_lens':
      return query ? `Checking where ${query} appears across the archive.` : 'Checking where the named entity appears.';
    case 'archive_gems':
      return query
        ? `Looking for a surprising archive spark around ${query}.`
        : 'Looking for a surprising archive spark.';
    case 'claim_check':
      return query ? `Verifying ${query} against archive evidence.` : 'Verifying the claim against archive evidence.';
    default:
      return 'Using an archive tool to narrow the answer.';
  }
}

function commandInferenceConfig() {
  return {
    maxTokens: Number(process.env.BEDROCK_MAX_OUTPUT_TOKENS || '2500'),
    temperature: Number(process.env.BEDROCK_TEMPERATURE || '0.45')
  };
}

function chatSlowNoticeMs() {
  const value = Number(process.env.CHAT_SLOW_NOTICE_MS || DEFAULT_CHAT_SLOW_NOTICE_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CHAT_SLOW_NOTICE_MS;
}

function chatDeadlineMs() {
  const value = Number(process.env.CHAT_DEADLINE_MS || DEFAULT_CHAT_DEADLINE_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CHAT_DEADLINE_MS;
}

function preflightInferenceConfig() {
  return {
    maxTokens: Number(process.env.BEDROCK_PREFLIGHT_MAX_TOKENS || '650'),
    temperature: Number(process.env.BEDROCK_PREFLIGHT_TEMPERATURE || '0')
  };
}

function preflightUserPrompt(
  question: unknown,
  scope: unknown,
  history: ChatHistory,
  context: { mode?: unknown; readerContext?: unknown } = {}
) {
  return [
    `Active source scope: ${normalizeScope(scope)}`,
    `Conversation mode: ${conversationModeDefinition(context.mode).label}`,
    `Recent conversation turns available to the main agent: ${Array.isArray(history) ? history.length : 0}`,
    '',
    'Conversation so far:',
    conversationContext(Array.isArray(history) ? history : []),
    '',
    'Reader context available to the main agent:',
    context.readerContext || 'No reader-local context supplied.',
    '',
    'Reader prompt:',
    String(question || '').trim()
  ].join('\n');
}

async function evaluatePromptPreflight(
  question: string,
  scope: unknown,
  history: ChatHistory = [],
  context: { mode?: unknown; readerContext?: unknown } = {}
) {
  const hardPrivacy = privacyPreflight(question);
  if (hardPrivacy) return hardPrivacy;
  if (!truthyEnv('LIBRARIAN_PREFLIGHT_ENABLED', '1')) {
    return passThroughPreflight(question, 'Preflight evaluator disabled; passed through.');
  }
  const start = performance.now();
  try {
    const response = await bedrock.send(
      new ConverseCommand({
        modelId: fastModel(),
        system: [{ text: PREFLIGHT_SYSTEM_PROMPT }],
        messages: [
          {
            role: 'user',
            content: [{ text: preflightUserPrompt(question, scope, history, context) }]
          }
        ],
        inferenceConfig: preflightInferenceConfig()
      })
    );
    const message = response.output?.message;
    const text = bedrockMessageText(message);
    const parsed = parsePreflightJson(text);
    const preflight = normalizePreflightDecision(parsed || {}, question);
    logEvent('info', 'prompt_preflight_completed', {
      action: preflight.action,
      category: preflight.category,
      mode: normalizeConversationMode(context.mode),
      duration_ms: Math.round(performance.now() - start),
      output_tokens: response.usage?.outputTokens
    });
    return preflight;
  } catch (error) {
    logEvent('warning', 'prompt_preflight_failed', { error_type: errorName(error) });
    return passThroughPreflight(question);
  }
}

function agentQuestionForPreflight(question: string, preflight: PreflightDecision | null | undefined) {
  if (!preflight || preflight.action !== 'rewrite') return question;
  const parts = ['Original reader prompt:', question, '', 'Preflight evaluator rewrite:', preflight.rewritten_question];
  if (preflight.answer_guidance) {
    parts.push('', 'Evaluator guidance:', preflight.answer_guidance);
  }
  parts.push(
    '',
    'Answer the reader by honoring the original prompt through the archive-shaped rewrite. Do not mention the preflight evaluator.'
  );
  return parts.join('\n');
}

const AGENT_SYSTEM_PROMPT = agentSystemPrompt();

function compactTraceValue(value: unknown, maxChars = 1200) {
  if (value == null) return value;
  if (typeof value === 'string') return value.slice(0, maxChars);
  try {
    const json = JSON.stringify(value);
    if (json.length <= maxChars) return value;
    return { compacted: true, chars: json.length, preview: json.slice(0, maxChars) };
  } catch {
    return { compacted: true };
  }
}

function countResultItems(value: unknown) {
  const result = objectValue(value);
  return [
    result.results,
    result.results_a,
    result.results_b,
    result.reading_path,
    result.related_sources,
    result.incoming_links,
    result.outgoing_links,
    result.cross_source_links
  ].reduce<number>((total, value) => total + (Array.isArray(value) ? value.length : 0), 0);
}

function traceToolResult(value: unknown) {
  const result = objectValue(value);
  return {
    error: result.error ? String(result.error).slice(0, 300) : '',
    result_count: countResultItems(result),
    total_count: Number(result.total_count || 0),
    scope: result.scope,
    source_kind: result.source_kind,
    mode: result.mode,
    topic: result.topic || result.theme || result.entity || ''
  };
}

async function streamBedrockAgentAnswer(
  question: string,
  history: ChatHistory,
  responseStream: ResponseStream,
  options: AgentStreamOptions = {}
) {
  const start = performance.now();
  const scope = normalizeScope(options.scope);
  const mode = normalizeConversationMode(options.mode);
  const readerContext = String(options.readerContext || '').trim();
  const agentQuestion = agentQuestionForPreflight(question, options.preflight);
  const shouldStopWriting = () => Boolean(options.deadlineExceeded?.());
  const messages: Message[] = [
    {
      role: 'user',
      content: [
        {
          text: agentUserPrompt({
            conversation_context: conversationContext(history),
            reader_context: readerContext || 'No reader-local context supplied.',
            question: agentQuestion
          })
        }
      ]
    }
  ];
  const toolResults: JsonRecord[] = [];
  const toolTrace: ToolTrace = { calls: [] };
  let answer = '';
  let usage: TokenUsage | undefined;
  let stopReason = '';
  const maxTurns = Number(process.env.MAX_TOOL_TURNS || DEFAULT_MAX_TOOL_TURNS);
  const turnLimit = maxTurns;
  type ToolHandler = (input?: JsonRecord, context?: JsonRecord) => unknown | Promise<unknown>;
  const toolHandlers = ARCHIVE_TOOLS as Record<string, ToolHandler>;
  const activeToolSpecs = toolSpecs() as Tool[];
  // The static system prompt is cached; per-request blocks go after the
  // cachePoint so they don't bust the static prompt's prefix cache.
  const systemBlocks: SystemContentBlock[] = [{ text: AGENT_SYSTEM_PROMPT }, { cachePoint: { type: 'default' } }];
  // Active scope varies per request, so it goes after the cachePoint as its
  // own block — it tells the agent which corpus it may speak from without
  // busting the static prompt's prefix cache.
  systemBlocks.push({ text: scopePromptLine(scope) });
  systemBlocks.push({ text: conversationModePrompt(mode) });
  for (let turn = 0; turn <= turnLimit; turn += 1) {
    // The reader disconnected at the client deadline - stop the work, not
    // just the writes, or the loop burns Bedrock turns nobody will see.
    if (shouldStopWriting()) break;
    const streamAnswerDeltas = toolResults.length > 0;
    // A rolling cachePoint on the newest message caches the whole growing
    // prefix (system prompt + conversation + tool results) between loop
    // turns and between conversation turns - without it every Bedrock call
    // re-paid for the full history.
    const messagesForRequest = messages.map((entry, index) =>
      index === messages.length - 1
        ? { ...entry, content: [...(entry.content || []), { cachePoint: { type: 'default' as const } }] }
        : entry
    );
    const response = await bedrock.send(
      new ConverseStreamCommand({
        modelId: agentModel(),
        system: systemBlocks,
        messages: messagesForRequest,
        toolConfig: {
          tools: activeToolSpecs
        },
        inferenceConfig: commandInferenceConfig()
      })
    );
    const result = await readConverseStream(response, {
      onTextDelta: streamAnswerDeltas
        ? (delta) => {
            if (shouldStopWriting()) return;
            writeSse(responseStream, 'answer_delta', { delta });
          }
        : undefined
    });
    const message = result.message;
    usage = result.usage || usage;
    stopReason = result.stopReason || stopReason;
    messages.push(message);
    const toolUses = (message.content || []).flatMap((block) =>
      'toolUse' in block && block.toolUse ? [block.toolUse] : []
    );
    if (!toolUses.length) {
      answer = bedrockMessageText(message) || result.text;
      break;
    }
    const commentary = activityCommentaryText(result.text);
    const resultBlocks: ContentBlock[] = [];
    for (const [index, toolUse] of toolUses.entries()) {
      const toolName = String(toolUse.name || 'unknown_tool');
      const toolUseId = String(toolUse.toolUseId || '');
      const toolInput = objectValue(toolUse.input);
      const toolNote = toolActivityCommentary(toolName, toolInput);
      const visibleNote = [index === 0 ? commentary : '', toolNote].filter(Boolean).join(' ');
      if (!shouldStopWriting()) {
        writeSse(responseStream, 'status', {
          kind: 'tool',
          tool_name: toolName,
          message: `Checking ${toolName.replaceAll('_', ' ')}...`,
          commentary: visibleNote
        });
      }
      const handler = toolHandlers[toolName];
      let result: JsonRecord;
      const toolStart = performance.now();
      let ok = true;
      try {
        result = handler
          ? objectValue(await handler(toolInput, { scope, subscriberHash: options.subscriberHash }))
          : { error: `Unknown tool: ${toolName}` };
      } catch (error) {
        ok = false;
        logEvent(
          'error',
          'tool_call_failed',
          errorFields(error, {
            request_id: options.requestId,
            conversation_id: options.conversationId,
            tool_name: toolName
          })
        );
        result = { error: `${toolName} failed: ${errorName(error)}` };
      }
      toolTrace.calls.push({
        name: toolName,
        input: compactTraceValue(toolInput, 1000),
        ok: ok && !result.error,
        duration_ms: Math.round(performance.now() - toolStart),
        result: traceToolResult(result)
      });
      toolResults.push(result);
      resultBlocks.push({ toolResult: { toolUseId, content: [{ json: result as BedrockJson }] } });
    }
    messages.push({
      role: 'user',
      content: resultBlocks
    });
  }
  if (!answer) {
    if (stopReason === 'tool_use') {
      stopReason = 'tool_use_exhausted';
      answer = [
        'I found archive material for this, but I ran out of my research loop before I could turn it into a reliable answer.',
        'Try asking again with a narrower angle, or ask me to pick one specific source or time period.'
      ].join(' ');
    } else {
      answer = 'I could not produce a reliable answer from the archive tools for that question.';
    }
  }
  const sanitizedAnswer = sanitizeAnswerProse(answer);
  answer = sanitizedAnswer;
  // max_tokens truncation was previously logged but invisible to readers -
  // the answer just stopped mid-sentence. Say so in the answer itself.
  if (stopReason === 'max_tokens' && answer) {
    answer = `${answer}\n\n*This answer hit its length limit - ask me to continue and I will pick up where it cut off.*`;
  }
  if (!shouldStopWriting()) writeSse(responseStream, 'answer', { answer });
  const citations = prioritizeCitationsForAnswer(
    collectToolCitations(toolResults),
    answer,
    await weeklyIssueCatalog(),
    evidencedIssueNumbers(toolResults)
  );
  const experience = experienceFromToolResults(toolResults, answer, question);
  if (experience && !shouldStopWriting()) {
    writeSse(responseStream, 'experience', { experience });
  }
  logEvent('info', 'agent_streamed', {
    request_id: options.requestId,
    conversation_id: options.conversationId,
    model: agentModel(),
    scope,
    mode,
    tool_turns: toolResults.length,
    citation_count: citations.length,
    experience_kind: experience?.kind,
    duration_ms: Math.round(performance.now() - start),
    answer_chars: answer.length,
    output_tokens: usage?.outputTokens,
    stop_reason: stopReason,
    deadline_exceeded: shouldStopWriting()
  });
  return {
    answer,
    citations,
    experience,
    toolTrace,
    metrics: {
      model: agentModel(),
      duration_ms: Math.round(performance.now() - start),
      output_tokens: usage?.outputTokens,
      stop_reason: stopReason
    }
  };
}

function streamFromResponse(responseStream: ResponseStream, _event: LibrarianHttpEvent, statusCode: number) {
  return awslambda.HttpResponseStream.from(responseStream, {
    statusCode,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      'x-librarian-contract-version': LIBRARIAN_CONTRACT_VERSION
    }
  });
}

function jsonResponseStream(responseStream: ResponseStream, statusCode: number) {
  return awslambda.HttpResponseStream.from(responseStream, {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-librarian-contract-version': LIBRARIAN_CONTRACT_VERSION
    }
  });
}

async function handleCuriosityMapRoute({
  event,
  responseStream,
  requestId,
  summary,
  start
}: {
  event: LibrarianHttpEvent;
  responseStream: ResponseStream;
  requestId: string;
  summary: RequestSummary;
  start: number;
}) {
  const body = parseBody(event);
  const payload = verifyToken(extractBearer(event, body));
  if (!payload || !(await sessionAllowedForThingyProfile(payload))) {
    const s401 = jsonResponseStream(responseStream, 401);
    s401.write(
      JSON.stringify({ error: 'Please validate your subscriber email to use the librarian.', request_id: requestId })
    );
    s401.end();
    logEvent('warning', 'curiosity_map_unauthorized', { ...summary });
    return;
  }
  const subscriberHash = String(payload.sub || '');
  const requestedConversationId = validConversationId(body.conversation_id || body.conversationId);
  const modeAccess = await resolveRequestedConversationMode({
    body,
    payload,
    subscriberHash,
    conversationId: requestedConversationId
  });
  if (!modeAccess.ok) {
    const s403 = jsonResponseStream(responseStream, 403);
    s403.write(JSON.stringify({ error: modeAccess.error, request_id: requestId }));
    s403.end();
    return;
  }
  if (
    !(await checkRateLimit(`curiosity_map#${subscriberHash}`, Number(process.env.RATE_LIMIT_MAX || RATE_LIMIT_MAX)))
  ) {
    const s429 = jsonResponseStream(responseStream, 429);
    s429.write(JSON.stringify({ error: 'Thingy is at the hourly limit for this session.', request_id: requestId }));
    s429.end();
    return;
  }
  try {
    const scope = normalizeScope(body.scope);
    const conversations = await loadUserConversationSummaries({
      dynamodb,
      tableName: process.env.TABLE_NAME,
      subscriberHash,
      limit: 12,
      logEvent
    });
    const map = await buildCuriosityMap({
      conversations,
      scope,
      center: body.center || body.topic || body.query
    });
    const conversationId = requestedConversationId || crypto.randomUUID();
    const center = map.center?.label || String(map.title || '').replace(/^Curiosity Map:\s*/i, '') || 'archive';
    const conversation = await recordUserArtifactConversation({
      dynamodb,
      tableName: process.env.TABLE_NAME,
      subscriberHash,
      conversationId,
      artifact: map,
      scope,
      mode: modeAccess.mode,
      requestId,
      title: map.title || 'Curiosity Map',
      preview: `Explore branches from ${center}.`,
      logEvent,
      preserveConversationSummary: Boolean(requestedConversationId)
    });
    const s200 = jsonResponseStream(responseStream, 200);
    s200.write(JSON.stringify({ ...map, request_id: requestId, conversation_id: conversationId, conversation }));
    s200.end();
    logEvent('info', 'curiosity_map_completed', {
      ...summary,
      subscriber_hash: subscriberHash,
      conversation_id: conversationId,
      mode: modeAccess.mode,
      attached_to_existing_conversation: Boolean(requestedConversationId),
      node_count: map.nodes?.length || 0,
      source_count: map.sources?.length || 0,
      scope,
      duration_ms: Math.round(performance.now() - start)
    });
  } catch (error) {
    const s500 = jsonResponseStream(responseStream, 500);
    s500.write(JSON.stringify({ error: 'Thingy could not draw a curiosity map right now.', request_id: requestId }));
    s500.end();
    logEvent('error', 'curiosity_map_failed', { ...summary, error_type: errorName(error) });
  }
}

export const handler = awslambda.streamifyResponse<LibrarianHttpEvent>(async (event, responseStream, context) => {
  const start = performance.now();
  const requestId = context?.awsRequestId || event.requestContext?.requestId || crypto.randomUUID();
  const { method, path } = methodAndPath(event);
  const summary = { request_id: requestId, method, path, origin: normalizeHeaders(event.headers || {}).origin };
  if (!supportsRequestedContract(event.headers || {})) {
    const stream = jsonResponseStream(responseStream, 409);
    stream.write(
      JSON.stringify({
        error: 'This Thingy client uses an unsupported Librarian contract version.',
        contract_version: LIBRARIAN_CONTRACT_VERSION,
        request_id: requestId
      })
    );
    stream.end();
    logEvent('warning', 'contract_version_rejected', {
      ...summary,
      contract_version: LIBRARIAN_CONTRACT_VERSION
    });
    return;
  }
  let subscriberHash = '';
  logEvent('info', 'request_started', summary);

  if (method === 'OPTIONS') {
    const stream = streamFromResponse(responseStream, event, 204);
    stream.end();
    return;
  }

  if (method === 'GET' && path.endsWith('/health')) {
    const stream = jsonResponseStream(responseStream, 200);
    stream.write(
      JSON.stringify({
        ok: true,
        service: 'weekly-thing-librarian-stream',
        contract_version: LIBRARIAN_CONTRACT_VERSION,
        model: agentModel(),
        fast_model: fastModel(),
        advanced_model: advancedModel(),
        embedding_model: embeddingModel(),
        rerank_model: rerankModel()
      })
    );
    stream.end();
    logEvent('info', 'request_completed', { ...summary, duration_ms: Math.round(performance.now() - start) });
    return;
  }

  if (method === 'POST' && path.endsWith('/feedback')) {
    const body = parseBody(event);
    const payload = verifyToken(extractBearer(event, body));
    const active = payload ? await sessionAllowedForThingyProfile(payload) : false;
    const result =
      active && payload
        ? await recordFeedback({
            subscriberHash: String(payload.sub || ''),
            requestId: body.request_id,
            reaction: body.reaction,
            comment: body.comment
          })
        : {
            statusCode: 401,
            payload: { error: 'Please validate your subscriber email to use the librarian.', request_id: requestId }
          };
    const stream = jsonResponseStream(responseStream, result.statusCode);
    stream.write(JSON.stringify(result.payload));
    stream.end();
    logEvent('info', 'request_completed', {
      ...summary,
      status_code: result.statusCode,
      duration_ms: Math.round(performance.now() - start)
    });
    return;
  }

  if (method === 'POST' && path.endsWith('/retrieve')) {
    // Service retrieval. Same Bedrock embed → vector search → Cohere
    // rerank pipeline /chat uses, exposed as a passages-only JSON response
    // (no Sonnet call). Auth via LIBRARIAN_RETRIEVE_SECRET, not per-user token —
    // the caller is workshop_bot, not a reader. Used by compose-closer to
    // ground "From the Archive" picks on actual archive content rather
    // than vocabulary-only BM25 matches.
    const body = parseBody(event);
    const secretState = retrieveSecretOk(body);
    if (secretState === null) {
      const s503 = jsonResponseStream(responseStream, 503);
      s503.write(JSON.stringify({ error: 'Service retrieval is not enabled.' }));
      s503.end();
      logEvent('warning', 'retrieve_service_disabled', { ...summary });
      return;
    }
    if (!secretState) {
      const s401 = jsonResponseStream(responseStream, 401);
      s401.write(JSON.stringify({ error: 'Retrieval secret rejected.' }));
      s401.end();
      logEvent('warning', 'retrieve_bad_secret', { ...summary });
      return;
    }
    const query = String(body.query || '').trim();
    if (!query) {
      const s400 = jsonResponseStream(responseStream, 400);
      s400.write(JSON.stringify({ error: 'query is required.' }));
      s400.end();
      return;
    }
    if (!(await checkRateLimit('service#retrieve', Number(process.env.RETRIEVE_RATE_LIMIT_MAX || 600)))) {
      const s429 = jsonResponseStream(responseStream, 429);
      s429.write(JSON.stringify({ error: 'Retrieval rate limit exceeded. Try again shortly.' }));
      s429.end();
      logEvent('warning', 'retrieve_rate_limited', { ...summary });
      return;
    }
    const requestedK = Number(body.k || 12);
    const limit = Math.max(1, Math.min(Number.isFinite(requestedK) ? requestedK : 12, 40));
    const filters = objectValue(body.filters);
    // Optional scope (default weekly_thing). workshop_bot sends no scope, so
    // it keeps getting WT-only passages — unaffected by the blog corpus.
    filters.scope = normalizeScope(body.scope ?? filters.scope);
    try {
      const passages = await retrieve(query, limit, filters);
      const compact = passages.map((p) => compactSource(p, 1200));
      const s200 = jsonResponseStream(responseStream, 200);
      s200.write(
        JSON.stringify({
          passages: compact,
          embedding_model: embeddingModel(),
          rerank_model: rerankModel(),
          request_id: requestId
        })
      );
      s200.end();
      logEvent('info', 'retrieve_completed', {
        ...summary,
        query_chars: query.length,
        k: limit,
        passage_count: compact.length,
        duration_ms: Math.round(performance.now() - start)
      });
    } catch (error) {
      const s500 = jsonResponseStream(responseStream, 500);
      s500.write(JSON.stringify({ error: 'Retrieval failed.', request_id: requestId }));
      s500.end();
      logEvent('error', 'retrieve_failed', { ...summary, error_type: errorName(error) });
    }
    return;
  }

  if (method === 'POST' && path.endsWith('/curiosity-map')) {
    await handleCuriosityMapRoute({ event, responseStream, requestId, summary, start });
    return;
  }

  const isStreamRoute = method === 'POST' && (path.endsWith('/chat') || path.endsWith('/welcome'));
  const stream = streamFromResponse(responseStream, event, isStreamRoute ? 200 : 404);
  try {
    if (!isStreamRoute) {
      writeSse(stream, 'error', { error: 'Not found.', request_id: requestId });
      return;
    }

    const body = parseBody(event);
    const payload = verifyToken(extractBearer(event, body));
    if (!payload || !(await sessionAllowedForThingyProfile(payload))) {
      writeSse(stream, 'error', {
        error: 'Please validate your subscriber email to use the librarian.',
        request_id: requestId
      });
      return;
    }
    subscriberHash = String(payload.sub || '');

    if (path.endsWith('/welcome')) {
      const scope = normalizeScope(body.scope);
      const modeAccess = await resolveRequestedConversationMode({
        body,
        payload,
        subscriberHash,
        conversationId: ''
      });
      if (!modeAccess.ok) {
        writeSse(stream, 'error', { error: modeAccess.error, request_id: requestId });
        return;
      }
      const userProfile = normalizeUserProfile(body.user_profile);
      const memory = await getUserMemory(subscriberHash);
      const effectiveProfile = {
        ...userProfile,
        preferred_name: userProfile.preferred_name || memory?.preferred_name || '',
        returning: userProfile.returning || Number(memory?.turn_count || 0) > 0,
        turn_count: userProfile.turn_count ?? Number(memory?.turn_count || 0)
      };
      const readerContext = readerContextPrompt(body.client_context, effectiveProfile);
      const conversations = await loadUserConversationSummaries({
        dynamodb,
        tableName: process.env.TABLE_NAME,
        subscriberHash,
        limit: 8,
        logEvent
      });
      if (
        !(await checkRateLimit(`welcome#${String(payload.sub)}`, Number(process.env.RATE_LIMIT_MAX || RATE_LIMIT_MAX)))
      ) {
        writeSse(stream, 'error', { error: 'Thingy is at the hourly limit for this session.', request_id: requestId });
        return;
      }
      writeSse(stream, 'meta', { request_id: requestId, contract_version: LIBRARIAN_CONTRACT_VERSION });
      writeSse(stream, 'status', { message: 'Thingy is getting oriented...' });
      let spark = null;
      try {
        spark = await buildWelcomeSpark({ conversations, scope });
      } catch (error) {
        logEvent('warning', 'welcome_spark_failed', { error_type: errorName(error) });
      }
      if (spark) writeSse(stream, 'experience', { experience: spark });
      const answer = await generateWelcome({ readerContext, conversations, scope, mode: modeAccess.mode, spark });
      writeSse(stream, 'answer_delta', { delta: answer });
      writeSse(stream, 'done', { request_id: requestId, mode: modeAccess.mode });
      logEvent('info', 'welcome_completed', {
        subscriber_hash: subscriberHash,
        mode: modeAccess.mode,
        conversation_count: conversations.length,
        has_memory: Boolean(memory),
        has_preferred_name: Boolean(effectiveProfile.preferred_name),
        has_spark: Boolean(spark),
        duration_ms: Math.round(performance.now() - start)
      });
      return;
    }

    const question = String(body.message || '').trim();
    const scope = normalizeScope(body.scope);
    const userProfile = normalizeUserProfile(body.user_profile);
    const suppliedPreferredName = userProfile.preferred_name || extractPreferredNameFromMessage(question);
    let effectiveUserProfile = {
      ...userProfile,
      preferred_name: suppliedPreferredName || userProfile.preferred_name
    };
    let readerContext = readerContextPrompt(body.client_context, effectiveUserProfile);
    const requestedConversationId = validConversationId(body.conversation_id || body.conversationId);
    const conversationId = requestedConversationId || crypto.randomUUID();
    const modeAccess = await resolveRequestedConversationMode({
      body,
      payload,
      subscriberHash,
      conversationId: requestedConversationId
    });
    if (!modeAccess.ok) {
      writeSse(stream, 'error', { error: modeAccess.error, request_id: requestId });
      return;
    }
    const history = await loadUserConversationHistory({
      dynamodb,
      tableName: process.env.TABLE_NAME,
      subscriberHash,
      conversationId,
      logEvent
    });
    if (!question) {
      writeSse(stream, 'error', { error: 'Ask a question about the archive.', request_id: requestId });
      return;
    }
    if (question.length > Number(process.env.MAX_QUESTION_CHARS || '1200')) {
      writeSse(stream, 'error', { error: 'Please ask a shorter question.', request_id: requestId });
      return;
    }
    if (!(await checkRateLimit(String(payload.sub)))) {
      writeSse(stream, 'error', {
        error: 'The librarian is at the hourly limit for this session.',
        request_id: requestId
      });
      return;
    }
    if (effectiveUserProfile.preferred_name) {
      await recordUserPreferredName(subscriberHash, effectiveUserProfile.preferred_name);
    }

    // Fetch the user profile row so the preferred name reaches the prompt
    // even when the client didn't supply it.
    const userMemory = await getUserMemory(subscriberHash);
    if (!effectiveUserProfile.preferred_name && userMemory?.preferred_name) {
      effectiveUserProfile = {
        ...effectiveUserProfile,
        preferred_name: userMemory.preferred_name
      };
      readerContext = readerContextPrompt(body.client_context, effectiveUserProfile);
    }

    writeSse(stream, 'meta', {
      request_id: requestId,
      conversation_id: conversationId,
      mode: modeAccess.mode,
      contract_version: LIBRARIAN_CONTRACT_VERSION
    });
    writeSse(stream, 'status', { message: 'Understanding the request...' });
    const preflight = await evaluatePromptPreflight(question, scope, history, {
      readerContext,
      mode: modeAccess.mode
    });
    if (preflight.action === 'direct') {
      preflight.direct_answer = sanitizeAnswerProse(preflight.direct_answer);
      const citations: Citation[] = [];
      writeSse(stream, 'answer_delta', { delta: preflight.direct_answer });
      writeSse(stream, 'citations', { citations });
      const conversation = await recordUserConversationTurn({
        dynamodb,
        tableName: process.env.TABLE_NAME,
        subscriberHash,
        conversationId,
        question,
        answer: preflight.direct_answer,
        scope,
        mode: modeAccess.mode,
        requestId,
        citations,
        preflight,
        toolTrace: { calls: [] },
        metrics: {
          model: fastModel(),
          stop_reason: 'preflight_direct'
        },
        logEvent
      });
      writeSse(stream, 'done', {
        request_id: requestId,
        conversation_id: conversationId,
        conversation,
        mode: modeAccess.mode
      });
      // Guarded/direct turns still update memory — the question text was
      // recorded above, so let the user-memory row reflect that turn too.
      await updateUserMemoryAfterTurn(subscriberHash, effectiveUserProfile.preferred_name);
      return;
    }

    writeSse(stream, 'status', { message: 'Investigating the archive...' });
    let deadlineExceeded = false;
    const deadlineMs = chatDeadlineMs();
    const slowNoticeMs = Math.min(chatSlowNoticeMs(), Math.max(1000, deadlineMs - 1000));
    const slowNoticeTimer = setTimeout(() => {
      if (deadlineExceeded) return;
      try {
        writeSse(stream, 'status', {
          message: 'This is a deeper archive pass. Thingy is still working...'
        });
      } catch {}
      logEvent('info', 'chat_slow_notice_sent', {
        request_id: requestId,
        conversation_id: conversationId,
        subscriber_hash: subscriberHash,
        mode: modeAccess.mode,
        slow_notice_ms: slowNoticeMs,
        deadline_ms: deadlineMs
      });
    }, slowNoticeMs);
    const deadlineTimer = setTimeout(() => {
      deadlineExceeded = true;
      try {
        writeSse(stream, 'error', {
          error: 'Thingy spent too long in the archive. Please try again with a narrower angle.',
          request_id: requestId
        });
      } catch {}
      try {
        stream.end();
      } catch {}
      logEvent('warning', 'chat_deadline_exceeded', {
        request_id: requestId,
        conversation_id: conversationId,
        subscriber_hash: subscriberHash,
        mode: modeAccess.mode,
        deadline_ms: deadlineMs
      });
    }, deadlineMs);
    let result;
    try {
      result = await streamBedrockAgentAnswer(question, history, stream, {
        readerContext,
        scope,
        mode: modeAccess.mode,
        preflight,
        subscriberHash,
        requestId,
        conversationId,
        deadlineExceeded: () => deadlineExceeded
      });
    } finally {
      clearTimeout(slowNoticeTimer);
      clearTimeout(deadlineTimer);
    }
    if (deadlineExceeded) {
      await recordUserConversationTurn({
        dynamodb,
        tableName: process.env.TABLE_NAME,
        subscriberHash,
        conversationId,
        question,
        answer: 'Thingy spent too long in the archive before it could return a reliable answer.',
        scope,
        mode: modeAccess.mode,
        requestId,
        citations: [],
        preflight,
        toolTrace: result?.toolTrace || { calls: [] },
        metrics: {
          model: result?.metrics?.model || agentModel(),
          duration_ms: Math.round(performance.now() - start),
          output_tokens: result?.metrics?.output_tokens,
          stop_reason: 'app_deadline_exceeded'
        },
        logEvent
      });
      return;
    }
    const answer = result.answer;
    const citations = result.citations;
    const conversation = await recordUserConversationTurn({
      dynamodb,
      tableName: process.env.TABLE_NAME,
      subscriberHash,
      conversationId,
      question,
      answer,
      scope,
      mode: modeAccess.mode,
      requestId,
      citations,
      preflight,
      toolTrace: result.toolTrace,
      metrics: result.metrics,
      logEvent
    });
    writeSse(stream, 'citations', { citations });
    writeSse(stream, 'done', {
      request_id: requestId,
      conversation_id: conversationId,
      conversation,
      mode: modeAccess.mode
    });
    // Update per-user memory after the answer ships. If the sid has
    // rotated since the prior turn, this also triggers a Bedrock-
    // synthesized summary of the previous session.
    await updateUserMemoryAfterTurn(subscriberHash, effectiveUserProfile.preferred_name);
    logEvent('info', 'chat_completed', {
      subscriber_hash: subscriberHash,
      request_id: requestId,
      conversation_id: conversationId,
      mode: modeAccess.mode,
      question_chars: question.length,
      history_count: history.length,
      citation_count: citations.length,
      duration_ms: Math.round(performance.now() - start)
    });
  } catch (error) {
    logEvent(
      'error',
      'request_failed',
      errorFields(error, {
        ...summary,
        subscriber_hash: subscriberHash
      })
    );
    writeSse(stream, 'error', {
      error: 'The librarian could not generate an answer right now.',
      request_id: requestId
    });
  } finally {
    logEvent('info', 'request_completed', { ...summary, duration_ms: Math.round(performance.now() - start) });
    stream.end();
  }
});
