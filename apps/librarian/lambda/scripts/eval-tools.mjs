#!/usr/bin/env node
/**
 * Tool-surface eval: response invariants + known-answer fixtures over the
 * REAL corpus, run on every deploy, failing the build on violations.
 * Layer 1 (matcher unit fixtures) lives in tests/matcher.test.mjs; this
 * script is layers 2 and 3.
 *
 * Corpus source: EVAL_CORPUS_DIR (corpus.json / blog_corpus.json /
 * podcast_corpus.json / graph.json as plain or gzipped JSON) or S3 via
 * CORPUS_BUCKET credentials. With EVAL_CORPUS_FALLBACK=s3 a file missing
 * from the dir is read from S3 instead: the deploy's corpus gate stages
 * only the corpora it rebuilt and evals them beside the live rest.
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
// Set by deploy.yml when the push rebuilds a corpus: the recall baseline
// describes the corpora being built, so the corpus gate checks it against
// the candidates, and the code eval over the live corpora checks only the
// invariants and known answers.
const skipBaseline = process.env.EVAL_SKIP_BASELINE === '1';
const allowNetwork = process.env.EVAL_ALLOW_NETWORK === '1';

const { ARCHIVE_TOOLS } = await import(path.join(distDir, 'shared/archive-tools.mjs'));
const { primeCorpusCachesForTests, ...retrieval } = await import(path.join(distDir, 'shared/retrieval.mjs'));
const { mcpToolDeclarations, renderToolCallResult, validateToolArguments } = await import(
  path.join(distDir, 'shared/mcp.mjs')
);
const { runCompletenessChecks } = await import('./eval-completeness.mjs');

// --- corpus loading -------------------------------------------------------
const CORPUS_FILES = {
  weekly_thing: 'corpus.json',
  blog: 'blog_corpus.json',
  podcast: 'podcast_corpus.json',
  // The topic graph feeds list_topics, archive_lens topic cards and
  // similar issues; without it those tools ran degraded in CI.
  graph: 'graph.json'
};

function parseJsonBytes(bytes) {
  const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
  return JSON.parse(text);
}

async function loadCorpora() {
  const dir = process.env.EVAL_CORPUS_DIR;
  const fallback = process.env.EVAL_CORPUS_FALLBACK === 's3';
  let s3;
  const fetchKey = async (key) => {
    if (!s3) {
      const { S3Client } = await import('@aws-sdk/client-s3');
      s3 = new S3Client({});
    }
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const bucket = process.env.CORPUS_BUCKET || 'weekly-thing-librarian';
    try {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return parseJsonBytes(Buffer.from(await response.Body.transformToByteArray()));
    } catch (error) {
      console.log(`corpus ${key} unavailable: ${error.name}`);
      return undefined;
    }
  };
  const corpora = {};
  for (const [kind, name] of Object.entries(CORPUS_FILES)) {
    const file = dir ? path.join(dir, name) : '';
    if (file && existsSync(file)) {
      corpora[kind] = parseJsonBytes(readFileSync(file));
      console.log(`corpus ${name}: ${file}`);
    } else if (!dir || fallback) {
      corpora[kind] = await fetchKey(`artifacts/${name}`);
      if (corpora[kind] && dir) console.log(`corpus ${name}: live S3 copy (not staged)`);
    }
  }
  return corpora;
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

// A known answer that a corpus fix makes true. When this push rebuilds the
// corpus (skipBaseline), the code eval reads the live corpora the fix has
// not reached yet, so it warns; the corpus gate re-runs it on the
// candidates, where it must pass.
function checkCorpus(name, condition, detail = '') {
  if (condition || !skipBaseline) {
    check(name, condition, detail);
    return;
  }
  console.log(`eval-tools: corpus rebuild pending, the gate re-checks: ${name}${detail ? ` :: ${detail}` : ''}`);
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

  // 2.0: what was left out is in one top-level truncated block; no inline
  // {omitted, note} markers and no *_omitted / truncation-note keys.
  walk(response, (value, keyPath) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('omitted' in value && 'note' in value) failures.push(label(`inline truncation marker at ${keyPath}`));
      for (const key of Object.keys(value)) {
        if (/_omitted$|^(results|sources|yearly_signals|body)_note$|^body_truncated$/.test(key)) {
          failures.push(label(`retired key ${keyPath ? `${keyPath}.` : ''}${key}`));
        }
      }
    }
  });
  if (response.truncated) {
    const { omitted = {}, clipped = [], hint } = response.truncated;
    check(label('truncated has a hint'), typeof hint === 'string' && hint.length > 0);
    check(
      label('truncated counts are positive'),
      Object.values(omitted).every((count) => Number.isInteger(count) && count > 0),
      JSON.stringify(omitted)
    );
    check(label('truncated clipped is a list'), Array.isArray(clipped));
  }

  // The MCP door's view: the rendered result conforms to the tool's
  // declared outputSchema (required keys present, every key declared).
  const declaration = mcpToolDeclarations([tool])[0];
  if (declaration?.outputSchema && !response.error) {
    const rendered = renderToolCallResult(tool, response);
    const schema = declaration.outputSchema;
    const body = rendered.structured || {};
    check(label('renders without error'), !rendered.isError, rendered.text.slice(0, 120));
    const missing = (schema.required || []).filter((key) => !(key in body));
    check(label('outputSchema required keys present'), missing.length === 0, missing.join(', '));
    const undeclared = Object.keys(body).filter((key) => !(key in (schema.properties || {})));
    check(label('outputSchema declares every key'), undeclared.length === 0, undeclared.join(', '));
    // A hint that counts a list ("outgoing_links shows 30 of 48") counts
    // what was rendered, after the cap's own cuts (QA2 R2-11: wt-1 said 30
    // and rendered 26).
    const hintText = String(body.truncated?.hint || '');
    const miscounted = [...hintText.matchAll(/\b([a-z_]+) shows (?:the \w+ )?(\d+) of (\d+)/g)]
      .filter((match) => Array.isArray(body[match[1]]) && body[match[1]].length !== Number(match[2]))
      .map((match) => `${match[0]} (rendered ${body[match[1]].length})`);
    check(label('hint counts the rendered list'), miscounted.length === 0, miscounted.join('; '));
    // An id list holding {id, resolved: false} declares object items (QA2 L2-11).
    for (const [key, value] of Object.entries(body)) {
      if (!Array.isArray(value) || !value.some((item) => item && typeof item === 'object' && 'resolved' in item))
        continue;
      const items = [schema.properties?.[key]?.items?.type || []].flat();
      check(label(`${key} items declared string or object`), items.includes('string') && items.includes('object'));
    }
    checkAccounting(tool, body, label);
  }
}

// --- completeness accounting -----------------------------------------------
// Jamie, 2026-09-30: "It is super important that this MCP not silently
// exclude or miss things." An enumerating tool states how many things
// matched (total_count); its page plus what `truncated` says it omitted is
// that total; and every count list partitions it. Checked on the rendered
// result, so the 48K cap's cuts must be accounted for too.
const ENUMERATED_LISTS = {
  find_links: 'results',
  list_content: 'results',
  archive_lens: 'sources_by_id',
  media_search: 'results',
  currently_history: 'entries',
  top_references: 'top',
  quote_search: 'results',
  list_topics: 'topics',
  latest_content: 'results',
  search_faq: 'results'
};
const PARTITIONS = [
  'counts_by_year',
  'counts_by_source',
  'counts_by_kind',
  'counts_by_link_kind',
  'counts_by_link_category'
];

function listedCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function checkAccounting(tool, body, label) {
  const omitted = body.truncated?.omitted || {};
  const listKey = ENUMERATED_LISTS[tool];
  if (listKey) {
    check(label('states total_count'), Number.isInteger(body.total_count), `keys: ${Object.keys(body).join(', ')}`);
    if (Number.isInteger(body.total_count)) {
      const shown = listedCount(body[listKey]) + (omitted[listKey] || 0);
      check(
        label(`${listKey} shown + omitted = total_count`),
        shown === body.total_count,
        `${shown} vs ${body.total_count}`
      );
    }
  }
  if (tool === 'on_this_day' && Array.isArray(body.years)) {
    const listed = body.years.reduce((sum, row) => sum + (row.items || []).length, 0);
    const perYear = body.years.reduce((sum, row) => sum + (row.total_count || 0), 0);
    check(
      label('years[].total_count sum to total_count'),
      perYear === body.total_count,
      `${perYear} vs ${body.total_count}`
    );
    check(
      label('years[].items shown + omitted = total_count'),
      listed + (omitted['years[].items'] || 0) === body.total_count,
      `${listed} + ${omitted['years[].items'] || 0} vs ${body.total_count}`
    );
  }
  if (tool === 'source_neighborhood') {
    // Each list and its count (QA2 links L2-9: related_sources was cut to
    // limit with no count).
    for (const [list, count] of [
      ['outgoing_links', 'outgoing_count'],
      ['incoming_links', 'incoming_count'],
      ['related_sources', 'related_count']
    ]) {
      const shown = (body[list] || []).length + (omitted[list] || 0);
      check(label(`${list} shown + omitted = ${count}`), shown === body[count], `${shown} vs ${body[count]}`);
    }
  }
  if (!Number.isInteger(body.total_count)) return;
  for (const key of PARTITIONS) {
    if (!Array.isArray(body[key]) || omitted[key]) continue;
    // Undated pages are in total_count and in no year (2.4.0).
    const undated = key === 'counts_by_year' ? Number(body.undated_count) || 0 : 0;
    const sum = body[key].reduce((total, row) => total + (Number(row.count) || 0), 0) + undated;
    check(label(`${key} sums to total_count`), sum === body.total_count, `${sum} vs ${body.total_count}`);
  }
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
    archive_lens: [
      'topic',
      'aliases',
      'operation',
      'match_mode',
      'case_sensitive',
      'source_kind',
      'year_range',
      'year',
      'limit'
    ],
    list_content: ['topic', 'match_mode', 'case_sensitive', 'source_kind', 'year_range', 'year', 'limit', 'has_audio'],
    find_links: ['topic', 'match_mode', 'case_sensitive', 'source_kind', 'year_range', 'year', 'limit'],
    corpus_stats: ['source_kind', 'year_range', 'year', 'limit'],
    top_references: ['source_kind', 'year_range', 'year', 'limit', 'include_utility'],
    quote_search: ['phrase', 'limit'],
    media_search: ['query', 'year_range', 'year', 'issue_number', 'limit', 'source_kind', 'match_mode', 'offset'],
    get_source: ['id', 'section', 'format'],
    source_neighborhood: ['id', 'limit'],
    find_evidence: ['claims', 'source_kind', 'voice', 'limit'],
    latest_content: ['source_kind', 'has_also_in_issues', 'also_in_issue', 'has_audio', 'limit', 'offset'],
    on_this_day: ['date', 'window_days', 'year_range', 'year', 'source_kind', 'include_microposts', 'limit_per_year']
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
  const lens = await run('archive_lens', { topic: 'Ethereum', source_kind: 'weekly_thing', operation: 'first_last' });
  const firstId = typeof lens.first === 'string' ? lens.first : lens.first?.id;
  check('KA first Ethereum WT mention is issue 17 (Sept 2017)', firstId === 'wt-17', String(firstId));
  check('KA first Ethereum is NOT issue 5', firstId !== 'wt-5');
  counts.ethereum_wt_sources = lens.total_count;
  counts.ethereum_wt_evidence = lens.total_evidence_matches;
}
{
  const lens = await run('archive_lens', { topic: 'ENS', source_kind: 'blog', operation: 'first_last' });
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
  counts.ens_blog_sources = lens.total_count;
  counts.ens_blog_evidence = lens.total_evidence_matches;
}
{
  const lens = await run('archive_lens', { topic: 'ENS', source_kind: 'weekly_thing', operation: 'first_last' });
  const firstId = typeof lens.first === 'string' ? lens.first : lens.first?.id;
  check('KA first ENS WT mention is issue 182', firstId === 'wt-182', String(firstId));
  counts.ens_wt_sources = lens.total_count;
  // A caller's alias widens the same lens (2.0 folded entity_lens in).
  const widened = await run('archive_lens', {
    topic: 'ENS',
    aliases: ['thingelstad.eth'],
    source_kind: 'weekly_thing',
    operation: 'first_last'
  });
  check(
    'KA archive_lens aliases reported and never narrow',
    widened.aliases_checked?.includes('thingelstad.eth') && widened.total_count >= lens.total_count,
    `${widened.total_count} vs ${lens.total_count}`
  );
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
// Every link top_references sees is counted or excluded under a named
// reason, so the reasons and the count add up to find_links' total for the
// same window (Jamie, 2026-09-30: never silently exclude).
for (const args of [{}, { source_kind: 'weekly_thing' }, { source_kind: 'blog', year: 2024 }, { year: 2019 }]) {
  const refs = await run('top_references', { ...args, limit: 1 });
  const links = await run('find_links', { ...args, limit: 1 });
  const accounted = [
    'counted_links',
    'excluded_internal_links',
    'excluded_non_headline_links',
    'excluded_blog_and_podcast_links',
    'excluded_utility_links',
    'excluded_malformed_links'
  ].reduce((sum, key) => sum + (Number(refs?.[key]) || 0), 0);
  check(
    `KA top_references ${JSON.stringify(args)}: counted + excluded = find_links total`,
    accounted === links?.total_count,
    `${accounted} vs ${links?.total_count}`
  );
}
// QA3 Q2: a utility entry matches only its own host (Jamie: "aws.amazon.com
// and amazon.com are radically different"); wikipedia.org keeps its
// language editions. Jamie's headline picks on aws.amazon.com (29 on the
// 2026-10-01 corpora), blog.poap.xyz and code.facebook.com rank again.
{
  const ranked = new Map();
  for (let offset = 0; offset < 10_000;) {
    const page = await run('top_references', { source_kind: 'weekly_thing', limit: 40, offset });
    for (const row of page?.top || []) ranked.set(row.domain, row.count);
    if (!page?.truncated?.next_offset) break;
    offset = page.truncated.next_offset;
  }
  check(
    'KA top_references ranks aws.amazon.com, blog.poap.xyz and code.facebook.com',
    (ranked.get('aws.amazon.com') || 0) >= 25 && ranked.has('blog.poap.xyz') && ranked.has('code.facebook.com'),
    JSON.stringify(['aws.amazon.com', 'blog.poap.xyz', 'code.facebook.com'].map((domain) => ranked.get(domain)))
  );
  const utility = [...ranked.keys()].filter(
    (domain) =>
      /(?:^|\.)wikipedia\.org$/.test(domain) ||
      /^(?:(?:m|mobile)\.)?(?:amazon\.com|twitter\.com|x\.com|facebook\.com|linkedin\.com|micro\.blog)$/.test(domain)
  );
  check('KA top_references ranks no utility host', utility.length === 0, utility.join(', '));
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
    first.results.every((gem) => /drawn at random from \d+ sources/.test(gem.reason))
  );
  check(
    'KA gems cap domains at 5',
    first.results.every((gem) => (gem.domains || []).length <= 5)
  );
}
{
  // QA2 L2-10: a theme draws at random from the sources that name it, like
  // every mode (it returned one fixed reading path every time), and every
  // gem is one list_content finds for that topic.
  const named = new Set();
  let listed = 0;
  for (let offset = 0, pages = 0; pages < 40; pages += 1) {
    const page = await ARCHIVE_TOOLS.list_content({ topic: 'coffee', limit: 120, offset }, { scope: 'all' });
    (page.results || []).forEach((row) => named.add(row.id));
    listed = page.total_count;
    offset = page.truncated?.next_offset;
    if (!offset) break;
  }
  const draws = [];
  for (let round = 0; round < 3; round += 1) {
    const gems = await run('archive_gems', { theme: 'coffee', limit: 6 });
    draws.push(gems?.results || []);
    check(
      'KA gems theme total_count is the list_content count',
      gems?.total_count === listed,
      `${gems?.total_count} vs ${listed}`
    );
  }
  const keys = draws.map((gems) => gems.map((gem) => gem.id).join(','));
  check('KA gems theme draws vary', new Set(keys).size > 1, keys[0]);
  const stray = draws.flat().filter((gem) => !named.has(gem.id));
  check(
    'KA gems theme draws only sources that name it',
    named.size === listed && stray.length === 0,
    stray.map((gem) => gem.id).join(', ')
  );
}
{
  // Per-hit strictness: first_last under stem, for a term whose corpus
  // hits are literal, must equal the exact-mode first (round-seven P0).
  const exact = await run('archive_lens', { topic: 'Ethereum', source_kind: 'weekly_thing', operation: 'first_last' });
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
    Number(goCase.total_count) < Number(go.total_count),
    `${goCase.total_count} vs ${go.total_count}`
  );
}
{
  // Recall snapshots for heavy topics - precision changes surface as
  // reviewable baseline diffs.
  for (const topic of ['POAP', 'RSS', 'OmniFocus']) {
    const lens = await run('archive_lens', { topic }, { scope: 'all' });
    counts[`recall_${topic.toLowerCase()}_sources`] = lens.total_count;
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
  counts.ethereum_lens_sources = lens.total_count;
}

// Layer 2 breadth: every registry tool exercised at least once.
await run('search_archive', { query: 'data ownership', limit: 4 }).then((out) => {
  const groups = out?.results || [];
  check(
    'KA search_archive groups passages under their source',
    groups.length > 0 && groups.every((group) => group.id && Array.isArray(group.passages) && group.passages.length),
    JSON.stringify(groups.map((group) => [group.id, group.passages?.length]))
  );
  check('KA search_archive sends each source once', new Set(groups.map((group) => group.id)).size === groups.length);
  const badAudio = groups.flatMap((group) =>
    (group.passages || [])
      .filter((passage) => passage.audio)
      .filter(
        ({ audio }) =>
          !Number.isInteger(audio.start) || (audio.start && !String(audio.url).endsWith(`#t=${audio.start}`))
      )
      .map(() => group.id)
  );
  check('KA search_archive passage audio starts at its chapter', badAudio.length === 0, badAudio.join(', '));
});
// QA2 I2-1: WT212's Journal links back to a 2021 post; that is a reference,
// not a copy, so the post surfacing never drops the passage, and the
// passage never names the post as its original.
{
  const query = 'NFTs are a truly new thing that cannot be copied';
  const all = await run('search_archive', { query, limit: 12 });
  const ids = (all?.results || []).map((group) => group.id);
  check('KA search_archive keeps wt-212 under scope all', ids.includes('wt-212'), ids.join(', '));
  const wt = await run('search_archive', { query, limit: 12, source_kind: 'weekly_thing' });
  const named = (wt?.results || [])
    .filter((group) => group.id === 'wt-212')
    .flatMap((group) => group.passages.flatMap((passage) => (passage.copy_of || []).map((copy) => copy.id)));
  check('KA wt-212 is not a copy of blog-1464172', !named.includes('blog-1464172'), named.join(', '));
}
// QA2 R2-3: the Journal dedupe works on the returned page. WT147's "mini
// minnebar" copy ranks 8th; its post ranks about 28th, below the cut, so
// the copy stays (the pool-wide dedupe dropped it and neither showed). And
// no page carries a copy beside every post it copies, when each of those
// posts is one passage (QA3 Q7: a longer post's other passage keeps it).
{
  const passagesOf = new Map();
  for (const chunk of corpora.blog?.chunks || []) {
    const id = `blog-${chunk.microblog_id}`;
    passagesOf.set(id, (passagesOf.get(id) || 0) + 1);
  }
  const page = await run('search_archive', { query: 'Minnebar session I attended', limit: 8 });
  const ids = (page?.results || []).map((group) => group.id);
  check(
    'KA search_archive keeps the wt-147 copy or its post blog-1088967',
    ids.includes('wt-147') || ids.includes('blog-1088967'),
    ids.join(', ')
  );
  for (const query of ['Minnebar session I attended', 'Tesla software update applied', 'mini Minnebar']) {
    const out = await run('search_archive', { query, limit: 12 });
    const shown = new Set((out?.results || []).map((group) => group.id));
    const twins = (out?.results || []).flatMap((group) =>
      group.passages
        .filter(
          (passage) =>
            passage.copy_of?.length &&
            passage.copy_of.every((copy) => shown.has(copy.id) && (passagesOf.get(copy.id) || 1) === 1)
        )
        .map(() => group.id)
    );
    check(`KA search_archive "${query}" shows no copy beside all its posts`, twins.length === 0, twins.join(', '));
  }
}
// QA3 Q7: Journal twins are judged per passage. WT147's "mini minnebar"
// copy reprints the event paragraphs of blog-1088967; the post's opening
// passage (remote work) never drops it, the passage holding the event
// paragraph does. Chunks are found by content: ids move on a rebuild.
{
  const copy = (corpora.weekly_thing?.chunks || []).find(
    (chunk) => chunk.issue_number === 147 && /person from Turkey/.test(chunk.text || '')
  );
  const passages = (corpora.blog?.chunks || []).filter((chunk) => String(chunk.microblog_id) === '1088967');
  const opening = passages.find((chunk) => /^We have all shifted quickly/.test(chunk.text || ''));
  const event = passages.find((chunk) => /^The event had a single track/.test(chunk.text || ''));
  const kept = (post) => Boolean(copy && post && retrieval.dedupeJournalTwins([copy, post]).includes(copy));
  check(
    "KA wt-147 copy stays beside blog-1088967's opening passage",
    Boolean(copy && opening) && kept(opening),
    `copy ${Boolean(copy)}, passage ${Boolean(opening)}`
  );
  check(
    'KA wt-147 copy drops beside the blog-1088967 passage it reprints',
    Boolean(copy && event) && !kept(event),
    `copy ${Boolean(copy)}, passage ${Boolean(event)}`
  );
}
// QA2 R2-2: search_archive section takes the H2 group headings a caller
// sees in a body. For every ## heading with text under it, the filter
// keeps at least one chunk of that issue (452 of 2,207 kept none: Notable
// Links 📌 none in 78 issues); WT146's Stream keeps all 8 chunks, 9,099
// chars, under it (the oracle's count), not only its 85-char header.
{
  const chunksOf = new Map();
  for (const chunk of corpora.weekly_thing.chunks || []) {
    const key = String(chunk.issue_number);
    if (!chunksOf.has(key)) chunksOf.set(key, []);
    chunksOf.get(key).push(chunk);
  }
  const missed = [];
  let groups = 0;
  for (const issue of corpora.weekly_thing.issues || []) {
    const lines = String(issue.body || '').split('\n');
    lines.forEach((line, index) => {
      const heading = /^##\s+(.*?)\s*$/.exec(line);
      if (!heading) return;
      const next = lines.findIndex((other, at) => at > index && /^#{1,2}\s/.test(other));
      if (!lines.slice(index + 1, next < 0 ? lines.length : next).some((other) => other.trim())) return;
      groups += 1;
      const kept = (chunksOf.get(String(issue.number)) || []).filter((chunk) =>
        retrieval.matchesFilters(chunk, { section: heading[1] })
      );
      if (!kept.length) missed.push(`wt-${issue.number} "${heading[1]}"`);
    });
  }
  check(
    'KA search_archive section keeps a passage under every H2 group heading',
    groups > 2000 && missed.length === 0,
    `${missed.length} of ${groups}: ${missed.slice(0, 5).join(', ')}`
  );
  const stream = (chunksOf.get('146') || []).filter((chunk) => retrieval.matchesFilters(chunk, { section: 'Stream' }));
  const chars = stream.reduce((sum, chunk) => sum + String(chunk.text || '').length, 0);
  check(
    'KA section Stream keeps all of wt-146 under it',
    stream.length === 8 && chars === 9099,
    `${stream.length}, ${chars}`
  );
  const notable = await run('search_archive', { query: 'privacy', section: 'Notable Links 📌', limit: 12 });
  check(
    'KA search_archive privacy in Notable Links 📌 finds passages',
    (notable?.results || []).length > 0,
    JSON.stringify(notable).slice(0, 120)
  );
  for (const section of ['No Such Heading Anywhere', '##']) {
    const out = await run('search_archive', { query: 'privacy', section }, { expectError: true });
    check(`KA search_archive section "${section}" is bad_request`, out?.code === 'bad_request', String(out?.error));
  }
}
// QA2 L2-7: WT1 is filed under Media and culture at issue level only; the
// topic filter reaches it.
await run('search_archive', {
  query: 'Minnesota Original Layne Kennedy photographer',
  topic: 'Media and culture',
  limit: 5
}).then((out) => {
  const ids = (out?.results || []).map((group) => group.id);
  check('KA search_archive topic reaches an issue filed only at issue level', ids.includes('wt-1'), ids.join(', '));
});
// QA2 R2-11: the neighbourhoods the finding saw miscounted; the hint
// invariant above checks them as rendered.
await run('source_neighborhood', { id: 'wt-1' });
await run('source_neighborhood', { id: 'blog-1075885' });
// QA2 F15: a phrase that is a group heading no section row holds still
// names its section (old: "Links 📌" gave section null on 127 of 127).
{
  const rows = [];
  for (let offset = 0, page = 0; page < 10; page += 1) {
    const out = await run('quote_search', { phrase: 'Links 📌', limit: 50, ...(offset ? { offset } : {}) });
    rows.push(...(out?.results || []));
    offset = out?.truncated?.next_offset || 0;
    if (!offset) break;
  }
  const wt = rows.filter((row) => row.source_kind === 'weekly_thing');
  const unnamed = wt.filter((row) => !row.section).map((row) => row.id);
  check(
    'KA quote_search "Links 📌" names a section on every Weekly Thing row',
    wt.length > 100 && unnamed.length === 0,
    `${unnamed.length} of ${wt.length}: ${unnamed.slice(0, 5).join(', ')}`
  );
}
// QA2 R2-8: the passage window folds like the matcher, so a folded query
// ("Molkky", a straight apostrophe) still centres the window on the word
// (old: 64 of 90 accented and 708 of 717 curly-apostrophe windows missed).
{
  const { passageWindow } = await import(path.join(distDir, 'shared/archive-tools.mjs'));
  // Chunk ids hash the text, so a rebuild moves them: take the first chunk
  // where the word sits past the first 450 characters, out of a plain cut.
  const chunks = corpora.weekly_thing.chunks || [];
  for (const [query, word] of [
    ['Molkky', 'Mölkky'],
    ["Tribune's", 'Tribune’s']
  ]) {
    const chunk = chunks.find((candidate) => String(candidate.text || '').indexOf(word) > 450);
    const window = chunk ? passageWindow(chunk, query, 450) : { text: '' };
    check(
      `KA passage window for "${query}" shows "${word}"`,
      String(chunk?.text || '').length > 450 && window.text.includes(word),
      `${String(chunk?.text || '').length} chars, window at ${window.clipped?.start}`
    );
  }
}
// QA2 R2-1 / R2-5: an H2 heading reads its whole extent, not the exact
// row that shares its name (WT146 Stream gave 95 of 9,099 chars); a "#"
// comment in fenced code does not end a blog section.
for (const [id, section, phrase] of [
  ['wt-146', 'Stream', 'Ms. PAC-MAN'],
  ['wt-8', 'Now Reading 📚', 'American Eclipse'],
  ['blog-4180550', 'Posting to Micro.blog', 'curl']
]) {
  const out = await run('get_source', { id, section, format: 'text' });
  const body = String(out?.source?.body || '');
  check(`KA get_source ${id} "${section}" reads "${phrase}"`, body.includes(phrase), `${body.length} chars`);
}
// QA2 R2-7: a miss lists the body headings too, and each one it lists reads.
for (const [id, heading] of [
  ['blog-1076058', 'Transcript'],
  ['wt-4', null]
]) {
  const miss = await run('get_source', { id, section: 'zz no such section' }, { expectError: true });
  const names = miss?.available_sections || [];
  check(
    `KA get_source ${id} miss lists its sections`,
    names.length > 0 && (!heading || names.includes(heading)),
    names.join(' | ')
  );
  const unread = [];
  for (const name of names) {
    const out = await run('get_source', { id, section: name, format: 'outline' }, { expectError: true });
    if (out?.error) unread.push(name);
  }
  check(`KA get_source ${id} every available section reads`, unread.length === 0, unread.join(' | '));
}
// QA2 R2-9 / R2-10: a section of only heading marks, and an offset the read
// cannot honour, are refused rather than read as something else.
for (const [label, args] of [
  ['section "##"', { id: 'wt-351', section: '##' }],
  ['offset with outline', { id: 'wt-351', format: 'outline', offset: 100 }],
  ['offset past the end', { id: 'wt-351', format: 'text', offset: 999999 }]
]) {
  const out = await run('get_source', args, { expectError: true });
  check(
    `KA get_source ${label} is bad_request`,
    out?.code === 'bad_request',
    String(out?.error || out?.source?.section)
  );
}
await run('get_source', { id: 'wt-351', format: 'text', offset: '100' }).then((out) => {
  check('KA get_source string offset echoes as a number', out?.applied?.offset === 100, JSON.stringify(out?.applied));
});
await run('get_source', { id: 'wt-321', format: 'outline' }).then((out) => {
  check('KA get_source outline has no body', out?.source && out.source.body === undefined);
  check('KA get_source outline names sections', (out?.source?.sections || []).length > 3);
});
await run('get_source', { id: 'WT321', section: 'Notable' }).then((out) => {
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
// Audio editions (2.3.0): a section read and a passage start their
// chapter; WT274's Journal chapter starts at 1697 seconds.
await run('get_source', { id: 'wt-274', section: 'Journal', format: 'outline' }).then((out) => {
  const audio = out?.source?.section_audio;
  check(
    'KA get_source WT274 Journal starts its audio chapter',
    audio?.start === 1697 && /\.mp3#t=1697$/.test(String(audio?.url)) && audio?.chapter === 'Journal',
    JSON.stringify(audio)
  );
});
await run('get_source', { id: 'wt-350', section: 'Friday', format: 'outline' }).then((out) => {
  check(
    'KA get_source a Journal day falls back to the Journal chapter',
    out?.source?.section_audio?.chapter === 'Journal',
    JSON.stringify(out?.source?.section_audio)
  );
});
await run('get_source', { id: 'wt-100', section: 'Journal', format: 'outline' }).then((out) => {
  check('KA get_source no audio edition, no section_audio', out?.source && !out.source.section_audio);
});
await run('list_content', { has_audio: true, source_kind: 'blog' }, { expectError: true }).then((out) => {
  check('KA has_audio with source_kind blog is refused', out?.code === 'bad_request', String(out?.error));
});
await run('get_issue', { number: '182' });
await run('get_section', { number: '321', section: 'Journal' });
await run('find_links', { topic: 'ethereum', limit: 5 });
await run('domain_history', { domain: 'macstories.net' });
// QA2 links L2-6: an internationalized domain is a host, taken as its
// punycode, at the door and in the tool.
{
  const idn = '\u{1F578}\u{1F48D}.ws';
  const problems = validateToolArguments('find_links', { domain: idn });
  const out = await run('find_links', { domain: idn, limit: 1 });
  check(
    'KA find_links takes an IDN domain as its punycode',
    !problems.length && !out?.error && out?.applied?.domain === 'xn--sr8hvo.ws',
    `${problems.join('; ')} ${out?.error || ''} ${out?.applied?.domain}`
  );
}
// QA2 links L2-7: an archive url without its scheme is still a url.
for (const tool of ['get_source', 'find_links', 'source_neighborhood']) {
  const out = await run(tool, { id: 'thingelstad.com/2004/07/06/learn-to-row.html', limit: 1 });
  const id = out?.source?.id || out?.results?.[0]?.id;
  check(`KA ${tool} resolves a scheme-less archive url`, id === 'blog-1076487', String(out?.error || id));
}
// QA2 links L2-4: an id and a source_kind that disagree are refused, not
// answered with 0 links.
await run('find_links', { id: 'wt-351', source_kind: 'blog' }, { expectError: true }).then((out) => {
  const said = `${out?.error || ''} ${out?.truncated?.hint || ''}`;
  check(
    'KA find_links id with a contradicting source_kind says so',
    /source_kind/.test(said),
    JSON.stringify(out).slice(0, 160)
  );
});
// QA2 links L2-5: with id the links keep source order, and applied.sort
// never claims an order it did not apply.
for (const sort of ['oldest', 'newest']) {
  const out = await run('find_links', { id: 'wt-351', sort, limit: 50 });
  const dates = (out?.results || []).map((link) => String(link.publish_date || ''));
  const ordered = dates.every(
    (date, index) => !index || (sort === 'oldest' ? dates[index - 1] <= date : dates[index - 1] >= date)
  );
  const inOrder = (out?.results || []).length > 1 && dates.some((date) => date !== dates[0]) && ordered;
  check(
    `KA find_links id echoes the order it applied (sort ${sort})`,
    out?.applied?.sort !== sort || inOrder,
    String(out?.applied?.sort)
  );
}
await run('latest_content', { limit: 3 });
await run('list_content', { topic: 'ethereum', match_mode: 'exact', limit: 5 });
await run('list_issues', { topic: 'ethereum', limit: 5 });
await run('compare_eras', { topic: 'ethereum', year_a: [2021, 2021], year_b: [2024, 2024], limit: 2 });
// QA2 T2-4: an era's sources_naming_topic is archive_lens's count for the
// same words, so a voice narrows both (Twitter quoted 2017-18 is 0, and the
// count once said 43 and hid the never-named note).
for (const voice of ['quoted', 'jamie']) {
  const eras = await run('compare_eras', {
    topic: 'Twitter',
    year_a: [2022, 2023],
    year_b: [2017, 2018],
    voice,
    limit: 1
  });
  for (const [key, year_range] of [
    ['era_a', [2022, 2023]],
    ['era_b', [2017, 2018]]
  ]) {
    const lens = await run('archive_lens', { topic: 'Twitter', year_range, voice, limit: 1 });
    check(
      `KA compare_eras ${key} voice ${voice} counts what archive_lens counts`,
      eras?.[key]?.sources_naming_topic === lens?.total_count,
      `${eras?.[key]?.sources_naming_topic} vs ${lens?.total_count}`
    );
  }
}
await run('source_neighborhood', { id: 'wt-182', limit: 3 });
// QA2 links L2-3, L2-8: blog-1075885 has more incoming links than the
// list holds. The hint names find_links url, which reaches every one, and
// every listed link names a source get_source opens.
for (const id of ['blog-1075885', 'wt-351', 'wt-182']) {
  const near = await run('source_neighborhood', { id, limit: 3 });
  const rendered = renderToolCallResult('source_neighborhood', near).structured || {};
  if (rendered.incoming_count > (rendered.incoming_links || []).length) {
    const hint = String(rendered.truncated?.hint || '');
    const all = await run('find_links', { url: rendered.source?.url, limit: 1 });
    check(
      `KA source_neighborhood ${id} routes to every incoming link`,
      /find_links with url/.test(hint) && all?.total_count >= rendered.incoming_count,
      `${all?.total_count} vs ${rendered.incoming_count}: ${hint}`
    );
  } else {
    check(`KA source_neighborhood ${id} has more incoming links than it lists`, id !== 'blog-1075885');
  }
  const ids = new Set(
    ['outgoing_links', 'incoming_links', 'cross_source_links'].flatMap((list) =>
      (rendered[list] || []).map((link) => link.id)
    )
  );
  const dead = [];
  for (const linkId of ids) {
    const source = await ARCHIVE_TOOLS.get_source({ id: linkId, format: 'outline' }, { scope: 'all' });
    if (!linkId || source?.source?.id !== linkId) dead.push(String(linkId));
  }
  check(
    `KA source_neighborhood ${id} every link names a source get_source opens`,
    ids.size > 0 && !dead.length,
    dead.join(', ')
  );
}
await run('find_evidence', {
  claims: ['Jamie registered thingelstad.eth in 2021', 'Jamie started The Weekly Thing in 2017']
}).then((out) => {
  const results = out?.results || [];
  check('KA find_evidence answers each claim', results.length === 2, String(results.length));
  check(
    'KA find_evidence passages carry id and voices',
    results.every((row) => row.evidence.length && row.evidence.every((item) => item.id && item.voices?.length)),
    JSON.stringify(results.map((row) => row.evidence.map((item) => item.id)))
  );
  check(
    'KA find_evidence gives no verdict',
    results.every((row) => !('verdict' in row) && !('supported' in row) && !('status' in row))
  );
});
await run('media_search', { query: 'minnehaha creek', limit: 4 });
// Round 2 media (2.3.0): plurals fold both ways, phrase is a phrase, a
// word with nothing to match is refused, an unknown issue is not_found and
// an issue listing offers only the offset.
for (const [singular, plural] of [
  ['dog', 'dogs'],
  ['beach', 'beaches']
]) {
  const one = await run('media_search', { query: singular, limit: 1 });
  const many = await run('media_search', { query: plural, limit: 1 });
  check(
    `KA media_search ${plural} finds what ${singular} finds`,
    many?.total_count >= one?.total_count,
    `${many?.total_count} vs ${one?.total_count}`
  );
}
{
  const phrase = await run('media_search', { query: 'book cover', match_mode: 'phrase', limit: 12 });
  const exact = await run('media_search', { query: 'book cover', match_mode: 'exact', limit: 1 });
  check(
    'KA media_search phrase is narrower than exact',
    phrase?.total_count > 0 && phrase.total_count < exact?.total_count,
    `${phrase?.total_count} vs ${exact?.total_count}`
  );
  check(
    'KA media_search phrase results hold the phrase',
    (phrase?.results || []).every((item) =>
      [item.alt, item.context, item.description].some((text) => /\bbook\W+covers?\b/i.test(String(text || '')))
    )
  );
}
await run('media_search', { query: 'dog 🐕' }, { expectError: true }).then((out) => {
  check('KA media_search refuses a word with nothing to match', out?.code === 'bad_request', String(out?.error));
});
await run('media_search', { issue_number: 999 }, { expectError: true }).then((out) => {
  check('KA media_search unknown issue is not_found', out?.code === 'not_found', String(out?.error));
});
await run('media_search', { issue_number: 66, limit: 12 }).then((out) => {
  const hint = String(out?.truncated?.hint || '');
  check('KA media_search issue listing hint offers only offset', !/source_kind|year_range/.test(hint), hint);
});
{
  const loose = Object.keys(ARCHIVE_TOOLS)
    .flatMap((tool) => validateToolArguments(tool, { offset: -1 }))
    .filter((problem) => / to -|from - to/.test(problem));
  check('KA one-sided range messages name one bound', loose.length === 0, loose.slice(0, 3).join('; '));
}
// QA3 Q6: search_archive is a ranked top-N; the result says so and names
// the complete tools ("Minnebar": 12 sources shown of the 130 naming it).
{
  const out = await run('search_archive', { query: 'Minnebar', limit: 12 });
  check(
    'KA search_archive says it is ranked and points to quote_search and archive_lens',
    /not every match/.test(out?.note || '') &&
      /quote_search/.test(out?.note || '') &&
      /archive_lens/.test(out?.note || ''),
    String(out?.note)
  );
}
// QA3 Q13: a photo matches when either copy's description does, and the
// blog photo, which is canonical, is the result. WT340's copy of
// 0e514b8635.jpg is "an indoor sports facility", its blog photo "an
// agility dog competition"; "dog sports facility" found neither copy. And
// with no year filter no Weekly Thing copy of an indexed blog photo that
// matched on descriptions alone stays unfolded: those words are its blog
// photo's too. (A copy found by its issue's own context still stays.)
{
  const photo = (out) => (out?.results || []).find((row) => /0e514b8635/.test(String(row.image_url)));
  for (const query of ['dog sports facility', 'sports facility', 'agility dog']) {
    const hit = photo(await run('media_search', { query, limit: 40 }));
    check(
      `KA media_search "${query}" shows the blog photo of 0e514b8635.jpg`,
      hit?.source_id === 'blog-5747260' && (hit?.also_in_issues || []).includes(340),
      JSON.stringify(hit?.source_id)
    );
  }
  const blogPhotos = new Set((corpora.blog?.media || []).map((item) => `blog-${item.microblog_id}\0${item.url}`));
  const unfolded = [];
  for (const query of ['dog', 'snow', 'coffee', 'family']) {
    for (let offset = 0; offset < 5000;) {
      const out = await run('media_search', { query, limit: 50, offset });
      for (const row of out?.results || []) {
        const byDescription = (row.match_reasons || []).every((reason) => reason.startsWith('description'));
        if (row.copy_of && byDescription && blogPhotos.has(`${row.copy_of}\0${row.canonical_url}`)) {
          unfolded.push(`${query}: ${row.source_id}`);
        }
      }
      if (!out?.truncated?.next_offset) break;
      offset = out.truncated.next_offset;
    }
  }
  check(
    'KA media_search folds every description-matched copy of an indexed blog photo',
    unfolded.length === 0,
    unfolded.slice(0, 5).join(', ')
  );
}
// QA3 Q3: a blank or whitespace url, id or domain is refused at the door
// on every tool that takes one, never read as absent (find_links url:""
// listed all 36,523 links); find_links and list_content refuse it in
// process too.
{
  const widened = [];
  for (const tool of Object.keys(ARCHIVE_TOOLS)) {
    const properties = mcpToolDeclarations([tool])[0]?.inputSchema?.properties || {};
    for (const key of ['url', 'id', 'domain']) {
      if (!(key in properties)) continue;
      for (const value of ['', '   ']) {
        if (!validateToolArguments(tool, { [key]: value }).some((problem) => problem.startsWith(`${key} is`))) {
          widened.push(`${tool}.${key}=${JSON.stringify(value)}`);
        }
      }
    }
  }
  check('KA a blank url, id or domain is refused at the door', widened.length === 0, widened.join(', '));
  for (const [tool, args] of [
    ['find_links', { url: '' }],
    ['find_links', { id: '  ' }],
    ['find_links', { domain: '' }],
    ['list_content', { domain: ' ' }]
  ]) {
    const out = await run(tool, args, { expectError: true });
    check(
      `KA ${tool} ${JSON.stringify(args)} is bad_request`,
      out?.code === 'bad_request',
      JSON.stringify(out).slice(0, 120)
    );
  }
}
// QA2 L2-9 / L2-10: an offset past the end says so for every pageOf tool,
// and a reversed year_range is refused in-process as at the door.
for (const [tool, args] of [
  ['list_content', { topic: 'RSS' }],
  ['quote_search', { phrase: 'RSS reader' }],
  ['list_topics', {}],
  ['currently_history', {}],
  ['find_links', { domain: 'github.com' }],
  ['top_references', {}],
  ['latest_content', {}],
  ['media_search', { query: 'snow' }],
  ['search_faq', { query: 'newsletter' }]
]) {
  const past = await run(tool, { ...args, offset: 99999 });
  check(
    `KA ${tool} offset past the end says so`,
    /^offset 99999 is past the last of \d+/.test(String(past?.truncated?.hint || '')),
    String(past?.truncated?.hint)
  );
}
for (const [tool, args] of [
  ['list_content', { topic: 'RSS' }],
  ['archive_lens', { topic: 'RSS' }],
  ['find_links', { domain: 'github.com' }],
  ['corpus_stats', {}],
  ['on_this_day', { date: '05-13' }]
]) {
  const reversed = await run(tool, { ...args, year_range: [2024, 2019] }, { expectError: true });
  check(
    `KA ${tool} reversed year_range refused in-process`,
    reversed?.code === 'bad_request' && /backwards/.test(String(reversed?.error)),
    JSON.stringify(reversed).slice(0, 80)
  );
}
// QA2 L2-11: what a tool sets aside is named in applied.ignored, never
// echoed as applied or dropped without a word.
{
  const photo = await run('list_content', { topic: 'Photo 📷', limit: 1 });
  const plain = await run('list_content', { topic: 'photo', limit: 1 });
  check(
    'KA an emoji word in a topic is named ignored',
    photo?.total_count === plain?.total_count && (photo?.applied?.ignored?.topic_words || []).includes('📷'),
    JSON.stringify(photo?.applied)
  );
  const voiced = await run('list_content', { topic: 'iPhone', voice: 'jamie', limit: 1 });
  check(
    'KA list_content echoes only what it reads (voice is ignored)',
    voiced?.applied?.voice === undefined && voiced?.applied?.ignored?.voice === 'jamie',
    JSON.stringify(voiced?.applied)
  );
  const nine = await run(
    'archive_lens',
    { topic: 'ENS', aliases: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'], limit: 1 },
    { expectError: true }
  );
  check(
    'KA a ninth caller alias is refused in-process',
    nine?.code === 'bad_request',
    JSON.stringify(nine).slice(0, 80)
  );
}
// File names are searchable (plan 4 step 1): the Straw Poll charts are
// found by the word only their file names hold, and say so.
await run('media_search', { query: 'strawpoll', limit: 12 }).then((out) => {
  const results = out?.results || [];
  check(
    'KA media_search strawpoll finds the poll charts by file name',
    out?.total_count >= 2,
    String(out?.total_count)
  );
  check(
    'KA media_search file-name match says filename',
    results.some((item) => (item.match_reasons || []).some((reason) => reason.startsWith("filename: 'strawpoll"))),
    JSON.stringify(results.map((item) => item.match_reasons))
  );
});
await run('currently_history', { kind: 'reading', limit: 5 });
{
  // on_this_day: WT1 went out 2017-05-13; past years only; every id resolves.
  const day = await run('on_this_day', { date: '2026-05-13' });
  const items = (day?.years || []).flatMap((row) => row.items);
  check(
    'KA on_this_day 05-13 includes WT1',
    items.some((item) => item.id === 'wt-1'),
    JSON.stringify(items.map((item) => item.id).slice(0, 8))
  );
  check(
    'KA on_this_day returns the date year and earlier, newest first',
    (day?.years || []).every((row, index, rows) => row.year <= 2026 && (!index || rows[index - 1].year > row.year))
  );
  for (const item of items.slice(0, 12)) {
    const source = await ARCHIVE_TOOLS.get_source({ id: item.id }, { scope: 'all' });
    check(`KA get_source resolves on_this_day id ${item.id}`, source?.source?.id === item.id, source?.error || '');
  }
  counts.on_this_day_0513 = items.length;
}
// QA2 L2-4: a schemeless url is one term, not "github.com" or
// "jthingelstad"; it is found where it is written, in links (27 sources and
// 51 links on the 2026-10-01 corpora). case_sensitive holds for each side of
// a slash term (Go/Rust ran case-insensitive: 1,060 either way).
{
  const url = await run('list_content', { topic: 'github.com/jthingelstad', limit: 1 });
  check(
    'KA slash keeps a schemeless url whole',
    !(url?.aliases_checked || []).includes('jthingelstad') && url?.total_count > 0,
    `${JSON.stringify(url?.aliases_checked)} ${url?.total_count}`
  );
  const links = await run('find_links', { topic: 'github.com/jthingelstad', limit: 1 });
  const linkOracle = ['weekly_thing', 'blog', 'podcast']
    .flatMap((kind) => corpora[kind]?.links || [])
    .filter((link) =>
      /(?<![\p{L}\p{N}])github\.com\/jthingelstad(?![\p{L}\p{N}])/iu.test(String(link.url || ''))
    ).length;
  check(
    'KA find_links finds a url-shaped topic in each link url',
    linkOracle > 0 && links?.total_count === linkOracle,
    `${links?.total_count} vs ${linkOracle}`
  );
  const goRust = await run('list_content', { topic: 'Go/Rust', case_sensitive: true, limit: 1 });
  const goRustCi = await run('list_content', { topic: 'Go/Rust', limit: 1 });
  check(
    'KA case_sensitive holds for slash sides',
    goRust?.total_count < goRustCi?.total_count && goRust?.applied?.case_sensitive === true,
    `${goRust?.total_count} vs ${goRustCi?.total_count}`
  );
}
// QA3 Q10: a slash whose sides are not names keeps the term whole. 9/11
// matched 758 sources as "9" or "11"; now list_content lists exactly the
// sources whose words (link targets aside) say 9/11 (13 on the 2026-10-01
// corpora). Twitter/X still names either.
{
  const strip = (text) =>
    String(text || '')
      .replace(/\]\([^)]*\)/g, ']')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\bwww\.\S+/g, ' ');
  const says = (text) => /(?<![\p{L}\p{N}/])9\s*\/\s*11(?![\p{L}\p{N}/])/u.test(strip(text));
  const oracle = new Set();
  for (const issue of corpora.weekly_thing?.issues || []) if (says(issue.body)) oracle.add(`wt-${issue.number}`);
  for (const chunk of corpora.blog?.chunks || []) {
    if (says(chunk.text)) oracle.add(chunk.page_id != null ? `page-${chunk.page_id}` : `blog-${chunk.microblog_id}`);
  }
  for (const chunk of corpora.podcast?.chunks || []) if (says(chunk.text)) oracle.add(`ep-${chunk.episode_number}`);
  const nine = await run('list_content', { topic: '9/11', limit: 40 });
  const listed = (nine?.results || []).map((row) => row.id).sort();
  check(
    'KA 9/11 lists exactly the sources that say 9/11',
    oracle.size > 0 && JSON.stringify(listed) === JSON.stringify([...oracle].sort()) && !nine?.aliases_checked,
    `${listed.length} listed vs ${oracle.size}: ${JSON.stringify(nine?.aliases_checked)}`
  );
  for (const term of ['24/7', 'I/O', 'and/or', 'w/o']) {
    const out = await run('list_content', { topic: term, limit: 1 });
    check(`KA ${term} keeps its slash`, !out?.aliases_checked && out?.total_count < 20, `${out?.total_count}`);
  }
  const tx = await run('list_content', { topic: 'Twitter/X', limit: 1 });
  check(
    'KA Twitter/X still names either',
    JSON.stringify(tx?.aliases_checked) === JSON.stringify(['Twitter/X', 'Twitter', 'X']) && tx?.total_count > 300,
    `${JSON.stringify(tx?.aliases_checked)} ${tx?.total_count}`
  );
}
// QA2 L2-5: list_topics and currently_history use the alias table and the
// slash rule like every other filter ("Twitter/X" and "microblog" gave 0).
{
  const tx = await run('list_topics', { query: 'Twitter/X' });
  const t = await run('list_topics', { query: 'Twitter' });
  check(
    'KA list_topics slash-or finds each side',
    t?.total_count > 0 && tx?.total_count >= t.total_count,
    `${tx?.total_count} vs ${t?.total_count}`
  );
  const ch = await run('currently_history', { query: 'microblog' });
  const chDot = await run('currently_history', { query: 'micro.blog' });
  check(
    'KA currently_history uses the alias table',
    chDot?.total_count > 0 && ch?.total_count === chDot.total_count,
    `${ch?.total_count} vs ${chDot?.total_count}`
  );
  check(
    'KA list_topics and currently_history echo aliases_checked',
    (tx?.aliases_checked || []).includes('X') && (ch?.aliases_checked || []).includes('micro.blog'),
    `${JSON.stringify(tx?.aliases_checked)} ${JSON.stringify(ch?.aliases_checked)}`
  );
}
// QA2 L2-6: a topic or phrase past what the regex compiler takes was an
// internal_error ("SyntaxError", "try again") that every retry repeated.
for (const [tool, args] of [
  ['archive_lens', { topic: 'a'.repeat(5000) }],
  ['list_content', { topic: 'a'.repeat(5000) }],
  ['archive_lens', { topic: 'Ethereum', aliases: ['a'.repeat(5000)] }],
  ['quote_search', { phrase: 'the '.repeat(1500) }]
]) {
  const out = await ARCHIVE_TOOLS[tool](args, { scope: 'all' }).catch((error) => ({
    error: String(error),
    code: 'internal_error'
  }));
  check(
    `KA ${tool} long input is refused, never a crash`,
    out?.code === 'bad_request' && !/SyntaxError/.test(String(out.error || '')),
    String(out?.error).slice(0, 80)
  );
}
// QA2 T2-7: an issue is on its Chicago day, across DST and midnight UTC
// (pins checked against the corpus send times: WT35 01:28Z Jan 7, WT251
// 01:14Z Apr 24, WT299 01:45Z Nov 4). WT22 is read from the corpus: its
// 00:00Z placeholder is being corrected to the day it went out.
const chicagoDayOf = (stamp) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(stamp));
const wt22Day = chicagoDayOf(
  (corpora.weekly_thing?.issues || []).find((issue) => Number(issue.number) === 22)?.publish_date
);
for (const [id, date] of [
  ['wt-35', '2018-01-06'],
  ['wt-22', wt22Day],
  ['wt-251', '2023-04-23'],
  ['wt-299', '2024-11-03']
]) {
  const day = await run('on_this_day', { date, source_kind: 'weekly_thing' });
  const item = (day?.years || []).flatMap((row) => row.items).find((entry) => entry.id === id);
  check(`KA on_this_day files ${id} on ${date}`, item?.date === date, JSON.stringify(item?.date));
}
await run('search_faq', { query: 'what is the weekly thing' });
// QA2 T2-6: a resource takes no offset or limit, so a cut resource's hint
// names the tool call for the rest, never "call again with offset".
{
  const { parseResourceUri, readResource } = await import(path.join(distDir, 'shared/mcp-resources.mjs'));
  const reader = {
    invoke: (name, input) => ARCHIVE_TOOLS[name](input, { scope: 'all' }),
    render: (name, result) => renderToolCallResult(name, result)
  };
  let cut = 0;
  for (const uri of ['librarian://on-this-day/09-26', 'librarian://year/2019', 'librarian://topic/apple']) {
    const read = await readResource(parseResourceUri(uri), reader);
    const hint = JSON.parse(read.text).truncated?.hint;
    if (hint === undefined) continue;
    cut += 1;
    check(
      `KA resource ${uri} hint names the tool call, not a parameter it lacks`,
      !/call again|raise limit|with offset \d/.test(hint) && /call the \w+ tool/.test(hint),
      hint
    );
  }
  check('KA resource hints exercised on a cut resource', cut >= 2, String(cut));
}
// QA2 F14 / L2-8: search_faq counts every entry that names a word,
// possessive included ("Jamie's" is Jamie), against the raw FAQ, and a
// query of common words matches nothing.
{
  const faq = JSON.parse(readFileSync(path.join(here, '..', 'shared', 'faq.json'), 'utf8'));
  const entries = (faq.sections || []).flatMap((section) =>
    (section.entries || []).map((entry) => `${section.title}\n${entry.question}\n${entry.answer}`)
  );
  for (const word of ['Jamie', 'newsletter']) {
    const oracle = entries.filter((text) => new RegExp(`\\b${word}\\b`, 'i').test(text)).length;
    const out = await run('search_faq', { query: word, limit: 10 });
    check(
      `KA search_faq ${word} counts every entry naming it`,
      out?.total_count === oracle,
      `${out?.total_count} vs ${oracle}`
    );
  }
  const common = await run('search_faq', { query: 'the and of' });
  check('KA search_faq common words match nothing', common?.total_count === 0, String(common?.total_count));
}
// QA2 I2-3: a name that is no site topic says where every mention is
// counted. The name is the first candidate the graph has no topic for, so a
// rebuilt graph (Mastodon became one on 2026-10-01) cannot break the check.
{
  let name = 'Overcast';
  let none;
  for (const candidate of ['Overcast', 'Ghost', 'Raycast', 'Tailscale']) {
    name = candidate;
    none = await run('list_topics', { query: candidate });
    if (none?.total_count === 0) break;
  }
  const listed = await run('list_content', { topic: name, limit: 1 });
  check(
    'KA list_topics with no match points to list_content and archive_lens',
    none?.total_count === 0 && /list_content/.test(none?.note || '') && /archive_lens/.test(none?.note || ''),
    `${name}: ${none?.total_count} ${none?.note}`
  );
  check('KA a no-topic name is counted by list_content', listed?.total_count > 0, `${name}: ${listed?.total_count}`);
}
{
  // QA2 T2-5: currently_history showed WT22's UTC day (00:00Z on the 7th
  // was the 6th in Chicago); it shows the Chicago day of the corpus stamp.
  const reading = await run('currently_history', { year: 2017, kind: 'reading', limit: 120 });
  const wt22 = (reading?.entries || []).find((entry) => entry.source_id === 'wt-22');
  check(
    'KA currently_history shows WT22 on its Chicago day',
    wt22?.date === wt22Day,
    JSON.stringify(wt22?.date ?? wt22?.publish_date)
  );
  const latest = await run('latest_content', { source_kind: 'podcast', limit: 1 });
  check(
    'KA latest_content dates an episode by its own day',
    latest?.results?.[0]?.date === latest?.results?.[0]?.publish_date,
    JSON.stringify(latest?.results?.[0]?.date)
  );
}
// Every enumerating tool at a small limit, so checkAccounting sees a cut.
await run('search_faq', { query: 'newsletter', limit: 1 });
await run('list_topics', { limit: 5 });
await run('list_topics', { query: 'coffee' });
// QA2 ingest I2-2: a Journal time label ("Saturday @ 7:16 PM") once ran
// into the next line, and "PM We" became a 69-issue topic with a public page.
{
  const clock = await run('list_topics', { query: 'pm', limit: 100 });
  const junk = (clock?.topics || []).filter((topic) => /^(AM|PM)\s|\s(AM|PM)$/i.test(topic.name));
  checkCorpus(
    'KA list_topics has no clock-label topics',
    junk.length === 0,
    junk
      .slice(0, 5)
      .map((topic) => topic.name)
      .join(', ')
  );
}
await run('quote_search', { phrase: 'open web', limit: 3 });
await run('media_search', { query: 'snow', limit: 3 });
await run('top_references', { limit: 3 });
await run('currently_history', { limit: 3 });
await run('find_links', { domain: 'github.com', limit: 3 });
await run('list_content', { topic: 'Mastodon', limit: 3 });
await run('archive_lens', { topic: 'Mastodon', limit: 3 });
// QA2 lexical L2-2: following next_offset reaches every matched source.
// Only operation timeline pages; the others answer for the whole match,
// offer no next_offset, and their hint names timeline as the way through.
for (const operation of ['timeline', 'by_year', 'first_last', 'reading_path', 'source_compare']) {
  const seen = new Set();
  let offset = 0;
  let total = 0;
  let stale = 0;
  let hint = '';
  for (let pages = 0; pages < 60; pages += 1) {
    const page = await run('archive_lens', { topic: 'RSS', operation, limit: 7, ...(offset ? { offset } : {}) });
    total = page?.total_count || 0;
    if (!pages) hint = String(page?.truncated?.hint || '');
    const before = seen.size;
    Object.keys(page?.sources_by_id || {}).forEach((id) => seen.add(id));
    if (pages && seen.size === before) stale += 1;
    offset = page?.truncated?.next_offset || 0;
    if (!offset) break;
  }
  if (operation === 'timeline') {
    check(
      `KA archive_lens timeline next_offset walk reaches every source`,
      seen.size === total,
      `${seen.size} vs ${total}`
    );
  } else {
    check(`KA archive_lens ${operation} offers no page that shows nothing new`, stale === 0, `${stale} stale pages`);
    check(
      `KA archive_lens ${operation} hint names operation timeline for the rest`,
      seen.size === total || /operation timeline/.test(hint),
      hint
    );
  }
}
await run('on_this_day', { date: '05-13', limit_per_year: 1 });
// QA2 T2-1: a windowed call at the top limit passes the 48K cap; the cut
// must keep every year and its counts (checkAccounting on the render).
await run('on_this_day', { date: '01-01', window_days: 7, limit_per_year: 20 });
if (allowNetwork) {
  await run('fetch_page', { url: 'https://www.thingelstad.com/' });
} else {
  console.log('fetch_page skipped (EVAL_ALLOW_NETWORK != 1)');
}

// QA2 F7: corpus_stats oldest/newest domains honour limit (they were held
// at 6 for every limit from 10 to 40 while limit 9 showed 9).
for (const limit of [3, 9, 10, 12, 20, 40]) {
  const stats = await run('corpus_stats', { source_kind: 'weekly_thing', limit });
  const omitted = stats?.truncated?.omitted || {};
  for (const at of ['oldest', 'newest']) {
    const shown = (stats?.sources?.[0]?.[at]?.domains || []).length;
    const all = shown + (omitted[`sources[].${at}.domains`] || 0);
    check(
      `KA corpus_stats limit ${limit} ${at}.domains shows min(limit, all)`,
      shown === Math.min(limit, all),
      `${shown} of ${all}`
    );
  }
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

// Layer 4: completeness against oracles computed from the raw corpora.
check('graph corpus loaded', Boolean(corpora.graph), 'artifacts/graph.json unavailable');
await runCompletenessChecks({
  corpora,
  check,
  counts,
  retrieval,
  call: async (tool, args) => {
    const response = await ARCHIVE_TOOLS[tool](args, { scope: 'all' });
    const rendered = renderToolCallResult(tool, response);
    return rendered.structured || JSON.parse(rendered.text);
  }
});

// --- baseline comparison --------------------------------------------------
// Counts the completeness checks already pin exactly against an oracle;
// they are printed for review, never banded (a new site page is not a
// recall regression and must not fail a corpus deploy).
const REPORT_ONLY = new Set([
  'on_this_day_partition',
  'site_pages',
  'shared_permalink_posts',
  'corpus_items',
  'corpus_links',
  // Grows ten a day while the audio back-catalogue runs; pinned exactly
  // against its oracle in the completeness layer.
  'audio_editions'
]);

if (updateBaseline) {
  const banded = Object.fromEntries(Object.entries(counts).filter(([key]) => !REPORT_ONLY.has(key)));
  writeFileSync(baselinePath, `${JSON.stringify(banded, null, 2)}\n`);
  console.log('baseline updated:', baselinePath);
} else if (skipBaseline) {
  console.log('baseline: skipped here; the corpus gate checks it against the candidate corpora');
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
