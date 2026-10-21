import assert from 'node:assert/strict';
import test from 'node:test';
import { handler as authHandler } from '../dist/auth/handler.mjs';

// The blog's Weekly Thing card (www.thingelstad.com, 2026-10-21) posts the
// same /auth calls as the weekly forms, from another origin, with its own
// placements and the ref "blog".

const BLOG = 'https://www.thingelstad.com';

async function withButtondown(run) {
  const prior = {
    fetch: globalThis.fetch,
    key: process.env.BUTTONDOWN_API_KEY,
    table: process.env.TABLE_NAME,
    turnstile: process.env.TURNSTILE_MODE_WEEKLY,
    origins: process.env.ALLOWED_ORIGIN
  };
  process.env.BUTTONDOWN_API_KEY = 'test-key';
  delete process.env.TABLE_NAME;
  process.env.TURNSTILE_MODE_WEEKLY = 'observe';
  process.env.ALLOWED_ORIGIN = `https://weekly.thingelstad.com,https://thingy.thingelstad.com,${BLOG}`;
  const created = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = String(init.method || 'GET');
    if (method === 'GET') return new Response(JSON.stringify({ detail: 'Not found' }), { status: 404 });
    created.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ email_address: 'reader@example.com', type: 'unactivated' }), {
      status: 201,
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    return await run(created);
  } finally {
    globalThis.fetch = prior.fetch;
    for (const [name, value] of [
      ['BUTTONDOWN_API_KEY', prior.key],
      ['TABLE_NAME', prior.table],
      ['TURNSTILE_MODE_WEEKLY', prior.turnstile],
      ['ALLOWED_ORIGIN', prior.origins]
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('a blog subscribe is answered for the blog origin and tagged source:blog with its placement', async () => {
  await withButtondown(async (created) => {
    const response = await authHandler(
      {
        httpMethod: 'POST',
        path: '/auth',
        headers: { origin: BLOG, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'subscribe',
          email: 'reader@example.com',
          source: 'blog-post',
          attribution: { ref: 'blog', landing_url: `${BLOG}/2024/10/21/money-and-elections.html` }
        })
      },
      { awsRequestId: 'blog-signup-test' }
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], BLOG);
    assert.equal(JSON.parse(response.body).status, 'subscribed');
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].tags, ['source:blog']);
    assert.equal(created[0].metadata.placement, 'blog-post');
  });
});
