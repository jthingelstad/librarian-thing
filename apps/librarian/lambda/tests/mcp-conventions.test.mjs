// The MCP conventions, asserted over the built declarations and the
// registry (review 2026-09-29, item 12). What holds from MCP 1.3.0 on:
//   - every limit (and limit_*) declares its minimum, maximum and default,
//     and they match TOOL_LIMITS, which the handlers clamp to
//   - a limit above its maximum is refused at the door, before quota
//   - errors go out with isError and a code from the closed set
//   - output cut to the cap still parses as JSON
//   - every source id a tool emits is accepted by get_source
//   - a successful result carries the applied echo
// And from 2.0.0:
//   - every tool declares an outputSchema, and a successful result conforms
//     to it: its required keys are there, and every key it sends is declared
//   - what a result leaves out is in one truncated block ({omitted,
//     clipped, hint}, max_chars when the cap cut it); no inline {omitted,
//     note} markers, *_omitted keys, truncation notes or body_truncated
//   - counts are [{<key>, count}] lists, and a total is total_count
//   - year is shorthand for year_range [year, year] wherever year_range is
//   - MCP text names Jamie (no pronouns) and never mentions "the app"
import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS, TOOL_LIMITS } from '../dist/shared/archive-tools.mjs';
import {
  MCP_LAUNCH_TOOLS,
  MCP_RESULT_MAX_CHARS,
  TOOL_ERROR_CODES,
  mcpToolDeclarations,
  renderToolCallResult,
  validateToolArguments
} from '../dist/shared/mcp.mjs';
import { toolTitle } from '../dist/shared/prompts.mjs';
import { primeCorpusCachesForTests } from '../dist/shared/retrieval.mjs';

process.env.BRAVE_SEARCH_API_KEY = 'test-key-for-declarations';
const declarations = mcpToolDeclarations();
delete process.env.BRAVE_SEARCH_API_KEY;

// A type-correct value for each required argument (compare_eras requires
// two year ranges; find_evidence a list of claims).
const requiredArguments = (tool) =>
  Object.fromEntries(
    (tool.inputSchema.required || []).map((name) => {
      const schema = tool.inputSchema.properties?.[name] || {};
      if (schema.type !== 'array') return [name, 'x'];
      return [name, schema.items?.type === 'string' ? ['x'] : [2018, 2019]];
    })
  );

const limitProperties = (tool) =>
  Object.entries(tool.inputSchema.properties || {}).filter(([key]) => key === 'limit' || key.startsWith('limit_'));

test('every launch tool is declared, titled, and backed by a handler', () => {
  assert.deepEqual(declarations.map((tool) => tool.name).sort(), [...MCP_LAUNCH_TOOLS].sort());
  for (const name of MCP_LAUNCH_TOOLS) {
    assert.equal(typeof ARCHIVE_TOOLS[name], 'function', `${name} has a handler`);
    assert.notEqual(toolTitle(name), name.replaceAll('_', ' '), `${name} has a display title`);
  }
});

test('every limit declares minimum, maximum and default, matching TOOL_LIMITS', () => {
  for (const tool of declarations) {
    for (const [key, schema] of limitProperties(tool)) {
      assert.equal(schema.type, 'integer', `${tool.name}.${key} is an integer`);
      const declared = TOOL_LIMITS[tool.name];
      assert.ok(declared, `${tool.name} has a TOOL_LIMITS entry`);
      assert.deepEqual(
        { min: schema.minimum, max: schema.maximum, default: schema.default },
        declared,
        `${tool.name}.${key} matches TOOL_LIMITS`
      );
    }
  }
  for (const name of Object.keys(TOOL_LIMITS)) {
    const tool = declarations.find((entry) => entry.name === name);
    assert.ok(tool && limitProperties(tool).length === 1, `${name} declares exactly one limit`);
  }
});

test('a limit above its maximum is refused before quota, for every tool', (t) => {
  // web_search's schema is only visible once a Brave key is configured.
  process.env.BRAVE_SEARCH_API_KEY = 'test-key-for-declarations';
  t.after(() => delete process.env.BRAVE_SEARCH_API_KEY);
  for (const tool of declarations) {
    for (const [key, schema] of limitProperties(tool)) {
      const required = requiredArguments(tool);
      assert.deepEqual(validateToolArguments(tool.name, { ...required, [key]: schema.maximum }), []);
      const problems = validateToolArguments(tool.name, { ...required, [key]: schema.maximum + 1 });
      assert.equal(problems.length, 1, `${tool.name}.${key} over max`);
    }
  }
});

function fixtures() {
  return {
    weekly_thing: {
      issues: [
        {
          number: 300,
          subject: 'Tidepools and the fall',
          publish_date: '2024-09-29T12:00:00Z',
          url: '/archive/300/',
          summary: { abstract: 'Tidepools.' },
          sections: [{ name: 'Issue', text: 'Tidepools at low tide.' }],
          body: 'Tidepools at low tide.'
        },
        {
          number: 301,
          subject: 'More tidepools',
          publish_date: '2024-10-06T12:00:00Z',
          url: '/archive/301/',
          sections: [{ name: 'Issue', text: 'Tidepools again.' }],
          body: 'Tidepools again.'
        }
      ],
      chunks: [],
      links: [],
      media: []
    },
    blog: {
      posts: [
        {
          microblog_id: 987,
          subject: 'Tidepools on the blog',
          publish_date: '2019-09-29',
          url: 'https://www.thingelstad.com/2019/09/29/tidepools.html',
          post_kind: 'post'
        }
      ],
      chunks: [
        {
          source_kind: 'blog',
          url: 'https://www.thingelstad.com/2019/09/29/tidepools.html',
          section: 'post',
          text: 'Tidepools, written up.'
        }
      ],
      links: []
    },
    podcast: {
      episodes: [
        {
          number: 3,
          show: 'Another Thing',
          subject: 'Tidepools, the episode',
          publish_date: '2025-09-29',
          url: 'https://another.thingelstad.com/3/'
        }
      ],
      chunks: [],
      links: []
    }
  };
}

function emittedIds(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) emittedIds(entry, found);
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'sources_by_id') for (const id of Object.keys(entry)) found.add(id);
      if (key === 'id' && typeof entry === 'string' && /^(wt|blog|ep)-/.test(entry)) found.add(entry);
      emittedIds(entry, found);
    }
  }
  return found;
}

test('every source id a tool emits is accepted by get_source', async () => {
  primeCorpusCachesForTests(fixtures());
  const calls = [
    ['on_this_day', { date: '2026-09-29' }],
    ['list_content', { topic: 'tidepools' }],
    ['latest_content', {}],
    ['archive_lens', { topic: 'tidepools' }],
    ['archive_lens', { topic: 'tidepools', operation: 'reading_path' }],
    ['archive_lens', { topic: 'tide pools', aliases: ['tidepools'] }],
    ['archive_gems', { theme: 'tidepools' }],
    ['archive_gems', { mode: 'recent' }]
  ];
  const ids = new Set();
  for (const [name, args] of calls) {
    const out = await ARCHIVE_TOOLS[name](args, { scope: 'all' });
    assert.equal(out.error, undefined, `${name} succeeded`);
    for (const id of emittedIds(out)) ids.add(id);
  }
  assert.ok(ids.size >= 4, `ids seen: ${[...ids].join(', ')}`);
  for (const id of ids) {
    const source = await ARCHIVE_TOOLS.get_source({ id }, { scope: 'all' });
    assert.equal(source.error, undefined, `get_source takes ${id}`);
    assert.equal(source.source.id, id);
  }
});

test('errors go out with isError and a code from the closed set', async () => {
  primeCorpusCachesForTests(fixtures());
  const cases = [
    ['get_source', { id: 'wt-9999' }, 'not_found'],
    ['archive_lens', {}, 'bad_request'],
    ['on_this_day', { date: '2026-02-31' }, 'bad_request']
  ];
  for (const [name, args, code] of cases) {
    const rendered = renderToolCallResult(name, await ARCHIVE_TOOLS[name](args, { scope: 'all' }));
    assert.equal(rendered.isError, true, name);
    const parsed = JSON.parse(rendered.text);
    assert.equal(parsed.code, code, name);
    assert.ok(TOOL_ERROR_CODES.includes(parsed.code));
    assert.equal(typeof parsed.next, 'string');
  }
});

test('output cut to the cap parses, for every tool', () => {
  const big = {
    results: Array.from({ length: 400 }, (_value, index) => ({ id: `wt-${index}`, text: 'x'.repeat(400) })),
    note: 'y'.repeat(60000)
  };
  for (const tool of declarations) {
    const rendered = renderToolCallResult(tool.name, big);
    assert.ok(rendered.text.length <= MCP_RESULT_MAX_CHARS, `${tool.name} fits`);
    const parsed = JSON.parse(rendered.text);
    assert.equal(rendered.truncated, true);
    assert.ok(parsed.truncated, `${tool.name} says it was cut`);
  }
});

test('a successful result carries the applied echo', async () => {
  primeCorpusCachesForTests(fixtures());
  for (const [name, args] of [
    ['list_content', { limit: 3, year_range: [2019, 2024] }],
    ['on_this_day', { date: '09-29' }],
    ['latest_content', { source_kind: 'blog' }]
  ]) {
    const out = await ARCHIVE_TOOLS[name](args, { scope: 'all' });
    assert.ok(out.applied && typeof out.applied === 'object', `${name} has applied`);
    assert.equal(Object.keys(out)[0], 'applied', `${name} leads with applied`);
  }
});

// ── 2.0.0 ────────────────────────────────────────────────────────────────

const typeOf = (value) =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;

function schemaProblems(name, schema, result) {
  const problems = [];
  for (const key of schema.required || []) if (!(key in result)) problems.push(`${name}: required ${key} missing`);
  for (const [key, value] of Object.entries(result)) {
    const declared = schema.properties?.[key];
    if (!declared) {
      problems.push(`${name}: ${key} is sent but not declared`);
      continue;
    }
    const types = declared.type ? [declared.type].flat() : [];
    const actual = typeOf(value);
    if (types.length && !types.includes(actual) && !(actual === 'integer' && types.includes('number'))) {
      problems.push(`${name}.${key} is ${actual}, declared ${types.join('|')}`);
    }
  }
  return problems;
}

// Keys and markers 2.0 retired, anywhere in a result.
const RETIRED_KEY =
  /_omitted$|^(results|sources|yearly_signals|body)_note$|^body_truncated$|^total_(sources|matches|domains)$/;

function shapeProblems(name, value, path = '', problems = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => shapeProblems(name, entry, `${path}[]`, problems));
  } else if (value && typeof value === 'object') {
    if ('omitted' in value && 'note' in value) problems.push(`${name}: inline {omitted, note} marker at ${path}`);
    for (const [key, entry] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      if (RETIRED_KEY.test(key)) problems.push(`${name}: retired key ${at}`);
      if (key === 'more' || key === 'total') problems.push(`${name}: ${at} should be total_count`);
      if (key.startsWith('counts_by_')) {
        const ok = Array.isArray(entry) && entry.every((row) => row && Number.isInteger(row.count));
        if (!ok) problems.push(`${name}: ${at} is not a [{<key>, count}] list`);
      }
      if (key === 'truncated' && path === '') {
        const extra = Object.keys(entry).filter((part) => !['max_chars', 'omitted', 'clipped', 'hint'].includes(part));
        if (extra.length) problems.push(`${name}: truncated carries ${extra.join(', ')}`);
        for (const count of Object.values(entry.omitted || {})) {
          if (!(Number.isInteger(count) && count > 0)) problems.push(`${name}: truncated.omitted holds ${count}`);
        }
        if (!(typeof entry.hint === 'string' && entry.hint)) problems.push(`${name}: truncated has no hint`);
        continue;
      }
      shapeProblems(name, entry, at, problems);
    }
  }
  return problems;
}

// Every registry tool that answers from the corpus caches alone (the
// retrieval tools need embeddings and are covered by eval-tools).
const OFFLINE_CALLS = [
  ['get_source', { id: 'wt-300' }],
  ['get_source', { id: 'WT301', format: 'outline' }],
  ['get_source', { id: 'blog-987', format: 'text' }],
  ['list_content', { topic: 'tidepools', limit: 1 }],
  ['list_content', { year: 2024 }],
  ['latest_content', { limit: 2 }],
  ['corpus_stats', { limit: 3 }],
  ['list_topics', {}],
  ['find_links', {}],
  ['archive_lens', { topic: 'tidepools', limit: 1 }],
  ['archive_lens', { topic: 'tidepools', operation: 'by_year', year: 2024 }],
  ['archive_lens', { topic: 'tidepools', operation: 'source_compare' }],
  ['archive_lens', { topic: 'tidepools', operation: 'reading_path' }],
  ['archive_gems', { theme: 'tidepools' }],
  ['archive_gems', { mode: 'forgotten' }],
  ['source_neighborhood', { id: 'wt-300' }],
  ['quote_search', { phrase: 'tidepools' }],
  ['currently_history', { year: 2024 }],
  ['top_references', { year_range: [2019, 2025] }],
  ['on_this_day', { date: '09-29', limit_per_year: 1 }],
  ['on_this_day', { date: '09-29', window_days: 7 }]
];

test('every tool declares an outputSchema whose required keys it declares', () => {
  for (const tool of declarations) {
    const schema = tool.outputSchema;
    assert.equal(schema?.type, 'object', `${tool.name} declares an outputSchema`);
    for (const key of schema.required || []) assert.ok(key in schema.properties, `${tool.name}: ${key} declared`);
    if (tool.name !== 'view_photo') {
      for (const key of ['applied', 'server_version', 'truncated']) assert.ok(key in schema.properties, key);
    }
  }
});

test('a successful result conforms to its outputSchema and uses only 2.0 shapes', async () => {
  primeCorpusCachesForTests(fixtures());
  const covered = new Set();
  for (const [name, args] of OFFLINE_CALLS) {
    assert.deepEqual(validateToolArguments(name, args), [], `${name} ${JSON.stringify(args)} is valid`);
    const rendered = renderToolCallResult(name, await ARCHIVE_TOOLS[name](args, { scope: 'all' }));
    assert.equal(rendered.isError, false, `${name}: ${rendered.text.slice(0, 200)}`);
    const tool = declarations.find((entry) => entry.name === name);
    assert.deepEqual(rendered.structured, JSON.parse(rendered.text));
    assert.deepEqual(schemaProblems(name, tool.outputSchema, rendered.structured), [], `${name} conforms`);
    assert.deepEqual(shapeProblems(name, rendered.structured), [], `${name} shapes`);
    covered.add(name);
  }
  const retrieval = new Set(['search_faq', 'search_archive', 'compare_eras', 'find_evidence', 'media_search']);
  const live = new Set(['fetch_page', 'web_search']);
  for (const tool of declarations) {
    if (tool.name === 'view_photo' || retrieval.has(tool.name) || live.has(tool.name)) continue;
    assert.ok(covered.has(tool.name), `${tool.name} is exercised offline`);
  }
});

test('what a tool leaves out is counted in truncated, with a hint', async () => {
  primeCorpusCachesForTests(fixtures());
  const listed = await ARCHIVE_TOOLS.list_content({ topic: 'tidepools', limit: 1 }, { scope: 'all' });
  assert.equal(listed.results.length + listed.truncated.omitted.results, listed.total_count);
  const lens = await ARCHIVE_TOOLS.archive_lens({ topic: 'tidepools', limit: 1 }, { scope: 'all' });
  assert.ok(lens.truncated.omitted.sources_by_id > 0);
  assert.match(lens.truncated.hint, /limit/);
});

test('year is shorthand for year_range [year, year] wherever year_range is taken', async () => {
  primeCorpusCachesForTests(fixtures());
  for (const tool of declarations) {
    const properties = tool.inputSchema.properties || {};
    if (!properties.year_range) continue;
    assert.equal(properties.year?.type, 'integer', `${tool.name} takes year`);
    assert.match(
      validateToolArguments(tool.name, { ...requiredArguments(tool), year: 2020, year_range: [2020, 2021] }).join(' '),
      /not both/
    );
  }
  const out = await ARCHIVE_TOOLS.list_content({ year: 2024 }, { scope: 'all' });
  assert.deepEqual(out.applied.year_range, [2024, 2024]);
  assert.equal(out.applied.year, undefined);
  assert.equal(out.total_count, 2);
});

test('MCP text names Jamie, never a pronoun, and never mentions the app', () => {
  process.env.BRAVE_SEARCH_API_KEY = 'test-key-for-declarations';
  const all = mcpToolDeclarations([...MCP_LAUNCH_TOOLS, 'view_photo']);
  delete process.env.BRAVE_SEARCH_API_KEY;
  for (const tool of all) {
    const text = JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema });
    assert.doesNotMatch(text, /\b(he|him|his|she|her|hers)\b/i, `${tool.name} uses a pronoun`);
    assert.doesNotMatch(text, /\bthe app\b/i, `${tool.name} mentions the app`);
  }
});

test('source ids: wt-351, WT351, #351, 351 and the url all reach the same issue', async () => {
  primeCorpusCachesForTests(fixtures());
  for (const id of [
    'wt-300',
    'WT300',
    'wt 300',
    '#300',
    '300',
    'https://weekly.thingelstad.com/archive/300/',
    '/archive/300/'
  ]) {
    const out = await ARCHIVE_TOOLS.get_source({ id, format: 'outline' }, { scope: 'all' });
    assert.equal(out.source?.id, 'wt-300', id);
  }
});
