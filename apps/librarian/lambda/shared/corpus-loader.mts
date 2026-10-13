import { JSONParser } from '@streamparser/json';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

/** Parse S3 JSON incrementally. Never hold compressed bytes, the complete
 * decompressed buffer and a UTF-8 copy alongside the parsed corpus. */
export async function readCorpusJson(body: AsyncIterable<Uint8Array>): Promise<unknown> {
  const iterator = body[Symbol.asyncIterator]();
  const prefix: Uint8Array[] = [];
  let length = 0;
  while (length < 2) {
    const item = await iterator.next();
    if (item.done) break;
    prefix.push(item.value);
    length += item.value.length;
  }
  const magic = Buffer.concat(prefix);
  const source = Readable.from(
    (async function* () {
      yield* prefix;
      for (;;) {
        const item = await iterator.next();
        if (item.done) break;
        yield item.value;
      }
    })()
  );
  const decoded = magic[0] === 0x1f && magic[1] === 0x8b ? source.pipe(createGunzip()) : source;
  source.on('error', (error) => decoded.destroy(error));
  const parser = new JSONParser({ paths: ['$', '$.chunks.*'], stringBufferSize: 64 * 1024 });
  let result: unknown;
  parser.onValue = ({ value, stack }) => {
    if (stack.length === 0) result = value;
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const chunk = value as Record<string, unknown>;
      // Preserve every binary64 value, but avoid boxed-number arrays from
      // a token parser. This is an in-memory representation only.
      if (Array.isArray(chunk.embedding)) chunk.embedding = Float64Array.from(chunk.embedding);
    }
  };
  try {
    for await (const bytes of decoded) parser.write(bytes as Buffer);
    if (!parser.isEnded) parser.end();
    return result;
  } finally {
    decoded.destroy();
    source.destroy();
    await iterator.return?.();
  }
}

/** One load per key, including cold concurrent requests. Failure releases
 * the slot so a subsequent request can retry. Completed caches stay owned
 * by retrieval; pending promises never contain reader-specific state. */
export function singleFlight() {
  const pending = new Map<string, Promise<unknown>>();
  return function load<T>(key: string, action: () => Promise<T>): Promise<T> {
    const active = pending.get(key);
    if (active) return active as Promise<T>;
    const promise = Promise.resolve()
      .then(action)
      .finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  };
}
