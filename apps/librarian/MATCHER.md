# MATCHER.md — canonical matching semantics

One matching component (`lambda/shared/matcher.mts`) serves every field
(subject, text, section, domains, topics) in every tool that filters or
ranks. No tool keeps a private comparison path. This spec exists because
matching semantics failed three separate times in five review rounds —
substring matching, unverifiable evidence, prefix stemming — all from
per-field ad hoc comparison.

## Modes

| Mode | Semantics | Default? | Strict? |
|---|---|---|---|
| `exact` | Whole-token match on Unicode word boundaries, case-insensitive. Tokens split on any non-alphanumeric (including `.` `-` `_`), so `ens` matches `ENS` and `ens.domains`, never `sense`, `citizens`, `Walgreens`, `Christensen`. | Yes, for single-token terms | Yes |
| `phrase` | Contiguous token sequence. `Ethereum Name Service` matches only that sequence (tokens separated by any non-alphanumeric run), never its individual tokens. | Yes, for multi-word terms | Yes |
| `stem` | Opt-in only, never for terms under 6 characters (falls back to `exact`). Inflection-suffix whitelist only (`s`, `es`, `ed`, `ing`, `'s`): `ethereum` matches `ethereums`, never `ethernet` or `etherscan`. No prefix slicing exists anywhere. | Never | **No** |
| `literal` | Raw case-insensitive substring. Internal to `quote_search` — a quotation is prose, not an entity. | quote_search only | Yes |

Rules:

- Multi-word terms always compile as `phrase`, even when `stem` is
  requested — a token-bag interpretation is the round-five alias bug.
- The server never silently applies a looser mode than requested.
- `match_mode` is an input parameter on `archive_lens`, `list_content`,
  `find_links`, and the applied mode is echoed in the response as
  `match_mode`.

## Aliases

One table (`ENTITY_ALIASES` in `matcher.mts`), seeded:

| Term | Aliases |
|---|---|
| ens | Ethereum Name Service |
| poap | Proof of Attendance Protocol |
| micro.blog | microblog |
| omnifocus | Omni Focus |
| sps commerce | SPS |
| minnestar | Minnebar, Minnedemo |
| wt | Weekly Thing |

Each alias compiles under its own mode (multi-word alias = phrase).
Aliases work both ways (2.1.0): Minnebar finds minnestar as minnestar finds
Minnebar. `archive_lens` always keeps the table's aliases for its topic and
adds the caller's `aliases` beside them (the caller's capped at 8, deduped
case-insensitively); passing your own never drops a built-in one (Jamie,
2026-09-30). It reports the full set as `aliases_checked`. (MCP 2.0 folded `entity_lens`, which
did this alone, into `archive_lens`.) Match reasons
attribute the specific alias span that hit (`text: 'ethereum name
service'`), never a bag of tokens.

**A slash means or (2.2.0).** `Twitter/X` names either: each side, and
each side's aliases, is an alias of the whole (Jamie, 2026-09-30). A url
(`https://x.com/a`) or a path (`/archive/`) keeps its slashes.

## Sections

A section filter names a heading or a family. A name some section or
family has exactly wins over a substring (Jamie, 2026-09-30: `coffee`
finds Coffee, not Coffee Gear); any other name matches inside headings.
Headings compare as written in the body: no-break spaces, markdown marks
(`#MNTech`, `*Not*`, `` `yes` ``) and doubled spaces do not count
(`headingKey`). `get_source` also reads any `##`/`###` heading the body
carries (an H2 group over its articles, an H3 inside a post) to the next
heading of its level, and a name that matches nothing is `bad_request`
with `available_sections`, never an empty success.

## Voice

`voice` keeps one speaker's words: `jamie` (Jamie's own), `quoted`
(blockquotes) or `link` (headline link titles), from each chunk's spans.
Image markup is nobody's voice, because alt text is mostly machine-written,
so `![alt](url)` and `<img alt>` leave a voiced passage. FAQ answers and
site pages are the site speaking, not Jamie writing on a topic, so no
voice matches them (Jamie, 2026-09-30).

## Provenance

Every hit records the field, the ACTUAL matched span at its actual
offset (never an echo of the query term), and the mode that matched.
Evidence windows front-load (≤60 chars of context before the match) and
always contain the span — enforced post-compaction by the eval suite,
because the payload compactor once cut snippets off exactly where the
proof began. A source whose only matches are subject/topic/domain
carries no text evidence.

**Topic labels match only whole (1.5.1).** The coarse `detect_topics`
labels ("Open web and RSS" is on 8,856 of 8,930 weekly chunks) are not in
any matching haystack. A label counts only when the query names it whole
(case and spacing aside), and that hit is strict. Before 1.5.1, "RSS"
matched every issue through the label. **Domains match exactly or as a
parent:** `x.com` is `x.com` or `*.x.com`, never `netflix.com`
(`domainMatches` in `shared/archive-tools.mts`).

## first / latest hardening

`first`, `latest`, and `first_last` results are computed only from
sources with at least one strict hit (see Per-hit strictness: a literal
token match is strict even under a stem request). A genuinely inflected
stem hit can never determine the headline answer — the round-five failure (first
"ethereum" source = a 2017 article about Ethernet MAC addresses) is
structurally impossible. Each lens source exposes `strict_match`.

## Exemptions (documented, not accidental)

- `find_evidence` and `compare_eras` filter by semantic retrieval
  (embeddings + rerank), not lexical matching.
- `source_neighborhood` ranks by token-overlap scoring between two
  sources; it does not match a user query against text.
- `search_archive` is hybrid retrieval (TF-IDF + embeddings + RRF), not
  a filter; its lexical leg is token-based, not substring.
- `top_references` aggregates link domains; no text matching.

## Case sensitivity

`case_sensitive: true` (archive_lens, list_content, find_links) drops case folding for the primary term - topic "Go" matches
the language, never "to go". Default is case-insensitive. Aliases never
inherit case sensitivity; per the ETH rule below, a case-sensitive alias
requires per-alias case flags first.

**Alias design rule:** never add ETH as an Ethereum/ENS alias under
case-insensitive matching - it would token-match every `.eth` name in
this corpus. Any future case-sensitive alias needs per-alias case flags.

## Common-word terms

When a term matches more than half of the in-scope sources (and at
least 10 were scanned), the lens response carries `term_frequency_note`
telling the agent the ranking is undifferentiated and suggesting a
phrase, `case_sensitive: true`, or a narrower `year_range`. The matcher
does not silently special-case common words - the advisory is visible
and the agent decides.

## Per-hit strictness

Strictness is a property of each HIT, not the requested mode: a
whole-token literal match is strict even under `match_mode: "stem"`
(the stem regex captures its suffix group; an empty capture means the
stemmer did no work). Only genuinely inflected hits are non-strict and
excluded from first/latest. Matched spans always carry the canonical
case of the source text; `matched_term` is the input term as provided.

## Tool coverage

| Surface | Canonical matcher | match_mode / case_sensitive params |
|---|---|---|
| archive_lens | yes | yes |
| list_content, find_links | yes | yes |
| media_search | yes (every word; stem by default, accents and plurals fold) | match_mode |
| list_issues | yes (exact per token) | no |
| quote_search | yes (literal mode) | no |
| search_archive | exempt - hybrid retrieval (TF-IDF + embeddings + RRF) | - |
| find_evidence, compare_eras | exempt - semantic retrieval | - |
| search_faq | exempt - lexical scoring, token-based | - |
| source_neighborhood | exempt - inter-source overlap ranking | - |
| top_references, corpus_stats | no text matching (domain aggregation via one shared function) | - |

Registry-internal (bound in-process, no published MCP/agent spec):
`get_issue`, `get_section`, `domain_history`, `list_issues`,
`compare_eras`. Agent test rounds should not probe them over MCP.

## Eval enforcement

Three layers, wired to the deploy (failures block it):

1. `tests/matcher.test.mjs` — unit fixtures: every shipped matching bug
   and its family as a negative (ens≠sense/citizens/Walgreens/
   Christensen/extensible, ethereum≠ethernet/etherscan, ai≠aim/said,
   ml≠html/mlb, edi≠editor/credit, rss≠grss; phrase ≠ its tokens).
2. `scripts/eval-tools.mjs` invariants — against the real corpus, every
   registry tool: evidence contains its span (post-compaction), all ids
   resolve or are marked, no duplicate records, scope/source_kind/
   match_mode echoes, limit honored, cross-tool domain counts agree,
   truncation markers only where >3 entries were cut.
3. Known answers + recall baseline (`eval/baseline.json`): first WT
   Ethereum mention = issue 17 (2017-09-02), never issue 5; first ENS
   blog post = 2021-04-10; first ENS issue = WT182; "blog pensieve" =
   issues {314, 317} + the 2024-07-14 post; weekly_thing references
   never predate 2017-05-13. Counts drifting >10% fail with a diff to
   review (`--update-baseline` accepts a reviewed change).
