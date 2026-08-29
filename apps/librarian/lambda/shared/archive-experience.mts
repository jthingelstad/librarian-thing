// The agentic welcome: the short, warm opening message Thingy writes for a
// newly loaded chat. This module once also built Archive Sparks, Thingy
// Trails, and Curiosity Maps; those surfaces were retired 2026-08-29 in the
// streamline to a pure chat experience (see git history).
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Message } from '@aws-sdk/client-bedrock-runtime';
import { agentModel, bedrock } from './aws-clients.mjs';
import { sanitizeAnswerProse } from './answer-sanitizer.mjs';
import { logEvent as sharedLogEvent } from './logging.mjs';
import { agentSystemPrompt } from './prompts.mjs';
import { normalizeScope } from './scope.mjs';
import {
  conversationModeDefinition,
  conversationModePrompt,
  normalizeConversationMode
} from './conversation-modes.mjs';

const AGENT_SYSTEM_PROMPT = agentSystemPrompt();
const SERVICE_NAME = 'weekly-thing-librarian-stream';

interface ConversationSummary {
  title?: string;
  turn_count?: number;
  updated_at?: string;
}

interface WelcomeInput {
  conversations?: ConversationSummary[];
  scope?: unknown;
  readerContext?: unknown;
  mode?: unknown;
}

function logEvent(level: string, message: string, fields: Record<string, unknown> = {}) {
  sharedLogEvent(level, message, fields, SERVICE_NAME);
}

function bedrockMessageText(message: Message | undefined) {
  const parts: string[] = [];
  for (const content of message?.content || []) {
    if (content.text) parts.push(content.text);
  }
  return parts.join('\n').trim();
}

function welcomeInferenceConfig() {
  return {
    maxTokens: Number(process.env.BEDROCK_WELCOME_MAX_TOKENS || '320'),
    temperature: Number(process.env.BEDROCK_WELCOME_TEMPERATURE || '0.7')
  };
}

function welcomePrompt({ readerContext, conversations = [], scope, mode }: WelcomeInput) {
  const recent = (conversations || []).slice(0, 6);
  const modeDefinition = conversationModeDefinition(mode);
  const conversationLines = recent.length
    ? recent
        .map(
          (entry) =>
            `- ${entry.title || 'Untitled chat'} (${entry.turn_count || 0} turns, updated ${String(entry.updated_at || '').slice(0, 10) || 'unknown'})`
        )
        .join('\n')
    : 'No prior conversations found.';
  return [
    "Write Thingy's opening message for a newly loaded chat.",
    '',
    "Thingy is Jamie Thingelstad's archive agent. It can help the reader connect ideas, compare eras, recall prior threads, and explore The Weekly Thing newsletter, the thingelstad.com blog, and Another Thing podcast.",
    '',
    'Reader and session context:',
    readerContext || 'No reader-local context supplied.',
    '',
    'Recent Thingy conversations:',
    conversationLines,
    '',
    `Active source scope: ${normalizeScope(scope)}`,
    `Conversation mode: ${modeDefinition.label}`,
    '',
    'Mode guidance:',
    conversationModePrompt(mode),
    '',
    'Requirements:',
    '- Start with a natural greeting that can use the reader local time if supplied.',
    '- If a preferred name is known, use it. If no preferred name is known, ask what Thingy should call the reader, but keep it conversational.',
    '- If this looks like their first time, give a little more orientation. If returning, welcome them back and lightly reference recent conversations when they exist.',
    '- In Thought Partner mode, welcome Jamie as the author and invite a reflective thread rather than explaining Thingy to a general reader.',
    '- If they are a Weekly Thing Supporting Member, acknowledge that gracefully without making the whole message about it.',
    '- Do not frame Thingy as just search. Prefer agentic verbs like connect, trace, compare, explore, and pick up threads.',
    '- Keep it under 115 words, no heading, no table, no citations.'
  ].join('\n');
}

export async function generateWelcome({ readerContext, conversations = [], scope, mode }: WelcomeInput) {
  const start = performance.now();
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: agentModel(),
      system: [{ text: AGENT_SYSTEM_PROMPT }, { cachePoint: { type: 'default' } }],
      messages: [
        {
          role: 'user',
          content: [{ text: welcomePrompt({ readerContext, conversations, scope, mode }) }]
        }
      ],
      inferenceConfig: welcomeInferenceConfig()
    })
  );
  const answer = sanitizeAnswerProse(bedrockMessageText(response.output?.message)).trim();
  logEvent('info', 'welcome_generated', {
    model: agentModel(),
    mode: normalizeConversationMode(mode),
    conversation_count: (conversations || []).length,
    duration_ms: Math.round(performance.now() - start),
    output_tokens: response.usage?.outputTokens,
    answer_chars: answer.length
  });
  return answer || "Hi. I'm Thingy. Tell me what you're curious about and I'll help you explore Jamie's archive.";
}
