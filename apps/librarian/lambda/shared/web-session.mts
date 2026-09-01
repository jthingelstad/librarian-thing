import crypto from 'node:crypto';
import type { LibrarianHttpEvent, LibrarianHttpResponse } from './http.mjs';
import { normalizeHeaders } from './http.mjs';
import { extractBearer } from './session.mjs';

// Cookie container for the web session token (Phase C of the AWS migration).
// The token inside is the same HMAC-signed compact token session.mts has
// always minted; the cookie is a container, not a credential format. The
// __Host- prefix makes the browser enforce Secure + Path=/ + no Domain, which
// pins the cookie to exactly thingy.thingelstad.com.
export const SESSION_COOKIE = '__Host-thingy_session';

// Cookie-authenticated requests are honored only when the request came
// through the thingy distribution (CloudFront stamps this marker on its API
// origins) AND carries the contract header no cross-site request can attach
// without a failing CORS preflight. Bearer requests are exempt: an explicit
// header is not an ambient credential, so CSRF does not apply.
function markerOk(event: LibrarianHttpEvent | null | undefined) {
  const expected = String(process.env.THINGY_WEB_ORIGIN_TOKEN || '');
  // Unset marker env disables cookie auth entirely (safe default) rather
  // than accepting cookies from any path.
  if (!expected) return false;
  const supplied = String(normalizeHeaders(event?.headers || {})['x-thingy-origin'] || '');
  if (!supplied) return false;
  const expectedDigest = crypto.createHash('sha256').update(expected).digest();
  const suppliedDigest = crypto.createHash('sha256').update(supplied).digest();
  return crypto.timingSafeEqual(expectedDigest, suppliedDigest);
}

function contractHeaderPresent(event: LibrarianHttpEvent | null | undefined) {
  return Boolean(normalizeHeaders(event?.headers || {})['x-librarian-contract-version']);
}

export function sessionCookie(event: LibrarianHttpEvent | null | undefined) {
  for (const entry of event?.cookies || []) {
    const separator = entry.indexOf('=');
    if (separator > 0 && entry.slice(0, separator) === SESSION_COOKIE) {
      return entry.slice(separator + 1).trim();
    }
  }
  return '';
}

export interface ResolvedSessionCredential {
  token: string;
  source: 'bearer' | 'cookie' | 'none';
}

// Explicit Bearer (or legacy body token) always wins - it is the permanent
// path for qa-real, local dev against the live backend, and any non-browser
// client. The cookie is the web app's path and carries the CSRF conditions.
export function resolveSessionToken(
  event: LibrarianHttpEvent | null | undefined,
  body: Record<string, unknown> = {}
): ResolvedSessionCredential {
  const bearer = extractBearer(event, body);
  if (bearer) return { token: bearer, source: 'bearer' };
  const cookie = sessionCookie(event);
  if (cookie && markerOk(event) && contractHeaderPresent(event)) {
    return { token: cookie, source: 'cookie' };
  }
  return { token: '', source: 'none' };
}

function cookieAttributes(maxAgeSeconds: number) {
  return `Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
}

// Attach (or refresh) the session cookie on a response. API Gateway HTTP API
// v2 emits Set-Cookie headers from the response `cookies` array.
export function withSessionCookie(
  response: LibrarianHttpResponse,
  token: string,
  expiresAtSeconds: number
): LibrarianHttpResponse {
  const maxAge = Math.max(0, expiresAtSeconds - Math.floor(Date.now() / 1000));
  response.cookies = [
    ...(response.cookies || []).filter((entry) => !entry.startsWith(`${SESSION_COOKIE}=`)),
    `${SESSION_COOKIE}=${token}; ${cookieAttributes(maxAge)}`
  ];
  return response;
}

export function withClearedSessionCookie(response: LibrarianHttpResponse): LibrarianHttpResponse {
  response.cookies = [
    ...(response.cookies || []).filter((entry) => !entry.startsWith(`${SESSION_COOKIE}=`)),
    `${SESSION_COOKIE}=; ${cookieAttributes(0)}`
  ];
  return response;
}
