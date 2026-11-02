/**
 * The corpora as a deploy ships them, for the scripts that read them all:
 * the tool-surface eval (eval-tools.mjs) and the keyword index build
 * (build-keyword-index.mjs).
 *
 * EVAL_CORPUS_DIR names a directory of corpus files (plain or gzipped JSON);
 * without it each is read from S3 (CORPUS_BUCKET, default
 * weekly-thing-librarian, under artifacts/). With EVAL_CORPUS_FALLBACK=s3 a
 * file missing from the directory is read from S3 instead: the deploy stages
 * only the corpora it rebuilt and reads the live copy of the rest.
 *
 * The corpora come back as their files hold them; the Lambda's load-time
 * changes (the reference rows handed back to the Weekly Thing and the blog)
 * are each caller's own.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

export const CORPUS_FILES = {
  weekly_thing: 'corpus.json',
  blog: 'blog_corpus.json',
  podcast: 'podcast_corpus.json',
  // The reference base (2026-10-23): site pages, the FAQ, things, the blog's
  // pages and the reference documents. Absent (not uploaded yet), the
  // Weekly Thing and blog corpora still carry the rows, as before.
  reference: 'reference_corpus.json',
  // The saved links of Linking Things (2026-10-24), read only when a call
  // names source_kind link. Absent (not uploaded yet), it is empty.
  link: 'links_corpus.json',
  // The topic graph feeds list_topics, archive_lens topic cards and
  // similar issues; without it those tools ran degraded in CI.
  graph: 'graph.json'
};

export function parseJsonBytes(bytes) {
  const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
  return JSON.parse(text);
}

// Each corpus by kind, and where it came from (sources[kind]: 'file' or
// 's3'). A corpus neither place holds is left out.
export async function loadCorpora({ log = console.log } = {}) {
  const dir = process.env.EVAL_CORPUS_DIR;
  const fallback = process.env.EVAL_CORPUS_FALLBACK === 's3';
  let s3;
  const fetchKey = async (key) => {
    const { GetObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
    s3 ||= new S3Client({});
    const bucket = process.env.CORPUS_BUCKET || 'weekly-thing-librarian';
    try {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return parseJsonBytes(Buffer.from(await response.Body.transformToByteArray()));
    } catch (error) {
      log(`corpus ${key} unavailable: ${error.name}`);
      return undefined;
    }
  };
  const corpora = {};
  const sources = {};
  for (const [kind, name] of Object.entries(CORPUS_FILES)) {
    const file = dir ? path.join(dir, name) : '';
    if (file && existsSync(file)) {
      corpora[kind] = parseJsonBytes(readFileSync(file));
      sources[kind] = 'file';
      log(`corpus ${name}: ${file}`);
    } else if (!dir || fallback) {
      corpora[kind] = await fetchKey(`artifacts/${name}`);
      if (corpora[kind]) sources[kind] = 's3';
      if (corpora[kind] && dir) log(`corpus ${name}: live S3 copy (not staged)`);
    }
    if (!corpora[kind]) delete corpora[kind];
  }
  return { corpora, sources };
}
