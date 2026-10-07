import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROGRESS_UPDATES_BETA,
  WEB_SEARCH_TOOL,
  agentInferenceConfig,
  anthropicTools,
  messageText,
  streamMessage,
  webSearchActivity,
  webSearchEnabled,
  webSearchTool,
  withWebSearch
} from '../dist/shared/anthropic.mjs';
import { WEB_TOOLS } from '../dist/shared/mcp.mjs';
import { modelAcceptsSamplingParams, modelWritesProgressUpdates } from '../dist/shared/aws-clients.mjs';
import { availableToolSpecs } from '../dist/shared/archive-tools.mjs';

test('tool specs bind as Anthropic tools with the breakpoint where the cachePoint stood', () => {
  const specs = availableToolSpecs();
  const tools = anthropicTools(specs);
  const named = specs.filter((entry) => entry.toolSpec?.name);
  assert.equal(tools.length, named.length);
  for (const [index, tool] of tools.entries()) {
    const spec = named[index].toolSpec;
    assert.equal(tool.name, spec.name);
    assert.equal(tool.description, spec.description);
    assert.deepEqual(tool.input_schema, spec.inputSchema.json);
    assert.equal('toolSpec' in tool, false);
    assert.equal('mcp' in tool, false);
  }
  // The cachePoint entry marks the tool just before it as the breakpoint.
  const cacheIndex = specs.findIndex((entry) => entry.cachePoint);
  assert.ok(cacheIndex > 0);
  const marked = tools.filter((tool) => tool.cache_control);
  assert.deepEqual(
    marked.map((tool) => tool.name),
    [specs[cacheIndex - 1].toolSpec.name]
  );
  assert.deepEqual(marked[0].cache_control, { type: 'ephemeral' });
});

test('a filtered tool list keeps the breakpoint on the last tool before it', () => {
  const specs = availableToolSpecs().filter(
    (entry) => !entry.toolSpec || ['search_archive', 'media_search'].includes(entry.toolSpec.name)
  );
  const tools = anthropicTools(specs);
  assert.deepEqual(
    tools.map((tool) => [tool.name, Boolean(tool.cache_control)]),
    [
      ['search_archive', true],
      ['media_search', false]
    ]
  );
});

test('a leading cachePoint marks nothing', () => {
  assert.deepEqual(anthropicTools([{ cachePoint: { type: 'default' } }]), []);
});

test('messageText joins text blocks and skips tool use', () => {
  assert.equal(
    messageText({
      content: [
        { type: 'text', text: 'First.' },
        { type: 'tool_use', id: 'toolu_1', name: 'search_archive', input: {} },
        { type: 'text', text: 'Second.' }
      ]
    }),
    'First.\nSecond.'
  );
  assert.equal(messageText(undefined), '');
});

// Stands in for client.beta.messages.stream: replays content_block_delta
// events (index, delta) to streamEvent listeners, then returns the message.
function fakeClient(message, events = []) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params) {
          calls.push(params);
          const listeners = [];
          return {
            on(event, listener) {
              if (event === 'streamEvent') listeners.push(listener);
              return this;
            },
            async finalMessage() {
              for (const [index, delta, start] of events) {
                // [index, null, block] replays a content_block_start.
                const event = start
                  ? { type: 'content_block_start', index, content_block: start }
                  : { type: 'content_block_delta', index, delta };
                for (const listener of listeners) listener(event);
              }
              return message;
            }
          };
        }
      }
    }
  };
}

const textDelta = (text) => ({ type: 'text_delta', text });
const thinkingDelta = (thinking) => ({ type: 'thinking_delta', thinking });

test('streamMessage forwards text deltas and returns the assembled turn', async () => {
  const message = {
    content: [{ type: 'text', text: 'First second.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 3 }
  };
  const client = fakeClient(message, [
    [0, textDelta('First ')],
    [0, textDelta('second.')]
  ]);
  const deltas = [];
  const result = await streamMessage(
    { model: 'claude-sonnet-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] },
    { client, onTextDelta: (delta) => deltas.push(delta) }
  );
  assert.deepEqual(deltas, ['First ', 'second.']);
  assert.equal(result.text, 'First second.');
  assert.equal(result.narration, 'First second.');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.usage.output_tokens, 3);
  assert.equal(client.calls[0].model, 'claude-sonnet-4-6');
});

test('progress notes stream and narrate, but never join the answer text', async () => {
  // display: 'updates' - the reasoning block stays empty, the note between
  // tool calls arrives as a thinking block with text.
  const message = {
    content: [
      { type: 'thinking', thinking: '', signature: 'sig-reasoning' },
      { type: 'thinking', thinking: 'Checking the 2019 issues first.', signature: 'sig-note' },
      { type: 'text', text: 'Looking now.' },
      { type: 'tool_use', id: 'toolu_1', name: 'search_archive', input: { query: 'RSS' } }
    ],
    stop_reason: 'tool_use',
    usage: {}
  };
  const deltas = [];
  const result = await streamMessage(
    { model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] },
    {
      client: fakeClient(message, [
        [0, thinkingDelta('')],
        [1, thinkingDelta('Checking the 2019 ')],
        [1, thinkingDelta('issues first.')],
        [2, textDelta('Looking now.')]
      ]),
      onTextDelta: (delta) => deltas.push(delta)
    }
  );
  assert.equal(deltas.join(''), 'Checking the 2019 issues first.\n\nLooking now.');
  assert.equal(result.text, 'Looking now.');
  assert.equal(result.narration, 'Checking the 2019 issues first.\n\nLooking now.');
  // The thinking blocks come back whole, signatures intact, to be passed back.
  assert.deepEqual(result.message.content, message.content);
});

test('only the 5.5 generation asks for progress updates', () => {
  assert.match(PROGRESS_UPDATES_BETA, /^thinking-display-updates-/);
  for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']) {
    assert.equal(modelWritesProgressUpdates(model), true, model);
    assert.equal(modelAcceptsSamplingParams(model), false, model);
  }
  for (const model of ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-sonnet-5']) {
    assert.equal(modelWritesProgressUpdates(model), false, model);
  }
});

test('streamMessage returns tool use blocks whole', async () => {
  const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'search_archive', input: { query: 'RSS' } };
  const result = await streamMessage(
    { model: 'claude-sonnet-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] },
    { client: fakeClient({ content: [toolUse], stop_reason: 'tool_use', usage: {} }) }
  );
  assert.deepEqual(result.message.content, [toolUse]);
  assert.equal(result.text, '');
  assert.equal(result.stopReason, 'tool_use');
});

test('the 5.5 models think at medium effort with progress updates and no temperature', () => {
  const saved = process.env.THINGY_EFFORT;
  delete process.env.THINGY_EFFORT;
  try {
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5']) {
      assert.deepEqual(agentInferenceConfig(model), {
        max_tokens: 16000,
        thinking: { type: 'adaptive', display: 'updates' },
        output_config: { effort: 'medium' },
        betas: [PROGRESS_UPDATES_BETA]
      });
    }
    process.env.THINGY_EFFORT = 'high';
    assert.equal(agentInferenceConfig('claude-sonnet-5-5').output_config.effort, 'high');
    process.env.THINGY_EFFORT = 'extreme';
    assert.equal(agentInferenceConfig('claude-sonnet-5-5').output_config.effort, 'medium');
  } finally {
    if (saved === undefined) delete process.env.THINGY_EFFORT;
    else process.env.THINGY_EFFORT = saved;
  }
  // Rolling back by model id restores the old request shape.
  assert.deepEqual(agentInferenceConfig('claude-sonnet-4-6'), { max_tokens: 2500, temperature: 0.45 });
});

test('the client refuses to start without an API key', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      streamMessage({ model: 'claude-sonnet-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] }),
      /ANTHROPIC_API_KEY is not configured/
    );
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('the 5.x models search with dynamic filtering, Haiku with the basic search', () => {
  const saved = process.env.THINGY_WEB_SEARCH_MAX_USES;
  delete process.env.THINGY_WEB_SEARCH_MAX_USES;
  try {
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-4-6']) {
      assert.deepEqual(webSearchTool(model), { type: 'web_search_20260209', name: 'web_search', max_uses: 5 }, model);
    }
    assert.deepEqual(webSearchTool('claude-haiku-4-5'), {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5
    });
    process.env.THINGY_WEB_SEARCH_MAX_USES = '3';
    assert.equal(webSearchTool('claude-sonnet-5-5').max_uses, 3);
    process.env.THINGY_WEB_SEARCH_MAX_USES = 'lots';
    assert.equal(webSearchTool('claude-sonnet-5-5').max_uses, 5);
  } finally {
    if (saved === undefined) delete process.env.THINGY_WEB_SEARCH_MAX_USES;
    else process.env.THINGY_WEB_SEARCH_MAX_USES = saved;
  }
});

test('web search goes last and carries the tool-list breakpoint', () => {
  const archive = anthropicTools(availableToolSpecs());
  const before = JSON.stringify(archive);
  const tools = withWebSearch(archive, 'claude-sonnet-5-5');
  assert.equal(tools.length, archive.length + 1);
  assert.equal(tools.at(-1).name, WEB_SEARCH_TOOL);
  assert.deepEqual(tools.at(-1).cache_control, { type: 'ephemeral' });
  assert.deepEqual(
    tools.filter((tool) => tool.cache_control).map((tool) => tool.name),
    [WEB_SEARCH_TOOL]
  );
  // The archive list it was built from is left as it was.
  assert.equal(JSON.stringify(archive), before);
});

test('web search binds in the signed-in chat only, and THINGY_WEB_SEARCH=off unbinds it', () => {
  // The guest lane runs on WEB_TOOLS, so it never names web search.
  assert.equal(WEB_TOOLS.includes(WEB_SEARCH_TOOL), false);
  // Nor do the archive tool specs that /mcp and /tools serve.
  assert.equal(
    availableToolSpecs().some((entry) => entry.toolSpec?.name === WEB_SEARCH_TOOL),
    false
  );
  const saved = process.env.THINGY_WEB_SEARCH;
  try {
    delete process.env.THINGY_WEB_SEARCH;
    assert.equal(webSearchEnabled(), true);
    process.env.THINGY_WEB_SEARCH = 'off';
    assert.equal(webSearchEnabled(), false);
  } finally {
    if (saved === undefined) delete process.env.THINGY_WEB_SEARCH;
    else process.env.THINGY_WEB_SEARCH = saved;
  }
});

// A web-search answer as the API returns it: the search, its results, and
// the answer split into text blocks where the citation starts and ends.
const searchTurn = {
  content: [
    { type: 'thinking', thinking: 'Checking what happened since.', signature: 'sig' },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'IndieWeb Camp 2026' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: [
        { type: 'web_search_result', url: 'https://indieweb.org/2026', title: 'IndieWeb 2026', encrypted_content: 'x' },
        { type: 'web_search_result', url: 'https://example.com/b', title: 'B', encrypted_content: 'y' }
      ]
    },
    { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'more' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_2',
      content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' }
    },
    { type: 'text', text: 'According to the IndieWeb wiki, ' },
    {
      type: 'text',
      text: 'the 2026 camp met in Minneapolis',
      citations: [
        {
          type: 'web_search_result_location',
          url: 'https://indieweb.org/2026',
          title: 'IndieWeb 2026',
          encrypted_index: 'i',
          cited_text: 'Minneapolis'
        }
      ]
    },
    { type: 'text', text: '.' }
  ],
  stop_reason: 'end_turn',
  usage: { server_tool_use: { web_search_requests: 2 } }
};

test('a cited answer reads as one passage, in text, narration and the stream', async () => {
  const sentence = 'According to the IndieWeb wiki, the 2026 camp met in Minneapolis.';
  assert.equal(messageText(searchTurn), sentence);
  const deltas = [];
  const servers = [];
  const result = await streamMessage(
    { model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] },
    {
      client: fakeClient(searchTurn, [
        [0, thinkingDelta('Checking what happened since.')],
        [1, null, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }],
        [5, textDelta('According to the IndieWeb wiki, ')],
        [6, textDelta('the 2026 camp met in Minneapolis')],
        [7, textDelta('.')]
      ]),
      onTextDelta: (delta) => deltas.push(delta),
      onServerToolUse: (name) => servers.push(name)
    }
  );
  assert.deepEqual(servers, ['web_search']);
  assert.equal(deltas.join(''), `Checking what happened since.\n\n${sentence}`);
  assert.equal(result.text, sentence);
  assert.equal(result.narration, `Checking what happened since.\n\n${sentence}`);
  // Search blocks come back whole, encrypted content intact, to be sent back.
  assert.deepEqual(result.message.content, searchTurn.content);
});

test('webSearchActivity reports each search and the cited pages once', () => {
  const activity = webSearchActivity([
    ...searchTurn.content,
    // Asked for alongside an archive tool: no result yet.
    { type: 'server_tool_use', id: 'srvtoolu_3', name: 'web_search', input: { query: 'later' } },
    {
      type: 'text',
      text: 'Again.',
      citations: [
        { type: 'web_search_result_location', url: 'https://indieweb.org/2026', title: 'IndieWeb 2026' },
        { type: 'char_location', url: 'https://not-a-web-cite.example', title: 'doc' }
      ]
    }
  ]);
  assert.deepEqual(activity.searches, [
    { query: 'IndieWeb Camp 2026', ok: true, results: 2 },
    { query: 'more', ok: false, results: 0, error: 'max_uses_exceeded' },
    { query: 'later', ok: false, results: 0, error: 'not_run' }
  ]);
  assert.deepEqual(activity.sources, [{ url: 'https://indieweb.org/2026', title: 'IndieWeb 2026' }]);
  assert.deepEqual(webSearchActivity(undefined), { searches: [], sources: [] });
});
