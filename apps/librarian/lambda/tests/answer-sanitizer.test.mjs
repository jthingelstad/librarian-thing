import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeAnswerProse } from '../dist/shared/answer-sanitizer.mjs';

test('removes archive URL sentence from latest-content prose', () => {
  const answer =
    'Weekly Thing — WT350, published May 30, 2026. The archive URL is `/archive/350/`.\n\nBlog — newest post.';

  const out = sanitizeAnswerProse(answer);

  assert.equal(out, 'Weekly Thing — WT350, published May 30, 2026.\n\nBlog — newest post.');
  assert.doesNotMatch(out, /\/archive\/350/);
});

test('replaces raw Weekly Thing archive links with WT citations', () => {
  const answer = 'See https://weekly.thingelstad.com/archive/350/ and /archive/349/ for context.';

  const out = sanitizeAnswerProse(answer);

  assert.equal(out, 'See WT350 and WT349 for context.');
});

test('wraps raw urls as markdown links without touching existing ones', () => {
  const answer = 'Read [Thingy](https://thingy.thingelstad.com/) but not https://example.com/raw.';

  const out = sanitizeAnswerProse(answer);

  assert.equal(
    out,
    'Read [Thingy](https://thingy.thingelstad.com/) but not [example.com/raw](https://example.com/raw).'
  );
});

test('removes leading tool-process narration from answers', () => {
  const answer =
    'The Switzerland hike is compelling, but let me pull up the full text first.\n\nI have everything I need. Let me tell it.\n\n---\n\nHere is the story from the archive.';

  const out = sanitizeAnswerProse(answer);

  assert.equal(out, 'Here is the story from the archive.');
});

test('removes leading process narration without paragraph breaks', () => {
  const answer = "I've found it — a perfect post. Let me pull the full context.Here's a story from the archive.";

  const out = sanitizeAnswerProse(answer);

  assert.equal(out, "Here's a story from the archive.");
});

test('removes got-what-i-need process narration', () => {
  const answer = "I've got what I need. Here's a useful answer from an old post.";

  const out = sanitizeAnswerProse(answer);

  assert.equal(out, "Here's a useful answer from an old post.");
});

test('removes have-enough synthesis process narration', () => {
  const answer =
    'Good. I have enough to build a sharp thesis and map the evidence. Let me synthesize.\n\n---\n\n## The Sharpest Thesis\n\nA real answer.';

  const out = sanitizeAnswerProse(answer);

  assert.equal(out, '## The Sharpest Thesis\n\nA real answer.');
});

test('removes let-me-dig process narration', () => {
  const answer = 'Let me dig into the archive to map that out.\n\n## Thingy Trail\n\n1. A real answer.';

  const out = sanitizeAnswerProse(answer);

  assert.equal(out, '## Thingy Trail\n\n1. A real answer.');
});

test('removes leaked preflight annotations from reader-facing prose', () => {
  const answer =
    "I can't help infer that private detail.\n\n(Preflight: privacy_refusal/direct · reason: sensitive personal characteristic)";

  const out = sanitizeAnswerProse(answer);

  assert.equal(out, "I can't help infer that private detail.");
  assert.doesNotMatch(out, /Preflight/i);
});
