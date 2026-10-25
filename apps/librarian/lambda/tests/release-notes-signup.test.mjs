import assert from 'node:assert/strict';
import test from 'node:test';
import { handler as authHandler } from '../dist/auth/handler.mjs';

// Release Notes (notes.yourversionnumber.com, 2026-10-25) comes with the
// Weekly Thing. Its server asks /auth the way Thingy's page does: `check`
// for an address it has proved with an emailed code, and `subscribe` when
// the person asks to be added. No widget, so Turnstile treats it as Thingy.

async function withButtondown(subscriber, run) {
  const prior = {
    fetch: globalThis.fetch,
    key: process.env.BUTTONDOWN_API_KEY,
    table: process.env.TABLE_NAME,
    weekly: process.env.TURNSTILE_MODE_WEEKLY
  };
  process.env.BUTTONDOWN_API_KEY = 'test-key';
  delete process.env.TABLE_NAME;
  // The weekly site enforces; Release Notes must not depend on that.
  process.env.TURNSTILE_MODE_WEEKLY = 'enforce';
  const created = [];
  const asked = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = String(init.method || 'GET');
    asked.push(`${method} ${String(url)}`);
    if (method === 'GET') {
      return subscriber
        ? new Response(JSON.stringify(subscriber), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ detail: 'Not found' }), { status: 404 });
    }
    created.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ email_address: 'reader@example.com', type: 'unactivated' }), {
      status: 201,
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    return await run({ created, asked });
  } finally {
    globalThis.fetch = prior.fetch;
    for (const [name, value] of [
      ['BUTTONDOWN_API_KEY', prior.key],
      ['TABLE_NAME', prior.table],
      ['TURNSTILE_MODE_WEEKLY', prior.weekly]
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// A server-to-server call: no Origin, no Turnstile token.
const ask = (body) =>
  authHandler(
    {
      httpMethod: 'POST',
      path: '/auth',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'reader@example.com', source: 'release-notes', ...body })
    },
    { awsRequestId: 'release-notes-test' }
  );

test('check answers a member’s standing without a token and mails nothing', async () => {
  await withButtondown({ email_address: 'reader@example.com', type: 'premium' }, async ({ asked }) => {
    const response = await ask({ action: 'check' });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).status, 'premium');
    assert.deepEqual(asked, ['GET https://api.buttondown.com/v1/subscribers/reader%40example.com']);
  });
});

test('check says not_found, so Release Notes can offer to add the address', async () => {
  await withButtondown(null, async () => {
    const response = await ask({ action: 'check' });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).status, 'not_found');
  });
});

test('the same tokenless call from a weekly form is refused', async () => {
  await withButtondown(null, async ({ asked }) => {
    const response = await ask({ action: 'check', source: 'hero' });
    assert.equal(response.statusCode, 403);
    assert.equal(JSON.parse(response.body).status, 'turnstile_failed');
    assert.equal(asked.length, 0);
  });
});

test('subscribe adds the address tagged source:release-notes', async () => {
  await withButtondown(null, async ({ created }) => {
    const response = await ask({ action: 'subscribe', attribution: { ref: 'release-notes' } });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).status, 'subscribed');
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].tags, ['source:release-notes']);
    assert.equal(created[0].metadata.placement, 'release-notes');
  });
});
