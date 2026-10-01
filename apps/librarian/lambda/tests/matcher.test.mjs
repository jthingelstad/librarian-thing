import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aliasesFor,
  compileLiteral,
  compileQuery,
  defaultMatchMode,
  MatchInputError,
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
  assert.equal(shortStem.appliedMode, 'stem');
  assert.equal(shortStem.matches('a sense of it'), false);
});

test('stem under six characters is the plural and possessive only (2.1.0)', () => {
  const dog = m('dog', { mode: 'stem' });
  assert.ok(dog.matches('two dogs on the dock'));
  assert.ok(dog.matches('the dog’s bowl'));
  assert.ok(dog.matches('a dog'));
  for (const text of ['dogged pursuit', 'dogging it', 'dogma']) assert.equal(dog.matches(text), false, text);
  const car = m('car', { mode: 'stem' });
  assert.ok(car.matches('electric cars'));
  for (const text of ['she cared', 'caring', 'cares', 'career']) assert.equal(car.matches(text), false, text);
  const bus = m('bus', { mode: 'stem' });
  assert.ok(bus.matches('school buses'));
  assert.equal(bus.matches('busing'), false);
  assert.equal(dog.firstHit('two dogs').strict, false, 'an inflected hit is not strict');
  assert.equal(dog.firstHit('a dog').strict, true);
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

test('stem below 6 chars echoes stem (plural only); stem on multi-word echoes phrase', () => {
  assert.equal(m('ens', { mode: 'stem' }).appliedMode, 'stem');
  assert.equal(m('Ethereum Name Service', { mode: 'stem' }).appliedMode, 'phrase');
});

test('hits report all variants: literal span included even when inflected comes first (round8 #4b)', () => {
  const stem = m('goalie', { mode: 'stem' });
  const spans = stem.hits('the goalies cheered as the goalie saved it').map((hit) => hit.span);
  assert.ok(spans.includes('goalies'));
  assert.ok(spans.includes('goalie'), 'literal variant reported even though inflected occurs first');
});

test('literal phrases cross an emoji that carries a variation selector (QA2 L2-1)', () => {
  const text = 'the first round of the playoffs. ⚽️\n\nNov 2, 2024';
  for (const phrase of ['playoffs. ⚽️ Nov 2', 'playoffs. ⚽ Nov 2']) {
    const quote = compileLiteral(phrase);
    assert.ok(quote.matches(text), phrase);
    const hit = quote.firstHit(text);
    assert.equal(hit.span, 'playoffs. ⚽️\n\nNov 2', 'the span is the text, selector included');
    assert.equal(text.slice(hit.offset, hit.offset + hit.span.length), hit.span);
  }
  assert.ok(compileLiteral('gorgeous! ☀️ This').matches('so gorgeous! ☀️ This is'));
  assert.ok(compileLiteral('roast ☕ Hat').matches('a new roast ☕️ Hat tip'), 'selector in the text only');
  assert.ok(m('AT&T ☕ Park').matches('at AT&T ☕️ Park'), 'significant-punctuation terms too');
  assert.equal(compileLiteral('playoffs. Nov 2').matches(text), false, 'the emoji is still text');
  // Keycap digits are a product question (QA2 Question 3): 2025 does not
  // match 2️⃣0️⃣2️⃣5️⃣, as before.
  const keycaps = ['2', '0', '2', '5'].map((digit) => `${digit}️⃣`).join('');
  assert.equal(compileLiteral('2025').matches(`the year ${keycaps}`), false);
  assert.equal(m('2025').matches(`the year ${keycaps}`), false);
});

test('a term the regex compiler cannot take throws MatchInputError, not SyntaxError (QA2 L2-6)', () => {
  for (const compile of [() => m('a'.repeat(5000)), () => compileLiteral('the '.repeat(1500))]) {
    assert.throws(compile, (error) => error instanceof MatchInputError && /too long to match/.test(error.message));
  }
  assert.ok(compileLiteral('the '.repeat(250)).matches('the '.repeat(300)), 'a 1000-character quotation compiles');
  assert.ok(m('a'.repeat(200)).matches('a'.repeat(200)), 'a 200-character term compiles');
});

test('a schemeless url keeps its slashes; case_sensitive holds for slash sides (QA2 L2-4)', () => {
  assert.deepEqual(aliasesFor('github.com/jthingelstad'), []);
  assert.deepEqual(aliasesFor('weekly.thingelstad.com/archive/351'), []);
  assert.deepEqual(aliasesFor('Twitter/X'), ['Twitter', 'X']);
  assert.deepEqual(aliasesFor('ASP.NET/PHP'), ['ASP.NET', 'PHP'], 'a name with a dot is not a host');
  assert.deepEqual(aliasesFor('micro.blog / Mastodon'), ['micro.blog', 'Mastodon', 'microblog']);
  const url = m('github.com/jthingelstad', { aliases: aliasesFor('github.com/jthingelstad') });
  const linked = 'my code is [on GitHub](https://github.com/jthingelstad/repo) now';
  assert.ok(url.matches(linked), 'a url-shaped term is a mention inside a link target');
  assert.equal(url.firstHit(linked).span, 'github.com/jthingelstad');
  assert.equal(url.matches('see github.com and jthingelstad elsewhere'), false, 'never its parts');
  assert.equal(m('rss').matches('[feed](https://example.com/rss)'), false, 'other terms still skip urls');
  const goRust = m('Go/Rust', { aliases: aliasesFor('Go/Rust'), caseSensitive: true });
  assert.ok(goRust.matches('written in Go'));
  assert.ok(goRust.matches('a Rust rewrite'));
  assert.equal(goRust.matches('a long way to go'), false, 'the Go side keeps the case flag');
  assert.equal(goRust.matches('rust on the car'), false, 'the Rust side keeps the case flag');
  const ens = m('ENS/POAP', { aliases: aliasesFor('ENS/POAP'), caseSensitive: true });
  assert.ok(ens.matches('the ethereum name service'), 'table aliases stay case-insensitive');
});
