/**
 * The canonical matcher. Every tool that filters or ranks text matches
 * through this component - no tool keeps a private comparison path.
 * Five rounds of MCP-driven review produced three matching failures from
 * the same root cause (per-field ad hoc comparison); this module is the
 * fix at the source. Semantics are documented in MATCHER.md.
 *
 * Modes:
 * - exact: whole-token match on Unicode word boundaries, case-insensitive.
 *   "ens" matches "ENS" and "ens.domains" (tokens split on any
 *   non-alphanumeric, including . - _), never "sense" / "citizens" /
 *   "Walgreens" / "Christensen".
 * - phrase: contiguous token sequence. "Ethereum Name Service" matches
 *   only that sequence, never its individual tokens.
 * - stem: OPT-IN only, never the default, never for terms under 6 chars.
 *   Implemented as an inflection-suffix whitelist (s, es, ed, ing, 's) so
 *   it cannot cross lexeme boundaries: ethereum matches "ethereums",
 *   never "ethernet" or "etherscan". No prefix slicing, ever.
 * - literal: internal mode for quote_search - raw case-insensitive
 *   substring, because a quotation is prose, not an entity.
 *
 * Every hit carries provenance: the ACTUAL span found (never an echo of
 * the query term), its offset, the term that hit, and the mode that
 * matched it.
 *
 * Typography (2.1.0): the archive is typed in every era's typography -
 * curly and straight apostrophes (350 of 352 issues use U+2019), non-
 * breaking spaces, &amp; left in bodies, accents, markdown emphasis. Each
 * character of a compiled query accepts its variants (typedChar), so the
 * text is never rewritten and every span is the text's own at its own
 * offset. A term whose punctuation carries meaning (C++, C#, .NET, AT&T,
 * A.I.) matches as that string between word boundaries instead of losing
 * the punctuation; a term with no letter or digit compiles to nothing
 * (isEmpty), which callers refuse rather than read as "no filter". A hit
 * inside a URL (a markdown link target, a bare link, an image src) is not
 * a mention.
 */

export type MatchMode = 'exact' | 'phrase' | 'stem' | 'literal';

export interface MatchHit {
  term: string;
  mode: MatchMode;
  span: string;
  offset: number;
  // Strictness is a property of the HIT, not the requested mode: a
  // whole-token literal match is strict even under a stem request; only
  // hits where the stemmer actually did work (an inflection suffix
  // matched) are non-strict.
  strict: boolean;
}

interface CompiledTerm {
  raw: string;
  mode: MatchMode;
  re: RegExp;
  strict: boolean; // exact/phrase/literal terms are inherently strict
  // For stem terms: matches only the literal (uninflected) token, so a
  // text whose FIRST occurrence is inflected but which contains the
  // literal token elsewhere still scores strict.
  strictRe?: RegExp;
}

export interface CanonicalMatcher {
  raw: string;
  terms: Array<{ term: string; mode: MatchMode }>;
  appliedMode: MatchMode;
  isEmpty: boolean;
  matches: (text: string) => boolean;
  matchesStrict: (text: string) => boolean;
  firstHit: (text: string) => MatchHit | null;
  hits: (text: string) => MatchHit[];
}

const BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}])';
const BOUNDARY_AFTER = '(?![\\p{L}\\p{N}])';
const STEM_SUFFIX = "(s|es|ed|ing|'s|\\u2019s)?";
export const STEM_MIN_CHARS = 6;
// A token under STEM_MIN_CHARS stems to its plural and possessive only
// (2.1.0): dog finds dogs and dog's, car finds cars, never cared, dogged or
// caring; -es only after s, x, z, ch or sh (bus, buses).
const PLURAL_SUFFIX = "(s|'s|\\u2019s)?";
const SIBILANT_PLURAL_SUFFIX = "(es|'s|\\u2019s)?";

// A term the regex compiler cannot take (QA2 L2-6): typedChar makes every
// letter a class, and V8 overflows its stack at about 1,700 of them. The
// doors cap term lengths (TEXT_LIMITS in archive-tools); this is the
// backstop, which the tool wrapper turns into bad_request, never a crash.
export class MatchInputError extends Error {
  constructor(term: string) {
    const shown = term.length > 60 ? `${term.slice(0, 60)}…` : term;
    super(`"${shown}" is too long to match (${Array.from(term).length} characters); shorten it`);
    this.name = 'MatchInputError';
  }
}

// V8 compiles a pattern on its first match, once for one-byte and once for
// two-byte text, and a pattern too deep for the compiler throws there, not
// in the constructor; both widths run here, inside the guard.
function compilePattern(term: string, source: string, flags: string) {
  try {
    const re = new RegExp(source, flags);
    re.test('');
    re.test(String.fromCharCode(0x2019));
    return re;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) throw new MatchInputError(term);
    throw error;
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeTerm(value: unknown) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Hyphens are token separators, not token characters: "e-mail" compiles
// as the phrase e+mail (matching "e-mail" and "e mail", never "email").
// Apostrophes stay inside tokens (O'Reilly is one token).
export function termTokensPreservingCase(value: unknown): string[] {
  return (String(value || '').match(/[\p{L}\p{N}][\p{L}\p{N}'\u2019]*/gu) || []).map((token) =>
    token.replace(/['\u2019]+$/g, '')
  );
}

export function termTokens(value: unknown): string[] {
  return (
    String(value || '')
      .toLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu) || []
  ).map((token) => token.replace(/['’]+$/g, ''));
}

// Default mode is caller-visible policy: exact for single tokens, phrase
// for multi-word input. The server never silently infers a LOOSER mode
// than requested.
export function defaultMatchMode(term: unknown): MatchMode {
  return termTokens(term).length > 1 ? 'phrase' : 'exact';
}

export function normalizeMatchMode(value: unknown): MatchMode | null {
  const raw = String(value || '')
    .toLowerCase()
    .trim();
  return raw === 'exact' || raw === 'phrase' || raw === 'stem' ? raw : null;
}

// Letters that read as their base letter: every Latin letter whose
// decomposition starts with it (é, ü, å, ǎ, ṡ), plus the few that do not
// decompose (ø, đ, ł, ħ). "cafe" finds café and "café" finds cafe.
const LETTER_VARIANTS = (() => {
  const variants = new Map<string, string[]>();
  const add = (base: string, letter: string) => variants.set(base, [...(variants.get(base) || []), letter]);
  for (const [start, end] of [
    [0xc0, 0x24f],
    [0x1e00, 0x1eff]
  ]) {
    for (let code = start; code <= end; code++) {
      const letter = String.fromCodePoint(code);
      const base = letter.normalize('NFD')[0];
      if (base !== letter && /^[A-Za-z]$/.test(base)) add(base, letter);
    }
  }
  for (const [base, letter] of [
    ['o', 'ø'],
    ['O', 'Ø'],
    ['d', 'đ'],
    ['D', 'Đ'],
    ['l', 'ł'],
    ['L', 'Ł'],
    ['h', 'ħ'],
    ['H', 'Ħ']
  ]) {
    add(base, letter);
  }
  return variants;
})();

const APOSTROPHE = "(?:['\\u2018\\u2019\\u02BC\\u2032]|&#0?39;|&apos;|&[lr]squo;)";
const QUOTE = '(?:["\\u201C\\u201D\\u201E\\u2033]|&quot;|&[lr]dquo;)';
const DASH = '(?:[-\\u2010-\\u2015\\u2212]|&[mn]dash;)';
const AMPERSAND = '(?:&amp;|&)';
// A variation selector (U+FE0E text, U+FE0F emoji presentation) the text
// carries after a character the query typed: foldQuery strips both as
// marks, so "⚽️" arrives as "⚽" while the text still reads "⚽\uFE0F"
// (QA2 L2-1: 86 of 86 "word ⚽️ word" phrases were missed). Only these two:
// a keycap (U+20E3) still makes "2️⃣" a different character from "2".
const VARIATION_SELECTOR = '[\\uFE0E\\uFE0F]?';
// Whitespace in a literal phrase: any run of spaces, nbsp, line breaks and
// the markdown emphasis between words ("simply **great**").
const LITERAL_GAP = `${VARIATION_SELECTOR}(?:[\\s\\u00A0*_]|&nbsp;)+`;
// Between the words of a term with significant punctuation (AT&T Park).
const WORD_GAP = `${VARIATION_SELECTOR}(?:[\\s\\u00A0]|&nbsp;)+`;
// Between the tokens of a phrase: anything that is not a letter or digit,
// an entity counting as one character (Product &amp; Partner Fair).
const PHRASE_GAP = '(?:&(?:amp|nbsp|quot|apos|#\\d+);|[^\\p{L}\\p{N}])+';

// The query side of the fold: accents off, curly quotes and dashes to
// their plain forms. typedChar then accepts every form on the text side.
export function foldQuery(value: unknown) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;| /gi, ' ')
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-');
}

function typedChar(char: string) {
  if (/^[A-Za-z]$/.test(char)) {
    const variants = LETTER_VARIANTS.get(char);
    return variants ? `[${char}${variants.join('')}]` : char;
  }
  if (/^[\p{L}\p{N}]$/u.test(char)) return escapeRegExp(char);
  if (char === "'") return APOSTROPHE;
  if (char === '"') return QUOTE;
  if (char === '-') return DASH;
  if (char === '&') return AMPERSAND;
  // A symbol or emoji may carry a selector in the text (QA2 L2-1).
  return escapeRegExp(char) + VARIATION_SELECTOR;
}

// One token or literal string as a pattern, every character typedChar.
function typedPattern(value: string, gap: string) {
  return value
    .trim()
    .split(/\s+/)
    .map((word) => Array.from(word, typedChar).join(''))
    .join(gap);
}

// Punctuation that makes a term a different word: C++, C#, .NET, AT&T,
// A.I., $5, 100%. A dot followed by a space (St. Paul) or a hyphen
// (e-mail) is a separator, as it always was.
function significantPunctuation(term: string) {
  return /[+#&/@$%=~^|\\<>*]|\.(?=[\p{L}\p{N}])/u.test(term);
}

// Edges a person types around a term without meaning them: quotes,
// brackets, a closing question mark or full stop ("RSS?", "Mastodon.").
export function trimTerm(value: unknown) {
  let term = normalizeTerm(foldQuery(value));
  for (let previous = ''; previous !== term;) {
    previous = term;
    term = term.replace(/^[\s"'([{<,;:!?]+/, '').replace(/[\s"')\]}>,;:!?]+$/, '');
    if (term.endsWith('.') && !/\.[\p{L}\p{N}]/u.test(term)) term = term.slice(0, -1);
  }
  return term;
}

function compileTerm(term: string, requestedMode: MatchMode | null, caseSensitive = false): CompiledTerm | null {
  const folded = trimTerm(term);
  const tokens = caseSensitive ? termTokensPreservingCase(folded) : termTokens(folded);
  if (!tokens.length) return null;
  let mode: MatchMode = requestedMode || defaultMatchMode(folded);
  // Multi-word terms always match as a phrase - a looser interpretation
  // (token bag) is exactly the round-five alias bug.
  if (tokens.length > 1) mode = 'phrase';

  const flags = caseSensitive ? 'u' : 'iu';
  if (mode === 'literal') {
    return { raw: term, mode, re: compilePattern(term, typedPattern(folded, LITERAL_GAP), flags), strict: true };
  }
  if (significantPunctuation(folded)) {
    // The string itself between word boundaries: C++ is C++, never "c'mon".
    const body = typedPattern(folded, WORD_GAP);
    const re = compilePattern(term, `${BOUNDARY_BEFORE}${body}${BOUNDARY_AFTER}`, flags);
    return { raw: term, mode: tokens.length > 1 || /\s/.test(folded) ? 'phrase' : 'exact', re, strict: true };
  }
  if (mode === 'phrase') {
    const body = tokens.map((token) => typedPattern(token, '')).join(PHRASE_GAP);
    return {
      raw: term,
      mode,
      re: compilePattern(term, `${BOUNDARY_BEFORE}${body}${BOUNDARY_AFTER}`, flags),
      strict: true
    };
  }
  const token = typedPattern(tokens[0], '');
  if (mode === 'stem') {
    // The suffix group is captured: an empty capture means the hit is the
    // literal token and therefore strict.
    const suffix =
      tokens[0].length >= STEM_MIN_CHARS
        ? STEM_SUFFIX
        : /(?:s|x|z|ch|sh)$/.test(tokens[0])
          ? SIBILANT_PLURAL_SUFFIX
          : PLURAL_SUFFIX;
    return {
      raw: term,
      mode,
      re: compilePattern(term, `${BOUNDARY_BEFORE}${token}${suffix}${BOUNDARY_AFTER}`, flags),
      strict: false,
      strictRe: compilePattern(term, `${BOUNDARY_BEFORE}${token}${BOUNDARY_AFTER}`, flags)
    };
  }
  return {
    raw: term,
    mode: 'exact',
    re: compilePattern(term, `${BOUNDARY_BEFORE}${token}${BOUNDARY_AFTER}`, flags),
    strict: true
  };
}

// A hit inside a URL is not a mention: a markdown link target (](...)),
// an image or anchor attribute, a bare link, or an <autolink>. The word the
// hit sits in is read back to the last space.
function insideUrl(text: string, offset: number) {
  const start = Math.max(text.lastIndexOf(' ', offset - 1), text.lastIndexOf('\n', offset - 1)) + 1;
  const lead = text.slice(start, offset);
  return /\]\(|:\/\/|^<?www\.|(?:src|href)=/i.test(lead);
}

// The first match of re in text that is not inside a URL.
function mentionIn(re: RegExp, text: string): RegExpExecArray | null {
  if (!re.test(text)) return null;
  const scan = new RegExp(re.source, `${re.flags}g`);
  for (let match = scan.exec(text); match; match = scan.exec(text)) {
    if (!insideUrl(text, match.index)) return match;
    if (match[0] === '') scan.lastIndex += 1;
  }
  return null;
}

export interface CompileQueryInput {
  term: unknown;
  aliases?: unknown[];
  mode?: unknown;
  // Opt-in case sensitivity: topic "Go" with caseSensitive matches the
  // language, not the verb. Regexes drop the i flag; callers must feed
  // ORIGINAL-case text (they do - haystacks are no longer pre-lowered).
  caseSensitive?: boolean;
}

export function compileQuery({ term, aliases = [], mode, caseSensitive = false }: CompileQueryInput): CanonicalMatcher {
  const requested = normalizeMatchMode(mode);
  const primary = normalizeTerm(term);
  const compiled: CompiledTerm[] = [];
  const primaryTerm = compileTerm(primary, requested, caseSensitive);
  if (primaryTerm) compiled.push(primaryTerm);
  for (const alias of aliases) {
    // Aliases are first-class terms with their OWN mode: a multi-word
    // alias is always a phrase regardless of the requested mode. Aliases
    // never inherit case sensitivity (see MATCHER.md: the ETH rule needs
    // per-alias case flags before any case-sensitive alias exists).
    const compiledAlias = compileTerm(normalizeTerm(alias), requested === 'stem' ? null : requested);
    if (compiledAlias) compiled.push(compiledAlias);
  }

  const hitFor = (entry: CompiledTerm, text: string): MatchHit | null => {
    const match = mentionIn(entry.re, text);
    if (!match) return null;
    const inflected = entry.mode === 'stem' && Boolean(match[1]);
    return {
      term: entry.raw,
      mode: entry.mode,
      span: match[0],
      offset: match.index,
      strict: entry.strict || !inflected
    };
  };

  return {
    raw: primary.toLowerCase(),
    terms: compiled.map((entry) => ({ term: entry.raw, mode: entry.mode })),
    appliedMode: primaryTerm?.mode || 'exact',
    isEmpty: compiled.length === 0,
    matches(text: string) {
      if (!compiled.length) return true;
      return compiled.some((entry) => Boolean(mentionIn(entry.re, text)));
    },
    matchesStrict(text: string) {
      if (!compiled.length) return true;
      return compiled.some((entry) => Boolean(mentionIn(entry.strict ? entry.re : entry.strictRe!, text)));
    },
    firstHit(text: string) {
      let best: MatchHit | null = null;
      for (const entry of compiled) {
        const hit = hitFor(entry, text);
        if (hit && (!best || hit.offset < best.offset)) best = hit;
      }
      return best;
    },
    hits(text: string) {
      const found: MatchHit[] = [];
      for (const entry of compiled) {
        const hit = hitFor(entry, text);
        if (hit) found.push(hit);
        // A stem term whose first hit is inflected may ALSO contain the
        // literal token - report both variants so match_reasons list the
        // same spans regardless of which occurrence comes first.
        if (hit && !hit.strict && entry.strictRe) {
          const literal = mentionIn(entry.strictRe, text);
          if (literal) {
            found.push({ term: entry.raw, mode: entry.mode, span: literal[0], offset: literal.index, strict: true });
          }
        }
      }
      return found;
    }
  };
}

// Literal substring matcher for quotations (quote_search): a quote is
// prose, not an entity, so token boundaries must not apply.
export function compileLiteral(phrase: unknown): CanonicalMatcher {
  const raw = normalizeTerm(phrase);
  const folded = normalizeTerm(foldQuery(raw));
  const entry: CompiledTerm | null = folded
    ? { raw, mode: 'literal', re: compilePattern(raw, typedPattern(folded, LITERAL_GAP), 'iu'), strict: true }
    : null;
  return {
    raw: raw.toLowerCase(),
    terms: entry ? [{ term: raw, mode: 'literal' }] : [],
    appliedMode: 'literal',
    isEmpty: !entry,
    matches: (text: string) => (entry ? entry.re.test(text) : true),
    matchesStrict: (text: string) => (entry ? entry.re.test(text) : true),
    firstHit(text: string) {
      if (!entry) return null;
      const match = entry.re.exec(text);
      return match ? { term: raw, mode: 'literal', span: match[0], offset: match.index, strict: true } : null;
    },
    hits(text: string) {
      const hit = this.firstHit(text);
      return hit ? [hit] : [];
    }
  };
}

// One alias table for the whole registry. Multi-word aliases match as
// phrases; aliases_checked reports the full set; match reasons attribute
// the specific alias span that hit.
export const ENTITY_ALIASES: Record<string, string[]> = {
  ens: ['Ethereum Name Service'],
  poap: ['Proof of Attendance Protocol'],
  'micro.blog': ['microblog'],
  omnifocus: ['Omni Focus'],
  'sps commerce': ['SPS'],
  minnestar: ['Minnebar', 'Minnedemo'],
  wt: ['Weekly Thing']
};

// Aliases work both ways (2.1.0): Minnebar finds minnestar and Minnedemo,
// as minnestar finds Minnebar. The term itself is never its own alias.
export function aliasesFor(term: unknown): string[] {
  const key = normalizeTerm(term).toLowerCase();
  if (!key) return [];
  // "Twitter/X" names either (Jamie, 2026-09-30): each side, and its own
  // aliases, is an alias of the whole. A url or a path keeps its slashes.
  const sides = key.includes('/') && !/:\/\/|^\/|\/$/.test(key) ? key.split(/\s*\/\s*/).filter(Boolean) : [];
  if (sides.length > 1) {
    const original = normalizeTerm(term)
      .split(/\s*\/\s*/)
      .filter(Boolean);
    return [...new Set([...original, ...sides.flatMap((side) => aliasesFor(side))])].filter(
      (name) => name.toLowerCase() !== key
    );
  }
  for (const [entity, aliases] of Object.entries(ENTITY_ALIASES)) {
    const family = [entity, ...aliases];
    if (family.some((name) => name.toLowerCase() === key)) {
      return family.filter((name) => name.toLowerCase() !== key);
    }
  }
  return [];
}
