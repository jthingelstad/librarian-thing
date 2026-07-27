import { logEvent } from './logging.mjs';
import { tinylyticsPixelHtml } from './tinylytics-email.mjs';

const JMAP_SESSION_URL = 'https://api.fastmail.com/jmap/session';
const CAP_CORE = 'urn:ietf:params:jmap:core';
const CAP_MAIL = 'urn:ietf:params:jmap:mail';
const CAP_SUBMISSION = 'urn:ietf:params:jmap:submission';

type JsonObject = Record<string, unknown>;
type JmapMethodResponse = [string, JsonObject, string];

interface JmapSession {
  apiUrl?: string;
  primaryAccounts?: Record<string, string>;
}

interface JmapResponse {
  methodResponses?: JmapMethodResponse[];
}

interface JmapIdentity {
  id?: string;
  email?: string;
}

interface JmapMailbox {
  id?: string;
  name?: string;
  parentId?: string | null;
  role?: string;
}

/**
 * Mailbox Thingy files its outbound mail into.
 *
 * The Fastmail account is shared by several agents and uses a per-agent scheme
 * (Thingy-Sent, Elixir-Sent, Oliver-Sent, Otto-Sent). Only the top-level Sent
 * carries the JMAP `sent` role — the agent folders are plain named children — so
 * resolving by role alone files every Thingy magic link and Dispatch email into
 * the folder shared with the other agents.
 */
const SENT_FOLDER = process.env.THINGY_EMAIL_SENT_FOLDER?.trim() || 'Thingy-Sent';

/**
 * Prefer our own named child of Sent; fall back to the role parent so a renamed
 * folder degrades to "misfiled" rather than "magic link never sent".
 */
export function pickSentMailbox(
  mailboxes: JmapMailbox[],
  sentRootId: string,
  folderName: string = SENT_FOLDER
): JmapMailbox | undefined {
  const child = mailboxes.find((mailbox) => mailbox.parentId === sentRootId && mailbox.name === folderName);
  if (child?.id) return child;
  return mailboxes.find((mailbox) => mailbox.id === sentRootId);
}

interface SendContext {
  apiUrl: string;
  mailAccountId: string;
  submissionAccountId: string;
  identityId: string;
  draftMailboxId: string;
  sentMailboxId: string;
}

interface ReaderEmailContext {
  preferred_name?: unknown;
  returning?: unknown;
  turn_count?: unknown;
  subscriber_status?: unknown;
}

interface MagicLinkEmailInput {
  magicLink: string;
  expiresMinutes: number;
  context?: ReaderEmailContext;
  imageUrl?: string;
}

interface JmapEmailCallInput {
  context: SendContext;
  fromEmail: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

interface SendJmapEmailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
  fromEmail?: string;
  fromName?: string;
}

interface JmapSetResult {
  notCreated?: Record<string, { type?: string }>;
  created?: Record<string, { id?: string }>;
}

function envValue(...names: string[]) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

export function jmapToken() {
  return envValue('FASTMAIL_JMAP_TOKEN', 'THINGY_FASTMAIL_JMAP_TOKEN', 'THINGY_JMAP_TOKEN');
}

export function jmapFromEmail() {
  return envValue('THINGY_MAGIC_LINK_FROM_EMAIL', 'THINGY_EMAIL_FROM') || 'thingy@thingelstad.com';
}

export function jmapFromName() {
  return envValue('THINGY_MAGIC_LINK_FROM_NAME', 'THINGY_EMAIL_FROM_NAME') || 'Thingy';
}

export function jmapImageUrl() {
  return envValue('THINGY_MAGIC_LINK_IMAGE_URL') || 'https://thingy.thingelstad.com/img/thingy.png';
}

export function jmapConfigured() {
  return Boolean(jmapToken());
}

async function jmapFetch<T extends JsonObject = JsonObject>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${jmapToken()}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`JMAP HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function jmapSession(): Promise<JmapSession> {
  return await jmapFetch<JmapSession & JsonObject>(JMAP_SESSION_URL);
}

async function jmapCall(apiUrl: string, calls: unknown[]): Promise<JmapResponse> {
  return await jmapFetch<JmapResponse & JsonObject>(apiUrl, {
    method: 'POST',
    body: JSON.stringify({
      using: [CAP_CORE, CAP_MAIL, CAP_SUBMISSION],
      methodCalls: calls
    })
  });
}

export function requireMethodResponse(responses: JmapMethodResponse[] = [], name: string, id: string): JsonObject {
  const found = responses.find((item) => item[2] === id && (item[0] === name || item[0] === 'error'));
  if (!found) throw new Error(`JMAP ${name} response missing`);
  if (found[0] === 'error') {
    throw new Error(`JMAP ${name} failed: ${found[1]?.type || found[1]?.description || 'error'}`);
  }
  return found[1] || {};
}

function primaryAccount(session: JmapSession, capability: string) {
  return session?.primaryAccounts?.[capability] || session?.primaryAccounts?.[CAP_MAIL] || '';
}

function pickIdentity(identities: JmapIdentity[] = [], fromEmail = '') {
  const wanted = String(fromEmail || '').toLowerCase();
  return identities.find((identity) => String(identity.email || '').toLowerCase() === wanted) || identities[0] || null;
}

async function loadSendContext(session: JmapSession, fromEmail: string): Promise<SendContext> {
  const mailAccountId = primaryAccount(session, CAP_MAIL);
  const submissionAccountId = primaryAccount(session, CAP_SUBMISSION) || mailAccountId;
  if (!mailAccountId || !submissionAccountId || !session.apiUrl) {
    throw new Error('JMAP session missing mail/submission account');
  }
  const response = await jmapCall(session.apiUrl, [
    ['Identity/get', { accountId: submissionAccountId, ids: null }, 'identity'],
    [
      'Mailbox/get',
      {
        accountId: mailAccountId,
        ids: null,
        // name + parentId are needed to find our own child of Sent; role alone
        // only ever resolves the shared top-level folder.
        properties: ['id', 'name', 'parentId', 'role']
      },
      'mailboxes'
    ]
  ]);
  const identities =
    (requireMethodResponse(response.methodResponses, 'Identity/get', 'identity').list as JmapIdentity[] | undefined) ||
    [];
  const mailboxes =
    (requireMethodResponse(response.methodResponses, 'Mailbox/get', 'mailboxes').list as JmapMailbox[] | undefined) ||
    [];
  const drafts = mailboxes.find((mailbox) => mailbox.role === 'drafts');
  const sentRoot = mailboxes.find((mailbox) => mailbox.role === 'sent');
  const identity = pickIdentity(identities, fromEmail);
  if (!identity?.id) throw new Error(`No JMAP identity available for ${fromEmail}`);
  if (!drafts?.id) throw new Error('No JMAP drafts mailbox available');
  if (!sentRoot?.id) throw new Error('No JMAP sent mailbox available');
  const sent = pickSentMailbox(mailboxes, sentRoot.id);
  if (!sent?.id) throw new Error('No JMAP sent mailbox available');
  if (sent.id === sentRoot.id) {
    logEvent('WARN', 'jmap_sent_folder_missing', {
      folder: SENT_FOLDER,
      detail: 'filing into the shared Sent folder'
    });
  }
  return {
    apiUrl: session.apiUrl,
    mailAccountId,
    submissionAccountId,
    identityId: identity.id,
    draftMailboxId: drafts.id,
    sentMailboxId: sent.id
  };
}

function emailGreeting(context: ReaderEmailContext = {}) {
  const name = String(context.preferred_name || '').trim();
  if (name) return `Hi ${name}. Thingy is ready.`;
  if (context.returning) return 'Welcome back. Thingy is ready.';
  return 'Thingy is ready.';
}

function emailIntro(context: ReaderEmailContext = {}) {
  if (context.returning && Number(context.turn_count || 0) > 0) {
    return 'Your archive thread is waiting. Use this private link to step back into Thingy.';
  }
  return "Use this private link to meet Thingy, Jamie Thingelstad's archive agent.";
}

function emailMemberLine(context: ReaderEmailContext = {}) {
  return context.subscriber_status === 'premium'
    ? 'Thanks for being a Weekly Thing Supporting Member.'
    : 'Thingy will open the archive in your browser.';
}

export function magicLinkEmailText({ magicLink, expiresMinutes, context = {} }: MagicLinkEmailInput) {
  return [
    emailGreeting(context),
    '',
    emailIntro(context),
    '',
    magicLink,
    '',
    `This link expires in ${expiresMinutes} minutes and can only be used once. It opens the archive agent in your browser.`,
    emailMemberLine(context),
    '',
    'If you did not request this, you can ignore this email.'
  ].join('\n');
}

function escapeHtml(value: unknown) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function magicLinkEmailHtml({
  magicLink,
  expiresMinutes,
  context = {},
  imageUrl = jmapImageUrl()
}: MagicLinkEmailInput) {
  const safeLink = escapeHtml(magicLink);
  const safeImageUrl = escapeHtml(imageUrl);
  const safeMinutes = escapeHtml(String(expiresMinutes));
  const greeting = escapeHtml(emailGreeting(context));
  const intro = escapeHtml(emailIntro(context));
  const memberLine = escapeHtml(emailMemberLine(context));
  const trackingPixel = tinylyticsPixelHtml('/email/thingy/login');
  return `<!doctype html>
<html>
  <body style="margin:0;background:#f5f7f4;color:#18221f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7f4;margin:0;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border:1px solid #dfe8e2;border-radius:22px;overflow:hidden;box-shadow:0 18px 50px rgba(31,47,42,0.10);">
            <tr>
              <td align="center" style="padding:34px 28px 10px;">
                <img src="${safeImageUrl}" width="132" height="132" alt="Thingy" style="display:block;width:132px;height:132px;border:0;margin:0 auto 14px;">
                <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#658178;font-weight:700;">Thingy</div>
                <h1 style="font-size:28px;line-height:1.15;margin:10px 0 0;color:#14211d;font-weight:750;">${greeting}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 34px 8px;text-align:center;">
                <p style="font-size:16px;line-height:1.55;margin:0;color:#394943;">${intro}</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:24px 34px 14px;">
                <a href="${safeLink}" style="display:inline-block;background:#223c35;color:#ffffff;text-decoration:none;border-radius:999px;padding:14px 22px;font-size:16px;line-height:1;font-weight:700;">Open Thingy</a>
              </td>
            </tr>
            <tr>
              <td style="padding:4px 34px 30px;text-align:center;">
                <p style="font-size:13px;line-height:1.5;margin:0;color:#70827b;">This link expires in ${safeMinutes} minutes and can only be used once.<br>${memberLine}</p>
              </td>
            </tr>
            <tr>
              <td style="background:#eef4f0;padding:18px 24px;text-align:center;">
                <p style="font-size:12px;line-height:1.5;margin:0;color:#66766f;">If the button does not work, paste this link into your browser:<br><a href="${safeLink}" style="color:#315f54;word-break:break-all;">${safeLink}</a></p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    ${trackingPixel}
  </body>
</html>`;
}

export function magicLinkEmailSubject() {
  return 'Thingy is ready for you';
}

export function buildMagicLinkJmapCalls({
  context,
  fromEmail,
  fromName,
  to,
  text,
  html
}: Omit<JmapEmailCallInput, 'subject'>) {
  return buildJmapEmailCalls({
    context,
    fromEmail,
    fromName,
    to,
    subject: magicLinkEmailSubject(),
    text,
    html
  });
}

export function buildJmapEmailCalls({
  context,
  fromEmail,
  fromName,
  to,
  subject,
  text,
  html
}: JmapEmailCallInput): unknown[] {
  return [
    [
      'Email/set',
      {
        accountId: context.mailAccountId,
        create: {
          draft: {
            mailboxIds: { [context.draftMailboxId]: true },
            keywords: { $draft: true },
            from: [{ name: fromName, email: fromEmail }],
            to: [{ email: to }],
            subject,
            bodyStructure: {
              type: 'multipart/alternative',
              subParts: [
                { partId: 'text', type: 'text/plain' },
                { partId: 'html', type: 'text/html' }
              ]
            },
            bodyValues: {
              text: { value: text, charset: 'utf-8' },
              html: { value: html, charset: 'utf-8' }
            }
          }
        }
      },
      'email'
    ],
    [
      'EmailSubmission/set',
      {
        accountId: context.submissionAccountId,
        onSuccessUpdateEmail: {
          '#send': {
            [`mailboxIds/${context.sentMailboxId}`]: true,
            [`mailboxIds/${context.draftMailboxId}`]: null,
            'keywords/$draft': null
          }
        },
        create: {
          send: {
            emailId: '#draft',
            identityId: context.identityId,
            envelope: {
              mailFrom: { email: fromEmail },
              rcptTo: [{ email: to }]
            }
          }
        }
      },
      'submit'
    ]
  ];
}

export async function sendJmapEmail({
  to,
  subject,
  text,
  html,
  fromEmail = jmapFromEmail(),
  fromName = jmapFromName()
}: SendJmapEmailInput) {
  const token = jmapToken();
  if (!token) throw new Error('FASTMAIL_JMAP_TOKEN is not configured');
  const session = await jmapSession();
  const sendContext = await loadSendContext(session, fromEmail);
  const response = await jmapCall(
    sendContext.apiUrl,
    buildJmapEmailCalls({
      context: sendContext,
      fromEmail,
      fromName,
      to,
      subject,
      text,
      html
    })
  );
  const emailSet = requireMethodResponse(response.methodResponses, 'Email/set', 'email') as JmapSetResult;
  const submit = requireMethodResponse(response.methodResponses, 'EmailSubmission/set', 'submit') as JmapSetResult;
  if (emailSet.notCreated?.draft) {
    throw new Error(`JMAP email create failed: ${emailSet.notCreated.draft.type || 'notCreated'}`);
  }
  if (submit.notCreated?.send) {
    throw new Error(`JMAP submission failed: ${submit.notCreated.send.type || 'notCreated'}`);
  }
  if (!submit.created?.send?.id) throw new Error('JMAP submission did not create a send record');
  return {
    ok: true,
    submission_id: submit.created.send.id
  };
}

export async function sendMagicLinkEmail({
  to,
  magicLink,
  expiresMinutes,
  context = {}
}: MagicLinkEmailInput & { to: string }) {
  const token = jmapToken();
  if (!token) throw new Error('FASTMAIL_JMAP_TOKEN is not configured');
  const fromEmail = jmapFromEmail();
  const session = await jmapSession();
  const sendContext = await loadSendContext(session, fromEmail);
  const text = magicLinkEmailText({ magicLink, expiresMinutes, context });
  const html = magicLinkEmailHtml({ magicLink, expiresMinutes, context });
  const response = await jmapCall(
    sendContext.apiUrl,
    buildMagicLinkJmapCalls({
      context: sendContext,
      fromEmail,
      fromName: jmapFromName(),
      to,
      text,
      html
    })
  );
  const emailSet = requireMethodResponse(response.methodResponses, 'Email/set', 'email') as JmapSetResult;
  const submit = requireMethodResponse(response.methodResponses, 'EmailSubmission/set', 'submit') as JmapSetResult;
  if (emailSet.notCreated?.draft) {
    throw new Error(`JMAP email create failed: ${emailSet.notCreated.draft.type || 'notCreated'}`);
  }
  if (submit.notCreated?.send) {
    throw new Error(`JMAP submission failed: ${submit.notCreated.send.type || 'notCreated'}`);
  }
  if (!submit.created?.send?.id) throw new Error('JMAP submission did not create a send record');
  return {
    ok: true,
    submission_id: submit.created.send.id
  };
}
