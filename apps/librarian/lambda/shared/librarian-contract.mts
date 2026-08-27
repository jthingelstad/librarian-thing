export const LIBRARIAN_CONTRACT_VERSION = '1.0.0';

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
const dispatchBriefSource = object({
  id: string,
  label: string,
  title: string,
  url: string,
  source_kind: string,
  publish_date: string,
  why: string
});
const dispatchBrief = object({
  user_goal: string,
  working_angle: string,
  coverage_status: { enum: ['thin', 'focused', 'broad', 'ambiguous'] },
  selected_sources: arrayOf(ref('dispatchBriefSource')),
  excluded_scope: arrayOf(string),
  generation_instructions: string,
  preheader_basis: string,
  status: { enum: ['draft', 'ready'] }
});
const dispatchMessage = object({
  id: string,
  baseId: string,
  scope: string,
  role: { enum: ['user', 'assistant', 'system'] },
  text: string,
  time: string,
  kind: string,
  status: string,
  startedAt: number,
  completedAt: { anyOf: [number, string] }
});
const dispatchRow = object({
  id: string,
  dispatch_id: string,
  status: string,
  topic: string,
  prompt: string,
  direction: string,
  conversation_id: string,
  clarification_question: string,
  clarification_answer: string,
  brief: ref('dispatchBrief'),
  subject: string,
  title: string,
  preview: string,
  error: string,
  messages: arrayOf(ref('dispatchMessage')),
  created_at: string,
  updated_at: string,
  template_test: boolean,
  source_count: number
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
const experience = object({
  kind: string,
  title: string,
  intro: string,
  prompt: string,
  items: arrayOf(ref('archiveItem'))
});
const curiosityNode = object({ id: string, label: string, kind: string, prompt: string, why: string, weight: number }, [
  'id',
  'label'
]);
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
  dispatches: arrayOf(ref('dispatchRow')),
  dispatch: ref('dispatchRow'),
  supporting_member: boolean,
  items: arrayOf(ref('dispatchRow')),
  data: {},
  code: string,
  nodes: arrayOf(ref('curiosityNode')),
  sources: arrayOf(ref('archiveItem')),
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
  experience: ref('experience'),
  commentary: string,
  detail: string,
  note: string,
  kind: string,
  tool_name: string,
  toolName: string,
  brief: ref('dispatchBrief')
};

export const LIBRARIAN_CONTRACT = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://thingy.thingelstad.com/contracts/librarian-api.v1.json',
  title: 'Thingy Librarian API Contract',
  version: LIBRARIAN_CONTRACT_VERSION,
  compatibility: 'additive',
  $defs: {
    mode,
    profile,
    conversation,
    conversationMessage,
    dispatchBriefSource,
    dispatchBrief,
    dispatchMessage,
    dispatchRow,
    archiveItem,
    citation,
    experience,
    curiosityNode,
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
    '/dispatch': endpoint({
      list: object({ dispatches: apiProperties.dispatches }, ['dispatches']),
      save_draft: object({ dispatch: apiProperties.dispatch }, ['dispatch']),
      status: object({ dispatch: apiProperties.dispatch }, ['dispatch'])
    }),
    '/feedback': endpoint(),
    '/memory': endpoint(),
    '/curiosity-map': endpoint()
  },
  stream_events: {
    meta: object(streamProperties),
    status: object(streamProperties),
    commentary: object(streamProperties),
    answer_delta: object(streamProperties, ['delta']),
    answer: object(streamProperties, ['answer']),
    citations: object(streamProperties, ['citations']),
    experience: object(streamProperties, ['experience']),
    dispatch_brief: object(streamProperties, ['brief']),
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
  const currentMajor = /^([0-9]+)\./.exec(LIBRARIAN_CONTRACT_VERSION)?.[1];
  return Boolean(requestedMajor && currentMajor && requestedMajor === currentMajor);
}
