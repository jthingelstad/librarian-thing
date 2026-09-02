import assert from 'node:assert/strict';
import test from 'node:test';
import {
  quotaMaxForEntitlements,
  DEFAULT_CHAT_DAILY_QUOTA,
  DEFAULT_MCP_DAILY_QUOTA,
  chatDailyQuota,
  mcpDailyQuota,
  quotaKey,
  utcDayBucket
} from '../dist/shared/quota.mjs';

test('quota keys are independent per surface and per day', () => {
  assert.equal(quotaKey('chat', 'abc', '2026-08-29'), 'quota#chat#abc#2026-08-29');
  assert.equal(quotaKey('mcp', 'abc', '2026-08-29'), 'quota#mcp#abc#2026-08-29');
  assert.notEqual(quotaKey('chat', 'abc', '2026-08-29'), quotaKey('mcp', 'abc', '2026-08-29'));
  assert.notEqual(quotaKey('chat', 'abc', '2026-08-29'), quotaKey('chat', 'abc', '2026-08-30'));
});

test('utcDayBucket is a UTC calendar date', () => {
  assert.equal(utcDayBucket(new Date('2026-08-29T23:59:59.000Z')), '2026-08-29');
  assert.equal(utcDayBucket(new Date('2026-08-30T00:00:01.000Z')), '2026-08-30');
});

test('quota envs fall back to sane defaults', () => {
  delete process.env.CHAT_DAILY_QUOTA;
  delete process.env.MCP_DAILY_QUOTA;
  assert.equal(chatDailyQuota(), DEFAULT_CHAT_DAILY_QUOTA);
  assert.equal(mcpDailyQuota(), DEFAULT_MCP_DAILY_QUOTA);
  process.env.CHAT_DAILY_QUOTA = '10';
  assert.equal(chatDailyQuota(), 10);
  process.env.CHAT_DAILY_QUOTA = '-3';
  assert.equal(chatDailyQuota(), DEFAULT_CHAT_DAILY_QUOTA);
  delete process.env.CHAT_DAILY_QUOTA;
});

test('supporting members get double daily pools', () => {
  assert.equal(quotaMaxForEntitlements(50, ['reader']), 50);
  assert.equal(quotaMaxForEntitlements(50, ['reader', 'supporting_member']), 100);
  assert.equal(quotaMaxForEntitlements(500, []), 500);
});

test('guest quota envs fall back to the agreed defaults', async () => {
  const { DEFAULT_GUEST_DAILY_QUOTA, DEFAULT_GUEST_GLOBAL_DAILY_QUOTA, guestDailyQuota, guestGlobalDailyQuota } =
    await import('../dist/shared/quota.mjs');
  delete process.env.GUEST_DAILY_QUOTA;
  delete process.env.GUEST_GLOBAL_DAILY_QUOTA;
  assert.equal(DEFAULT_GUEST_DAILY_QUOTA, 3);
  assert.equal(DEFAULT_GUEST_GLOBAL_DAILY_QUOTA, 100);
  assert.equal(guestDailyQuota(), 3);
  assert.equal(guestGlobalDailyQuota(), 100);
  process.env.GUEST_DAILY_QUOTA = '5';
  assert.equal(guestDailyQuota(), 5);
  process.env.GUEST_DAILY_QUOTA = '0';
  assert.equal(guestDailyQuota(), 3);
  delete process.env.GUEST_DAILY_QUOTA;
});

test('the strict guest counter fails CLOSED where the reader counter fails open', async () => {
  const { consumeDailyQuota, consumeDailyQuotaStrict } = await import('../dist/shared/quota.mjs');
  const savedTable = process.env.TABLE_NAME;
  delete process.env.TABLE_NAME;
  try {
    const readerResult = await consumeDailyQuota('chat', 'abc', 50);
    assert.equal(readerResult.allowed, true);
    const guestResult = await consumeDailyQuotaStrict('guest', 'abc', 3);
    assert.equal(guestResult.allowed, false);
  } finally {
    if (savedTable) process.env.TABLE_NAME = savedTable;
  }
});
