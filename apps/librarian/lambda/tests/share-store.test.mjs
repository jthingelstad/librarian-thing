import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SHARE_TTL_SECONDS,
  generateShareToken,
  shareRowKey,
  shareTokenHash,
  shareUrl,
  validShareToken
} from '../dist/shared/share-store.mjs';

test('share tokens round-trip validation and are unguessable-shaped', () => {
  const token = generateShareToken();
  assert.match(token, /^shr_[A-Za-z0-9_-]{43}$/);
  assert.equal(validShareToken(token), token);
  assert.equal(validShareToken(` ${token} `), token);
  assert.notEqual(generateShareToken(), token);
});

test('malformed tokens are rejected before any lookup', () => {
  assert.equal(validShareToken(''), '');
  assert.equal(validShareToken(null), '');
  assert.equal(validShareToken('shr_short'), '');
  assert.equal(validShareToken('acc_' + 'a'.repeat(43)), '');
  assert.equal(validShareToken('shr_' + 'a'.repeat(44)), '');
  assert.equal(validShareToken('shr_' + 'a'.repeat(42) + '/'), '');
});

test('the lookup row is keyed by sha256, never the plaintext token', () => {
  const token = generateShareToken();
  const key = shareRowKey(token);
  assert.equal(key.sk.S, 'share');
  assert.match(key.pk.S, /^share#[0-9a-f]{64}$/);
  assert.equal(key.pk.S, `share#${shareTokenHash(token)}`);
  assert.equal(key.pk.S.includes(token.slice(4)), false);
});

test('share URLs land on the Thingy web /c/ route', () => {
  const token = generateShareToken();
  assert.equal(shareUrl(token), `https://thingy.thingelstad.com/c/${token}`);
});

test('shares pin content for a year', () => {
  assert.equal(SHARE_TTL_SECONDS, 365 * 24 * 60 * 60);
});

test('sharedSnapshotHistory bounds: 16-message window, 700-char clip, 9000 budget', async () => {
  const { sharedSnapshotHistory } = await import('../dist/shared/share-store.mjs');
  const long = 'x'.repeat(2000);
  const many = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `turn ${i}`
  }));
  const windowed = sharedSnapshotHistory(many);
  assert.equal(windowed.length, 16);
  assert.equal(windowed[0].content, 'turn 4');
  assert.equal(windowed.at(-1).content, 'turn 19');

  const clipped = sharedSnapshotHistory([{ role: 'user', content: `  a\n\n b  ${long}` }]);
  assert.equal(clipped.length, 1);
  assert.equal(clipped[0].content.length, 700);
  assert.ok(clipped[0].content.startsWith('a b x'));

  const budget = sharedSnapshotHistory(Array.from({ length: 16 }, () => ({ role: 'user', content: long })));
  const total = budget.reduce((sum, item) => sum + item.content.length, 0);
  assert.ok(total <= 9000);
  assert.ok(budget.length < 16, 'oldest messages drop when the budget is exhausted');

  assert.deepEqual(sharedSnapshotHistory([{ role: 'user', content: '   ' }]), []);
});
