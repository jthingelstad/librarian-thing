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
import { serverVersion, toolTitle } from './prompts.mjs';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];

// Full read surface: every archive tool the chat agent binds.
export const MCP_LAUNCH_TOOLS = [
  'search_archive',
  'get_source',
  'archive_lens',
  'latest_content',
  'corpus_stats',
  'list_topics',
  'compare_eras',
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
  'on_this_day',
  'fetch_page',
  'web_search'
];

// Browser-facing subset served by the /tools route for the WebMCP page
// module: everything except the outbound-network tools - a page-hosted agent
// has its own web access, and asking this Lambda to fetch arbitrary URLs on
// a page agent's behalf is a different risk posture than reading the archive.
export const WEB_TOOLS = MCP_LAUNCH_TOOLS.filter((name) => name !== 'fetch_page' && name !== 'web_search');

// view_photo is MCP-only and lives outside the ARCHIVE_TOOLS registry on
// purpose: its result is image content blocks, which the Bedrock chat loop
// and the WebMCP page (which renders archive URLs natively) have no use
// for, and whose base64 must never land in audit rows or Converse text.
export const VIEW_PHOTO_TOOL = 'view_photo';

// Declared from the published spec (tool-specs.json) - the same text the
// chat loop binds, so the two surfaces cannot drift.
function viewPhotoDeclaration() {
  return mcpToolDeclarations([VIEW_PHOTO_TOOL])[0];
}

// The most a single tools/call returns (see fitToCap).
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
  // view_photo capability (photo-view.mts, audited by the runtime). Absent
  // means the surface does not offer the tool.
  viewPhoto?: (urls: unknown) => Promise<{
    photos: { url: string; mimeType: string; dataBase64: string; bytes: number }[];
    refused: { url: string; reason: string }[];
  }>;
}

export function mcpToolDeclarations(names: string[] = MCP_LAUNCH_TOOLS) {
  const wanted = new Set(names.filter((name) => name !== 'web_search' || webSearchConfigured()));
  return (availableToolSpecs() as BedrockToolSpec[])
    .map((spec) => spec.toolSpec)
    .filter((spec): spec is NonNullable<BedrockToolSpec['toolSpec']> => Boolean(spec?.name && wanted.has(spec.name)))
    .map((spec) => ({
      name: String(spec.name),
      // Display name: MCP clients render title when present, so readers
      // see "Archive statistics" instead of a prettified identifier.
      title: toolTitle(spec.name),
      annotations: { title: toolTitle(spec.name) },
      description: String(spec.description || ''),
      inputSchema: spec.inputSchema?.json || { type: 'object' }
    }));
}

// ── Tool errors ─────────────────────────────────────────────────────────
// A tool that cannot answer says so: the result goes out with isError: true
// and one code from this closed set, plus one next step. Handlers may set
// `code` and `next` themselves; otherwise the message decides.
export const TOOL_ERROR_CODES = [
  'bad_request',
  'not_found',
  'not_configured',
  'upstream_error',
  'too_large',
  'internal_error'
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

const NEXT_STEP: Record<ToolErrorCode, string> = {
  bad_request: "Check the arguments against this tool's input schema and call it again.",
  not_found: 'Find a valid id with search_archive, list_content or latest_content, then call again.',
  not_configured: 'This deployment does not offer that; use the archive tools instead.',
  upstream_error: 'The outside service failed; try again later or answer from the archive.',
  too_large: 'Narrow the arguments and call again.',
  internal_error: 'Try again; if it keeps failing, answer from another tool.'
};

function errorCodeFor(message: string): ToolErrorCode {
  if (/not found/i.test(message)) return 'not_found';
  if (/not configured/i.test(message)) return 'not_configured';
  if (/is required|needs a|must be|unknown argument/i.test(message)) return 'bad_request';
  return 'upstream_error';
}

function toolErrorRecord(result: JsonRecord): JsonRecord {
  const message = String(result.error);
  const declared = String(result.code || '');
  const code = (TOOL_ERROR_CODES as readonly string[]).includes(declared)
    ? (declared as ToolErrorCode)
    : errorCodeFor(message);
  const next = typeof result.next === 'string' && result.next ? result.next : NEXT_STEP[code];
  return { ...result, error: message, code, next };
}

// ── Argument validation ────────────────────────────────────────────────
// Arguments are checked against the declared schema BEFORE any quota is
// spent, so a malformed call costs nothing and says what was wrong. Scalars
// are accepted in either spelling a client might send ("12" for 12); an
// unknown argument, a bad enum, an out-of-range number or an inverted
// year_range is refused.
interface ArgSchema {
  type?: string | string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: ArgSchema;
  properties?: Record<string, ArgSchema>;
  required?: string[];
}

function matchesType(value: unknown, type: string) {
  if (type === 'string') return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
  if (type === 'integer') return Number.isInteger(value) || (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value));
  if (type === 'number')
    return (
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    );
  if (type === 'boolean') return typeof value === 'boolean' || value === 'true' || value === 'false';
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  return true;
}

function checkValue(path: string, value: unknown, schema: ArgSchema, problems: string[]) {
  if (value === null || value === undefined) return;
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  if (types.length && !types.some((type) => matchesType(value, type))) {
    problems.push(`${path} must be ${types.join(' or ')}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(`${path} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`);
  }
  if (typeof schema.minimum === 'number' || typeof schema.maximum === 'number') {
    const number = Number(value);
    if (
      Number.isFinite(number) &&
      ((typeof schema.minimum === 'number' && number < schema.minimum) ||
        (typeof schema.maximum === 'number' && number > schema.maximum))
    ) {
      problems.push(`${path} must be from ${schema.minimum ?? '-'} to ${schema.maximum ?? '-'}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      problems.push(`${path} needs at least ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      problems.push(`${path} takes at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => checkValue(`${path}[${index}]`, item, schema.items!, problems));
  }
}

export function validateToolArguments(name: string, args: unknown): string[] {
  if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
    return ['arguments must be an object'];
  }
  const record = (args || {}) as JsonRecord;
  const schema = (mcpToolDeclarations([name])[0]?.inputSchema || {}) as ArgSchema;
  const properties = schema.properties || {};
  const problems: string[] = [];
  for (const key of Object.keys(record)) {
    if (!(key in properties)) problems.push(`unknown argument "${key}"`);
  }
  for (const key of schema.required || []) {
    if (record[key] === undefined || record[key] === null || record[key] === '') problems.push(`${key} is required`);
  }
  for (const [key, value] of Object.entries(record)) {
    if (key in properties) checkValue(key, value, properties[key], problems);
  }
  for (const key of ['year_range', 'year_a', 'year_b']) {
    const range = record[key];
    if (Array.isArray(range) && range.length === 2 && Number(range[0]) > Number(range[1])) {
      problems.push(`${key} runs backwards: [${range[0]}, ${range[1]}] should be [${range[1]}, ${range[0]}]`);
    }
  }
  return problems;
}

/** The isError result for arguments that fail validation. */
export function invalidArgumentsResult(name: string, problems: string[]) {
  const spec = mcpToolDeclarations([name])[0];
  const accepted = Object.keys((spec?.inputSchema as { properties?: Record<string, unknown> })?.properties || {});
  return renderToolCallResult(name, {
    error: `Invalid arguments for ${name}: ${problems.join('; ')}.`,
    code: 'bad_request',
    accepted_arguments: accepted
  });
}

// ── Rendering under the cap ────────────────────────────────────────────
// Tool results are sized for the Bedrock loop, where 200KB of evidence is
// cheap context. MCP clients pay for every byte, so a result is cut to fit
// MCP_RESULT_MAX_CHARS - structurally, so it always parses: whole items
// come off the end of the largest list first (results are ranked), then the
// longest text is clipped, and a `truncated` block says what went where.

interface Found {
  path: string;
  size: number;
  array?: unknown[];
  parent?: JsonRecord | unknown[];
  key?: string | number;
  text?: string;
}

function survey(
  value: unknown,
  path: string,
  arrays: Found[],
  strings: Found[],
  parent?: JsonRecord | unknown[],
  key?: string | number
) {
  if (typeof value === 'string') {
    strings.push({ path, size: value.length, parent, key, text: value });
    return;
  }
  if (Array.isArray(value)) {
    arrays.push({ path, size: JSON.stringify(value).length, array: value });
    value.forEach((item, index) => survey(item, `${path}[]`, arrays, strings, value, index));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as JsonRecord)) {
      if (!path && childKey === 'truncated') continue;
      survey(child, path ? `${path}.${childKey}` : childKey, arrays, strings, value as JsonRecord, childKey);
    }
  }
}

function fitToCap(result: JsonRecord, max: number, hint: string) {
  let text = JSON.stringify(result);
  if (text.length <= max) return { text, truncated: false };
  const working = JSON.parse(text) as JsonRecord;
  const omitted: Record<string, number> = {};
  const clipped: string[] = [];
  for (let round = 0; round < 400; round++) {
    working.truncated = { max_chars: max, omitted, clipped, hint };
    text = JSON.stringify(working);
    const over = text.length - max;
    if (over <= 0) return { text, truncated: true };
    const arrays: Found[] = [];
    const strings: Found[] = [];
    survey(working, '', arrays, strings);
    const list = arrays.filter((found) => found.array!.length > 1).sort((a, b) => b.size - a.size)[0];
    const longest = strings.sort((a, b) => b.size - a.size)[0];
    if (list && (!longest || list.size >= longest.size)) {
      const items = list.array!;
      const perItem = list.size / items.length;
      const drop = Math.min(items.length - 1, Math.max(1, Math.ceil(over / perItem)));
      items.splice(items.length - drop, drop);
      omitted[list.path] = (omitted[list.path] || 0) + drop;
      continue;
    }
    if (longest && longest.size > 240) {
      const keep = Math.max(200, longest.size - over - 80);
      (longest.parent as Record<string | number, unknown>)[longest.key!] = `${longest.text!.slice(0, keep)}…`;
      if (!clipped.includes(longest.path)) clipped.push(longest.path);
      continue;
    }
    break;
  }
  return {
    text: JSON.stringify({
      ...toolErrorRecord({ error: 'The result was too large to return.', code: 'too_large', next: hint }),
      server_version: serverVersion()
    }),
    truncated: true
  };
}

function narrowingHint(name: string) {
  const spec = mcpToolDeclarations([name])[0];
  const paramNames = Object.keys((spec?.inputSchema as { properties?: Record<string, unknown> })?.properties || {});
  return paramNames.length
    ? `narrow the arguments (${paramNames.join(', ')}) for a complete result`
    : 'ask a narrower question for a complete result';
}

// Shared by MCP tools/call and the /tools web route so the two surfaces can
// never drift: an {error} result becomes an isError result with a code and a
// next step; anything else is stamped with server_version and fitted under
// the cap.
export function renderToolCallResult(name: string, invoked: unknown) {
  const record =
    invoked && typeof invoked === 'object' && !Array.isArray(invoked)
      ? (invoked as JsonRecord)
      : { result: invoked ?? null };
  if (typeof record.error === 'string' && record.error) {
    const text = JSON.stringify({ ...toolErrorRecord(record), server_version: serverVersion() });
    return { text, truncated: false, isError: true };
  }
  const fitted = fitToCap({ ...record, server_version: serverVersion() }, MCP_RESULT_MAX_CHARS, narrowingHint(name));
  return { ...fitted, isError: false };
}

/** A tool that threw: the isError result, naming only the error class. */
export function toolFailureResult(name: string, error: unknown) {
  return renderToolCallResult(name, {
    error: `Tool ${name} failed: ${error instanceof Error ? error.constructor.name : 'error'}`,
    code: 'internal_error'
  });
}

// Kept for callers that only want the text.
export function renderToolResultText(name: string, invoked: unknown) {
  const { text, truncated } = renderToolCallResult(name, invoked);
  return { text, truncated };
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

// Defined beside the prompt fingerprint so archive tools can stamp it too.
export { serverVersion };

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
      version: serverVersion(),
      // SEP-973 icon metadata (spec 2025-11-25). claude.ai currently ignores
      // this and derives custom-connector avatars from the registrable
      // domain's favicon (thingelstad.com - Jamie's photo); declared anyway
      // so the Thingy robot takes over the moment clients honor it.
      websiteUrl: 'https://thingy.thingelstad.com/',
      icons: [
        {
          src: 'https://thingy.thingelstad.com/img/thingy.png',
          mimeType: 'image/png',
          sizes: ['1022x1022']
        }
      ]
    },
    instructions: [
      "Tools for exploring Jamie Thingelstad's public archive: The Weekly Thing newsletter,",
      'the thingelstad.com blog, and the Another Thing podcast.',
      'Start broad with search_archive, then deepen with get_source; use archive_lens for',
      'how-things-changed-over-time questions, latest_content for freshness, and corpus_stats',
      'for what the archive contains. Cite Weekly Thing sources as WT<issue number>.',
      'Photos: media_search finds them; view_photo shows up to 3 inline and gives you vision over them.',
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
    const tools = [...mcpToolDeclarations(), ...(context.viewPhoto ? [viewPhotoDeclaration()] : [])];
    return { statusCode: 200, payload: rpcResult(id, { tools }) };
  }
  if (method === 'tools/call') {
    const name = String(params.name || '');
    const rawArgs = params.arguments === undefined ? {} : params.arguments;
    if (name === VIEW_PHOTO_TOOL && context.viewPhoto) {
      const problems = validateToolArguments(name, rawArgs);
      if (problems.length) {
        const { text } = invalidArgumentsResult(name, problems);
        return { statusCode: 200, payload: rpcResult(id, { content: [{ type: 'text', text }], isError: true }) };
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
        const { photos, refused } = await context.viewPhoto(args.image_urls);
        const summary = {
          shown: photos.map(({ url, bytes, mimeType }) => ({ url, bytes, mime_type: mimeType })),
          refused,
          server_version: serverVersion()
        };
        return {
          statusCode: 200,
          payload: rpcResult(id, {
            content: [
              ...photos.map((photo) => ({ type: 'image', data: photo.dataBase64, mimeType: photo.mimeType })),
              { type: 'text', text: JSON.stringify(summary) }
            ],
            isError: photos.length === 0
          })
        };
      } catch (error) {
        const { text } = toolFailureResult(name, error);
        return { statusCode: 200, payload: rpcResult(id, { content: [{ type: 'text', text }], isError: true }) };
      }
    }
    // Only what tools/list declares is callable: web_search without its key
    // is neither listed nor callable.
    if (!mcpToolDeclarations().some((tool) => tool.name === name)) {
      return { statusCode: 200, payload: rpcError(id, -32602, `Unknown tool: ${name}`) };
    }
    const problems = validateToolArguments(name, rawArgs);
    if (problems.length) {
      const { text } = invalidArgumentsResult(name, problems);
      return { statusCode: 200, payload: rpcResult(id, { content: [{ type: 'text', text }], isError: true }) };
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
    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as JsonRecord;
    try {
      const invoked = await context.invokeTool(name, args);
      const { text, isError } = renderToolCallResult(name, invoked);
      return { statusCode: 200, payload: rpcResult(id, { content: [{ type: 'text', text }], isError }) };
    } catch (error) {
      const { text } = toolFailureResult(name, error);
      return { statusCode: 200, payload: rpcResult(id, { content: [{ type: 'text', text }], isError: true }) };
    }
  }
  return { statusCode: 200, payload: rpcError(id, -32601, `Method not found: ${method}`) };
}
