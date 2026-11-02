#!/usr/bin/env node
/**
 * Builds the keyword index (shared/keyword-index.mts) from the corpora a
 * deploy ships, the way the Lambda loads them:
 *
 *   node scripts/build-keyword-index.mjs <out.db>
 *
 * The corpora come from scripts/load-corpora.mjs (EVAL_CORPUS_DIR, with
 * EVAL_CORPUS_FALLBACK=s3 for the ones a deploy did not rebuild; neither,
 * every corpus from S3). They prime the Lambda's own loader (dist/, or
 * EVAL_DIST_DIR), so the index holds exactly the rows its keyword scans
 * read. The file is then checked by the coverage oracle
 * (keyword-index-coverage.mjs): every corpus row once, nothing else, the
 * corpora's build stamps recorded. A failed check leaves no file.
 *
 * Beside the index goes its fact (<out stem>.fact.json, keyword_index.fact.json
 * beside keyword_index.db), which pipeline/deploy/upload_keyword_index.py
 * writes onto the S3 object as metadata: when it was built, its rows, its
 * schema and the sha256 of the file.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYWORD_KINDS, keywordIndexCoverage } from './keyword-index-coverage.mjs';
import { loadCorpora } from './load-corpora.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.env.EVAL_DIST_DIR || path.join(here, '..', 'dist');
const out = process.argv[2];
if (!out || process.argv.length > 3) {
  console.error('usage: node scripts/build-keyword-index.mjs <out.db>');
  process.exit(2);
}

const { primeCorpusCachesForTests, keywordIndexSources } = await import(path.join(distDir, 'shared/retrieval.mjs'));
const { writeKeywordIndex } = await import(path.join(distDir, 'shared/keyword-index.mjs'));

const { corpora } = await loadCorpora();
const absent = KEYWORD_KINDS.filter((kind) => !corpora[kind]);
if (absent.length) {
  // An index without a corpus the Lambda loads would leave that corpus's
  // retrievals on the old scan; refuse rather than ship it.
  console.error(`build-keyword-index: no ${absent.join(', ')} corpus to index`);
  process.exit(1);
}
primeCorpusCachesForTests(corpora);

const start = performance.now();
const fact = path.join(path.dirname(out), `${path.basename(out, path.extname(out))}.fact.json`);
mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
for (const file of [out, `${out}-journal`, fact]) rmSync(file, { force: true });
const meta = await writeKeywordIndex(out, await keywordIndexSources());
const { problems, counts } = keywordIndexCoverage(out, corpora);
if (problems.length) {
  rmSync(out, { force: true });
  console.error('build-keyword-index: the index does not cover the corpora');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

const rows = Object.values(counts).reduce((total, n) => total + n, 0);
const sha256 = createHash('sha256').update(readFileSync(out)).digest('hex');
writeFileSync(
  fact,
  `${JSON.stringify(
    {
      'built-at': meta.built_at,
      'item-count': String(rows),
      'index-schema': String(meta.schema),
      'index-sha256': sha256,
      // The corpora it was built from, by their build stamps, so a HEAD
      // says whether the index matches the corpora beside it.
      ...Object.fromEntries(
        KEYWORD_KINDS.map((kind) => [`from-${kind.replaceAll('_', '-')}`, meta.kinds[kind]?.generated_at ?? 'none'])
      )
    },
    null,
    0
  )}\n`
);
const megabytes = (statSync(out).size / 1024 / 1024).toFixed(1);
console.log(
  `keyword index ${out}: ${rows} rows (${KEYWORD_KINDS.map((kind) => `${kind} ${counts[kind]}`).join(', ')}), ` +
    `${megabytes} MB, built in ${((performance.now() - start) / 1000).toFixed(1)} s; coverage checked`
);
