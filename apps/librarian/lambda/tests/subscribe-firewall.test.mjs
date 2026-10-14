import assert from 'node:assert/strict';
import test from 'node:test';
import { handler as authHandler } from '../dist/auth/handler.mjs';

// Buttondown's firewall answers a create with 2xx and files the address as
// blocked; no confirmation mail goes out. The reader must hear that, not
// "check your inbox" (Jamie, 2026-10-14).

function withButtondown(routes, run) {
  const prior = { fetch: globalThis.fetch, key: process.env.BUTTONDOWN_API_KEY, table: process.env.TABLE_NAME };
  process.env.BUTTONDOWN_API_KEY = 'test-key';
  delete process.env.TABLE_NAME;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = String(init.method || 'GET');
    seen.push(`${method} ${new URL(String(url)).pathname}`);
    const route = routes[method];
    if (!route) throw new Error(`unexpected ${method} ${url}`);
    const [status, body] = route;
    return new Response(body === null ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  };
  return run(seen).finally(() => {
    globalThis.fetch = prior.fetch;
    if (prior.key === undefined) delete process.env.BUTTONDOWN_API_KEY;
    else process.env.BUTTONDOWN_API_KEY = prior.key;
    if (prior.table !== undefined) process.env.TABLE_NAME = prior.table;
  });
}

async function postAuth(payload) {
  const response = await authHandler(
    {
      httpMethod: 'POST',
      path: '/auth',
      headers: { origin: 'https://weekly.thingelstad.com', 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    },
    { awsRequestId: 'firewall-test' }
  );
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

const blockedRecord = { email_address: 'flagged@example.com', type: 'blocked' };

test('a subscribe the firewall catches says it is under review, not "check your inbox"', async () => {
  await withButtondown({ GET: [404, { detail: 'Not found' }], POST: [201, blockedRecord] }, async () => {
    const { status, body } = await postAuth({ action: 'subscribe', email: 'flagged@example.com', source: 'hero' });
    assert.equal(status, 200);
    assert.equal(body.status, 'needs_jamie');
    assert.equal(body.subscriber_status, 'blocked');
    assert.match(body.error, /flagged as suspicious and has been recorded for review/);
    assert.match(body.error, /isn’t subscribed yet/);
    assert.doesNotMatch(JSON.stringify(body), /Check your inbox/);
  });
});

test('subscribing an address already blocked gives the same answer and creates nothing', async () => {
  await withButtondown({ GET: [200, blockedRecord] }, async (seen) => {
    const { status, body } = await postAuth({ action: 'subscribe', email: 'flagged@example.com', source: 'hero' });
    assert.equal(status, 200);
    assert.equal(body.status, 'needs_jamie');
    assert.match(body.error, /recorded for review/);
    assert.deepEqual(seen, ['GET /v1/subscribers/flagged%40example.com']);
  });
});

test('a check on a blocked address says under review instead of offering a resubscribe', async () => {
  await withButtondown({ GET: [200, blockedRecord] }, async () => {
    const { status, body } = await postAuth({ action: 'check', email: 'flagged@example.com', source: 'hero' });
    assert.equal(status, 403);
    assert.equal(body.status, 'inactive');
    assert.equal(body.under_review, true);
    assert.match(body.error, /recorded for review/);
  });
});

test('an ordinary unsubscribed address still reads as inactive, not under review', async () => {
  await withButtondown({ GET: [200, { email_address: 'gone@example.com', type: 'unsubscribed' }] }, async () => {
    const { status, body } = await postAuth({ action: 'check', email: 'gone@example.com', source: 'hero' });
    assert.equal(status, 403);
    assert.equal(body.under_review, undefined);
    assert.equal(body.error, 'That subscription is not active.');
  });
});

test('a create Buttondown accepts still says check your inbox', async () => {
  await withButtondown(
    { GET: [404, { detail: 'Not found' }], POST: [201, { email_address: 'reader@example.com', type: 'unactivated' }] },
    async () => {
      const { body } = await postAuth({ action: 'subscribe', email: 'reader@example.com', source: 'hero' });
      assert.equal(body.status, 'subscribed');
      assert.equal(body.message, 'Check your inbox to confirm your subscription.');
    }
  );
});

test('a weekly form check on a subscriber answers active and mails nothing', async () => {
  for (const [type, expected] of [['regular', 'active'], ['premium', 'premium']]) {
    await withButtondown({ GET: [200, { email_address: 'reader@example.com', type }] }, async (seen) => {
      const { status, body } = await postAuth({ action: 'check', email: 'reader@example.com', source: 'hero' });
      assert.equal(status, 200);
      assert.equal(body.status, expected);
      assert.equal(body.token, undefined);
      // Only the Buttondown lookup: no JMAP send, no sign-in link.
      assert.deepEqual(seen, ['GET /v1/subscribers/reader%40example.com']);
    });
  }
});
