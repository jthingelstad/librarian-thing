/**
 * The keyword index: one SQLite full-text (FTS5) file over every corpus,
 * the keyword leg of retrieval (docs/PLAN-2026-11-01-keyword-search.md,
 * built from docs/BRIEF-2026-11-02-keyword-index-build.md).
 *
 * One table holds the rows each corpus's keyword scan reads (the Weekly
 * Thing's and the blog's own rows, the podcast, the reference base and the
 * saved links), so bm25 shares one set of word counts and a small corpus is
 * not ranked out: one index per corpus scored the podcast's questions 0.00
 * to 0.50. The deploy builds it from the corpora it ships
 * (scripts/build-keyword-index.mjs), the corpus gate checks it covers every
 * row, and the Lambda opens it read-only; retrieval.mts maps its ids back to
 * the corpus rows it loaded.
 *
 * node:sqlite is imported on first use, so a runtime without it (or without
 * FTS5) fails to open the index and retrieval keeps the TF-IDF scan, logged.
 */
import type { DatabaseSync } from 'node:sqlite';

// Bump when the table or the meta changes shape: an index of another schema
// does not open, and retrieval uses TF-IDF until the deploy rebuilds it.
export const KEYWORD_INDEX_SCHEMA = 1;

// The corpora the index covers, by the kind retrieve() names their pools.
export const KEYWORD_INDEX_KINDS = ['weekly_thing', 'blog', 'podcast', 'reference', 'link'] as const;

// porter stems ("sessions" finds "session"): inflected questions went from
// 0.35 to 0.91 with it, 0.45 without.
const TOKENIZE = 'porter unicode61';

// A phrase match outranks every term match: its score is lifted by a
// constant larger than any bm25 score the archive gives.
const PHRASE_LIFT = 1000;

// A common list of English stopwords. The keyword test set's generator keeps
// its own (an oracle shares no code with what it checks).
const STOPWORDS = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both but
  by can could did do does doing down during each few for from further had has have having he her here hers herself him
  himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other
  our ours ourselves out over own same she should so some such than that the their theirs them themselves then there
  these they this those through to too under until up very was we were what when where which while who whom why will
  with would you your yours yourself yourselves`
    .split(/\s+/)
    .filter(Boolean)
);

const WORD_RE = /[\p{L}\p{N}]+/gu;
const words = (text: unknown) => Array.from(String(text || '').matchAll(WORD_RE), (match) => match[0].toLowerCase());
const quote = (word: string) => `"${word.replaceAll('"', '""')}"`;

// How a reader's words become a query. The served mode is 'adjacent'; the
// eval measures the others (scripts/fts5-lexical.mjs).
//   or        every word, OR'd
//   nostop    stopwords dropped (unless that leaves none), the rest OR'd
//   phrase    nostop, and a span in double quotes of two or more words is a
//             phrase: rows holding it rank first
//   adjacent  phrase, and with no quoted span a query of two or more words is
//             a phrase too: rows holding its words in order rank first
export type KeywordQueryMode = 'or' | 'nostop' | 'phrase' | 'adjacent';
export const KEYWORD_QUERY_MODES: readonly KeywordQueryMode[] = ['or', 'nostop', 'phrase', 'adjacent'];

// The FTS5 query for a reader's words: the OR'd terms, and the phrases whose
// rows rank first. Every word is quoted, so nothing a reader types (NOT, OR,
// *, -, NEAR, a column name) is ever FTS5 syntax.
export function ftsQuery(
  text: unknown,
  options: { query?: KeywordQueryMode } = {}
): { match: string; phrases: string[] } {
  const mode = options.query || 'adjacent';
  const phrases: string[][] = [];
  let rest = String(text || '');
  if (mode === 'phrase' || mode === 'adjacent') {
    rest = rest.replace(/["“”]([^"“”]+)["“”]/g, (_, span: string) => {
      const spanWords = words(span);
      if (spanWords.length > 1) phrases.push(spanWords);
      return ` ${span} `;
    });
  }
  let terms = words(rest);
  if (mode === 'adjacent' && !phrases.length && terms.length > 1) phrases.push(terms);
  if (mode !== 'or') {
    const kept = terms.filter((word) => !STOPWORDS.has(word));
    if (kept.length) terms = kept;
  }
  terms = [...new Set(terms)];
  return {
    match: terms.map(quote).join(' OR '),
    phrases: phrases.map((spanWords) => spanWords.map(quote).join(' + '))
  };
}

type SqliteModule = typeof import('node:sqlite');
let sqlite: Promise<SqliteModule> | undefined;
function loadSqlite(): Promise<SqliteModule> {
  // A failed import is not cached: the next open tries again.
  sqlite ||= import('node:sqlite').catch((error) => {
    sqlite = undefined;
    throw error;
  });
  return sqlite;
}

export interface KeywordIndexRow {
  id?: unknown;
  subject?: unknown;
  section?: unknown;
  text?: unknown;
}

// One corpus's part of the index: its pool's kind, the build stamp of the
// corpus its rows came from, and the rows.
export interface KeywordIndexSource {
  kind: string;
  generated_at?: unknown;
  rows: KeywordIndexRow[];
}

// What the index was built from, per corpus: retrieval checks it against the
// corpora a container loaded and keeps TF-IDF when they differ.
export interface KeywordIndexMeta {
  schema: number;
  built_at: string;
  kinds: Record<string, { rows: number; generated_at: string | null }>;
}

// A corpus's build stamp as the index records it (retrieval compares the
// loaded corpus's stamp the same way).
export const keywordIndexStamp = (value: unknown) => (value == null || value === '' ? null : String(value));

// Writes the index to path, which must not exist yet. Throws on a corpus
// given twice, a row without an id or an id twice in one corpus, since the
// index names rows by (kind, id).
export async function writeKeywordIndex(
  path: string,
  sources: KeywordIndexSource[],
  builtAt: string = new Date().toISOString()
): Promise<KeywordIndexMeta> {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(path);
  const meta: KeywordIndexMeta = { schema: KEYWORD_INDEX_SCHEMA, built_at: builtAt, kinds: {} };
  try {
    db.exec(
      `CREATE VIRTUAL TABLE t USING fts5(subject, section, text, kind UNINDEXED, id UNINDEXED, tokenize='${TOKENIZE}');
       CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`
    );
    const insert = db.prepare('INSERT INTO t (subject, section, text, kind, id) VALUES (?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    for (const { kind, generated_at, rows } of sources) {
      if (meta.kinds[kind]) throw new Error(`keyword index: ${kind} given twice`);
      const seen = new Set<string>();
      for (const row of rows) {
        const id = row.id == null ? '' : String(row.id);
        if (!id) throw new Error(`keyword index: a ${kind} row has no id`);
        if (seen.has(id)) throw new Error(`keyword index: ${kind} row ${id} appears twice`);
        seen.add(id);
        insert.run(String(row.subject || ''), String(row.section || ''), String(row.text || ''), kind, id);
      }
      meta.kinds[kind] = { rows: rows.length, generated_at: keywordIndexStamp(generated_at) };
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('index', ?)").run(JSON.stringify(meta));
    db.exec('COMMIT');
    db.exec("INSERT INTO t (t) VALUES ('optimize')");
  } finally {
    db.close();
  }
  return meta;
}

export interface KeywordHit {
  id: string;
  score: number;
}

export interface KeywordIndex {
  meta: KeywordIndexMeta;
  // One corpus's matches, best first: rows holding the query's phrase, then
  // the rest by bm25. Scores are positive and comparable across corpora.
  search(query: unknown, kind: string): Generator<KeywordHit>;
  // Every (kind, id) the index names, for the gate's coverage check.
  entries(): Generator<{ kind: string; id: string }>;
  close(): void;
}

export async function openKeywordIndex(path: string): Promise<KeywordIndex> {
  const { DatabaseSync } = await loadSqlite();
  const db: DatabaseSync = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'index'").get() as { value?: string } | undefined;
    const meta = JSON.parse(String(row?.value || 'null')) as KeywordIndexMeta | null;
    if (!meta || meta.schema !== KEYWORD_INDEX_SCHEMA) {
      throw new Error(`keyword index schema ${meta?.schema ?? 'missing'}, expected ${KEYWORD_INDEX_SCHEMA}`);
    }
    // Prepared here, so a runtime whose SQLite lacks FTS5 fails now, at open.
    const select = db.prepare('SELECT id, -bm25(t) AS score FROM t WHERE t MATCH ? AND kind = ? ORDER BY bm25(t)');
    const all = db.prepare('SELECT kind, id FROM t');
    return {
      meta,
      *search(query, kind) {
        const { match, phrases } = ftsQuery(query, { query: 'adjacent' });
        if (!match) return;
        const taken = new Set<string>();
        if (phrases.length) {
          for (const hit of select.all(phrases.join(' OR '), kind) as Array<{ id: string; score: number }>) {
            taken.add(hit.id);
            yield { id: hit.id, score: PHRASE_LIFT + hit.score };
          }
        }
        for (const hit of select.iterate(match, kind) as Iterable<{ id: string; score: number }>) {
          if (!taken.has(hit.id)) yield { id: hit.id, score: hit.score };
        }
      },
      *entries() {
        for (const entry of all.iterate() as Iterable<{ kind: string; id: string }>) yield entry;
      },
      close() {
        db.close();
      }
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
