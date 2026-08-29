import crypto from 'node:crypto';

const DEFAULT_MAGIC_LINK_TTL_SECONDS = 15 * 60;
const MAGIC_TOKEN_BYTES = 32;
const MAGIC_TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

export function magicLinkTtlSeconds() {
  const value = Number(process.env.THINGY_MAGIC_LINK_TTL_SECONDS || DEFAULT_MAGIC_LINK_TTL_SECONDS);
  return Number.isFinite(value) && value >= 60 ? Math.floor(value) : DEFAULT_MAGIC_LINK_TTL_SECONDS;
}

export function createMagicToken() {
  return crypto.randomBytes(MAGIC_TOKEN_BYTES).toString('base64url');
}

export function validMagicToken(token: unknown) {
  const value = String(token || '').trim();
  return MAGIC_TOKEN_RE.test(value) ? value : '';
}

export function magicTokenHash(token: unknown) {
  return crypto.createHash('sha256').update(validMagicToken(token)).digest('hex');
}

export function magicLinkBaseUrl() {
  return String(process.env.THINGY_MAGIC_LINK_BASE_URL || 'https://thingy.thingelstad.com/').trim();
}

const MAGIC_CODE_RE = /^[0-9]{6}$/;

// The visible sign-in code that rides in the email alongside the link.
// Six digits so Apple Mail's verification-code detection and Safari's
// one-time-code autofill both engage; brute force is handled by the
// attempt cap on the pending record, not by code entropy.
export function createMagicCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

export function validMagicCode(code: unknown) {
  const value = String(code || '')
    .replace(/[^0-9]/g, '')
    .trim();
  return MAGIC_CODE_RE.test(value) ? value : '';
}

export function magicCodeHash(code: unknown) {
  return crypto
    .createHash('sha256')
    .update(String(code || ''))
    .digest('hex');
}

export function buildMagicLink(token: unknown, baseUrl = magicLinkBaseUrl()) {
  const value = validMagicToken(token);
  if (!value) throw new Error('Invalid magic token');
  const url = new URL(baseUrl || 'https://thingy.thingelstad.com/');
  url.searchParams.set('login_token', value);
  return url.toString();
}
