import { entitlementContext, isOwnerSubscriberHash } from './conversation-modes.mjs';

// A research conversation is the product's long game; 8 messages at 700
// chars made Thingy forget the thread fast and read truncated versions of
// its own answers. The static system prompt is cached and history rides
// after the cachePoint, so the wider window costs little.
const MAX_HISTORY_MESSAGES = 24;
const MAX_HISTORY_CHARS = 16000;
const MAX_HISTORY_MESSAGE_CHARS = 1500;

interface HistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

interface ClientContext {
  locale: string;
  time_zone: string;
  utc_offset_minutes: number | null;
  local_iso: string;
  local_date: string;
  local_time: string;
  day_period: string;
}

interface UserProfile {
  status: string;
  supporting_member: boolean;
  returning: boolean;
  preferred_name: string;
  awaiting_name: boolean;
  first_seen_at: string;
  last_seen_at: string;
  turn_count: number | null;
}

export function sanitizeHistory(history: unknown): HistoryItem[] {
  if (!Array.isArray(history)) return [];
  // Walk newest-first so the char budget evicts the OLDEST turns. The
  // previous oldest-first walk broke on budget overflow and silently
  // dropped the most recent messages - the ones the reply depends on.
  const cleaned: HistoryItem[] = [];
  let chars = 0;
  for (const item of history.slice(-MAX_HISTORY_MESSAGES).reverse()) {
    const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'user' ? 'user' : '';
    const content = String(item?.content || '')
      .trim()
      .replace(/\s+/g, ' ');
    if (!role || !content) continue;
    const clipped = content.slice(0, MAX_HISTORY_MESSAGE_CHARS);
    if (chars + clipped.length > MAX_HISTORY_CHARS) break;
    chars += clipped.length;
    cleaned.push({ role, content: clipped });
  }
  return cleaned.reverse();
}

export function conversationContext(history: HistoryItem[]) {
  if (!history.length) return 'No earlier conversation in this session.';
  return history.map((item) => `${item.role === 'user' ? 'User' : 'Thingy'}: ${item.content}`).join('\n');
}

function cleanContextString(value: unknown, maxLength = 120) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);
}

export function normalizeClientContext(value: unknown): ClientContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      locale: '',
      time_zone: '',
      utc_offset_minutes: null,
      local_iso: '',
      local_date: '',
      local_time: '',
      day_period: ''
    };
  }
  const record = value as Record<string, unknown>;
  const dayPeriod = cleanContextString(record.day_period, 20).toLowerCase();
  const offsetMinutes = Number(record.utc_offset_minutes);
  return {
    locale: cleanContextString(record.locale, 40),
    time_zone: cleanContextString(record.time_zone, 80),
    utc_offset_minutes:
      Number.isFinite(offsetMinutes) && Math.abs(offsetMinutes) <= 14 * 60 ? Math.trunc(offsetMinutes) : null,
    local_iso: cleanContextString(record.local_iso, 40),
    local_date: cleanContextString(record.local_date, 80),
    local_time: cleanContextString(record.local_time, 60),
    day_period: ['morning', 'afternoon', 'evening', 'night'].includes(dayPeriod) ? dayPeriod : ''
  };
}

export function normalizeUserProfile(value: unknown): UserProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      status: '',
      supporting_member: false,
      returning: false,
      preferred_name: '',
      awaiting_name: false,
      first_seen_at: '',
      last_seen_at: '',
      turn_count: null
    };
  }
  const record = value as Record<string, unknown>;
  const status = cleanContextString(record.status, 30).toLowerCase();
  const turnCount = Number(record.turn_count);
  return {
    status: cleanContextString(status, 30),
    supporting_member: record.supporting_member === true || status === 'premium',
    returning: record.returning === true,
    preferred_name: cleanContextString(record.preferred_name, 80),
    awaiting_name: record.awaiting_name === true,
    first_seen_at: cleanContextString(record.first_seen_at, 40),
    last_seen_at: cleanContextString(record.last_seen_at, 40),
    turn_count: Number.isFinite(turnCount) && turnCount >= 0 ? Math.trunc(turnCount) : null
  };
}

function titleCasePreferredName(value: unknown) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .slice(0, 4)
    .map((word) => (/^[A-Z]{2,}$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
    .slice(0, 80);
}

export function extractPreferredNameFromMessage(message: unknown) {
  const text = String(message || '').trim();
  if (!text || text.length > 160 || /[?]/.test(text)) return '';
  const match = text.match(
    /^(?:my (?:preferred )?name is|i am|i'm|call me|please call me)\s+([a-z][a-z .'’-]{0,60})[.!]?$/i
  );
  if (!match) return '';
  const candidate = match[1].trim().replace(/[.!]+$/, '');
  if (!/^[a-z][a-z .'’-]{0,60}$/i.test(candidate)) return '';
  return titleCasePreferredName(candidate);
}

export function readerContextPrompt(clientContext: unknown, userProfile: unknown) {
  const context = normalizeClientContext(clientContext);
  const profile = normalizeUserProfile(userProfile);
  const lines = [];
  if (context.local_date || context.local_time) {
    lines.push(`Reader local time: ${[context.local_date, context.local_time].filter(Boolean).join(' at ')}`);
  }
  if (context.time_zone) lines.push(`Reader time zone: ${context.time_zone}`);
  if (context.utc_offset_minutes !== null) lines.push(`Reader UTC offset minutes: ${context.utc_offset_minutes}`);
  if (context.locale) lines.push(`Reader locale: ${context.locale}`);
  if (context.day_period) lines.push(`Reader day period: ${context.day_period}`);
  if (context.local_iso) lines.push(`Reader local timestamp: ${context.local_iso}`);
  if (profile.status) lines.push(`Subscriber status: ${profile.status}`);
  if (profile.supporting_member) lines.push('Subscriber is a Weekly Thing Supporting Member.');
  if (profile.preferred_name) lines.push(`Reader preferred name: ${profile.preferred_name}`);
  if (profile.awaiting_name && !profile.preferred_name)
    lines.push('Thingy recently asked what to call the reader; their next short response may be a name.');
  if (profile.turn_count !== null) lines.push(`Prior Thingy turns known to client: ${profile.turn_count}`);
  if (profile.returning) lines.push('Client profile says this is a returning Thingy reader.');
  if (profile.first_seen_at) lines.push(`First seen by Thingy: ${profile.first_seen_at}`);
  if (profile.last_seen_at) lines.push(`Last seen by Thingy: ${profile.last_seen_at}`);
  return lines.length ? lines.join('\n') : 'No reader-local context supplied.';
}

export function tokenEntitlements(payload: Record<string, unknown> | null | undefined) {
  const entitlements = new Set<string>(
    Array.isArray(payload?.entitlements)
      ? payload.entitlements.filter((value): value is string => typeof value === 'string')
      : ['reader']
  );
  if (isOwnerSubscriberHash(payload?.sub)) {
    entitlements.add('owner');
    entitlements.add('supporting_member');
    entitlements.add('trusted_circle');
  }
  return entitlementContext([...entitlements]);
}
