/**
 * The daily subscribe digest.
 *
 * Once a day, at 07:00 Central, Jamie gets one email listing every
 * subscribe attempt of the last day that did not end with a reader on the
 * list — and nothing at all on a clean day. Each line is the address, the
 * form it came from, what Buttondown said, and (for the ones only a person
 * can fix) a link to add them by hand. Buttondown's firewall catches land
 * as `blocked` subscribers since the setting changed 2026-09-20; those are
 * listed too, so a real person caught in the net is one click from in.
 *
 * Jamie, 2026-09-20: "I don't even know there is an error — they don't
 * email me." Now he does.
 *
 * Since 2026-10-14 the firewall catches are split in two. Those that came
 * through our form carry their Turnstile result, which is what says whether
 * a person typed them; those that never touched our form went straight to
 * Buttondown and are bots. A bot run that varies one address
 * (`…+d05425@hotmail.com` twenty-six times in four minutes) is one line.
 * Buttondown answers a firewalled create with 2xx, so a ledger row that says
 * `subscribed` for an address on the blocked list is counted as blocked.
 */

import { listBlockedSince } from './buttondown.mjs';
import { sendJmapEmail } from './jmap-mail.mjs';
import { logEvent } from './logging.mjs';
import { NEEDS_JAMIE, TRANSIENT, listAttemptsSince, type LedgerRow } from './subscribe-ledger.mjs';
import { readTurnstileStats, statsDay, turnstileMode } from './turnstile.mjs';
import type { TurnstileMode, TurnstileResult, TurnstileSurface } from './turnstile.mjs';

export type TurnstileStats = Partial<Record<TurnstileSurface, Partial<Record<TurnstileResult, number>>>>;
/** Bot runs that vary one address collapse to one line from this many. */
const GROUP_MIN = 3;
const REFUSED_SHOWN = 10;

export const DIGEST_TO = 'jamie@thingelstad.com';
const BUTTONDOWN_SUBSCRIBERS = 'https://buttondown.com/subscribers';

const WORDS: Record<string, string> = {
  suppressed:
    'on the suppression list (bounced, complained, or blocked before) — add by hand or ask Buttondown support',
  resubscribe_unavailable: 'a disabled/undeliverable record — add by hand',
  lookup_failed: 'Buttondown lookup failed',
  create_failed: 'Buttondown refused or timed out',
  reminder_failed: 'confirmation reminder could not be sent',
  pending: 'no outcome recorded — the request died mid-way'
};

const TURNSTILE_WORDS: Record<string, string> = {
  pass: 'passed Turnstile, so probably a person',
  fail: 'failed Turnstile',
  missing: 'no Turnstile token',
  error: 'Turnstile could not be reached',
  unconfigured: 'Turnstile not set up yet'
};
const SURFACE_WORDS: Record<TurnstileSurface, string> = {
  subscribe: 'subscribe',
  resend: 'resend',
  check: 'address check / sign-in',
  mcp_signin: 'MCP sign-in'
};
const RESULT_WORDS: Record<string, string> = {
  pass: 'passed',
  fail: 'failed',
  missing: 'no token',
  error: 'unreachable',
  unconfigured: 'not set up'
};

function turnstileWords(result: string | undefined) {
  return result ? TURNSTILE_WORDS[result] || `Turnstile ${result}` : 'before Turnstile';
}

/** `name+tag@domain` → `+tag@domain`, the part a bot run keeps fixed. */
function plusSuffix(email: string) {
  const match = /^[^+@]+(\+[^@]+@.+)$/.exec(email);
  return match ? match[1] : '';
}

function when(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  });
}

/** One line per surface that saw traffic: `subscribe 8 passed, 2 failed`. */
export function turnstileSummary(stats: TurnstileStats, mode: TurnstileMode) {
  const parts = (Object.keys(SURFACE_WORDS) as TurnstileSurface[])
    .filter((surface) => stats[surface] && Object.values(stats[surface]!).some(Boolean))
    .map((surface) => {
      const counts = stats[surface]!;
      const tally = Object.keys(RESULT_WORDS)
        .filter((result) => counts[result as TurnstileResult])
        .map((result) => `${counts[result as TurnstileResult]} ${RESULT_WORDS[result]}`)
        .join(', ');
      return `${SURFACE_WORDS[surface]} ${tally}`;
    });
  if (!parts.length) return '';
  const note = mode === 'observe' ? ' (observe mode: nobody was refused)' : mode === 'enforce' ? ' (enforcing)' : '';
  return `Turnstile yesterday${note}: ${parts.join('; ')}.`;
}

/** The email as text and HTML, or null when there is nothing to say. */
export function composeDigest(
  attempts: LedgerRow[],
  blocked: { email: string; creation_date: string }[],
  now = new Date(),
  turnstile: { stats?: TurnstileStats; mode?: TurnstileMode } = {}
): { subject: string; text: string; html: string } | null {
  const blockedEmails = new Set(blocked.map((b) => b.email.toLowerCase()));
  const formEmails = new Set(attempts.map((a) => a.email.toLowerCase()));
  const isBlocked = (a: LedgerRow) => a.outcome === 'blocked' || blockedEmails.has(a.email.toLowerCase());

  const failed = attempts.filter((a) => NEEDS_JAMIE.has(a.outcome) || TRANSIENT.has(a.outcome));
  const needs = failed.filter((a) => NEEDS_JAMIE.has(a.outcome));
  const transient = failed.filter((a) => TRANSIENT.has(a.outcome));
  const refused = attempts.filter((a) => a.outcome === 'turnstile_refused');
  // One line per address: a retried address can have several rows.
  const formBlocked = [
    ...new Map(
      attempts
        .filter((a) => !failed.includes(a) && a.outcome !== 'turnstile_refused' && isBlocked(a))
        .map((a) => [a.email.toLowerCase(), a])
    ).values()
  ];
  const direct = blocked.filter((b) => !formEmails.has(b.email.toLowerCase()));
  const reached = attempts.filter((a) => !failed.includes(a) && a.outcome !== 'turnstile_refused' && !isBlocked(a));
  // Observe mode: these went ahead, and enforcement would have refused them.
  const unverified = reached.filter((a) => a.turnstile === 'fail' || a.turnstile === 'missing');

  if (
    !needs.length &&
    !transient.length &&
    !refused.length &&
    !formBlocked.length &&
    !direct.length &&
    !unverified.length
  ) {
    return null;
  }
  const day = now.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric' });

  const line = (a: LedgerRow, why?: string) => {
    const code = a.buttondown_code ? ` (${a.buttondown_code})` : '';
    const ref = a.campaign_ref ? `, ref ${a.campaign_ref}` : '';
    return {
      head: `${a.email} — ${when(a.at)}, ${a.source} form${ref}`,
      why: why || `${WORDS[a.outcome] || a.outcome}${code}`
    };
  };

  // Group the bot runs; everything else is one line each.
  const groups = new Map<string, { email: string; creation_date: string }[]>();
  for (const b of direct) {
    const suffix = plusSuffix(b.email.toLowerCase());
    if (suffix) groups.set(suffix, [...(groups.get(suffix) || []), b]);
  }
  const directRows: { head: string; why: string }[] = [];
  const grouped = new Set<string>();
  for (const [suffix, members] of groups) {
    if (members.length < GROUP_MIN) continue;
    const times = members.map((m) => m.creation_date).sort();
    directRows.push({
      head: `${members.length} addresses ending ${suffix} — ${when(times[0])} to ${when(times[times.length - 1])}`,
      why: `one bot run, e.g. ${members[0].email}`
    });
    for (const m of members) grouped.add(m.email);
  }
  for (const b of direct) {
    if (!grouped.has(b.email))
      directRows.push({ head: `${b.email} — ${when(b.creation_date)}`, why: 'blocked subscriber' });
  }

  const sections: { title: string; rows: { head: string; why: string }[] }[] = [];
  if (needs.length) sections.push({ title: 'Need you', rows: needs.map((a) => line(a)) });
  if (formBlocked.length) {
    sections.push({
      title: 'Caught by the firewall, through our form (unblock in Buttondown if real)',
      rows: formBlocked.map((a) => line(a, `blocked subscriber — ${turnstileWords(a.turnstile)}`))
    });
  }
  if (directRows.length) {
    sections.push({
      title: 'Caught by the firewall, straight to Buttondown (never touched our form, so bots)',
      rows: directRows
    });
  }
  if (unverified.length) {
    sections.push({
      title: 'Went ahead without passing Turnstile (enforcement would refuse these)',
      rows: unverified.map((a) =>
        line(a, `${WORDS[a.outcome] || a.outcome.replace(/_/g, ' ')} — ${turnstileWords(a.turnstile)}`)
      )
    });
  }
  if (refused.length) {
    const shown = refused.slice(0, REFUSED_SHOWN).map((a) => line(a, 'refused: failed Turnstile'));
    if (refused.length > REFUSED_SHOWN) {
      shown.push({ head: `and ${refused.length - REFUSED_SHOWN} more`, why: 'refused: failed Turnstile' });
    }
    sections.push({ title: 'Refused by Turnstile (a real person here emailed you, or will)', rows: shown });
  }
  if (transient.length)
    sections.push({ title: 'Failed on our side (may have retried)', rows: transient.map((a) => line(a)) });

  const directCount = direct.length;
  const count = needs.length + formBlocked.length + directCount + transient.length + refused.length;
  const subject = `Weekly Thing subscribe: ${count + unverified.length} to look at — ${day}`;
  const reachedNote = reached.length ? ` (${reached.length} did)` : ' (none did)';
  const intro = `${count} subscribe ${count === 1 ? 'attempt' : 'attempts'} in the last day did not end with a reader on the list${reachedNote}.`;
  const summary = turnstileSummary(turnstile.stats || {}, turnstile.mode || 'observe');

  const text = [
    intro,
    '',
    ...sections.flatMap((s) => [s.title.toUpperCase(), ...s.rows.flatMap((r) => [`- ${r.head}`, `  ${r.why}`]), '']),
    ...(summary ? [summary, ''] : []),
    `Add by hand: ${BUTTONDOWN_SUBSCRIBERS}`,
    '',
    '— The Librarian'
  ].join('\n');

  const esc = (v: string) => v.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const html = [
    `<p>${esc(intro)}</p>`,
    ...sections.map(
      (s) =>
        `<h3 style="font-size:14px;margin:18px 0 6px">${esc(s.title)}</h3><ul style="padding-left:18px;margin:0">${s.rows
          .map(
            (r) =>
              `<li style="margin:0 0 8px"><strong>${esc(r.head)}</strong><br><span style="color:#555">${esc(r.why)}</span></li>`
          )
          .join('')}</ul>`
    ),
    ...(summary ? [`<p style="margin-top:18px;color:#555">${esc(summary)}</p>`] : []),
    `<p style="margin-top:18px"><a href="${BUTTONDOWN_SUBSCRIBERS}">Add by hand in Buttondown</a></p>`,
    '<p style="color:#888">— The Librarian</p>'
  ].join('\n');

  return { subject, text, html };
}

/** Gather the last day, compose, send if there is anything. Returns what happened. */
export async function runSubscribeDigest(now = new Date()) {
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const attempts = await listAttemptsSince(since);
  let blocked: { email: string; creation_date: string }[] = [];
  try {
    blocked = await listBlockedSince(since);
  } catch (error) {
    logEvent('error', 'subscribe_digest_blocked_list_failed', { error_type: (error as Error)?.name || 'Error' });
  }
  let stats: TurnstileStats = {};
  try {
    // The digest runs at 07:00 Central, so yesterday is a whole Central day.
    stats = await readTurnstileStats(statsDay(now.getTime() - 24 * 3_600_000));
  } catch (error) {
    logEvent('error', 'subscribe_digest_turnstile_stats_failed', { error_type: (error as Error)?.name || 'Error' });
  }
  const mail = composeDigest(attempts, blocked, now, { stats, mode: turnstileMode() });
  if (!mail) {
    logEvent('info', 'subscribe_digest_quiet', { attempts: attempts.length });
    return { sent: false, attempts: attempts.length, blocked: 0 };
  }
  await sendJmapEmail({ to: DIGEST_TO, subject: mail.subject, text: mail.text, html: mail.html });
  logEvent('info', 'subscribe_digest_sent', { attempts: attempts.length, blocked: blocked.length });
  return { sent: true, attempts: attempts.length, blocked: blocked.length };
}
