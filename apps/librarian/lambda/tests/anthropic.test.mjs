import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROGRESS_UPDATES_BETA,
  UnusableModelResponseError,
  agentInferenceConfig,
  anthropicTools,
  messageText,
  oneShotInferenceConfig,
  oneShotText,
  streamMessage
} from '../dist/shared/anthropic.mjs';
import {
  FAST_THINGY_MODEL,
  fastModel,
  modelAcceptsSamplingParams,
  modelWritesProgressUpdates
} from '../dist/shared/aws-clients.mjs';
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
              for (const [index, delta] of events) {
                for (const listener of listeners) listener({ type: 'content_block_delta', index, delta });
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

test('sampling params go only to the older models that take them', () => {
  for (const model of [
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5-20250929',
    'claude-sonnet-4-20250514',
    'anthropic.claude-sonnet-4-20250514-v1:0',
    'claude-opus-4-6',
    'claude-opus-4-1-20250805',
    'claude-3-5-haiku-20241022'
  ]) {
    assert.equal(modelAcceptsSamplingParams(model), true, model);
  }
  // Haiku 5.5 is a 400 on any temperature/top_p/top_k, and so is an id the
  // allowlist has never seen: a new model must not get a temperature.
  for (const model of [
    'claude-haiku-5-5',
    'claude-sonnet-5',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-fable-5-1',
    'claude-haiku-6',
    'claude-sonnet-4-9',
    ''
  ]) {
    assert.equal(modelAcceptsSamplingParams(model), false, model);
  }
});

const ONE_SHOT = {
  maxTokens: 650,
  thinkingMaxTokens: 4000,
  maxTokensEnv: 'TEST_ONE_SHOT_MAX_TOKENS',
  temperature: 0,
  temperatureEnv: 'TEST_ONE_SHOT_TEMPERATURE',
  effort: 'low'
};

test('the fast model is Haiku 5.5 and its one-shot calls carry effort and no sampling params', () => {
  const saved = process.env.THINGY_FAST_MODEL;
  delete process.env.THINGY_FAST_MODEL;
  try {
    assert.equal(FAST_THINGY_MODEL, 'claude-haiku-5-5');
    assert.equal(fastModel(), 'claude-haiku-5-5');
    const config = oneShotInferenceConfig(fastModel(), ONE_SHOT);
    assert.deepEqual(config, { max_tokens: 4000, output_config: { effort: 'low' } });
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) assert.equal(key in config, false, key);
  } finally {
    if (saved !== undefined) process.env.THINGY_FAST_MODEL = saved;
  }
});

test('one-shot settings keep the old shape on Haiku 4.5 and honor the env overrides', () => {
  assert.deepEqual(oneShotInferenceConfig('claude-haiku-4-5', ONE_SHOT), { max_tokens: 650, temperature: 0 });
  process.env.TEST_ONE_SHOT_MAX_TOKENS = '9000';
  process.env.TEST_ONE_SHOT_TEMPERATURE = '0.3';
  try {
    assert.deepEqual(oneShotInferenceConfig('claude-haiku-4-5', ONE_SHOT), { max_tokens: 9000, temperature: 0.3 });
    assert.deepEqual(oneShotInferenceConfig('claude-haiku-5-5', ONE_SHOT), {
      max_tokens: 9000,
      output_config: { effort: 'low' }
    });
  } finally {
    delete process.env.TEST_ONE_SHOT_MAX_TOKENS;
    delete process.env.TEST_ONE_SHOT_TEMPERATURE;
  }
  assert.deepEqual(oneShotInferenceConfig('claude-haiku-5-5', { ...ONE_SHOT, effort: 'medium' }).output_config, {
    effort: 'medium'
  });
});

test('one-shot text is read from text blocks when a thinking block comes first', () => {
  const response = {
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: '{"action":"pass"}' }
    ],
    stop_reason: 'end_turn'
  };
  assert.equal(oneShotText(response, { call: 'preflight', model: 'claude-haiku-5-5' }), '{"action":"pass"}');
  // Truncated text is still text: the caller's parser decides what it is worth.
  assert.equal(
    oneShotText(
      {
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: '{"act' }
        ],
        stop_reason: 'max_tokens'
      },
      { call: 'preflight', model: 'claude-haiku-5-5' }
    ),
    '{"act'
  );
});

test('a refusal or a max_tokens stop with no text throws onto the caller failure path, with a log line', () => {
  const logged = [];
  const log = (level, message, fields) => logged.push({ level, message, ...fields });
  const context = { call: 'eval_review', model: 'claude-haiku-5-5', log };
  assert.throws(
    () =>
      oneShotText(
        {
          content: [{ type: 'thinking', thinking: '' }],
          stop_reason: 'max_tokens',
          usage: { output_tokens: 8000 }
        },
        context
      ),
    (error) => error instanceof UnusableModelResponseError && error.stopReason === 'max_tokens'
  );
  assert.throws(
    () => oneShotText({ content: [{ type: 'text', text: 'partial' }], stop_reason: 'refusal' }, context),
    (error) => error instanceof UnusableModelResponseError && error.stopReason === 'refusal'
  );
  assert.deepEqual(
    logged.map(({ level, message, call, stop_reason }) => ({ level, message, call, stop_reason })),
    [
      { level: 'warning', message: 'model_response_unusable', call: 'eval_review', stop_reason: 'max_tokens' },
      { level: 'warning', message: 'model_response_unusable', call: 'eval_review', stop_reason: 'refusal' }
    ]
  );
  assert.equal(logged[0].output_tokens, 8000);
});
