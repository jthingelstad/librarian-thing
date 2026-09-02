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

// Cookie-authenticated requests are honored only when the request carries
// the marker CloudFront stamps on the thingy distribution's API origins AND
// the contract header. The marker's job is blocking direct-to-origin cookie
// replay and acting as a kill switch - it does NOT stop CSRF (a cross-site
// POST routed through the distribution gets stamped too); the CSRF controls
// are SameSite=Lax plus the custom contract header, which no cross-site
// request can attach without a failing CORS preflight. Bearer requests are
// exempt: an explicit header is not an ambient credential.
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

// Guest-lane gate: guests can only arrive through the thingy
// distribution, which stamps the origin marker on every /api request -
// a fleet POSTing the Lambda URL directly never carries it. When the
// marker env is unset (local dev without the token, or the kill-switch
// wipe) the gate stands DOWN rather than killing the guest feature:
// unlike cookies, there is no ambient credential to protect here.
export function guestOriginOk(event: LibrarianHttpEvent | null | undefined) {
  if (!String(process.env.THINGY_WEB_ORIGIN_TOKEN || '')) return true;
  return markerOk(event);
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
