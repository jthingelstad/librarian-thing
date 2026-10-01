// Thingy's chat agent and the MCP door share one tool registry, but the chat
// learns the tools from agent-system.md. A call the prompt teaches with an
// argument the schema dropped (archive_gems mood, source_neighborhood url,
// both retired in 2.0.0) would be refused at the door - these keep the two in
// step, and pin the chat loop's refusal shape.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { availableToolSpecs } from '../dist/shared/archive-tools.mjs';
import { invalidArgumentsRecord, toolErrorRecord, validateToolArguments } from '../dist/shared/mcp.mjs';

const systemPrompt = readFileSync(new URL('../prompts/agent-system.md', import.meta.url), 'utf8');

function boundSchemas() {
  return new Map(
    availableToolSpecs()
      .filter((entry) => entry.toolSpec?.name)
      .map((entry) => [entry.toolSpec.name, entry.toolSpec.inputSchema?.json?.properties || {}])
  );
}

// `tool(arg="x", other=[1, 2])` as the prompt writes a worked call.
function taughtCalls(text) {
  return [...text.matchAll(/`([a-z_]+)\(([^`]*)\)`/g)].map(([, name, args]) => ({
    name,
    keys: [...args.matchAll(/(?:^|,)\s*([a-z_]+)\s*=/g)].map((match) => match[1])
  }));
}

test('every call the chat prompt teaches uses a bound tool and declared arguments', () => {
  const schemas = boundSchemas();
  const calls = taughtCalls(systemPrompt);
  assert.ok(calls.length >= 8, `expected worked calls in agent-system.md, found ${calls.length}`);
  for (const { name, keys } of calls) {
    assert.ok(schemas.has(name), `agent-system.md teaches ${name}(), which the chat does not bind`);
    for (const key of keys) {
      assert.ok(key in schemas.get(name), `agent-system.md teaches ${name}(${key}=...), which its schema does not declare`);
    }
  }
});

test('every enum value the chat prompt teaches is one the schema accepts', () => {
  const schemas = boundSchemas();
  for (const match of systemPrompt.matchAll(/`([a-z_]+)\(([^`]*)\)`/g)) {
    const [, name, args] = match;
    for (const [, key, value] of args.matchAll(/([a-z_]+)="([^"]*)"/g)) {
      const allowed = schemas.get(name)?.[key]?.enum;
      if (allowed) assert.ok(allowed.includes(value), `${name}(${key}="${value}") is not one of ${allowed.join(', ')}`);
    }
  }
});

test('the chat prompt routes to every tool the chat binds', () => {
  for (const name of boundSchemas().keys()) {
    assert.ok(systemPrompt.includes(`\`${name}`), `agent-system.md never mentions ${name}`);
  }
});

test('a retired argument is refused with the accepted list and a next step', () => {
  const problems = validateToolArguments('archive_gems', { mood: 'serendipity' });
  assert.deepEqual(problems, ['unknown argument "mood"']);
  const record = invalidArgumentsRecord('archive_gems', problems);
  assert.equal(record.code, 'bad_request');
  assert.match(record.error, /Invalid arguments for archive_gems: unknown argument "mood"/);
  assert.ok(record.accepted_arguments.includes('mode'));
  assert.equal(typeof record.next, 'string');
  assert.deepEqual(validateToolArguments('source_neighborhood', { source_kind: 'blog', url: 'https://x' }), [
    'unknown argument "source_kind"',
    'unknown argument "url"',
    'id is required'
  ]);
});

test('a handler error reaches the chat with a code and a next step', () => {
  const record = toolErrorRecord({ error: 'Source not found: wt-9999' });
  assert.equal(record.code, 'not_found');
  assert.match(record.next, /search_archive/);
  const own = toolErrorRecord({ error: 'Unknown tool: x', code: 'bad_request', next: 'Call only the tools in your tool list.' });
  assert.equal(own.next, 'Call only the tools in your tool list.');
});
