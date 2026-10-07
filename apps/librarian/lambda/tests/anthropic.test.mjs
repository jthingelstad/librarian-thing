import assert from 'node:assert/strict';
import test from 'node:test';
import { anthropicTools, messageText, streamMessage } from '../dist/shared/anthropic.mjs';
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

function fakeClient(message, deltas = []) {
  const calls = [];
  return {
    calls,
    messages: {
      stream(params) {
        calls.push(params);
        const listeners = [];
        return {
          on(event, listener) {
            if (event === 'text') listeners.push(listener);
            return this;
          },
          async finalMessage() {
            for (const delta of deltas) for (const listener of listeners) listener(delta);
            return message;
          }
        };
      }
    }
  };
}

test('streamMessage forwards text deltas and returns the assembled turn', async () => {
  const message = {
    content: [{ type: 'text', text: 'First second.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 3 }
  };
  const client = fakeClient(message, ['First ', 'second.']);
  const deltas = [];
  const result = await streamMessage(
    { model: 'claude-sonnet-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] },
    { client, onTextDelta: (delta) => deltas.push(delta) }
  );
  assert.deepEqual(deltas, ['First ', 'second.']);
  assert.equal(result.text, 'First second.');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.usage.output_tokens, 3);
  assert.equal(client.calls[0].model, 'claude-sonnet-4-6');
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
