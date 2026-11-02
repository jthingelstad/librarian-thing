/**
 * A keyword engine on SQLite full-text search (FTS5, built into node:sqlite),
 * for the meaning eval to measure against today's TF-IDF scan
 * (docs/PLAN-2026-11-01-keyword-search.md). retrieve() takes it as
 * opts.lexicalEngine; nothing that serves readers passes one. The served
 * keyword index (shared/keyword-index.mts) is the variant it chose:
 * tokenizer=porter,query=adjacent,merge=global.
 *
 * Each corpus's rows are indexed once, in memory, in three columns (subject,
 * section, text), with the row's index as its rowid. Options:
 *
 *   tokenizer  'unicode61' or 'porter' (porter stems: "sessions" finds
 *              "session")
 *   weights    [subject, section, text] for bm25(); FTS5 fixes k1 at 1.2 and
 *              b at 0.75
 *   query      'or'       every word, OR'd
 *              'nostop'   stopwords dropped, the rest OR'd
 *              'phrase'   nostop, and a span the reader put in double quotes
 *                         is a phrase: rows holding it rank first
 *              'adjacent' phrase, and an unquoted query of two or more words
 *                         is a phrase too: rows holding its words in order
 *                         rank first
 *   urls       'keep' or 'strip' (a markdown link indexes its text only)
 *   merge      how one corpus's scores meet another's when retrieve() sorts
 *              the keyword lists of every corpus it scans together:
 *              'raw'    bm25 as it comes (each corpus's own word statistics,
 *                       so a small corpus scores low)
 *              'max'    each corpus's scores divided by its best
 *              'global' one index over every corpus, so bm25 shares one set
 *                       of statistics; collect(true) while retrieve() is
 *                       called once over every corpus, then collect(false)
 */
import { DatabaseSync } from 'node:sqlite';
// The query builder is the served one (shared/keyword-index.mts), so the
// eval measures the words readers' questions become.
import { ftsQuery } from '../dist/shared/keyword-index.mjs';

export { ftsQuery };

const stripUrls = (text) =>
  String(text || '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ');

export function parseFtsOptions(spec = '') {
  const options = { tokenizer: 'porter', weights: [1, 1, 1], query: 'nostop', urls: 'keep', merge: 'raw' };
  for (const pair of String(spec).split(',').filter(Boolean)) {
    const [key, value] = pair.split('=');
    if (key === 'weights') options.weights = value.split(':').map(Number);
    else if (key in options) options[key] = value;
    else throw new Error(`fts option ${key} is unknown`);
  }
  if (!['unicode61', 'porter'].includes(options.tokenizer)) throw new Error(`tokenizer ${options.tokenizer}`);
  if (!['or', 'nostop', 'phrase', 'adjacent'].includes(options.query)) throw new Error(`query ${options.query}`);
  if (!['keep', 'strip'].includes(options.urls)) throw new Error(`urls ${options.urls}`);
  if (!['raw', 'max', 'global'].includes(options.merge)) throw new Error(`merge ${options.merge}`);
  if (options.weights.length !== 3 || options.weights.some((w) => !(w > 0))) throw new Error('weights a:b:c');
  return options;
}

export function fts5Engine(spec = '') {
  const options = parseFtsOptions(spec);
  const tokenize = options.tokenizer === 'porter' ? 'porter unicode61' : 'unicode61';
  const [ws, wh, wt] = options.weights;
  const clean = options.urls === 'strip' ? stripUrls : (value) => String(value || '');
  const rank = `bm25(t, ${ws}, ${wh}, ${wt})`;

  function open(rowsByKind) {
    const db = new DatabaseSync(':memory:');
    db.exec(
      `CREATE VIRTUAL TABLE t USING fts5(subject, section, text, kind UNINDEXED, idx UNINDEXED, tokenize='${tokenize}')`
    );
    const insert = db.prepare('INSERT INTO t(subject, section, text, kind, idx) VALUES (?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    for (const [kind, rows] of rowsByKind) {
      rows.forEach((row, index) => insert.run(clean(row.subject), clean(row.section), clean(row.text), kind, index));
    }
    db.exec('COMMIT');
    return db.prepare(`SELECT idx AS i, -${rank} AS s FROM t WHERE t MATCH ? AND kind = ? ORDER BY ${rank}`);
  }

  const own = new Map();
  const seen = new Map();
  let collecting = false;
  let shared = null;
  function searchFor(kind, rows) {
    if (options.merge === 'global') {
      if (!shared || seen.get(kind) !== rows) throw new Error(`fts5 global: ${kind} was not collected`);
      return shared;
    }
    const held = own.get(kind);
    if (held && held.rows === rows) return held.search;
    const search = open([[kind, rows]]);
    own.set(kind, { rows, search });
    return search;
  }

  function engine(query, kind, rows) {
    if (collecting) {
      seen.set(kind, rows);
      return [];
    }
    const search = searchFor(kind, rows);
    const { match, phrases } = ftsQuery(query, options);
    if (!match) return [];
    const scale = (list) => {
      if (options.merge !== 'max' || !list.length) return list;
      const best = list[0].s || 1;
      return list.map((row) => ({ ...row, s: row.s / best }));
    };
    const out = [];
    const taken = new Set();
    // A phrase match outranks every term match: its score is lifted by a
    // constant larger than any bm25 score here.
    if (phrases.length) {
      for (const row of scale(search.all(phrases.join(' OR '), kind))) {
        taken.add(row.i);
        out.push({ index: Number(row.i), score: 1000 + row.s });
      }
    }
    for (const row of scale(search.all(match, kind))) {
      if (taken.has(row.i)) continue;
      out.push({ index: Number(row.i), score: row.s });
    }
    return out;
  }
  // Global merge: gather every corpus's rows first, then build one index.
  engine.collect = (on) => {
    collecting = on;
    if (!on && options.merge === 'global') shared = open(seen);
  };
  engine.options = options;
  return engine;
}
