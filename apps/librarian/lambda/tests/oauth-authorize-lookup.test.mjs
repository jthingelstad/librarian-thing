// The MCP connector's /authorize pages answer 502 when Buttondown cannot be
// asked, as /auth does, so the sign-in alarm (web-auth's live 5xx count)
// sees connector failures too (Jamie, 2026-11-03: "Approved: change
// Librarian's MCP /authorize pages to answer 502 when the Buttondown lookup
// fails, so the sign-in alarm covers the connector"). The reader sees the
// same page as before; only the status changed. Correct refusals (bad input,
// not a subscriber, a wrong code) stay 200 pages.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handler as authHandler } from '../dist/auth/handler.mjs';
import { dynamodb } from '../dist/shared/aws-clients.mjs';
import { magicCodeHash } from '../dist/shared/magic-link.mjs';

const CLIENT_ID = 'ClientIdForAuthorizeTestsAb';
const PENDING_ID = 'PendingIdForAuthorizeTests01';
const REDIRECT = 'https://client.example/callback';
const EMAIL = 'reader@example.com';
const CODE = '123456';
const TOKEN_HASH = 'f'.repeat(64);
const LOOKUP_FAILED = 'Could not check that subscription right now. Try again.';
const REDEEM_FAILED = 'Could not confirm your subscription right now. Try again.';
const S = (value) => ({ S: String(value) });
const N = (value) => ({ N: String(value) });

function pendingRow(status) {
  const later = Math.floor(Date.now() / 1000) + 600;
  return {
    pk: S(`oauthpending#${PENDING_ID}`),
    sk: S('pending'),
    client_id: S(CLIENT_ID),
    redirect_uri: S(REDIRECT),
    scope: S('archive:read'),
    state: S('state-1'),
    code_challenge: S('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'),
    entitlements: S('[]'),
    pending_status: S(status),
    ...(status === 'awaiting_code' ? { email: S(EMAIL) } : {}),
    created_at: N(later - 600),
    expires_at: N(later),
    ttl: N(later)
  };
}

const clientRow = {
  pk: S(`oauthclient#${CLIENT_ID}`),
  sk: S('client'),
  client_id: S(CLIENT_ID),
  client_name: S('Test App'),
  redirect_uris: S(JSON.stringify([REDIRECT])),
  created_at: N(1),
  ttl: N(Math.floor(Date.now() / 1000) + 3600)
};

// The table the flow touches: the pending row, the client, the rate limits
// (always under), and the emailed code's rows, which hold CODE.
function fakeTable(pendingStatus) {
  const original = dynamodb.send;
  const later = Math.floor(Date.now() / 1000) + 600;
  dynamodb.send = async (command) => {
    const name = command.constructor.name;
    const pk = command.input.Key?.pk?.S || '';
    if (name === 'GetItemCommand' && pk.startsWith('oauthpending#')) return { Item: pendingRow(pendingStatus) };
    if (name === 'GetItemCommand' && pk.startsWith('oauthclient#')) return { Item: clientRow };
    if (name === 'GetItemCommand' && pk === `magic#${TOKEN_HASH}`) {
      return { Item: { pk: S(pk), sk: S('magic'), email: S(EMAIL), expires_at: N(later) } };
    }
    if (name === 'UpdateItemCommand' && pk.startsWith('rate#')) return { Attributes: { count: N(1) } };
    if (name === 'UpdateItemCommand' && pk.startsWith('magiccode#')) {
      return { Attributes: { attempts: N(1), code_hash: S(magicCodeHash(CODE)), token_hash: S(TOKEN_HASH) } };
    }
    if (name === 'UpdateItemCommand' || name === 'DeleteItemCommand') return {};
    throw new Error(`unexpected ${name} ${pk}`);
  };
  return () => (dynamodb.send = original);
}

// Buttondown answers every lookup with `status`; nothing else is fetched.
async function withFlow(pendingStatus, buttondownStatus, run) {
  const keys = ['TABLE_NAME', 'BUTTONDOWN_API_KEY', 'TURNSTILE_MODE_MCP', 'LIBRARIAN_RUNTIME_SECRET_ID'];
  const prior = { fetch: globalThis.fetch, env: Object.fromEntries(keys.map((key) => [key, process.env[key]])) };
  process.env.TABLE_NAME = 'test-table';
  process.env.BUTTONDOWN_API_KEY = 'test-key';
  process.env.TURNSTILE_MODE_MCP = 'off';
  delete process.env.LIBRARIAN_RUNTIME_SECRET_ID;
  const seen = [];
  globalThis.fetch = async (url) => {
    const { hostname, pathname } = new URL(String(url));
    seen.push(`${hostname}${pathname}`);
    if (hostname !== 'api.buttondown.com') throw new Error(`unexpected fetch ${url}`);
    const body = buttondownStatus === 404 ? { detail: 'Not found' } : { detail: 'Service unavailable' };
    return new Response(JSON.stringify(body), {
      status: buttondownStatus,
      headers: { 'content-type': 'application/json' }
    });
  };
  const restoreTable = fakeTable(pendingStatus);
  try {
    return await run(seen);
  } finally {
    restoreTable();
    globalThis.fetch = prior.fetch;
    for (const [key, value] of Object.entries(prior.env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function postAuthorize(fields) {
  return authHandler(
    {
      httpMethod: 'POST',
      path: '/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pending: PENDING_ID, ...fields }).toString()
    },
    { awsRequestId: 'authorize-lookup-test' }
  );
}

// Two renders of the same page differ only in their message.
function samePageApartFrom(a, aMessage, b, bMessage) {
  assert.ok(a.body.includes(aMessage), `missing: ${aMessage}`);
  assert.ok(b.body.includes(bMessage), `missing: ${bMessage}`);
  assert.equal(a.body.replace(aMessage, '<message>'), b.body.replace(bMessage, '<message>'));
  const withoutRequestId = (headers) =>
    Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'x-request-id'));
  assert.deepEqual(withoutRequestId(a.headers), withoutRequestId(b.headers));
}

test('email step: a failed Buttondown lookup answers 502 with the same email-step page', async () => {
  const failed = await withFlow('awaiting_email', 503, async (seen) => {
    const response = await postAuthorize({ step: 'email', email: EMAIL });
    assert.deepEqual(seen, ['api.buttondown.com/v1/subscribers/reader%40example.com']);
    return response;
  });
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(failed.body, /<h1>Connect Test App<\/h1>/);
  assert.match(failed.body, /<input type="hidden" name="step" value="email">/);
  assert.match(failed.body, new RegExp(`<p class="error">${LOOKUP_FAILED}</p>`));

  // Bad input is still a 200 page, and it is the same page with its own message.
  const invalid = await withFlow('awaiting_email', 503, () => postAuthorize({ step: 'email', email: 'not-an-email' }));
  assert.equal(invalid.statusCode, 200);
  samePageApartFrom(failed, LOOKUP_FAILED, invalid, 'Enter a valid email address.');
});

test('email step: an address that is not a subscriber is still a 200 refusal', async () => {
  const response = await withFlow('awaiting_email', 404, () => postAuthorize({ step: 'email', email: EMAIL }));
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /That email is not an active Weekly Thing subscription\./);
});

test('code step: a failed Buttondown lookup on redeem answers 502 with the same code-step page', async () => {
  const failed = await withFlow('awaiting_code', 503, async (seen) => {
    const response = await postAuthorize({ step: 'code', code: CODE });
    assert.deepEqual(seen, ['api.buttondown.com/v1/subscribers/reader%40example.com']);
    return response;
  });
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(failed.body, /<h1>Enter your code<\/h1>/);
  assert.match(failed.body, /<input type="hidden" name="step" value="code">/);
  assert.match(failed.body, new RegExp(`<p class="error">${REDEEM_FAILED}</p>`));

  // A wrong code is still a 200 refusal, the same page with its own message,
  // and never reaches Buttondown.
  const wrong = await withFlow('awaiting_code', 503, async (seen) => {
    const response = await postAuthorize({ step: 'code', code: '654321' });
    assert.deepEqual(seen, []);
    return response;
  });
  assert.equal(wrong.statusCode, 200);
  samePageApartFrom(failed, REDEEM_FAILED, wrong, 'That code is not right or has expired. Check the newest email.');
});
