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

// A web-search answer arrives as a run of adjacent text blocks, split where
// each citation starts and ends ("Based on the results, " + "the cited
// claim" + "."). Adjacent text blocks are one passage and join as written;
// blocks with something between them (a tool call, a note) are separate.
function textRuns(content: readonly unknown[] | undefined, include: (type: string) => boolean) {
  const runs: string[] = [];
  let previousType = '';
  for (const block of content || []) {
    const entry = block as { type?: string; text?: string; thinking?: string };
    const type = String(entry.type || '');
    if (include(type)) {
      const text = (type === 'thinking' ? entry.thinking : entry.text) || '';
      if (type === 'text' && previousType === 'text' && runs.length) runs[runs.length - 1] += text;
      else runs.push(text);
    }
    previousType = type;
  }
  return runs.map((run) => run.trim()).filter(Boolean);
}

export function messageText(message: { content?: readonly unknown[] } | undefined) {
  return textRuns(message?.content, (type) => type === 'text')
    .join('\n')
    .trim();
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
  return textRuns(message.content, (type) => type === 'text' || type === 'thinking').join('\n\n');
}

// One streamed model turn, on the beta surface so progress updates can be
// asked for. Visible deltas (text and progress notes) go to onTextDelta as they
// arrive, with a paragraph break between blocks; the assembled message (thinking,
// text and tool_use blocks) comes back at the end, to be passed back unchanged.
// onServerToolUse hears each server-side tool call (web search) as it
// starts, before its query has streamed, so the reader sees the search begin.
export async function streamMessage(
  params: Parameters<Anthropic['beta']['messages']['stream']>[0],
  options: {
    onTextDelta?: (delta: string) => void;
    onServerToolUse?: (name: string) => void;
    client?: Pick<Anthropic, 'beta'>;
  } = {}
): Promise<StreamedTurn> {
  const stream = (options.client || anthropic()).beta.messages.stream(params);
  const { onTextDelta, onServerToolUse } = options;
  if (onTextDelta || onServerToolUse) {
    let blockIndex = -1;
    let blockType = '';
    stream.on('streamEvent', (event) => {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'server_tool_use') onServerToolUse?.(String(event.content_block.name || ''));
        return;
      }
      if (event.type !== 'content_block_delta' || !onTextDelta) return;
      const delta = event.delta;
      const piece = delta.type === 'text_delta' ? delta.text : delta.type === 'thinking_delta' ? delta.thinking : '';
      if (!piece) return;
      // A new block starts a new paragraph, except the next text block of a
      // cited run (see textRuns), which continues the same sentence.
      const citedRun = delta.type === 'text_delta' && blockType === 'text_delta' && event.index === blockIndex + 1;
      if (blockIndex >= 0 && event.index !== blockIndex && !citedRun) onTextDelta('\n\n');
      blockIndex = event.index;
      blockType = delta.type;
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

// Claude's own web search, run on Anthropic's servers (2026-10-07). Jamie
// asked for the model's search; the third-party Brave tool that stood in for
// it was removed in MCP 2.5.1, and none comes back. It binds in the
// signed-in chat only: guests, /mcp and /tools keep their own tool lists.
// THINGY_WEB_SEARCH=off unbinds it without a code change, for instance if
// the Console setting is ever switched off (the API then refuses any
// request that carries the tool).
export const WEB_SEARCH_TOOL = 'web_search';

export function webSearchEnabled() {
  return String(process.env.THINGY_WEB_SEARCH || '').trim() !== 'off';
}

// Searches per model call. A simple lookup takes one to three.
function webSearchMaxUses() {
  const value = Number(process.env.THINGY_WEB_SEARCH_MAX_USES || '5');
  return Number.isInteger(value) && value > 0 ? value : 5;
}

// Dynamic filtering (web_search_20260209: the model filters results in code
// before they reach its context) needs a 4.6-or-later model. Haiku 4.5, the
// fast tier, gets the basic search.
export function modelFiltersWebSearch(modelId: string) {
  return /(sonnet-4-6|sonnet-5|opus-4-[678]|opus-5|fable)/.test(modelId);
}

export function webSearchTool(modelId: string): Anthropic.Beta.BetaToolUnion {
  const maxUses = webSearchMaxUses();
  return modelFiltersWebSearch(modelId)
    ? { type: 'web_search_20260209', name: WEB_SEARCH_TOOL, max_uses: maxUses }
    : { type: 'web_search_20250305', name: WEB_SEARCH_TOOL, max_uses: maxUses };
}

// The archive tools plus web search, last, carrying the tool-list cache
// breakpoint so the list still ends on it.
export function withWebSearch(tools: readonly Anthropic.Beta.BetaToolUnion[], modelId: string) {
  const bound = tools.map((tool) => {
    if (!('cache_control' in tool) || !tool.cache_control) return tool;
    const copy = { ...tool };
    delete copy.cache_control;
    return copy;
  });
  return [...bound, { ...webSearchTool(modelId), cache_control: CACHE_BREAKPOINT } as Anthropic.Beta.BetaToolUnion];
}

export interface WebSearchCall {
  query: string;
  ok: boolean;
  results: number;
  error?: string;
}

export interface WebSearchActivity {
  searches: WebSearchCall[];
  // The pages the answer cites, once each, in order of first citation.
  sources: Array<{ url: string; title: string }>;
}

// What one model turn did on the web: each search with its outcome (a
// failed search still answers 200, with an error object where the result
// list would be), and the pages its text blocks cite.
export function webSearchActivity(content: readonly unknown[] | undefined): WebSearchActivity {
  const blocks = (content || []) as Array<Record<string, unknown>>;
  const outcomes = new Map<string, unknown>();
  for (const block of blocks) {
    if (block?.type === 'web_search_tool_result') outcomes.set(String(block.tool_use_id || ''), block.content);
  }
  const searches: WebSearchCall[] = [];
  for (const block of blocks) {
    if (block?.type !== 'server_tool_use' || block.name !== WEB_SEARCH_TOOL) continue;
    const input = (block.input || {}) as Record<string, unknown>;
    const outcome = outcomes.get(String(block.id || ''));
    const query = String(input.query || '');
    if (Array.isArray(outcome)) searches.push({ query, ok: true, results: outcome.length });
    else if (outcome && typeof outcome === 'object') {
      const code = String((outcome as Record<string, unknown>).error_code || 'unavailable');
      searches.push({ query, ok: false, results: 0, error: code });
    } else searches.push({ query, ok: false, results: 0, error: 'not_run' });
  }
  const sources: WebSearchActivity['sources'] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block?.type !== 'text' || !Array.isArray(block.citations)) continue;
    for (const raw of block.citations as Array<Record<string, unknown>>) {
      const url = String(raw?.url || '');
      if (raw?.type !== 'web_search_result_location' || !url || seen.has(url)) continue;
      seen.add(url);
      sources.push({ url, title: String(raw.title || '') });
    }
  }
  return { searches, sources };
}
