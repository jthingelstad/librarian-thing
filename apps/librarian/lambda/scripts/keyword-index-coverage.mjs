/**
 * The keyword index's coverage oracle: whether an index file names every row
 * each corpus's keyword scan reads, each once and nothing else, and was built
 * from these corpora. Written apart from shared/keyword-index.mts and
 * shared/retrieval.mts, since an oracle never shares the code it checks.
 * build-keyword-index.mjs runs it on the file it built, before the upload;
 * eval-tools.mjs runs it on the file it evals.
 */
import { DatabaseSync } from 'node:sqlite';

export const KEYWORD_KINDS = ['weekly_thing', 'blog', 'podcast', 'reference', 'link'];

// The rows the reference base holds. With a reference base, the Weekly
// Thing's and the blog's copies of them are not in their keyword scans: the
// base is scanned once, as its own corpus.
const REFERENCE_SOURCE_KINDS = new Set(['site_page', 'faq', 'thing', 'document']);
const isPage = (row) => row.source_kind === 'blog' && row.page_id != null && row.page_id !== '';
const isReference = (row) => REFERENCE_SOURCE_KINDS.has(row.source_kind) || isPage(row);
const stamp = (value) => (value == null || value === '' ? null : String(value));

// Each corpus's keyword rows, from the corpora as their files hold them.
export function expectedKeywordRows(corpora) {
  const withReference = Boolean(corpora.reference?.chunks?.length);
  const expected = new Map();
  for (const kind of KEYWORD_KINDS) {
    const rows = corpora[kind]?.chunks || [];
    const own = withReference && (kind === 'weekly_thing' || kind === 'blog');
    expected.set(kind, own ? rows.filter((row) => !isReference(row)) : rows);
  }
  return expected;
}

// What is wrong with the index at file for these corpora, as sentences; an
// empty list is an index that covers them. counts[kind] = rows held.
export function keywordIndexCoverage(file, corpora) {
  const problems = [];
  const counts = {};
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'index'").get();
    const meta = metaRow ? JSON.parse(metaRow.value) : null;
    if (!meta) problems.push('the index has no meta row');
    const held = new Map();
    for (const { kind, id } of db.prepare('SELECT kind, id FROM t').iterate()) {
      if (!held.has(kind)) held.set(kind, new Map());
      const ids = held.get(kind);
      ids.set(id, (ids.get(id) || 0) + 1);
    }
    for (const kind of held.keys()) {
      if (!KEYWORD_KINDS.includes(kind)) problems.push(`the index holds rows of an unknown kind ${kind}`);
    }
    for (const [kind, rows] of expectedKeywordRows(corpora)) {
      const ids = held.get(kind) || new Map();
      counts[kind] = [...ids.values()].reduce((total, n) => total + n, 0);
      const wanted = new Set(rows.map((row) => String(row.id)));
      const missing = [...wanted].filter((id) => !ids.has(id));
      const extra = [...ids.keys()].filter((id) => !wanted.has(id));
      const twice = [...ids].filter(([, n]) => n > 1).map(([id]) => id);
      const sample = (list) => list.slice(0, 3).join(', ');
      if (wanted.size !== rows.length)
        problems.push(`${kind}: the corpus gives ${rows.length - wanted.size} ids twice`);
      if (missing.length) problems.push(`${kind}: ${missing.length} rows not in the index (${sample(missing)})`);
      if (extra.length) problems.push(`${kind}: ${extra.length} index rows not in the corpus (${sample(extra)})`);
      if (twice.length) problems.push(`${kind}: ${twice.length} rows in the index twice (${sample(twice)})`);
      const built = meta?.kinds?.[kind];
      if (meta && (!built || built.rows !== rows.length)) {
        problems.push(`${kind}: the index records ${built?.rows ?? 'no'} rows, the corpus has ${rows.length}`);
      }
      const generated = stamp(corpora[kind]?.generated_at);
      if (meta && built && built.generated_at !== generated) {
        problems.push(
          `${kind}: the index was built from the corpus of ${built.generated_at}, this one is of ${generated}`
        );
      }
    }
  } finally {
    db.close();
  }
  return { problems, counts };
}
