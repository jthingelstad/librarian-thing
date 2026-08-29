import { fetchSubscriber, subscriberStatus } from '../shared/buttondown.mjs';
import { entitlementsForSubscriber } from '../shared/conversation-modes.mjs';
import { htmlResponse, methodAndPath, parseBody } from '../shared/http.mjs';
import type { LibrarianHttpEvent, LibrarianHttpResponse } from '../shared/http.mjs';
import { errorFields, logEvent } from '../shared/logging.mjs';
import { validMagicCode } from '../shared/magic-link.mjs';
import { clientIdentityHash, sendLoginCodeEmail, verifyPendingCode } from '../shared/magic-login.mjs';
import type { OauthClient, OauthPending } from '../shared/oauth-store.mjs';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  createAuthCode,
  createClient,
  createPendingAuthorization,
  deletePending,
  getClient,
  getPending,
  mintTokens,
  normalizeScope,
  OAUTH_SCOPES,
  redeemAuthCode,
  redeemRefreshToken,
  sanitizeClientName,
  updatePending,
  validateRedirectUris,
  validCodeChallenge,
  validCodeVerifier,
  validState,
  verifyPkce
} from '../shared/oauth-store.mjs';
import { checkRateLimit } from '../shared/rate-limit.mjs';
import { emailHash, normalizeEmail } from '../shared/session.mjs';

// OAuth 2.1 authorization server for the Librarian MCP surface (Phase 2).
// Public clients only (PKCE, no client secrets). The authorize flow verifies
// the reader with the same emailed sign-in code Thingy uses.

const REGISTER_RATE_LIMIT_MAX = 10;
const TOKEN_RATE_LIMIT_MAX = 120;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DEFAULT_CLIENT_NAME = 'MCP client';

type JsonRecord = Record<string, unknown>;

export function oauthIssuer() {
  return String(process.env.LIBRARIAN_OAUTH_ISSUER || 'https://librarian.thingelstad.com')
    .trim()
    .replace(/\/+$/, '');
}

// RFC 8414 authorization server metadata.
export function authorizationServerMetadata() {
  const issuer = oauthIssuer();
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: OAUTH_SCOPES
  };
}

// RFC 9728 protected resource metadata.
export function protectedResourceMetadata() {
  const issuer = oauthIssuer();
  return {
    resource: issuer,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: OAUTH_SCOPES
  };
}

// Plain JSON responses for the OAuth protocol endpoints. Deliberately not
// jsonResponse: no CORS headers and no Thingy contract header belong here.
function oauthJson(statusCode: number, payload: unknown, headers: Record<string, string> = {}): LibrarianHttpResponse {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      pragma: 'no-cache',
      ...headers
    },
    body: JSON.stringify(payload)
  };
}

function tokenError(error: string, description?: string) {
  return oauthJson(400, { error, ...(description ? { error_description: description } : {}) });
}

export function handleOauthMetadata(event: LibrarianHttpEvent) {
  const { path } = methodAndPath(event);
  const payload = path.endsWith('/.well-known/oauth-protected-resource')
    ? protectedResourceMetadata()
    : authorizationServerMetadata();
  return oauthJson(200, payload, { 'cache-control': 'public, max-age=300' });
}

// --- Dynamic client registration (RFC 7591 subset) -------------------------

export async function handleRegister(event: LibrarianHttpEvent) {
  if (!(await checkRateLimit(`oauth#register:${clientIdentityHash(event)}`, REGISTER_RATE_LIMIT_MAX))) {
    logEvent('warning', 'oauth_register_rate_limited', {});
    return oauthJson(429, { error: 'invalid_client_metadata', error_description: 'Too many registrations.' });
  }
  const body = parseBody(event);
  const redirectUris = validateRedirectUris(body.redirect_uris);
  if (!redirectUris) {
    logEvent('info', 'oauth_register_rejected', { reason: 'invalid_redirect_uris' });
    return oauthJson(400, {
      error: 'invalid_redirect_uri',
      error_description:
        'redirect_uris must be 1-5 absolute https URLs (http is allowed only for localhost or 127.0.0.1).'
    });
  }
  const clientName = sanitizeClientName(body.client_name) || DEFAULT_CLIENT_NAME;
  const client = await createClient({ clientName, redirectUris });
  return oauthJson(201, {
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: 'none'
  });
}

// --- Authorize pages -------------------------------------------------------

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Minimal page shell matching Thingy's sign-in look: dark-friendly, the
// Thingy robot, system font stack. All styling inline; CSP forbids scripts.
function pageHtml(title: string, inner: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  background: #f5f2ec; color: #2b2622;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
@media (prefers-color-scheme: dark) { body { background: #191512; color: #efe9df; } .card { background: #241f1b; border-color: #3a332c; } input { background: #191512; color: #efe9df; border-color: #4a4139; } .muted { color: #a89c8e; } }
.card { width: min(92vw, 24rem); background: #fffdf9; border: 1px solid #e0d8ca; border-radius: 12px; padding: 2rem; box-sizing: border-box; text-align: center; }
img.robot { width: 72px; height: 72px; }
h1 { font-size: 1.2rem; margin: 0.75rem 0 0.5rem; }
p { font-size: 0.95rem; line-height: 1.45; margin: 0.5rem 0 1rem; }
.muted { color: #7a6f61; font-size: 0.85rem; }
.error { color: #b3402a; font-size: 0.9rem; margin: 0.5rem 0 1rem; }
input { width: 100%; box-sizing: border-box; font-size: 1rem; padding: 0.6rem 0.7rem; border: 1px solid #cbc1b1; border-radius: 8px; margin-bottom: 1rem; font-family: inherit; }
input.code { text-align: center; letter-spacing: 0.4em; font-variant-numeric: tabular-nums; }
button { width: 100%; font-size: 1rem; padding: 0.65rem; border: 0; border-radius: 8px; background: #2f6f4f; color: #fff; cursor: pointer; }
button.secondary { background: transparent; color: inherit; border: 1px solid #cbc1b1; margin-top: 0.6rem; }
form { margin: 0; }
</style>
</head>
<body>
<main class="card">
<img class="robot" src="https://thingy.thingelstad.com/img/thingy.png" alt="Thingy">
${inner}
</main>
</body>
</html>
`;
}

function hiddenPendingField(pendingId: string) {
  return `<input type="hidden" name="pending" value="${escapeHtml(pendingId)}">`;
}

function errorPage(statusCode: number, title: string, message: string) {
  return htmlResponse(statusCode, pageHtml(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`));
}

function emailStepPage(pendingId: string, clientName: string, errorMessage = '') {
  const inner = `<h1>Connect ${escapeHtml(clientName)}</h1>
<p>Sign in with the email you use for The Weekly Thing. Thingy will email you a six-digit code.</p>
${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ''}
<form method="post" action="authorize">
${hiddenPendingField(pendingId)}
<input type="hidden" name="step" value="email">
<input type="email" name="email" placeholder="you@example.com" autocomplete="email" required autofocus>
<button type="submit">Email me a code</button>
</form>`;
  return htmlResponse(200, pageHtml('Sign in to Thingy', inner));
}

function codeStepPage(pendingId: string, email: string, errorMessage = '') {
  const inner = `<h1>Enter your code</h1>
<p>We sent a six-digit code to <strong>${escapeHtml(email)}</strong>. It expires in a few minutes.</p>
${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ''}
<form method="post" action="authorize">
${hiddenPendingField(pendingId)}
<input type="hidden" name="step" value="code">
<input class="code" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required autofocus>
<button type="submit">Verify</button>
</form>`;
  return htmlResponse(200, pageHtml('Enter your code', inner));
}

function consentPage(pendingId: string, clientName: string, scope: string) {
  const inner = `<h1>Allow ${escapeHtml(clientName)}?</h1>
<p><strong>${escapeHtml(clientName)}</strong> wants to search and read The Weekly Thing archive as you.</p>
<p class="muted">Scope: ${escapeHtml(scope)}</p>
<form method="post" action="authorize">
${hiddenPendingField(pendingId)}
<input type="hidden" name="step" value="approve">
<button type="submit" name="decision" value="approve">Allow</button>
<button class="secondary" type="submit" name="decision" value="deny">Deny</button>
</form>`;
  return htmlResponse(200, pageHtml('Approve access', inner));
}

function redirectWithParams(redirectUri: string, params: Record<string, string>): LibrarianHttpResponse {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== '') url.searchParams.set(key, value);
  }
  return {
    statusCode: 302,
    headers: { location: url.toString(), 'cache-control': 'no-store' },
    body: ''
  };
}

function authorizeErrorRedirect(redirectUri: string, error: string, state: string, description = '') {
  return redirectWithParams(redirectUri, { error, error_description: description, state });
}

function queryParams(event: LibrarianHttpEvent): JsonRecord {
  if (event.queryStringParameters) return { ...event.queryStringParameters };
  return Object.fromEntries(new URLSearchParams(event.rawQueryString || ''));
}

// Every request in the flow re-validates client_id and the exact registered
// redirect_uri. Requests with an unverified redirect_uri get an HTML error
// page and are never redirected.
async function loadValidatedClient(clientId: unknown, redirectUri: unknown) {
  const client = await getClient(String(clientId || ''));
  if (!client) return null;
  const uri = String(redirectUri || '');
  if (!client.redirectUris.includes(uri)) return null;
  return client;
}

const AUTHORIZE_RATE_LIMIT_MAX = 30;

async function handleAuthorizeGet(event: LibrarianHttpEvent) {
  // Each GET creates a pending row; cap churn per client identity.
  if (!(await checkRateLimit(`oauth#authorize:${clientIdentityHash(event)}`, AUTHORIZE_RATE_LIMIT_MAX))) {
    return errorPage(429, 'Slow down', 'Too many sign-in attempts. Please wait a bit and try again.');
  }
  const params = queryParams(event);
  const client = await loadValidatedClient(params.client_id, params.redirect_uri);
  if (!client) {
    logEvent('info', 'oauth_authorize_rejected', { reason: 'unknown_client_or_redirect' });
    return errorPage(
      400,
      'Sign-in request rejected',
      'This connection request came from an unknown app or an unregistered redirect address.'
    );
  }
  const redirectUri = String(params.redirect_uri || '');
  const state = validState(params.state);
  if (String(params.state ?? '').length > 512) {
    return authorizeErrorRedirect(redirectUri, 'invalid_request', '', 'state is too long');
  }
  if (String(params.response_type || '') !== 'code') {
    return authorizeErrorRedirect(redirectUri, 'unsupported_response_type', state);
  }
  const scope = normalizeScope(params.scope);
  if (!scope) {
    return authorizeErrorRedirect(redirectUri, 'invalid_scope', state);
  }
  const codeChallenge = validCodeChallenge(params.code_challenge);
  const codeChallengeMethod = String(params.code_challenge_method || 'S256');
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    return authorizeErrorRedirect(redirectUri, 'invalid_request', state, 'PKCE with S256 is required');
  }
  const pending = await createPendingAuthorization({
    clientId: client.clientId,
    redirectUri,
    scope,
    state,
    codeChallenge
  });
  logEvent('info', 'oauth_authorize_started', { client_id: client.clientId, scope });
  return emailStepPage(pending.id, client.clientName);
}

async function handleEmailStep(
  event: LibrarianHttpEvent,
  pending: OauthPending,
  client: OauthClient,
  body: JsonRecord,
  start: number
) {
  const email = normalizeEmail(body.email);
  if (!EMAIL_RE.test(email)) {
    return emailStepPage(pending.id, client.clientName, 'Enter a valid email address.');
  }
  let subscriber;
  try {
    subscriber = await fetchSubscriber(email);
  } catch (error) {
    logEvent('error', 'oauth_authorize_buttondown_lookup_failed', errorFields(error, { email_hash: emailHash(email) }));
    return emailStepPage(pending.id, client.clientName, 'Could not check that subscription right now. Try again.');
  }
  const status = subscriberStatus(subscriber);
  if (status !== 'active' && status !== 'premium') {
    logEvent('info', 'oauth_authorize_subscriber_not_active', {
      email_hash: emailHash(email),
      subscriber_status: status
    });
    return emailStepPage(
      pending.id,
      client.clientName,
      'That email is not an active Weekly Thing subscription. Subscribe first at thingelstad.com.'
    );
  }
  const sent = await sendLoginCodeEmail({ email, subscriber, source: 'thingy', event, start });
  if (sent.status === 'rate_limited') {
    return emailStepPage(pending.id, client.clientName, 'Too many sign-in emails. Wait a bit and try again.');
  }
  await updatePending(pending.id, { email, status: 'awaiting_code' });
  return codeStepPage(pending.id, email);
}

async function handleCodeStep(event: LibrarianHttpEvent, pending: OauthPending, client: OauthClient, body: JsonRecord) {
  if (pending.status !== 'awaiting_code' || !pending.email) {
    return emailStepPage(pending.id, client.clientName, 'Start again with your email address.');
  }
  const code = validMagicCode(body.code);
  if (!code) {
    return codeStepPage(pending.id, pending.email, 'Enter the six-digit code from the email.');
  }
  const result = await verifyPendingCode(pending.email, code, event);
  if (result.status === 'rate_limited') {
    return codeStepPage(pending.id, pending.email, 'Too many attempts. Wait a bit and try again.');
  }
  if (result.status === 'code_invalid' || result.status === 'link_invalid') {
    return codeStepPage(pending.id, pending.email, 'That code is not right or has expired. Check the newest email.');
  }
  if (result.status === 'subscriber_unavailable') {
    return codeStepPage(pending.id, pending.email, 'Could not confirm your subscription right now. Try again.');
  }
  if (result.status === 'not_active') {
    return emailStepPage(pending.id, client.clientName, 'That subscription is not active.');
  }
  const entitlements = entitlementsForSubscriber({
    email: result.email,
    subscriber: result.subscriber,
    status: result.subscriberStatus
  });
  await updatePending(pending.id, {
    subscriberHash: emailHash(result.email),
    entitlements: entitlements.map(String),
    status: 'verified'
  });
  logEvent('info', 'oauth_authorize_verified', {
    client_id: client.clientId,
    subscriber_hash: emailHash(result.email)
  });
  return consentPage(pending.id, client.clientName, pending.scope);
}

async function handleApproveStep(pending: OauthPending, client: OauthClient, body: JsonRecord) {
  if (pending.status !== 'verified' || !pending.subscriberHash) {
    return errorPage(400, 'Sign-in incomplete', 'Verify your email before approving access. Start over from the app.');
  }
  if (String(body.decision || '') !== 'approve') {
    await deletePending(pending.id);
    logEvent('info', 'oauth_authorize_denied', { client_id: client.clientId });
    return authorizeErrorRedirect(pending.redirectUri, 'access_denied', pending.state);
  }
  const code = await createAuthCode(pending);
  await deletePending(pending.id);
  logEvent('info', 'oauth_authorize_code_issued', {
    client_id: client.clientId,
    subscriber_hash: pending.subscriberHash,
    scope: pending.scope
  });
  return redirectWithParams(pending.redirectUri, { code, state: pending.state });
}

async function handleAuthorizePost(event: LibrarianHttpEvent, start: number) {
  const body = parseBody(event);
  const pending = await getPending(body.pending);
  if (!pending) {
    return errorPage(400, 'Sign-in expired', 'This sign-in session expired or is invalid. Start over from the app.');
  }
  // Re-validate the client and the exact redirect_uri on every step: a client
  // deleted or re-registered mid-flow must not receive a code.
  const client = await loadValidatedClient(pending.clientId, pending.redirectUri);
  if (!client) {
    return errorPage(
      400,
      'Sign-in request rejected',
      'This connection request came from an unknown app or an unregistered redirect address.'
    );
  }
  const step = String(body.step || '');
  if (step === 'email') return handleEmailStep(event, pending, client, body, start);
  if (step === 'code') return handleCodeStep(event, pending, client, body);
  if (step === 'approve') return handleApproveStep(pending, client, body);
  return errorPage(400, 'Sign-in request rejected', 'Unsupported sign-in step.');
}

export async function handleAuthorize(event: LibrarianHttpEvent, start = performance.now()) {
  const { method } = methodAndPath(event);
  if (method === 'GET') return handleAuthorizeGet(event);
  return handleAuthorizePost(event, start);
}

// --- Token endpoint --------------------------------------------------------

async function handleAuthorizationCodeGrant(body: JsonRecord) {
  const code = String(body.code || '');
  const redirectUri = String(body.redirect_uri || '');
  const clientId = String(body.client_id || '');
  const codeVerifier = validCodeVerifier(body.code_verifier);
  if (!code || !redirectUri || !clientId || !codeVerifier) {
    return tokenError('invalid_request', 'code, redirect_uri, client_id, and code_verifier are required');
  }
  const redeemed = await redeemAuthCode(code);
  if (!redeemed) {
    logEvent('info', 'oauth_token_code_rejected', { client_id: clientId });
    return tokenError('invalid_grant');
  }
  if (redeemed.clientId !== clientId || redeemed.redirectUri !== redirectUri) {
    logEvent('warning', 'oauth_token_code_binding_mismatch', { client_id: clientId });
    return tokenError('invalid_grant');
  }
  if (!verifyPkce(codeVerifier, redeemed.codeChallenge)) {
    logEvent('warning', 'oauth_token_pkce_failed', { client_id: clientId });
    return tokenError('invalid_grant');
  }
  const tokens = await mintTokens({
    clientId,
    subscriberHash: redeemed.subscriberHash,
    entitlements: redeemed.entitlements,
    scope: redeemed.scope
  });
  logEvent('info', 'oauth_token_issued', {
    client_id: clientId,
    subscriber_hash: redeemed.subscriberHash,
    grant_type: 'authorization_code'
  });
  return oauthJson(200, {
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: tokens.refreshToken,
    scope: tokens.scope
  });
}

async function handleRefreshTokenGrant(body: JsonRecord) {
  const refreshToken = String(body.refresh_token || '');
  const clientId = String(body.client_id || '');
  if (!refreshToken || !clientId) {
    return tokenError('invalid_request', 'refresh_token and client_id are required');
  }
  const result = await redeemRefreshToken(refreshToken, clientId);
  if (result.status === 'reuse_revoked') {
    logEvent('warning', 'oauth_refresh_reuse_detected', { client_id: clientId });
    return tokenError('invalid_grant');
  }
  if (result.status !== 'ok') {
    return tokenError('invalid_grant');
  }
  logEvent('info', 'oauth_token_issued', {
    client_id: clientId,
    subscriber_hash: result.grant.subscriberHash,
    grant_type: 'refresh_token'
  });
  return oauthJson(200, {
    access_token: result.tokens.accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: result.tokens.refreshToken,
    scope: result.tokens.scope
  });
}

export async function handleToken(event: LibrarianHttpEvent) {
  if (!(await checkRateLimit(`oauth#token:${clientIdentityHash(event)}`, TOKEN_RATE_LIMIT_MAX))) {
    logEvent('warning', 'oauth_token_rate_limited', {});
    return oauthJson(429, { error: 'invalid_request', error_description: 'Too many token requests.' });
  }
  const body = parseBody(event);
  const grantType = String(body.grant_type || '');
  if (grantType === 'authorization_code') return handleAuthorizationCodeGrant(body);
  if (grantType === 'refresh_token') return handleRefreshTokenGrant(body);
  return tokenError('unsupported_grant_type');
}
