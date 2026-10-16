import assert from 'node:assert/strict';
import test from 'node:test';
import { clientSourceIp, eventSummary, forwardingShape } from '../dist/shared/http.mjs';

test('health probes expose only a bounded user agent for caller migration', () => {
  const headers = { 'User-Agent': 'Uptime monitor\r\n' + 'x'.repeat(250), Authorization: 'private' };
  const summary = eventSummary({ headers, rawPath: '/health', requestContext: { http: { method: 'GET' } } });
  assert.equal(summary.health_user_agent.length, 200);
  assert.ok(summary.health_user_agent.startsWith('Uptime monitor  '));
  assert.ok(!JSON.stringify(summary).includes('private'));
  for (const [method, path] of [
    ['POST', '/health'],
    ['POST', '/auth'],
    ['GET', '/share/token']
  ]) {
    assert.ok(
      !Object.hasOwn(eventSummary({ headers, rawPath: path, requestContext: { http: { method } } }), 'health_user_agent')
    );
  }
});

// R2-04: behind CloudFront the connection sourceIp is the POP egress
// address; the viewer is the LAST X-Forwarded-For entry (CloudFront
// appends it; earlier entries are client-supplied and untrusted).
test('clientSourceIp prefers the CloudFront-appended viewer address', () => {
  const event = {
    headers: { 'X-Forwarded-For': '203.0.113.7' },
    requestContext: { http: { sourceIp: '130.176.0.1' } }
  };
  assert.equal(clientSourceIp(event), '203.0.113.7');
});

test('clientSourceIp ignores client-forged earlier XFF entries', () => {
  const event = {
    headers: { 'x-forwarded-for': '10.0.0.1, 198.51.100.9' },
    requestContext: { http: { sourceIp: '130.176.0.2' } }
  };
  assert.equal(clientSourceIp(event), '198.51.100.9');
});

test('clientSourceIp falls back to the connection address', () => {
  assert.equal(clientSourceIp({ requestContext: { http: { sourceIp: '192.0.2.4' } } }), '192.0.2.4');
  assert.equal(
    clientSourceIp({
      headers: { 'x-forwarded-for': 'not-an-ip' },
      requestContext: { http: { sourceIp: '192.0.2.5' } }
    }),
    '192.0.2.5'
  );
  assert.equal(clientSourceIp(null), '');
});

// Native requests carry no connection address, so the old peer-vs-viewer
// comparison made via_edge false on every native request (2026-10-16 audit).
test('forwardingShape marks native requests through CloudFront as via the edge', () => {
  const edge = forwardingShape({
    native: true,
    headers: { 'cloudfront-viewer-address': '203.0.113.7:51234', 'x-forwarded-for': '10.0.0.1, 203.0.113.7' }
  });
  assert.equal(edge.via_edge, true);
  assert.equal(edge.xff_depth, 2);
  assert.match(edge.ip_hash, /^[0-9a-f]{16}$/);
  const v6 = forwardingShape({ native: true, headers: { 'CloudFront-Viewer-Address': '[2001:db8::1]:443' } });
  assert.equal(v6.via_edge, true);
  // A native request without the trusted viewer header (or with a forged
  // X-Forwarded-For only) is not via the edge and has no viewer identity.
  for (const headers of [{}, { 'x-forwarded-for': '198.51.100.9' }, { 'cloudfront-viewer-address': 'garbage' }]) {
    const direct = forwardingShape({ native: true, headers });
    assert.equal(direct.via_edge, false);
    assert.equal(direct.ip_hash, '');
  }
  // Event-shaped requests keep the connection-peer comparison.
  assert.equal(
    forwardingShape({ headers: { 'x-forwarded-for': '203.0.113.7' }, requestContext: { http: { sourceIp: '130.176.0.1' } } })
      .via_edge,
    true
  );
  assert.equal(forwardingShape({ requestContext: { http: { sourceIp: '192.0.2.4' } } }).via_edge, false);
});
