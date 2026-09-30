// MCP-native surface (MCP 1.6.0; 2.0.0 truncation): resources and templates, prompts, tool
// annotations and strict schemas, and absolute urls at the door.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TOOLS } from '../dist/shared/archive-tools.mjs';
import {
  MCP_QUOTA_ERROR_CODE,
  handleMcpMessage,
  initializeResult,
  mcpToolDeclarations,
  renderToolCallResult
} from '../dist/shared/mcp.mjs';
import { parseResourceUri, sourceMarkdown } from '../dist/shared/mcp-resources.mjs';
import { primeCorpusCachesForTests } from '../dist/shared/retrieval.mjs';

function fixtures() {
  return {
    weekly_thing: {
      issues: [
        {
          number: 350,
          subject: 'WT350 - Tidepools',
          publish_date: '2026-09-19T12:00:00Z',
          url: '/archive/350/',
          description: 'Tidepools and the fall.',
          sections: [{ name: 'Issue', text: 'Tidepools at low tide.' }],
          body: 'Tidepools at low tide.'
        },
        {
          number: 351,
          subject: 'WT351 - Attention',
          publish_date: '2026-09-26T12:00:00Z',
          url: '/archive/351/',
          description: 'Attention is the scarce part.',
          sections: [{ name: 'Issue', text: 'Attention is the scarce part of building with agents.' }],
          body: 'Attention is the scarce part of building with agents.'
        }
      ],
      chunks: [
        {
          id: 'c351',
          issue_number: 351,
          publish_date: '2026-09-26T12:00:00Z',
          section: 'Issue',
          topics: ['AI and agents'],
          text: 'Attention is the scarce part of building with agents.'
        }
      ],
      links: [],
      media: [],
      topics: [
        {
          name: 'AI and agents',
          description: 'Archive material related to ai and agents.',
          first_seen: '2026-09-26T12:00:00Z',
          last_seen: '2026-09-26T12:00:00Z',
          issue_numbers: [351],
          representative_issues: [351],
          related_topics: []
        }
      ]
    },
    blog: {
      posts: [
        {
          microblog_id: 77,
          subject: 'Pour-over notes',
          publish_date: '2020-01-02',
          url: 'https://www.thingelstad.com/2020/01/02/pour-over.html',
          post_kind: 'post'
        }
      ],
      chunks: [
        {
          source_kind: 'blog',
          url: 'https://www.thingelstad.com/2020/01/02/pour-over.html',
          section: 'post',
          text: 'Pour-over, written up.'
        }
      ],
      links: []
    },
    podcast: { episodes: [], chunks: [], links: [] },
    graph: {
      issues: {
        349: { entities: ['MacStories'] },
        350: { entities: ['MacStories'] },
        351: { entities: ['MacStories'] }
      },
      entity_index: { macstories: ['349', '350', '351'] }
    }
  };
}

// A context over the real registry that records what each read ran, as
// what, and how much quota it spent.
function liveContext({ allowed = true } = {}) {
  const calls = [];
  let spent = 0;
  return {
    calls,
    spent: () => spent,
    context: {
      subscriberHash: 'sub-1',
      entitlements: ['reader'],
      scope: 'archive:read',
      spendQuota: async () => {
        spent += 1;
        return { allowed, count: spent, max: 500 };
      },
      invokeTool: async (name, input, auditAs) => {
        calls.push([name, auditAs || name]);
        return ARCHIVE_TOOLS[name](input, { scope: 'all' });
      }
    }
  };
}

const rpc = (method, params, context, id = 1) => handleMcpMessage({ jsonrpc: '2.0', id, method, params }, context);

test('initialize declares tools, resources and prompts', () => {
  const { capabilities, instructions } = initializeResult('2025-06-18');
  assert.deepEqual(Object.keys(capabilities).sort(), ['prompts', 'resources', 'tools']);
  assert.match(instructions, /librarian:\/\/wt\/\{n\}/);
  assert.match(instructions, /thinking_over_time/);
  assert.match(instructions, /\[WT351\]\(url\)/);
});

test('every tool is read-only; only the live-web tools are open-world; schemas are closed', () => {
  process.env.BRAVE_SEARCH_API_KEY = 'test-key';
  try {
    for (const tool of mcpToolDeclarations()) {
      assert.equal(tool.annotations.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations.openWorldHint, ['fetch_page', 'web_search'].includes(tool.name), tool.name);
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    }
  } finally {
    delete process.env.BRAVE_SEARCH_API_KEY;
  }
});

test('prompts/list offers the five asks; prompts/get expands one with its arguments', async () => {
  const { context } = liveContext();
  const list = await rpc('prompts/list', {}, context);
  const names = list.payload.result.prompts.map((prompt) => prompt.name);
  assert.deepEqual(names, [
    'thinking_over_time',
    'year_in_review',
    'reading_path',
    'this_week_in_past_years',
    'research_brief'
  ]);
  for (const prompt of list.payload.result.prompts) {
    assert.ok(prompt.title && prompt.description, prompt.name);
    assert.ok(Array.isArray(prompt.arguments), prompt.name);
  }
  const got = await rpc('prompts/get', { name: 'thinking_over_time', arguments: { topic: 'RSS' } }, context);
  const [message] = got.payload.result.messages;
  assert.equal(message.role, 'user');
  assert.match(message.content.text, /archive_lens with topic "RSS", voice "jamie"/);
  assert.doesNotMatch(message.content.text, /\b(he|his|him|she|her)\b/i, 'no pronoun for Jamie');
  const weekly = await rpc('prompts/get', { name: 'this_week_in_past_years' }, context);
  assert.match(weekly.payload.result.messages[0].content.text, /on_this_day with window_days 3/);
});

test('prompts/get refuses unknown prompts and bad arguments as invalid params', async () => {
  const { context } = liveContext();
  for (const params of [
    { name: 'write_as_jamie', arguments: {} },
    { name: 'thinking_over_time', arguments: {} },
    { name: 'year_in_review', arguments: { year: 'last year' } },
    { name: 'reading_path', arguments: { theme: 'rss', length: '40' } },
    { name: 'research_brief', arguments: { subject: 'Obsidian', tone: 'snarky' } }
  ]) {
    const reply = await rpc('prompts/get', params, context);
    assert.equal(reply.payload.error.code, -32602, JSON.stringify(params));
  }
});

test('resource URIs parse to one kind each, or to nothing', () => {
  assert.deepEqual(parseResourceUri('librarian://wt/351'), { uri: 'librarian://wt/351', kind: 'wt', value: '351' });
  assert.equal(parseResourceUri('librarian://blog/6034145').kind, 'blog');
  assert.equal(parseResourceUri('librarian://topic/ai-and-agents').value, 'ai-and-agents');
  assert.equal(parseResourceUri('librarian://year/2021').value, '2021');
  assert.equal(parseResourceUri('librarian://on-this-day/09-29').value, '09-29');
  for (const bad of [
    'librarian://wt/abc',
    'librarian://on-this-day/13-01',
    'librarian://year/1850',
    'librarian://podcast/1',
    'https://weekly.thingelstad.com/archive/351/',
    'librarian://topic/Not A Slug'
  ]) {
    assert.equal(parseResourceUri(bad), null, bad);
  }
});

test('resources/templates/list names the five templates', async () => {
  const { context } = liveContext();
  const reply = await rpc('resources/templates/list', {}, context);
  assert.deepEqual(
    reply.payload.result.resourceTemplates.map((template) => template.uriTemplate),
    [
      'librarian://wt/{n}',
      'librarian://blog/{id}',
      'librarian://topic/{slug}',
      'librarian://year/{yyyy}',
      'librarian://on-this-day/{mm-dd}'
    ]
  );
});

test('resources/list offers the newest issues, newest first', async () => {
  primeCorpusCachesForTests(fixtures());
  const { context, spent } = liveContext();
  const reply = await rpc('resources/list', {}, context);
  const [first, second] = reply.payload.result.resources;
  assert.equal(first.uri, 'librarian://wt/351');
  assert.equal(first.name, 'WT351');
  assert.equal(first.mimeType, 'text/markdown');
  assert.equal(second.uri, 'librarian://wt/350');
  assert.equal(spent(), 0, 'listing is free');
});

test('resources/read librarian://wt/351 is the issue as markdown, one quota unit, audited as resource:wt', async () => {
  primeCorpusCachesForTests(fixtures());
  const { context, calls, spent } = liveContext();
  const reply = await rpc('resources/read', { uri: 'librarian://wt/351' }, context);
  const [contents] = reply.payload.result.contents;
  assert.equal(contents.uri, 'librarian://wt/351');
  assert.equal(contents.mimeType, 'text/markdown');
  assert.match(contents.text, /^# WT351 - Attention/);
  assert.match(contents.text, /- URL: https:\/\/weekly\.thingelstad\.com\/archive\/351\//);
  assert.match(contents.text, /Attention is the scarce part of building with agents\./);
  assert.deepEqual(calls, [['get_source', 'resource:wt']]);
  assert.equal(spent(), 1);
});

test('resources/read serves a blog post, a year, a day and a topic by slug', async () => {
  primeCorpusCachesForTests(fixtures());
  const { context, calls } = liveContext();
  const blog = await rpc('resources/read', { uri: 'librarian://blog/77' }, context);
  assert.match(blog.payload.result.contents[0].text, /^# Pour-over notes/);
  const year = await rpc('resources/read', { uri: 'librarian://year/2026' }, context);
  const stats = JSON.parse(year.payload.result.contents[0].text);
  assert.deepEqual(stats.applied.year_range, [2026, 2026]);
  const day = await rpc('resources/read', { uri: 'librarian://on-this-day/09-26' }, context);
  assert.equal(day.payload.result.contents[0].mimeType, 'application/json');
  const cluster = await rpc('resources/read', { uri: 'librarian://topic/ai-and-agents' }, context);
  const lens = JSON.parse(cluster.payload.result.contents[0].text);
  assert.equal(lens.topic_card.name, 'AI and agents');
  assert.equal(lens.topic_card.kind, 'cluster');
  const page = await rpc('resources/read', { uri: 'librarian://topic/macstories' }, context);
  assert.equal(JSON.parse(page.payload.result.contents[0].text).topic_card.name, 'MacStories');
  assert.deepEqual(
    calls.map(([, auditAs]) => auditAs),
    [
      'resource:blog',
      'resource:year',
      'resource:on-this-day',
      'resource:topic',
      'resource:topic',
      'resource:topic',
      'resource:topic'
    ]
  );
});

test('resources/read: unknown URI is invalid params before quota; a missing source is -32002; quota is honoured', async () => {
  primeCorpusCachesForTests(fixtures());
  const { context, spent } = liveContext();
  const bad = await rpc('resources/read', { uri: 'librarian://podcast/1' }, context);
  assert.equal(bad.payload.error.code, -32602);
  assert.match(bad.payload.error.message, /librarian:\/\/wt\/\{n\}/);
  assert.equal(spent(), 0);
  const missing = await rpc('resources/read', { uri: 'librarian://wt/9999' }, context);
  assert.equal(missing.payload.error.code, -32002);
  assert.deepEqual(missing.payload.error.data, { uri: 'librarian://wt/9999' });
  const noTopic = await rpc('resources/read', { uri: 'librarian://topic/nothing-here' }, context);
  assert.equal(noTopic.payload.error.code, -32002);
  const exhausted = liveContext({ allowed: false });
  const refused = await rpc('resources/read', { uri: 'librarian://wt/351' }, exhausted.context);
  assert.equal(refused.payload.error.code, MCP_QUOTA_ERROR_CODE);
  assert.deepEqual(exhausted.calls, []);
});

test('the doors send every url absolute; other strings are left alone', () => {
  const { text } = renderToolCallResult('latest_content', {
    results: [{ url: '/archive/351/', issue_url: '/archive/351/', source_url: '/faq/', note: '/archive/351/' }],
    sources_by_id: { 'blog-1': { url: 'https://www.thingelstad.com/x.html' } }
  });
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.results[0], {
    url: 'https://weekly.thingelstad.com/archive/351/',
    issue_url: 'https://weekly.thingelstad.com/archive/351/',
    source_url: 'https://weekly.thingelstad.com/faq/',
    note: '/archive/351/'
  });
  assert.equal(parsed.sources_by_id['blog-1'].url, 'https://www.thingelstad.com/x.html');
});

test('list_topics finds a name spelled as its slug', async () => {
  primeCorpusCachesForTests(fixtures());
  const cluster = await ARCHIVE_TOOLS.list_topics({ query: 'ai-and-agents' });
  assert.deepEqual(
    cluster.clusters.map((entry) => entry.name),
    ['AI and agents']
  );
  const page = await ARCHIVE_TOOLS.list_topics({ query: 'mac stories' });
  assert.deepEqual(page.topics, []);
  const slug = await ARCHIVE_TOOLS.list_topics({ query: 'macstories' });
  assert.deepEqual(
    slug.topics.map((entry) => entry.name),
    ['MacStories']
  );
});

test('a source resource says when its body was cut, from the truncated block (2.0)', () => {
  const source = { id: 'wt-351', subject: 'WT351', body: 'The first part.' };
  const whole = sourceMarkdown(source);
  assert.doesNotMatch(whole, /cut to fit/);
  const cut = sourceMarkdown(source, { clipped: ['source.body'], hint: 'Pass section.' });
  assert.match(cut, /_The body was cut to fit; get_source with id wt-351 and a section reads one section whole._$/);
});
