import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceKeyFromChunk, sourceKeyFromLink, sourceRecordKey } from '../dist/shared/archive-tools.mjs';
import { withBlogIdentity } from '../dist/shared/retrieval.mjs';

test('blog records, chunks, and links key by microblog_id across corpus layers', () => {
  const url = 'https://www.thingelstad.com/2013/03/13/google-reader-rip.html';

  const recordKey = sourceRecordKey({ source_kind: 'blog', microblog_id: '12345', url });

  assert.equal(recordKey, 'blog\0' + '12345');
  assert.equal(sourceKeyFromChunk({ source_kind: 'blog', microblog_id: '12345', url }), recordKey);
  assert.equal(sourceKeyFromLink({ corpus_kind: 'blog', microblog_id: '12345', post_url: url }), recordKey);
});

test('posts that share a permalink stay distinct sources (QA 2026-09-30)', () => {
  // micro.blog gave 1074797, 1074798, 1074800 and 1074801 one permalink.
  const url = 'https://www.thingelstad.com/2014/12/21/010000.html';
  const a = sourceRecordKey({ source_kind: 'blog', microblog_id: 1074797, url });
  const b = sourceRecordKey({ source_kind: 'blog', microblog_id: 1074800, url });
  assert.notEqual(a, b);
});

test('withBlogIdentity fills the post id into chunks, links and media, never guessing a shared url', () => {
  const shared = 'https://www.thingelstad.com/2014/12/21/010000.html';
  const own = 'https://www.thingelstad.com/2015/01/01/own.html';
  const corpus = withBlogIdentity({
    posts: [
      { microblog_id: 1, url: shared },
      { microblog_id: 2, url: shared },
      { microblog_id: 3, url: own }
    ],
    chunks: [
      { id: 'blog:2:0:abc', url: shared },
      { id: 'legacy', url: 'https://thingelstad.com/2015/01/01/own.html/' },
      { id: 'legacy-shared', url: shared }
    ],
    links: [{ post_url: own }, { post_url: shared }],
    media: [{ source_url: own }, { source_url: shared }]
  });
  assert.deepEqual(
    corpus.chunks.map((chunk) => chunk.microblog_id),
    [2, 3, undefined]
  );
  assert.deepEqual(
    corpus.links.map((link) => link.microblog_id),
    [3, undefined]
  );
  assert.deepEqual(
    corpus.media.map((item) => item.microblog_id),
    [3, undefined]
  );
});

test('podcast records, chunks, and links use the canonical URL across corpus layers', () => {
  const url = 'https://another.thingelstad.com/episodes/archive-thinking/';

  const recordKey = sourceRecordKey({ source_kind: 'podcast', episode_number: 42, url });

  assert.equal(sourceKeyFromChunk({ source_kind: 'podcast', url }), recordKey);
  assert.equal(sourceKeyFromLink({ corpus_kind: 'podcast', episode_number: 42, episode_url: url }), recordKey);
});

test('provider identifiers remain a fallback when a canonical URL is absent', () => {
  assert.equal(sourceRecordKey({ source_kind: 'blog', microblog_id: '12345' }), 'blog\0' + '12345');
  assert.equal(sourceKeyFromChunk({ source_kind: 'podcast', episode_number: 42 }), 'podcast\0' + '42');
});
