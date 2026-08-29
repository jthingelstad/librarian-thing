import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeHistory } from '../dist/shared/chat-context.mjs';

function turns(count, charsEach = 100) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `turn-${index} ${'x'.repeat(charsEach)}`
  }));
}

test('sanitizeHistory keeps the most recent turns under the char budget', () => {
  // 30 turns of ~1500 chars each blows any budget; the survivors must be
  // the newest turns, evicting from the oldest end.
  const history = turns(30, 1400);
  const cleaned = sanitizeHistory(history);
  assert.ok(cleaned.length > 0);
  assert.match(cleaned[cleaned.length - 1].content, /^turn-29 /);
  const kept = cleaned.map((item) => Number(item.content.match(/^turn-(\d+)/)[1]));
  assert.deepEqual([...kept].sort((a, b) => a - b), kept);
  assert.equal(kept[kept.length - 1], 29);
});

test('sanitizeHistory keeps a short history intact and in order', () => {
  const cleaned = sanitizeHistory(turns(4, 50));
  assert.equal(cleaned.length, 4);
  assert.match(cleaned[0].content, /^turn-0 /);
  assert.match(cleaned[3].content, /^turn-3 /);
});

test('sanitizeHistory drops malformed entries', () => {
  const cleaned = sanitizeHistory([{ role: 'user', content: 'hi' }, { role: 'weird', content: 'x' }, { content: 'y' }]);
  assert.equal(cleaned.length, 1);
});
