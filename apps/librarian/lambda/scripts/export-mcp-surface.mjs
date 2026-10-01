// Exports the published MCP surface - the tools exactly as tools/list
// declares them, which door offers which tool, resources, prompts, error
// codes, limits, quotas and the OAuth facts - to
// apps/librarian/contracts/mcp-surface.json (+ .sha256). Thingy vendors the
// artifact and renders its /connect/reference/ page from it at build time,
// so the public reference cannot drift from the server.
//
// Reads the BUILT modules (run npm run build first; verify does). Every
// value comes from the code: exported constants where they exist, protocol
// probes through handleMcpMessage with a stub context for the JSON-RPC
// errors, and the compiled source text for the few limits that live in
// unexported constants. Nothing here is hand-copied.
//
// Deliberately absent: serverInfo.version's "+tools.<fingerprint>" suffix.
// The fingerprint hashes every packaged prompt file (agent-system.md too),
// so it would churn the artifact on prompt edits that do not touch the MCP
// surface. The semver part is exported; the schemas themselves are in the
// artifact, so any surface change still changes it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const defaultTarget = resolve(root, '../contracts/mcp-surface.json');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const targets = args.filter((arg) => arg !== '--check').map((target) => resolve(process.cwd(), target));

if (!existsSync(resolve(dist, 'shared/mcp.mjs'))) {
  process.stderr.write('dist/ is missing - run npm run build first.\n');
  process.exit(1);
}

// The surface as code defaults declare it, not as this shell's environment
// would bend it. web_search is declared only when a search key is set; a
// placeholder (never a real key) makes its declaration exportable, and the
// artifact marks it conditional.
for (const name of [
  'CHAT_DAILY_QUOTA',
  'MCP_DAILY_QUOTA',
  'WEB_TOOLS_DAILY_QUOTA',
  'GUEST_DAILY_QUOTA',
  'GUEST_GLOBAL_DAILY_QUOTA',
  'LIBRARIAN_OAUTH_ISSUER',
  'MAX_TOOL_TURNS',
  'RATE_LIMIT_MAX'
]) {
  delete process.env[name];
}
process.env.BRAVE_SEARCH_API_KEY = 'export-placeholder-not-a-key';

const load = (path) => import(resolve(dist, path));
const mcp = await load('shared/mcp.mjs');
const archiveTools = await load('shared/archive-tools.mjs');
const prompts = await load('shared/prompts.mjs');
const mcpResources = await load('shared/mcp-resources.mjs');
const mcpPrompts = await load('shared/mcp-prompts.mjs');
const photoView = await load('shared/photo-view.mjs');
const quota = await load('shared/quota.mjs');
const oauthStore = await load('shared/oauth-store.mjs');
const oauthRoutes = await load('auth/oauth-routes.mjs');

// A limit kept in an unexported constant, read from the compiled module so
// it follows the code. A missing match fails the export loudly.
function constantFrom(file, pattern, label) {
  const source = readFileSync(resolve(dist, file), 'utf8');
  const match = source.match(pattern);
  if (!match) throw new Error(`export-mcp-surface: could not find ${label} in dist/${file}`);
  return match[1];
}

function product(expression) {
  return expression
    .split('*')
    .map((part) => Number(part.trim()))
    .reduce((total, value) => total * value, 1);
}

const intConstant = (file, name) => Number(constantFrom(file, new RegExp(`const ${name} = (\\d+);`), name));

// ── Tools ───────────────────────────────────────────────────────────────
const declarations = mcp.mcpToolDeclarations([...mcp.MCP_LAUNCH_TOOLS, mcp.VIEW_PHOTO_TOOL]);
const specs = archiveTools.mcpToolSpecs();
const chatToolNames = archiveTools
  .availableToolSpecs()
  .map((entry) => entry.toolSpec?.name)
  .filter(Boolean);
const doorsFor = (name) => ({
  mcp: mcp.MCP_LAUNCH_TOOLS.includes(name) || name === mcp.VIEW_PHOTO_TOOL,
  webmcp: mcp.WEB_TOOLS.includes(name),
  chat: chatToolNames.includes(name),
  guest_chat: mcp.WEB_TOOLS.includes(name)
});

const tools = declarations.map((tool) => {
  const spec = specs.find((entry) => entry.toolSpec?.name === tool.name);
  const chatDescription = String(spec?.toolSpec?.description || '');
  return {
    ...tool,
    ...(chatDescription && chatDescription !== tool.description ? { chat_description: chatDescription } : {}),
    ...(tool.name === 'web_search'
      ? { conditional: 'Declared and callable only when the deployment configures a web search key.' }
      : {}),
    ...(archiveTools.PAGED_LISTS[tool.name] ? { paged_list: archiveTools.PAGED_LISTS[tool.name] } : {}),
    doors: doorsFor(tool.name)
  };
});

// ── Protocol probes ─────────────────────────────────────────────────────
// A stub context: quota always refused, tools never actually invoked. Each
// probe records the real JSON-RPC error the server answers with.
const refusingContext = {
  subscriberHash: 'export',
  entitlements: [],
  scope: 'all',
  invokeTool: async () => ({ error: 'not invoked during export' }),
  spendQuota: async () => ({ allowed: false, count: 0, max: quota.DEFAULT_MCP_DAILY_QUOTA }),
  viewPhoto: async () => ({ photos: [], refused: [] })
};
async function probe(message) {
  const { statusCode, payload } = await mcp.handleMcpMessage(message, refusingContext);
  return { statusCode, payload };
}
const rpc = (method, params) => ({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });
// latest_content takes no required argument, so the call reaches the quota.
const quotaProbeTool = 'latest_content';
const probes = [
  [
    'quota_exhausted',
    'tools/call or resources/read after the daily quota is spent',
    rpc('tools/call', { name: quotaProbeTool, arguments: {} })
  ],
  ['unknown_tool', 'tools/call naming a tool tools/list does not declare', rpc('tools/call', { name: 'no_such_tool' })],
  ['unknown_prompt', 'prompts/get naming no prompt', rpc('prompts/get', { name: 'no_such_prompt' })],
  [
    'bad_resource_uri',
    'resources/read with a URI no template matches',
    rpc('resources/read', { uri: 'librarian://nothing/1' })
  ],
  ['unknown_method', 'a method this server does not implement', rpc('sampling/createMessage')],
  ['batch', 'a JSON-RPC batch (removed in protocol 2025-06-18)', [rpc('ping')]],
  ['not_jsonrpc', 'a body that is not a JSON-RPC 2.0 request', { method: 'ping' }]
];
const jsonRpcErrors = [];
for (const [key, when, message] of probes) {
  const { statusCode, payload } = await probe(message);
  if (!payload?.error) throw new Error(`export-mcp-surface: probe ${key} returned no error`);
  jsonRpcErrors.push({ key, when, http_status: statusCode, code: payload.error.code, message: payload.error.message });
}
// Not reachable with a stub context: the HTTP door's parse failure, a
// resource whose id names nothing, and a resource read that failed.
jsonRpcErrors.push(
  { key: 'parse_error', when: 'the POST body is not JSON', http_status: 400, code: -32700, message: 'Parse error' },
  {
    key: 'resource_not_found',
    when: 'resources/read for a well-formed URI that names nothing (librarian://wt/9999)',
    http_status: 200,
    code: -32002,
    message: 'Names the missing resource; error.data carries the uri.'
  },
  {
    key: 'resource_read_failed',
    when: 'resources/list or resources/read failed inside the server',
    http_status: 200,
    code: -32603,
    message: 'The resource could not be read; try again.'
  }
);

const retiredProbe = await mcp.handleMcpMessage(
  rpc('tools/call', { name: Object.keys(mcp.RETIRED_TOOLS)[0] }),
  refusingContext
);
const retiredShape = JSON.parse(retiredProbe.payload.result.content[0].text);
delete retiredShape.server_version;

const badArgs = JSON.parse(
  mcp.invalidArgumentsResult('search_archive', ['unknown argument "q"', 'query is required']).text
);
delete badArgs.server_version;

// ── Prompts: the call sequence each expands to ──────────────────────────
// Rendered with {placeholder} arguments where the prompt accepts them; a
// prompt that validates its argument (year) renders with a sample value
// that is then swapped back for the placeholder. Optional arguments are
// left out, so the text shows the defaults.
const SAMPLE_VALUES = { year: '2099', date: '09-29', length: '6' };
function renderPrompt(prompt) {
  const values = {};
  const swaps = [];
  for (const argument of prompt.arguments.filter((entry) => entry.required)) {
    values[argument.name] = `{${argument.name}}`;
  }
  let rendered;
  try {
    rendered = mcpPrompts.getPrompt(prompt.name, values);
  } catch {
    for (const argument of prompt.arguments.filter((entry) => entry.required)) {
      const sample = SAMPLE_VALUES[argument.name];
      if (!sample) throw new Error(`export-mcp-surface: no sample value for prompt argument ${argument.name}`);
      values[argument.name] = sample;
      swaps.push([sample, `{${argument.name}}`]);
    }
    rendered = mcpPrompts.getPrompt(prompt.name, values);
  }
  let text = rendered.messages.map((message) => message.content.text).join('\n\n');
  for (const [sample, placeholder] of swaps) text = text.replaceAll(sample, placeholder);
  return text;
}

// resources/list reads through a tool; record which, with what arguments.
let resourceListCall = null;
await mcpResources.listResources({
  invoke: async (name, input) => {
    resourceListCall = { tool: name, arguments: input };
    return { results: [] };
  },
  render: () => ({ text: '{}' })
});

// ── Assemble ────────────────────────────────────────────────────────────
const initialize = mcp.initializeResult(mcp.MCP_PROTOCOL_VERSION);
const supportedVersions = JSON.parse(
  constantFrom(
    'shared/mcp.mjs',
    /const SUPPORTED_PROTOCOL_VERSIONS = (\[[^\]]*\]);/,
    'SUPPORTED_PROTOCOL_VERSIONS'
  ).replaceAll("'", '"')
);
const issuer = oauthRoutes.oauthIssuer();
const supporting = (base) => quota.quotaMaxForEntitlements(base, ['supporting_member']);

const surface = {
  artifact: 'librarian-mcp-surface',
  schema_version: 1,
  generated_by: 'apps/librarian/lambda/scripts/export-mcp-surface.mjs',
  server: {
    name: initialize.serverInfo.name,
    title: initialize.serverInfo.title,
    version: prompts.MCP_SERVER_VERSION,
    version_format: `${prompts.MCP_SERVER_VERSION}+tools.<fingerprint>: the fingerprint hashes every packaged prompt file, the tool specs included, so it changes whenever the declared tools do`,
    website_url: initialize.serverInfo.websiteUrl,
    icons: initialize.serverInfo.icons,
    endpoint: `${issuer}/mcp`,
    transport: 'Streamable HTTP, stateless: each POST carries one JSON-RPC message and gets one application/json reply',
    protocol_versions: { default: mcp.MCP_PROTOCOL_VERSION, supported: supportedVersions },
    capabilities: initialize.capabilities,
    instructions: initialize.instructions
  },
  doors: {
    mcp: {
      path: '/mcp',
      url: `${issuer}/mcp`,
      auth: 'OAuth 2.1 bearer access token carrying the archive:read scope',
      tools: tools.filter((tool) => tool.doors.mcp).map((tool) => tool.name),
      daily_quota: {
        reader: quota.DEFAULT_MCP_DAILY_QUOTA,
        supporting_member: supporting(quota.DEFAULT_MCP_DAILY_QUOTA),
        unit: 'tool call or resource read'
      },
      hourly_rate_limit: intConstant('chat/runtime.mjs', 'MCP_RATE_LIMIT_MAX'),
      result_cap_chars: mcp.MCP_RESULT_MAX_CHARS
    },
    webmcp: {
      path: '/tools',
      url: 'https://thingy.thingelstad.com/api/tools',
      auth: 'the signed-in Thingy web session (same-origin, HttpOnly cookie)',
      tools: tools.filter((tool) => tool.doors.webmcp).map((tool) => tool.name),
      daily_quota: {
        reader: quota.DEFAULT_WEB_TOOLS_DAILY_QUOTA,
        supporting_member: supporting(quota.DEFAULT_WEB_TOOLS_DAILY_QUOTA),
        unit: 'tool call'
      },
      hourly_rate_limit: intConstant('chat/runtime.mjs', 'WEB_TOOLS_RATE_LIMIT_MAX'),
      result_cap_chars: mcp.MCP_RESULT_MAX_CHARS
    },
    chat: {
      path: '/chat',
      auth: 'the signed-in Thingy web session',
      runtime: 'Amazon Bedrock Converse agent loop, tools called in-process',
      tools: tools.filter((tool) => tool.doors.chat).map((tool) => tool.name),
      max_tool_turns: intConstant('chat/runtime.mjs', 'DEFAULT_MAX_TOOL_TURNS'),
      daily_quota: {
        reader: quota.DEFAULT_CHAT_DAILY_QUOTA,
        supporting_member: supporting(quota.DEFAULT_CHAT_DAILY_QUOTA),
        unit: 'chat turn'
      },
      hourly_rate_limit: intConstant('chat/runtime.mjs', 'RATE_LIMIT_MAX'),
      result_cap_chars: null
    },
    guest_chat: {
      path: '/chat',
      auth: 'none (guest preview lane)',
      runtime: 'Amazon Bedrock Converse agent loop, tools called in-process',
      tools: tools.filter((tool) => tool.doors.guest_chat).map((tool) => tool.name),
      max_tool_turns: intConstant('chat/runtime.mjs', 'DEFAULT_MAX_TOOL_TURNS'),
      daily_quota: {
        visitor: quota.DEFAULT_GUEST_DAILY_QUOTA,
        global: quota.DEFAULT_GUEST_GLOBAL_DAILY_QUOTA,
        unit: 'chat turn'
      },
      hourly_rate_limit: intConstant('chat/runtime.mjs', 'GUEST_RATE_LIMIT_MAX'),
      result_cap_chars: null
    }
  },
  quota_rules: {
    reset: 'Daily pools are UTC days and reset at midnight UTC.',
    supporting_member_multiplier: supporting(1),
    owner: 'exempt',
    pools: 'Each door has its own pool; one never spends another.'
  },
  tools,
  retired_tools: Object.entries(mcp.RETIRED_TOOLS).map(([name, replacement]) => ({ name, replacement })),
  retired_tool_result: retiredShape,
  resources: {
    templates: mcpResources.RESOURCE_TEMPLATES,
    list: resourceListCall,
    quota: 'one quota unit per resources/read'
  },
  prompts: mcpPrompts.promptList().map((prompt) => ({ ...prompt, call_sequence: renderPrompt(prompt) })),
  errors: {
    tool_error_codes: mcp.TOOL_ERROR_CODES.map((code) => ({
      code,
      next: mcp.toolErrorRecord({ error: 'x', code }).next
    })),
    invalid_arguments_example: badArgs,
    json_rpc: jsonRpcErrors
  },
  limits: {
    result_max_chars: mcp.MCP_RESULT_MAX_CHARS,
    tool_limits: archiveTools.TOOL_LIMITS,
    text_limits: archiveTools.TEXT_LIMITS,
    paged_lists: archiveTools.PAGED_LISTS,
    view_photo: {
      max_images: photoView.VIEW_PHOTO_MAX_IMAGES,
      max_image_bytes: photoView.VIEW_PHOTO_MAX_IMAGE_BYTES,
      byte_budget: photoView.VIEW_PHOTO_BYTE_BUDGET,
      resize_width: photoView.RESIZE_WIDTH
    }
  },
  oauth: {
    issuer,
    authorization_server_metadata: `${issuer}/.well-known/oauth-authorization-server`,
    protected_resource_metadata: `${issuer}/.well-known/oauth-protected-resource`,
    metadata: oauthRoutes.authorizationServerMetadata(),
    resource: oauthRoutes.protectedResourceMetadata(),
    sign_in:
      'The reader signs in with an emailed six-digit code, the same sign-in Thingy uses; the address must be an active Weekly Thing subscription.',
    lifetimes_seconds: {
      access_token: oauthStore.ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: oauthStore.REFRESH_TOKEN_TTL_SECONDS,
      refresh_family_max: product(
        constantFrom(
          'shared/oauth-store.mjs',
          /const OAUTH_FAMILY_MAX_SECONDS = ([\d\s*]+);/,
          'OAUTH_FAMILY_MAX_SECONDS'
        )
      ),
      authorization_code: oauthStore.AUTH_CODE_TTL_SECONDS,
      pending_authorization: oauthStore.PENDING_TTL_SECONDS,
      registered_client: oauthStore.CLIENT_TTL_SECONDS
    },
    refresh_rotation:
      'Refresh tokens rotate on every use; replaying a rotated token revokes the whole token family. A family lives at most refresh_family_max from first consent, then the client authorizes again.',
    token_prefixes: {
      access_token: oauthStore.ACCESS_TOKEN_PREFIX,
      refresh_token: oauthStore.REFRESH_TOKEN_PREFIX,
      authorization_code: oauthStore.AUTH_CODE_PREFIX
    },
    rate_limits: {
      register_per_hour_per_client_ip: intConstant('auth/oauth-routes.mjs', 'REGISTER_RATE_LIMIT_MAX'),
      register_per_day_global: Number(
        constantFrom(
          'auth/oauth-routes.mjs',
          /consumeDailyQuotaStrict\('oauth_register', 'global', (\d+)\)/,
          'the global registration cap'
        )
      ),
      token_per_hour_per_client_ip: intConstant('auth/oauth-routes.mjs', 'TOKEN_RATE_LIMIT_MAX')
    }
  }
};

let stale = false;
const content = `${JSON.stringify(surface, null, 2)}\n`;
for (const target of targets.length ? targets : [defaultTarget]) {
  const checksumTarget = target.replace(/\.json$/, '.sha256');
  const checksum = createHash('sha256').update(content).digest('hex');
  const checksumLine = `${checksum}  ${basename(target)}\n`;
  if (checkOnly) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
    const currentChecksum = existsSync(checksumTarget) ? readFileSync(checksumTarget, 'utf8') : '';
    if (current !== content || currentChecksum !== checksumLine) {
      process.stderr.write(`STALE: ${target} does not match the built MCP surface - run npm run mcp-surface:export\n`);
      stale = true;
    }
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  writeFileSync(checksumTarget, checksumLine);
  process.stdout.write(`${target}\n${checksumTarget}\n`);
}
if (stale) process.exit(1);
