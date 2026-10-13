import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { readCorpusJson, singleFlight } from '../dist/shared/corpus-loader.mjs';
async function* pieces(bytes, width = 1) {
  for (let i = 0; i < bytes.length; i += width) yield bytes.subarray(i, i + width);
}
const fixture = {
  chunks: [{ embedding: [0.1234567890123456, -0.4, 0], text: 'Jamie’s 🦉 archive\\\"' }],
  nested: { empty: [], none: null, enabled: true }
};
for (const gzip of [false, true])
  test(`streamed JSON retains Unicode and double precision, gzip=${gzip}`, async () => {
    const bytes = Buffer.from(JSON.stringify(fixture));
    const parsed = await readCorpusJson(pieces(gzip ? gzipSync(bytes) : bytes));
    assert.ok(parsed.chunks[0].embedding instanceof Float64Array);
    parsed.chunks[0].embedding = Array.from(parsed.chunks[0].embedding);
    assert.deepEqual(parsed, fixture);
  });
test('truncated JSON and corrupt gzip fail instead of publishing a partial corpus', async () => {
  await assert.rejects(readCorpusJson(pieces(Buffer.from('{"chunks":['))));
  await assert.rejects(readCorpusJson(pieces(Buffer.from([31, 139, 0, 1, 2]))));
});
test('a failed source aborts parsing', async () => {
  async function* broken() {
    yield Buffer.from('{"chunks":[');
    throw new Error('S3 unavailable');
  }
  await assert.rejects(readCorpusJson(broken()), /S3 unavailable/);
});
test('cold concurrent loads share one operation; a failure allows retry', async () => {
  const load = singleFlight();
  let calls = 0;
  let finish;
  const action = () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const reads = Array.from({ length: 8 }, () => load('corpus', action));
  await Promise.resolve();
  assert.equal(calls, 1);
  finish(fixture);
  assert.deepEqual(await Promise.all(reads), Array(8).fill(fixture));
  await assert.rejects(
    load('corpus', async () => {
      throw new Error('retryable');
    })
  );
  assert.equal(await load('corpus', async () => 7), 7);
});
