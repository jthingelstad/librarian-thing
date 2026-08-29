export const LIBRARIAN_CONTRACT_VERSION = '3.0.0';
// Majors the server still answers for. 2.x clients predate the chat
// streamline (curiosity map + experiences removed); drop '2' once the
// deployed Thingy web client vendors 3.0.0.
export const SUPPORTED_CONTRACT_MAJORS = ['2', '3'];

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
  draft: boolean
});
const conversationMessage = object({
  role: string,
  content: string,
  scope: string,
  artifact: {},
  tool_names: arrayOf(string),
  toolNames: arrayOf(string),
  request_id: string,
  requestId: string,
  citations: unknownArray
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
const accountOverview = object({
  first_seen_at: string,
  last_seen_at: string,
  memory_turn_count: number,
  conversation_count: number,
  conversation_turn_count: number,
  oldest_conversation_at: string,
  newest_conversation_at: string
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
  has_comment: boolean
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
  toolName: string
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
    conversation,
    conversationMessage,
    archiveItem,
    citation,
    accountOverview,
    apiResponse: object(apiProperties),
    apiError: object({ error: string, message: string, errorMessage: string, request_id: string, requestId: string }),
    streamBase: object(streamProperties)
  },
  endpoints: {
    '/auth': endpoint(),
    '/conversations': endpoint({
      list: object({ conversations: apiProperties.conversations }, ['conversations']),
      get: object({ conversation: apiProperties.conversation, messages: apiProperties.messages }, [
        'conversation',
        'messages'
      ]),
      create: object({ conversation: apiProperties.conversation }, ['conversation']),
      rename: object({ conversation: apiProperties.conversation }, ['conversation'])
    }),
    '/feedback': endpoint(),
    '/memory': endpoint(),
    // SSE agent loop. The response body is the stream_events sequence below;
    // request fields are listed here so removing one is a contract change.
    '/chat': {
      actions: {},
      request: object(
        {
          question: string,
          conversation_id: string,
          scope: string,
          mode: string,
          client_context: object({})
        },
        ['question']
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
