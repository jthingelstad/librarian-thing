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
