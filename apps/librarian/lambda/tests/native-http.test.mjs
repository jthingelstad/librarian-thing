import assert from 'node:assert/strict';
import test from 'node:test';
import { makeServer } from '../dist/web/server.mjs';
import { clientSourceIp } from '../dist/shared/http.mjs';
import { sessionCookie } from '../dist/shared/web-session.mjs';
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
        headers: { authorization: 'Bearer ' + id, cookie: 'other=1; __Host-thingy_session=fixture' }
      })
    )
  );
  assert.deepEqual(await Promise.all(responses.map((res) => res.json())), [
    { bearer: 'Bearer one' },
    { bearer: 'Bearer two' }
  ]);
  assert.ok(seen.every((req) => req.rawQueryString.includes('x=%2B&x=two')));
  assert.ok(seen.every((req) => req.cookies.includes('__Host-thingy_session=fixture')));
  assert.equal(sessionCookie(seen[0]), 'fixture');
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

test('actual native route layers retain contract refusals and bearerless MCP challenge without AWS calls', async () => {
  const { handleAuthRequest } = await import('../dist/auth/handler.mjs');
  const { handleStreamRequest } = await import('../dist/chat/runtime.mjs');
  const { dynamodb, s3 } = await import('../dist/shared/aws-clients.mjs');
  const previousSecretId = process.env.LIBRARIAN_RUNTIME_SECRET_ID;
  delete process.env.LIBRARIAN_RUNTIME_SECRET_ID;
  const priorDynamo = dynamodb.send,
    priorS3 = s3.send;
  dynamodb.send = s3.send = async () => {
    throw new Error('Unexpected AWS access');
  };
  try {
    const auth = makeServer({ auth: handleAuthRequest }, 35);
    const archive = makeServer({ archive: handleStreamRequest }, 300);
    const health = await archive.request('/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    const metadata = await auth.request('/.well-known/oauth-authorization-server');
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).issuer, 'https://librarian.thingelstad.com');
    for (const app of [auth, archive]) {
      const refused = await app.request('/health', { headers: { 'x-librarian-contract-version': '999.0.0' } });
      assert.equal(refused.status, 409);
      assert.equal(refused.headers.get('cache-control'), 'no-store');
      await refused.text();
    }
    const mcp = await archive.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(mcp.status, 401);
    assert.match(mcp.headers.get('www-authenticate'), /Bearer/);
    await mcp.text();
  } finally {
    dynamodb.send = priorDynamo;
    s3.send = priorS3;
    if (previousSecretId === undefined) delete process.env.LIBRARIAN_RUNTIME_SECRET_ID;
    else process.env.LIBRARIAN_RUNTIME_SECRET_ID = previousSecretId;
  }
});

// 2026-10-16 audit: the server forced no-store over every route's own
// cache-control. A route's explicit value now stands, but only on a response
// nothing per-reader went into.
test('native responses keep a route cache-control only when nothing per-reader is involved', async () => {
  const app = makeServer(
    {
      auth: async (req) => ({
        statusCode: 200,
        headers: { 'content-type': 'text/plain', 'cache-control': 'public, max-age=3600' },
        cookies: req.path === '/sets-cookie' ? ['thingy_email=x; Secure; HttpOnly; Path=/authorize'] : [],
        body: 'ok'
      })
    },
    35
  );
  const plain = await app.request('/');
  assert.equal(plain.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal((await app.request('/', { method: 'HEAD' })).headers.get('cache-control'), 'public, max-age=3600');
  for (const [path, init] of [
    ['/', { headers: { authorization: 'Bearer reader' } }],
    ['/', { headers: { cookie: '__Host-thingy_session=fixture' } }],
    ['/', { headers: { origin: 'https://thingy.thingelstad.com' } }],
    ['/?client_id=abc', {}],
    ['/', { method: 'POST', body: '{}' }],
    ['/sets-cookie', {}]
  ]) {
    const res = await app.request(path, init);
    assert.equal(res.headers.get('cache-control'), 'no-store', `${init.method || 'GET'} ${path} ${JSON.stringify(init)}`);
    await res.text();
  }
  const silent = makeServer({ auth: async () => ({ statusCode: 200, headers: {}, body: '{}' }) }, 35);
  assert.equal((await silent.request('/')).headers.get('cache-control'), 'no-store');
  const streaming = makeServer(
    {
      archive: async (_req, stream) => {
        stream.start(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' });
        stream.end('event: done\ndata: {}\n\n');
      }
    },
    300
  );
  const sse = await streaming.request('/chat', { method: 'POST', body: '{}' });
  assert.equal(sse.headers.get('cache-control'), 'no-store');
  await sse.text();
});

test('actual auth routes: RFC 9728 path-suffixed metadata and cacheable public pages', async () => {
  const { handleAuthRequest } = await import('../dist/auth/handler.mjs');
  const { dynamodb, s3 } = await import('../dist/shared/aws-clients.mjs');
  const previousSecretId = process.env.LIBRARIAN_RUNTIME_SECRET_ID;
  delete process.env.LIBRARIAN_RUNTIME_SECRET_ID;
  const priorDynamo = dynamodb.send,
    priorS3 = s3.send;
  dynamodb.send = s3.send = async () => {
    throw new Error('Unexpected AWS access');
  };
  try {
    const auth = makeServer({ auth: handleAuthRequest }, 35);
    const issuer = 'https://librarian.thingelstad.com';
    for (const [path, resource] of [
      ['/.well-known/oauth-protected-resource', issuer],
      ['/.well-known/oauth-protected-resource/mcp', `${issuer}/mcp`],
      ['/mcp/.well-known/oauth-protected-resource', issuer]
    ]) {
      const res = await auth.request(path);
      assert.equal(res.status, 200, path);
      const body = await res.json();
      assert.equal(body.resource, resource, path);
      assert.deepEqual(body.authorization_servers, [issuer]);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=300', path);
    }
    for (const path of ['/.well-known/oauth-protected-resource/chat', '/.well-known/oauth-protected-resource/mcp/x']) {
      const res = await auth.request(path);
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      await res.text();
    }
    const root = await auth.request('/');
    assert.equal(root.headers.get('cache-control'), 'public, max-age=3600');
    await root.text();
    const favicon = await auth.request('/favicon.ico');
    assert.equal(favicon.status, 302);
    assert.equal(favicon.headers.get('cache-control'), 'public, max-age=86400');
    // The same public page asked for with a bearer or a session cookie is not cacheable.
    for (const headers of [{ authorization: 'Bearer reader' }, { cookie: '__Host-thingy_session=fixture' }]) {
      const res = await auth.request('/', { headers });
      assert.equal(res.headers.get('cache-control'), 'no-store');
      await res.text();
    }
    const health = await auth.request('/health');
    assert.equal(health.headers.get('cache-control'), 'no-store');
    await health.text();
  } finally {
    dynamodb.send = priorDynamo;
    s3.send = priorS3;
    if (previousSecretId === undefined) delete process.env.LIBRARIAN_RUNTIME_SECRET_ID;
    else process.env.LIBRARIAN_RUNTIME_SECRET_ID = previousSecretId;
  }
});

test('the native request record makes via_edge true for CloudFront traffic', async () => {
  const { forwardingShape } = await import('../dist/shared/http.mjs');
  let shape;
  const app = makeServer(
    {
      auth: async (req) => {
        shape = forwardingShape(req);
        return { statusCode: 204, headers: {}, body: '' };
      }
    },
    35
  );
  await app.request('/health', { headers: { 'cloudfront-viewer-address': '203.0.113.7:51234' } });
  assert.equal(shape.via_edge, true);
  await app.request('/health');
  assert.equal(shape.via_edge, false);
});
