import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aliasesFor,
  compileLiteral,
  compileQuery,
  defaultMatchMode,
  normalizeMatchMode
} from '../dist/shared/matcher.mjs';

const m = (term, options = {}) => compileQuery({ term, ...options });

test('exact: positives - case, compounds, boundaries', () => {
  const ens = m('ENS');
  for (const text of [
    'registering an ENS name',
    'my ens setup',
    'the ens.domains project',
    'ens-first thinking',
    'prefix_ens_suffix',
    '(ENS)',
    'ENS'
  ]) {
    assert.ok(ens.matches(text.toLowerCase()), `ENS should match "${text}"`);
  }
});

test('exact: negatives - every shipped substring bug and its family', () => {
  const cases = [
    [
      'ens',
      [
        'a sense of things',
        'citizens united',
        'shopping at Walgreens',
        'Christensen wrote',
        'extensible systems',
        'the pensieve'
      ]
    ],
    ['ai', ['aim high', 'he said so', 'rain today', 'the maid']],
    ['ml', ['html markup', 'the mlb season', 'xml files']],
    ['edi', ['the editor', 'credit cards', 'edition one', 'editing']],
    ['rss', ['grss is fake', 'embarrassing moment']],
    ['ethereum', ['ethernet cables', 'etherscan links', 'the ethernet MAC address']]
  ];
  for (const [term, texts] of cases) {
    const matcher = m(term);
    for (const text of texts) {
      assert.equal(matcher.matches(text.toLowerCase()), false, `${term} must not match "${text}"`);
    }
  }
});

test('phrase: contiguous sequence only, never its individual tokens', () => {
  const phrase = m('Ethereum Name Service');
  assert.equal(phrase.appliedMode, 'phrase');
  assert.ok(phrase.matches('set up the ethereum name service today'));
  assert.ok(phrase.matches('Ethereum Name Service (ENS)'.toLowerCase()));
  assert.ok(phrase.matches('ethereum-name-service'.toLowerCase()));
  for (const text of [
    'ethereum gas prices',
    'a name service for machines',
    'standalone service',
    'standalone ethereum',
    'name ethereum service',
    'ethereum names services'
  ]) {
    assert.equal(phrase.matches(text), false, `phrase must not match "${text}"`);
  }
});

test('stem: opt-in, suffix whitelist only, never crossing lexeme boundaries', () => {
  const stem = m('ethereum', { mode: 'stem' });
  assert.equal(stem.appliedMode, 'stem');
  assert.ok(stem.matches('many ethereums exist'));
  assert.ok(stem.matches('plain ethereum text'));
  assert.equal(stem.matches('ethernet cables'), false, 'stem must not cross into ethernet');
  assert.equal(stem.matches('etherscan links'), false, 'stem must not cross into etherscan');
  const shortStem = m('ens', { mode: 'stem' });
  assert.equal(shortStem.appliedMode, 'exact');
  assert.equal(shortStem.matches('a sense of it'), false);
});

test('defaults: exact for single tokens, phrase for multi-word; never looser than requested', () => {
  assert.equal(defaultMatchMode('ens'), 'exact');
  assert.equal(defaultMatchMode('Ethereum Name Service'), 'phrase');
  assert.equal(normalizeMatchMode('stem'), 'stem');
  assert.equal(normalizeMatchMode('anything-else'), null);
  assert.equal(m('Ethereum Name Service', { mode: 'stem' }).appliedMode, 'phrase');
});

test('aliases are first-class phrases with attributed spans', () => {
  const ens = m('ENS', { aliases: aliasesFor('ENS') });
  assert.deepEqual(
    ens.terms.map((entry) => entry.mode),
    ['exact', 'phrase']
  );
  const text = 'setting up the Ethereum Name Service was easy'.toLowerCase();
  assert.ok(ens.matches(text));
  const hit = ens.firstHit(text);
  assert.equal(hit.term, 'Ethereum Name Service');
  assert.equal(hit.span, 'ethereum name service', 'span is the actual text found, not a query echo');
  assert.equal(text.slice(hit.offset, hit.offset + hit.span.length), hit.span, 'offset is real');
  assert.equal(ens.matches('ethereum gas fees are high'), false);
  assert.equal(ens.matches('room service tonight'), false);
});

test('provenance: span and offset always describe the actual hit', () => {
  const matcher = m('ens');
  const text = 'nothing nothing then ENS.domains appears';
  const hit = matcher.firstHit(text.toLowerCase());
  assert.equal(hit.span, 'ens');
  assert.equal(hit.offset, text.toLowerCase().indexOf('ens.domains'));
});

test('strict matching excludes stem hits (first_last hardening primitive)', () => {
  const stem = m('publishing', { mode: 'stem' });
  assert.ok(stem.matches('publishings galore'));
  assert.equal(stem.matchesStrict('publishings galore'), false, 'stem-only hit is never strict');
  const exact = m('publishing');
  assert.ok(exact.matchesStrict('publishing weekly'));
});

test('literal mode serves quotations without token boundaries', () => {
  const quote = compileLiteral('blog pensieve');
  assert.ok(quote.matches('my blog pensieve idea'));
  assert.ok(quote.matches('a blog pensieve-like thing'));
  const hit = quote.firstHit('the blog pensieve concept');
  assert.equal(hit.span, 'blog pensieve');
  assert.equal(hit.mode, 'literal');
});

// --- Round seven ----------------------------------------------------------

test('strictness is per HIT: literal matches under a stem request stay strict', () => {
  const stem = m('ethereum', { mode: 'stem' });
  // literal token present: strict regardless of requested mode
  assert.ok(stem.matchesStrict('plain ethereum text'));
  // first occurrence inflected, literal later: still strict
  assert.ok(stem.matchesStrict('many ethereums and then ethereum itself'));
  // ONLY inflected occurrences: non-strict
  assert.equal(stem.matchesStrict('many ethereums exist'), false);
  const literalHit = stem.firstHit('plain ethereum text');
  assert.equal(literalHit.strict, true);
  const inflectedHit = stem.firstHit('many ethereums exist');
  assert.equal(inflectedHit.strict, false);
});

test('matched spans carry canonical case from the source text', () => {
  const exact = m('ethereum');
  const hit = exact.firstHit('Learning about Ethereum today');
  assert.equal(hit.span, 'Ethereum', 'span is the actual text, canonical case');
  const stem = m('ethereum', { mode: 'stem' });
  const stemHit = stem.firstHit('Learning about Ethereum today');
  assert.equal(stemHit.span, 'Ethereum');
  assert.equal(stemHit.term, 'ethereum', 'term is the input as provided');
});

test('case_sensitive: Go the language, not the verb', () => {
  const go = m('Go', { caseSensitive: true });
  assert.ok(go.matches('written in Go last year'));
  assert.equal(go.matches('a long way to go on reform'), false);
  assert.equal(go.matches('1 minute to go'), false);
  const insensitive = m('Go');
  assert.ok(insensitive.matches('a long way to go on reform'), 'default stays insensitive');
});

test('unicode and punctuation terms (round-six test debt)', () => {
  assert.ok(m('micro.blog').matches('posted on micro.blog today'), 'dotted term as phrase across the dot');
  assert.ok(m("O'Reilly").matches("an O'Reilly book"));
  assert.ok(m('café').matches('at the café'));
  assert.equal(m('café').matches('cafeteria'), false);
  assert.ok(m('e-mail').matches('sent an e-mail'));
  assert.ok(m('e-mail').matches('sent an e mail'), 'hyphen is a token separator in phrase joins');
  assert.equal(m('email').matches('sent an e-mail'), false, 'email is one token, e-mail is two');
});

test('phrases match across newlines in real chunk text', () => {
  const phrase = m('Ethereum Name Service');
  assert.ok(phrase.matches('the Ethereum\nName Service launch'));
  assert.ok(phrase.matches('Ethereum \n  Name\tService'));
});

test('stem below 6 chars echoes exact; stem on multi-word echoes phrase', () => {
  assert.equal(m('ens', { mode: 'stem' }).appliedMode, 'exact');
  assert.equal(m('Ethereum Name Service', { mode: 'stem' }).appliedMode, 'phrase');
});

test('hits report all variants: literal span included even when inflected comes first (round8 #4b)', () => {
  const stem = m('goalie', { mode: 'stem' });
  const spans = stem.hits('the goalies cheered as the goalie saved it').map((hit) => hit.span);
  assert.ok(spans.includes('goalies'));
  assert.ok(spans.includes('goalie'), 'literal variant reported even though inflected occurs first');
});
