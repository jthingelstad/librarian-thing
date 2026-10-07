import Anthropic from '@anthropic-ai/sdk';
import { modelAcceptsSamplingParams, modelWritesProgressUpdates } from './aws-clients.mjs';

// Thingy's Claude calls go to the Anthropic API (2026-10): Bedrock would not
// offer the account the newer models. Cohere embed and rerank stay on Bedrock
// (shared/aws-clients.mts).

let client: Anthropic | undefined;

// Built on first use, not at import: ANTHROPIC_API_KEY arrives from the
// runtime secret (loadRuntimeSecrets), which runs after the modules load.
export function anthropic() {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
    client = new Anthropic({ apiKey });
  }
  return client;
}

// One cache breakpoint. A request may carry four; Thingy uses three: the end
// of the tool list, the static system prompt, and the newest message.
export const CACHE_BREAKPOINT = { type: 'ephemeral' } as const;

export function messageText(message: { content?: readonly unknown[] } | undefined) {
  const parts: string[] = [];
  for (const block of message?.content || []) {
    const entry = block as { type?: string; text?: string };
    if (entry.type === 'text' && entry.text) parts.push(entry.text);
  }
  return parts.join('\n').trim();
}

interface SpecEntry {
  toolSpec?: { name?: string; description?: string; inputSchema?: { json?: unknown } };
  cachePoint?: unknown;
}

// prompts/tool-specs.json keeps its published shape (toolSpec entries and a
// closing cachePoint), which the MCP surface and the evals read. The chat
// binds them here: a toolSpec becomes an Anthropic tool, and a cachePoint
// marks the tool before it as a cache breakpoint.
export function anthropicTools(entries: readonly unknown[]): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];
  for (const raw of entries) {
    const entry = raw as SpecEntry;
    if (entry.cachePoint) {
      const last = tools.at(-1);
      if (last) last.cache_control = CACHE_BREAKPOINT;
      continue;
    }
    const spec = entry.toolSpec;
    if (!spec?.name) continue;
    tools.push({
      name: spec.name,
      description: spec.description,
      input_schema: (spec.inputSchema?.json || { type: 'object' }) as Anthropic.Tool.InputSchema
    });
  }
  return tools;
}

// Sonnet 5.5 and Opus 5.5 return the notes they write between tool calls as
// thinking blocks, empty unless thinking.display is 'updates', which is still
// a beta. Their reasoning stays empty under 'updates'; only the notes carry text.
export const PROGRESS_UPDATES_BETA = 'thinking-display-updates-2026-08-18';

const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

// Medium is the documented starting point for chat and multistep tool use on
// Sonnet 5.5, and Opus 5.5's own default. THINGY_EFFORT overrides it.
function agentEffort(): (typeof AGENT_EFFORTS)[number] {
  const value = String(process.env.THINGY_EFFORT || '').trim();
  return (AGENT_EFFORTS as readonly string[]).includes(value) ? (value as (typeof AGENT_EFFORTS)[number]) : 'medium';
}

// Request settings for the chat agent's model turns.
export function agentInferenceConfig(modelId: string) {
  if (modelWritesProgressUpdates(modelId)) {
    // These models always think, and max_tokens covers the thinking as well
    // as the answer, so the old 2500 would cut answers off. 'updates' returns
    // the notes written between tool calls, which the reader sees stream.
    return {
      max_tokens: Number(process.env.BEDROCK_MAX_OUTPUT_TOKENS || '16000'),
      thinking: { type: 'adaptive' as const, display: 'updates' as const },
      output_config: { effort: agentEffort() },
      betas: [PROGRESS_UPDATES_BETA]
    };
  }
  return {
    max_tokens: Number(process.env.BEDROCK_MAX_OUTPUT_TOKENS || '2500'),
    // The 5-family rejects sampling params with a 400.
    ...(modelAcceptsSamplingParams(modelId) ? { temperature: Number(process.env.BEDROCK_TEMPERATURE || '0.45') } : {})
  };
}

export interface StreamedTurn {
  message: Anthropic.Beta.BetaMessage;
  // Text blocks only: on the last turn, the answer.
  text: string;
  // Everything the reader can see, in order: text blocks and progress notes.
  narration: string;
  stopReason: string;
  usage: Anthropic.Beta.BetaUsage;
}

function narrationText(message: { content?: readonly unknown[] }) {
  const parts: string[] = [];
  for (const block of message.content || []) {
    const entry = block as { type?: string; text?: string; thinking?: string };
    const text = entry.type === 'text' ? entry.text : entry.type === 'thinking' ? entry.thinking : '';
    if (text?.trim()) parts.push(text.trim());
  }
  return parts.join('\n\n');
}

// One streamed model turn, on the beta surface so progress updates can be
// asked for. Visible deltas (text and progress notes) go to onTextDelta as they
// arrive, with a paragraph break between blocks; the assembled message (thinking,
// text and tool_use blocks) comes back at the end, to be passed back unchanged.
export async function streamMessage(
  params: Parameters<Anthropic['beta']['messages']['stream']>[0],
  options: { onTextDelta?: (delta: string) => void; client?: Pick<Anthropic, 'beta'> } = {}
): Promise<StreamedTurn> {
  const stream = (options.client || anthropic()).beta.messages.stream(params);
  const onTextDelta = options.onTextDelta;
  if (onTextDelta) {
    let blockIndex = -1;
    stream.on('streamEvent', (event) => {
      if (event.type !== 'content_block_delta') return;
      const delta = event.delta;
      const piece = delta.type === 'text_delta' ? delta.text : delta.type === 'thinking_delta' ? delta.thinking : '';
      if (!piece) return;
      if (blockIndex >= 0 && event.index !== blockIndex) onTextDelta('\n\n');
      blockIndex = event.index;
      onTextDelta(piece);
    });
  }
  const message = await stream.finalMessage();
  return {
    message,
    text: messageText(message),
    narration: narrationText(message),
    stopReason: message.stop_reason || '',
    usage: message.usage
  };
}
