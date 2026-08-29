/**
 * Citation post-processing for the Thingy agent loop.
 *
 * The agent's tool results bubble up many candidate citations — far more
 * than will end up referenced in the final answer. The runtime hands the
 * full list here so we can keep only the ones the answer body actually
 * mentions, in the order they appear, with at most one citation per
 * issue number.
 */

/**
 * Return citations filtered + deduped against the answer body.
 *
 * Behavior:
 *   - Filter: drop citations whose `issue_number` is not referenced
 *     anywhere in `answer` (regex matches `WT\d+` or `#\d+`).
 *   - Dedupe: at most one citation per issue number; the first section
 *     seen wins (multiple tool calls can surface the same issue with
 *     different sections).
 *   - Order: sort by first-mention order in the answer body.
 *
 * Edge case: when the answer mentions no issue numbers at all (FAQ-only
 * response, out-of-scope refusal, etc.), the full citations list is
 * returned unchanged — the reader may still appreciate a "we looked at
 * these" footer.
 *
 * Catalog back-fill is evidence-gated: an issue number mentioned in the
 * answer but missing from the collected citations only gets a catalog
 * citation when that number also appeared somewhere in this turn's tool
 * results. A number the model invented gets no citation — manufacturing
 * a plausible-looking source for it would launder the hallucination.
 *
 * Blog/podcast citations carry no WT/# token, so the mention filter can
 * never match them. They are always kept (the agent cites these sources by
 * title/link, not number) and appended after the issue citations.
 *
 */
export interface Citation {
  issue_number?: string | number | null;
  source_kind?: string;
  url?: string;
  subject?: string;
  publish_date?: string;
  section?: string;
  [key: string]: unknown;
}

interface IssueMetadata {
  number?: string | number;
  issue_number?: string | number | null;
  subject?: string;
  publish_date?: string;
  url?: string;
}

type IssueCatalog = Map<string | number, IssueMetadata> | Record<string, IssueMetadata> | null;

function isExternalCitation(citation: Citation) {
  return (
    ['blog', 'podcast'].includes(citation.source_kind || '') || (citation.issue_number == null && Boolean(citation.url))
  );
}

function catalogIssue(issueCatalog: IssueCatalog, issueNumber: string | number): IssueMetadata | null {
  const key = String(issueNumber || '').trim();
  if (!key || !issueCatalog) return null;
  if (issueCatalog instanceof Map) return issueCatalog.get(key) || issueCatalog.get(Number(key)) || null;
  return issueCatalog[key] || null;
}

function citationFromIssue(issueNumber: string | number, issueCatalog: IssueCatalog): Citation | null {
  const issue = catalogIssue(issueCatalog, issueNumber);
  if (!issue) return null;
  const number = String(issue.number ?? issue.issue_number ?? issueNumber);
  return {
    issue_number: number,
    source_kind: 'chunk',
    subject: issue.subject || `Weekly Thing ${number}`,
    publish_date: issue.publish_date,
    section: 'Issue',
    url: issue.url || `/archive/${number}/`
  };
}

export function prioritizeCitationsForAnswer(
  citations: Citation[],
  answer: unknown,
  issueCatalog: IssueCatalog = null,
  evidencedIssues: Set<number> | null = null
): Citation[] {
  const external: Citation[] = [];
  const issueCitations: Citation[] = [];
  for (const citation of citations) {
    (isExternalCitation(citation) ? external : issueCitations).push(citation);
  }
  const mentioned = [...String(answer || '').matchAll(/(?:WT|#)(\d+)/g)].map((match) => Number(match[1]));
  if (!mentioned.length) return [...issueCitations, ...external];
  const firstSeen = new Map<number, number>();
  mentioned.forEach((issueNumber, index) => {
    if (!firstSeen.has(issueNumber)) firstSeen.set(issueNumber, index);
  });
  const byIssue = new Map<number, Citation>();
  for (const citation of issueCitations) {
    const num = Number(citation.issue_number);
    if (!firstSeen.has(num)) continue;
    if (!byIssue.has(num)) byIssue.set(num, citation);
  }
  for (const issueNumber of firstSeen.keys()) {
    if (byIssue.has(issueNumber)) continue;
    if (evidencedIssues && !evidencedIssues.has(issueNumber)) continue;
    const citation = citationFromIssue(issueNumber, issueCatalog);
    if (citation) byIssue.set(issueNumber, citation);
  }
  const orderedIssues = [...byIssue.values()].sort((a, b) => {
    const rankA = firstSeen.get(Number(a.issue_number));
    const rankB = firstSeen.get(Number(b.issue_number));
    return (rankA ?? Number.MAX_SAFE_INTEGER) - (rankB ?? Number.MAX_SAFE_INTEGER);
  });
  return [...orderedIssues, ...external];
}

// Issue numbers that actually surfaced in this turn's tool results - the
// evidence set that gates catalog back-fill above. Matches issue_number
// fields and inline WT###/#### tokens inside tool result payloads.
export function evidencedIssueNumbers(toolResults: unknown[]): Set<number> {
  const evidenced = new Set<number>();
  for (const result of toolResults || []) {
    let serialized = '';
    try {
      serialized = JSON.stringify(result) || '';
    } catch {
      continue;
    }
    for (const match of serialized.matchAll(/(?:"issue_number"\s*:\s*"?|WT|#)(\d{1,4})\b/g)) {
      evidenced.add(Number(match[1]));
    }
  }
  return evidenced;
}
