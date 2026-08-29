import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conversationTtlSeconds,
  mcpAuditTtlSeconds,
} from '../dist/shared/retention.mjs';

test('Thingy retention windows default to the agreed shorter durations', () => {
  const now = '2026-06-08T12:00:00.000Z';
  const epoch = Math.floor(Date.parse(now) / 1000);
  const day = 24 * 60 * 60;

  assert.equal(conversationTtlSeconds(now), epoch + (45 * day));
  assert.equal(mcpAuditTtlSeconds(now), epoch + (14 * day));
});
