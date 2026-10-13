type LogFields = Record<string, unknown>;

interface ErrorLike {
  name?: string;
  message?: string;
  code?: unknown;
  Code?: unknown;
  $metadata?: { httpStatusCode?: number };
  constructor?: { name?: string };
}

export function logEvent(
  level: string,
  message: string,
  fields: LogFields = {},
  service = process.env.LIBRARIAN_SERVICE_NAME || 'weekly-thing-librarian'
) {
  const record = {
    level,
    message,
    service,
    timestamp: Math.floor(Date.now() / 1000),
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null))
  };
  if (process.env.LIBRARIAN_NATIVE_HTTP === '1') console.info(record);
  else console.log(JSON.stringify(record));
}

function sanitizeErrorMessage(message: unknown) {
  return String(message || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 360);
}

export function errorFields(error: unknown, fields: LogFields = {}) {
  const candidate: ErrorLike = error && typeof error === 'object' ? (error as ErrorLike) : {};
  const name = candidate.name || candidate.constructor?.name || 'Error';
  const code = candidate.code || candidate.Code || candidate.$metadata?.httpStatusCode;
  const message = sanitizeErrorMessage(candidate.message);
  return {
    ...fields,
    error_type: candidate.constructor?.name || name,
    error_name: name,
    error_code: code,
    error_message: message || undefined
  };
}

export function truthyEnv(name: string, defaultValue = '0') {
  const value = String(process.env[name] ?? defaultValue)
    .trim()
    .toLowerCase();
  return !['', '0', 'false', 'no', 'off'].includes(value);
}
