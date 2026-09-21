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
 */

import { listBlockedSince } from './buttondown.mjs';
import { sendJmapEmail } from './jmap-mail.mjs';
import { logEvent } from './logging.mjs';
import { NEEDS_JAMIE, TRANSIENT, listAttemptsSince, type LedgerRow } from './subscribe-ledger.mjs';

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

function when(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  });
}

/** The email as text and HTML, or null when there is nothing to say. */
export function composeDigest(
  attempts: LedgerRow[],
  blocked: { email: string; creation_date: string }[],
  now = new Date()
): { subject: string; text: string; html: string } | null {
  const failed = attempts.filter((a) => NEEDS_JAMIE.has(a.outcome) || TRANSIENT.has(a.outcome));
  if (!failed.length && !blocked.length) return null;

  const needs = failed.filter((a) => NEEDS_JAMIE.has(a.outcome));
  const transient = failed.filter((a) => TRANSIENT.has(a.outcome));
  const worked = attempts.length - failed.length;
  const day = now.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric' });

  const line = (a: LedgerRow) => {
    const why = WORDS[a.outcome] || a.outcome;
    const code = a.buttondown_code ? ` (${a.buttondown_code})` : '';
    const ref = a.campaign_ref ? `, ref ${a.campaign_ref}` : '';
    return { head: `${a.email} — ${when(a.at)}, ${a.source} form${ref}`, why: `${why}${code}` };
  };

  const sections: { title: string; rows: { head: string; why: string }[] }[] = [];
  if (needs.length) sections.push({ title: 'Need you', rows: needs.map(line) });
  if (blocked.length) {
    sections.push({
      title: 'Caught by the firewall (accepted as blocked — unblock in Buttondown if real)',
      rows: blocked.map((b) => ({ head: `${b.email} — ${when(b.creation_date)}`, why: 'blocked subscriber' }))
    });
  }
  if (transient.length) sections.push({ title: 'Failed on our side (may have retried)', rows: transient.map(line) });

  const count = needs.length + blocked.length + transient.length;
  const subject = `Weekly Thing subscribe: ${count} to look at — ${day}`;
  const intro = `${count} subscribe ${count === 1 ? 'attempt' : 'attempts'} in the last day did not end with a reader on the list${worked ? ` (${worked} did)` : ''}.`;

  const text = [
    intro,
    '',
    ...sections.flatMap((s) => [s.title.toUpperCase(), ...s.rows.flatMap((r) => [`- ${r.head}`, `  ${r.why}`]), '']),
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
  const mail = composeDigest(attempts, blocked, now);
  if (!mail) {
    logEvent('info', 'subscribe_digest_quiet', { attempts: attempts.length });
    return { sent: false, attempts: attempts.length, blocked: 0 };
  }
  await sendJmapEmail({ to: DIGEST_TO, subject: mail.subject, text: mail.text, html: mail.html });
  logEvent('info', 'subscribe_digest_sent', { attempts: attempts.length, blocked: blocked.length });
  return { sent: true, attempts: attempts.length, blocked: blocked.length };
}
