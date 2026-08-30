/**
 * MCP protocol layer for the /mcp resource endpoint.
 *
 * Speaks MCP streamable HTTP in stateless single-response mode: every POST
 * carries one JSON-RPC message and gets one application/json reply. The tool
 * surface is the same ARCHIVE_TOOLS registry Thingy's own agent loop calls
 * in-process - parity by construction, per the Phase 1 design. Transport,
 * auth, rate limiting, and quota live in the runtime caller; this module is
 * pure protocol given a context and an invoke function.
 */
import { availableToolSpecs, webSearchConfigured } from './archive-tools.mjs';
import { promptFingerprint } from './prompts.mjs';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];

// Full read surface: every archive tool the chat agent binds.
export const MCP_LAUNCH_TOOLS = [
  'search_archive',
  'get_source',
  'archive_lens',
  'latest_content',
  'corpus_stats',
  'search_faq',
  'quote_search',
  'find_links',
  'list_content',
  'entity_lens',
  'source_neighborhood',
  'archive_gems',
  'claim_check',
  'media_search',
  'currently_history',
  'top_references',
  'fetch_page',
  'web_search'
];

// Tool results are sized for the Bedrock loop, where 200KB of evidence is
// cheap context. MCP clients pay tokens for every byte, so cap what a
// single tools/call returns and say so honestly when trimmed.
export const MCP_RESULT_MAX_CHARS = 48000;

export const MCP_QUOTA_ERROR_CODE = -32029;

type JsonRecord = Record<string, unknown>;

interface BedrockToolSpec {
  toolSpec?: {
    name?: string;
    description?: string;
    inputSchema?: { json?: JsonRecord };
  };
}

export interface McpContext {
  subscriberHash: string;
  entitlements: string[];
  scope: string;
  // Called for tools/call after the runtime has spent quota. Receives the
  // registry handler's context shape.
  invokeTool: (name: string, input: JsonRecord) => Promise<unknown>;
  // Returns true when the caller may spend one tool call; false ends the
  // request with a quota error.
  spendQuota: () => Promise<{ allowed: boolean; count: number; max: number }>;
}

export function mcpToolDeclarations(names: string[] = MCP_LAUNCH_TOOLS) {
  const wanted = new Set(names.filter((name) => name !== 'web_search' || webSearchConfigured()));
  return (availableToolSpecs() as BedrockToolSpec[])
    .map((spec) => spec.toolSpec)
    .filter((spec): spec is NonNullable<BedrockToolSpec['toolSpec']> => Boolean(spec?.name && wanted.has(spec.name)))
    .map((spec) => ({
      name: String(spec.name),
      description: String(spec.description || ''),
      inputSchema: spec.inputSchema?.json || { type: 'object' }
    }));
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function negotiatedProtocolVersion(requested: unknown) {
  const value = String(requested || '');
  return SUPPORTED_PROTOCOL_VERSIONS.includes(value) ? value : MCP_PROTOCOL_VERSION;
}

// The tool-surface cache key, also stamped onto tool responses
// (belt-and-braces: listChanged depends on client behavior we don't
// control; a version on the payload lets an agent detect a stale cached
// tools/list from any response).
export function serverVersion() {
  return `1.1.0+tools.${promptFingerprint()}`;
}

export function initializeResult(requestedVersion: unknown) {
  return {
    protocolVersion: negotiatedProtocolVersion(requestedVersion),
    // The tool list DOES change across deploys - declaring false told
    // clients to cache tools/list forever, and one did, reporting shipped
    // fixes as missing. This server is stateless single-response, so the
    // list_changed notification itself can never be delivered; the honest
    // signal is listChanged: true plus a serverInfo.version that changes
    // exactly when the tool surface does (the prompt fingerprint covers
    // tool-specs.json). Clients should re-fetch tools/list whenever the
    // version differs from their cache.
    capabilities: { tools: { listChanged: true } },
    serverInfo: {
      name: 'librarian',
      title: "The Librarian - Jamie Thingelstad's archive",
      version: serverVersion()
    },
    instructions: [
      "Tools for exploring Jamie Thingelstad's public archive: The Weekly Thing newsletter,",
      'the thingelstad.com blog, and the Another Thing podcast.',
      'Start broad with search_archive, then deepen with get_source; use archive_lens for',
      'how-things-changed-over-time questions, latest_content for freshness, and corpus_stats',
      'for what the archive contains. Cite Weekly Thing sources as WT<issue number>.',
      'The tool schemas evolve; serverInfo.version changes whenever they do - if it differs from your',
      'cached value, re-fetch tools/list before relying on cached parameter schemas.'
    ].join(' ')
  };
}

// One JSON-RPC message in, one HTTP-ready reply out. statusCode 202 with a
// null payload means "accepted notification, no body".
export async function handleMcpMessage(
  message: unknown,
  context: McpContext
): Promise<{ statusCode: number; payload: unknown }> {
  if (Array.isArray(message)) {
    // JSON-RPC batching was removed in the 2025-06-18 MCP revision.
    return { statusCode: 400, payload: rpcError(null, -32600, 'Batched requests are not supported.') };
  }
  const record = message && typeof message === 'object' ? (message as JsonRecord) : null;
  if (!record || record.jsonrpc !== '2.0' || typeof record.method !== 'string') {
    return { statusCode: 400, payload: rpcError(null, -32600, 'Expected a JSON-RPC 2.0 request.') };
  }
  const method = record.method;
  const id = 'id' in record ? record.id : undefined;
  const params = (record.params && typeof record.params === 'object' ? record.params : {}) as JsonRecord;
  const isNotification = id === undefined;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { statusCode: 202, payload: null };
  }
  if (isNotification) {
    // Unknown notifications are accepted and ignored per JSON-RPC.
    return { statusCode: 202, payload: null };
  }
  if (method === 'initialize') {
    return { statusCode: 200, payload: rpcResult(id, initializeResult(params.protocolVersion)) };
  }
  if (method === 'ping') {
    return { statusCode: 200, payload: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return { statusCode: 200, payload: rpcResult(id, { tools: mcpToolDeclarations() }) };
  }
  if (method === 'tools/call') {
    const name = String(params.name || '');
    if (!MCP_LAUNCH_TOOLS.includes(name)) {
      return { statusCode: 200, payload: rpcError(id, -32602, `Unknown tool: ${name}`) };
    }
    const quota = await context.spendQuota();
    if (!quota.allowed) {
      return {
        statusCode: 200,
        payload: rpcError(
          id,
          MCP_QUOTA_ERROR_CODE,
          `Daily tool-call quota reached (${quota.max} per day). It resets at midnight UTC.`
        )
      };
    }
    const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as JsonRecord;
    try {
      const invoked = await context.invokeTool(name, args);
      const result =
        invoked && typeof invoked === 'object' && !Array.isArray(invoked)
          ? { ...(invoked as JsonRecord), server_version: serverVersion() }
          : invoked;
      let text = JSON.stringify(result ?? null, null, 1);
      if (text.length > MCP_RESULT_MAX_CHARS) {
        // Name only parameters THIS tool actually accepts.
        const spec = mcpToolDeclarations([name])[0];
        const paramNames = Object.keys(
          (spec?.inputSchema as { properties?: Record<string, unknown> })?.properties || {}
        );
        const hint = paramNames.length ? `narrow the arguments (${paramNames.join(', ')})` : 'ask a narrower question';
        text =
          text.slice(0, MCP_RESULT_MAX_CHARS) +
          `\n... [truncated at ${MCP_RESULT_MAX_CHARS} characters; ${hint} for a complete result]`;
      }
      return {
        statusCode: 200,
        payload: rpcResult(id, {
          content: [{ type: 'text', text }],
          isError: false
        })
      };
    } catch (error) {
      return {
        statusCode: 200,
        payload: rpcResult(id, {
          content: [
            {
              type: 'text',
              text: `Tool ${name} failed: ${error instanceof Error ? error.constructor.name : 'error'}`
            }
          ],
          isError: true
        })
      };
    }
  }
  return { statusCode: 200, payload: rpcError(id, -32601, `Method not found: ${method}`) };
}
