import assert from 'node:assert/strict';
import test from 'node:test';
import {
  answerEmailHtml,
  answerEmailSubject,
  answerEmailText,
  answerMarkdownToHtml,
  citationLink
} from '../dist/shared/answer-email.mjs';

test('subject carries the conversation title, clipped and prefixed', () => {
  assert.equal(answerEmailSubject('Crypto over the years'), 'Thingy: Crypto over the years');
  assert.equal(answerEmailSubject(''), 'An answer from Thingy');
  assert.ok(answerEmailSubject('x'.repeat(300)).length <= 'Thingy: '.length + 120);
});

test('markdown renders links, images, bold, and lists', () => {
  const html = answerMarkdownToHtml(
    '## The peak\n\nJamie wrote **most** in [WT219](https://weekly.thingelstad.com/archive/219/).\n\n- one\n- two\n\n![creek](https://cdn.example.com/creek.jpg)'
  );
  assert.ok(html.includes('<h3'));
  assert.ok(html.includes('<strong>most</strong>'));
  assert.ok(html.includes('href="https://weekly.thingelstad.com/archive/219/"'));
  assert.ok(html.includes('<li'));
  assert.ok(html.includes('<img src="https://cdn.example.com/creek.jpg"'));
});

test('markdown escapes html and rejects non-http image urls', () => {
  const html = answerMarkdownToHtml('<script>alert(1)</script> and ![x](javascript:alert(1))');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  // The non-http url never becomes an attribute - it survives only as
  // escaped inert text, which is the safe outcome.
  assert.ok(!html.includes('src="javascript:'));
  assert.ok(!html.includes('href="javascript:'));
});

test('citation links resolve WT issues to the archive and pass blog urls through', () => {
  assert.deepEqual(citationLink({ issue_number: '348', subject: 'My words' }), {
    url: 'https://weekly.thingelstad.com/archive/348/',
    label: 'WT348 - My words'
  });
  const blog = citationLink({ url: 'https://www.thingelstad.com/2026/post.html', subject: 'A post' });
  assert.equal(blog.url, 'https://www.thingelstad.com/2026/post.html');
  assert.equal(blog.label, 'A post');
});

test('text and html variants both carry question, answer, and sources', () => {
  const input = {
    conversationTitle: 'Data ownership',
    question: 'What does Jamie believe?',
    answer: 'Own your **words**.',
    citations: [{ issue_number: '348', subject: 'My words' }]
  };
  const text = answerEmailText(input);
  assert.ok(text.includes('You asked: What does Jamie believe?'));
  assert.ok(text.includes('Own your **words**.'));
  assert.ok(text.includes('WT348 - My words (https://weekly.thingelstad.com/archive/348/)'));
  const html = answerEmailHtml(input);
  assert.ok(html.includes('Data ownership'));
  assert.ok(html.includes('<strong>words</strong>'));
  assert.ok(html.includes('Sources'));
});
