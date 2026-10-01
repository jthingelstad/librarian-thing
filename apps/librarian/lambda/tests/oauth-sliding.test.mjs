// Sliding MCP connections (contract 4.14.0): a refresh family lives while it
// is refreshed within the idle window, with no absolute cap; the email stored
// at consent drives a membership re-check every nine days (lapsed revokes,
// a Buttondown outage keeps going, the owner is exempt); the member list is
// trimmed; families from before the change keep their 90-day cap. Also the
// AWS DevOps Agent 3LO shapes: client_id over HTTP Basic, offline_access.
import assert from 'node:assert/strict';
import test from 'node:test';
import { dynamodb } from '../dist/shared/aws-clients.mjs';
import {
  AUTH_CODE_PREFIX,
  LEGACY_FAMILY_MAX_SECONDS,
  MEMBERSHIP_RECHECK_SECONDS,
  OAUTH_FAMILY_IDLE_SECONDS,
  OAUTH_FAMILY_MEMBERS_KEPT,
  familyExpiresAt,
  familyMembersAfterRotation,
  buildAuthCodeItem,
  mintTokens,
  redeemAuthCode,
  redeemRefreshToken,
  sha256Hex,
  validateAccessToken
} from '../dist/shared/oauth-store.mjs';
import { checkConnectionMembership, handleToken, tokenRequestClientId } from '../dist/auth/oauth-routes.mjs';

process.env.TABLE_NAME = 'test-table';

const SUB = 'c'.repeat(64);
const CLIENT = 'DevOpsAgentClientIdAbCdE';
const FAMILY = 'SlidingFamilyIdForTests';
const EMAIL = 'reader@example.com';
const DAY = 24 * 60 * 60;
const S = (value) => ({ S: String(value) });
const N = (value) => ({ N: String(value) });
const now = () => Math.floor(Date.now() / 1000);

// A small single table that applies the writes the OAuth store makes:
// conditional puts, the rotated_to claim, and the family rotation.
function fakeTable(seed = [], { onRotateClaim } = {}) {
  const rows = new Map(seed.map((item) => [`${item.pk.S}|${item.sk.S}`, structuredClone(item)]));
  const original = dynamodb.send;
  const conditionFailed = () => Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
  dynamodb.send = async (command) => {
    const name = command.constructor.name;
    const input = command.input;
    const key = input.Key ? `${input.Key.pk.S}|${input.Key.sk.S}` : '';
    if (name === 'GetItemCommand') return { Item: rows.get(key) };
    if (name === 'DeleteItemCommand') {
      rows.delete(key);
      return {};
    }
    if (name === 'PutItemCommand') {
      const putKey = `${input.Item.pk.S}|${input.Item.sk.S}`;
      if (input.ConditionExpression === 'attribute_not_exists(pk)' && rows.has(putKey)) throw conditionFailed();
      rows.set(putKey, input.Item);
      return {};
    }
    if (name === 'UpdateItemCommand') {
      const row = rows.get(key);
      const values = input.ExpressionAttributeValues || {};
      if (input.UpdateExpression.startsWith('SET rotated_to')) {
        if (!row || row.rotated_to) throw conditionFailed();
        rows.set(key, { ...row, rotated_to: values[':rotated_to'], rotated_at: values[':now'] });
        onRotateClaim?.(rows);
        return {};
      }
      if (input.Key.pk.S.startsWith('oauthcode#')) {
        if (!row || row.used_at) throw conditionFailed();
        const spent = { ...row, used_at: values[':used_at'] };
        delete spent.email;
        rows.set(key, spent);
        return { Attributes: row };
      }
      if (input.Key.pk.S.startsWith('oauthfamily#')) {
        if (!row) throw conditionFailed();
        rows.set(key, {
          ...row,
          member_hashes: values[':members'],
          ttl: values[':ttl'],
          last_refreshed_at: values[':now'],
          ...(values[':verified'] ? { entitlements_verified_at: values[':verified'] } : {})
        });
        return {};
      }
      return {};
    }
    throw new Error(`unexpected ${name}`);
  };
  return { rows, restore: () => (dynamodb.send = original) };
}

const refreshToken = `lrt_${'r'.repeat(43)}`;
const refreshHash = sha256Hex(refreshToken);

function refreshRow(extra = {}) {
  return {
    pk: S(`oauthrefresh#${refreshHash}`),
    sk: S('refresh'),
    client_id: S(CLIENT),
    subscriber_hash: S(SUB),
    entitlements: S('["reader"]'),
    scope: S('archive:read'),
    family_id: S(FAMILY),
    created_at: N(now() - DAY),
    expires_at: N(now() + 29 * DAY),
    ttl: N(now() + 29 * DAY),
    ...extra
  };
}

function familyRow({ createdAgo = 200 * DAY, verifiedAgo = DAY, email = EMAIL, members = [refreshHash] } = {}) {
  return {
    pk: S(`oauthfamily#${FAMILY}`),
    sk: S('family'),
    subscriber_hash: S(SUB),
    ...(email ? { email: S(email), entitlements_verified_at: N(now() - verifiedAgo) } : {}),
    member_hashes: { L: members.map(S) },
    created_at: N(now() - createdAgo),
    ttl: N(now() + 29 * DAY)
  };
}

const familyKey = `oauthfamily#${FAMILY}|family`;
const members = (table) => table.rows.get(familyKey).member_hashes.L.map((entry) => entry.S);

test('the code exchange hands over the verified email and the spent code drops it', async () => {
  const code = `${AUTH_CODE_PREFIX}${'k'.repeat(43)}`;
  const pending = {
    clientId: CLIENT,
    redirectUri: 'https://a.example/cb',
    scope: 'archive:read',
    codeChallenge: 'x'.repeat(43),
    email: EMAIL,
    subscriberHash: SUB,
    entitlements: ['reader']
  };
  const created = now();
  const table = fakeTable([buildAuthCodeItem(pending, sha256Hex(code), created)]);
  try {
    const redeemed = await redeemAuthCode(code);
    assert.equal(redeemed.email, EMAIL);
    assert.equal(redeemed.verifiedAt, created);
    assert.equal('email' in table.rows.get(`oauthcode#${sha256Hex(code)}|code`), false);
    assert.equal(await redeemAuthCode(code), null, 'single use');
  } finally {
    table.restore();
  }
});

test('consent writes the family row with the email, the hash for profile deletion and a sliding ttl', async () => {
  const table = fakeTable();
  try {
    const grant = { clientId: CLIENT, subscriberHash: SUB, entitlements: ['reader'], scope: 'archive:read' };
    const tokens = await mintTokens(grant, { email: EMAIL, verifiedAt: now() - 60 });
    const family = table.rows.get(`oauthfamily#${tokens.familyId}|family`);
    assert.equal(family.email.S, EMAIL);
    assert.equal(family.subscriber_hash.S, SUB, 'SubscriberHashIndex finds it at profile deletion');
    assert.deepEqual(
      family.member_hashes.L.map((entry) => entry.S),
      [sha256Hex(tokens.refreshToken)]
    );
    assert.ok(Math.abs(Number(family.ttl.N) - (now() + OAUTH_FAMILY_IDLE_SECONDS)) <= 2);
    assert.equal(tokens.expiresAt, Number(family.ttl.N));
    // Only the family row holds the email; token rows never do.
    for (const [key, row] of table.rows) {
      if (!key.startsWith('oauthfamily#')) assert.equal('email' in row, false, key);
    }
  } finally {
    table.restore();
  }
});

test('a refresh slides a 200-day-old connection 30 days ahead: there is no absolute cap', async () => {
  const table = fakeTable([refreshRow(), familyRow({ createdAgo: 200 * DAY })]);
  try {
    let asked = false;
    const result = await redeemRefreshToken(refreshToken, CLIENT, async () => {
      asked = true;
      return { status: 'unavailable' };
    });
    assert.equal(result.status, 'ok');
    assert.equal(asked, false, 'verified a day ago, so Buttondown is not asked');
    assert.ok(Math.abs(result.expiresAt - (now() + OAUTH_FAMILY_IDLE_SECONDS)) <= 2);
    assert.equal(Number(table.rows.get(familyKey).ttl.N), result.expiresAt);
    assert.deepEqual(members(table), [refreshHash, sha256Hex(result.tokens.refreshToken)]);
    assert.ok(await validateAccessToken(result.tokens.accessToken));
    // The old token is spent: replaying it revokes the connection.
    assert.equal((await redeemRefreshToken(refreshToken, CLIENT)).status, 'reuse_revoked');
    assert.equal(table.rows.has(familyKey), false);
  } finally {
    table.restore();
  }
});

test('a family from before the change (no email) keeps its 90-day cap', async () => {
  const old = fakeTable([refreshRow(), familyRow({ email: '', createdAgo: LEGACY_FAMILY_MAX_SECONDS + DAY })]);
  try {
    assert.equal((await redeemRefreshToken(refreshToken, CLIENT)).status, 'invalid');
    assert.equal(old.rows.has(familyKey), false, 'revoked at the cap');
  } finally {
    old.restore();
  }
  const young = fakeTable([refreshRow(), familyRow({ email: '', createdAgo: 80 * DAY })]);
  try {
    const result = await redeemRefreshToken(refreshToken, CLIENT, async () => {
      throw new Error('no email, so no re-check');
    });
    assert.equal(result.status, 'ok');
    // It still ends at the cap, not 30 days on.
    assert.ok(Math.abs(result.expiresAt - (now() + 10 * DAY)) <= 2);
  } finally {
    young.restore();
  }
  assert.equal(familyExpiresAt({ createdAt: 1000, email: 'x@example.com' }, 5000), 5000 + OAUTH_FAMILY_IDLE_SECONDS);
});

test('a revoked or idle-expired family refuses the refresh', async () => {
  const gone = fakeTable([refreshRow()]);
  try {
    assert.equal((await redeemRefreshToken(refreshToken, CLIENT)).status, 'invalid');
  } finally {
    gone.restore();
  }
  const idle = fakeTable([refreshRow(), { ...familyRow(), ttl: N(now() - 60) }]);
  try {
    assert.equal((await redeemRefreshToken(refreshToken, CLIENT)).status, 'invalid');
  } finally {
    idle.restore();
  }
});

test('nine days on, a refresh re-checks the membership with the stored email', async () => {
  const table = fakeTable([refreshRow(), familyRow({ verifiedAgo: MEMBERSHIP_RECHECK_SECONDS + 60 })]);
  try {
    let seen;
    const result = await redeemRefreshToken(refreshToken, CLIENT, async (membership) => {
      seen = membership;
      return { status: 'verified', entitlements: ['reader', 'supporting_member'] };
    });
    assert.equal(seen.email, EMAIL);
    assert.equal(seen.subscriberHash, SUB);
    assert.deepEqual(seen.entitlements, ['reader']);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.grant.entitlements, ['reader', 'supporting_member']);
    const context = await validateAccessToken(result.tokens.accessToken);
    assert.deepEqual(context.entitlements, ['reader', 'supporting_member']);
    const verifiedAt = Number(table.rows.get(familyKey).entitlements_verified_at.N);
    assert.ok(Math.abs(verifiedAt - now()) <= 2, 'the nine-day clock restarts');
  } finally {
    table.restore();
  }
});

test('a lapsed membership revokes the connection; a Buttondown outage keeps it', async () => {
  const stale = { verifiedAgo: MEMBERSHIP_RECHECK_SECONDS + 60 };
  const lapsed = fakeTable([refreshRow(), familyRow(stale)]);
  try {
    const result = await redeemRefreshToken(refreshToken, CLIENT, async () => ({
      status: 'lapsed',
      subscriberStatus: 'not_found'
    }));
    assert.equal(result.status, 'lapsed');
    assert.equal(lapsed.rows.has(familyKey), false, 'the family row, and the email with it, is gone');
    assert.equal(lapsed.rows.has(`oauthrefresh#${refreshHash}|refresh`), false);
  } finally {
    lapsed.restore();
  }
  const outage = fakeTable([refreshRow(), familyRow(stale)]);
  try {
    const before = Number(outage.rows.get(familyKey).entitlements_verified_at.N);
    const result = await redeemRefreshToken(refreshToken, CLIENT, async () => ({ status: 'unavailable' }));
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.grant.entitlements, ['reader']);
    assert.equal(
      Number(outage.rows.get(familyKey).entitlements_verified_at.N),
      before,
      'still stale, so the next refresh asks again'
    );
  } finally {
    outage.restore();
  }
});

test('the family keeps only the newest refresh hashes, the live one always among them', async () => {
  const history = Array.from({ length: OAUTH_FAMILY_MEMBERS_KEPT }, (_, index) => `old${index}`);
  const table = fakeTable([refreshRow(), familyRow({ members: [...history.slice(1), refreshHash] })]);
  try {
    const result = await redeemRefreshToken(refreshToken, CLIENT);
    const kept = members(table);
    assert.equal(kept.length, OAUTH_FAMILY_MEMBERS_KEPT);
    assert.equal(kept.at(-1), sha256Hex(result.tokens.refreshToken));
    assert.equal(kept.at(-2), refreshHash);
    assert.equal(kept.includes('old1'), false, 'the oldest is dropped');
  } finally {
    table.restore();
  }
  assert.deepEqual(familyMembersAfterRotation(['a', 'b'], 'c'), ['a', 'b', 'c']);
  // A year of hourly refreshes stays the same size.
  let list = [];
  for (let index = 0; index < 24 * 365; index += 1) list = familyMembersAfterRotation(list, `h${index}`);
  assert.equal(list.length, OAUTH_FAMILY_MEMBERS_KEPT);
  assert.equal(list.at(-1), `h${24 * 365 - 1}`);
});

test('a refresh racing a disconnect does not bring the family back', async () => {
  const table = fakeTable([refreshRow(), familyRow()], {
    onRotateClaim: (rows) => rows.delete(familyKey)
  });
  try {
    const result = await redeemRefreshToken(refreshToken, CLIENT);
    assert.equal(result.status, 'invalid');
    assert.equal(table.rows.has(familyKey), false);
    const refreshRows = [...table.rows.keys()].filter((key) => key.startsWith('oauthrefresh#'));
    assert.deepEqual(refreshRows, [`oauthrefresh#${refreshHash}|refresh`], 'the successor refresh row is dropped');
  } finally {
    table.restore();
  }
});

test('the token endpoint takes client_id over HTTP Basic with an empty secret', () => {
  const basic = (value) => ({ headers: { Authorization: `Basic ${Buffer.from(value).toString('base64')}` } });
  assert.equal(tokenRequestClientId({ headers: {} }, { client_id: CLIENT }), CLIENT);
  assert.equal(tokenRequestClientId(basic(`${CLIENT}:`), {}), CLIENT);
  assert.equal(tokenRequestClientId(basic(`${CLIENT}:`), { client_id: CLIENT }), CLIENT);
  // Both halves are form-encoded (RFC 6749 2.3.1).
  assert.equal(tokenRequestClientId(basic('a%2Db:'), {}), 'a-b');
  // A secret, a disagreement with the body, or a malformed header: refused.
  assert.equal(tokenRequestClientId(basic(`${CLIENT}:secret`), {}), null);
  assert.equal(tokenRequestClientId(basic(`${CLIENT}:`), { client_id: 'someone-else' }), null);
  assert.equal(tokenRequestClientId(basic(CLIENT), {}), null);
  assert.equal(tokenRequestClientId(basic(':'), {}), null);
  assert.equal(tokenRequestClientId(basic('%E0%A4%A:'), {}), null);
  // A non-Basic Authorization header is not client authentication.
  assert.equal(tokenRequestClientId({ headers: { authorization: 'Bearer x' } }, { client_id: CLIENT }), CLIENT);
});

const clientRow = (extra = {}) => ({
  pk: S(`oauthclient#${CLIENT}`),
  sk: S('client'),
  client_id: S(CLIENT),
  client_name: S('AWS DevOps Agent'),
  redirect_uris: S('["https://example.com/callback"]'),
  created_at: N(now() - DAY),
  ttl: N(now() + 300 * DAY),
  ...extra
});

test('a Basic secret is answered 401 invalid_client; a Basic id reaches the grant', async () => {
  const table = fakeTable([clientRow()]);
  try {
    const withSecret = await handleToken({
      headers: {
        authorization: `Basic ${Buffer.from(`${CLIENT}:secret`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: `grant_type=refresh_token&refresh_token=${refreshToken}`
    });
    assert.equal(withSecret.statusCode, 401);
    assert.equal(JSON.parse(withSecret.body).error, 'invalid_client');
    assert.match(withSecret.headers['www-authenticate'], /^Basic /);
    const withId = await handleToken({
      headers: {
        authorization: `Basic ${Buffer.from(`${CLIENT}:`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: `grant_type=refresh_token&refresh_token=${refreshToken}`
    });
    // Past client authentication: the unknown token is the grant's problem.
    assert.equal(withId.statusCode, 400);
    assert.equal(JSON.parse(withId.body).error, 'invalid_grant');
  } finally {
    table.restore();
  }
});

test('the Buttondown re-check: active and premium verify, gone lapses, an error is an outage, the owner is exempt', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BUTTONDOWN_API_KEY;
  process.env.BUTTONDOWN_API_KEY = 'test-key';
  let calls = 0;
  const answer = (status, body) => {
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(body ? JSON.stringify(body) : '', { status });
    };
  };
  const membership = { subscriberHash: SUB, email: EMAIL, entitlements: ['reader'], verifiedAt: 0 };
  try {
    answer(200, { email_address: EMAIL, type: 'regular' });
    assert.deepEqual(await checkConnectionMembership(membership), { status: 'verified', entitlements: ['reader'] });
    answer(200, { email_address: EMAIL, type: 'premium' });
    const premium = await checkConnectionMembership(membership);
    assert.equal(premium.status, 'verified');
    assert.ok(premium.entitlements.includes('supporting_member'));
    answer(404);
    assert.deepEqual(await checkConnectionMembership(membership), { status: 'lapsed', subscriberStatus: 'not_found' });
    answer(500, { detail: 'down' });
    assert.deepEqual(await checkConnectionMembership(membership), { status: 'unavailable' });
    calls = 0;
    const owner = { ...membership, subscriberHash: sha256Hex('jamie@thingelstad.com'), entitlements: ['owner'] };
    assert.deepEqual(await checkConnectionMembership(owner), { status: 'verified', entitlements: ['owner'] });
    assert.equal(calls, 0, 'the owner is never sent to Buttondown');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.BUTTONDOWN_API_KEY;
    else process.env.BUTTONDOWN_API_KEY = originalKey;
  }
});

test('a client that no longer exists is refused 401 invalid_client before any grant (4.15.0)', async () => {
  const table = fakeTable([refreshRow(), familyRow()]);
  try {
    const response = await handleToken({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${refreshToken}&client_id=${CLIENT}`
    });
    assert.equal(response.statusCode, 401);
    assert.equal(JSON.parse(response.body).error, 'invalid_client');
    assert.match(JSON.parse(response.body).error_description, /Unknown client/);
    // The refresh token was never touched.
    assert.equal(table.rows.get(`oauthrefresh#${refreshHash}|refresh`).rotated_to, undefined);
  } finally {
    table.restore();
  }
});
