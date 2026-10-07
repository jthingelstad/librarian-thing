// The exported MCP surface (contracts/mcp-surface.json) that Thingy's
// /connect/reference/ page renders from: it must be the tools/list the
// server declares, carry its checksum, and never a build fingerprint.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MCP_LAUNCH_TOOLS, VIEW_PHOTO_TOOL, mcpToolDeclarations } from '../dist/shared/mcp.mjs';

const artifactUrl = new URL('../../contracts/mcp-surface.json', import.meta.url);
const text = await readFile(artifactUrl, 'utf8');
const surface = JSON.parse(text);

test('the MCP surface artifact matches its checksum', async () => {
  const checksum = (await readFile(new URL('../../contracts/mcp-surface.sha256', import.meta.url), 'utf8')).split(
    /\s+/
  )[0];
  assert.equal(createHash('sha256').update(text).digest('hex'), checksum);
});

test('the MCP surface carries no build fingerprint', () => {
  assert.doesNotMatch(text, /\+tools\.[0-9a-f]{12}/);
  assert.match(surface.server.version, /^\d+\.\d+\.\d+$/);
});

test('the MCP surface declares the tools exactly as tools/list does', () => {
  const declared = mcpToolDeclarations([...MCP_LAUNCH_TOOLS, VIEW_PHOTO_TOOL]);
  assert.deepEqual(
    surface.tools.map((tool) => tool.name),
    declared.map((tool) => tool.name)
  );
  for (const tool of declared) {
    const entry = surface.tools.find((candidate) => candidate.name === tool.name);
    for (const key of ['title', 'description', 'inputSchema', 'outputSchema', 'annotations']) {
      assert.deepEqual(entry[key], tool[key], `${tool.name}.${key} is stale: run npm run mcp-surface:export`);
    }
  }
});

test('every tool says which doors offer it', () => {
  for (const tool of surface.tools) {
    assert.equal(tool.doors.mcp, true, tool.name);
    assert.equal(typeof tool.doors.webmcp, 'boolean', tool.name);
    assert.equal(typeof tool.doors.chat, 'boolean', tool.name);
  }
  assert.deepEqual(
    surface.doors.webmcp.tools,
    surface.tools.filter((tool) => tool.doors.webmcp).map((tool) => tool.name)
  );
});
