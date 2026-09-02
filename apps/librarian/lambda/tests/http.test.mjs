import assert from 'node:assert/strict';
import test from 'node:test';
import { clientSourceIp } from '../dist/shared/http.mjs';

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
