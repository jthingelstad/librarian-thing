import crypto from 'node:crypto';
import { agentModel, premiumModel } from './aws-clients.mjs';

export const DEFAULT_CONVERSATION_MODE = 'thingy';

// Friendly names for the model ids Thingy actually configures; fall back
// to the raw id so a future model never renders as a blank.
function friendlyModelLabel(modelId: string) {
  const table: Array<[RegExp, string]> = [
    [/opus-5/, 'Claude Opus 5'],
    [/sonnet-5/, 'Claude Sonnet 5'],
    [/opus-4-8/, 'Claude Opus 4.8'],
    [/opus-4-6/, 'Claude Opus 4.6'],
    [/sonnet-4-6/, 'Claude Sonnet 4.6'],
    [/haiku-4-5/, 'Claude Haiku 4.5']
  ];
  for (const [pattern, label] of table) if (pattern.test(modelId)) return label;
  return modelId;
}

// The single source of truth for premium model routing: supporters and the
// owner get the premium model, everyone else the fleet default. Used by the
// chat loop (to pick the model) and the account overview (to report it).
export function chatModelForReader(subscriberHash: unknown, entitlements: readonly unknown[] = []) {
  const premium = isOwnerSubscriberHash(subscriberHash) || entitlements.includes('supporting_member');
  const id = premium ? premiumModel() : agentModel();
  return { id, label: friendlyModelLabel(id), premium };
}

export type ConversationMode = 'thingy' | 'research_guide' | 'thought_partner' | 'trusted_circle';

interface ModeDefinition {
  id: ConversationMode;
  label: string;
  description: string;
  required_entitlement: string;
  hidden?: boolean;
}

interface Subscriber {
  type?: string;
  tags?: Array<string | { name?: string }>;
}

interface SubscriberEntitlementInput {
  email?: unknown;
  subscriber?: Subscriber | null;
  status?: unknown;
}

const MODE_DEFINITIONS: Record<ConversationMode, ModeDefinition> = {
  thingy: {
    id: 'thingy',
    label: 'Thingy',
    description: "Explore Jamie Thingelstad's published archive with the default archive agent.",
    required_entitlement: 'reader'
  },
  research_guide: {
    id: 'research_guide',
    label: 'Research Guide',
    description: 'Deeper synthesis, timelines, and reading paths for supporting members.',
    required_entitlement: 'supporting_member'
  },
  thought_partner: {
    id: 'thought_partner',
    label: 'Thought Partner',
    description: 'A more reflective mode for Jamie to interrogate patterns in his published work.',
    required_entitlement: 'owner'
  },
  trusted_circle: {
    id: 'trusted_circle',
    label: 'Trusted Circle',
    description: 'A warmer, closer-reader posture for explicitly invited people.',
    required_entitlement: 'trusted_circle'
  }
};

const DEFAULT_OWNER_EMAIL = 'jamie@thingelstad.com';

function normalizeEmail(value: unknown) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function emailHash(value: unknown) {
  return crypto.createHash('sha256').update(normalizeEmail(value)).digest('hex');
}

function csv(value: unknown) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function subscriberTagNames(subscriber: Subscriber | null | undefined) {
  const tags = Array.isArray(subscriber?.tags) ? subscriber.tags : [];
  const names: string[] = [];
  for (const tag of tags) {
    const name = typeof tag === 'string' ? tag : tag?.name;
    const clean = String(name || '')
      .trim()
      .toLowerCase();
    if (clean && !names.includes(clean)) names.push(clean);
  }
  return names;
}

export function ownerEmailHashes() {
  const emails = csv(process.env.THINGY_OWNER_EMAILS || DEFAULT_OWNER_EMAIL).map(emailHash);
  const hashes = csv(process.env.THINGY_OWNER_EMAIL_HASHES);
  return Array.from(new Set([...emails, ...hashes].map((value) => value.toLowerCase())));
}

export function isOwnerEmail(email: unknown) {
  return ownerEmailHashes().includes(emailHash(email));
}

export function isOwnerSubscriberHash(subscriberHash: unknown) {
  return ownerEmailHashes().includes(
    String(subscriberHash || '')
      .trim()
      .toLowerCase()
  );
}

export function entitlementsForSubscriber({
  email = '',
  subscriber = null,
  status = ''
}: SubscriberEntitlementInput = {}) {
  const normalizedStatus = String(status || subscriber?.type || '')
    .trim()
    .toLowerCase();
  const subscriberType = String(subscriber?.type || '')
    .trim()
    .toLowerCase();
  const tags = subscriberTagNames(subscriber);
  const entitlements = new Set<string>(['reader']);

  if (
    ['premium', 'gifted'].includes(normalizedStatus) ||
    ['premium', 'gifted'].includes(subscriberType) ||
    tags.includes('thingy-supporting-member')
  ) {
    entitlements.add('supporting_member');
  }
  if (tags.some((tag) => ['thingy-trusted-circle', 'thingy-family', 'thingy-close-friends'].includes(tag))) {
    entitlements.add('trusted_circle');
  }
  if (isOwnerEmail(email) || tags.includes('thingy-owner')) {
    entitlements.add('owner');
    entitlements.add('supporting_member');
    entitlements.add('trusted_circle');
  }

  return Array.from(entitlements);
}

export function normalizeConversationMode(value: unknown): ConversationMode {
  const key = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return key in MODE_DEFINITIONS ? (key as ConversationMode) : DEFAULT_CONVERSATION_MODE;
}

export function canUseConversationMode(mode: unknown, entitlements: readonly unknown[] = []) {
  const normalized = normalizeConversationMode(mode);
  const required = MODE_DEFINITIONS[normalized]?.required_entitlement || 'reader';
  return new Set(entitlements.map((value) => String(value))).has(required);
}

export function resolveConversationMode(value: unknown, entitlements: readonly unknown[] = []) {
  const normalized = normalizeConversationMode(value);
  return canUseConversationMode(normalized, entitlements) ? normalized : DEFAULT_CONVERSATION_MODE;
}

export function conversationModeDefinition(mode: unknown) {
  return MODE_DEFINITIONS[normalizeConversationMode(mode)] || MODE_DEFINITIONS[DEFAULT_CONVERSATION_MODE];
}

export function availableConversationModes(entitlements: readonly unknown[] = []) {
  return Object.values(MODE_DEFINITIONS)
    .filter((mode) => !mode.hidden && canUseConversationMode(mode.id, entitlements))
    .map((mode) => ({ ...mode }));
}

export function entitlementContext(entitlements: readonly unknown[] = []) {
  const values = Array.from(new Set(entitlements.map((item) => String(item || '').trim()).filter(Boolean)));
  return values.length ? values : ['reader'];
}

export function conversationModePrompt(mode: unknown) {
  const normalized = normalizeConversationMode(mode);
  if (normalized === 'thought_partner') {
    return [
      'Conversation mode: Thought Partner.',
      'This mode is for Jamie, the author of the archive, using the published archive only.',
      'Respond as a candid, constructive thought partner rather than a docent for a general reader.',
      'Use the archive to reflect patterns back to Jamie, identify tensions or changes over time, name assumptions, and ask sharper follow-up questions when useful.',
      'Prefer sharp distinctions over exhaustive coverage. When Jamie proposes a thesis, separate the thesis he may want to argue from the tighter thesis the archive actually supports.',
      'Push back gently when the evidence supports it, but stay grounded in retrieved sources and do not pretend to know unpublished motives or private context.',
      'Do not narrate your research process; start with the useful pushback, distinction, or recommendation.',
      'Do not introduce private-draft or hidden-corpus claims; this mode changes posture, not archive scope.'
    ].join('\n');
  }
  if (normalized === 'research_guide') {
    return [
      'Conversation mode: Research Guide.',
      'Favor deeper synthesis, timelines, comparisons, and guided reading paths through the published archive.',
      'For timelines and research tables, distinguish contemporaneous evidence from later retrospective evidence. If a later source supports an earlier-era claim, label it as retrospective instead of presenting it as direct evidence from that year.',
      'Structure the answer so a reader can keep researching: name questions, eras, source types, and the strongest next sources.',
      'Still stay grounded in retrieved evidence and avoid general-purpose answers outside the archive.'
    ].join('\n');
  }
  if (normalized === 'trusted_circle') {
    return [
      'Conversation mode: Trusted Circle.',
      "Use a warmer closer-reader tone while staying grounded in Jamie's published archive.",
      'Be comfortable being brief and gently opinionated when the reader asks for a nudge rather than a report.',
      'When recommending one source, ground the recommendation in at least one concrete detail from the source or retrieved evidence; do not rely on the title alone.',
      'Do not assume private facts or privileged access.'
    ].join('\n');
  }
  return [
    'Conversation mode: Thingy.',
    'Use the default public archive-agent posture for an authenticated reader.',
    'Be useful and grounded without becoming a research report. If the reader asks for a concise answer or one recommendation, keep the answer compact and avoid extra tool fan-out once the evidence is good enough.'
  ].join('\n');
}
