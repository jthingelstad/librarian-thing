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
- `match_mode` is an input parameter on `archive_lens`, `entity_lens`,
  `list_content`, `find_links`, and the applied mode is echoed in the
  response as `match_mode`.

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
`entity_lens` reports the full set as `aliases_checked`. Match reasons
attribute the specific alias span that hit (`text: 'ethereum name
service'`), never a bag of tokens.

## Provenance

Every hit records the field, the ACTUAL matched span at its actual
offset (never an echo of the query term), and the mode that matched.
Evidence windows front-load (≤60 chars of context before the match) and
always contain the span — enforced post-compaction by the eval suite,
because the payload compactor once cut snippets off exactly where the
proof began. A source whose only matches are subject/topic/domain
carries no text evidence.

## first / latest hardening

`first`, `latest`, and `first_last` results are computed only from
sources with at least one strict (exact/phrase/literal) hit. A stem hit
can never determine the headline answer — the round-five failure (first
"ethereum" source = a 2017 article about Ethernet MAC addresses) is
structurally impossible. Each lens source exposes `strict_match`.

## Exemptions (documented, not accidental)

- `claim_check` and `compare_eras` filter by semantic retrieval
  (embeddings + rerank), not lexical matching.
- `source_neighborhood` ranks by token-overlap scoring between two
  sources; it does not match a user query against text.
- `search_archive` is hybrid retrieval (TF-IDF + embeddings + RRF), not
  a filter; its lexical leg is token-based, not substring.
- `top_references` aggregates link domains; no text matching.

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
