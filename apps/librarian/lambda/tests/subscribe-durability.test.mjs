/**
 * A reader who asks to subscribe is never lost. The revive retry, the
 * suppressed-code recognition, and the digest's words are pinned here; the
 * ledger's DynamoDB calls are exercised against a fake client.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSubscriber,
  isSuppressedCode,
  isSuppressedError,
  listBlockedSince
} from '../dist/shared/buttondown.mjs';
import { composeDigest } from '../dist/shared/subscribe-digest.mjs';

function withFetch(impl, fn) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BUTTONDOWN_API_KEY;
  process.env.BUTTONDOWN_API_KEY = 'test-key';
  globalThis.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.BUTTONDOWN_API_KEY;
      else process.env.BUTTONDOWN_API_KEY = originalKey;
    });
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('both of Buttondown’s names for a suppressed address are recognised', () => {
  assert.equal(isSuppressedCode('subscriber_suppressed'), true);
  assert.equal(isSuppressedCode('subscriber_blocked'), true);
  assert.equal(isSuppressedCode('email_invalid'), false);
  assert.equal(isSuppressedError(new Error('network')), false);
});

test('the revive retry sends the collision header, and only then', async () => {
  const seen = [];
  await withFetch(async (url, init) => {
    seen.push(init.headers['X-Buttondown-Collision-Behavior'] || null);
    return seen.length === 1
      ? json(400, { code: 'subscriber_suppressed', detail: 'previously unsubscribed' })
      : json(201, { email_address: 'reader@example.com', type: 'unactivated' });
  }, async () => {
    await assert.rejects(createSubscriber('reader@example.com', { headers: {} }, 'hero', null), (error) => {
      assert.equal(isSuppressedError(error), true);
      return true;
    });
    const revived = await createSubscriber('reader@example.com', { headers: {} }, 'hero', null, { revive: true });
    assert.equal(revived.type, 'unactivated');
  });
  assert.deepEqual(seen, [null, 'add']);
});

test('the blocked list stops at the first record older than the window', async () => {
  await withFetch(async () =>
    json(200, {
      results: [
        { email_address: 'new@example.com', creation_date: '2026-09-21T01:00:00Z' },
        { email_address: 'old@example.com', creation_date: '2026-09-18T01:00:00Z' }
      ],
      next: 'https://api.buttondown.com/v1/subscribers?page=2'
    }), async () => {
    const blocked = await listBlockedSince('2026-09-20T00:00:00Z');
    assert.deepEqual(blocked.map((b) => b.email), ['new@example.com']);
  });
});

const row = (over) => ({
  sk: '2026-09-21T02:24:06Z#abcd', at: '2026-09-21T02:24:06Z', email: 'patrick@example.com',
  source: 'hero', outcome: 'suppressed', buttondown_code: 'subscriber_blocked', ...over
});

test('a clean day is no email at all', () => {
  assert.equal(composeDigest([], []), null);
  assert.equal(composeDigest([row({ outcome: 'subscribed' }), row({ outcome: 'already_subscribed' })], []), null);
});

test('the digest names the address, the form, the reason, and where to add them', () => {
  const mail = composeDigest(
    [
      row(),
      row({ email: 'ok@example.com', outcome: 'subscribed' }),
      row({ email: 'flaky@example.com', outcome: 'create_failed', buttondown_code: undefined, campaign_ref: 'DenseDiscovery-400' })
    ],
    [{ email: 'bot@example.com', creation_date: '2026-09-21T05:00:00Z' }],
    new Date('2026-09-21T12:00:00Z')
  );
  assert.ok(mail);
  assert.equal(mail.subject, 'Weekly Thing subscribe: 3 to look at — September 21');
  assert.match(mail.text, /3 subscribe attempts in the last day did not end with a reader on the list \(1 did\)/);
  assert.match(mail.text, /NEED YOU\n- patrick@example.com — Sun 9:24 PM, hero form\n  on the suppression list .*\(subscriber_blocked\)/);
  assert.match(mail.text, /CAUGHT BY THE FIREWALL[\s\S]*bot@example.com/);
  assert.match(mail.text, /FAILED ON OUR SIDE[\s\S]*flaky@example.com — .*, hero form, ref DenseDiscovery-400/);
  assert.match(mail.text, /https:\/\/buttondown.com\/subscribers/);
  assert.match(mail.html, /<strong>patrick@example.com/);
  assert.doesNotMatch(mail.text, /ok@example.com/);
});
