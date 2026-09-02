// The agentic welcome: the short, warm opening message Thingy writes for a
// newly loaded chat. This module once also built Archive Sparks, Thingy
// Trails, and Curiosity Maps; those surfaces were retired 2026-08-29 in the
// streamline to a pure chat experience (see git history).
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Message } from '@aws-sdk/client-bedrock-runtime';
import { agentModel, bedrock, modelAcceptsSamplingParams } from './aws-clients.mjs';
import { sanitizeAnswerProse } from './answer-sanitizer.mjs';
import { logEvent as sharedLogEvent } from './logging.mjs';
import { agentSystemPrompt } from './prompts.mjs';
import { normalizeScope } from './scope.mjs';
import { normalizeConversationMode } from './conversation-modes.mjs';

const AGENT_SYSTEM_PROMPT = agentSystemPrompt();
const SERVICE_NAME = 'weekly-thing-librarian-stream';

interface ConversationSummary {
  title?: string;
  turn_count?: number;
  updated_at?: string;
}

interface GroundingPassage {
  issue_number?: unknown;
  source_kind?: string;
  subject?: string;
  publish_date?: string;
  section?: string;
  text?: string;
  title?: string;
}

interface WelcomeInput {
  conversations?: ConversationSummary[];
  scope?: unknown;
  readerContext?: unknown;
  mode?: unknown;
  grounding?: GroundingPassage[];
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
    maxTokens: Number(process.env.BEDROCK_WELCOME_MAX_TOKENS || '450'),
    // The 5-family rejects sampling params with a ValidationException.
    ...(modelAcceptsSamplingParams(agentModel())
      ? { temperature: Number(process.env.BEDROCK_WELCOME_TEMPERATURE || '0.7') }
      : {})
  };
}

function groundingLines(grounding: GroundingPassage[] = []) {
  if (!grounding.length) return 'No archive material retrieved.';
  return grounding
    .map((passage) => {
      const label =
        passage.source_kind === 'weekly_thing' || passage.issue_number
          ? `WT${passage.issue_number}`
          : passage.source_kind || 'archive';
      const date = String(passage.publish_date || '').slice(0, 10);
      const snippet = String(passage.text || '')
        .replace(/\s+/g, ' ')
        .slice(0, 260);
      return `- [${label}${date ? ` ${date}` : ''}] ${passage.subject || passage.title || ''}${passage.section ? ` / ${passage.section}` : ''}: ${snippet}`;
    })
    .join('\n');
}

function welcomePrompt({ readerContext, conversations = [], scope, grounding = [] }: WelcomeInput) {
  const recent = (conversations || []).slice(0, 6);
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
    '',
    'Archive material retrieved just now (REAL corpus passages - the only',
    'permitted grounding for suggestions):',
    groundingLines(grounding),
    '',
    'Requirements:',
    '- Start with a natural greeting that can use the reader local time if supplied.',
    '- If a preferred name is known, use it. If no preferred name is known, ask what Thingy should call the reader, but keep it conversational.',
    '- If this looks like their first time, give a little more orientation. If returning, welcome them back and lightly reference recent conversations when they exist.',
    '- If they are a Weekly Thing Supporting Member, acknowledge that gracefully without making the whole message about it.',
    '- Do not frame Thingy as just search. Prefer agentic verbs like connect, trace, compare, explore, and pick up threads.',
    '- Keep it under 115 words, no heading, no table, no citations.',
    '',
    'After the welcome prose, on its own final line, output exactly:',
    'SUGGESTIONS: ["...", "...", "..."]',
    '- A JSON array of 2 or 3 tappable follow-up questions for the reader.',
    '- Each MUST be grounded in one of the archive passages above: name the',
    '  specific subject, story, or thread from that passage. Never invent',
    '  content and never write a generic question that any archive could',
    '  answer.',
    '- Skip subjects their recent conversations already covered.',
    '- Keep each under 90 characters, phrased as the reader asking Thingy.',
    '- If no archive material was retrieved, output SUGGESTIONS: []'
  ].join('\n');
}

export function parseWelcomeOutput(raw: string) {
  const match = /\n?\s*SUGGESTIONS:\s*(\[[\s\S]*?\])\s*$/.exec(raw);
  let suggestions: string[] = [];
  if (match) {
    try {
      const parsed: unknown = JSON.parse(match[1]);
      if (Array.isArray(parsed)) {
        suggestions = parsed
          .map((entry) => String(entry || '').trim())
          .filter((entry) => entry.length > 0 && entry.length <= 140)
          .slice(0, 3);
      }
    } catch {
      suggestions = [];
    }
  }
  const answer = (match ? raw.slice(0, match.index) : raw).trim();
  return { answer, suggestions };
}

export async function generateWelcome({
  readerContext,
  conversations = [],
  scope,
  mode,
  grounding = []
}: WelcomeInput) {
  const start = performance.now();
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: agentModel(),
      system: [{ text: AGENT_SYSTEM_PROMPT }, { cachePoint: { type: 'default' } }],
      messages: [
        {
          role: 'user',
          content: [{ text: welcomePrompt({ readerContext, conversations, scope, grounding }) }]
        }
      ],
      inferenceConfig: welcomeInferenceConfig()
    })
  );
  const { answer: rawAnswer, suggestions } = parseWelcomeOutput(bedrockMessageText(response.output?.message));
  const answer = sanitizeAnswerProse(rawAnswer).trim();
  logEvent('info', 'welcome_generated', {
    model: agentModel(),
    mode: normalizeConversationMode(mode),
    conversation_count: (conversations || []).length,
    grounding_count: grounding.length,
    suggestion_count: suggestions.length,
    duration_ms: Math.round(performance.now() - start),
    output_tokens: response.usage?.outputTokens,
    answer_chars: answer.length
  });
  return {
    answer: answer || "Hi. I'm Thingy. Tell me what you're curious about and I'll help you explore Jamie's archive.",
    suggestions
  };
}
