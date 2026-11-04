// Thingy's identity and voice reach every prompt that speaks as him, from one
// source each (persona: thingy.thingelstad.xyz persona/THINGY.md, approved
// 2026-11-03). One list of words he does not use; the answer style reaches
// the model with its Markdown intact; the print persona WT Builder vendors
// carries the same list and the register names WT Builder's prompts call.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { WELCOME_SYSTEM_PROMPT } from '../dist/shared/archive-experience.mjs';
import { PREFLIGHT_SYSTEM_PROMPT } from '../dist/shared/prompt-preflight.mjs';
import {
  agentSystemPrompt,
  answerStyle,
  premiumThankYouSystemPrompt,
  thankYouClaimsToSustain,
  thingyIdentity,
  thingyVoicePrompt,
  wordsHeDoesNotUse
} from '../dist/shared/prompts.mjs';

const printPersona = readFileSync(new URL('../../prompts/thingy-persona.md', import.meta.url), 'utf8');
const OLD_LABELS = /robot librarian|archive agent|AI librarian|AI-assisted|agentic librarian|publishing sidekick/i;

test('the answer style reaches the model with its headings and lists, not one line', () => {
  const style = answerStyle();
  assert.match(style, /^# Thingy's voice\n/);
  assert.match(style, /\n# Answer mechanics\n/);
  assert.match(style, /\n- Open with the interesting thing you found/);
  assert.match(style, /\n- hype words \("fascinating," "remarkable," "deep cut"\)\./);
  assert.ok(style.split('\n').length > 20, 'answer style kept its lines');
  assert.doesNotMatch(style, /\{\{/);
});

test('one list of words he does not use, in every prompt that speaks as Thingy', () => {
  const words = wordsHeDoesNotUse();
  assert.match(words, /^- superlatives and marketing/);
  for (const [name, prompt] of [
    ['agent system', agentSystemPrompt()],
    ['preflight', PREFLIGHT_SYSTEM_PROMPT],
    ['welcome', WELCOME_SYSTEM_PROMPT],
    ['premium thank-you', premiumThankYouSystemPrompt()],
    ['print persona', printPersona]
  ]) {
    assert.ok(prompt.includes(words), `${name} carries the list verbatim`);
  }
});

test('the chat prompt opens with his identity and names every source he knows', () => {
  const system = agentSystemPrompt();
  assert.ok(system.startsWith(thingyIdentity()));
  assert.doesNotMatch(system, /\{\{/);
  for (const source of [
    'The Weekly Thing',
    'thingelstad.com blog',
    'Another Thing',
    "Things I've Built",
    'Linking Things',
    'reference documents'
  ]) {
    assert.ok(thingyIdentity().includes(source), `identity names ${source}`);
  }
  assert.match(thingyIdentity(), /agent sidekick/);
  assert.match(thingyIdentity(), /he\/him/);
  assert.ok(thingyVoicePrompt().startsWith(thingyIdentity()));
  assert.doesNotMatch(thingyVoicePrompt(), /# Tool routing/);
});

test('no prompt carries a retired label for Thingy', () => {
  for (const [name, prompt] of [
    ['agent system', agentSystemPrompt()],
    ['preflight', PREFLIGHT_SYSTEM_PROMPT],
    ['welcome', WELCOME_SYSTEM_PROMPT],
    ['premium thank-you', premiumThankYouSystemPrompt()],
    ['print persona', printPersona]
  ]) {
    assert.doesNotMatch(prompt, OLD_LABELS, name);
  }
});

test('the print persona keeps the register names WT Builder prompts call', () => {
  // wt-builder src/server/editorial.ts: "the community-giving register above"
  // (Membership) and "the archive-librarian register above" (Echoes); its
  // tests/persona.test.ts asserts both names.
  assert.match(printPersona, /\*\*Archive librarian\*\* \(Echoes\)/);
  assert.match(printPersona, /\*\*Community giving\*\* \(Supporting Membership/);
  assert.match(printPersona, /two\s+bylined drafting prompts/);
  assert.doesNotMatch(printPersona, /\$\d/, 'figures come from support.json, never the persona');
});

test('a thank-you that credits the money with keeping anything going never reaches a member', () => {
  assert.match(premiumThankYouSystemPrompt(), /does not keep the Weekly Thing free/);
  // Lines the model really wrote from the earlier prompt.
  for (const line of [
    "Thanks for being a Supporting Member, friend. Your giving keeps the Weekly Thing free for everyone, and I'm glad you're part of it.",
    'Thank you for being a Supporting Member, friend. Your giving is part of what keeps this little corner of the internet glad to have you in it.',
    "Thanks for signing in and supporting the Weekly Thing. Your membership sends 100% of its fees to this year's nonprofit, and I'm glad to have you here."
  ]) {
    assert.equal(thankYouClaimsToSustain(line), true, line);
  }
  for (const line of [
    "Thanks for being a Supporting Member. Your giving goes straight to the nonprofit chosen each year, and I'm glad to have you along.",
    "Thank you for giving through the Weekly Thing. Your membership goes to this year's nonprofit, and I'm glad you're part of it."
  ]) {
    assert.equal(thankYouClaimsToSustain(line), false, line);
  }
});

test('the premium thank-you states no figure it is not given', () => {
  const prompt = premiumThankYouSystemPrompt();
  assert.doesNotMatch(prompt, /\$\d|Signal|EFF|Creative Commons/);
  assert.match(prompt, /host of the Weekly Thing's Supporting Membership/);
});
