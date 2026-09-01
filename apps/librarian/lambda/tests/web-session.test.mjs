import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'web-session-test-secret';
process.env.THINGY_WEB_ORIGIN_TOKEN = 'marker-token-for-tests-0123456789ab';

const { SESSION_COOKIE, resolveSessionToken, sessionCookie, withClearedSessionCookie, withSessionCookie } =
  await import('../dist/shared/web-session.mjs');

const MARKER = process.env.THINGY_WEB_ORIGIN_TOKEN;

function event({ bearer, cookie, marker, contractHeader = true } = {}) {
  const headers = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (marker) headers['x-thingy-origin'] = marker;
  if (contractHeader) headers['x-librarian-contract-version'] = '3.1.0';
  return {
    headers,
    cookies: cookie ? [`${SESSION_COOKIE}=${cookie}`, 'other=1'] : ['other=1']
  };
}

test('bearer always wins over a cookie', () => {
  const resolved = resolveSessionToken(event({ bearer: 'b-token', cookie: 'c-token', marker: MARKER }), {});
  assert.deepEqual(resolved, { token: 'b-token', source: 'bearer' });
});

test('cookie is honored only with marker and contract header', () => {
  assert.deepEqual(resolveSessionToken(event({ cookie: 'c-token', marker: MARKER }), {}), {
    token: 'c-token',
    source: 'cookie'
  });
  assert.equal(resolveSessionToken(event({ cookie: 'c-token' }), {}).source, 'none');
  assert.equal(resolveSessionToken(event({ cookie: 'c-token', marker: 'wrong' }), {}).source, 'none');
  assert.equal(
    resolveSessionToken(event({ cookie: 'c-token', marker: MARKER, contractHeader: false }), {}).source,
    'none'
  );
});

test('unset marker env disables cookie auth entirely', () => {
  const saved = process.env.THINGY_WEB_ORIGIN_TOKEN;
  delete process.env.THINGY_WEB_ORIGIN_TOKEN;
  try {
    assert.equal(resolveSessionToken(event({ cookie: 'c-token', marker: saved }), {}).source, 'none');
  } finally {
    process.env.THINGY_WEB_ORIGIN_TOKEN = saved;
  }
});

test('legacy body token still resolves as bearer', () => {
  const resolved = resolveSessionToken(event({}), { token: 'body-token' });
  assert.deepEqual(resolved, { token: 'body-token', source: 'bearer' });
});

test('sessionCookie parses only its own entry', () => {
  assert.equal(sessionCookie({ cookies: ['a=1', `${SESSION_COOKIE}=tok`, 'b=2'] }), 'tok');
  assert.equal(sessionCookie({ cookies: ['a=1'] }), '');
  assert.equal(sessionCookie({}), '');
});

test('withSessionCookie sets a Host-prefixed HttpOnly cookie and replaces prior entries', () => {
  const expires = Math.floor(Date.now() / 1000) + 100;
  const response = withSessionCookie(
    { statusCode: 200, headers: {}, body: '{}', cookies: [`${SESSION_COOKIE}=old; Path=/`] },
    'new-token',
    expires
  );
  assert.equal(response.cookies.length, 1);
  const cookie = response.cookies[0];
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=new-token; `));
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=(9[0-9]|100)\b/);
  assert.equal(SESSION_COOKIE, '__Host-thingy_session');
});

test('withClearedSessionCookie expires the cookie', () => {
  const response = withClearedSessionCookie({ statusCode: 200, headers: {}, body: '{}' });
  assert.match(response.cookies[0], new RegExp(`^${SESSION_COOKIE.replace(/[$-]/g, '\\$&')}=; .*Max-Age=0`));
});
