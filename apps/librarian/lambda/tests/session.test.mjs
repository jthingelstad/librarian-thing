import assert from 'node:assert/strict';
import test from 'node:test';
import { renderFaqAnswer, searchFaq } from '../dist/shared/faq.mjs';
import { buildMagicLink, createMagicToken, magicTokenHash, validMagicToken } from '../dist/shared/magic-link.mjs';
import {
  buildJmapEmailCalls,
  buildMagicLinkJmapCalls,
  magicLinkEmailHtml,
  magicLinkEmailText,
  pickSentMailbox,
  requireMethodResponse
} from '../dist/shared/jmap-mail.mjs';
import {
  createSessionToken,
  createSessionTokenForSub,
  emailHash,
  normalizeEmail,
  verifyToken
} from '../dist/shared/session.mjs';
import {
  entitlementsForSessionPayload,
  handler as authHandler,
  magicLinkBaseWithReturnPath
} from '../dist/auth/handler.mjs';
import {
  authProfile,
  memoryDynamoItem,
  memoryFromItem,
  recordUserTurn,
  recordUserPreferredName
} from '../dist/shared/user-memory.mjs';
import { renderTemplate, agentUserPrompt } from '../dist/shared/prompts.mjs';
import { subscriberStatus } from '../dist/shared/buttondown.mjs';
import { deleteThingyProfile, tokenIssuedAfterProfileDeletion } from '../dist/shared/profile-deletion.mjs';
import { dynamodb, s3 } from '../dist/shared/aws-clients.mjs';
import {
  availableConversationModes,
  canUseConversationMode,
  entitlementsForSubscriber,
  isOwnerEmail,
  normalizeConversationMode
} from '../dist/shared/conversation-modes.mjs';
import { normalizeFeedbackReaction, validFeedbackRequestId } from '../dist/shared/feedback.mjs';
import { readConverseStream } from '../dist/shared/bedrock-stream.mjs';
import {
  PREFLIGHT_SYSTEM_PROMPT,
  normalizePreflightDecision,
  parsePreflightJson,
  passThroughPreflight
} from '../dist/shared/prompt-preflight.mjs';
import { normalizeUserProfile, readerContextPrompt } from '../dist/shared/chat-context.mjs';

test('session token round trips and rejects tampering', () => {
  process.env.SESSION_SECRET = 'test-secret';
  const now = Math.floor(Date.now() / 1000);
  const { token, expiresAt } = createSessionToken('Reader@Example.com', 'session-1');
  const payload = verifyToken(token);

  assert.equal(payload.sid, 'session-1');
  assert.ok(Number(payload.iat || 0) > 0);
  assert.ok(Number(payload.iat_ms || 0) >= Number(payload.iat || 0) * 1000);
  assert.equal(payload.sub, emailHash('reader@example.com'));
  assert.ok(expiresAt >= now + 60 * 60 * 24 * 9 - 2);
  assert.ok(expiresAt <= now + 60 * 60 * 24 * 9 + 2);
  assert.equal(verifyToken(`${token}x`), null);
});

test('session token can carry safe entitlement claims', () => {
  process.env.SESSION_SECRET = 'test-secret';
  const { token } = createSessionToken('Reader@Example.com', 'session-2', {
    entitlements: ['reader', 'owner']
  });
  const payload = verifyToken(token);

  assert.equal(payload.sid, 'session-2');
  assert.deepEqual(payload.entitlements, ['reader', 'owner']);
  assert.ok(Number(payload.iat || 0) > 0);
  assert.ok(Number(payload.entitlements_verified_until || 0) >= Math.floor(Date.now() / 1000));
});

test('profile deletion marker rejects tokens issued before deletion', () => {
  const marker = {
    deleted_at_ms: 2000,
    deleted_at_seconds: 2
  };
  assert.equal(tokenIssuedAfterProfileDeletion({ sub: 'subscriber-hash', iat_ms: 1999 }, marker), false);
  assert.equal(tokenIssuedAfterProfileDeletion({ sub: 'subscriber-hash', iat_ms: 2001 }, marker), true);
  assert.equal(tokenIssuedAfterProfileDeletion({ sub: 'subscriber-hash', iat: 1 }, marker), false);
  assert.equal(tokenIssuedAfterProfileDeletion({ sub: 'subscriber-hash' }, marker), false);
  assert.equal(tokenIssuedAfterProfileDeletion({ sub: 'subscriber-hash' }, null), true);
});

test('legacy memory actions are rejected', async () => {
  process.env.SESSION_SECRET = 'test-secret';
  const priorTable = process.env.TABLE_NAME;
  delete process.env.TABLE_NAME;
  const { token } = createSessionToken('reader@example.com', 'legacy-memory-action');
  try {
    for (const action of ['synthesize', 'update', 'resynthesize', 'delete']) {
      const response = await authHandler(
        {
          httpMethod: 'POST',
          path: '/memory',
          headers: {
            authorization: `Bearer ${token}`,
            origin: 'https://thingy.thingelstad.com'
          },
          body: JSON.stringify({ action })
        },
        { awsRequestId: `legacy-${action}` }
      );
      assert.equal(response.statusCode, 400);
      assert.match(JSON.parse(response.body).error, /Unsupported memory action/);
    }
  } finally {
    if (priorTable === undefined) delete process.env.TABLE_NAME;
    else process.env.TABLE_NAME = priorTable;
  }
});

test('deleteThingyProfile deletes Thingy-local rows, artifacts, and writes a marker', async () => {
  const priorTable = process.env.TABLE_NAME;
  process.env.TABLE_NAME = 'thingy-test-table';
  const originalDynamoSend = dynamodb.send;
  const originalS3Send = s3.send;
  const dynamoCalls = [];
  const s3Calls = [];

  dynamodb.send = async (command) => {
    dynamoCalls.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === 'QueryCommand' && !command.input.IndexName) {
      return {
        Items: [
          { pk: { S: 'user#subscriber-hash' }, sk: { S: 'memory' } },
          {
            pk: { S: 'user#subscriber-hash' },
            sk: { S: 'dispatch#draft-1' },
            content_artifact_bucket: { S: 'artifact-bucket' },
            content_artifact_key: { S: 'dispatches/draft-1.json' }
          },
          { pk: { S: 'user#subscriber-hash' }, sk: { S: 'profile-deleted' } }
        ]
      };
    }
    if (command.constructor.name === 'QueryCommand' && command.input.IndexName === 'EmailHashIndex') {
      return {
        Items: [
          { pk: { S: 'session#abc' }, sk: { S: 'session' } },
          { pk: { S: 'user#subscriber-hash' }, sk: { S: 'memory' } }
        ]
      };
    }
    if (command.constructor.name === 'QueryCommand' && command.input.IndexName === 'SubscriberHashIndex') {
      return {
        Items: [{ pk: { S: 'linked#xyz' }, sk: { S: 'connection' } }]
      };
    }
    if (command.constructor.name === 'BatchWriteItemCommand') {
      return { UnprocessedItems: {} };
    }
    if (command.constructor.name === 'PutItemCommand') {
      return {};
    }
    throw new Error(`Unexpected Dynamo command ${command.constructor.name}`);
  };

  s3.send = async (command) => {
    s3Calls.push({ name: command.constructor.name, input: command.input });
    return {};
  };

  try {
    const result = await deleteThingyProfile('subscriber-hash');
    assert.equal(result.ok, true);
    assert.equal(result.deleted_items, 4);
    assert.equal(result.deleted_artifacts, 1);

    const batch = dynamoCalls.find((call) => call.name === 'BatchWriteItemCommand');
    const deletes = batch.input.RequestItems['thingy-test-table'].map((request) => request.DeleteRequest.Key);
    assert.equal(deletes.length, 4);
    assert.equal(
      deletes.some((key) => key.sk.S === 'profile-deleted'),
      false
    );
    assert.ok(deletes.some((key) => key.pk.S === 'linked#xyz'));
    assert.ok(deletes.some((key) => key.pk.S === 'session#abc'));
    assert.equal(
      dynamoCalls.some((call) => call.name === 'ScanCommand'),
      false
    );
    assert.ok(dynamoCalls.some((call) => call.input.IndexName === 'EmailHashIndex'));
    assert.ok(dynamoCalls.some((call) => call.input.IndexName === 'SubscriberHashIndex'));

    const put = dynamoCalls.find((call) => call.name === 'PutItemCommand');
    assert.equal(put.input.Item.pk.S, 'user#subscriber-hash');
    assert.equal(put.input.Item.sk.S, 'profile-deleted');
    assert.ok(put.input.Item.deleted_at.S);
    assert.ok(Number(put.input.Item.deleted_at_ms.N) > 0);

    assert.deepEqual(s3Calls, [
      {
        name: 'DeleteObjectCommand',
        input: {
          Bucket: 'artifact-bucket',
          Key: 'dispatches/draft-1.json'
        }
      }
    ]);
  } finally {
    dynamodb.send = originalDynamoSend;
    s3.send = originalS3Send;
    if (priorTable === undefined) delete process.env.TABLE_NAME;
    else process.env.TABLE_NAME = priorTable;
  }
});

test('memory delete_profile route deletes local rows and writes marker', async () => {
  process.env.SESSION_SECRET = 'test-secret';
  const priorTable = process.env.TABLE_NAME;
  process.env.TABLE_NAME = 'thingy-test-table';
  const originalDynamoSend = dynamodb.send;
  const originalS3Send = s3.send;
  const { token } = createSessionToken('reader@example.com', 'delete-profile-route');
  const dynamoCalls = [];
  const s3Calls = [];

  dynamodb.send = async (command) => {
    dynamoCalls.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === 'GetItemCommand') return {};
    if (command.constructor.name === 'QueryCommand' && !command.input.IndexName) {
      return {
        Items: [
          {
            pk: { S: `user#${emailHash('reader@example.com')}` },
            sk: { S: 'dispatch#draft-1' },
            content_artifact_bucket: { S: 'artifact-bucket' },
            content_artifact_key: { S: 'dispatches/draft-1.json' }
          }
        ]
      };
    }
    if (command.constructor.name === 'QueryCommand' && command.input.IndexName === 'EmailHashIndex') {
      return { Items: [{ pk: { S: 'session#abc' }, sk: { S: 'session' } }] };
    }
    if (command.constructor.name === 'QueryCommand' && command.input.IndexName === 'SubscriberHashIndex') {
      return { Items: [{ pk: { S: 'linked#xyz' }, sk: { S: 'connection' } }] };
    }
    if (command.constructor.name === 'BatchWriteItemCommand') return { UnprocessedItems: {} };
    if (command.constructor.name === 'PutItemCommand') return {};
    throw new Error(`Unexpected Dynamo command ${command.constructor.name}`);
  };
  s3.send = async (command) => {
    s3Calls.push({ name: command.constructor.name, input: command.input });
    return {};
  };

  try {
    const response = await authHandler(
      {
        httpMethod: 'POST',
        path: '/memory',
        headers: {
          authorization: `Bearer ${token}`,
          origin: 'https://thingy.thingelstad.com'
        },
        body: JSON.stringify({ action: 'delete_profile' })
      },
      { awsRequestId: 'delete-profile-route' }
    );
    const body = JSON.parse(response.body);
    assert.equal(response.statusCode, 200);
    assert.equal(body.status, 'deleted');
    assert.ok(body.deleted_at);
    assert.ok(dynamoCalls.some((call) => call.name === 'BatchWriteItemCommand'));
    assert.ok(dynamoCalls.some((call) => call.input.IndexName === 'EmailHashIndex'));
    assert.ok(dynamoCalls.some((call) => call.input.IndexName === 'SubscriberHashIndex'));
    assert.equal(
      dynamoCalls.some((call) => call.name === 'ScanCommand'),
      false
    );
    assert.equal(s3Calls.length, 1);
  } finally {
    dynamodb.send = originalDynamoSend;
    s3.send = originalS3Send;
    if (priorTable === undefined) delete process.env.TABLE_NAME;
    else process.env.TABLE_NAME = priorTable;
  }
});

test('session refresh entitlements do not renew stale privileged claims', () => {
  const priorOwnerEmails = process.env.THINGY_OWNER_EMAILS;
  const priorOwnerHashes = process.env.THINGY_OWNER_EMAIL_HASHES;
  process.env.THINGY_OWNER_EMAILS = 'jamie@thingelstad.com';
  delete process.env.THINGY_OWNER_EMAIL_HASHES;

  try {
    const now = 1000;
    assert.deepEqual(
      entitlementsForSessionPayload(
        {
          sub: emailHash('reader@example.com'),
          entitlements: ['reader', 'supporting_member'],
          entitlements_verified_until: now - 1
        },
        now
      ),
      ['reader']
    );
    assert.deepEqual(
      entitlementsForSessionPayload(
        {
          sub: emailHash('reader@example.com'),
          entitlements: ['reader', 'supporting_member'],
          entitlements_verified_until: now + 1
        },
        now
      ),
      ['reader', 'supporting_member']
    );
    assert.deepEqual(
      entitlementsForSessionPayload(
        {
          sub: emailHash('jamie@thingelstad.com'),
          entitlements: ['reader'],
          entitlements_verified_until: now - 1
        },
        now
      ),
      ['reader', 'owner', 'supporting_member', 'trusted_circle']
    );
  } finally {
    if (priorOwnerEmails === undefined) delete process.env.THINGY_OWNER_EMAILS;
    else process.env.THINGY_OWNER_EMAILS = priorOwnerEmails;
    if (priorOwnerHashes === undefined) delete process.env.THINGY_OWNER_EMAIL_HASHES;
    else process.env.THINGY_OWNER_EMAIL_HASHES = priorOwnerHashes;
  }
});

test('refreshed session token round trips with a stable subject hash', () => {
  process.env.SESSION_SECRET = 'test-secret';
  const sub = '0123456789abcdef0123456789abcdef';
  const { token, sessionId, expiresAt } = createSessionTokenForSub(sub, 'session-d1', {
    entitlements: ['reader']
  });
  assert.equal(sessionId, 'session-d1');
  assert.ok(expiresAt > Math.floor(Date.now() / 1000));

  const payload = verifyToken(token);
  assert.equal(payload.sid, 'session-d1');
  assert.equal(payload.sub, sub);
  assert.deepEqual(payload.entitlements, ['reader']);
  assert.equal(verifyToken(`${token}x`), null);
});

test('createSessionTokenForSub rejects empty sub', () => {
  process.env.SESSION_SECRET = 'test-secret';
  assert.throws(() => createSessionTokenForSub(''), /non-empty string/);
  assert.throws(() => createSessionTokenForSub(null), /non-empty string/);
});

test('conversation mode entitlements unlock the expected modes', () => {
  const priorOwnerEmails = process.env.THINGY_OWNER_EMAILS;
  const priorOwnerHashes = process.env.THINGY_OWNER_EMAIL_HASHES;
  process.env.THINGY_OWNER_EMAILS = 'jamie@thingelstad.com';
  delete process.env.THINGY_OWNER_EMAIL_HASHES;

  try {
    assert.equal(normalizeConversationMode('Thought Partner'), 'thought_partner');
    assert.equal(isOwnerEmail('jamie@thingelstad.com'), true);

    const readerEntitlements = entitlementsForSubscriber({
      email: 'reader@example.com',
      subscriber: { type: 'regular', tags: [] },
      status: 'regular'
    });
    assert.deepEqual(readerEntitlements, ['reader']);
    assert.equal(canUseConversationMode('thought_partner', readerEntitlements), false);

    const supportingEntitlements = entitlementsForSubscriber({
      email: 'supporter@example.com',
      subscriber: { type: 'premium', tags: [] },
      status: 'premium'
    });
    assert.ok(supportingEntitlements.includes('supporting_member'));
    assert.equal(canUseConversationMode('research_guide', supportingEntitlements), true);
    assert.equal(canUseConversationMode('thought_partner', supportingEntitlements), false);

    const giftedEntitlements = entitlementsForSubscriber({
      email: 'gifted@example.com',
      subscriber: { type: 'gifted', tags: [] },
      status: 'active'
    });
    assert.deepEqual(giftedEntitlements, ['reader', 'supporting_member']);
    assert.equal(canUseConversationMode('research_guide', giftedEntitlements), true);
    assert.equal(canUseConversationMode('thought_partner', giftedEntitlements), false);
    assert.equal(canUseConversationMode('trusted_circle', giftedEntitlements), false);

    const trustedEntitlements = entitlementsForSubscriber({
      email: 'family@example.com',
      subscriber: { type: 'regular', tags: [{ name: 'thingy-family' }] },
      status: 'regular'
    });
    assert.ok(trustedEntitlements.includes('trusted_circle'));

    const ownerEntitlements = entitlementsForSubscriber({
      email: 'jamie@thingelstad.com',
      subscriber: { type: 'regular', tags: [] },
      status: 'regular'
    });
    assert.ok(ownerEntitlements.includes('owner'));
    assert.ok(ownerEntitlements.includes('supporting_member'));
    assert.ok(ownerEntitlements.includes('trusted_circle'));
    assert.equal(canUseConversationMode('thought_partner', ownerEntitlements), true);
    assert.deepEqual(
      availableConversationModes(ownerEntitlements).map((mode) => mode.id),
      ['thingy', 'research_guide', 'thought_partner', 'trusted_circle']
    );
  } finally {
    if (priorOwnerEmails === undefined) delete process.env.THINGY_OWNER_EMAILS;
    else process.env.THINGY_OWNER_EMAILS = priorOwnerEmails;
    if (priorOwnerHashes === undefined) delete process.env.THINGY_OWNER_EMAIL_HASHES;
    else process.env.THINGY_OWNER_EMAIL_HASHES = priorOwnerHashes;
  }
});

test('authProfile returns returning=false for first-time users', () => {
  assert.deepEqual(authProfile(null), { returning: false });
});

test('memoryFromItem keeps the basic profile and ignores legacy synthesized fields', () => {
  const memory = memoryFromItem(
    {
      version: { N: '3' },
      first_seen_at: { S: '2026-01-01T00:00:00Z' },
      last_seen_at: { S: '2026-01-02T00:00:00Z' },
      preferred_name: { S: 'Jamie' },
      turn_count: { N: '7' },
      // Legacy attributes still present on pre-simplification rows.
      current_session_questions: {
        L: [{ M: { ts: { S: '2026-01-02T00:00:00Z' }, question: { S: 'What about RSS?' } } }]
      },
      recent_prompts: { L: [{ M: { ts: { S: '2026-01-01T00:00:00Z' }, question: { S: 'Tell me about OPML.' } } }] },
      synthesized_history: { L: [] },
      learned_profile: { L: [{ M: { label: { S: 'RSS workflows' }, summary: { S: 'Often explores RSS.' } } }] },
      memory_synthesis: { M: { status: { S: 'current' } } }
    },
    'subscriber-hash'
  );

  assert.equal(memory.sub, 'subscriber-hash');
  assert.equal(memory.version, 3);
  assert.equal(memory.preferred_name, 'Jamie');
  assert.equal(memory.turn_count, 7);
  assert.equal(Object.hasOwn(memory, 'current_session_questions'), false);
  assert.equal(Object.hasOwn(memory, 'recent_prompts'), false);
  assert.equal(Object.hasOwn(memory, 'synthesized_history'), false);
  assert.equal(Object.hasOwn(memory, 'learned_profile'), false);
  assert.equal(Object.hasOwn(memory, 'memory_synthesis'), false);
});

test('recordUserTurn increments the turn counter and keeps the profile basics', async () => {
  const priorTable = process.env.TABLE_NAME;
  process.env.TABLE_NAME = 'thingy-test-table';
  const originalDynamoSend = dynamodb.send;
  const storedItem = memoryDynamoItem(
    'subscriber-hash',
    {
      version: 4,
      first_seen_at: '2026-01-01T00:00:00.000Z',
      preferred_name: 'Jamie',
      turn_count: 7
    },
    '2026-01-01T00:00:00.000Z'
  );
  let writtenMemory = null;

  dynamodb.send = async (command) => {
    if (command.constructor.name === 'GetItemCommand') return { Item: storedItem };
    if (command.constructor.name === 'PutItemCommand') {
      if (command.input.Item?.sk?.S === 'memory') writtenMemory = command.input.Item;
      return {};
    }
    throw new Error(`Unexpected Dynamo command ${command.constructor.name}`);
  };

  try {
    await recordUserTurn('subscriber-hash', {});
    const memory = memoryFromItem(writtenMemory, 'subscriber-hash');
    assert.equal(memory.turn_count, 8);
    assert.equal(memory.version, 5);
    assert.equal(memory.preferred_name, 'Jamie');
    assert.equal(memory.first_seen_at, '2026-01-01T00:00:00.000Z');
    assert.equal(Object.hasOwn(writtenMemory, 'recent_prompts'), false);
    assert.equal(Object.hasOwn(writtenMemory, 'learned_profile'), false);
  } finally {
    dynamodb.send = originalDynamoSend;
    if (priorTable === undefined) delete process.env.TABLE_NAME;
    else process.env.TABLE_NAME = priorTable;
  }
});

test('recordUserPreferredName reports failure when memory storage is not configured', async () => {
  const priorTable = process.env.TABLE_NAME;
  delete process.env.TABLE_NAME;
  try {
    const result = await recordUserPreferredName('subscriber-hash', 'Jamie');
    assert.equal(result.ok, false);
    assert.match(result.error, /Missing memory write context/);
  } finally {
    if (priorTable === undefined) delete process.env.TABLE_NAME;
    else process.env.TABLE_NAME = priorTable;
  }
});

test('full memory item rewrites keep only the basic profile fields', () => {
  const item = memoryDynamoItem('subscriber-hash', {}, '2026-06-10T12:05:00.000Z');

  assert.equal(item.pk.S, 'user#subscriber-hash');
  assert.equal(item.sk.S, 'memory');
  assert.equal(Object.hasOwn(item, 'recent_prompts'), false);
});

test('authProfile reflects turn_count and keeps legacy keys as empty arrays', () => {
  const memory = {
    first_seen_at: '2026-01-01T00:00:00Z',
    last_seen_at: '2026-04-01T00:00:00Z',
    preferred_name: 'Jamie',
    turn_count: 7
  };
  const profile = authProfile(memory);
  assert.equal(profile.returning, true);
  assert.equal(profile.turn_count, 7);
  assert.equal(profile.preferred_name, 'Jamie');
  // Frozen contract shape for web clients deployed before the
  // synthesized-memory removal.
  assert.deepEqual(profile.current_session_questions, []);
  assert.deepEqual(profile.recent_prompts, []);
  assert.deepEqual(profile.prior_session_summaries, []);
  assert.deepEqual(profile.learned_profile, []);
  assert.deepEqual(profile.memory_synthesis, {});
});

test('reader context carries profile basics and ignores legacy prompt arrays', () => {
  const profile = normalizeUserProfile({
    turn_count: 9,
    preferred_name: 'Jamie',
    recent_prompts: [{ question: 'What did Jamie say about RSS?' }],
    current_session_questions: [{ question: 'Fallback current-session question.' }]
  });
  const prompt = readerContextPrompt({}, profile);

  assert.equal(Object.hasOwn(profile, 'recent_prompts'), false);
  assert.equal(Object.hasOwn(profile, 'current_session_questions'), false);
  assert.match(prompt, /Reader preferred name: Jamie/);
  assert.match(prompt, /Prior Thingy turns known to client: 9/);
  assert.doesNotMatch(prompt, /Client-known recent Thingy prompts/);
  assert.doesNotMatch(prompt, /What did Jamie say about RSS/);
});

test('email normalization is stable', () => {
  assert.equal(normalizeEmail(' Reader@Example.com '), 'reader@example.com');
  assert.equal(emailHash('Reader@Example.com'), emailHash('reader@example.com'));
});

test('magic link tokens are URL-safe and hashed for storage', () => {
  const token = createMagicToken();
  assert.equal(validMagicToken(token), token);
  assert.match(magicTokenHash(token), /^[a-f0-9]{64}$/);
  assert.equal(validMagicToken('not a token!'), '');
});

test('magic link builder adds login_token without leaking extra state', () => {
  const token = createMagicToken();
  const url = new URL(buildMagicLink(token, 'https://thingy.thingelstad.com/?prompt=hello'));
  assert.equal(url.origin, 'https://thingy.thingelstad.com');
  assert.equal(url.searchParams.get('prompt'), 'hello');
  assert.equal(url.searchParams.get('login_token'), token);
});

test('magic link base lands on signin with the app return path preserved', () => {
  const original = process.env.THINGY_MAGIC_LINK_BASE_URL;
  process.env.THINGY_MAGIC_LINK_BASE_URL = 'https://thingy.example/';
  try {
    const token = createMagicToken();
    const base = magicLinkBaseWithReturnPath('/dispatch/?from=https%3A%2F%2Fweekly.example%2Fissue');
    const url = new URL(buildMagicLink(token, base));
    assert.equal(url.origin, 'https://thingy.example');
    assert.equal(url.pathname, '/signin/');
    assert.equal(url.searchParams.get('return'), '/dispatch/?from=https%3A%2F%2Fweekly.example%2Fissue');
    assert.equal(url.searchParams.get('login_token'), token);
  } finally {
    if (original === undefined) delete process.env.THINGY_MAGIC_LINK_BASE_URL;
    else process.env.THINGY_MAGIC_LINK_BASE_URL = original;
  }
});

test('magic link email text includes expiration and fallback URL', () => {
  const text = magicLinkEmailText({ magicLink: 'https://thingy.example/login?token=abc', expiresMinutes: 15 });
  assert.match(text, /Thingy is ready/);
  assert.match(text, /https:\/\/thingy\.example\/login\?token=abc/);
  assert.match(text, /expires in 15 minutes/);
});

test('magic link email copy reflects reader context', () => {
  const text = magicLinkEmailText({
    magicLink: 'https://thingy.example/login?token=abc',
    expiresMinutes: 15,
    context: { preferred_name: 'Jamie', returning: true, turn_count: 4, subscriber_status: 'premium' }
  });
  assert.match(text, /Hi Jamie/);
  assert.match(text, /archive thread is waiting/);
  assert.match(text, /Supporting Member/);

  const html = magicLinkEmailHtml({
    magicLink: 'https://thingy.example/login?token=abc&x=<bad>',
    expiresMinutes: 15,
    context: { preferred_name: 'Jamie', returning: true, turn_count: 4 },
    imageUrl: 'https://thingy.example/img/thingy.png'
  });
  assert.match(html, /Hi Jamie/);
  assert.match(html, /Open Thingy/);
  assert.match(html, /thingy\.png/);
  assert.match(html, /https:\/\/tinylytics\.app\/pixel\/u5bRAyyJvMXUrz6zbTz5\.gif\?path=%2Femail%2Fthingy%2Flogin/);
  assert.doesNotMatch(html, /<bad>/);
});

test('sign-in code leads the subject and body so Apple Mail detects it', () => {
  const text = magicLinkEmailText({
    magicLink: 'https://thingy.example/login?token=abc',
    expiresMinutes: 15,
    code: '123456'
  });
  assert.ok(text.startsWith('Your Thingy sign-in code is 123456'));
  assert.match(text, /The code and link expire in 15 minutes/);

  const html = magicLinkEmailHtml({
    magicLink: 'https://thingy.example/login?token=abc',
    expiresMinutes: 15,
    imageUrl: 'https://thingy.example/img/thingy.png',
    code: '123456'
  });
  // The "code is" phrasing and the digits must share one text run — a block
  // boundary between them defeats Mail's verification-code detector.
  assert.match(html, /Your Thingy sign-in code is <span[^>]*>123456<\/span>/);

  const calls = buildMagicLinkJmapCalls({
    context: {
      mailAccountId: 'mail-account',
      submissionAccountId: 'submission-account',
      identityId: 'identity-1',
      draftMailboxId: 'drafts-1',
      sentMailboxId: 'sent-1'
    },
    fromEmail: 'thingy@example.com',
    fromName: 'Thingy',
    to: 'reader@example.com',
    text: 'hello',
    html: '<p>hello</p>',
    code: '123456'
  });
  assert.equal(calls[0][1].create.draft.subject, '123456 is your Thingy sign-in code');
});

test('JMAP method errors are treated as hard send failures', () => {
  assert.throws(
    () => requireMethodResponse([['error', { type: 'accountReadOnly' }, 'email']], 'Email/set', 'email'),
    /accountReadOnly/
  );
  assert.deepEqual(
    requireMethodResponse([['Email/set', { created: { draft: { id: 'm1' } } }, 'email']], 'Email/set', 'email'),
    { created: { draft: { id: 'm1' } } }
  );
});

test('JMAP magic link payload creates a draft and submits it through Sent', () => {
  const calls = buildMagicLinkJmapCalls({
    context: {
      mailAccountId: 'mail-account',
      submissionAccountId: 'submission-account',
      identityId: 'identity-1',
      draftMailboxId: 'drafts-1',
      sentMailboxId: 'sent-1'
    },
    fromEmail: 'thingy@example.com',
    fromName: 'Thingy',
    to: 'reader@example.com',
    text: 'hello',
    html: '<p>hello</p>'
  });

  const emailSet = calls[0][1];
  assert.equal(calls[0][0], 'Email/set');
  assert.deepEqual(emailSet.create.draft.mailboxIds, { 'drafts-1': true });
  assert.deepEqual(emailSet.create.draft.bodyStructure, {
    type: 'multipart/alternative',
    subParts: [
      { partId: 'text', type: 'text/plain' },
      { partId: 'html', type: 'text/html' }
    ]
  });
  assert.equal(emailSet.create.draft.bodyValues.text.value, 'hello');
  assert.equal(emailSet.create.draft.bodyValues.html.value, '<p>hello</p>');
  assert.equal(emailSet.create.draft.subject, 'Thingy is ready for you');

  const submissionSet = calls[1][1];
  assert.equal(calls[1][0], 'EmailSubmission/set');
  assert.equal(submissionSet.create.send.emailId, '#draft');
  assert.equal(submissionSet.create.send.identityId, 'identity-1');
  assert.deepEqual(submissionSet.create.send.envelope, {
    mailFrom: { email: 'thingy@example.com' },
    rcptTo: [{ email: 'reader@example.com' }]
  });
  assert.deepEqual(submissionSet.onSuccessUpdateEmail['#send'], {
    'mailboxIds/sent-1': true,
    'mailboxIds/drafts-1': null,
    'keywords/$draft': null
  });
});

test('JMAP generic email payload uses supplied subject', () => {
  const calls = buildJmapEmailCalls({
    context: {
      mailAccountId: 'mail-account',
      submissionAccountId: 'submission-account',
      identityId: 'identity-1',
      draftMailboxId: 'drafts-1',
      sentMailboxId: 'sent-1'
    },
    fromEmail: 'thingy@example.com',
    fromName: 'Thingy',
    to: 'reader@example.com',
    subject: 'Thingy Dispatch — The Output Is Not the Point',
    text: 'dispatch text',
    html: '<p>dispatch html</p>'
  });

  assert.equal(calls[0][1].create.draft.subject, 'Thingy Dispatch — The Output Is Not the Point');
});

test('buttondown subscriber status maps active and inactive states', () => {
  assert.equal(subscriberStatus(null), 'not_found');
  assert.equal(subscriberStatus({ type: 'regular' }), 'active');
  assert.equal(subscriberStatus({ type: 'premium' }), 'premium');
  assert.equal(subscriberStatus({ type: 'unactivated' }), 'unconfirmed');
  assert.equal(subscriberStatus({ type: 'regular', unsubscription_date: '2026-01-01' }), 'inactive');
  assert.equal(subscriberStatus({ type: 'disabled' }), 'inactive');
});

test('prompt template renderer substitutes named placeholders', () => {
  assert.equal(
    renderTemplate('Hello {{ name }} from {{ place }}.', { name: 'Thingy', place: 'the archive' }),
    'Hello Thingy from the archive.'
  );
});

test('agent user prompt renders dynamic conversation context', () => {
  const prompt = agentUserPrompt({
    conversation_context: 'User: Tell me more.',
    reader_context: 'Reader preferred name: Jamie',
    question: 'What did the archive say about RSS?'
  });

  assert.match(prompt, /User: Tell me more\./);
  assert.match(prompt, /Reader preferred name: Jamie/);
  assert.match(prompt, /What did the archive say about RSS\?/);
  assert.match(prompt, /Investigate with tools as needed/);
});

test('preflight JSON parser tolerates fenced strict JSON', () => {
  const parsed = parsePreflightJson('```json\n{"action":"rewrite","category":"archive_rewrite"}\n```');
  assert.deepEqual(parsed, { action: 'rewrite', category: 'archive_rewrite' });
  assert.equal(parsePreflightJson('not json'), null);
});

test('preflight normalizer keeps rewrites/direct answers safe and structured', () => {
  const rewrite = normalizePreflightDecision(
    {
      action: 'rewrite',
      category: 'archive_rewrite',
      rewritten_question: 'Pick one archive thread and tell it as a concise story.',
      answer_guidance: 'Keep the playful intent.'
    },
    'Tell me a story.'
  );
  assert.equal(rewrite.action, 'rewrite');
  assert.equal(rewrite.category, 'archive_rewrite');
  assert.equal(rewrite.original_question, 'Tell me a story.');
  assert.match(rewrite.rewritten_question, /archive thread/);

  const badRewrite = normalizePreflightDecision({ action: 'rewrite', category: 'archive_rewrite' }, 'Surprise me.');
  assert.equal(badRewrite.action, 'pass');

  const direct = normalizePreflightDecision(
    { action: 'direct', category: 'privacy_refusal' },
    'Where does Jamie live?'
  );
  assert.equal(direct.action, 'direct');
  assert.equal(direct.category, 'privacy_refusal');
  assert.match(direct.direct_answer, /public archive/i);

  assert.equal(passThroughPreflight('What did Jamie write about RSS?').action, 'pass');
});

test('preflight prompt allows named-person archive lookups without weakening privacy refusals', () => {
  assert.match(PREFLIGHT_SYSTEM_PROMPT, /Named-person archive lookups are allowed/);
  assert.match(PREFLIGHT_SYSTEM_PROMPT, /Do not refuse merely because the prompt names a private individual/);
  assert.match(PREFLIGHT_SYSTEM_PROMPT, /home address, phone numbers, whereabouts/);
});

test('FAQ search returns authoritative shared FAQ entries', () => {
  const results = searchFaq('How do I unsubscribe?', { replacements: { yearsActive: 10, issueCount: 345 } });

  assert.equal(results[0].question, 'How do I unsubscribe?');
  assert.equal(results[0].url, '/faq/');
  assert.match(results[0].answer_text, /unsubscribe link/);
  assert.equal(
    renderFaqAnswer('over {{yearsActive}} years and {{issueCount}} issues', { yearsActive: 10, issueCount: 345 }),
    'over 10 years and 345 issues'
  );
});

test('feedback helpers accept only expected reactions and request ids', () => {
  assert.equal(normalizeFeedbackReaction('up'), 'up');
  assert.equal(normalizeFeedbackReaction(' DOWN '), 'down');
  assert.equal(normalizeFeedbackReaction('helpful'), '');

  assert.equal(validFeedbackRequestId('63026f16-ef49-456f-b26f-bc76d7d83481'), '63026f16-ef49-456f-b26f-bc76d7d83481');
  assert.equal(validFeedbackRequestId('request:local.test_1'), 'request:local.test_1');
  assert.equal(validFeedbackRequestId('conversation#bad'), '');
  assert.equal(validFeedbackRequestId(''), '');
});

test('Bedrock converse stream reader emits incremental text deltas', async () => {
  const deltas = [];
  const result = await readConverseStream(
    {
      stream: [
        { messageStart: { role: 'assistant' } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'First ' } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'second.' } } },
        { messageStop: { stopReason: 'end_turn' } },
        { metadata: { usage: { outputTokens: 3 } } }
      ]
    },
    { onTextDelta: (delta) => deltas.push(delta) }
  );

  assert.deepEqual(deltas, ['First ', 'second.']);
  assert.equal(result.text, 'First second.');
  assert.deepEqual(result.message.content, [{ text: 'First second.' }]);
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.usage.outputTokens, 3);
});

test('Bedrock converse stream reader reconstructs streamed tool use input', async () => {
  const result = await readConverseStream({
    stream: [
      { messageStart: { role: 'assistant' } },
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: 'tool-1', name: 'search_archive' } }
        }
      },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"query":"' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: 'RSS"}' } } } },
      { messageStop: { stopReason: 'tool_use' } }
    ]
  });

  assert.deepEqual(result.message.content, [
    {
      toolUse: { toolUseId: 'tool-1', name: 'search_archive', input: { query: 'RSS' } }
    }
  ]);
  assert.equal(result.stopReason, 'tool_use');
});

// The Fastmail account is shared by several agents: only the top-level Sent
// carries the JMAP "sent" role, and each agent has a plain named child under it.
// Resolving by role alone filed every Thingy magic link into the shared Sent.
const SHARED_MAILBOXES = [
  { id: 'sent-root', name: 'Sent', parentId: null, role: 'sent' },
  { id: 'drafts', name: 'Drafts', parentId: null, role: 'drafts' },
  { id: 'thingy-sent', name: 'Thingy-Sent', parentId: 'sent-root' },
  { id: 'elixir-sent', name: 'Elixir-Sent', parentId: 'sent-root' }
];

test('JMAP sent mailbox resolves to Thingy own child of Sent', () => {
  const picked = pickSentMailbox(SHARED_MAILBOXES, 'sent-root', 'Thingy-Sent');
  assert.equal(picked.id, 'thingy-sent');
});

test('JMAP sent mailbox never picks another agent folder', () => {
  const picked = pickSentMailbox(SHARED_MAILBOXES, 'sent-root', 'Thingy-Sent');
  assert.notEqual(picked.id, 'elixir-sent');
});

test('JMAP sent mailbox falls back to shared Sent rather than failing to send', () => {
  const picked = pickSentMailbox(SHARED_MAILBOXES, 'sent-root', 'Missing-Sent');
  assert.equal(picked.id, 'sent-root');
});

test('JMAP sent mailbox ignores a same-named folder under another parent', () => {
  const decoys = [
    ...SHARED_MAILBOXES,
    { id: 'archive-root', name: 'Archive', parentId: null, role: 'archive' },
    { id: 'decoy', name: 'Thingy-Sent', parentId: 'archive-root' }
  ];
  assert.equal(pickSentMailbox(decoys, 'sent-root', 'Thingy-Sent').id, 'thingy-sent');
});
