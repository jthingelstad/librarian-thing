import crypto from 'node:crypto';
import { normalizeHeaders } from './http.mjs';

// 9 days, sliding: every visit re-mints (refresh_session), so an active
// reader rarely signs in again; only a 9-day absence expires the session.
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 9;
const PRIVILEGED_ENTITLEMENTS = new Set(['supporting_member', 'trusted_circle', 'owner']);

type Claims = Record<string, unknown>;

interface TokenEvent {
  headers?: Record<string, unknown> | null;
}

function b64url(value: string) {
  return Buffer.from(value).toString('base64url');
}

function b64urlDecode(value: string) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(value + padding, 'base64url');
}

export function sessionSecret() {
  const value = process.env.SESSION_SECRET || process.env.LIBRARIAN_SIGNING_SECRET;
  if (!value) throw new Error('SESSION_SECRET is required');
  return value;
}

export function normalizeEmail(email: unknown) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

export function emailHash(email: unknown) {
  return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

export function stableHash(value: unknown) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}

export function signPayload(payload: Claims) {
  const encoded = b64url(JSON.stringify(payload, Object.keys(payload).sort()));
  const signature = crypto.createHmac('sha256', sessionSecret()).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function createSessionToken(
  email: unknown,
  sessionId = crypto.randomBytes(18).toString('base64url'),
  claims: unknown = {}
) {
  const issuedAtMs = Date.now();
  const issuedAt = Math.floor(issuedAtMs / 1000);
  const expiresAt = issuedAt + SESSION_TTL_SECONDS;
  const safeClaims: Claims = claims && typeof claims === 'object' && !Array.isArray(claims) ? (claims as Claims) : {};
  const payloadClaims = { ...safeClaims };
  const entitlements = Array.isArray(payloadClaims.entitlements) ? payloadClaims.entitlements : [];
  if (
    entitlements.some((entitlement) => typeof entitlement === 'string' && PRIVILEGED_ENTITLEMENTS.has(entitlement)) &&
    !Number(payloadClaims.entitlements_verified_until || 0)
  ) {
    payloadClaims.entitlements_verified_until = expiresAt;
  }
  return {
    sessionId,
    expiresAt,
    token: signPayload({
      ...payloadClaims,
      sid: sessionId,
      sub: emailHash(email),
      exp: expiresAt,
      iat: issuedAt,
      iat_ms: issuedAtMs
    })
  };
}

// Refresh a session token from an already verified, stable subject hash.
export function createSessionTokenForSub(
  sub: string,
  sessionId = crypto.randomBytes(18).toString('base64url'),
  claims: unknown = {}
) {
  if (!sub || typeof sub !== 'string') {
    throw new Error('createSessionTokenForSub: sub must be a non-empty string');
  }
  const issuedAtMs = Date.now();
  const issuedAt = Math.floor(issuedAtMs / 1000);
  const expiresAt = issuedAt + SESSION_TTL_SECONDS;
  const safeClaims: Claims = claims && typeof claims === 'object' && !Array.isArray(claims) ? (claims as Claims) : {};
  const payloadClaims = { ...safeClaims };
  const entitlements = Array.isArray(payloadClaims.entitlements) ? payloadClaims.entitlements : [];
  if (
    entitlements.some((entitlement) => typeof entitlement === 'string' && PRIVILEGED_ENTITLEMENTS.has(entitlement)) &&
    !Number(payloadClaims.entitlements_verified_until || 0)
  ) {
    payloadClaims.entitlements_verified_until = expiresAt;
  }
  return {
    sessionId,
    expiresAt,
    token: signPayload({ ...payloadClaims, sid: sessionId, sub, exp: expiresAt, iat: issuedAt, iat_ms: issuedAtMs })
  };
}

export function verifyToken(token: unknown): Claims | null {
  try {
    const [encoded, signature] = String(token || '').split('.', 2);
    if (!encoded || !signature) return null;
    const expected = crypto.createHmac('sha256', sessionSecret()).update(encoded).digest();
    const supplied = b64urlDecode(signature);
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
    const payload: unknown = JSON.parse(b64urlDecode(encoded).toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const claims = payload as Claims;
    if (Number(claims.exp || 0) < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

export function extractBearer(event: TokenEvent | null | undefined, body: Claims = {}) {
  const auth = String(normalizeHeaders(event?.headers || {}).authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return String(body.token || '');
}
