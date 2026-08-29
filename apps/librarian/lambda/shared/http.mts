import { LIBRARIAN_CONTRACT_VERSION } from './librarian-contract.mjs';

export interface LibrarianHttpEvent {
  headers?: Record<string, unknown> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string | undefined> | null;
  rawQueryString?: string;
  requestContext?: {
    requestId?: string;
    http?: { method?: string; sourceIp?: string };
    identity?: { sourceIp?: string };
  };
  httpMethod?: string;
  rawPath?: string;
  path?: string;
}

interface LibrarianRequestContext {
  awsRequestId?: string;
}

export interface LibrarianHttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export function allowedOrigins() {
  return String(process.env.ALLOWED_ORIGIN || 'https://weekly.thingelstad.com')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function normalizeHeaders(headers: Record<string, unknown> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), String(value ?? '')])
  );
}

export function corsOrigin(event?: LibrarianHttpEvent | null) {
  const origins = allowedOrigins();
  const origin = String(normalizeHeaders(event?.headers || {}).origin || '');
  if (origin && origins.includes(origin)) return origin;
  return origins[0] || 'https://weekly.thingelstad.com';
}

export function jsonResponse(
  statusCode: number,
  payload: unknown,
  event?: LibrarianHttpEvent | null,
  headers: Record<string, string> = {}
): LibrarianHttpResponse {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-librarian-contract-version': LIBRARIAN_CONTRACT_VERSION,
      'access-control-allow-origin': corsOrigin(event),
      'access-control-allow-headers': 'content-type, authorization, x-librarian-contract-version',
      'access-control-allow-methods': 'GET,OPTIONS,POST',
      'access-control-expose-headers': 'x-librarian-contract-version, x-request-id',
      ...headers
    },
    body: JSON.stringify(payload)
  };
}

export function parseBody(event?: LibrarianHttpEvent | null): Record<string, unknown> {
  const body = event?.body || '{}';
  const text = event?.isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
  const contentType = normalizeHeaders(event?.headers || {})['content-type'] || '';
  if (contentType.split(';')[0].trim() === 'application/x-www-form-urlencoded') {
    // OAuth token/authorize requests (RFC 6749) and plain HTML form posts.
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// HTML responses for the OAuth authorize pages. Deliberately no CORS headers:
// the authorization endpoint is a top-level browser navigation, not an API.
export function htmlResponse(
  statusCode: number,
  html: string,
  headers: Record<string, string> = {}
): LibrarianHttpResponse {
  return {
    statusCode,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src https://thingy.thingelstad.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
      ...headers
    },
    body: html
  };
}

export function methodAndPath(event?: LibrarianHttpEvent | null) {
  const method = (event?.requestContext?.http?.method || event?.httpMethod || 'GET').toUpperCase();
  const path = (event?.rawPath || event?.path || '/').replace(/\/$/, '') || '/';
  return { method, path };
}

export function eventSummary(event?: LibrarianHttpEvent | null, context?: LibrarianRequestContext | null) {
  const { method, path } = methodAndPath(event);
  return {
    request_id: context?.awsRequestId || event?.requestContext?.requestId || '',
    method,
    path,
    origin: normalizeHeaders(event?.headers || {}).origin
  };
}

export function clientSourceIp(event?: LibrarianHttpEvent | null) {
  return event?.requestContext?.http?.sourceIp || event?.requestContext?.identity?.sourceIp || '';
}

export function userAgent(event?: LibrarianHttpEvent | null) {
  return normalizeHeaders(event?.headers || {})['user-agent'] || '';
}
