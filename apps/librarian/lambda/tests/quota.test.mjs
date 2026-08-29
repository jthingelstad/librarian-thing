import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
