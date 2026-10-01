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
import { PAGED_LISTS, mcpToolSpecs, webSearchConfigured } from './archive-tools.mjs';
import { PromptArgumentError, getPrompt, promptList } from './mcp-prompts.mjs';
import {
  RESOURCE_TEMPLATES,
  ResourceNotFound,
  listResources,
  parseResourceUri,
  readResource
} from './mcp-resources.mjs';
import { serverVersion, toolTitle } from './prompts.mjs';
import { absoluteSourceUrl } from './source-identity.mjs';

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
  'source_neighborhood',
  'archive_gems',
  'find_evidence',
  'media_search',
  'currently_history',
  'top_references',
  'on_this_day',
  'fetch_page',
  'web_search'
];

// The tools that reach past the archive to the live web. Every tool reads
// and nothing writes (readOnlyHint), and the MCP default for openWorldHint
// is true, so the closed-archive tools say false out loud.
const LIVE_WEB_TOOLS = new Set(['fetch_page', 'web_search']);

// Browser-facing subset served by the /tools route for the WebMCP page
// module: everything except the outbound-network tools - a page-hosted agent
// has its own web access, and asking this Lambda to fetch arbitrary URLs on
// a page agent's behalf is a different risk posture than reading the archive.
export const WEB_TOOLS = MCP_LAUNCH_TOOLS.filter((name) => name !== 'fetch_page' && name !== 'web_search');

// Tools 2.0.0 folded into others. A client with a cached tools/list still
// calls them; the answer names the replacement instead of "Unknown tool".
export const RETIRED_TOOLS: Record<string, string> = {
  entity_lens:
    'entity_lens was folded into archive_lens in 2.0.0: call archive_lens with topic, and aliases for other names (known aliases are added for you). Re-fetch tools/list.',
  claim_check:
    'claim_check became find_evidence in 2.0.0: pass claims (one to four statements); it returns the passages for each, and the verdict is yours. Re-fetch tools/list.'
};

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

interface ToolSpecEntry {
  toolSpec?: {
    name?: string;
    description?: string;
    inputSchema?: { json?: JsonRecord };
  };
  // The MCP surface's own wording, where the chat's does not fit a client
  // with no app around it, and the shape of a successful result.
  mcp?: { description?: string; outputSchema?: OutputSchema };
}

interface OutputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
}

// What a result left out (archive-tools markTruncated, then fitToCap):
// counts by list path, clipped texts, the cap that cut it, and for a paged
// list (2.1.0) the offset the next page starts at.
const TRUNCATED_SCHEMA = {
  type: 'object',
  properties: {
    omitted: { type: 'object', additionalProperties: { type: 'integer' } },
    clipped: { type: 'array', items: { type: 'string' } },
    max_chars: { type: 'integer' },
    next_offset: { type: 'integer', minimum: 1 },
    hint: { type: 'string' }
  },
  required: ['hint'],
  additionalProperties: false
};

// Every registry tool's result carries these (withAppliedEcho, then
// renderToolCallResult); the spec declares only each tool's own keys.
// view_photo is not a registry tool and declares its whole shape.
function withEnvelope(name: string, schema: OutputSchema | undefined): OutputSchema {
  const own = schema || { type: 'object' };
  if (name === VIEW_PHOTO_TOOL) return own;
  return {
    type: 'object',
    properties: {
      applied: { type: 'object' },
      ...(own.properties || {}),
      truncated: TRUNCATED_SCHEMA,
      server_version: { type: 'string' }
    },
    required: ['applied', ...(own.required || []), 'server_version']
  };
}

export interface McpContext {
  subscriberHash: string;
  entitlements: string[];
  scope: string;
  // Called for tools/call after the runtime has spent quota, and for
  // resources, which read through the same tools (auditAs names the audit
  // row: resource:<kind>).
  invokeTool: (name: string, input: JsonRecord, auditAs?: string) => Promise<unknown>;
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
  return (mcpToolSpecs() as ToolSpecEntry[])
    .filter((entry) => Boolean(entry.toolSpec?.name && wanted.has(entry.toolSpec.name)))
    .map(({ toolSpec, mcp }) => {
      const name = String(toolSpec!.name);
      return {
        name,
        // Display name: MCP clients render title when present, so readers
        // see "Archive statistics" instead of a prettified identifier.
        title: toolTitle(name),
        annotations: { title: toolTitle(name), readOnlyHint: true, openWorldHint: LIVE_WEB_TOOLS.has(name) },
        description: String(mcp?.description || toolSpec!.description || ''),
        // validateToolArguments refuses an undeclared argument; the schema
        // says so.
        inputSchema: { ...(toolSpec!.inputSchema?.json || { type: 'object' }), additionalProperties: false },
        // A successful call's structuredContent conforms to this.
        outputSchema: withEnvelope(name, mcp?.outputSchema)
      };
    });
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

export function toolErrorRecord(result: JsonRecord): JsonRecord {
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
// unknown argument, a bad enum, an out-of-range number, a text past its
// maxLength, an inverted
// year_range, or year and year_range together is refused.
interface ArgSchema {
  type?: string | string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
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
  // A term longer than the matcher compiles (QA2 L2-6), in characters.
  if (typeof value === 'string' && typeof schema.maxLength === 'number') {
    const length = Array.from(value).length;
    if (length > schema.maxLength)
      problems.push(`${path} takes at most ${schema.maxLength} characters (got ${length})`);
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
      // One bound reads as one bound (QA M2-7: "must be from 0 to -").
      problems.push(
        typeof schema.minimum === 'number' && typeof schema.maximum === 'number'
          ? `${path} must be from ${schema.minimum} to ${schema.maximum}`
          : typeof schema.minimum === 'number'
            ? `${path} must be at least ${schema.minimum}`
            : `${path} must be at most ${schema.maximum}`
      );
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

// A blank filter read as an absent one and widened to everything:
// find_links url:"", id:"  " or domain:"" listed all 36,523 links, and
// applied said nothing (QA2 links residue; Jamie, 2026-10-01, QA3 Q3:
// refuse). Every argument that names a source, link, host or subject is
// refused blank or whitespace; a required one is "required".
const BLANK_REFUSED = new Set(['id', 'url', 'domain', 'topic', 'section', 'section_family', 'category', 'theme']);

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
  const blank = (value: unknown) => typeof value === 'string' && !value.trim();
  for (const key of schema.required || []) {
    if (record[key] === undefined || record[key] === null || blank(record[key])) problems.push(`${key} is required`);
  }
  for (const [key, value] of Object.entries(record)) {
    if (key in properties) checkValue(key, value, properties[key], problems);
    if (!(key in properties) || !BLANK_REFUSED.has(key) || (schema.required || []).includes(key)) continue;
    if (blank(value) || (Array.isArray(value) && value.some(blank))) {
      problems.push(`${key} is blank: give it a value, or leave ${key} out to apply no ${key} filter`);
    }
  }
  for (const key of ['year_range', 'year_a', 'year_b']) {
    const range = record[key];
    if (Array.isArray(range) && range.length === 2 && Number(range[0]) > Number(range[1])) {
      problems.push(`${key} runs backwards: [${range[0]}, ${range[1]}] should be [${range[1]}, ${range[0]}]`);
    }
  }
  if (
    record.year !== undefined &&
    record.year !== null &&
    record.year_range !== undefined &&
    record.year_range !== null
  ) {
    problems.push('pass year or year_range, not both');
  }
  return problems;
}

/** The error record for arguments that fail validation (the chat loop's form). */
export function invalidArgumentsRecord(name: string, problems: string[]): JsonRecord {
  const spec = mcpToolDeclarations([name])[0];
  const accepted = Object.keys((spec?.inputSchema as { properties?: Record<string, unknown> })?.properties || {});
  return toolErrorRecord({
    error: `Invalid arguments for ${name}: ${problems.join('; ')}.`,
    code: 'bad_request',
    accepted_arguments: accepted
  });
}

/** The isError result for arguments that fail validation. */
export function invalidArgumentsResult(name: string, problems: string[]) {
  return renderToolCallResult(name, invalidArgumentsRecord(name, problems));
}

// ── Rendering under the cap ────────────────────────────────────────────
// Tool results are sized for the Bedrock loop, where 200KB of evidence is
// cheap context. MCP clients pay for every byte, so a result is cut to fit
// MCP_RESULT_MAX_CHARS - structurally, so it always parses: whole items
// come off the end of the largest list first (results are ranked), then the
// longest text is clipped, and a `truncated` block says what went where. A
// handler that already cut something (a limit, a long body) set `truncated`
// itself; the cap adds to it rather than replacing it.

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

function priorTruncation(result: JsonRecord) {
  const prior = (result.truncated && typeof result.truncated === 'object' ? result.truncated : {}) as JsonRecord;
  const omitted = {
    ...((prior.omitted && typeof prior.omitted === 'object' ? prior.omitted : {}) as Record<string, number>)
  };
  const clipped = Array.isArray(prior.clipped) ? prior.clipped.map(String) : [];
  const nextOffset = typeof prior.next_offset === 'number' ? prior.next_offset : null;
  return { omitted, clipped, hint: typeof prior.hint === 'string' ? prior.hint : '', nextOffset };
}

// paged names the list the tool pages by offset (PAGED_LISTS): cutting it
// moves next_offset back to the first item cut, and the hint says so - the
// tool's own hint named a page the caller never received (currently_history
// once said "the 120 newest are shown" over 64).
function nestedLength(value: unknown, path: string): number {
  const [head, ...rest] = path.split('[].');
  const child = value && typeof value === 'object' ? (value as JsonRecord)[head] : undefined;
  if (!Array.isArray(child)) return 0;
  return rest.length
    ? child.reduce<number>((sum, item) => sum + nestedLength(item, rest.join('[].')), 0)
    : child.length;
}

function fitToCap(result: JsonRecord, max: number, hint: string, paged = '') {
  let text = JSON.stringify(result);
  if (text.length <= max) return { text, truncated: Boolean(result.truncated), tooLarge: false };
  const working = JSON.parse(text) as JsonRecord;
  const prior = priorTruncation(working);
  const { omitted, clipped } = prior;
  let nextOffset = prior.nextOffset;
  let hints =
    prior.hint && prior.hint !== hint ? `${prior.hint} Or ${hint}.` : `${hint[0].toUpperCase()}${hint.slice(1)}.`;
  for (let round = 0; round < 400; round++) {
    working.truncated = {
      max_chars: max,
      omitted,
      clipped,
      ...(nextOffset !== null ? { next_offset: nextOffset } : {}),
      hint: hints
    };
    text = JSON.stringify(working);
    const over = text.length - max;
    if (over <= 0) return { text, truncated: true, tooLarge: false };
    const arrays: Found[] = [];
    const strings: Found[] = [];
    survey(working, '', arrays, strings);
    const list = arrays.filter((found) => found.array!.length > 1).sort((a, b) => b.size - a.size)[0];
    const longest = strings.sort((a, b) => b.size - a.size)[0];
    const nested = paged.includes('[]') && list && paged.startsWith(`${list.path}[].`);
    if (nested) {
      // A per-group paged list (on_this_day years[].items): cut every group
      // to the same depth so one next_offset pages them all; dropping whole
      // groups would hide their items from every page (QA2 T2-1).
      const groups = arrays.filter((found) => found.path === paged);
      const depth = Math.max(0, ...groups.map((found) => found.array!.length));
      if (depth > 1) {
        const cap = depth - 1;
        let dropped = 0;
        for (const found of groups) {
          const extra = found.array!.length - cap;
          if (extra > 0) {
            found.array!.splice(cap, extra);
            dropped += extra;
          }
        }
        omitted[paged] = (omitted[paged] || 0) + dropped;
        const applied = (working.applied || {}) as JsonRecord;
        nextOffset = (Number(applied.offset) || 0) + cap;
        hints = `Cut to fit ${max} characters at ${cap} ${paged} in each group; call again with offset ${nextOffset} for the rest.`;
        continue;
      }
    }
    if (list && paged.startsWith(`${list.path}[].`)) {
      // Dropping whole groups: their items are omitted too, and no offset
      // reaches them, so the hint names the groups instead of a next page.
      const items = list.array!;
      const drop = Math.min(items.length - 1, Math.max(1, Math.ceil(over / (list.size / items.length))));
      const gone = items.splice(items.length - drop, drop);
      const leaf = paged.slice(list.path.length + 3);
      omitted[list.path] = (omitted[list.path] || 0) + drop;
      omitted[paged] = (omitted[paged] || 0) + gone.reduce<number>((sum, group) => sum + nestedLength(group, leaf), 0);
      nextOffset = null;
      hints = `Cut to fit ${max} characters at ${items.length} of the ${list.path}; ${hint}.`;
      continue;
    }
    if (list && (!longest || list.size >= longest.size)) {
      const items = list.array!;
      const perItem = list.size / items.length;
      const drop = Math.min(items.length - 1, Math.max(1, Math.ceil(over / perItem)));
      items.splice(items.length - drop, drop);
      omitted[list.path] = (omitted[list.path] || 0) + drop;
      if (paged && list.path === paged) {
        const applied = (working.applied || {}) as JsonRecord;
        nextOffset = (Number(applied.offset) || 0) + items.length;
        hints = `Cut to fit ${max} characters at ${items.length} ${paged}; call again with offset ${nextOffset} for the rest.`;
      }
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
    truncated: true,
    tooLarge: true
  };
}

function narrowingHint(name: string) {
  const spec = mcpToolDeclarations([name])[0];
  const paramNames = Object.keys((spec?.inputSchema as { properties?: Record<string, unknown> })?.properties || {});
  return paramNames.length
    ? `narrow the arguments (${paramNames.join(', ')}) for a complete result`
    : 'ask a narrower question for a complete result';
}

// The corpus keeps Weekly Thing URLs site-relative (/archive/351/) because
// the weekly site renders them; a client outside that site cannot resolve
// them, so the doors send every url absolute. Only *url keys are touched.
function absoluteUrls(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    return /(^|_)url$/.test(key) && value.startsWith('/') && !value.startsWith('//') ? absoluteSourceUrl(value) : value;
  }
  if (Array.isArray(value)) return value.map((item) => absoluteUrls(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonRecord).map(([childKey, child]) => [childKey, absoluteUrls(child, childKey)])
    );
  }
  return value;
}

// Shared by MCP tools/call and the /tools web route so the two surfaces can
// never drift: an {error} result becomes an isError result with a code and a
// next step; anything else is stamped with server_version, its urls made
// absolute, and fitted under the cap. structured is the same result as an
// object, for MCP's structuredContent; error results carry none.
export function renderToolCallResult(
  name: string,
  invoked: unknown
): { text: string; truncated: boolean; isError: boolean; structured?: JsonRecord } {
  const record =
    invoked && typeof invoked === 'object' && !Array.isArray(invoked)
      ? (absoluteUrls(invoked) as JsonRecord)
      : { result: invoked ?? null };
  if (typeof record.error === 'string' && record.error) {
    const text = JSON.stringify({ ...toolErrorRecord(record), server_version: serverVersion() });
    return { text, truncated: false, isError: true };
  }
  const { text, truncated, tooLarge } = fitToCap(
    { ...record, server_version: serverVersion() },
    MCP_RESULT_MAX_CHARS,
    narrowingHint(name),
    PAGED_LISTS[name]
  );
  if (tooLarge) return { text, truncated, isError: true };
  return { text, truncated, isError: false, structured: JSON.parse(text) as JsonRecord };
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

function quotaError(id: unknown, max: number) {
  return rpcError(
    id,
    MCP_QUOTA_ERROR_CODE,
    `Daily tool-call quota reached (${max} per day). It resets at midnight UTC.`
  );
}

// Resources read through the same tools as tools/call, rendered the same way.
function resourceReader(context: McpContext) {
  return {
    invoke: (name: string, input: JsonRecord, auditAs: string) => context.invokeTool(name, input, auditAs),
    render: (name: string, result: unknown) => renderToolCallResult(name, result)
  };
}

// JSON-RPC's "resource not found" (MCP spec, resources).
const RESOURCE_NOT_FOUND = -32002;

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
    // Resources and prompts are fixed catalogues served statelessly: no
    // subscriptions, and no list_changed to promise.
    capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
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
      'how-things-changed-over-time questions, compare_eras for then-versus-now, on_this_day for',
      'this date in every year (this one included), list_topics for the topic catalogue, latest_content for freshness,',
      'and corpus_stats for what the archive contains. voice: "jamie" (search_archive, quote_search,',
      "find_evidence, compare_eras and archive_lens) keeps only Jamie's own words, never passages Jamie quoted.",
      'year is shorthand for year_range [year, year]. When a result is cut, its truncated block says what',
      'was left out and how to get the rest.',
      'Sources have one id everywhere (wt-351, blog-<microblog id>, page-<page id>, ep-<n>); pass it back to get_source',
      'or source_neighborhood. Cite each source as a markdown link to its url: [WT351](url) for a Weekly Thing',
      'issue, the title for a blog post, page or episode. Pages (About, Lists, Collections, Open Loop) are undated:',
      'date-anchored tools leave them out, and updated is their last edit.',
      'Photos: media_search finds them; view_photo shows up to 3 inline and gives you vision over them.',
      'Resources: librarian://wt/{n}, librarian://blog/{id} and librarian://page/{id} attach one source as markdown; topic, year and',
      'on-this-day templates too. Prompts (thinking_over_time, year_in_review, reading_path,',
      'this_week_in_past_years, research_brief) set out the call sequence for the big asks.',
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
  if (method === 'prompts/list') {
    return { statusCode: 200, payload: rpcResult(id, { prompts: promptList() }) };
  }
  if (method === 'prompts/get') {
    const name = String(params.name || '');
    try {
      const prompt = getPrompt(name, params.arguments);
      if (!prompt) return { statusCode: 200, payload: rpcError(id, -32602, `Unknown prompt: ${name}`) };
      return { statusCode: 200, payload: rpcResult(id, prompt) };
    } catch (error) {
      if (!(error instanceof PromptArgumentError)) throw error;
      return { statusCode: 200, payload: rpcError(id, -32602, `Invalid arguments for ${name}: ${error.message}.`) };
    }
  }
  if (method === 'resources/templates/list') {
    return { statusCode: 200, payload: rpcResult(id, { resourceTemplates: RESOURCE_TEMPLATES }) };
  }
  if (method === 'resources/list') {
    try {
      return { statusCode: 200, payload: rpcResult(id, { resources: await listResources(resourceReader(context)) }) };
    } catch {
      return { statusCode: 200, payload: rpcError(id, -32603, 'The resource list could not be read; try again.') };
    }
  }
  if (method === 'resources/read') {
    const resource = parseResourceUri(params.uri);
    if (!resource) {
      const templates = RESOURCE_TEMPLATES.map((template) => template.uriTemplate).join(', ');
      return {
        statusCode: 200,
        payload: rpcError(id, -32602, `Unknown resource URI; this server serves ${templates}.`, { uri: params.uri })
      };
    }
    const quota = await context.spendQuota();
    if (!quota.allowed) return { statusCode: 200, payload: quotaError(id, quota.max) };
    try {
      const contents = await readResource(resource, resourceReader(context));
      return { statusCode: 200, payload: rpcResult(id, { contents: [contents] }) };
    } catch (error) {
      if (error instanceof ResourceNotFound) {
        return { statusCode: 200, payload: rpcError(id, RESOURCE_NOT_FOUND, error.message, { uri: resource.uri }) };
      }
      return { statusCode: 200, payload: rpcError(id, -32603, 'The resource could not be read; try again.') };
    }
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
      if (!quota.allowed) return { statusCode: 200, payload: quotaError(id, quota.max) };
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
            ...(photos.length ? { structuredContent: summary } : {}),
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
      if (RETIRED_TOOLS[name]) {
        const text = JSON.stringify({
          error: RETIRED_TOOLS[name],
          code: 'not_found',
          next: 'Re-fetch tools/list and call the named tool.',
          server_version: serverVersion()
        });
        return { statusCode: 200, payload: rpcResult(id, { content: [{ type: 'text', text }], isError: true }) };
      }
      return { statusCode: 200, payload: rpcError(id, -32602, `Unknown tool: ${name}`) };
    }
    const problems = validateToolArguments(name, rawArgs);
    if (problems.length) {
      const { text } = invalidArgumentsResult(name, problems);
      return { statusCode: 200, payload: rpcResult(id, { content: [{ type: 'text', text }], isError: true }) };
    }
    const quota = await context.spendQuota();
    if (!quota.allowed) return { statusCode: 200, payload: quotaError(id, quota.max) };
    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as JsonRecord;
    try {
      const invoked = await context.invokeTool(name, args);
      const { text, isError, structured } = renderToolCallResult(name, invoked);
      return {
        statusCode: 200,
        payload: rpcResult(id, {
          content: [{ type: 'text', text }],
          ...(structured ? { structuredContent: structured } : {}),
          isError
        })
      };
    } catch (error) {
      const { text } = toolFailureResult(name, error);
      return { statusCode: 200, payload: rpcResult(id, { content: [{ type: 'text', text }], isError: true }) };
    }
  }
  return { statusCode: 200, payload: rpcError(id, -32601, `Method not found: ${method}`) };
}
