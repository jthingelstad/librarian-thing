/**
 * "Email me this answer" - renders a saved Thingy answer as a self-sent
 * email. The reader proves ownership of the address at the route layer
 * (emailHash(email) must equal the session sub); this module only formats.
 *
 * The answer arrives as the markdown Thingy streamed. Email clients don't
 * render markdown, so a deliberately small converter handles the subset the
 * answer style guide produces: headings, bold/italic, links, images, lists,
 * and paragraphs. Anything it doesn't recognize passes through as escaped
 * text - never dropped, never executed.
 */

type JsonRecord = Record<string, unknown>;

const WT_ARCHIVE_BASE = 'https://weekly.thingelstad.com/archive/';

export function answerEmailSubject(title: unknown) {
  const clean = String(title || '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? `Thingy: ${clean.slice(0, 120)}` : 'An answer from Thingy';
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeUrl(value: unknown) {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

// Inline markdown: images, links, bold, italic, code - on already-escaped text.
function inlineHtml(escaped: string) {
  return escaped
    .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, (_match, alt, url) => {
      const src = safeUrl(url);
      if (!src) return alt;
      return `<img src="${src}" alt="${alt}" style="max-width:100%;height:auto;border-radius:10px;display:block;margin:12px 0;">`;
    })
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (match, label, url) => {
      const href = safeUrl(url);
      return href ? `<a href="${href}" style="color:#0e7a5f;">${label}</a>` : match;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code style="background:#eef2ef;border-radius:4px;padding:1px 5px;">$1</code>');
}

export function answerMarkdownToHtml(markdown: unknown) {
  const blocks = String(markdown || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const html: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const heading = block.match(/^(#{1,4})\s+(.*)$/);
    if (heading && lines.length === 1) {
      const level = Math.min(heading[1].length + 1, 4);
      html.push(
        `<h${level} style="font-size:${level === 2 ? 20 : 17}px;line-height:1.3;margin:20px 0 8px;color:#14211d;">${inlineHtml(escapeHtml(heading[2]))}</h${level}>`
      );
      continue;
    }
    if (lines.every((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line))) {
      const ordered = /^\s*\d+\./.test(lines[0]);
      const items = lines
        .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''))
        .map((item) => `<li style="margin:4px 0;">${inlineHtml(escapeHtml(item))}</li>`)
        .join('');
      html.push(
        `<${ordered ? 'ol' : 'ul'} style="margin:10px 0;padding-left:22px;color:#394943;font-size:15px;line-height:1.6;">${items}</${ordered ? 'ol' : 'ul'}>`
      );
      continue;
    }
    if (/^>/.test(lines[0])) {
      const quote = lines.map((line) => line.replace(/^>\s?/, '')).join(' ');
      html.push(
        `<blockquote style="margin:12px 0;padding:8px 16px;border-left:3px solid #0e7a5f;color:#394943;font-size:15px;line-height:1.6;">${inlineHtml(escapeHtml(quote))}</blockquote>`
      );
      continue;
    }
    html.push(
      `<p style="margin:10px 0;color:#394943;font-size:15px;line-height:1.6;">${inlineHtml(escapeHtml(block.replace(/\n/g, ' ')))}</p>`
    );
  }
  return html.join('\n');
}

export function citationLink(citation: JsonRecord) {
  const issue = String(citation.issue_number ?? '').trim();
  const url = safeUrl(citation.url) || (issue ? `${WT_ARCHIVE_BASE}${issue}/` : '');
  const subject = String(citation.subject || '').trim();
  const label = issue ? `WT${issue}${subject ? ` - ${subject}` : ''}` : subject || url;
  return { url, label };
}

export interface AnswerEmailInput {
  conversationTitle: unknown;
  question: unknown;
  answer: unknown;
  citations?: JsonRecord[];
}

export function answerEmailText({ conversationTitle, question, answer, citations = [] }: AnswerEmailInput) {
  const lines = [
    `From your Thingy conversation "${String(conversationTitle || '').trim() || 'Untitled'}".`,
    '',
    `You asked: ${String(question || '').trim()}`,
    '',
    String(answer || '').trim()
  ];
  const links = citations.map(citationLink).filter((entry) => entry.url || entry.label);
  if (links.length) {
    lines.push('', 'Sources:');
    for (const entry of links) lines.push(`- ${entry.label}${entry.url ? ` (${entry.url})` : ''}`);
  }
  lines.push('', 'Sent by Thingy at your request. https://thingy.thingelstad.com/');
  return lines.join('\n');
}

export function answerEmailHtml({ conversationTitle, question, answer, citations = [] }: AnswerEmailInput) {
  const title = escapeHtml(String(conversationTitle || '').trim() || 'Untitled');
  const safeQuestion = escapeHtml(String(question || '').trim());
  const answerHtml = answerMarkdownToHtml(answer);
  const links = citations.map(citationLink).filter((entry) => entry.url || entry.label);
  const sources = links.length
    ? `<div style="margin-top:22px;padding-top:14px;border-top:1px solid #dfe8e2;">
        <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#658178;font-weight:700;margin-bottom:6px;">Sources</div>
        ${links
          .map((entry) => {
            const label = escapeHtml(entry.label);
            return entry.url
              ? `<div style="margin:3px 0;font-size:14px;"><a href="${entry.url}" style="color:#0e7a5f;">${label}</a></div>`
              : `<div style="margin:3px 0;font-size:14px;color:#394943;">${label}</div>`;
          })
          .join('\n')}
      </div>`
    : '';
  return `<!doctype html>
<html>
  <body style="margin:0;background:#f5f7f4;color:#18221f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7f4;margin:0;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #dfe8e2;border-radius:22px;overflow:hidden;">
            <tr>
              <td style="padding:30px 34px 6px;">
                <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#658178;font-weight:700;">Thingy</div>
                <h1 style="font-size:22px;line-height:1.25;margin:8px 0 4px;color:#14211d;font-weight:750;">${title}</h1>
                <p style="font-size:14px;margin:0 0 6px;color:#658178;">You asked: ${safeQuestion}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 34px 26px;">
                ${answerHtml}
                ${sources}
                <p style="font-size:12px;color:#8a988f;margin:26px 0 0;">Sent by Thingy at your request. <a href="https://thingy.thingelstad.com/" style="color:#658178;">thingy.thingelstad.com</a></p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
