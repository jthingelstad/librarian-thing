// The agentic welcome: the short, warm opening message Thingy writes for a
// newly loaded chat. This module once also built Archive Sparks, Thingy
// Trails, and Curiosity Maps; those surfaces were retired 2026-08-29 in the
// streamline to a pure chat experience (see git history).
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Message } from '@aws-sdk/client-bedrock-runtime';
import { bedrock, fastModel, modelAcceptsSamplingParams } from './aws-clients.mjs';
import { logEvent as sharedLogEvent } from './logging.mjs';
import { normalizeScope } from './scope.mjs';

const SERVICE_NAME = 'weekly-thing-librarian-stream';

// Compact, welcome-only system prompt. The full agent system prompt added
// seconds of input processing to a call whose entire job is chips and
// one-liners; the fast model with this prompt is the latency budget.
const WELCOME_SYSTEM_PROMPT = [
  "You write the opening furniture for Thingy, Jamie Thingelstad's archive agent over The Weekly Thing newsletter, the thingelstad.com blog, and the Another Thing podcast.",
  'You produce two things: short greeting lines and tappable suggestion questions, both grounded ONLY in archive material supplied in the request.',
  'Never invent archive content. Never use these phrases or their variants: "I\'m happy to", "I\'m all yours", "Want me to look?".'
].join('\n');

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
    ...(modelAcceptsSamplingParams(fastModel())
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

function welcomeSetPrompt({ conversations = [], scope, grounding = [] }: WelcomeInput) {
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
    "Produce Thingy's welcome set for a newly loaded chat.",
    '',
    'Recent Thingy conversations (avoid repeating their subjects):',
    conversationLines,
    '',
    `Active source scope: ${normalizeScope(scope)}`,
    '',
    'Archive material retrieved just now (REAL corpus passages - the only',
    'permitted grounding):',
    groundingLines(grounding),
    '',
    'Output EXACTLY two lines:',
    'GREETINGS: ["...", "...", "...", "...", "...", "..."]',
    'SUGGESTIONS: ["...", "...", "...", "...", "..."]',
    '',
    'GREETINGS rules - 6 one-line opening teases. Each stands ALONE as the',
    "only line on Thingy's new-chat screen, like a librarian who was mid-",
    'thought when the reader walked in:',
    '- No greeting words, no reader name, no questions about their name.',
    '- Each holds up something REAL and specific from the passages above -',
    '  a story, thread, or idea - with light, curious energy. First person',
    '  as Thingy. Think "I left this open for you", not "I can help you".',
    '- Under 90 characters each. No emoji, no citations, no exclamation runs.',
    '- Example shapes: "That barn-restoration thread is still open." /',
    '  "I found three different years arguing about RSS readers."',
    '',
    'SUGGESTIONS rules - 5 tappable questions (the client shows 3 and',
    'shuffles the rest in):',
    '- Each MUST be grounded in one of the archive passages above: name the',
    '  specific subject, story, or thread. Never generic.',
    '- Skip subjects their recent conversations already covered.',
    '- Under 90 characters, phrased as the reader asking Thingy.',
    '- If no archive material was retrieved, output SUGGESTIONS: []'
  ].join('\n');
}

function parseJsonLine(raw: string, label: string, maxLen: number, maxCount: number): string[] {
  const match = new RegExp(`${label}:\\s*(\\[[\\s\\S]*?\\])\\s*$`, 'm').exec(raw);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => String(entry || '').trim())
      .filter((entry) => entry.length > 0 && entry.length <= maxLen)
      .slice(0, maxCount);
  } catch {
    return [];
  }
}

export function parseWelcomeSetOutput(raw: string) {
  return {
    greeting_lines: parseJsonLine(raw, 'GREETINGS', 140, 6),
    suggestions: parseJsonLine(raw, 'SUGGESTIONS', 140, 6)
  };
}

export async function generateWelcomeSet({ conversations = [], scope, grounding = [] }: WelcomeInput) {
  const start = performance.now();
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: fastModel(),
      system: [{ text: WELCOME_SYSTEM_PROMPT }],
      messages: [
        {
          role: 'user',
          content: [{ text: welcomeSetPrompt({ conversations, scope, grounding }) }]
        }
      ],
      inferenceConfig: welcomeInferenceConfig()
    })
  );
  const set = parseWelcomeSetOutput(bedrockMessageText(response.output?.message));
  logEvent('info', 'welcome_set_generated', {
    model: fastModel(),
    conversation_count: (conversations || []).length,
    grounding_count: grounding.length,
    greeting_line_count: set.greeting_lines.length,
    suggestion_count: set.suggestions.length,
    duration_ms: Math.round(performance.now() - start),
    output_tokens: response.usage?.outputTokens
  });
  return set;
}
