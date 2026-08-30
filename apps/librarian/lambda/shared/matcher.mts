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

function compileTerm(term: string, requestedMode: MatchMode | null, caseSensitive = false): CompiledTerm | null {
  const tokens = caseSensitive ? termTokensPreservingCase(term) : termTokens(term);
  if (!tokens.length) return null;
  let mode: MatchMode = requestedMode || defaultMatchMode(term);
  // Multi-word terms always match as a phrase - a looser interpretation
  // (token bag) is exactly the round-five alias bug.
  if (tokens.length > 1) mode = 'phrase';
  // Stem never applies to short terms; fall back to exact (stricter).
  if (mode === 'stem' && tokens[0].length < STEM_MIN_CHARS) mode = 'exact';

  const flags = caseSensitive ? 'u' : 'iu';
  if (mode === 'literal') {
    return { raw: term, mode, re: new RegExp(escapeRegExp(term), flags), strict: true };
  }
  if (mode === 'phrase') {
    const body = tokens.map(escapeRegExp).join('[^\\p{L}\\p{N}]+');
    return { raw: term, mode, re: new RegExp(`${BOUNDARY_BEFORE}${body}${BOUNDARY_AFTER}`, flags), strict: true };
  }
  if (mode === 'stem') {
    // The suffix group is captured: an empty capture means the hit is the
    // literal token and therefore strict.
    return {
      raw: term,
      mode,
      re: new RegExp(`${BOUNDARY_BEFORE}${escapeRegExp(tokens[0])}${STEM_SUFFIX}${BOUNDARY_AFTER}`, flags),
      strict: false,
      strictRe: new RegExp(`${BOUNDARY_BEFORE}${escapeRegExp(tokens[0])}${BOUNDARY_AFTER}`, flags)
    };
  }
  return {
    raw: term,
    mode: 'exact',
    re: new RegExp(`${BOUNDARY_BEFORE}${escapeRegExp(tokens[0])}${BOUNDARY_AFTER}`, flags),
    strict: true
  };
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
    const match = entry.re.exec(text);
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
      return compiled.some((entry) => entry.re.test(text));
    },
    matchesStrict(text: string) {
      if (!compiled.length) return true;
      return compiled.some((entry) => (entry.strict ? entry.re.test(text) : Boolean(entry.strictRe?.test(text))));
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
          const literal = entry.strictRe.exec(text);
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
  const entry: CompiledTerm | null = raw
    ? { raw, mode: 'literal', re: new RegExp(escapeRegExp(raw.toLowerCase()), 'iu'), strict: true }
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

export function aliasesFor(term: unknown): string[] {
  return ENTITY_ALIASES[normalizeTerm(term).toLowerCase()] || [];
}
