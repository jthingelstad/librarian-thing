import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWelcomeOutput } from '../dist/shared/archive-experience.mjs';

test('parses prose plus a suggestions line', () => {
  const { answer, suggestions } = parseWelcomeOutput(
    'Good morning, Jamie! The archive is ready.\n\nSUGGESTIONS: ["Trace the bison thread from WT127", "What did WT48 say about RSS readers?"]'
  );
  assert.equal(answer, 'Good morning, Jamie! The archive is ready.');
  assert.deepEqual(suggestions, ['Trace the bison thread from WT127', 'What did WT48 say about RSS readers?']);
});

test('missing suggestions line leaves the prose intact', () => {
  const { answer, suggestions } = parseWelcomeOutput('Hello there.');
  assert.equal(answer, 'Hello there.');
  assert.deepEqual(suggestions, []);
});

test('malformed JSON degrades to no suggestions without eating prose', () => {
  const { answer, suggestions } = parseWelcomeOutput('Welcome back.\nSUGGESTIONS: [not json');
  assert.equal(answer, 'Welcome back.\nSUGGESTIONS: [not json');
  assert.deepEqual(suggestions, []);
});

test('caps at three and drops empties and over-long entries', () => {
  const { suggestions } = parseWelcomeOutput(
    `Hi.\nSUGGESTIONS: ["a", "", "${'x'.repeat(200)}", "b", "c", "d"]`
  );
  assert.deepEqual(suggestions, ['a', 'b', 'c']);
});

test('empty array is fine', () => {
  const { answer, suggestions } = parseWelcomeOutput('Hi.\nSUGGESTIONS: []');
  assert.equal(answer, 'Hi.');
  assert.deepEqual(suggestions, []);
});
