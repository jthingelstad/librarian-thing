import crypto from 'node:crypto';
import { GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import type { ContentBlock, Message, SystemContentBlock, Tool, ToolResultBlock } from '@aws-sdk/client-bedrock-runtime';
import type { Writable } from 'node:stream';
import type { LibrarianHttpEvent } from '../shared/http.mjs';
import {
  agentModel,
  bedrock,
  dynamodb,
  embeddingModel,
  fastModel,
  modelAcceptsSamplingParams,
  premiumModel,
  rerankModel
} from '../shared/aws-clients.mjs';
import { readConverseStream } from '../shared/bedrock-stream.mjs';
import { sanitizeAnswerProse } from '../shared/answer-sanitizer.mjs';
import {
  TOOL_TRACE_SCHEMA_VERSION,
  accumulateUsage,
  emptyUsageTotals,
  summarizeToolEvidence
} from '../shared/tool-evidence.mjs';
import { promptFingerprint } from '../shared/prompts.mjs';
import { generateWelcome } from '../shared/archive-experience.mjs';
import {
  ARCHIVE_TOOLS,
  availableToolSpecs,
  collectToolCitations,
  weeklyIssueCatalog
} from '../shared/archive-tools.mjs';
import {
  conversationContext,
  extractPreferredNameFromMessage,
  normalizeUserProfile,
  readerContextPrompt,
  sanitizeHistory,
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
import {
  chatDailyQuota,
  consumeDailyQuota,
  consumeDailyQuotaStrict,
  guestDailyQuota,
  guestGlobalDailyQuota,
  mcpDailyQuota,
  quotaMaxForEntitlements,
  webToolsDailyQuota
} from '../shared/quota.mjs';
import {
  MCP_RESULT_MAX_CHARS,
  WEB_TOOLS,
  handleMcpMessage,
  mcpToolDeclarations,
  renderToolResultText,
  serverVersion
} from '../shared/mcp.mjs';
import { recordMcpToolCall } from '../shared/mcp-audit-store.mjs';
import { validateAccessToken } from '../shared/oauth-store.mjs';
import { clientSourceIp, methodAndPath, normalizeHeaders, parseBody } from '../shared/http.mjs';
import { agentSystemPrompt, agentUserPrompt, toolTitle } from '../shared/prompts.mjs';
import { extractBearer, verifyToken } from '../shared/session.mjs';
import { resolveSessionToken } from '../shared/web-session.mjs';
import { sessionAllowedForThingyProfile } from '../shared/profile-deletion.mjs';
import { getUserMemory, recordUserPreferredName, recordUserTurn } from '../shared/user-memory.mjs';
import { validConversationId } from '../shared/user-conversations.mjs';
import {
  getUserConversationMetadata,
  loadUserConversationHistory,
  loadUserConversationSummaries,
  recordUserConversationFeedback,
  recordUserConversationTurn
} from '../shared/conversation-store.mjs';
import {
  canUseConversationMode,
  chatModelForReader,
  conversationModeDefinition,
  conversationModePrompt,
  normalizeConversationMode,
  isOwnerSubscriberHash
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
  // Restrict the agent to this tool subset (guest chat runs on WEB_TOOLS -
  // no outbound-network tools). Omitted = the full registry.
  toolNames?: readonly string[];
  // Model override: supporters and the owner route to the premium model.
  // Omitted = the fleet default.
  model?: string;
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
      return query ? `Looking for a surprising archive gem around ${query}.` : 'Looking for a surprising archive gem.';
    case 'claim_check':
      return query ? `Verifying ${query} against archive evidence.` : 'Verifying the claim against archive evidence.';
    default:
      return 'Using an archive tool to narrow the answer.';
  }
}

function commandInferenceConfig(modelId: string) {
  return {
    maxTokens: Number(process.env.BEDROCK_MAX_OUTPUT_TOKENS || '2500'),
    // The 5-family rejects sampling params with a ValidationException.
    ...(modelAcceptsSamplingParams(modelId) ? { temperature: Number(process.env.BEDROCK_TEMPERATURE || '0.45') } : {})
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
    // Bedrock usage rides along so preflight-direct turns can persist real
    // token metrics; preflightDynamoItem allow-lists fields, so this never
    // reaches storage through the preflight record itself.
    (preflight as JsonRecord).usage = response.usage;
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

// The deployed artifact identity, from the CloudFormation StreamCodeKey the
// deploy script already stamps (code/chat-lambda/<upload-ts>.zip). This is
// the smallest existing seam that uniquely names a deployed revision.
function sourceRevision() {
  const key = String(process.env.LIBRARIAN_SOURCE_REVISION || '');
  return key.replace(/^code\//, '').replace(/\.zip$/, '') || 'unknown';
}

// Every persisted trace - agent loop, preflight-direct, deadline fallback -
// carries the same version stamps so the evaluator can attribute any turn
// to a prompt set and deployed revision.
function stampedToolTrace(): ToolTrace {
  return {
    calls: [],
    schema_version: TOOL_TRACE_SCHEMA_VERSION,
    prompt_fingerprint: promptFingerprint(),
    source_revision: sourceRevision()
  };
}

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

async function streamBedrockAgentAnswer(
  question: string,
  history: ChatHistory,
  responseStream: ResponseStream,
  options: AgentStreamOptions = {}
) {
  const start = performance.now();
  const scope = normalizeScope(options.scope);
  const mode = normalizeConversationMode(options.mode);
  const modelId = String(options.model || agentModel());
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
  const toolTrace: ToolTrace = stampedToolTrace();
  let answer = '';
  // Usage accumulates across EVERY Bedrock turn of the loop - a 7-turn
  // research run previously recorded only the final call's tokens.
  const usageTotals = emptyUsageTotals();
  let stopReason = '';
  const maxTurns = Number(process.env.MAX_TOOL_TURNS || DEFAULT_MAX_TOOL_TURNS);
  const turnLimit = maxTurns;
  type ToolHandler = (input?: JsonRecord, context?: JsonRecord) => unknown | Promise<unknown>;
  const toolHandlers = ARCHIVE_TOOLS as Record<string, ToolHandler>;
  const allowedToolNames = Array.isArray(options.toolNames) ? new Set(options.toolNames.map(String)) : null;
  const activeToolSpecs = (availableToolSpecs() as Tool[]).filter(
    (tool) => !allowedToolNames || allowedToolNames.has(String(tool.toolSpec?.name || ''))
  );
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
        modelId,
        system: systemBlocks,
        messages: messagesForRequest,
        toolConfig: {
          tools: activeToolSpecs
        },
        inferenceConfig: commandInferenceConfig(modelId)
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
    accumulateUsage(usageTotals, result.usage);
    stopReason = result.stopReason || stopReason;
    messages.push(message);
    const toolUses = (message.content || []).flatMap((block) =>
      'toolUse' in block && block.toolUse ? [block.toolUse] : []
    );
    if (!toolUses.length) {
      answer = bedrockMessageText(message) || result.text;
      break;
    }
    // This turn's narration already streamed as answer deltas; without a
    // break the next turn's text glues straight onto its last sentence
    // ("...for RSS content.Great - WT48 has..."). Close the paragraph.
    if (streamAnswerDeltas && result.text.trim() && !shouldStopWriting()) {
      writeSse(responseStream, 'answer_delta', { delta: '\n\n' });
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
          message: `Checking ${toolTitle(toolName)}...`,
          commentary: visibleNote
        });
      }
      const handler = allowedToolNames && !allowedToolNames.has(toolName) ? undefined : toolHandlers[toolName];
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
        result: summarizeToolEvidence(result)
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

  logEvent('info', 'agent_streamed', {
    request_id: options.requestId,
    conversation_id: options.conversationId,
    model: modelId,
    scope,
    mode,
    tool_turns: toolResults.length,
    citation_count: citations.length,
    duration_ms: Math.round(performance.now() - start),
    answer_chars: answer.length,
    bedrock_calls: usageTotals.bedrock_calls,
    input_tokens: usageTotals.input_tokens,
    output_tokens: usageTotals.output_tokens,
    total_tokens: usageTotals.total_tokens,
    cache_read_input_tokens: usageTotals.cache_read_input_tokens,
    cache_write_input_tokens: usageTotals.cache_write_input_tokens,
    stop_reason: stopReason,
    deadline_exceeded: shouldStopWriting()
  });
  return {
    answer,
    citations,
    toolTrace,
    metrics: {
      model: modelId,
      duration_ms: Math.round(performance.now() - start),
      bedrock_calls: usageTotals.bedrock_calls,
      input_tokens: usageTotals.input_tokens,
      output_tokens: usageTotals.output_tokens,
      total_tokens: usageTotals.total_tokens,
      cache_read_input_tokens: usageTotals.cache_read_input_tokens,
      cache_write_input_tokens: usageTotals.cache_write_input_tokens,
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

function jsonResponseStream(responseStream: ResponseStream, statusCode: number, headers: Record<string, string> = {}) {
  return awslambda.HttpResponseStream.from(responseStream, {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-librarian-contract-version': LIBRARIAN_CONTRACT_VERSION,
      ...headers
    }
  });
}

const MCP_RATE_LIMIT_MAX = 300;

// One audited archive-tool invoker for every external tool door (/mcp and
// /tools). Runs the registry handler, records the bounded audit row with the
// calling surface, and logs the outcome; audit failures never fail the call.
function archiveToolInvoker({
  subscriberHash,
  requestId,
  surface
}: {
  subscriberHash: string;
  requestId: string;
  surface: 'mcp' | 'web';
}) {
  return async (name: string, input: JsonRecord) => {
    const handler = (ARCHIVE_TOOLS as Record<string, (input?: JsonRecord, context?: JsonRecord) => unknown>)[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    const toolStart = performance.now();
    const audit = async (result: unknown, status: 'ok' | 'tool_error', resultChars: number, durationMs: number) => {
      try {
        await recordMcpToolCall({
          dynamodb,
          tableName: process.env.TABLE_NAME,
          subscriberHash,
          requestId,
          createdAt: new Date().toISOString(),
          toolName: name,
          arguments: input,
          result,
          status,
          durationMs,
          sourceRevision: process.env.LIBRARIAN_SOURCE_REVISION,
          resultChars,
          responseTruncated: resultChars > MCP_RESULT_MAX_CHARS,
          responseMaxChars: MCP_RESULT_MAX_CHARS,
          surface
        });
      } catch (error) {
        logEvent('warning', 'mcp_tool_audit_failed', {
          request_id: requestId,
          tool_name: name,
          surface,
          error_type: errorName(error)
        });
      }
    };
    try {
      const toolResult = await handler(input, { scope: 'all', subscriberHash });
      const status = objectValue(toolResult).error ? 'tool_error' : 'ok';
      const durationMs = Math.round(performance.now() - toolStart);
      const resultChars = JSON.stringify(toolResult ?? null, null, 1).length;
      await audit(toolResult, status, resultChars, durationMs);
      logEvent('info', 'mcp_tool_call_completed', {
        request_id: requestId,
        tool_name: name,
        surface,
        status,
        duration_ms: durationMs,
        response_truncated: resultChars > MCP_RESULT_MAX_CHARS
      });
      return toolResult;
    } catch (error) {
      const durationMs = Math.round(performance.now() - toolStart);
      await audit({ error: errorName(error) }, 'tool_error', 0, durationMs);
      logEvent('warning', 'mcp_tool_call_completed', {
        request_id: requestId,
        tool_name: name,
        surface,
        status: 'tool_error',
        duration_ms: durationMs,
        error_type: errorName(error)
      });
      throw error;
    }
  };
}

// Browser-facing tool door for the WebMCP page module: same registry, same
// truncation, same audit pipeline as /mcp, but house-style JSON actions and
// web-session auth (cookie via the thingy distribution, or Bearer). Reached
// as /api/tools through the thingy CloudFront distribution.
const WEB_TOOLS_RATE_LIMIT_MAX = 120;

async function handleWebToolsRoute({
  event,
  responseStream,
  method,
  summary,
  start
}: {
  event: LibrarianHttpEvent;
  responseStream: ResponseStream;
  method: string;
  summary: JsonRecord;
  start: number;
}) {
  const finish = (statusCode: number, payload: unknown) => {
    const stream = jsonResponseStream(responseStream, statusCode, {});
    stream.write(JSON.stringify(payload));
    stream.end();
    logEvent('info', 'web_tools_request_completed', {
      ...summary,
      status_code: statusCode,
      duration_ms: Math.round(performance.now() - start)
    });
  };
  if (method !== 'POST') {
    finish(405, { error: 'Use POST for tool requests.' });
    return;
  }
  const body = parseBody(event);
  const payload = verifyToken(resolveSessionToken(event, body).token);
  if (!payload?.sub || !(await sessionAllowedForThingyProfile(payload))) {
    finish(401, { error: 'Please sign in at thingy.thingelstad.com to use the archive tools.' });
    return;
  }
  const subscriberHash = String(payload.sub);
  if (!(await checkRateLimit(`web_tools#${subscriberHash}`, WEB_TOOLS_RATE_LIMIT_MAX))) {
    finish(429, { error: 'Hourly tool-call limit reached. Please slow down and try again soon.' });
    return;
  }
  const action = String(body.action || 'list')
    .trim()
    .toLowerCase();
  if (action === 'list') {
    finish(200, { tools: mcpToolDeclarations(WEB_TOOLS), server_version: serverVersion() });
    return;
  }
  if (action !== 'call') {
    finish(400, { error: 'Unsupported tools action.' });
    return;
  }
  const name = String(body.tool || '');
  if (!WEB_TOOLS.includes(name)) {
    finish(400, { error: `Unknown tool: ${name}` });
    return;
  }
  const entitlements = tokenEntitlements(payload);
  const unlimited = isOwnerSubscriberHash(subscriberHash);
  const quota = unlimited
    ? { allowed: true, count: 0, max: 0 }
    : await consumeDailyQuota('web_tools', subscriberHash, quotaMaxForEntitlements(webToolsDailyQuota(), entitlements));
  if (!quota.allowed) {
    finish(429, {
      error: `Daily tool-call quota reached (${quota.max} per day). It resets at midnight UTC.`
    });
    return;
  }
  const args = objectValue(body.arguments);
  const invoke = archiveToolInvoker({
    subscriberHash,
    requestId: String(summary.request_id || ''),
    surface: 'web'
  });
  try {
    const invoked = await invoke(name, args);
    const { text, truncated } = renderToolResultText(name, invoked);
    finish(200, {
      content: [{ type: 'text', text }],
      is_error: false,
      truncated,
      server_version: serverVersion()
    });
  } catch (error) {
    finish(200, {
      content: [{ type: 'text', text: `Tool ${name} failed: ${errorName(error)}` }],
      is_error: true,
      server_version: serverVersion()
    });
  }
}

// MCP streamable HTTP endpoint in stateless single-response mode. Auth is a
// Librarian OAuth bearer token; the tool surface is the same ARCHIVE_TOOLS
// registry the /chat agent loop binds in-process.
async function handleMcpRoute({
  event,
  responseStream,
  method,
  summary,
  start
}: {
  event: LibrarianHttpEvent;
  responseStream: ResponseStream;
  method: string;
  summary: JsonRecord;
  start: number;
}) {
  const issuer = String(process.env.LIBRARIAN_OAUTH_ISSUER || 'https://librarian.thingelstad.com').replace(/\/$/, '');
  const wwwAuthenticate = `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`;
  const finish = (statusCode: number, payload: unknown, headers: Record<string, string> = {}) => {
    const stream = jsonResponseStream(responseStream, statusCode, headers);
    if (payload !== null) stream.write(JSON.stringify(payload));
    stream.end();
    logEvent('info', 'mcp_request_completed', {
      ...summary,
      status_code: statusCode,
      duration_ms: Math.round(performance.now() - start)
    });
  };
  if (method !== 'POST') {
    finish(405, { error: 'Use POST for MCP requests.' }, { allow: 'POST' });
    return;
  }
  const grant = await validateAccessToken(extractBearer(event));
  if (!grant) {
    finish(401, { error: 'A valid Librarian access token is required.' }, { 'www-authenticate': wwwAuthenticate });
    return;
  }
  if (
    !String(grant.scope || '')
      .split(/\s+/)
      .includes('archive:read')
  ) {
    finish(403, { error: 'This token does not carry the archive:read scope.' });
    return;
  }
  if (!(await checkRateLimit(`mcp#${grant.subscriberHash}`, MCP_RATE_LIMIT_MAX))) {
    finish(429, { error: 'MCP hourly rate limit reached. Please slow down.' });
    return;
  }
  let message: unknown;
  try {
    message = JSON.parse(
      String(event.body && event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body || '')
    );
  } catch {
    finish(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const unlimited = isOwnerSubscriberHash(grant.subscriberHash);
  const result = await handleMcpMessage(message, {
    subscriberHash: grant.subscriberHash,
    entitlements: grant.entitlements,
    scope: grant.scope,
    spendQuota: async () => {
      if (unlimited) return { allowed: true, count: 0, max: 0 };
      return consumeDailyQuota(
        'mcp',
        grant.subscriberHash,
        quotaMaxForEntitlements(mcpDailyQuota(), grant.entitlements)
      );
    },
    invokeTool: archiveToolInvoker({
      subscriberHash: grant.subscriberHash,
      requestId: String(summary.request_id || ''),
      surface: 'mcp'
    })
  });
  finish(result.statusCode, result.payload);
}

const GUEST_RATE_LIMIT_MAX = 10;

interface GuestChatContext {
  event: LibrarianHttpEvent;
  body: JsonRecord;
  stream: ResponseStream;
  requestId: string;
  start: number;
  rejectStream: (statusCode: number, reason: string, message: unknown) => void;
}

// Guest lane (Jamie's product call, 2026-09-01): a visitor can ask a few
// questions without signing in, so the archive links and shared
// conversations demo the real product. No conversation persistence, no
// memory, no profile, no email; history is client-supplied and sanitized;
// tools are WEB_TOOLS (archive-read only, no outbound network). Three
// stacked guards bound the unauthenticated Bedrock spend: the hourly IP
// rate limit, a per-visitor strict daily quota, and a global fail-closed
// circuit breaker. Kill switch: THINGY_GUEST_CHAT=off.
// Guest suggestion chips: one corpus-grounded set per UTC day, generated
// on first demand and cached in Dynamo, so guests get the same grounded
// first-tap moment at ~one model call per day instead of one per visitor.
const GUEST_SUGGESTIONS_TTL_SECONDS = 60 * 60 * 24 * 7;

async function loadOrGenerateGuestSuggestions(): Promise<string[]> {
  const day = new Date().toISOString().slice(0, 10);
  const key = { pk: { S: 'guestsuggestions' }, sk: { S: 'current' } };
  try {
    const existing = await dynamodb.send(new GetItemCommand({ TableName: process.env.TABLE_NAME, Key: key }));
    if (existing.Item?.day?.S === day) {
      const parsed: unknown = JSON.parse(existing.Item.suggestions?.S || '[]');
      return Array.isArray(parsed) ? parsed.map((entry) => String(entry || '')).filter(Boolean) : [];
    }
  } catch (error) {
    logEvent('warning', 'guest_suggestions_read_failed', { error_type: errorName(error) });
  }
  let suggestions: string[] = [];
  try {
    const grounding = await retrieve('memorable stories, ideas, and recurring threads in the archive', 6, {});
    const generated = await generateWelcome({
      readerContext: 'A first-time guest visitor with no prior context.',
      conversations: [],
      scope: 'all',
      mode: 'thingy',
      grounding
    });
    suggestions = generated.suggestions;
    await dynamodb.send(
      new PutItemCommand({
        TableName: process.env.TABLE_NAME,
        Item: {
          ...key,
          day: { S: day },
          suggestions: { S: JSON.stringify(suggestions) },
          ttl: { N: String(Math.floor(Date.now() / 1000) + GUEST_SUGGESTIONS_TTL_SECONDS) }
        }
      })
    );
  } catch (error) {
    logEvent('warning', 'guest_suggestions_generate_failed', { error_type: errorName(error) });
  }
  return suggestions;
}

async function handleGuestWelcome({
  event,
  stream,
  requestId,
  rejectStream
}: {
  event: LibrarianHttpEvent;
  stream: Writable;
  requestId: string;
  rejectStream: (statusCode: number, reason: string, message: string) => void;
}) {
  if (String(process.env.THINGY_GUEST_CHAT || 'on').toLowerCase() === 'off') {
    rejectStream(401, 'session_invalid', 'Please validate your subscriber email to use Thingy.');
    return;
  }
  const ip = clientSourceIp(event);
  const guestId = ip ? crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32) : '';
  if (!guestId || !(await checkRateLimit(`guestwelcome#${guestId}`, GUEST_RATE_LIMIT_MAX))) {
    rejectStream(429, 'guest_rate_limited', 'Try again in a bit.');
    return;
  }
  const suggestions = await loadOrGenerateGuestSuggestions();
  writeSse(stream, 'meta', { request_id: requestId, contract_version: LIBRARIAN_CONTRACT_VERSION, guest: true });
  if (suggestions.length) writeSse(stream, 'suggestions', { suggestions });
  writeSse(stream, 'done', { request_id: requestId, guest: true });
}

async function handleGuestChat({ event, body, stream, requestId, start, rejectStream }: GuestChatContext) {
  if (String(process.env.THINGY_GUEST_CHAT || 'on').toLowerCase() === 'off') {
    rejectStream(401, 'session_invalid', 'Please validate your subscriber email to use Thingy.');
    return;
  }
  const question = String(body.message || '').trim();
  if (!question) {
    rejectStream(400, 'empty_question', 'Ask a question about the archive.');
    return;
  }
  if (question.length > Number(process.env.MAX_QUESTION_CHARS || '1200')) {
    rejectStream(400, 'question_too_long', 'Please ask a shorter question.');
    return;
  }
  const ip = clientSourceIp(event);
  if (!ip) {
    rejectStream(401, 'guest_no_ip', 'Please sign in at thingy.thingelstad.com to use Thingy.');
    return;
  }
  const guestId = crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32);
  if (!(await checkRateLimit(`guestchat#${guestId}`, GUEST_RATE_LIMIT_MAX))) {
    rejectStream(429, 'guest_rate_limited', 'Guest questions are moving too fast. Try again in a bit, or sign in.');
    return;
  }
  const perVisitor = await consumeDailyQuotaStrict('guest', guestId, guestDailyQuota());
  if (!perVisitor.allowed) {
    rejectStream(
      429,
      'guest_daily_quota',
      "You've used today's guest questions. Sign in - free for Weekly Thing readers - to keep going."
    );
    return;
  }
  const globalPool = await consumeDailyQuotaStrict('guest', 'global', guestGlobalDailyQuota());
  if (!globalPool.allowed) {
    rejectStream(
      429,
      'guest_global_quota_exhausted',
      'Guest questions are done for today. Sign in - free for Weekly Thing readers - to keep asking.'
    );
    return;
  }
  const guestRemaining = Math.max(0, perVisitor.max - perVisitor.count);
  const scope = normalizeScope(body.scope);
  const history = sanitizeHistory(body.history);
  const readerContext =
    'Guest visitor previewing Thingy without an account. Do not reference account features, saved conversations, or personal history.';
  writeSse(stream, 'meta', {
    request_id: requestId,
    mode: 'thingy',
    guest: true,
    guest_remaining: guestRemaining,
    contract_version: LIBRARIAN_CONTRACT_VERSION
  });
  writeSse(stream, 'status', { message: 'Understanding the request...' });
  const preflight = await evaluatePromptPreflight(question, scope, history, { readerContext, mode: 'thingy' });
  if (preflight.action === 'direct') {
    preflight.direct_answer = sanitizeAnswerProse(preflight.direct_answer);
    writeSse(stream, 'answer_delta', { delta: preflight.direct_answer });
    writeSse(stream, 'citations', { citations: [] });
    writeSse(stream, 'done', { request_id: requestId, mode: 'thingy', guest: true, guest_remaining: guestRemaining });
    logEvent('info', 'guest_chat_completed', {
      guest_hash: guestId,
      request_id: requestId,
      preflight_direct: true,
      question_chars: question.length,
      guest_remaining: guestRemaining,
      duration_ms: Math.round(performance.now() - start)
    });
    return;
  }
  writeSse(stream, 'status', { message: 'Investigating the archive...' });
  let deadlineExceeded = false;
  const deadlineMs = chatDeadlineMs();
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
    logEvent('warning', 'guest_chat_deadline_exceeded', {
      guest_hash: guestId,
      request_id: requestId,
      deadline_ms: deadlineMs
    });
  }, deadlineMs);
  let result;
  try {
    result = await streamBedrockAgentAnswer(question, history, stream, {
      readerContext,
      scope,
      mode: 'thingy',
      preflight,
      subscriberHash: `guest#${guestId}`,
      requestId,
      conversationId: '',
      deadlineExceeded: () => deadlineExceeded,
      toolNames: WEB_TOOLS
    });
  } finally {
    clearTimeout(deadlineTimer);
  }
  if (deadlineExceeded) return;
  writeSse(stream, 'citations', { citations: result.citations });
  writeSse(stream, 'done', { request_id: requestId, mode: 'thingy', guest: true, guest_remaining: guestRemaining });
  logEvent('info', 'guest_chat_completed', {
    guest_hash: guestId,
    request_id: requestId,
    question_chars: question.length,
    citation_count: result.citations.length,
    guest_remaining: guestRemaining,
    duration_ms: Math.round(performance.now() - start)
  });
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
      status_code: 409,
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
        premium_model: premiumModel(),
        embedding_model: embeddingModel(),
        rerank_model: rerankModel()
      })
    );
    stream.end();
    logEvent('info', 'request_completed', {
      ...summary,
      status_code: 200,
      duration_ms: Math.round(performance.now() - start)
    });
    return;
  }

  if (method === 'POST' && path.endsWith('/feedback')) {
    const body = parseBody(event);
    const payload = verifyToken(resolveSessionToken(event, body).token);
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
            payload: { error: 'Please validate your subscriber email to use Thingy.', request_id: requestId }
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
      logEvent('warning', 'retrieve_service_disabled', { ...summary, status_code: 503 });
      return;
    }
    if (!secretState) {
      const s401 = jsonResponseStream(responseStream, 401);
      s401.write(JSON.stringify({ error: 'Retrieval secret rejected.' }));
      s401.end();
      logEvent('warning', 'retrieve_bad_secret', { ...summary, status_code: 401 });
      return;
    }
    const query = String(body.query || '').trim();
    if (!query) {
      const s400 = jsonResponseStream(responseStream, 400);
      s400.write(JSON.stringify({ error: 'query is required.' }));
      s400.end();
      logEvent('warning', 'retrieve_rejected', { ...summary, status_code: 400, reason: 'empty_query' });
      return;
    }
    if (!(await checkRateLimit('service#retrieve', Number(process.env.RETRIEVE_RATE_LIMIT_MAX || 600)))) {
      const s429 = jsonResponseStream(responseStream, 429);
      s429.write(JSON.stringify({ error: 'Retrieval rate limit exceeded. Try again shortly.' }));
      s429.end();
      logEvent('warning', 'retrieve_rate_limited', { ...summary, status_code: 429 });
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
      const compact = passages.map((p) => compactSource(p, 2000));
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
      logEvent('error', 'retrieve_failed', { ...summary, status_code: 500, error_type: errorName(error) });
    }
    return;
  }

  if (path.endsWith('/tools')) {
    await handleWebToolsRoute({ event, responseStream, method, summary, start });
    return;
  }

  if (path.endsWith('/mcp')) {
    await handleMcpRoute({ event, responseStream, method, summary, start });
    return;
  }

  const isStreamRoute = method === 'POST' && (path.endsWith('/chat') || path.endsWith('/welcome'));
  const stream = streamFromResponse(responseStream, event, isStreamRoute ? 200 : 404);
  // SSE responses are always HTTP 200 on the wire, so the terminal
  // request_completed line carries the logical outcome instead. Handled
  // rejections go through rejectStream so each one is countable in
  // CloudWatch (the chat_request_rejected metric filter matches them).
  let outcomeStatus = isStreamRoute ? 200 : 404;
  let outcomeReason = '';
  const rejectStream = (statusCode: number, reason: string, message: unknown) => {
    outcomeStatus = statusCode;
    outcomeReason = reason;
    logEvent('warning', 'chat_request_rejected', {
      ...summary,
      subscriber_hash: subscriberHash || undefined,
      status_code: statusCode,
      reason
    });
    writeSse(stream, 'error', { error: message, request_id: requestId });
  };
  try {
    if (!isStreamRoute) {
      rejectStream(404, 'not_found', 'Not found.');
      return;
    }

    const body = parseBody(event);
    const payload = verifyToken(resolveSessionToken(event, body).token);
    if (!payload || !(await sessionAllowedForThingyProfile(payload))) {
      // No valid session: /chat falls through to the guest lane; /welcome
      // serves the daily corpus-grounded guest suggestions (the client
      // keeps its own static guest greeting text).
      if (path.endsWith('/chat')) {
        await handleGuestChat({ event, body, stream, requestId, start, rejectStream });
        return;
      }
      if (path.endsWith('/welcome')) {
        await handleGuestWelcome({ event, stream, requestId, rejectStream });
        return;
      }
      rejectStream(401, 'session_invalid', 'Please validate your subscriber email to use Thingy.');
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
        rejectStream(403, 'mode_denied', modeAccess.error);
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
        rejectStream(429, 'rate_limited', 'Thingy is at the hourly limit for this session.');
        return;
      }
      if (!isOwnerSubscriberHash(subscriberHash)) {
        const welcomeMax = quotaMaxForEntitlements(
          chatDailyQuota(),
          Array.isArray(payload.entitlements) ? (payload.entitlements as string[]) : []
        );
        const quota = await consumeDailyQuota('chat', subscriberHash, welcomeMax);
        if (!quota.allowed) {
          rejectStream(
            429,
            'daily_quota_exceeded',
            "You've reached today's conversation limit. It resets at midnight UTC."
          );
          return;
        }
      }
      writeSse(stream, 'meta', { request_id: requestId, contract_version: LIBRARIAN_CONTRACT_VERSION });
      writeSse(stream, 'status', { message: 'Thingy is getting oriented...' });
      // Ground the suggestion chips in the corpus: retrieve real passages
      // near the reader's recent threads (recent-highlights for a first
      // visit) and hand them to the welcome model. Suggestions must cite
      // this material - never a canned question list.
      const suggestionQuery =
        conversations
          .slice(0, 3)
          .map((entry) => String(entry.title || '').trim())
          .filter(Boolean)
          .join('; ') || 'memorable stories, ideas, and recurring threads in the archive';
      let grounding: Awaited<ReturnType<typeof retrieve>> = [];
      try {
        grounding = await retrieve(suggestionQuery, 6, { scope });
      } catch (error) {
        logEvent('warning', 'welcome_grounding_failed', { error_type: errorName(error) });
      }
      const welcome = await generateWelcome({ readerContext, conversations, scope, mode: modeAccess.mode, grounding });
      writeSse(stream, 'answer_delta', { delta: welcome.answer });
      if (welcome.suggestions.length) {
        writeSse(stream, 'suggestions', { suggestions: welcome.suggestions });
      }
      writeSse(stream, 'done', { request_id: requestId, mode: modeAccess.mode });
      logEvent('info', 'welcome_completed', {
        subscriber_hash: subscriberHash,
        mode: modeAccess.mode,
        conversation_count: conversations.length,
        has_memory: Boolean(memory),
        has_preferred_name: Boolean(effectiveProfile.preferred_name),
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
    // Branch anchor from 4.3 clients: the request_id of the turn this
    // message follows. Context building and the recorded turn both use it
    // so edited/regenerated branches never see abandoned-branch turns.
    // Presence of the field matters: a branching-aware client sending ''
    // means "root turn - nothing precedes me" (an edit of the first
    // message), which becomes the 'root' sentinel so history stays empty.
    // Clients that omit the field entirely keep the legacy linear chain.
    const hasParentField = Object.prototype.hasOwnProperty.call(body || {}, 'parent_request_id');
    const parentRequestId = hasParentField ? String(body.parent_request_id || '').trim() || 'root' : '';
    const modeAccess = await resolveRequestedConversationMode({
      body,
      payload,
      subscriberHash,
      conversationId: requestedConversationId
    });
    if (!modeAccess.ok) {
      rejectStream(403, 'mode_denied', modeAccess.error);
      return;
    }
    const history = await loadUserConversationHistory({
      dynamodb,
      tableName: process.env.TABLE_NAME,
      subscriberHash,
      conversationId,
      parentRequestId,
      logEvent
    });
    if (!question) {
      rejectStream(400, 'empty_question', 'Ask a question about the archive.');
      return;
    }
    if (question.length > Number(process.env.MAX_QUESTION_CHARS || '1200')) {
      rejectStream(400, 'question_too_long', 'Please ask a shorter question.');
      return;
    }
    if (!(await checkRateLimit(String(payload.sub)))) {
      rejectStream(429, 'rate_limited', 'The librarian is at the hourly limit for this session.');
      return;
    }
    // Daily per-user budget pool (independent from the MCP pool). Rate
    // limits smooth bursts; this caps what any one reader can spend.
    if (!isOwnerSubscriberHash(subscriberHash)) {
      const chatMax = quotaMaxForEntitlements(
        chatDailyQuota(),
        Array.isArray(payload.entitlements) ? (payload.entitlements as string[]) : []
      );
      const quota = await consumeDailyQuota('chat', subscriberHash, chatMax);
      if (!quota.allowed) {
        rejectStream(
          429,
          'daily_quota_exceeded',
          "You've reached today's conversation limit. It resets at midnight UTC - see you tomorrow!"
        );
        return;
      }
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
        parentRequestId,
        answer: preflight.direct_answer,
        scope,
        mode: modeAccess.mode,
        requestId,
        citations,
        preflight,
        toolTrace: stampedToolTrace(),
        metrics: {
          model: fastModel(),
          ...accumulateUsage(emptyUsageTotals(), (preflight as JsonRecord).usage),
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
      logEvent('info', 'chat_completed', {
        subscriber_hash: subscriberHash,
        request_id: requestId,
        conversation_id: conversationId,
        mode: modeAccess.mode,
        preflight_direct: true,
        question_chars: question.length,
        history_count: history.length,
        citation_count: 0,
        duration_ms: Math.round(performance.now() - start)
      });
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
    // Supporters and the owner ride the premium model - same perk shape
    // as quota doubling: entitlement-routed, no mode machinery involved.
    const chatModel = chatModelForReader(
      subscriberHash,
      Array.isArray(payload.entitlements) ? (payload.entitlements as string[]) : []
    ).id;
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
        deadlineExceeded: () => deadlineExceeded,
        model: chatModel
      });
    } finally {
      clearTimeout(slowNoticeTimer);
      clearTimeout(deadlineTimer);
    }
    if (deadlineExceeded) {
      outcomeStatus = 504;
      outcomeReason = 'deadline_exceeded';
      await recordUserConversationTurn({
        dynamodb,
        tableName: process.env.TABLE_NAME,
        subscriberHash,
        conversationId,
        question,
        parentRequestId,
        answer: 'Thingy spent too long in the archive before it could return a reliable answer.',
        scope,
        mode: modeAccess.mode,
        requestId,
        citations: [],
        preflight,
        toolTrace: result?.toolTrace || stampedToolTrace(),
        metrics: {
          ...(result?.metrics || {}),
          model: result?.metrics?.model || agentModel(),
          duration_ms: Math.round(performance.now() - start),
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
      parentRequestId,
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
    outcomeStatus = 500;
    outcomeReason = 'unhandled_error';
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
    logEvent('info', 'request_completed', {
      ...summary,
      status_code: outcomeStatus,
      reason: outcomeReason || undefined,
      duration_ms: Math.round(performance.now() - start)
    });
    stream.end();
  }
});
