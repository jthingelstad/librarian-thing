#!/usr/bin/env node
// Golden-question harness for the live /retrieve endpoint. Run it before and
// after any retrieval, chunking, or embedding change to see whether quality
// moved. Invariant-style expectations (filters respected, proper nouns found,
// known landmark issues surfaced) rather than brittle full rankings.
//
//   LIBRARIAN_STREAM_URL=... LIBRARIAN_RETRIEVE_SECRET=... \
//     node scripts/golden-retrieval.mjs
//
// Both values live in the repo root .env (stack outputs + deploy secret).

const baseUrl = String(process.env.LIBRARIAN_STREAM_URL || '').replace(/\/$/, '');
const secret = process.env.LIBRARIAN_RETRIEVE_SECRET || '';
if (!baseUrl || !secret) {
  console.error('golden-retrieval: set LIBRARIAN_STREAM_URL and LIBRARIAN_RETRIEVE_SECRET (see repo .env).');
  process.exit(2);
}

const GOLDEN = [
  {
    name: 'proper noun: Fastmail (lexical must contribute)',
    request: { query: 'Fastmail email hosting' },
    check: (passages) => passages.some((p) => /fastmail/i.test(p.text || ''))
  },
  {
    // Tailscale appears exactly once in the archive, in a 2026 blog post -
    // so this probes cross-corpus lexical recall, not the WT corpus.
    name: 'proper noun: Tailscale (blog-only mention, all scope)',
    request: { query: 'Tailscale networking', scope: 'all', k: 12 },
    check: (passages) => passages.some((p) => /tailscale/i.test(p.text || ''))
  },
  {
    name: 'proper noun: Obsidian',
    request: { query: 'Obsidian notes' },
    check: (passages) => passages.some((p) => /obsidian/i.test(p.text || ''))
  },
  {
    name: 'year filter returns only that year',
    request: { query: 'artificial intelligence', filters: { yearRange: [2018, 2018] } },
    check: (passages) => passages.length > 0 && passages.every((p) => Number(p.issue_year) === 2018)
  },
  {
    name: 'year range filter returns only that range',
    request: { query: 'programming', filters: { yearRange: [2019, 2020] } },
    check: (passages) =>
      passages.length > 0 && passages.every((p) => Number(p.issue_year) >= 2019 && Number(p.issue_year) <= 2020)
  },
  {
    name: 'section filter returns only Journal chunks',
    request: { query: 'family life', filters: { section: 'journal' } },
    check: (passages) => passages.length > 0 && passages.every((p) => /journal/i.test(String(p.section || '')))
  },
  {
    name: 'blog scope returns blog sources',
    request: { query: 'privacy philosophy', scope: 'blog' },
    check: (passages) => passages.length > 0 && passages.every((p) => p.source_kind === 'blog')
  },
  {
    name: 'agents landmark: WT340 in top results',
    request: { query: 'a shocking number of people still think AI is a chatbot, it is all agents now', k: 8 },
    check: (passages) => passages.some((p) => Number(p.issue_number) === 340)
  },
  {
    name: 'agents landmark: WT348 Weekly Thing Team',
    request: { query: 'the Weekly Thing team of agents Eddy Linky Marky Patty workshop', k: 8 },
    check: (passages) => passages.some((p) => Number(p.issue_number) === 348)
  },
  {
    name: 'origin question finds grounding content',
    request: { query: 'what is the Weekly Thing and when did it start', k: 8 },
    check: (passages) =>
      passages.some((p) => p.source_kind === 'site_page' || p.source_kind === 'faq' || Number(p.issue_number) <= 5)
  },
  {
    name: 'passages carry the wider text budget',
    request: { query: 'multi agent systems', k: 4 },
    check: (passages) => passages.some((p) => String(p.text || '').length > 900)
  },
  {
    name: 'fusion labels retrieval modes',
    request: { query: 'agentic coding maintenance burden', k: 8 },
    check: (passages) => passages.every((p) => String(p.reason || '').length > 0)
  }
];

async function callRetrieve(request) {
  const response = await fetch(`${baseUrl}/retrieve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ k: 8, ...request, retrieve_secret: secret })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.error || 'error'}`);
  return data.passages || [];
}

let failures = 0;
for (const golden of GOLDEN) {
  try {
    const passages = await callRetrieve(golden.request);
    const ok = golden.check(passages);
    if (!ok) failures += 1;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${golden.name}  (${passages.length} passages` +
        (passages.length ? `, top: ${passages[0].source_kind || 'chunk'} #${passages[0].issue_number ?? '-'}` : '') +
        ')'
    );
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${golden.name}  (${error.message})`);
  }
}

console.log(`\n${GOLDEN.length - failures}/${GOLDEN.length} golden checks passed`);
process.exit(failures ? 1 : 0);
