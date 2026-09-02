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

test('loadSharedConversationSnapshot honors the sharedUpTo privacy pin', async () => {
  const { loadSharedConversationSnapshot } = await import('../dist/shared/share-store.mjs');
  const conversationItem = {
    pk: { S: 'user#owner-hash' },
    sk: { S: 'conversation#conv-1' },
    conversation_id: { S: 'conv-1' },
    title: { S: 'Pinned share' },
    created_at: { S: '2026-09-01T00:00:00.000Z' },
    turn_count: { N: '3' }
  };
  const turnItems = [
    ['2026-09-01T10:00:00.000Z', 'r1', 'first question', 'first answer'],
    ['2026-09-01T11:00:00.000Z', 'r2', 'second question', 'second answer'],
    // Asked AFTER the share was created: must never reach the snapshot.
    ['2026-09-02T09:00:00.000Z', 'r3', 'private later question', 'private later answer']
  ].map(([created, rid, question, answer]) => ({
    pk: { S: 'user#owner-hash' },
    sk: { S: `conversation#conv-1#turn#${created}#${rid}` },
    conversation_id: { S: 'conv-1' },
    request_id: { S: rid },
    created_at: { S: created },
    question: { S: question },
    answer: { S: answer },
    citations: { L: [] }
  }));
  const dynamodb = {
    async send(command) {
      if (command.constructor.name === 'GetItemCommand') return { Item: conversationItem };
      return { Items: turnItems };
    }
  };
  const share = {
    subscriberHash: 'owner-hash',
    conversationId: 'conv-1',
    sharedUpTo: '2026-09-01T23:59:59.999Z',
    createdAt: '2026-09-01T12:00:00.000Z',
    expiresAt: 0
  };
  const snapshot = await loadSharedConversationSnapshot('shr_' + 'a'.repeat(43), {
    dynamodb,
    tableName: 'table-name',
    getShare: async () => share
  });
  assert.ok(snapshot);
  assert.equal(snapshot.title, 'Pinned share');
  const contents = snapshot.messages.map((message) => message.content);
  assert.ok(contents.includes('first question') && contents.includes('second answer'));
  assert.ok(!contents.some((content) => content.includes('private later')), 'turns after sharedUpTo stay private');
  // Only role/content/citations/created_at (+4.8 receipt fields) are
  // projected - request ids and tool traces never reach the snapshot.
  for (const message of snapshot.messages) {
    assert.ok(!('request_id' in message) && !('tool_trace' in message));
  }
});
