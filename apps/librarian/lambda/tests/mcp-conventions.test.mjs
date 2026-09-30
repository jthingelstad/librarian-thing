// The MCP conventions, asserted over the built declarations and the
// registry (review 2026-09-29, item 12). What holds from MCP 1.3.0 on:
//   - every limit (and limit_*) declares its minimum, maximum and default,
//     and they match TOOL_LIMITS, which the handlers clamp to
//   - a limit above its maximum is refused at the door, before quota
//   - errors go out with isError and a code from the closed set
//   - output cut to the cap still parses as JSON
//   - every source id a tool emits is accepted by get_source
//   - a successful result carries the applied echo
// Phase 4 (MCP 2.0) tightens this.
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
      const required = Object.fromEntries((tool.inputSchema.required || []).map((name) => [name, 'x']));
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
    ['entity_lens', { entity: 'tidepools' }],
    ['archive_gems', { theme: 'tidepools' }],
    ['archive_gems', { mood: 'recent' }]
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
