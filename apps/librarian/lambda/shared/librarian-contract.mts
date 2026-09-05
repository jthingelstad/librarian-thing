// 4.0.0: conversation share links added; email_answer removed (breaking
// for callers of that action - the sole client shipped in lockstep).
// 4.1.0: guest chat - unauthenticated /chat streams carry guest and
// guest_remaining in meta/done (additive).
// 4.2.0: account overview reports chat_model - the entitlement-routed
// model answering this reader (additive).
// 4.3.0: conversation branching - turns carry parent_request_id, /chat
// accepts it, and stored messages return it (additive). Sending '' marks
// a root turn (edit of the first message; stored/returned as 'root');
// omitting the field keeps the legacy linear history.
// 4.4.0: /welcome may emit a suggestions stream event - corpus-grounded
// follow-up questions for the empty-thread chips (additive); guests get a
// daily cached set.
// 4.5.0: /conversations search action - full-content substring search
// over the reader's own turns, returning conversation ids + snippets
// (additive).
// 4.6.0: /conversations list pages (request offset/limit, response
// total) and search matches carry title/updated_at, so history beyond
// the rail's window is reachable (additive).
// 4.7.0: /chat accepts share_token - a share-link continuation seeds
// the model's context with the shared conversation's active chain,
// loaded server-side by token. Guests fork client-side; signed-in
// readers fork into a new conversation of their own (additive).
// 4.8.0: durable response receipts - done events carry receipt
// {duration_ms, total_tokens, tool_steps}, and stored/shared assistant
// messages carry duration_ms/total_tokens, so the client's response
// timer survives reload and share pages (additive).
// 4.9.0: account overview quota carries turns_today/tokens_today -
// informational daily usage counted for every reader including the
// owner, whose row previously reported nothing (additive).
// 4.10.0: instant welcome - /welcome answers from a precomputed per-
// reader set (refreshed post-turn), emits no greeting prose (clients
// compose the greeting from a time-aware salutation + a line from the
// suggestions event's new greeting_lines array), and no longer charges
// the chat quota (additive; old clients keep their built-in greeting).
export const LIBRARIAN_CONTRACT_VERSION = '4.10.0';
// Majors the server still answers for. 2.x clients predate the chat
// streamline (curiosity map + experiences removed); 3.x tabs open before
// the share release still list/get/chat fine (their mail button 400s).
// Known cross-repo consumers - check BOTH before dropping a major:
//  - thingy web (vendored contract via contract:sync; tracks current major)
//  - wt-builder src/server/integrations/librarian.ts (/retrieve for Echoes;
//    pins LIBRARIAN_CONTRACT_MAJOR by hand - a dropped major 409s Echoes
//    on a send week)
export const SUPPORTED_CONTRACT_MAJORS = ['2', '3', '4'];

const string = { type: 'string' } as const;
const boolean = { type: 'boolean' } as const;
const number = { type: 'number' } as const;
const unknownArray = { type: 'array' } as const;

function ref(name: string) {
  return { $ref: `#/$defs/${name}` };
}

function arrayOf(schema: Record<string, unknown>) {
  return { type: 'array', items: schema };
}

function object(properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: true
  };
}

function endpoint(actions: Record<string, Record<string, unknown>> = {}) {
  return {
    schema: ref('apiResponse'),
    actions
  };
}

const mode = object({ id: string, label: string, description: string }, ['id', 'label']);
const profile = object({
  email: string,
  status: string,
  returning: boolean,
  first_seen_at: string,
  last_seen_at: string,
  preferred_name: string,
  turn_count: number,
  entitlements: arrayOf(string),
  modes: arrayOf(ref('mode')),
  supporting_member: boolean,
  current_session_questions: unknownArray,
  recent_prompts: unknownArray,
  prior_session_summaries: unknownArray,
  learned_profile: unknownArray,
  memory_synthesis: object({})
});
const conversation = object({
  id: string,
  conversation_id: string,
  title: string,
  mode: string,
  scope: string,
  turn_count: number,
  created_at: string,
  updated_at: string,
  last_message_at: string,
  preview: string,
  local: boolean,
  draft: boolean,
  share_token: string,
  shared_at: string,
  shared_up_to: string
});
const conversationShare = object(
  { token: string, url: string, shared_at: string, shared_up_to: string, expires_at: string },
  ['token', 'url']
);
const sharedConversation = object(
  {
    title: string,
    created_at: string,
    shared_at: string,
    shared_up_to: string,
    // Present only when the authenticated viewer owns the share.
    owner: boolean,
    conversation_id: string
  },
  ['title']
);
const conversationMessage = object({
  role: string,
  content: string,
  scope: string,
  artifact: {},
  tool_names: arrayOf(string),
  toolNames: arrayOf(string),
  request_id: string,
  requestId: string,
  parent_request_id: string,
  citations: unknownArray,
  // 4.8: the turn's receipt, when recorded (assistant messages only).
  duration_ms: number,
  total_tokens: number
});
const receipt = object({
  duration_ms: number,
  total_tokens: number,
  tool_steps: number
});
const archiveItem = object({
  url: string,
  title: string,
  subject: string,
  label: string,
  publish_date: string,
  reason: string,
  source_kind: string
});
const citation = object({
  issue_number: { anyOf: [string, number, { type: 'null' }] },
  url: string,
  subject: string,
  publish_date: string,
  section: string
});
const quotaOverview = object({
  day: string,
  unlimited: boolean,
  chat_used: number,
  chat_max: { anyOf: [number, { type: 'null' }] },
  mcp_used: number,
  mcp_max: { anyOf: [number, { type: 'null' }] },
  turns_today: number,
  tokens_today: number
});
const chatModel = object({ id: string, label: string, premium: boolean }, ['id', 'label']);
const accountOverview = object({
  first_seen_at: string,
  last_seen_at: string,
  memory_turn_count: number,
  conversation_count: number,
  conversation_turn_count: number,
  oldest_conversation_at: string,
  newest_conversation_at: string,
  quota: ref('quotaOverview'),
  chat_model: ref('chatModel')
});

const apiProperties = {
  token: string,
  email: string,
  status: string,
  message: string,
  error: string,
  errorMessage: string,
  profile: ref('profile'),
  entitlements: arrayOf(string),
  modes: arrayOf(ref('mode')),
  request_id: string,
  requestId: string,
  conversations: arrayOf(ref('conversation')),
  conversation: ref('conversation'),
  messages: arrayOf(ref('conversationMessage')),
  supporting_member: boolean,
  data: {},
  code: string,
  account: ref('accountOverview'),
  reaction: string,
  ok: boolean,
  has_comment: boolean,
  share: ref('conversationShare')
};

const streamProperties = {
  ...apiProperties,
  contract_version: string,
  mode: string,
  conversation_id: string,
  delta: string,
  answer: string,
  citations: arrayOf(ref('citation')),
  commentary: string,
  detail: string,
  note: string,
  kind: string,
  tool_name: string,
  toolName: string,
  guest: boolean,
  guest_remaining: number,
  suggestions: arrayOf(string),
  receipt: ref('receipt')
};

export const LIBRARIAN_CONTRACT = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://thingy.thingelstad.com/contracts/librarian-api.json',
  title: 'Thingy Librarian API Contract',
  version: LIBRARIAN_CONTRACT_VERSION,
  compatibility: 'breaking',
  $defs: {
    mode,
    profile,
    receipt,
    conversation,
    conversationShare,
    sharedConversation,
    conversationMessage,
    archiveItem,
    citation,
    quotaOverview,
    chatModel,
    accountOverview,
    apiResponse: object(apiProperties),
    apiError: object({ error: string, message: string, errorMessage: string, request_id: string, requestId: string }),
    streamBase: object(streamProperties)
  },
  endpoints: {
    '/auth': endpoint(),
    '/conversations': endpoint({
      list: object({ conversations: apiProperties.conversations, total: number }, ['conversations']),
      get: object({ conversation: apiProperties.conversation, messages: apiProperties.messages }, [
        'conversation',
        'messages'
      ]),
      create: object({ conversation: apiProperties.conversation }, ['conversation']),
      rename: object({ conversation: apiProperties.conversation }, ['conversation']),
      share: object({ share: apiProperties.share }, ['share']),
      unshare: object({ ok: boolean }, ['ok']),
      search: object(
        {
          matches: arrayOf(
            object({ conversation_id: string, snippet: string, title: string, updated_at: string }, ['conversation_id'])
          )
        },
        ['matches']
      )
    }),
    // Public read-only shared-conversation snapshot; the token in the path
    // is the whole credential.
    '/share/{token}': {
      actions: {},
      schema: object(
        {
          conversation: ref('sharedConversation'),
          messages: arrayOf(ref('conversationMessage'))
        },
        ['conversation', 'messages']
      )
    },
    '/feedback': endpoint(),
    '/memory': endpoint(),
    // SSE agent loop. The response body is the stream_events sequence below;
    // request fields are listed here so removing one is a contract change.
    '/chat': {
      actions: {},
      request: object(
        {
          message: string,
          conversation_id: string,
          parent_request_id: string,
          share_token: string,
          scope: string,
          mode: string,
          client_context: object({})
        },
        ['message']
      ),
      schema: ref('streamBase')
    },
    // Service retrieval for trusted internal clients (wt-builder). JSON-only.
    '/retrieve': {
      actions: {},
      request: object(
        {
          query: string,
          k: number,
          scope: string,
          filters: object({ yearRange: unknownArray, section: string }),
          retrieve_secret: string,
          bridge_secret: string
        },
        ['query']
      ),
      schema: object(
        {
          passages: arrayOf(ref('archiveItem')),
          embedding_model: string,
          rerank_model: string,
          request_id: string
        },
        ['passages']
      )
    }
  },
  stream_events: {
    meta: object(streamProperties),
    status: object(streamProperties),
    commentary: object(streamProperties),
    answer_delta: object(streamProperties, ['delta']),
    answer: object(streamProperties, ['answer']),
    citations: object(streamProperties, ['citations']),
    suggestions: object({ ...streamProperties, greeting_lines: arrayOf(string) }, ['suggestions']),
    done: object(streamProperties),
    error: object(streamProperties, ['error'])
  }
} as const;

export function requestedContractVersion(headers: Record<string, unknown> = {}) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === 'x-librarian-contract-version');
  return String(entry?.[1] || '').trim();
}

export function supportsRequestedContract(headers: Record<string, unknown> = {}) {
  const requested = requestedContractVersion(headers);
  if (!requested) return true;
  const requestedMajor = /^([0-9]+)\./.exec(requested)?.[1];
  return Boolean(requestedMajor && SUPPORTED_CONTRACT_MAJORS.includes(requestedMajor));
}
