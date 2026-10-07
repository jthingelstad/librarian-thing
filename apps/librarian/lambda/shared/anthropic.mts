import Anthropic from '@anthropic-ai/sdk';

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

export interface StreamedTurn {
  message: Anthropic.Message;
  text: string;
  stopReason: string;
  usage: Anthropic.Usage;
}

// One streamed model turn. Text deltas go to onTextDelta as they arrive;
// the assembled message (text and tool_use blocks) comes back at the end.
export async function streamMessage(
  params: Anthropic.MessageStreamParams,
  options: { onTextDelta?: (delta: string) => void; client?: Pick<Anthropic, 'messages'> } = {}
): Promise<StreamedTurn> {
  const stream = (options.client || anthropic()).messages.stream(params);
  if (options.onTextDelta) stream.on('text', options.onTextDelta);
  const message = await stream.finalMessage();
  return {
    message,
    text: messageText(message),
    stopReason: message.stop_reason || '',
    usage: message.usage
  };
}
