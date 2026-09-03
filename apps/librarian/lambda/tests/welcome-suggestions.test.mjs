import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWelcomeSetOutput } from '../dist/shared/archive-experience.mjs';

test('parses greetings and suggestions lines', () => {
  const { greeting_lines, suggestions } = parseWelcomeSetOutput(
    'GREETINGS: ["There is a bison thread from WT127 I can trace.", "The RSS reader era shows up in three different years."]\nSUGGESTIONS: ["Trace the bison thread from WT127", "What did WT48 say about RSS readers?"]'
  );
  assert.deepEqual(greeting_lines, [
    'There is a bison thread from WT127 I can trace.',
    'The RSS reader era shows up in three different years.'
  ]);
  assert.deepEqual(suggestions, ['Trace the bison thread from WT127', 'What did WT48 say about RSS readers?']);
});

test('missing lines degrade to empty arrays', () => {
  const { greeting_lines, suggestions } = parseWelcomeSetOutput('Hello there.');
  assert.deepEqual(greeting_lines, []);
  assert.deepEqual(suggestions, []);
});

test('malformed JSON degrades to empty without throwing', () => {
  const { greeting_lines, suggestions } = parseWelcomeSetOutput(
    'GREETINGS: [not json\nSUGGESTIONS: [also not json'
  );
  assert.deepEqual(greeting_lines, []);
  assert.deepEqual(suggestions, []);
});

test('caps counts and drops empties and over-long entries', () => {
  const { greeting_lines, suggestions } = parseWelcomeSetOutput(
    `GREETINGS: ["a", "", "${'x'.repeat(200)}", "b", "c", "d", "e", "f", "g"]\nSUGGESTIONS: ["a", "", "${'x'.repeat(200)}", "b", "c", "d"]`
  );
  assert.deepEqual(greeting_lines, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(suggestions, ['a', 'b', 'c', 'd']);
});

test('one line present, one absent', () => {
  const { greeting_lines, suggestions } = parseWelcomeSetOutput('SUGGESTIONS: ["only chips"]');
  assert.deepEqual(greeting_lines, []);
  assert.deepEqual(suggestions, ['only chips']);
});
