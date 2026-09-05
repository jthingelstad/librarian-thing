import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedImageUrl, VIEW_PHOTO_MAX_IMAGES } from '../dist/shared/photo-view.mjs';
import { handleMcpMessage } from '../dist/shared/mcp.mjs';

function context(overrides = {}) {
  return {
    subscriberHash: 'sub-1',
    entitlements: ['reader'],
    scope: 'archive:read',
    spendQuota: async () => ({ allowed: true, count: 1, max: 500 }),
    invokeTool: async (name, input) => ({ echoed: name, input }),
    ...overrides
  };
}

const stubViewPhoto = async (urls) => ({
  photos: (Array.isArray(urls) ? urls : []).slice(0, 1).map((url) => ({
    url: String(url),
    mimeType: 'image/jpeg',
    dataBase64: 'aGVsbG8=',
    bytes: 5
  })),
  refused: (Array.isArray(urls) ? urls : []).slice(1).map((url) => ({ url: String(url), reason: 'test' }))
});

test('the image allowlist admits archive hosts and nothing else', () => {
  assert.ok(allowedImageUrl('https://files.thingelstad.com/weekly-thing/349/cover.jpg'));
  assert.ok(allowedImageUrl('https://www.thingelstad.com/uploads/2026/x.jpg'));
  assert.ok(allowedImageUrl('https://thingelstad.com/x.png'));
  assert.ok(allowedImageUrl('https://cdn.uploads.micro.blog/12/x.jpg'));
  assert.ok(allowedImageUrl('https://assets.buttondown.email/images/x.png'));
  // The rest of the internet is not an image proxy.
  assert.equal(allowedImageUrl('https://evil.example.com/x.jpg'), null);
  assert.equal(allowedImageUrl('https://thingelstad.com.evil.example/x.jpg'), null);
  assert.equal(allowedImageUrl('http://files.thingelstad.com/x.jpg'), null); // https only
  assert.equal(allowedImageUrl('data:image/png;base64,AAAA'), null);
  assert.equal(allowedImageUrl(''), null);
  assert.equal(allowedImageUrl(undefined), null);
});

test('tools/list offers view_photo exactly when the surface has the capability', async () => {
  const withCap = await handleMcpMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    context({ viewPhoto: stubViewPhoto })
  );
  assert.ok(withCap.payload.result.tools.some((tool) => tool.name === 'view_photo'));

  const without = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, context());
  assert.ok(!without.payload.result.tools.some((tool) => tool.name === 'view_photo'));
});

test('view_photo returns image blocks plus an honest text summary', async () => {
  const reply = await handleMcpMessage(
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'view_photo',
        arguments: { image_urls: ['https://files.thingelstad.com/a.jpg', 'https://files.thingelstad.com/b.jpg'] }
      }
    },
    context({ viewPhoto: stubViewPhoto })
  );
  const { content, isError } = reply.payload.result;
  assert.equal(isError, false);
  assert.deepEqual(content[0], { type: 'image', data: 'aGVsbG8=', mimeType: 'image/jpeg' });
  const summary = JSON.parse(content.at(-1).text);
  assert.equal(summary.shown.length, 1);
  assert.equal(summary.refused.length, 1);
  assert.match(summary.server_version, /^1\.2\.0\+tools\./);
});

test('view_photo with nothing viewable is an error result, not a silent success', async () => {
  const reply = await handleMcpMessage(
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'view_photo', arguments: { image_urls: [] } }
    },
    context({ viewPhoto: async () => ({ photos: [], refused: [{ url: 'x', reason: 'not an archive image host' }] }) })
  );
  assert.equal(reply.payload.result.isError, true);
});

test('view_photo without the capability is an unknown tool', async () => {
  const reply = await handleMcpMessage(
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'view_photo', arguments: { image_urls: [] } } },
    context()
  );
  assert.ok(reply.payload.error);
});

test('view_photo spends quota like any other call', async () => {
  const reply = await handleMcpMessage(
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'view_photo', arguments: { image_urls: ['x'] } } },
    context({ viewPhoto: stubViewPhoto, spendQuota: async () => ({ allowed: false, count: 500, max: 500 }) })
  );
  assert.equal(reply.payload.error.code, -32029);
});

test('the per-call image cap is small on purpose', () => {
  assert.equal(VIEW_PHOTO_MAX_IMAGES, 3);
});

test('image type is judged by magic bytes, never by headers', async () => {
  const { sniffImageMime } = await import('../dist/shared/photo-view.mjs');
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'image/png');
  assert.equal(sniffImageMime(Buffer.from('GIF89a______')), 'image/gif');
  assert.equal(sniffImageMime(Buffer.from('RIFF____WEBP')), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from('<html><body>')), null);
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8])), null); // too short to judge
});

test('the resize proxy URL is built from the original, fit-resize form', async () => {
  const { resizeProxyUrl, RESIZE_WIDTH } = await import('../dist/shared/photo-view.mjs');
  assert.equal(
    resizeProxyUrl('https://www.thingelstad.com/uploads/2021/x.jpg'),
    `https://micro.blog/photos/${RESIZE_WIDTH}/https://www.thingelstad.com/uploads/2021/x.jpg`
  );
});

test('converse image format maps sniffed mime types', async () => {
  const { converseImageFormat } = await import('../dist/shared/photo-view.mjs');
  assert.equal(converseImageFormat('image/jpeg'), 'jpeg');
  assert.equal(converseImageFormat('image/png'), 'png');
  assert.equal(converseImageFormat('image/webp'), 'webp');
  assert.equal(converseImageFormat('image/gif'), 'gif');
});

test('view_photo is published for the chat loop but stays off MCP/web launch lists', async () => {
  const { toolSpecs } = await import('../dist/shared/archive-tools.mjs');
  const names = toolSpecs().map((spec) => spec.toolSpec?.name);
  assert.ok(names.includes('view_photo'));
  const { MCP_LAUNCH_TOOLS, WEB_TOOLS } = await import('../dist/shared/mcp.mjs');
  // MCP offers it via its own capability-gated declaration; the launch list
  // and the WebMCP page-tool subset never include it.
  assert.ok(!MCP_LAUNCH_TOOLS.includes('view_photo'));
  assert.ok(!WEB_TOOLS.includes('view_photo'));
});

test('the MCP declaration derives from the published spec - no drift', async () => {
  process.env.BRAVE_SEARCH_API_KEY = '';
  const { mcpToolDeclarations } = await import('../dist/shared/mcp.mjs');
  const decl = mcpToolDeclarations(['view_photo'])[0];
  assert.equal(decl.name, 'view_photo');
  assert.equal(decl.title, 'View archive photos');
  assert.ok(decl.description.includes('media_search'));
  assert.ok(decl.inputSchema.properties.image_urls);
});
