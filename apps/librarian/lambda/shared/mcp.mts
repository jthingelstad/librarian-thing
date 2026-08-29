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
import { toolSpecs } from './archive-tools.mjs';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];

// Launch tool surface (design Phase 3). The fast-follow wave widens this.
export const MCP_LAUNCH_TOOLS = ['search_archive', 'get_source', 'archive_lens', 'latest_content', 'corpus_stats'];

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
  const wanted = new Set(names);
  return (toolSpecs() as BedrockToolSpec[])
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

export function initializeResult(requestedVersion: unknown) {
  return {
    protocolVersion: negotiatedProtocolVersion(requestedVersion),
    capabilities: { tools: { listChanged: false } },
    serverInfo: {
      name: 'librarian',
      title: "The Librarian - Jamie Thingelstad's archive",
      version: '1.0.0'
    },
    instructions: [
      "Tools for exploring Jamie Thingelstad's public archive: The Weekly Thing newsletter,",
      'the thingelstad.com blog, and the Another Thing podcast.',
      'Start broad with search_archive, then deepen with get_source; use archive_lens for',
      'how-things-changed-over-time questions, latest_content for freshness, and corpus_stats',
      'for what the archive contains. Cite Weekly Thing sources as WT<issue number>.'
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
      const result = await context.invokeTool(name, args);
      return {
        statusCode: 200,
        payload: rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 1) }],
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
