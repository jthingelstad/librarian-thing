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
