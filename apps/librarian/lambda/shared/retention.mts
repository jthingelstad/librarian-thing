const SECONDS_PER_DAY = 24 * 60 * 60;

export const DEFAULT_CONVERSATION_RETENTION_DAYS = 45;

type DateInput = Date | string | number;

function retentionDays(envName: string, fallback: number) {
  const value = Number(process.env[envName] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function epochSeconds(value: DateInput = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const milliseconds = date.getTime();
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : Math.floor(Date.now() / 1000);
}

export function ttlSecondsFrom(value: DateInput, days: number) {
  return epochSeconds(value) + Math.ceil(Number(days) * SECONDS_PER_DAY);
}

export function conversationTtlSeconds(now: DateInput = new Date()) {
  return ttlSecondsFrom(now, retentionDays('THINGY_CONVERSATION_RETENTION_DAYS', DEFAULT_CONVERSATION_RETENTION_DAYS));
}
