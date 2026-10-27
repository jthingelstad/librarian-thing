import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInfo } from '../dist/shared/build-info.mjs';

// /health says what the deployment was built from: the stack's NativeBuildId
// and the corpus object versions it was computed over. The sync page
// compares the versions with the objects' current ones to say whether
// Thingy serves the newest corpus.
test('buildInfo reports the build id and the corpus versions the stack set', () => {
  const versions = { 'artifacts/corpus.json': 'v1', 'artifacts/blog_corpus.json': 'v2' };
  assert.deepEqual(
    buildInfo({ LIBRARIAN_SOURCE_REVISION: 'abc123', LIBRARIAN_CORPUS_VERSIONS: JSON.stringify(versions) }),
    { source_revision: 'abc123', corpus_versions: versions }
  );
});

test('buildInfo is null where the environment carries nothing usable', () => {
  assert.deepEqual(buildInfo({}), { source_revision: null, corpus_versions: null });
  assert.deepEqual(buildInfo({ LIBRARIAN_SOURCE_REVISION: '', LIBRARIAN_CORPUS_VERSIONS: '' }), {
    source_revision: null,
    corpus_versions: null
  });
  for (const raw of ['not json', '[]', '{"other/key":"v"}', '{"artifacts/corpus.json":""}', '{"artifacts/corpus.json":1}']) {
    assert.equal(buildInfo({ LIBRARIAN_CORPUS_VERSIONS: raw }).corpus_versions, null, raw);
  }
});
