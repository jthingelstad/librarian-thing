const WT_ARCHIVE_URL_RE = /https?:\/\/weekly\.thingelstad\.com\/archive\/(\d+)\/?/gi;
const WT_ARCHIVE_PATH_RE = /`?\/archive\/(\d+)\/`?/gi;
const RAW_URL_RE = /(?<!\]\()https?:\/\/[^\s<>)]+/gi;
const PROCESS_NARRATION_RE =
  /\b(?:let me\s+(?:pull|look|search|check|find|tell|dig|synthesize|compile|assemble|gather|summarize|write up|put together)|i(?: have|(?:'|’)ve got) (?:everything|what) i need|i have enough(?:\s+to\b)?|i found enough|i can now answer|i (?:now )?have a (?:good|clear|full|complete|solid) (?:picture|sense|view)|i(?:'|’)ll\s+(?:pull|look|search|check|find|dig|compile|assemble))\b/i;
// Internal tool names (snake_case) narrated as subjects - "The quote_search
// for X returned...", "entity_lens shows..." - never belong in reader prose;
// the status stream already tells the reader what Thingy is doing.
const TOOL_NARRATION_RE =
  /\b(?:the\s+)?[a-z][a-z0-9]*_[a-z0-9_]+\s+(?:tool\s+|call\s+)?(?:for\s+[^.\n]{0,80}\s+)?(?:returned|came back|shows?|found|gave|confirms?)\b/i;
const PREFLIGHT_PAREN_RE = /\n{0,2}\s*\(Preflight:[\s\S]*?\)\s*$/i;
const PREFLIGHT_BLOCK_RE = /(?:^|\n)#{0,3}\s*\*{0,2}Preflight\*{0,2}:?[\s\S]*$/i;

function cleanSpacing(value: unknown) {
  return String(value || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1')
    .trim();
}

function stripLeadingProcessNarration(value: unknown) {
  let text = String(value || '');
  const answerMarker = text.search(/\b(?:here(?:'|’)s|here is)\b|^#{1,3}\s+/im);
  if (
    answerMarker > 0 &&
    (PROCESS_NARRATION_RE.test(text.slice(0, answerMarker)) || TOOL_NARRATION_RE.test(text.slice(0, answerMarker)))
  ) {
    text = text.slice(answerMarker);
  }
  const blocks = text.split(/\n{2,}/);
  while (blocks.length && (PROCESS_NARRATION_RE.test(blocks[0]) || TOOL_NARRATION_RE.test(blocks[0]))) {
    blocks.shift();
  }
  return blocks.join('\n\n').replace(/^(?:-{3,}|\*{3,}|_{3,})\s*/g, '');
}

export function sanitizeAnswerProse(answer: unknown) {
  let text = String(answer || '');
  if (!text) return '';

  text = stripLeadingProcessNarration(text);

  text = text
    .replace(PREFLIGHT_PAREN_RE, '')
    .replace(PREFLIGHT_BLOCK_RE, '')
    .replace(/(?:^|[ \t])(?:The\s+)?(?:archive\s+)?URL\s+is\s+`?\/archive\/\d+\/`?\.?/gim, '')
    .replace(
      /(?:^|[ \t])(?:The\s+)?(?:archive\s+)?URL\s+is\s+https?:\/\/weekly\.thingelstad\.com\/archive\/\d+\/?\.?/gim,
      ''
    )
    .replace(WT_ARCHIVE_URL_RE, 'WT$1')
    .replace(WT_ARCHIVE_PATH_RE, 'WT$1')
    // Bare URLs become markdown links instead of vanishing. The scope
    // prompts tell the agent to cite blog/podcast sources "by title and
    // link"; deleting the link whenever the model skipped markdown syntax
    // silently broke that instruction.
    .replace(RAW_URL_RE, (match) => {
      const trailing = match.match(/[.,;:!?]+$/)?.[0] || '';
      const url = trailing ? match.slice(0, -trailing.length) : match;
      if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(url)) return match;
      const display = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
      const label = display.length > 60 ? `${display.slice(0, 57)}...` : display;
      return `[${label}](${url})${trailing}`;
    });

  return cleanSpacing(text);
}
