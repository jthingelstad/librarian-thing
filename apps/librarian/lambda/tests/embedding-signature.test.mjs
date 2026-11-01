// Each corpus records the model and vector length it was embedded with, and
// the query is embedded the same way, once per signature. A corpus on another
// model gets its own query vector; a vector of the wrong length fails that
// corpus's semantic leg, logged, and leaves the others theirs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bedrock } from '../dist/shared/aws-clients.mjs';
import {
  embeddingsFromResponse,
  embeddingSignature,
  embedQueryBody,
  loadedEmbeddingModel,
  primeCorpusCachesForTests,
  retrieve
} from '../dist/shared/retrieval.mjs';

process.env.LIBRARIAN_RERANK_ENABLED = '0';

const V3 = 'cohere.embed-english-v3';
const V4 = 'cohere.embed-v4:0';

const unit = (length, hot) => Array.from({ length }, (_, index) => (index === hot ? 1 : 0));

const chunk = (fields) => ({
  issue_number: 1,
  issue_year: 2020,
  publish_date: '2020-01-04',
  topics: [],
  ...fields,
  word_count: String(fields.text).split(/\s+/).length
});

const corpus = (source, model, dimensions, chunks) => ({
  version: 2,
  source,
  embedding_model: model,
  embedding_dimensions: dimensions,
  chunks,
  issues: [],
  topics: [],
  links: [],
  media: []
});

// The query is about nothing the lexical leg can find, so only a semantic
// hit can return a row.
const QUERY = 'zzqx';

function fixtures({ blogModel = V4, blogDimensions = 512 } = {}) {
  return {
    weekly_thing: corpus('weekly_thing', V3, 1024, [
      chunk({ id: 'wt-1:0', source_kind: 'weekly_thing', text: 'Lake weekends and canoes.', embedding: unit(1024, 0) })
    ]),
    blog: corpus('blog', blogModel, blogDimensions, [
      chunk({
        id: 'blog-9:0',
        source_kind: 'blog',
        post_id: 9,
        url: 'https://www.thingelstad.com/2020/01/04/winter.html',
        text: 'Winter light over the river.',
        embedding: unit(blogDimensions, 0)
      })
    ]),
    podcast: corpus('podcast', V3, 1024, [])
  };
}

function stubBedrock(answer) {
  const calls = [];
  const original = bedrock.send;
  bedrock.send = async (command) => {
    const body = JSON.parse(command.input.body);
    calls.push({ modelId: command.input.modelId, body });
    return { body: new TextEncoder().encode(JSON.stringify(answer(command.input.modelId, body))) };
  };
  return { calls, restore: () => (bedrock.send = original) };
}

// v3 answers with a bare list; v4 always keys the vectors by type.
const honest = (modelId, body) =>
  modelId.includes('embed-v4')
    ? { response_type: 'embeddings_by_type', embeddings: { float: [unit(body.output_dimension, 0)] } }
    : { embeddings: [unit(1024, 0)] };

test('the v3 query body is unchanged; v4 asks for its length and float vectors, as a document', () => {
  assert.deepEqual(embedQueryBody('q', { model: V3, dimensions: 1024 }), {
    texts: ['q'],
    input_type: 'search_query',
    truncate: 'END'
  });
  assert.deepEqual(embedQueryBody('q', { model: V4, dimensions: 512 }), {
    texts: ['q'],
    input_type: 'search_document',
    embedding_types: ['float'],
    output_dimension: 512,
    truncate: 'RIGHT'
  });
  // An inference profile is the same model.
  assert.equal(embedQueryBody('q', { model: `us.${V4}`, dimensions: 256 }).output_dimension, 256);
});

test('both response shapes parse; anything else is no vectors', () => {
  assert.deepEqual(embeddingsFromResponse({ embeddings: [[1, 2]] }), [[1, 2]]);
  assert.deepEqual(embeddingsFromResponse({ embeddings: { float: [[3, 4]] } }), [[3, 4]]);
  assert.deepEqual(embeddingsFromResponse({ embeddings: { int8: [[5, 6]] } }), []);
  assert.deepEqual(embeddingsFromResponse({}), []);
});

test('a corpus names its own signature; the environment fills in only when it names none', () => {
  assert.deepEqual(embeddingSignature({ embedding_model: V4, embedding_dimensions: 1536 }), {
    model: V4,
    dimensions: 1536
  });
  const saved = process.env.BEDROCK_EMBEDDING_MODEL;
  process.env.BEDROCK_EMBEDDING_MODEL = V3;
  try {
    assert.deepEqual(embeddingSignature({}), { model: V3, dimensions: 1024 });
  } finally {
    if (saved === undefined) delete process.env.BEDROCK_EMBEDDING_MODEL;
    else process.env.BEDROCK_EMBEDDING_MODEL = saved;
  }
});

test('corpora on different models each get a query vector from their own model, once', async () => {
  primeCorpusCachesForTests(fixtures());
  const stub = stubBedrock(honest);
  try {
    const found = await retrieve(QUERY, 10, { scope: 'all' }, { rerank: false });
    const ids = found.map((row) => row.id);
    assert.ok(ids.includes('wt-1:0'), 'the v3 corpus keeps its semantic hit');
    assert.ok(ids.includes('blog-9:0'), 'the v4 corpus finds its own');
    const models = stub.calls.map((call) => call.modelId).sort();
    assert.deepEqual(models, [V3, V4], 'one embedding call per signature, not per corpus');
    const v4Call = stub.calls.find((call) => call.modelId === V4);
    assert.equal(v4Call.body.output_dimension, 512);
  } finally {
    stub.restore();
  }
});

test('corpora that share a signature share one query vector', async () => {
  primeCorpusCachesForTests(fixtures({ blogModel: V3, blogDimensions: 1024 }));
  const stub = stubBedrock(honest);
  try {
    await retrieve(QUERY, 10, { scope: 'all' }, { rerank: false });
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('a wrong-length vector fails that corpus only, and says so', async () => {
  primeCorpusCachesForTests(fixtures());
  // v4 answering with its default 1536 when the corpus holds 512: the old
  // code scored every chunk 0 and returned nothing, silently.
  const stub = stubBedrock((modelId, body) =>
    modelId.includes('embed-v4') ? { embeddings: { float: [unit(1536, 0)] } } : honest(modelId, body)
  );
  const logged = [];
  const originalLog = console.log;
  console.log = (line) => logged.push(String(line));
  try {
    const ids = (await retrieve(QUERY, 10, { scope: 'all' }, { rerank: false })).map((row) => row.id);
    assert.ok(ids.includes('wt-1:0'), 'the matching corpus keeps its hit');
    assert.ok(!ids.includes('blog-9:0'));
  } finally {
    console.log = originalLog;
    stub.restore();
  }
  const failure = logged.map((line) => JSON.parse(line)).find((row) => row.message === 'semantic_retrieval_failed');
  assert.ok(failure, 'the failure is logged');
  assert.equal(failure.corpus, 'blog');
  assert.equal(failure.embedding_model, V4);
  assert.match(failure.error_message, /1536-dimension/);
});

test('engines runs one engine alone; the default runs both', async () => {
  primeCorpusCachesForTests(fixtures());
  const stub = stubBedrock(honest);
  try {
    const lexicalOnly = await retrieve('canoes', 10, { scope: 'all' }, { rerank: false, engines: ['lexical'] });
    assert.equal(stub.calls.length, 0, 'lexical alone embeds nothing');
    assert.ok(lexicalOnly.every((row) => (row.retrieval_modes || []).every((mode) => mode === 'lexical')));
    const semanticOnly = await retrieve('canoes', 10, { scope: 'all' }, { rerank: false, engines: ['semantic'] });
    assert.ok(semanticOnly.length > 0);
    assert.ok(semanticOnly.every((row) => (row.retrieval_modes || []).every((mode) => mode === 'semantic')));
    const both = await retrieve('canoes', 10, { scope: 'all' }, { rerank: false });
    const wt = both.find((row) => row.id === 'wt-1:0');
    assert.deepEqual([...wt.retrieval_modes].sort(), ['lexical', 'semantic']);
  } finally {
    stub.restore();
  }
});

test('the reported embedding model is what the loaded corpora record, not the environment default', () => {
  primeCorpusCachesForTests(fixtures());
  assert.equal(loadedEmbeddingModel(), [V3, V4].sort().join(', '));
  primeCorpusCachesForTests(fixtures({ blogModel: V3, blogDimensions: 1024 }));
  assert.equal(loadedEmbeddingModel(), V3);
});
