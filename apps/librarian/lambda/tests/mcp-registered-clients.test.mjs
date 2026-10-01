// Apps a reader sets up by hand (contract 4.15.0): Thingy registers a public
// client bound to the reader for an app that asks for a client ID (AWS
// DevOps Agent's 3LO form, for one), lists it with the values the app's form
// needs, refuses anyone else at sign-in, and deleting it disconnects its
// connections before the client goes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { dynamodb } from '../dist/shared/aws-clients.mjs';
import {
  MAX_READER_CLIENTS,
  deleteAllReaderClients,
  deleteReaderClient,
  listReaderClients,
  mcpClientSettings,
  registerReaderClient
} from '../dist/shared/mcp-registered-clients.mjs';
import { clientOwnerRefusal } from '../dist/auth/oauth-routes.mjs';

process.env.TABLE_NAME = 'test-table';

const SUB = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const CALLBACK = 'https://api.prod.cp.aidevops.us-east-1.api.aws/v1/register/mcpserver/callback';
const S = (value) => ({ S: String(value) });
const N = (value) => ({ N: String(value) });
const now = () => Math.floor(Date.now() / 1000);

// Get/Put/Delete by key, Query by pk + begins_with; the rate-limit counter
// answers with the count given.
function fakeTable(seed = [], { rateCount = 1 } = {}) {
  const rows = new Map(seed.map((item) => [`${item.pk.S}|${item.sk.S}`, item]));
  const original = dynamodb.send;
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
      rows.set(`${input.Item.pk.S}|${input.Item.sk.S}`, input.Item);
      return {};
    }
    if (name === 'UpdateItemCommand') {
      return input.Key.pk.S.startsWith('rate#') ? { Attributes: { count: N(rateCount) } } : {};
    }
    if (name === 'QueryCommand') {
      const pk = input.ExpressionAttributeValues[':pk'].S;
      const prefix = input.ExpressionAttributeValues[':prefix']?.S;
      return { Items: [...rows.values()].filter((item) => item.pk.S === pk && item.sk.S.startsWith(prefix)) };
    }
    throw new Error(`unexpected ${name}`);
  };
  return { rows, restore: () => (dynamodb.send = original) };
}

const clientRow = (id, owner, extra = {}) => ({
  pk: S(`oauthclient#${id}`),
  sk: S('client'),
  client_id: S(id),
  client_name: S('AWS DevOps Agent'),
  redirect_uris: S(JSON.stringify([CALLBACK])),
  created_at: N(now() - 60),
  ...(owner ? { owner_hash: S(owner) } : {}),
  ttl: N(now() + 300 * 86400),
  ...extra
});
const panelRow = (sub, id) => ({
  pk: S(`user#${sub}`),
  sk: S(`mcpclient#${id}`),
  item_type: S('mcp_registered_client'),
  client_id: S(id),
  created_at: N(now() - 60)
});
const connectionRow = (sub, family, clientId) => ({
  pk: S(`user#${sub}`),
  sk: S(`mcpconn#${family}`),
  family_id: S(family),
  client_id: S(clientId),
  client_name: S('AWS DevOps Agent'),
  connected_at: N(now() - 30),
  last_authorized_at: N(now() - 30)
});
const familyRow = (family) => ({ pk: S(`oauthfamily#${family}`), sk: S('family'), member_hashes: { L: [] } });

const CLIENT = 'ReaderClientIdForTestsAb';
const FAMILY = 'Fam1lyIdForTheTestAbCdE';

test('registering binds a public client to the reader and returns the form values', async () => {
  const table = fakeTable();
  try {
    const result = await registerReaderClient(SUB, { clientName: '  DevOps  Agent ', redirectUri: CALLBACK });
    assert.equal(result.ok, true);
    const { client } = result;
    assert.equal(client.client_name, 'DevOps Agent');
    assert.equal(client.redirect_uri, CALLBACK);
    assert.equal(client.connection_count, 0);
    assert.deepEqual(client.settings, {
      client_id: client.client_id,
      client_secret: '',
      authorization_url: 'https://librarian.thingelstad.com/authorize',
      token_url: 'https://librarian.thingelstad.com/token',
      mcp_url: 'https://librarian.thingelstad.com/mcp',
      scope: 'archive:read',
      pkce: true
    });
    const stored = table.rows.get(`oauthclient#${client.client_id}|client`);
    assert.equal(stored.owner_hash.S, SUB);
    assert.deepEqual(JSON.parse(stored.redirect_uris.S), [CALLBACK]);
    assert.ok(table.rows.get(`user#${SUB}|mcpclient#${client.client_id}`), 'listed in the reader partition');
    const listed = await listReaderClients(SUB);
    assert.deepEqual(
      listed.map((entry) => entry.client_id),
      [client.client_id]
    );
  } finally {
    table.restore();
  }
});

test('a bad name or callback, the per-reader cap and the hourly limit are refused', async () => {
  let table = fakeTable();
  try {
    assert.deepEqual(await registerReaderClient(SUB, { clientName: ' ', redirectUri: CALLBACK }), {
      ok: false,
      reason: 'invalid_name'
    });
    for (const uri of ['http://example.com/cb', 'https://example.com/cb#frag', 'not a url', '']) {
      assert.deepEqual(await registerReaderClient(SUB, { clientName: 'App', redirectUri: uri }), {
        ok: false,
        reason: 'invalid_redirect_uri'
      });
    }
  } finally {
    table.restore();
  }
  const seed = [];
  for (let i = 0; i < MAX_READER_CLIENTS; i += 1) {
    const id = `ReaderClientNumber${String(i).padStart(6, '0')}`;
    seed.push(clientRow(id, SUB), panelRow(SUB, id));
  }
  table = fakeTable(seed);
  try {
    assert.deepEqual(await registerReaderClient(SUB, { clientName: 'App', redirectUri: CALLBACK }), {
      ok: false,
      reason: 'too_many'
    });
  } finally {
    table.restore();
  }
  table = fakeTable([], { rateCount: 11 });
  try {
    assert.deepEqual(await registerReaderClient(SUB, { clientName: 'App', redirectUri: CALLBACK }), {
      ok: false,
      reason: 'rate_limited'
    });
  } finally {
    table.restore();
  }
});

test('the list counts live connections and drops a client whose row has lapsed', async () => {
  const LAPSED = 'LapsedClientIdForTestsAb';
  const table = fakeTable([
    clientRow(CLIENT, SUB),
    panelRow(SUB, CLIENT),
    connectionRow(SUB, FAMILY, CLIENT),
    familyRow(FAMILY),
    clientRow(LAPSED, SUB, { ttl: N(now() - 10) }),
    panelRow(SUB, LAPSED)
  ]);
  try {
    const listed = await listReaderClients(SUB);
    assert.deepEqual(
      listed.map((entry) => [entry.client_id, entry.connection_count]),
      [[CLIENT, 1]]
    );
    assert.equal(table.rows.has(`user#${SUB}|mcpclient#${LAPSED}`), false, 'the lapsed panel row is cleaned up');
  } finally {
    table.restore();
  }
});

test('deleting an app disconnects its connections, then deletes the client and the panel row', async () => {
  const table = fakeTable([
    clientRow(CLIENT, SUB),
    panelRow(SUB, CLIENT),
    connectionRow(SUB, FAMILY, CLIENT),
    familyRow(FAMILY)
  ]);
  try {
    assert.deepEqual(await deleteReaderClient(SUB, CLIENT), { ok: true });
    assert.equal(table.rows.has(`oauthfamily#${FAMILY}|family`), false, 'the connection is revoked');
    assert.equal(table.rows.has(`user#${SUB}|mcpconn#${FAMILY}`), false);
    assert.equal(table.rows.has(`oauthclient#${CLIENT}|client`), false);
    assert.equal(table.rows.has(`user#${SUB}|mcpclient#${CLIENT}`), false);
    assert.deepEqual(await deleteReaderClient(SUB, CLIENT), { ok: false, reason: 'not_found' });
    assert.deepEqual(await deleteReaderClient(SUB, 'bad id'), { ok: false, reason: 'invalid' });
  } finally {
    table.restore();
  }
});

test("a reader cannot delete or list another reader's app", async () => {
  const table = fakeTable([clientRow(CLIENT, OTHER), panelRow(OTHER, CLIENT)]);
  try {
    assert.deepEqual(await deleteReaderClient(SUB, CLIENT), { ok: false, reason: 'not_found' });
    assert.deepEqual(await listReaderClients(SUB), []);
    assert.ok(table.rows.has(`oauthclient#${CLIENT}|client`), 'the owner keeps it');
  } finally {
    table.restore();
  }
});

test('profile deletion deletes the reader-owned clients only', async () => {
  const ANON = 'AnonymousClientIdTestsAb';
  const table = fakeTable([clientRow(CLIENT, SUB), panelRow(SUB, CLIENT), clientRow(ANON, ''), panelRow(SUB, ANON)]);
  try {
    await deleteAllReaderClients(SUB);
    assert.equal(table.rows.has(`oauthclient#${CLIENT}|client`), false);
    assert.ok(table.rows.has(`oauthclient#${ANON}|client`), 'a /register client is not the reader’s to delete');
  } finally {
    table.restore();
  }
});

test('an owned client authorizes its owner only; a /register client anyone', () => {
  const owned = { clientId: CLIENT, clientName: 'App', redirectUris: [CALLBACK], ownerHash: SUB };
  assert.equal(clientOwnerRefusal(owned, SUB), null);
  const refusal = clientOwnerRefusal(owned, OTHER);
  assert.equal(refusal.statusCode, 403);
  assert.match(refusal.body, /another account/);
  assert.equal(clientOwnerRefusal({ ...owned, ownerHash: '' }, OTHER), null);
});

test('the settings follow the configured issuer', () => {
  const saved = process.env.LIBRARIAN_OAUTH_ISSUER;
  process.env.LIBRARIAN_OAUTH_ISSUER = 'https://example.test/';
  try {
    const settings = mcpClientSettings(CLIENT);
    assert.equal(settings.authorization_url, 'https://example.test/authorize');
    assert.equal(settings.mcp_url, 'https://example.test/mcp');
  } finally {
    if (saved === undefined) delete process.env.LIBRARIAN_OAUTH_ISSUER;
    else process.env.LIBRARIAN_OAUTH_ISSUER = saved;
  }
});
