import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCESS_TOKEN_PREFIX,
  AUTH_CODE_PREFIX,
  AUTH_CODE_TTL_SECONDS,
  REFRESH_TOKEN_PREFIX,
  buildAuthCodeItem,
  generateAccessToken,
  generateAuthCode,
  generateClientId,
  generateRefreshToken,
  normalizeScope,
  sanitizeClientName,
  sha256Hex,
  validCodeChallenge,
  validCodeVerifier,
  validClientId,
  validRedirectUri,
  validState,
  validateRedirectUris,
  verifyPkce
} from '../dist/shared/oauth-store.mjs';
import {
  authorizationServerMetadata,
  handleOauthMetadata,
  protectedResourceMetadata,
  oauthIssuer
} from '../dist/auth/oauth-routes.mjs';
import { htmlResponse, parseBody } from '../dist/shared/http.mjs';

// RFC 7636 appendix B test vector.
const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

test('verifyPkce accepts the RFC 7636 S256 vector and rejects everything else', () => {
  assert.equal(verifyPkce(PKCE_VERIFIER, PKCE_CHALLENGE), true);
  // Wrong verifier for the challenge.
  assert.equal(verifyPkce('a'.repeat(43), PKCE_CHALLENGE), false);
  // "plain" method (challenge equals verifier) must never verify.
  assert.equal(verifyPkce(PKCE_VERIFIER, PKCE_VERIFIER), false);
  // Malformed inputs.
  assert.equal(verifyPkce('short', PKCE_CHALLENGE), false);
  assert.equal(verifyPkce('', PKCE_CHALLENGE), false);
  assert.equal(verifyPkce(PKCE_VERIFIER, ''), false);
  assert.equal(verifyPkce(PKCE_VERIFIER, 'not+base64url/chars='), false);
});

test('token generation uses the lat_/lrt_/lac_ prefixes over 32 random bytes', () => {
  const access = generateAccessToken();
  const refresh = generateRefreshToken();
  const code = generateAuthCode();
  assert.ok(access.startsWith(ACCESS_TOKEN_PREFIX));
  assert.ok(refresh.startsWith(REFRESH_TOKEN_PREFIX));
  assert.ok(code.startsWith(AUTH_CODE_PREFIX));
  for (const token of [access, refresh, code]) {
    const random = token.slice(4);
    assert.equal(random.length, 43); // 32 bytes base64url
    assert.match(random, /^[A-Za-z0-9_-]+$/);
  }
  assert.notEqual(generateAccessToken(), generateAccessToken());
});

test('sha256Hex is deterministic and hashes the full prefixed token', () => {
  const token = `${ACCESS_TOKEN_PREFIX}abc123`;
  assert.equal(sha256Hex(token), sha256Hex(token));
  assert.match(sha256Hex(token), /^[0-9a-f]{64}$/);
  assert.notEqual(sha256Hex(token), sha256Hex('abc123'));
});

test('client ids are 22+ base64url chars', () => {
  const id = generateClientId();
  assert.match(id, /^[A-Za-z0-9_-]{22,}$/);
  assert.equal(validClientId(id), id);
  assert.equal(validClientId('short'), '');
  assert.equal(validClientId('has spaces not allowed!!'), '');
});

test('redirect_uri validation matrix', () => {
  // Absolute https is fine.
  assert.equal(validRedirectUri('https://example.com/callback'), 'https://example.com/callback');
  // localhost / 127.0.0.1 over http with any port is fine (local MCP clients).
  assert.equal(validRedirectUri('http://localhost/callback'), 'http://localhost/callback');
  assert.equal(validRedirectUri('http://localhost:8123/cb'), 'http://localhost:8123/cb');
  assert.equal(validRedirectUri('http://127.0.0.1:33418/oauth'), 'http://127.0.0.1:33418/oauth');
  // http anywhere else is rejected.
  assert.equal(validRedirectUri('http://example.com/callback'), '');
  assert.equal(validRedirectUri('http://localhost.evil.com/cb'), '');
  // Non-http(s) schemes, fragments, userinfo, relative, and junk are rejected.
  assert.equal(validRedirectUri('javascript:alert(1)'), '');
  assert.equal(validRedirectUri('https://example.com/cb#fragment'), '');
  assert.equal(validRedirectUri('https://user:pass@example.com/cb'), '');
  assert.equal(validRedirectUri('/relative/path'), '');
  assert.equal(validRedirectUri(''), '');

  // List validation: 1-5 entries, all valid, deduped.
  assert.deepEqual(validateRedirectUris(['https://a.example/cb']), ['https://a.example/cb']);
  assert.deepEqual(validateRedirectUris(['https://a.example/cb', 'https://a.example/cb']), ['https://a.example/cb']);
  assert.equal(validateRedirectUris([]), null);
  assert.equal(validateRedirectUris('https://a.example/cb'), null);
  assert.equal(validateRedirectUris(['https://a.example/cb', 'http://evil.com/cb']), null);
  assert.equal(validateRedirectUris(Array.from({ length: 6 }, (_, i) => `https://a.example/cb${i}`)), null);
});

test('exact redirect_uri matching is enforced against the registered list', () => {
  const registered = ['https://a.example/cb'];
  assert.equal(registered.includes('https://a.example/cb'), true);
  assert.equal(registered.includes('https://a.example/cb/'), false);
  assert.equal(registered.includes('https://a.example/cb?x=1'), false);
  assert.equal(registered.includes('https://a.example/other'), false);
});

test('client_name is sanitized', () => {
  assert.equal(sanitizeClientName('  My   MCP\tClient  '), 'My MCP Client');
  assert.equal(sanitizeClientName('<script>alert(1)</script>Claude'), 'scriptalert(1)/scriptClaude');
  assert.equal(sanitizeClientName('x'.repeat(300)).length, 100);
  assert.equal(sanitizeClientName('bellname'), 'bellname');
  assert.equal(sanitizeClientName(undefined), '');
});

test('scope, state, and PKCE parameter validators', () => {
  assert.equal(normalizeScope(''), 'archive:read');
  assert.equal(normalizeScope('archive:read'), 'archive:read');
  assert.equal(normalizeScope('archive:read archive:read'), 'archive:read');
  assert.equal(normalizeScope('archive:write'), '');
  assert.equal(validState('x'.repeat(512)), 'x'.repeat(512));
  assert.equal(validState('x'.repeat(513)), '');
  assert.equal(validState(undefined), '');
  assert.equal(validCodeChallenge(PKCE_CHALLENGE), PKCE_CHALLENGE);
  assert.equal(validCodeChallenge('a'.repeat(42)), '');
  assert.equal(validCodeChallenge('a'.repeat(129)), '');
  assert.equal(validCodeVerifier(PKCE_VERIFIER), PKCE_VERIFIER);
  assert.equal(validCodeVerifier('a'.repeat(42)), '');
});

test('auth-code rows snapshot the verified pending authorization', () => {
  const pending = {
    id: 'pending-id',
    clientId: 'client-1234567890123456789012',
    redirectUri: 'https://a.example/cb',
    scope: 'archive:read',
    state: 'opaque-state',
    codeChallenge: PKCE_CHALLENGE,
    codeChallengeMethod: 'S256',
    email: 'reader@example.com',
    subscriberHash: 'subhash',
    entitlements: ['reader', 'supporting_member'],
    status: 'verified',
    createdAt: 1000,
    expiresAt: 1600
  };
  const codeHash = sha256Hex(`${AUTH_CODE_PREFIX}example`);
  const item = buildAuthCodeItem(pending, codeHash, 5000);
  assert.equal(item.pk.S, `oauthcode#${codeHash}`);
  assert.equal(item.sk.S, 'code');
  assert.equal(item.client_id.S, pending.clientId);
  assert.equal(item.redirect_uri.S, pending.redirectUri);
  assert.equal(item.scope.S, 'archive:read');
  assert.equal(item.code_challenge.S, PKCE_CHALLENGE);
  assert.equal(item.code_challenge_method.S, 'S256');
  assert.equal(item.subscriber_hash.S, 'subhash');
  assert.deepEqual(JSON.parse(item.entitlements.S), ['reader', 'supporting_member']);
  assert.equal(Number(item.expires_at.N), 5000 + AUTH_CODE_TTL_SECONDS);
  assert.equal(Number(item.ttl.N), 5000 + AUTH_CODE_TTL_SECONDS);
  // The email itself must not be snapshotted onto the code row.
  assert.equal('email' in item, false);
});

test('authorization server metadata follows RFC 8414 with the configurable issuer', () => {
  delete process.env.LIBRARIAN_OAUTH_ISSUER;
  assert.equal(oauthIssuer(), 'https://librarian.thingelstad.com');
  const metadata = authorizationServerMetadata();
  assert.equal(metadata.issuer, 'https://librarian.thingelstad.com');
  assert.equal(metadata.authorization_endpoint, 'https://librarian.thingelstad.com/authorize');
  assert.equal(metadata.token_endpoint, 'https://librarian.thingelstad.com/token');
  assert.equal(metadata.registration_endpoint, 'https://librarian.thingelstad.com/register');
  assert.deepEqual(metadata.response_types_supported, ['code']);
  assert.deepEqual(metadata.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none']);
  assert.deepEqual(metadata.scopes_supported, ['archive:read']);

  process.env.LIBRARIAN_OAUTH_ISSUER = 'https://staging.example.com/';
  assert.equal(authorizationServerMetadata().issuer, 'https://staging.example.com');
  assert.equal(authorizationServerMetadata().token_endpoint, 'https://staging.example.com/token');
  delete process.env.LIBRARIAN_OAUTH_ISSUER;
});

test('protected resource metadata follows RFC 9728', () => {
  delete process.env.LIBRARIAN_OAUTH_ISSUER;
  const metadata = protectedResourceMetadata();
  assert.equal(metadata.resource, 'https://librarian.thingelstad.com');
  assert.deepEqual(metadata.authorization_servers, ['https://librarian.thingelstad.com']);
  assert.deepEqual(metadata.bearer_methods_supported, ['header']);
  assert.deepEqual(metadata.scopes_supported, ['archive:read']);
});

test('metadata endpoints dispatch by path and are cacheable without CORS', () => {
  const asResponse = handleOauthMetadata({ rawPath: '/.well-known/oauth-authorization-server' });
  const prResponse = handleOauthMetadata({ rawPath: '/.well-known/oauth-protected-resource' });
  assert.equal(asResponse.statusCode, 200);
  assert.equal(JSON.parse(asResponse.body).authorization_endpoint, 'https://librarian.thingelstad.com/authorize');
  assert.equal(JSON.parse(prResponse.body).resource, 'https://librarian.thingelstad.com');
  for (const response of [asResponse, prResponse]) {
    assert.equal(response.headers['cache-control'], 'public, max-age=300');
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal('access-control-allow-origin' in response.headers, false);
  }
});

test('parseBody handles application/x-www-form-urlencoded token requests', () => {
  const form = parseBody({
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=authorization_code&code=lac_abc&redirect_uri=https%3A%2F%2Fa.example%2Fcb&state=a%26b'
  });
  assert.equal(form.grant_type, 'authorization_code');
  assert.equal(form.code, 'lac_abc');
  assert.equal(form.redirect_uri, 'https://a.example/cb');
  assert.equal(form.state, 'a&b');
  // Base64-encoded form bodies (API Gateway) decode first.
  const encoded = parseBody({
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: Buffer.from('step=email&email=reader%40example.com').toString('base64'),
    isBase64Encoded: true
  });
  assert.equal(encoded.step, 'email');
  assert.equal(encoded.email, 'reader@example.com');
  // JSON bodies still parse as before.
  const json = parseBody({ headers: {}, body: '{"action":"check"}' });
  assert.equal(json.action, 'check');
});

test('htmlResponse sets a restrictive CSP and no CORS headers', () => {
  const response = htmlResponse(200, '<p>hi</p>');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(response.headers['content-security-policy'], /default-src 'none'/);
  assert.match(response.headers['content-security-policy'], /form-action 'self'/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal('access-control-allow-origin' in response.headers, false);
});
