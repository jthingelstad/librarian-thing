// The eval measures another keyword engine by handing retrieve() a
// lexicalEngine (docs/PLAN-2026-11-01-keyword-search.md). The engine ranks a
// corpus's rows; retrieve() still applies the scan's filters, the limit and
// the public shape. scripts/fts5-lexical.mjs is the SQLite one it measures.
import assert from 'node:assert/strict';
import test from 'node:test';
import { primeCorpusCachesForTests, retrieve } from '../dist/shared/retrieval.mjs';
import { fts5Engine, ftsQuery, parseFtsOptions } from '../scripts/fts5-lexical.mjs';

process.env.LIBRARIAN_RERANK_ENABLED = '0';

const chunk = (fields) => ({
  issue_number: 1,
  issue_year: 2020,
  publish_date: '2020-01-04',
  topics: [],
  ...fields,
  word_count: String(fields.text).split(/\s+/).length
});
const corpus = (source, chunks) => ({ version: 2, source, chunks, issues: [], topics: [], links: [], media: [] });

function fixtures() {
  return {
    weekly_thing: corpus('weekly_thing', [
      chunk({
        id: 'wt-1:0',
        source_kind: 'weekly_thing',
        subject: 'WT1',
        section: 'Journal',
        text: 'A chess session with Kasparov at the lake.'
      }),
      chunk({
        id: 'wt-2:0',
        source_kind: 'weekly_thing',
        issue_number: 2,
        issue_year: 2021,
        publish_date: '2021-01-02',
        subject: 'WT2',
        section: 'Notable',
        text: 'Kasparov sessions on chess openings, and a canoe.'
      }),
      chunk({
        id: 'wt-3:0',
        source_kind: 'weekly_thing',
        issue_number: 3,
        subject: 'WT3',
        section: 'Briefly',
        text: 'Nothing about games here, only canoes.'
      })
    ]),
    blog: corpus('blog', [
      chunk({
        id: 'blog-9:0',
        source_kind: 'blog',
        post_id: 9,
        url: 'https://www.thingelstad.com/2020/01/04/a.html',
        subject: 'The mini Minnebar',
        section: '',
        text: 'Attending the mini Minnebar online.'
      })
    ]),
    podcast: corpus('podcast', [])
  };
}

test('a lexicalEngine replaces the TF-IDF scan; filters and the limit still hold', async () => {
  primeCorpusCachesForTests(fixtures());
  const asked = [];
  // Ranks every row, last first, so its order is plainly not TF-IDF's.
  const engine = (query, kind, rows) => {
    asked.push(kind);
    return rows.map((_, index) => ({ index, score: index + 1 })).reverse();
  };
  const rows = await retrieve(
    'anything',
    10,
    { scope: 'weekly_thing' },
    { rerank: false, engines: ['lexical'], lexicalEngine: engine }
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ['wt-3:0', 'wt-2:0', 'wt-1:0']
  );
  assert.ok(asked.includes('weekly_thing'));
  assert.ok(rows.every((row) => !Object.keys(row).some((key) => key.startsWith('_') && key !== '_retrieval_score')));
  const in2020 = await retrieve(
    'anything',
    10,
    { scope: 'weekly_thing', yearRange: [2020, 2020] },
    { rerank: false, engines: ['lexical'], lexicalEngine: engine }
  );
  assert.deepEqual(
    in2020.map((row) => row.id),
    ['wt-3:0', 'wt-1:0'],
    'the year filter drops WT2'
  );
  const one = await retrieve(
    'anything',
    1,
    { scope: 'weekly_thing' },
    { rerank: false, engines: ['lexical'], lexicalEngine: engine }
  );
  assert.equal(one.length, 1);
});

test('the FTS5 engine stems, ranks an in-order phrase first, and filters by corpus', async () => {
  primeCorpusCachesForTests(fixtures());
  const engine = fts5Engine('tokenizer=porter,query=adjacent');
  const run = (query, scope = 'weekly_thing') =>
    retrieve(query, 10, { scope }, { rerank: false, engines: ['lexical'], lexicalEngine: engine });
  // WT1 says "chess session"; WT2 says "sessions on chess", out of order.
  const stemmed = (await run('chess session')).map((row) => row.id);
  assert.equal(stemmed[0], 'wt-1:0', 'the words in order rank first');
  assert.ok(stemmed.includes('wt-2:0'), 'porter finds "sessions" for "session"');
  assert.ok(!stemmed.includes('wt-3:0'));
  const inflected = (await run('kasparov session')).map((row) => row.id);
  assert.equal(inflected[0], 'wt-2:0', '"Kasparov sessions" is the phrase once stemmed');
  const quoted = (await run('"chess openings" kasparov')).map((row) => row.id);
  assert.equal(quoted[0], 'wt-2:0', 'a quoted span is a phrase that ranks first');
  const unstemmed = fts5Engine('tokenizer=unicode61,query=nostop');
  const exact = await retrieve(
    'sessions',
    10,
    { scope: 'weekly_thing' },
    { rerank: false, engines: ['lexical'], lexicalEngine: unstemmed }
  );
  assert.deepEqual(
    exact.map((row) => row.id),
    ['wt-2:0']
  );
});

test('a global FTS5 index must see every corpus first', async () => {
  primeCorpusCachesForTests(fixtures());
  const engine = fts5Engine('merge=global');
  await assert.rejects(
    () => retrieve('minnebar', 5, { scope: 'all' }, { rerank: false, engines: ['lexical'], lexicalEngine: engine }),
    /was not collected/
  );
  engine.collect(true);
  await retrieve('collect', 1, { scope: 'all' }, { rerank: false, engines: ['lexical'], lexicalEngine: engine });
  engine.collect(false);
  const rows = await retrieve(
    'the mini minnebar',
    5,
    { scope: 'all' },
    { rerank: false, engines: ['lexical'], lexicalEngine: engine }
  );
  assert.equal(rows[0]?.id, 'blog-9:0');
});

test("a reader's words never become FTS5 syntax", () => {
  const options = parseFtsOptions('query=phrase');
  assert.deepEqual(ftsQuery('cats NOT dogs OR "near" * -x', options), {
    match: '"cats" OR "dogs" OR "near" OR "x"',
    phrases: []
  });
  assert.deepEqual(ftsQuery('the "mini minnebar" event', options).phrases, ['"mini" + "minnebar"']);
  assert.deepEqual(ftsQuery('the of', options).match, '"the" OR "of"', 'all stopwords: keep them');
  assert.throws(() => parseFtsOptions('tokenizer=trigram'), /tokenizer/);
  assert.throws(() => parseFtsOptions('weights=1:0:1'), /weights/);
});
