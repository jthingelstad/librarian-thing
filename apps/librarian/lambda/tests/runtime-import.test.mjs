import assert from 'node:assert/strict';
import test from 'node:test';
import { collectToolCitations } from '../dist/shared/archive-tools.mjs';

test('archive tool citations are exported for chat runtime', () => {
  const citations = collectToolCitations([
    {
      results: [
        {
          issue_number: 350,
          source_kind: 'weekly_thing',
          subject: 'Weekly Thing 350',
          section: 'Featured',
          url: '/archive/350/'
        }
      ]
    },
    {
      source: {
        source_kind: 'blog',
        subject: 'A blog post',
        url: 'https://www.thingelstad.com/example/'
      }
    }
  ]);

  assert.equal(citations.length, 2);
  assert.equal(citations[0].issue_number, 350);
  assert.equal(citations[1].source_kind, 'blog');
});

test('chat runtime imports with the Lambda response-stream shim', async () => {
  globalThis.awslambda = {
    streamifyResponse: (handler) => handler
  };

  const runtime = await import('../dist/chat/runtime.mjs');

  assert.equal(typeof runtime.handler, 'function');
});

test('retrieve auth uses the neutral deployment secret and keeps the request alias', async () => {
  globalThis.awslambda = {
    streamifyResponse: (handler) => handler
  };
  const runtime = await import('../dist/chat/runtime.mjs');
  const priorSecret = process.env.LIBRARIAN_RETRIEVE_SECRET;
  process.env.LIBRARIAN_RETRIEVE_SECRET = 'retrieve-test-secret';
  try {
    assert.equal(runtime.retrieveSecretOk({ retrieve_secret: 'retrieve-test-secret' }), true);
    assert.equal(runtime.retrieveSecretOk({ bridge_secret: 'retrieve-test-secret' }), true);
    assert.equal(runtime.retrieveSecretOk({ retrieve_secret: 'wrong' }), false);
  } finally {
    if (priorSecret === undefined) delete process.env.LIBRARIAN_RETRIEVE_SECRET;
    else process.env.LIBRARIAN_RETRIEVE_SECRET = priorSecret;
  }
});
