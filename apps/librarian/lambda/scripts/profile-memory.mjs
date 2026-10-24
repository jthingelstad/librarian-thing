// Replay downloaded published corpus artifacts with SDK fakes. No AWS or model calls.
import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { s3, bedrock } from '../dist/shared/aws-clients.mjs';
import { loadCorpus, loadGraph, retrieve } from '../dist/shared/retrieval.mjs';
const directory = process.argv[2];
if (!directory) throw new Error('Supply a directory with the six *.json.gz artifacts');
process.env.CORPUS_BUCKET = 'fixture';
process.env.CORPUS_KEY = 'corpus.json';
process.env.BLOG_CORPUS_KEY = 'blog_corpus.json';
process.env.PODCAST_CORPUS_KEY = 'podcast_corpus.json';
process.env.REFERENCE_CORPUS_KEY = 'reference_corpus.json';
process.env.LINKS_CORPUS_KEY = 'links_corpus.json';
process.env.GRAPH_KEY = 'graph.json';
const reads = {};
s3.send = async ({ input }) => {
  reads[input.Key] = (reads[input.Key] || 0) + 1;
  return { Body: createReadStream(resolve(directory, input.Key + '.gz')) };
};
bedrock.send = async () => ({
  body: Buffer.from(JSON.stringify({ embeddings: [Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))] }))
});
const began = performance.now();
const report = (phase) =>
  console.log(
    JSON.stringify({
      phase,
      elapsed_ms: Math.round(performance.now() - began),
      memory: process.memoryUsage(),
      max_rss_kib: process.resourceUsage().maxRSS,
      reads
    })
  );
report('start');
await Promise.all(
  Array.from({ length: 8 }, () =>
    Promise.all(['weekly_thing', 'blog', 'podcast', 'reference'].map((kind) => loadCorpus(kind)))
  )
);
await loadGraph();
report('loaded');
const results = await Promise.all(
  Array.from({ length: 8 }, () => retrieve('Minnebar technology community', 8, { scope: 'all' }, { rerank: false }))
);
if (Object.values(reads).some((count) => count !== 1)) throw new Error('Concurrent loading duplicated an S3 read');
const hashes = results.map((rows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex'));
if (new Set(hashes).size !== 1) throw new Error('Parallel retrieval results differ');
report('parallel_indexed');
global.gc?.();
report('gc');
// The links corpus loads only when a request names source kind link: the
// phases above never read it. A link retrieval loads and indexes it on top.
if (existsSync(resolve(directory, 'links_corpus.json.gz'))) {
  const linkStart = performance.now();
  const linkResults = await Promise.all(
    Array.from({ length: 8 }, () =>
      retrieve('Minnebar technology community', 8, { scope: 'all', sourceKinds: ['link'] }, { rerank: false })
    )
  );
  if (Object.values(reads).some((count) => count !== 1)) throw new Error('Concurrent loading duplicated an S3 read');
  const linkHashes = linkResults.map((rows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex'));
  if (new Set(linkHashes).size !== 1) throw new Error('Parallel link retrieval results differ');
  if (!linkResults[0].some((row) => row.source_kind === 'link')) throw new Error('A link retrieval found no link');
  console.log(JSON.stringify({ phase: 'links_load_ms', ms: Math.round(performance.now() - linkStart) }));
  report('links_indexed');
  global.gc?.();
  report('links_gc');
}
