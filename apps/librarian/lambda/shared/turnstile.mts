/**
 * Cloudflare Turnstile: is a person asking us to send this email?
 *
 * Every public `/auth` action that sends mail to a typed address (subscribe,
 * resend_confirmation, the sign-in `check`, and the MCP connector's email
 * step) carries a Turnstile token from the page. We ask Cloudflare whether
 * it is good before anything is written or sent.
 *
 * Subscription bombing is why (Jamie, 2026-10-14): bots type a victim's real
 * address into hundreds of forms so the victim's inbox fills with
 * confirmation mail. Double opt-in keeps them off the list, but we still
 * send the mail. Buttondown's firewall blocked real readers when it was
 * strict, so it now accepts-as-blocked and Jamie reviews; Turnstile is what
 * tells him which of those were people.
 *
 * Modes (`TURNSTILE_MODE`, default `observe`):
 * - `observe` checks and records every token and never refuses anyone.
 * - `enforce` refuses a missing or failed token. A Cloudflare outage or a
 *   missing secret still lets the request through: Buttondown's firewall
 *   and double opt-in are behind us, and a reader is never locked out by
 *   our own plumbing.
 * - `off` skips the check.
 *
 * The mode is per site (Jamie, 2026-10-20: enforce on the Weekly Thing
 * website first). `TURNSTILE_MODE_WEEKLY`, `TURNSTILE_MODE_THINGY` and
 * `TURNSTILE_MODE_MCP` each override `TURNSTILE_MODE` for the forms on
 * weekly.thingelstad.com (any `/auth` source but `thingy`), the Thingy
 * sign-in page, and the MCP connector's email step.
 *
 * One token serves one address for five minutes. The subscribe form checks
 * and then subscribes, and the sign-in page offers subscribe/resend after a
 * check; a Turnstile token is single-use at Cloudflare, so the verdict is
 * remembered (keyed by the token's hash, bound to the email's hash) and the
 * follow-up call reuses it. A token presented for a different address fails.
 */

import { GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { dynamodb } from './aws-clients.mjs';
import { clientSourceIp } from './http.mjs';
import type { LibrarianHttpEvent } from './http.mjs';
import { logEvent } from './logging.mjs';
import { stableHash } from './session.mjs';

/** Public: it is in every page that renders the widget. */
export const TURNSTILE_SITE_KEY = '0x4AAAAAAFWqGqZVkNAWfIQn';
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** The mode for a site with no override of its own. */
export const DEFAULT_TURNSTILE_MODE: TurnstileMode = 'observe';
/** The weekly site enforces unless the stack says otherwise (2026-10-20). */
export const DEFAULT_SITE_MODES: Readonly<Record<TurnstileSite, TurnstileMode | undefined>> = {
  weekly: 'enforce',
  thingy: undefined,
  mcp: undefined
};
export const TURNSTILE_SITES: readonly TurnstileSite[] = ['weekly', 'thingy', 'mcp'];

const TOKEN_VALID_SECONDS = 300;
const MAX_TOKEN_USES = 3;
const VERIFY_TIMEOUT_MS = 4000;
const STATS_PK = 'turnstile#stats';
const STATS_TTL_DAYS = 45;

export type TurnstileMode = 'off' | 'observe' | 'enforce';
/**
 * Where the request came from, which decides the mode: the Weekly Thing
 * website's forms, the Thingy sign-in page, or the MCP connector's email
 * step. A `/auth` call is `thingy` only when its `source` says so.
 */
export type TurnstileSite = 'weekly' | 'thingy' | 'mcp';
/** check: the address check that signs a reader in (or tells the form to subscribe). */
export type TurnstileSurface = 'subscribe' | 'resend' | 'check' | 'mcp_signin';
/**
 * pass / fail: Cloudflare's answer. missing: the page sent no token.
 * error: Cloudflare could not be asked. unconfigured: no secret key.
 */
export type TurnstileResult = 'pass' | 'fail' | 'missing' | 'error' | 'unconfigured' | 'off';

export interface TurnstileVerdict {
  result: TurnstileResult;
  mode: TurnstileMode;
  site: TurnstileSite;
  /** True when this request may go ahead. Always true outside enforce mode. */
  allowed: boolean;
  codes: string[];
  /** The verdict came from an earlier call with the same token. */
  reused: boolean;
}

type Db = Pick<typeof dynamodb, 'send'>;
interface Deps {
  db?: Db;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function parseMode(raw: unknown): TurnstileMode | undefined {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  return value === 'off' || value === 'observe' || value === 'enforce' ? value : undefined;
}

/**
 * The mode for one site: its own `TURNSTILE_MODE_<SITE>`, else
 * `TURNSTILE_MODE`, else the site's default. Without a site, the global
 * setting alone.
 */
export function turnstileMode(site?: TurnstileSite): TurnstileMode {
  const global = parseMode(process.env.TURNSTILE_MODE);
  if (!site) return global || DEFAULT_TURNSTILE_MODE;
  return (
    parseMode(process.env[`TURNSTILE_MODE_${site.toUpperCase()}`]) ||
    global ||
    DEFAULT_SITE_MODES[site] ||
    DEFAULT_TURNSTILE_MODE
  );
}

/** Every site's mode, for the digest's note. */
export function turnstileModes(): Record<TurnstileSite, TurnstileMode> {
  return { weekly: turnstileMode('weekly'), thingy: turnstileMode('thingy'), mcp: turnstileMode('mcp') };
}

/**
 * The site behind a `/auth` call: Thingy says so in `source`; the rest is the
 * weekly website. Release Notes (notes.yourversionnumber.com, 2026-10-25)
 * asks from its server for an address it has already proved with an emailed
 * code, so there is no widget and no token: it is checked as Thingy is
 * (Jamie: "Can't you do this the same way Thingy does?").
 */
export function turnstileSiteForSource(source: string): TurnstileSite {
  return source === 'thingy' || source === 'release-notes' ? 'thingy' : 'weekly';
}

export function turnstileSiteKey() {
  return String(process.env.TURNSTILE_SITE_KEY || '').trim() || TURNSTILE_SITE_KEY;
}

/** Enforce refuses only a token that is absent or that Cloudflare rejected. */
export function turnstileAllows(mode: TurnstileMode, result: TurnstileResult) {
  if (mode !== 'enforce') return true;
  return result !== 'fail' && result !== 'missing';
}

/** The token from a JSON body (`turnstile_token`) or a widget-posted form (`cf-turnstile-response`). */
export function turnstileTokenFrom(body: Record<string, unknown> | null | undefined) {
  const raw = body?.turnstile_token ?? body?.['cf-turnstile-response'] ?? '';
  // Cloudflare documents a 2048-character maximum.
  return String(raw || '')
    .trim()
    .slice(0, 2048);
}

/** The day a check counts toward, in Central time (the digest's day). */
export function statsDay(at = Date.now()) {
  return new Date(at).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function tableName() {
  return process.env.TABLE_NAME || '';
}

const S = (value: unknown): AttributeValue => ({ S: String(value ?? '') });
const N = (value: number): AttributeValue => ({ N: String(value) });

function cacheKey(token: string) {
  return { pk: S(`turnstile#${stableHash(token)}`), sk: S('verdict') };
}

async function readCached(db: Db, token: string, nowMs: number) {
  const table = tableName();
  if (!table) return null;
  try {
    const response = await db.send(new GetItemCommand({ TableName: table, Key: cacheKey(token) }));
    const item = response.Item;
    if (!item) return null;
    const verifiedAt = Number(item.verified_at?.N || '0');
    if (nowMs / 1000 - verifiedAt > TOKEN_VALID_SECONDS) return null;
    return {
      result: (item.result?.S || 'fail') as 'pass' | 'fail',
      emailHash: item.email_hash?.S || '',
      uses: Number(item.uses?.N || '0'),
      codes: (item.codes?.S || '').split(',').filter(Boolean)
    };
  } catch (error) {
    logEvent('warning', 'turnstile_cache_read_failed', { error_type: (error as Error)?.name || 'Error' });
    return null;
  }
}

async function writeCached(
  db: Db,
  token: string,
  nowMs: number,
  verdict: { result: 'pass' | 'fail'; emailHash: string; codes: string[] }
) {
  const table = tableName();
  if (!table) return;
  const seconds = Math.floor(nowMs / 1000);
  try {
    await db.send(
      new PutItemCommand({
        TableName: table,
        Item: {
          ...cacheKey(token),
          result: S(verdict.result),
          email_hash: S(verdict.emailHash),
          codes: S(verdict.codes.join(',')),
          uses: N(1),
          verified_at: N(seconds),
          ttl: N(seconds + TOKEN_VALID_SECONDS * 2)
        }
      })
    );
  } catch (error) {
    logEvent('warning', 'turnstile_cache_write_failed', { error_type: (error as Error)?.name || 'Error' });
  }
}

async function bumpUses(db: Db, token: string) {
  const table = tableName();
  if (!table) return;
  try {
    await db.send(
      new UpdateItemCommand({
        TableName: table,
        Key: cacheKey(token),
        UpdateExpression: 'ADD #u :one',
        ExpressionAttributeNames: { '#u': 'uses' },
        ExpressionAttributeValues: { ':one': N(1) }
      })
    );
  } catch (error) {
    logEvent('warning', 'turnstile_cache_update_failed', { error_type: (error as Error)?.name || 'Error' });
  }
}

/** Count the check toward today's tally for the digest. Never throws. */
async function bumpStats(db: Db, surface: TurnstileSurface, result: TurnstileResult, nowMs: number) {
  const table = tableName();
  if (!table) return;
  try {
    await db.send(
      new UpdateItemCommand({
        TableName: table,
        Key: { pk: S(STATS_PK), sk: S(statsDay(nowMs)) },
        UpdateExpression: 'ADD #k :one SET #ttl = :ttl',
        ExpressionAttributeNames: { '#k': `${surface}_${result}`, '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': N(1),
          ':ttl': N(Math.floor(nowMs / 1000) + STATS_TTL_DAYS * 86_400)
        }
      })
    );
  } catch (error) {
    logEvent('warning', 'turnstile_stats_failed', { error_type: (error as Error)?.name || 'Error' });
  }
}

/** One day's tally: `{ subscribe: { pass: 3, fail: 1 }, ... }`. */
export async function readTurnstileStats(day: string, db: Db = dynamodb) {
  const table = tableName();
  const out: Partial<Record<TurnstileSurface, Partial<Record<TurnstileResult, number>>>> = {};
  if (!table) return out;
  const response = await db.send(new GetItemCommand({ TableName: table, Key: { pk: S(STATS_PK), sk: S(day) } }));
  for (const [name, value] of Object.entries(response.Item || {})) {
    const match = /^(subscribe|resend|check|mcp_signin)_([a-z]+)$/.exec(name);
    if (!match || !value.N) continue;
    const surface = match[1] as TurnstileSurface;
    (out[surface] ||= {})[match[2] as TurnstileResult] = Number(value.N);
  }
  return out;
}

async function siteverify(
  fetchImpl: typeof fetch,
  secret: string,
  token: string,
  ip: string
): Promise<{ result: 'pass' | 'fail' | 'error'; codes: string[]; action?: string; hostname?: string }> {
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set('remoteip', ip);
  try {
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
    });
    if (!response.ok) return { result: 'error', codes: [`http_${response.status}`] };
    const data = (await response.json()) as {
      success?: boolean;
      'error-codes'?: unknown;
      action?: string;
      hostname?: string;
    };
    const codes = Array.isArray(data['error-codes']) ? data['error-codes'].map(String).slice(0, 5) : [];
    // A bad secret is our fault, not the visitor's.
    if (!data.success && codes.some((code) => code.includes('secret'))) return { result: 'error', codes };
    return { result: data.success ? 'pass' : 'fail', codes, action: data.action, hostname: data.hostname };
  } catch (error) {
    return { result: 'error', codes: [(error as Error)?.name || 'Error'] };
  }
}

/**
 * Check the token for one email-sending request. Never throws; the verdict
 * says whether to go ahead (`allowed`) and what to record (`result`).
 */
export async function checkTurnstile(
  input: {
    token: string;
    event: LibrarianHttpEvent;
    emailHash: string;
    surface: TurnstileSurface;
    site: TurnstileSite;
  },
  deps: Deps = {}
): Promise<TurnstileVerdict> {
  const db = deps.db || dynamodb;
  const fetchImpl = deps.fetchImpl || fetch;
  const nowMs = (deps.now || Date.now)();
  const site = input.site;
  const mode = turnstileMode(site);
  const done = async (result: TurnstileResult, codes: string[] = [], reused = false, extra = {}) => {
    const verdict = { result, mode, site, allowed: turnstileAllows(mode, result), codes, reused };
    if (mode !== 'off') await bumpStats(db, input.surface, result, nowMs);
    logEvent(result === 'error' || result === 'unconfigured' ? 'warning' : 'info', 'turnstile_checked', {
      surface: input.surface,
      site,
      result,
      mode,
      allowed: verdict.allowed,
      reused,
      codes,
      email_hash: input.emailHash,
      ...extra
    });
    return verdict;
  };

  if (mode === 'off') return { result: 'off', mode, site, allowed: true, codes: [], reused: false };
  const token = String(input.token || '');
  if (!token) return done('missing');
  const secret = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
  if (!secret) return done('unconfigured');

  const cached = await readCached(db, token, nowMs);
  if (cached) {
    if (cached.emailHash && input.emailHash && cached.emailHash !== input.emailHash) {
      return done('fail', ['token-other-address'], true);
    }
    if (cached.uses >= MAX_TOKEN_USES) return done('fail', ['token-used-up'], true);
    await bumpUses(db, token);
    return done(cached.result, cached.codes, true);
  }

  const answer = await siteverify(fetchImpl, secret, token, clientSourceIp(input.event));
  if (answer.result !== 'error') {
    await writeCached(db, token, nowMs, { result: answer.result, emailHash: input.emailHash, codes: answer.codes });
  }
  return done(answer.result, answer.codes, false, { action: answer.action, hostname: answer.hostname });
}
