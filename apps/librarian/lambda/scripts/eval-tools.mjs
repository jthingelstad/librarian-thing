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
const { primeCorpusCachesForTests } = await import(path.join(distDir, 'shared/retrieval.mjs'));
const { mcpToolDeclarations, renderToolCallResult } = await import(path.join(distDir, 'shared/mcp.mjs'));
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
  latest_content: 'results'
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
  if (!Number.isInteger(body.total_count)) return;
  for (const key of PARTITIONS) {
    if (!Array.isArray(body[key]) || omitted[key]) continue;
    const sum = body[key].reduce((total, row) => total + (Number(row.count) || 0), 0);
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
    media_search: ['query', 'year_range', 'year', 'issue_number', 'limit'],
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
await run('latest_content', { limit: 3 });
await run('list_content', { topic: 'ethereum', match_mode: 'exact', limit: 5 });
await run('list_issues', { topic: 'ethereum', limit: 5 });
await run('compare_eras', { topic: 'ethereum', year_a: [2021, 2021], year_b: [2024, 2024], limit: 2 });
await run('source_neighborhood', { id: 'wt-182', limit: 3 });
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
await run('search_faq', { query: 'what is the weekly thing' });
// Every enumerating tool at a small limit, so checkAccounting sees a cut.
await run('list_topics', { limit: 5 });
await run('list_topics', { query: 'coffee' });
await run('quote_search', { phrase: 'open web', limit: 3 });
await run('media_search', { query: 'snow', limit: 3 });
await run('top_references', { limit: 3 });
await run('currently_history', { limit: 3 });
await run('find_links', { domain: 'github.com', limit: 3 });
await run('list_content', { topic: 'Mastodon', limit: 3 });
await run('archive_lens', { topic: 'Mastodon', limit: 3 });
await run('on_this_day', { date: '05-13', limit_per_year: 1 });
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

// Layer 4: completeness against oracles computed from the raw corpora.
check('graph corpus loaded', Boolean(corpora.graph), 'artifacts/graph.json unavailable');
await runCompletenessChecks({
  corpora,
  check,
  counts,
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
