import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSubscriberBody,
  buttondownErrorFields,
  cleanTagSegment,
  createSubscriber,
  hasThingyTag,
  sanitizeAttribution
} from '../dist/shared/buttondown.mjs';

test('cleanTagSegment preserves casing and strips unsafe chars', () => {
  assert.equal(cleanTagSegment('DenseDiscovery-388'), 'DenseDiscovery-388');
  assert.equal(cleanTagSegment('  Dense Discovery 388  '), 'Dense-Discovery-388');
  assert.equal(cleanTagSegment('source:already:nested'), 'source-already-nested');
  assert.equal(cleanTagSegment(''), '');
  assert.equal(cleanTagSegment(null), '');
  assert.equal(cleanTagSegment('a'.repeat(200)).length, 80);
});

test('sanitizeAttribution returns null for non-objects and empty input', () => {
  assert.equal(sanitizeAttribution(null), null);
  assert.equal(sanitizeAttribution('hello'), null);
  assert.equal(sanitizeAttribution(['ref']), null);
  assert.equal(sanitizeAttribution({}), null);
  assert.equal(sanitizeAttribution({ ref: '   ' }), null);
});

test('sanitizeAttribution whitelists known keys and trims values', () => {
  const result = sanitizeAttribution({
    ref: '  DenseDiscovery-388  ',
    landing_url: '/?ref=DenseDiscovery-388',
    referrer_url: 'https://www.densediscovery.com/issues/388',
    captured_at: '2026-05-08T12:00:00Z',
    nefarious: 'drop me'
  });
  assert.deepEqual(result, {
    ref: 'DenseDiscovery-388',
    landing_url: '/?ref=DenseDiscovery-388',
    referrer_url: 'https://www.densediscovery.com/issues/388',
    captured_at: '2026-05-08T12:00:00Z'
  });
  assert.equal('nefarious' in result, false);
});

test('sanitizeAttribution caps oversized strings at 500 chars', () => {
  const result = sanitizeAttribution({ ref: 'x'.repeat(2000) });
  assert.equal(result.ref.length, 500);
});

test('sanitizeAttribution rejects non-http referrer URLs', () => {
  assert.equal(sanitizeAttribution({ referrer_url: 'javascript:alert(1)' }), null);
  assert.equal(sanitizeAttribution({ referrer_url: 'ftp://example.com' }), null);
  assert.equal(sanitizeAttribution({ referrer_url: 'not a url' }), null);
  const ok = sanitizeAttribution({ referrer_url: 'http://example.com/' });
  assert.equal(ok.referrer_url, 'http://example.com/');
});

test('buildSubscriberBody emits no tags for plain web subscribers (wt-site deprecated)', () => {
  const body = buildSubscriberBody('reader@example.com', 'hero', null, '203.0.113.1');
  assert.equal(body.email_address, 'reader@example.com');
  assert.equal(body.ip_address, '203.0.113.1');
  assert.equal('tags' in body, false);
  assert.equal('metadata' in body, false);
  assert.equal('referrer_url' in body, false);
});

test('buildSubscriberBody emits the wt-thingy user tag for chat-surface signups (no source:thingy)', () => {
  const body = buildSubscriberBody('reader@example.com', 'thingy', null, null);
  assert.deepEqual(body.tags, ['wt-thingy']);
});

test('buildSubscriberBody adds source:<ref> tag and metadata when attribution carries a ref', () => {
  const body = buildSubscriberBody(
    'reader@example.com',
    'hero',
    {
      ref: 'DenseDiscovery-388',
      landing_url: '/?ref=DenseDiscovery-388',
      referrer_url: 'https://www.densediscovery.com/issues/388',
      captured_at: '2026-05-08T12:00:00Z'
    },
    null
  );
  assert.deepEqual(body.tags, ['source:DenseDiscovery-388']);
  assert.equal(body.referrer_url, 'https://www.densediscovery.com/issues/388');
  assert.deepEqual(body.metadata, {
    ref: 'DenseDiscovery-388',
    landing_url: '/?ref=DenseDiscovery-388',
    first_referrer: 'https://www.densediscovery.com/issues/388',
    first_seen_at: '2026-05-08T12:00:00Z',
    placement: 'hero'
  });
});

test('buildSubscriberBody combines wt-thingy and source:<ref> for chat signups with attribution', () => {
  const body = buildSubscriberBody(
    'reader@example.com',
    'thingy',
    {
      ref: 'DenseDiscovery-388'
    },
    null
  );
  assert.deepEqual(body.tags, ['wt-thingy', 'source:DenseDiscovery-388']);
});

test('buildSubscriberBody omits referrer_url when attribution has only a ref', () => {
  const body = buildSubscriberBody('reader@example.com', 'hero', { ref: 'foo' }, null);
  assert.equal('referrer_url' in body, false);
  assert.deepEqual(body.metadata, { ref: 'foo', placement: 'hero' });
});

test('buildSubscriberBody skips source: tag when ref slug is empty after cleaning, but still tags Thingy users', () => {
  const formBody = buildSubscriberBody('reader@example.com', 'hero', { ref: '   ' }, null);
  assert.equal('tags' in formBody, false);

  const thingyBody = buildSubscriberBody('reader@example.com', 'thingy', { ref: '   ' }, null);
  assert.deepEqual(thingyBody.tags, ['wt-thingy']);
});

test('hasThingyTag detects string and object tag shapes', () => {
  assert.equal(hasThingyTag(null), false);
  assert.equal(hasThingyTag({}), false);
  assert.equal(hasThingyTag({ tags: [] }), false);
  assert.equal(hasThingyTag({ tags: ['source:Foo'] }), false);
  assert.equal(hasThingyTag({ tags: ['wt-thingy'] }), true);
  assert.equal(hasThingyTag({ tags: ['source:Foo', 'wt-thingy'] }), true);
  assert.equal(hasThingyTag({ tags: [{ name: 'wt-thingy' }] }), true);
  assert.equal(hasThingyTag({ tags: [{ name: 'source:Foo' }] }), false);
});

test('Buttondown failures retain only safe diagnostic fields', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BUTTONDOWN_API_KEY;
  process.env.BUTTONDOWN_API_KEY = 'test-key';
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: 'email_invalid', detail: 'reader@example.com is not valid' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });

  try {
    await assert.rejects(createSubscriber('reader@example.com', { headers: {} }, 'hero', null), (error) => {
      assert.deepEqual(buttondownErrorFields(error), {
        buttondown_status_code: 400,
        buttondown_code: 'email_invalid'
      });
      assert.doesNotMatch(JSON.stringify(buttondownErrorFields(error)), /reader@example\.com/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.BUTTONDOWN_API_KEY;
    else process.env.BUTTONDOWN_API_KEY = originalKey;
  }
});
