/**
 * Turnstile on the email-sending /auth actions (2026-10-14). Observe mode
 * records and never refuses; enforce refuses only a missing or failed
 * token, never our own outage; one token serves one address for five
 * minutes; the digest tells Jamie which firewall catches were people.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SITEVERIFY_URL,
  checkTurnstile,
  readTurnstileStats,
  statsDay,
  turnstileAllows,
  turnstileMode,
  turnstileModes,
  turnstileSiteForSource,
  turnstileTokenFrom
} from '../dist/shared/turnstile.mjs';
import { composeDigest, turnstileModeNote, turnstileSummary } from '../dist/shared/subscribe-digest.mjs';
import { subscriberStatus } from '../dist/shared/buttondown.mjs';

/** A DynamoDB stand-in holding items by pk/sk; enough for Get/Put/Update. */
function fakeDb() {
  const items = new Map();
  const key = (k) => `${k.pk.S}|${k.sk.S}`;
  return {
    items,
    async send(command) {
      const name = command.constructor.name;
      const input = command.input;
      if (name === 'GetItemCommand') return { Item: items.get(key(input.Key)) };
      if (name === 'PutItemCommand') {
        items.set(key(input.Item), { ...input.Item });
        return {};
      }
      if (name === 'UpdateItemCommand') {
        const item = items.get(key(input.Key)) || { ...input.Key };
        for (const [alias, attr] of Object.entries(input.ExpressionAttributeNames || {})) {
          if (!input.UpdateExpression.includes(`ADD ${alias}`)) continue;
          item[attr] = { N: String(Number(item[attr]?.N || '0') + 1) };
        }
        items.set(key(input.Key), item);
        return {};
      }
      throw new Error(`unexpected ${name}`);
    }
  };
}

function siteverifyAnswering(...answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: String(init.body) });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

async function withEnv(env, fn) {
  const saved = {};
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const event = { native: true, headers: { 'cloudfront-viewer-address': '203.0.113.9:443' } };
const ENV = { TABLE_NAME: 'test-table', TURNSTILE_SECRET_KEY: 'test-secret', TURNSTILE_MODE: undefined };

test('the token is read from the JSON field or the widget-posted form field', () => {
  assert.equal(turnstileTokenFrom({ turnstile_token: ' abc ' }), 'abc');
  assert.equal(turnstileTokenFrom({ 'cf-turnstile-response': 'xyz' }), 'xyz');
  assert.equal(turnstileTokenFrom({}), '');
  assert.equal(turnstileTokenFrom({ turnstile_token: 'a'.repeat(3000) }).length, 2048);
});

test('enforce refuses only a missing or failed token; observe never refuses', () => {
  for (const result of ['pass', 'fail', 'missing', 'error', 'unconfigured']) {
    assert.equal(turnstileAllows('observe', result), true, result);
  }
  assert.equal(turnstileAllows('enforce', 'pass'), true);
  assert.equal(turnstileAllows('enforce', 'fail'), false);
  assert.equal(turnstileAllows('enforce', 'missing'), false);
  // Our outage or our missing key never locks a reader out.
  assert.equal(turnstileAllows('enforce', 'error'), true);
  assert.equal(turnstileAllows('enforce', 'unconfigured'), true);
});

test('observe mode is the default and lets a missing token through, counted', async () => {
  const db = fakeDb();
  await withEnv(ENV, async () => {
    const verdict = await checkTurnstile({ token: '', event, emailHash: 'h1', surface: 'subscribe' }, { db });
    assert.equal(verdict.mode, 'observe');
    assert.equal(verdict.result, 'missing');
    assert.equal(verdict.allowed, true);
    const stats = await readTurnstileStats(statsDay(), db);
    assert.equal(stats.subscribe.missing, 1);
  });
});

// 2026-10-20: the Weekly Thing website enforces; Thingy sign-in and the MCP
// email step keep observing until Jamie says otherwise.
test('the mode is per site: the weekly site enforces by default, the others observe', async () => {
  const SITE_ENV = {
    TURNSTILE_MODE: undefined,
    TURNSTILE_MODE_WEEKLY: undefined,
    TURNSTILE_MODE_THINGY: undefined,
    TURNSTILE_MODE_MCP: undefined
  };
  await withEnv(SITE_ENV, async () => {
    assert.equal(turnstileMode(), 'observe', 'no site: the global default');
    assert.equal(turnstileMode('weekly'), 'enforce');
    assert.equal(turnstileMode('thingy'), 'observe');
    assert.equal(turnstileMode('mcp'), 'observe');
    assert.deepEqual(turnstileModes(), { weekly: 'enforce', thingy: 'observe', mcp: 'observe' });
  });
  // The stack's parameter turns the weekly site back to observe.
  await withEnv({ ...SITE_ENV, TURNSTILE_MODE_WEEKLY: 'observe' }, async () => {
    assert.equal(turnstileMode('weekly'), 'observe');
    assert.equal(turnstileMode('thingy'), 'observe');
  });
  // A global setting covers every site that has no override of its own.
  await withEnv({ ...SITE_ENV, TURNSTILE_MODE: 'enforce', TURNSTILE_MODE_MCP: 'off' }, async () => {
    assert.equal(turnstileMode('weekly'), 'enforce');
    assert.equal(turnstileMode('thingy'), 'enforce');
    assert.equal(turnstileMode('mcp'), 'off');
  });
  await withEnv({ ...SITE_ENV, TURNSTILE_MODE_WEEKLY: 'nonsense' }, async () => {
    assert.equal(turnstileMode('weekly'), 'enforce', 'an unknown value is ignored');
  });
  // Only Thingy says so in `source`; every weekly form source is the weekly site.
  assert.equal(turnstileSiteForSource('thingy'), 'thingy');
  for (const source of ['site', 'hero', 'footer', 'issue', 'about', 'mid1']) {
    assert.equal(turnstileSiteForSource(source), 'weekly');
  }
});

test('a missing token is refused on the weekly site and let through on Thingy sign-in', async () => {
  const db = fakeDb();
  await withEnv({ ...ENV, TURNSTILE_MODE_WEEKLY: undefined, TURNSTILE_MODE_THINGY: undefined }, async () => {
    const weekly = await checkTurnstile(
      { token: '', event, emailHash: 'h1', surface: 'subscribe', site: 'weekly' },
      { db }
    );
    assert.equal(weekly.mode, 'enforce');
    assert.equal(weekly.site, 'weekly');
    assert.equal(weekly.result, 'missing');
    assert.equal(weekly.allowed, false);

    const thingy = await checkTurnstile(
      { token: '', event, emailHash: 'h1', surface: 'check', site: 'thingy' },
      { db }
    );
    assert.equal(thingy.mode, 'observe');
    assert.equal(thingy.result, 'missing');
    assert.equal(thingy.allowed, true);

    const mcp = await checkTurnstile({ token: '', event, emailHash: 'h1', surface: 'mcp_signin', site: 'mcp' }, { db });
    assert.equal(mcp.mode, 'observe');
    assert.equal(mcp.allowed, true);
  });
});

test('the digest names each site’s mode', () => {
  assert.equal(
    turnstileModeNote({ weekly: 'enforce', thingy: 'observe', mcp: 'observe' }),
    'enforcing on the weekly site; observing Thingy sign-in and MCP sign-in (nobody refused)'
  );
  assert.equal(
    turnstileModeNote({ weekly: 'enforce', thingy: 'enforce', mcp: 'enforce' }),
    'enforcing on the weekly site, Thingy sign-in and MCP sign-in'
  );
  assert.equal(
    turnstileModeNote({ weekly: 'observe', thingy: 'off', mcp: 'observe' }),
    'observing the weekly site and MCP sign-in (nobody refused); off for Thingy sign-in'
  );
});

test('enforce mode refuses a failed token and sends the visitor IP to Cloudflare', async () => {
  const db = fakeDb();
  const { calls, fetchImpl } = siteverifyAnswering({ success: false, 'error-codes': ['invalid-input-response'] });
  await withEnv({ ...ENV, TURNSTILE_MODE: 'enforce' }, async () => {
    const verdict = await checkTurnstile({ token: 'bad', event, emailHash: 'h1', surface: 'check' }, { db, fetchImpl });
    assert.equal(verdict.result, 'fail');
    assert.equal(verdict.allowed, false);
    assert.deepEqual(verdict.codes, ['invalid-input-response']);
  });
  assert.equal(calls[0].url, SITEVERIFY_URL);
  assert.match(calls[0].body, /secret=test-secret/);
  assert.match(calls[0].body, /response=bad/);
  assert.match(calls[0].body, /remoteip=203.0.113.9/);
});

test('Cloudflare unreachable, a rejected secret, or no secret is our fault and never refuses', async () => {
  await withEnv({ ...ENV, TURNSTILE_MODE: 'enforce' }, async () => {
    const down = siteverifyAnswering(new Error('timeout'));
    const a = await checkTurnstile(
      { token: 't', event, emailHash: 'h', surface: 'subscribe' },
      { db: fakeDb(), fetchImpl: down.fetchImpl }
    );
    assert.equal(a.result, 'error');
    assert.equal(a.allowed, true);

    const badSecret = siteverifyAnswering({ success: false, 'error-codes': ['invalid-input-secret'] });
    const b = await checkTurnstile(
      { token: 't', event, emailHash: 'h', surface: 'subscribe' },
      { db: fakeDb(), fetchImpl: badSecret.fetchImpl }
    );
    assert.equal(b.result, 'error');
    assert.equal(b.allowed, true);
  });
  await withEnv({ ...ENV, TURNSTILE_MODE: 'enforce', TURNSTILE_SECRET_KEY: undefined }, async () => {
    const c = await checkTurnstile({ token: 't', event, emailHash: 'h', surface: 'subscribe' }, { db: fakeDb() });
    assert.equal(c.result, 'unconfigured');
    assert.equal(c.allowed, true);
  });
});

test('one passed token serves the check and the subscribe for the same address, and no other', async () => {
  const db = fakeDb();
  const { calls, fetchImpl } = siteverifyAnswering({
    success: true,
    action: 'subscribe',
    hostname: 'weekly.thingelstad.com'
  });
  await withEnv({ ...ENV, TURNSTILE_MODE: 'enforce' }, async () => {
    const check = await checkTurnstile(
      { token: 'tok', event, emailHash: 'reader', surface: 'check' },
      { db, fetchImpl }
    );
    const subscribe = await checkTurnstile(
      { token: 'tok', event, emailHash: 'reader', surface: 'subscribe' },
      { db, fetchImpl }
    );
    assert.equal(check.result, 'pass');
    assert.equal(subscribe.result, 'pass');
    assert.equal(subscribe.reused, true);
    assert.equal(calls.length, 1, 'Cloudflare is asked once; the token is single-use there');

    const other = await checkTurnstile(
      { token: 'tok', event, emailHash: 'victim', surface: 'subscribe' },
      { db, fetchImpl }
    );
    assert.equal(other.result, 'fail');
    assert.deepEqual(other.codes, ['token-other-address']);
    assert.equal(other.allowed, false);
  });
  // The cache row is keyed by a hash, never the token itself.
  assert.equal(
    [...db.items.keys()].some((k) => k.includes('tok|')),
    false
  );
});

test('a remembered token is used up after three requests and forgotten after five minutes', async () => {
  const { fetchImpl } = siteverifyAnswering(
    { success: true },
    { success: false, 'error-codes': ['timeout-or-duplicate'] }
  );
  await withEnv(ENV, async () => {
    const db = fakeDb();
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(
        (await checkTurnstile({ token: 'tok', event, emailHash: 'r', surface: 'resend' }, { db, fetchImpl })).result
      );
    }
    assert.deepEqual(results, ['pass', 'pass', 'pass', 'fail']);

    const later = fakeDb();
    const start = Date.parse('2026-10-14T14:00:00Z');
    await checkTurnstile(
      { token: 'old', event, emailHash: 'r', surface: 'check' },
      { db: later, fetchImpl, now: () => start }
    );
    const expired = await checkTurnstile(
      { token: 'old', event, emailHash: 'r', surface: 'subscribe' },
      { db: later, fetchImpl, now: () => start + 6 * 60_000 }
    );
    assert.equal(expired.reused, false, 'an old verdict is not trusted; Cloudflare is asked again');
    assert.equal(expired.result, 'fail');
  });
});

test('a Buttondown blocked record is not a reader', () => {
  assert.equal(subscriberStatus({ type: 'blocked' }), 'inactive');
  assert.equal(subscriberStatus({ type: 'regular' }), 'active');
});

const row = (over) => ({
  sk: '2026-10-13T16:10:50Z#abcd',
  at: '2026-10-13T16:10:50Z',
  email: 'reader@example.com',
  source: 'hero',
  outcome: 'subscribed',
  ...over
});

test('a firewalled address recorded as subscribed is not counted as a reader', () => {
  const mail = composeDigest(
    [row({ email: 'nickolad79@hotmail.com' }), row({ email: 'real@example.com', turnstile: 'pass' })],
    [{ email: 'nickolad79@hotmail.com', creation_date: '2026-10-13T16:10:51Z' }],
    new Date('2026-10-14T12:00:00Z')
  );
  assert.ok(mail);
  assert.match(mail.text, /1 subscribe attempt in the last day did not end with a reader on the list \(1 did\)/);
  assert.match(
    mail.text,
    /THROUGH OUR FORM[\s\S]*nickolad79@hotmail.com — Tue 11:10 AM, hero form\n  blocked subscriber — before Turnstile/
  );
  assert.doesNotMatch(mail.text, /STRAIGHT TO BUTTONDOWN/);
});

test('firewall catches name their Turnstile result, and a bot run is one line', () => {
  const run = Array.from({ length: 26 }, (_, i) => ({
    email: `bot${i}+d05425@hotmail.com`,
    creation_date: `2026-10-13T13:2${Math.min(4, Math.floor(i / 6))}:00Z`
  }));
  const mail = composeDigest(
    [
      row({ email: 'askiba@example.com', outcome: 'blocked', turnstile: 'pass' }),
      row({ email: 'askiba@example.com', outcome: 'blocked', turnstile: 'pass' }),
      row({ email: 'dotted.g.m.a.il@example.com', outcome: 'blocked', turnstile: 'fail' })
    ],
    [...run, { email: 'loner@example.com', creation_date: '2026-10-13T20:00:00Z' }],
    new Date('2026-10-14T12:00:00Z')
  );
  assert.ok(mail);
  assert.match(mail.text, /askiba@example.com — .*\n  blocked subscriber — passed Turnstile, so probably a person/);
  assert.equal(mail.text.match(/askiba@example.com/g).length, 1, 'a retried address is one line');
  assert.match(mail.text, /dotted.g.m.a.il@example.com[^\n]*\n  blocked subscriber — failed Turnstile/);
  assert.match(
    mail.text,
    /STRAIGHT TO BUTTONDOWN[\s\S]*- 26 addresses ending \+d05425@hotmail.com — Tue 8:20 AM to Tue 8:24 AM\n  one bot run/
  );
  assert.match(mail.text, /loner@example.com/);
  assert.doesNotMatch(mail.text, /bot7\+d05425/);
  // 2 through the form + 27 direct.
  assert.match(mail.text, /^29 subscribe attempts .* \(none did\)/);
});

test('observe mode lists what went ahead without passing, and the day’s tally', () => {
  const stats = { subscribe: { pass: 8, fail: 2, missing: 1 }, check: { pass: 12 }, mcp_signin: {} };
  const mail = composeDigest(
    [row({ email: 'sneaky@example.com', turnstile: 'missing' }), row({ email: 'fine@example.com', turnstile: 'pass' })],
    [],
    new Date('2026-10-14T12:00:00Z'),
    { stats, mode: 'observe' }
  );
  assert.ok(mail, 'an unverified subscribe alone is worth an email');
  assert.match(
    mail.text,
    /WENT AHEAD WITHOUT PASSING TURNSTILE[\s\S]*sneaky@example.com[^\n]*\n  subscribed — no Turnstile token/
  );
  assert.doesNotMatch(mail.text, /fine@example.com/);
  assert.match(
    mail.text,
    /Turnstile yesterday \(observing the weekly site, Thingy sign-in and MCP sign-in \(nobody refused\)\): subscribe 8 passed, 2 failed, 1 no token; address check \/ sign-in 12 passed\./
  );
  assert.equal(turnstileSummary({}, 'observe'), '');
  assert.match(
    turnstileSummary({ subscribe: { pass: 1 } }, { weekly: 'enforce', thingy: 'observe', mcp: 'observe' }),
    /^Turnstile yesterday \(enforcing on the weekly site; observing Thingy sign-in and MCP sign-in \(nobody refused\)\): subscribe 1 passed\.$/
  );
});

test('a clean day stays silent even with a Turnstile tally', () => {
  assert.equal(
    composeDigest([row({ turnstile: 'pass' })], [], new Date('2026-10-14T12:00:00Z'), {
      stats: { subscribe: { pass: 1 } }
    }),
    null
  );
});

test('refused attempts are listed, capped, so a real person refused can be found', () => {
  const refused = Array.from({ length: 12 }, (_, i) =>
    row({ email: `r${i}@example.com`, outcome: 'turnstile_refused', turnstile: 'fail' })
  );
  const mail = composeDigest(refused, [], new Date('2026-10-14T12:00:00Z'), { mode: 'enforce' });
  assert.ok(mail);
  assert.match(mail.text, /REFUSED BY TURNSTILE[\s\S]*r0@example.com[\s\S]*- and 2 more/);
  assert.doesNotMatch(mail.text, /r11@example.com/);
});
