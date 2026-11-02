// The keyword index (shared/keyword-index.mts): one FTS5 file over every
// corpus, the served keyword leg (docs/PLAN-2026-11-01-keyword-search.md).
// The query builder never passes a reader's words through as FTS5 syntax, a
// phrase ranks first, a corpus's search reads only its own rows, and
// retrieval keeps the TF-IDF scan, logged as keyword_index_unavailable, when
// the index is missing, broken or built from other corpora.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { s3 } from '../dist/shared/aws-clients.mjs';
import { ftsQuery, openKeywordIndex, writeKeywordIndex } from '../dist/shared/keyword-index.mjs';
import {
  keywordIndexProbe,
  keywordIndexSources,
  primeCorpusCachesForTests,
  retrieve
} from '../dist/shared/retrieval.mjs';
import { keywordIndexCoverage } from '../scripts/keyword-index-coverage.mjs';

process.env.LIBRARIAN_RERANK_ENABLED = '0';

const chunk = (fields) => ({
  issue_number: 1,
  issue_year: 2020,
  publish_date: '2020-01-04',
  topics: [],
  ...fields,
  word_count: String(fields.text).split(/\s+/).length
});
const corpus = (source, chunks, generated_at = '2026-11-02T12:00:00Z') => ({
  version: 2,
  source,
  generated_at,
  chunks,
  issues: [],
  topics: [],
  links: [],
  media: []
});

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
      }),
      // An older build's copy of a site page: the reference base holds it.
      chunk({ id: 'site:about:0', source_kind: 'site_page', subject: 'About', section: '', text: 'About the canoe.' })
    ]),
    blog: corpus('blog', [
      chunk({
        id: 'blog:9:0:aa',
        source_kind: 'blog',
        post_id: 9,
        url: 'https://www.thingelstad.com/2020/01/04/a.html',
        subject: 'The mini Minnebar',
        section: '',
        text: 'Attending the mini Minnebar online.'
      })
    ]),
    podcast: corpus('podcast', []),
    reference: corpus('reference', [
      chunk({ id: 'site:about:0', source_kind: 'site_page', subject: 'About', section: '', text: 'About the canoe.' })
    ]),
    link: corpus('link', [])
  };
}

function captureLogs() {
  const logged = [];
  const original = console.log;
  console.log = (line) => logged.push(String(line));
  return {
    events: () => logged.flatMap((line) => (line.startsWith('{') ? [JSON.parse(line)] : [])),
    restore: () => {
      console.log = original;
    }
  };
}

const scratch = () => mkdtempSync(path.join(tmpdir(), 'keyword-index-test-'));

// The fixtures primed, their index built and named, as a deploy leaves it.
async function servedIndex(corpora = fixtures()) {
  const dir = scratch();
  primeCorpusCachesForTests(corpora);
  const file = path.join(dir, 'keyword_index.db');
  await writeKeywordIndex(file, await keywordIndexSources(), '2026-11-02T13:00:00Z');
  primeCorpusCachesForTests(corpora);
  process.env.KEYWORD_INDEX_PATH = file;
  return { dir, file };
}

const lexical = (query, filters = { scope: 'weekly_thing' }, limit = 10) =>
  retrieve(query, limit, filters, { rerank: false, engines: ['lexical'] });

test("a reader's words become quoted terms, a phrase and nothing else", () => {
  assert.deepEqual(ftsQuery('cats NOT dogs OR "near" * -x', { query: 'phrase' }), {
    match: '"cats" OR "dogs" OR "near" OR "x"',
    phrases: []
  });
  // adjacent (served): an unquoted query of two or more words is a phrase.
  assert.deepEqual(ftsQuery('the mini Minnebar'), {
    match: '"mini" OR "minnebar"',
    phrases: ['"the" + "mini" + "minnebar"']
  });
  // A quoted span is the phrase, and the rest is not.
  assert.deepEqual(ftsQuery('the “mini minnebar” event').phrases, ['"mini" + "minnebar"']);
  assert.equal(ftsQuery('the of').match, '"the" OR "of"', 'all stopwords: keep them');
  assert.equal(ftsQuery('the of', { query: 'or' }).match, '"the" OR "of"');
  assert.deepEqual(ftsQuery('  -- * '), { match: '', phrases: [] });
  assert.equal(ftsQuery('"say ""hi"""').match, '"say" OR "hi"', 'a double quote is never syntax');
});

test('the index ranks the phrase first and searches one corpus at a time', async () => {
  const dir = scratch();
  try {
    const file = path.join(dir, 'keyword_index.db');
    const meta = await writeKeywordIndex(
      file,
      [
        {
          kind: 'weekly_thing',
          generated_at: 'w1',
          rows: [
            { id: 'a', subject: 'WT1', text: 'chess and a long session of something' },
            { id: 'b', subject: 'WT2', text: 'a chess session' }
          ]
        },
        { kind: 'blog', generated_at: '', rows: [{ id: 'c', subject: 'Chess', text: 'chess session notes' }] }
      ],
      '2026-11-02T13:00:00Z'
    );
    assert.deepEqual(meta.kinds, {
      weekly_thing: { rows: 2, generated_at: 'w1' },
      blog: { rows: 1, generated_at: null }
    });
    const index = await openKeywordIndex(file);
    try {
      const hits = [...index.search('chess session', 'weekly_thing')];
      assert.deepEqual(
        hits.map((hit) => hit.id),
        ['b', 'a'],
        'the words in order outrank the words apart'
      );
      assert.ok(hits[0].score > 1000 && hits[1].score < 1000 && hits[1].score > 0);
      assert.deepEqual(
        [...index.search('notes', 'weekly_thing')],
        [],
        "the blog's rows are not the Weekly Thing's"
      );
      assert.deepEqual(
        [...index.search('notes', 'blog')].map((hit) => hit.id),
        ['c']
      );
      assert.deepEqual([...index.search('', 'blog')], []);
      // A search abandoned part way (retrieval stops at its limit) leaves
      // the statements usable for the next.
      for (const hit of index.search('chess', 'weekly_thing')) {
        assert.ok(hit.id);
        break;
      }
      assert.equal([...index.search('chess session', 'weekly_thing')].length, 2);
      assert.deepEqual([...index.entries()].map(({ kind, id }) => `${kind}:${id}`).sort(), [
        'blog:c',
        'weekly_thing:a',
        'weekly_thing:b'
      ]);
    } finally {
      index.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the index refuses rows it could not name, and opens only its own schema', async () => {
  const dir = scratch();
  try {
    const write = (name, sources) => writeKeywordIndex(path.join(dir, name), sources);
    await assert.rejects(() => write('1.db', [{ kind: 'blog', rows: [{ text: 'x' }] }]), /has no id/);
    await assert.rejects(
      () => write('2.db', [{ kind: 'blog', rows: [{ id: 1 }, { id: '1' }] }]),
      /row 1 appears twice/
    );
    await assert.rejects(
      () =>
        write('3.db', [
          { kind: 'blog', rows: [] },
          { kind: 'blog', rows: [] }
        ]),
      /blog given twice/
    );
    const { DatabaseSync } = await import('node:sqlite');
    const other = path.join(dir, 'other.db');
    const db = new DatabaseSync(other);
    db.exec(
      "CREATE VIRTUAL TABLE t USING fts5(subject, section, text, kind UNINDEXED, id UNINDEXED); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('index', '{\"schema\":99}');"
    );
    db.close();
    await assert.rejects(() => openKeywordIndex(other), /schema 99, expected 1/);
    await assert.rejects(() => openKeywordIndex(path.join(dir, 'missing.db')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retrieval reads the keyword index: phrase first, filters and the corpus held', async () => {
  const { dir } = await servedIndex();
  const logs = captureLogs();
  try {
    const rows = await lexical('chess session');
    assert.deepEqual(
      rows.map((row) => row.id),
      ['wt-1:0', 'wt-2:0'],
      'WT1 says "chess session"; porter finds "sessions" in WT2'
    );
    assert.ok(rows.every((row) => !('embedding' in row) && row._retrieval_score > 0));
    const in2020 = await lexical('kasparov', { scope: 'weekly_thing', yearRange: [2020, 2020] });
    assert.deepEqual(
      in2020.map((row) => row.id),
      ['wt-1:0'],
      'the year filter drops WT2'
    );
    assert.equal((await lexical('chess', { scope: 'weekly_thing' }, 1)).length, 1, 'the limit holds');
    assert.deepEqual(await lexical('minnebar'), [], "a Weekly Thing search never reads the blog's rows");
    const everywhere = await lexical('the mini minnebar', { scope: 'all' });
    assert.equal(everywhere[0]?.id, 'blog:9:0:aa');
    // The reference base is scanned once, from its own corpus.
    const about = await lexical('canoe about', { scope: 'all' });
    assert.equal(about.filter((row) => row.id === 'site:about:0').length, 1);
    const events = logs.events();
    const completed = events.filter((event) => event.message === 'retrieval_completed');
    assert.ok(completed.length && completed.every((event) => event.engine === 'fts5'));
    assert.equal(events.filter((event) => event.message === 'keyword_index_loaded').length, 1, 'opened once');
    assert.ok(!events.some((event) => event.message === 'keyword_index_unavailable'));
  } finally {
    logs.restore();
    delete process.env.KEYWORD_INDEX_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an index built from other corpora is not read: TF-IDF, logged as stale', async () => {
  const { dir } = await servedIndex();
  // The same rows, another build of the Weekly Thing corpus.
  const rebuilt = fixtures();
  rebuilt.weekly_thing.generated_at = '2026-11-03T12:00:00Z';
  primeCorpusCachesForTests(rebuilt);
  const logs = captureLogs();
  try {
    const rows = await lexical('chess session');
    assert.ok(rows.some((row) => row.id === 'wt-1:0'), 'the TF-IDF scan still answers');
    const events = logs.events();
    const stale = events.filter((event) => event.message === 'keyword_index_unavailable');
    assert.equal(stale.length, 1);
    assert.equal(stale[0].level, 'error');
    assert.equal(stale[0].reason, 'stale');
    assert.equal(stale[0].corpus, 'weekly_thing');
    assert.equal(stale[0].index_generated_at, '2026-11-02T12:00:00Z');
    assert.equal(stale[0].corpus_generated_at, '2026-11-03T12:00:00Z');
    assert.ok(events.filter((event) => event.message === 'retrieval_completed').every((e) => e.engine === 'tf-idf'));
    await lexical('kasparov');
    assert.equal(
      logs.events().filter((event) => event.message === 'keyword_index_unavailable').length,
      1,
      'decided once per container'
    );
  } finally {
    logs.restore();
    delete process.env.KEYWORD_INDEX_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an index that will not open leaves retrieval on TF-IDF, logged; none configured is quiet', async () => {
  primeCorpusCachesForTests(fixtures());
  process.env.KEYWORD_INDEX_PATH = path.join(tmpdir(), 'no-such-dir', 'keyword_index.db');
  let logs = captureLogs();
  try {
    assert.ok((await lexical('chess')).length);
    const failed = logs.events().filter((event) => event.message === 'keyword_index_unavailable');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].level, 'error');
    assert.equal(failed[0].reason, 'open_failed');
    assert.deepEqual(await keywordIndexProbe(), { ok: false, engine: 'tf-idf', reason: 'open_failed' });
  } finally {
    logs.restore();
    delete process.env.KEYWORD_INDEX_PATH;
  }
  primeCorpusCachesForTests(fixtures());
  logs = captureLogs();
  try {
    assert.ok((await lexical('chess')).length);
    const events = logs.events();
    assert.ok(!events.some((event) => event.message === 'keyword_index_unavailable'));
    assert.equal(events.find((event) => event.message === 'keyword_index_disabled')?.level, 'info');
    assert.deepEqual(await keywordIndexProbe(), { ok: false, engine: 'tf-idf', reason: 'unconfigured' });
  } finally {
    logs.restore();
  }
});

test('the Lambda downloads the index from S3, gzipped or plain', async () => {
  const { dir, file } = await servedIndex();
  delete process.env.KEYWORD_INDEX_PATH;
  const bytes = readFileSync(file);
  const priorSend = s3.send;
  const asked = [];
  process.env.CORPUS_BUCKET = 'bucket-fixture';
  process.env.KEYWORD_INDEX_KEY = 'artifacts/keyword_index.db';
  try {
    for (const body of [
      () => Readable.from([gzipSync(bytes).subarray(0, 10), gzipSync(bytes).subarray(10)]),
      () => ({ transformToByteArray: async () => new Uint8Array(bytes) })
    ]) {
      primeCorpusCachesForTests(fixtures());
      s3.send = async (command) => {
        asked.push(command.input);
        return { Body: body() };
      };
      const probe = await keywordIndexProbe();
      assert.equal(probe.ok, true);
      assert.equal(probe.engine, 'fts5');
      assert.equal(probe.rows, 5);
      assert.deepEqual(probe.top && Object.keys(probe.top).sort(), ['id', 'kind']);
      assert.deepEqual(
        (await lexical('chess session')).map((row) => row.id),
        ['wt-1:0', 'wt-2:0']
      );
    }
    assert.deepEqual(asked, [
      { Bucket: 'bucket-fixture', Key: 'artifacts/keyword_index.db' },
      { Bucket: 'bucket-fixture', Key: 'artifacts/keyword_index.db' }
    ]);
  } finally {
    s3.send = priorSend;
    delete process.env.CORPUS_BUCKET;
    delete process.env.KEYWORD_INDEX_KEY;
    primeCorpusCachesForTests(fixtures());
    rmSync(path.join(tmpdir(), 'keyword_index.db'), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the coverage oracle names what an index is missing, holds extra or was built from', async () => {
  const { dir, file } = await servedIndex();
  delete process.env.KEYWORD_INDEX_PATH;
  try {
    const corpora = fixtures();
    const covered = keywordIndexCoverage(file, corpora);
    assert.deepEqual(covered.problems, []);
    assert.deepEqual(covered.counts, { weekly_thing: 3, blog: 1, podcast: 0, reference: 1, link: 0 });

    const grown = fixtures();
    grown.blog.chunks.push({ ...grown.blog.chunks[0], id: 'blog:10:0:bb' });
    grown.weekly_thing.chunks = grown.weekly_thing.chunks.filter((row) => row.id !== 'wt-3:0');
    grown.link.generated_at = '2026-11-03T00:00:00Z';
    const { problems } = keywordIndexCoverage(file, grown);
    assert.ok(problems.includes('blog: 1 rows not in the index (blog:10:0:bb)'), problems.join('\n'));
    assert.ok(problems.includes('weekly_thing: 1 index rows not in the corpus (wt-3:0)'), problems.join('\n'));
    assert.ok(problems.some((problem) => problem.startsWith('link: the index was built from the corpus of')));

    // With no reference base the Weekly Thing's own copy of a site page is
    // one of its rows, and an index without it is short.
    const noReference = fixtures();
    delete noReference.reference;
    assert.ok(
      keywordIndexCoverage(file, noReference).problems.includes(
        'weekly_thing: 1 rows not in the index (site:about:0)'
      )
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
