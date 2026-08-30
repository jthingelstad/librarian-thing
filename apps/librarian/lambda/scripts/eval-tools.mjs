#!/usr/bin/env node
/**
 * Tool-surface eval: response invariants + known-answer fixtures over the
 * REAL corpus, run on every deploy, failing the build on violations.
 * Layer 1 (matcher unit fixtures) lives in tests/matcher.test.mjs; this
 * script is layers 2 and 3.
 *
 * Corpus source: EVAL_CORPUS_DIR (corpus.json / blog_corpus.json /
 * podcast_corpus.json as plain JSON) or S3 via CORPUS_BUCKET credentials.
 * Code under test: EVAL_DIST_DIR (default ../dist) - point it at an older
 * build to produce a pre-change report.
 *
 * Baseline: eval/baseline.json holds expected counts for fixture queries.
 * A matcher change that silently moves recall shows up as a diff to
 * review. Counts outside a 10% band fail; run with --update-baseline to
 * accept a reviewed change. Known-answer identities (first ENS post etc.)
 * are exact and never auto-accepted.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.env.EVAL_DIST_DIR || path.join(here, '..', 'dist');
const baselinePath = path.join(here, '..', 'eval', 'baseline.json');
const updateBaseline = process.argv.includes('--update-baseline');
const allowNetwork = process.env.EVAL_ALLOW_NETWORK === '1';

const { ARCHIVE_TOOLS } = await import(path.join(distDir, 'shared/archive-tools.mjs'));
const { primeCorpusCachesForTests } = await import(path.join(distDir, 'shared/retrieval.mjs'));

// --- corpus loading -------------------------------------------------------
async function loadCorpora() {
  const dir = process.env.EVAL_CORPUS_DIR;
  const fromFile = (name) => {
    const file = path.join(dir, name);
    if (!existsSync(file)) return undefined;
    const raw = readFileSync(file);
    const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    return JSON.parse(text);
  };
  if (dir) {
    return {
      weekly_thing: fromFile('corpus.json'),
      blog: fromFile('blog_corpus.json'),
      podcast: fromFile('podcast_corpus.json')
    };
  }
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({});
  const bucket = process.env.CORPUS_BUCKET || 'weekly-thing-librarian';
  const fetchKey = async (key) => {
    try {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const bytes = Buffer.from(await response.Body.transformToByteArray());
      const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
      return JSON.parse(text);
    } catch (error) {
      console.log(`corpus ${key} unavailable: ${error.name}`);
      return undefined;
    }
  };
  return {
    weekly_thing: await fetchKey('artifacts/corpus.json'),
    blog: await fetchKey('artifacts/blog_corpus.json'),
    podcast: await fetchKey('artifacts/podcast_corpus.json')
  };
}

// --- reporting ------------------------------------------------------------
const failures = [];
const passes = [];
function check(name, condition, detail = '') {
  if (condition) {
    passes.push(name);
  } else {
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

// --- generic response invariants ------------------------------------------
function walk(value, visit, keyPath = '') {
  visit(value, keyPath);
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit, keyPath);
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) walk(entry, visit, keyPath ? `${keyPath}.${key}` : key);
  }
}

function checkInvariants(tool, args, response) {
  const label = (name) => `${tool} :: ${name}`;
  const serialized = JSON.stringify(response);
  check(label('serializes'), Boolean(serialized));

  // scope / source_kind echo
  if (args.source_kind && 'source_kind' in response) {
    check(label('source_kind echo'), response.source_kind === args.source_kind, String(response.source_kind));
  }
  if (args.source_kind && 'scope' in response) {
    check(label('scope reflects filter'), response.scope === args.source_kind, String(response.scope));
  }
  // match_mode echo
  if (args.match_mode && 'match_mode' in response) {
    check(label('match_mode echo'), response.match_mode === args.match_mode, String(response.match_mode));
  }

  const byId = response.sources_by_id;
  if (byId && typeof byId === 'object') {
    // Every referenced id resolves or is explicitly marked unresolved.
    const kept = new Set(Object.keys(byId));
    const dangling = [];
    walk(response, (value, keyPath) => {
      if (typeof value === 'string' && /^(wt|blog|ep)-/.test(value) && !keyPath.endsWith('sources_by_id')) {
        if (/(^|\.)(timeline|latest_sources|results|sample_sources|first|latest)$/.test(keyPath) && !kept.has(value)) {
          dangling.push(`${keyPath}:${value}`);
        }
      }
    });
    check(label('all referenced ids resolve'), dangling.length === 0, dangling.slice(0, 5).join(', '));

    // No full record serialized twice.
    for (const [id, record] of Object.entries(byId)) {
      const needle = JSON.stringify(record);
      const first = serialized.indexOf(needle);
      const second = serialized.indexOf(needle, first + 1);
      check(label(`record ${id} appears once`), second === -1);
    }

    // Every evidence snippet contains its matched span (the round-four
    // assertion - this single check caught the round-five P0).
    for (const record of Object.values(byId)) {
      for (const entry of record.evidence || []) {
        check(
          label('evidence contains matched span'),
          String(entry.text || '')
            .toLowerCase()
            .includes(String(entry.matched || '').toLowerCase()),
          `"${entry.matched}" not in "${String(entry.text).slice(0, 80)}"`
        );
      }
    }
  }

  // Truncation markers: only where more than 3 entries were cut, and
  // top-level notes name only real parameters.
  walk(response, (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'omitted' in value && 'note' in value) {
      check(label('marker economics'), Number(value.omitted) > 3, `omitted=${value.omitted}`);
    }
  });
}

// --- run ------------------------------------------------------------------
const corpora = await loadCorpora();
if (!corpora.weekly_thing) {
  console.error('eval-tools: no weekly_thing corpus available; set EVAL_CORPUS_DIR or AWS credentials');
  process.exit(2);
}
primeCorpusCachesForTests(corpora);

const counts = {};
async function run(tool, args, options = {}) {
  const handler = ARCHIVE_TOOLS[tool];
  if (!handler) {
    failures.push(`${tool} :: missing from registry`);
    return null;
  }
  const response = await handler(args, { scope: options.scope || 'all' });
  if (response?.error && !options.expectError) {
    failures.push(`${tool} :: unexpected error: ${response.error}`);
    return response;
  }
  checkInvariants(tool, args, response || {});
  return response;
}

// Schema completeness: every parameter the server accepts AND echoes in
// responses must appear in the published schema. This is the invariant
// that let a working, advisory-recommended parameter (case_sensitive)
// stay invisible through a green run - a schema gap is now a failure,
// not archaeology.
{
  const { toolSpecs } = await import(path.join(distDir, 'shared/archive-tools.mjs'));
  const published = new Map(
    toolSpecs()
      .map((spec) => spec.toolSpec)
      .filter(Boolean)
      .map((spec) => [spec.name, new Set(Object.keys(spec.inputSchema?.json?.properties || {}))])
  );
  const EXPECTED_PARAMS = {
    archive_lens: ['topic', 'operation', 'match_mode', 'case_sensitive', 'source_kind', 'year_range', 'limit'],
    entity_lens: ['entity', 'operation', 'match_mode', 'case_sensitive', 'source_kind', 'year_range', 'limit'],
    list_content: ['topic', 'match_mode', 'case_sensitive', 'source_kind', 'year_range', 'limit'],
    find_links: ['topic', 'match_mode', 'case_sensitive', 'source_kind', 'year_range', 'limit'],
    corpus_stats: ['source_kind', 'year_range', 'limit'],
    top_references: ['source_kind', 'year_start', 'year_end', 'limit', 'include_utility'],
    quote_search: ['phrase', 'limit'],
    media_search: ['query', 'year', 'limit'],
    get_source: ['issue_number', 'section', 'source_kind']
  };
  for (const [tool, params] of Object.entries(EXPECTED_PARAMS)) {
    const schema = published.get(tool);
    check(`schema exists for ${tool}`, Boolean(schema));
    for (const param of params) {
      check(`${tool} publishes ${param}`, Boolean(schema?.has(param)));
    }
  }
  // Echo-side: any input-named key echoed in responses must be published.
  const ECHO_KEYS = ['match_mode', 'case_sensitive', 'source_kind', 'year_range', 'limit'];
  const lens = await ARCHIVE_TOOLS.archive_lens({ topic: 'ethereum', match_mode: 'exact' }, { scope: 'weekly_thing' });
  for (const key of ECHO_KEYS) {
    if (key in lens && lens[key] !== undefined && lens[key] !== null) {
      check(`archive_lens echoes only published params (${key})`, Boolean(published.get('archive_lens')?.has(key)));
    }
  }
}

// Layer 3: known answers - the archive is stable history.
{
  const lens = await run('entity_lens', { entity: 'Ethereum', source_kind: 'weekly_thing', operation: 'first_last' });
  const firstId = typeof lens.first === 'string' ? lens.first : lens.first?.id;
  check('KA first Ethereum WT mention is issue 17 (Sept 2017)', firstId === 'wt-17', String(firstId));
  check('KA first Ethereum is NOT issue 5', firstId !== 'wt-5');
  counts.ethereum_wt_sources = lens.total_sources;
  counts.ethereum_wt_evidence = lens.total_evidence_matches;
}
{
  const lens = await run('entity_lens', { entity: 'ENS', source_kind: 'blog', operation: 'first_last' });
  const firstId = typeof lens.first === 'string' ? lens.first : lens.first?.id;
  const first = lens.sources_by_id[firstId];
  check(
    'KA first ENS blog post is 2021-04-10 registration',
    String(first?.publish_date) === '2021-04-10',
    String(first?.publish_date)
  );
  check(
    'KA ENS aliases reported',
    Array.isArray(lens.aliases_checked) && lens.aliases_checked.includes('Ethereum Name Service')
  );
  counts.ens_blog_sources = lens.total_sources;
  counts.ens_blog_evidence = lens.total_evidence_matches;
}
{
  const lens = await run('entity_lens', { entity: 'ENS', source_kind: 'weekly_thing', operation: 'first_last' });
  const firstId = typeof lens.first === 'string' ? lens.first : lens.first?.id;
  check('KA first ENS WT mention is issue 182', firstId === 'wt-182', String(firstId));
  counts.ens_wt_sources = lens.total_sources;
}
{
  const quotes = await run('quote_search', { phrase: 'blog pensieve' });
  const wtIssues = quotes.results
    .filter((row) => row.source_kind === 'weekly_thing')
    .map((row) => Number(row.issue_number));
  check(
    'KA pensieve WT issues are exactly 314 and 317',
    JSON.stringify([...wtIssues].sort((a, b) => a - b)) === '[314,317]',
    JSON.stringify(wtIssues)
  );
  check(
    'KA pensieve WT rows name their sections',
    quotes.results.filter((row) => row.source_kind === 'weekly_thing').every((row) => row.section),
    JSON.stringify(quotes.results.map((row) => row.section))
  );
  check(
    'KA pensieve includes the 2024-07-14 blog post',
    quotes.results.some((row) => row.source_kind === 'blog' && String(row.publish_date).startsWith('2024-07-14'))
  );
}
{
  const refs = await run('top_references', { source_kind: 'weekly_thing', limit: 10 });
  check(
    'KA top_references weekly_thing first_seen never before 2017-05-13',
    refs.top.every((entry) => entry.first_seen >= '2017-05-13'),
    JSON.stringify(refs.top.map((entry) => entry.first_seen).slice(0, 3))
  );
  check(
    'KA biggreenegg.com absent from weekly_thing references',
    !refs.top.some((entry) => entry.domain === 'biggreenegg.com')
  );

  // Cross-tool consistency: domain counts agree with corpus_stats.
  const stats = await run('corpus_stats', { source_kind: 'weekly_thing' });
  const statsDomains = new Map(
    (stats.sources?.[0]?.top_domains || []).filter((row) => row.domain).map((row) => [row.domain, row.count])
  );
  const refDomains = new Map(refs.top.map((entry) => [entry.domain, entry.count]));
  let compared = 0;
  for (const [domain, count] of statsDomains) {
    if (!refDomains.has(domain)) continue;
    compared += 1;
    check(
      `cross-tool count agrees for ${domain}`,
      refDomains.get(domain) === count,
      `${refDomains.get(domain)} vs ${count}`
    );
  }
  check('cross-tool comparison exercised', compared >= 3, String(compared));
}
{
  const first = await run('archive_gems', { limit: 3 }, { scope: 'weekly_thing' });
  const second = await run('archive_gems', { limit: 3 }, { scope: 'weekly_thing' });
  const draw = (gems) => gems.results.map((gem) => gem.issue_number ?? gem.subject).join(',');
  check('KA gems draws vary', draw(first) !== draw(second), draw(first));
  check(
    'KA gems disclose sampling',
    first.results.every((gem) => /randomly drawn from \d+ qualifying/.test(gem.reason))
  );
  check(
    'KA gems cap domains at 5',
    first.results.every((gem) => (gem.domains || []).length <= 5)
  );
}
{
  // Per-hit strictness: first_last under stem, for a term whose corpus
  // hits are literal, must equal the exact-mode first (round-seven P0).
  const exact = await run('entity_lens', { entity: 'Ethereum', source_kind: 'weekly_thing', operation: 'first_last' });
  const stem = await run('archive_lens', {
    topic: 'ethereum',
    match_mode: 'stem',
    source_kind: 'weekly_thing',
    operation: 'first_last'
  });
  const idOf = (value) => (typeof value === 'string' ? value : value?.id);
  check('KA stem first_last finds literal hits', Boolean(idOf(stem.first)), String(stem.first));
  check(
    'KA stem first equals exact first',
    idOf(stem.first) === idOf(exact.first),
    `${idOf(stem.first)} vs ${idOf(exact.first)}`
  );
  check('KA stem echo honest', stem.match_mode === 'stem', String(stem.match_mode));
}
{
  // Common-word advisory fires for undifferentiated terms.
  const go = await run('archive_lens', {
    topic: 'go',
    source_kind: 'weekly_thing',
    operation: 'first_last',
    year_range: [2017, 2017]
  });
  check(
    'KA common-word advisory present for go/2017',
    /undifferentiated/.test(String(go.term_frequency_note || '')),
    String(go.term_frequency_note).slice(0, 60)
  );
  const goCase = await run('archive_lens', {
    topic: 'Go',
    case_sensitive: true,
    source_kind: 'weekly_thing',
    year_range: [2017, 2017]
  });
  check(
    'KA case_sensitive Go narrows results',
    Number(goCase.total_sources) < Number(go.total_sources),
    `${goCase.total_sources} vs ${go.total_sources}`
  );
}
{
  // Recall snapshots for heavy topics - precision changes surface as
  // reviewable baseline diffs.
  for (const topic of ['POAP', 'RSS', 'OmniFocus']) {
    const lens = await run('entity_lens', { entity: topic }, { scope: 'all' });
    counts[`recall_${topic.toLowerCase()}_sources`] = lens.total_sources;
  }
}
{
  const lens = await run('archive_lens', { topic: 'ethereum', limit: 4 }, { scope: 'weekly_thing' });
  const size = JSON.stringify(lens).length;
  check('archive_lens(limit=4) under budget', size <= 26000, `${size} chars`);
  check(
    'archive_lens full counts_by_year',
    (lens.counts_by_year || []).every((row) => !('omitted' in row))
  );
  counts.ethereum_lens_sources = lens.total_sources;
}

// Layer 2 breadth: every registry tool exercised at least once.
await run('search_archive', { query: 'data ownership', limit: 4 });
await run('get_source', { issue_number: '321', section: 'Notable', source_kind: 'weekly_thing' }).then((out) => {
  check(
    'KA get_source Notable prose present',
    String(out?.source?.body || '').length > 200,
    `body ${String(out?.source?.body || '').length} chars`
  );
  check(
    'KA get_source Notable links filtered',
    (out?.source?.links || []).length > 0 && (out?.source?.links || []).length <= 12
  );
  check('KA get_source section echo', out?.source?.section === 'Notable', String(out?.source?.section));
});
await run('get_issue', { number: '182' });
await run('get_section', { number: '321', section: 'Journal' });
await run('find_links', { topic: 'ethereum', limit: 5 });
await run('domain_history', { domain: 'macstories.net' });
await run('latest_content', { limit: 3 });
await run('list_content', { topic: 'ethereum', match_mode: 'exact', limit: 5 });
await run('list_issues', { topic: 'ethereum', limit: 5 });
await run('compare_eras', { topic: 'ethereum', year_a: [2021, 2021], year_b: [2024, 2024], limit: 2 });
await run('source_neighborhood', { issue_number: '182', limit: 3 });
await run('claim_check', { claim: 'Jamie registered thingelstad.eth in 2021' });
await run('media_search', { query: 'minnehaha creek', limit: 4 });
await run('currently_history', { kind: 'reading', limit: 5 });
await run('search_faq', { query: 'what is the weekly thing' });
if (allowNetwork) {
  await run('fetch_page', { url: 'https://www.thingelstad.com/' });
} else {
  console.log('fetch_page skipped (EVAL_ALLOW_NETWORK != 1)');
}

// server_version presence (belt-and-braces cache signal).
{
  const stats = await run('corpus_stats', { source_kind: 'weekly_thing' });
  check(
    'server_version on corpus_stats',
    /^\d+\.\d+\.\d+\+tools\./.test(String(stats.server_version || '')),
    String(stats.server_version)
  );
}

// --- baseline comparison --------------------------------------------------
if (updateBaseline) {
  writeFileSync(baselinePath, `${JSON.stringify(counts, null, 2)}\n`);
  console.log('baseline updated:', baselinePath);
} else if (existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  for (const [key, expected] of Object.entries(baseline)) {
    const actual = counts[key];
    const drift = Math.abs((actual - expected) / Math.max(expected, 1));
    check(
      `baseline ${key} within 10% (expected ${expected}, got ${actual})`,
      Number.isFinite(actual) && drift <= 0.1,
      'recall moved - review, then run with --update-baseline'
    );
  }
} else {
  failures.push('baseline missing - run with --update-baseline once and commit eval/baseline.json');
}

console.log(`\neval-tools: ${passes.length} checks passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
