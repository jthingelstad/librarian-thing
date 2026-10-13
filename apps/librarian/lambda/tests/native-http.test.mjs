import assert from 'node:assert/strict';
import test from 'node:test';
import { makeServer } from '../dist/web/server.mjs';
import { clientSourceIp } from '../dist/shared/http.mjs';
test('native request-local records preserve cookies, raw OAuth query and bearer identity', async () => {
  const seen = [];
  const app = makeServer(
    {
      auth: async (req) => {
        seen.push(req);
        await new Promise((resolve) => setTimeout(resolve, req.headers.authorization === 'Bearer one' ? 15 : 1));
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          cookies: ['__Host-thingy_session=fixture; Secure; HttpOnly; Path=/'],
          body: JSON.stringify({ bearer: req.headers.authorization })
        };
      }
    },
    35
  );
  const responses = await Promise.all(
    ['one', 'two'].map((id) =>
      app.request('/authorize?scope=archive%3Aread+offline_access&x=%2B&x=two', {
        headers: { authorization: 'Bearer ' + id, cookie: '__Host-thingy_session=fixture' }
      })
    )
  );
  assert.deepEqual(await Promise.all(responses.map((res) => res.json())), [
    { bearer: 'Bearer one' },
    { bearer: 'Bearer two' }
  ]);
  assert.ok(seen.every((req) => req.rawQueryString.includes('x=%2B&x=two')));
  assert.equal(responses[0].headers.get('cache-control'), 'no-store');
  assert.match(responses[0].headers.get('set-cookie'), /Secure; HttpOnly/);
});
test('native archive starts a real incremental SSE response', async () => {
  let finish;
  const app = makeServer(
    {
      archive: async (_req, stream) => {
        stream.start(200, { 'content-type': 'text/event-stream' });
        stream.write('event: meta\ndata: {}\n\n');
        await new Promise((resolve) => {
          finish = resolve;
        });
        stream.end('event: done\ndata: {}\n\n');
      }
    },
    300
  );
  const res = await app.request('/chat', { method: 'POST', body: '{}' });
  const reader = res.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: meta/);
  finish();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: done/);
  await reader.cancel();
});
test('native client identity uses trusted viewer address, not the final proxy hop', () => {
  assert.equal(
    clientSourceIp({
      native: true,
      headers: { 'cloudfront-viewer-address': '203.0.113.1:443', 'x-forwarded-for': '198.51.100.9, 192.0.2.1' }
    }),
    '203.0.113.1'
  );
  assert.equal(
    clientSourceIp({ native: true, headers: { 'cloudfront-viewer-address': '[2001:db8::1]:443' } }),
    '2001:db8::1'
  );
  assert.equal(clientSourceIp({ native: true, headers: { 'x-forwarded-for': '198.51.100.9' } }), '');
});
test('native errors and refusals cannot be cached', async () => {
  const app = makeServer(
    {
      auth: async () => {
        throw new Error('private detail');
      }
    },
    35
  );
  const res = await app.request('/auth', { method: 'POST', body: '{}' });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await res.text(), /private detail/);
});

test('SSE keeps approved cross-origin bearer clients working', async () => {
  const prior = process.env.ALLOWED_ORIGIN;
  process.env.ALLOWED_ORIGIN = 'http://localhost:8080';
  try {
    const app = makeServer(
      {
        archive: async (_request, stream) => {
          stream.start(200, { 'content-type': 'text/event-stream' });
          stream.end('event: done\ndata: {}\n\n');
        }
      },
      300
    );
    const response = await app.request('/chat', {
      method: 'POST',
      headers: { origin: 'http://localhost:8080' },
      body: '{}'
    });
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:8080');
    await response.text();
  } finally {
    if (prior === undefined) delete process.env.ALLOWED_ORIGIN;
    else process.env.ALLOWED_ORIGIN = prior;
  }
});
test('reader disconnect cancels request-local work', async () => {
  let signal;
  const app = makeServer(
    {
      archive: async (_request, stream) => {
        signal = stream.signal;
        stream.start(200, { 'content-type': 'text/event-stream' });
        stream.write('data: {}\n\n');
      }
    },
    300
  );
  const response = await app.request('/chat', { method: 'POST', body: '{}' });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal.aborted, true);
});
