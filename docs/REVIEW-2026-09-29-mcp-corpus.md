# Review 2026-09-29: the Librarian MCP, and what would make it extraordinary

The question: what does the Librarian MCP (the "thingelstad.com" connector,
`/mcp` on the stream Lambda) expose today, where are the gaps between that and
an extraordinarily powerful MCP experience over Jamie's corpus of writing, and
should the builders (WT Builder, AT Builder) consume it instead of `/retrieve`.
Reviewed at server `1.2.0+tools.6eb4631ffb06`, librarian-thing `main` as of
this morning. **Recommendations only. Nothing here is applied.**

**Method.** Read the registry, protocol layer, invoker, audit store, retrieval,
lens and corpus builders, the evals, the decision logs (`ALIGNMENT.md`,
`AGENT-TEAM/`, Thingy `docs/ROADMAP.md`, WT Builder and AT Builder
`docs/decisions.md`) and the git history of the eight 2026-08-29 MCP review
rounds. Dumped the exact `tools/list` from the built registry and ran the
tool-surface census on it. Called 17 of the 18 tools live through the claude.ai
connector as Jamie (reads only; `fetch_page` not called), plus local probes
against `dist/` for truncation and edge cases. Measured the data on disk in
`data/`, `weekly.thingelstad.com` and `another.thingelstad.com`.
Read the MCP call log after Jamie approved it (`conversation_review.py
mcp-list --days 14`, a read-only DynamoDB scan). Part 7 holds the aggregate
census; no request ids or arguments appear in this document.

---

## The short answer

Today's MCP is a good **retrieval** surface that was built for Thingy's chat
loop and re-exported: hybrid search, one-source reads, lexical lenses over
time, link and domain queries, photos with vision. It finds and counts well.
It is weakest exactly where a corpus of *writing* is different from a pile of
documents:

1. **It cannot tell Jamie's words from anyone else's.** A Weekly Thing chunk
   mixes Jamie's commentary, blockquotes from the linked author, link titles
   and, since WT350, Thingy's bylined Echoes. The tools treat all of it as
   "the archive". Live, `claim_check` ranks Thingy's own Echoes above the issue
   it is summarising (defect 4).
2. **The structure the pipeline already computes never reaches a tool.** Nine
   curated topic clusters, embedding-based similar issues, per-issue abstracts
   and key points, six tropes, content kinds, 35 blog categories, section
   families, 172 audio editions: all built or on disk, none exposed (Part 3).
3. **It is not MCP-native.** Tools only: no resources an agent can attach, no
   prompts, no output schemas, no read-only hints. The descriptions carry
   Thingy-app rules ("URLs are citation metadata for the app; do not quote
   them", twelve times) into clients that have no app to render citations.
4. **Several results are quietly wrong or unusable** (truncation that emits
   invalid JSON, errors flagged as success, a section filter that returns
   nothing for "Journal", Weekly Thing photo descriptions missing in
   production). These go first because every later capability rests on them.

**Recommendation, in six moves** (detail in Part 4, order in Part 8):

| # | Move | What it unlocks |
|---|---|---|
| 1 | **Make it trustworthy**: fix defects 1 to 8 | Every answer rests on these |
| 2 | **Voice provenance**: tag every passage `jamie` / `quoted` / `thingy` / `link`, filter on it, keep Thingy out of evidence by default | "What does Jamie think about X", honest claim checks, no Echoes feedback loop; retires WT Builder's text-filter workaround |
| 3 | **A skim layer**: abstracts, key points and descriptions on every source record; search results grouped by source | "Summarise 2021" in one call instead of 38 `get_source` reads of ~40 KB each |
| 4 | **Structure out of hiding**: topics, similar issues, section families, content kinds, blog categories, tropes as filters plus one `list_topics` | Browsing like a librarian, not only searching |
| 5 | **MCP-native affordances**: resources (`wt/{n}`, `blog/{id}`, `topic/{slug}`), a few prompts, output schemas, annotations, one id everywhere, absolute URLs, MCP-specific descriptions | Attach an issue by name; clients render typed results; agents can cite with links |
| 6 | **Time and author tools**: publish `compare_eras`, add `on_this_day` and `link_history(url)`, make yearly signals distinctive | "How has my thinking moved", "have I linked this before", "what was I writing this week in past years" |

Net tool count stays close to flat: three new tools (`list_topics`,
`compare_eras`, `on_this_day`), everything else as filters on existing tools,
and one merge (`entity_lens` into `archive_lens`) held for a major.

**The call log (Part 7): every one of 54 calls in the window came from the
owner, and none from readers.** Organic use is mostly `find_links` and
`source_neighborhood`, so the link-graph fix and the author-facing moves
come first.

**On `/retrieve` versus MCP for the builders (Part 5): keep `/retrieve`.**
- Echoes is deterministic retrieval followed by one model call. MCP would
  change the wire, not the results, and would give up scope, `k`, the
  pinned contract and pre-model filtering.
- The real win is to put the builders' workarounds into the shared retrieval
  layer: voice, absolute URLs, labels, issue exclusion and an issue lookup.
  Both doors then get them.
- Along the way I found that Echoes cannot reach the blog or podcast, though
  its prompt says it may, and that AT Builder has no Thingy filter at all.

---

## Part 1: verified defects

Each is a statement the code or a live call contradicts. AT =
`apps/librarian/lambda/shared/archive-tools.mts`, MCP = `…/shared/mcp.mts`,
RT = `…/chat/runtime.mts`, SPEC = `…/prompts/tool-specs.json`.

**Trust-breaking**

1. **A truncated result is invalid JSON.** `renderToolResultText` hard-slices
   the pretty-printed text at 48,000 characters and appends a prose hint
   (MCP:111-127). Local probe: `list_content {limit:120}` is 122,510
   characters raw and fails `JSON.parse` after truncation; `get_source` for
   WT200 is 52,622 characters and truncates too.
2. **Tool errors go out as success, and still cost quota.** A handler that
   returns `{error}` is sent with `isError:false` (MCP:294-302); only a thrown
   exception sets `isError:true`. Live: `get_source` issue 9999 returns
   `{"error":"Source not found in the active source scope."}` with no code,
   no next step (the newest issue is 351), and a reference to a scope MCP
   callers cannot set. Quota is spent before arguments are validated
   (RT:1135-1146). `web_search` is still in `MCP_LAUNCH_TOOLS` and callable
   while unconfigured, spending a unit to return an error.
3. **Weekly Thing photo descriptions never reached production.** CI's WT
   corpus upload never calls `annotate_media_descriptions`; only
   `pipeline/deploy/upload_blog_corpus.py:71` and the local
   `pipeline/corpus/build.py:57` do. Live: `media_search "Cliffs of Moher"`
   (2024) returns WT291 photos with no `description` and blog photos with one.
   The 2026-09-05 vision pass (12,278 images) is half-deployed, and
   `describe_media` is not a CI step, so every image since (all 20 in
   WT350 to 351) is undescribed.
4. **Thingy-authored text is indexed as archive evidence and outranks the
   source.** Live: `claim_check "Jamie installed Locally AI in WT328"` ranks
   the WT351 Echoes block (Thingy byline, score 0.88) above WT328's own
   Currently entry (0.70). The corpus builder has no `from-thingy` handling
   (`librarian-core/librarian_core/corpus.py`). This contradicts the ratified
   rule "Thingy's words are not Jamie's archive"
   (`wt-builder/docs/service-contracts.md:227-238`); WT Builder works around it
   client-side by text-filtering. It compounds: WT350 and WT351 each carry
   two `from-thingy` blocks (Membership and Echoes), and every issue adds more.
5. **`section` does not name the sections an issue has.** `split_sections`
   splits on H1 to H4 (corpus.py:37, :163-181), so a Notable item's section is
   the article title and Journal becomes "Sunday", "Monday", "Thursday". Live:
   `get_source WT351 section="Journal"` returns an empty body and
   `word_count: 0`, while the tool's own spec suggests "Journal" (SPEC:91) and
   the same issue's link records say `section: "Notable"`. The spec's other
   examples ("Fine Print, Photo, Tools, Reading") occur in at most one issue;
   `search_archive section="Notable"` matches 16 chunks.
6. **Links inside Jamie's commentary are not in the link graph.** WT link
   records come from `links.json` (notable plus briefly headline links only).
   Live: `find_links domain=thingelstad.com source_kind=weekly_thing` finds 8
   links in 352 issues; WT351's Journal links four blog posts and WT350, and
   neither `get_source` nor `source_neighborhood` lists them
   (`cross_source_links: []`), even though the blog corpus knows 3,694 posts
   `also_in_issues`.
7. **Lens results lose their own headline ids.** The 24,000-character lens
   compaction keeps the timeline ahead of `latest` (archive-lens.mts:536-543).
   Local probe, `archive_lens topic="ENS"`: `latest` becomes
   `{id:"wt-347", resolved:false}`, reading-path anchors unresolve, and
   `{omitted:12}` markers land inside id arrays. `limit` does not bound
   `sources_by_id` (live: `archive_lens Mastodon limit=5` returned 18 full
   records).
8. **`archive_gems` is inconsistent in three ways.**
   - In theme mode it returns bare ids with no `sources_by_id`, and
     `get_source` does not accept those ids.
   - An explicit `mood:"serendipity"` switches off the random draw
     (AT:1758, `if (!mood …)`).
   - `mode` and `mood` are both declared with the same enum, and a conflict is
     resolved silently. Live: `mode:forgotten, mood:recent` applied "recent",
     and "recent" returned a 2012 post.

**Smaller, still wrong**

9. **`find_links` does not honour its own contract.**
   - `case_sensitive` is ineffective, because `topic` is lowercased before the
     case-sensitive compile (AT:577-579 vs :594-598).
   - A topic admits every link of every issue listed under
     `graph.entity_index[topic]` (AT:591-593, :613). Probe: `ethereum` gives
     770 links, and 1 of the first 50 mentions it.
   - The `match_mode` echo and `match_reasons` that the description promises
     are absent.
10. **`claim_check` does not check claims.** Its status is
    `hits.length ? 'evidence_found' : 'needs_caution'` over a hybrid top-3
    (AT:1784-1800), which is almost always non-empty. `/connect/` advertises
    "check claims… verify against the archive".
11. **`latest_content issue_number` does not return that issue.** It filters
    blog posts by `also_in_issues` (SPEC:306).
12. **`currently_history` documents 8 kinds (SPEC:652); the data has 20**
    (building, using, deleting, dining, walking…) plus variants such as
    "installing more", which `kind:"installing"` misses.
13. **Filter mistakes and applied values are silent.** An inverted
    `year_range` silently returns nothing (live: `list_content podcast
    [2026,2020]` gave 0 results). No tool echoes the applied `year_range` or
    `limit`.
14. **Result fields break the declared vocabulary.**
    - `search_archive` marks Weekly Thing hits `source_kind: "chunk"`, and
      `claim_check` evidence can be `"site_page"`, while every schema enum is
      weekly_thing/blog/podcast.
    - Blog hits carry `issue_year`.
    - `age` reads "about 1 years old".
15. **Some passage text carries a de-punctuated duplicate.** Live:
    `search_archive` hits for WT302 and its blog twin open with "com archive
    300 of the Weekly Thing https weekly thingelstad com I sent…";
    `entity_lens "Simon Willison"` returns the 2007 OpenID post's sentence
    twice, once as markdown and once stripped. The cause is not traced; it
    looks like lexical normalisation leaking into stored text.
16. **Version and count drift.**
    - Docs say `1.1.0+tools…` (`reference/librarian.md:278`,
      `apps/librarian/AGENTS.md:190`, `apps/librarian/README.md:155`), and
      `corpus_stats` still stamps 1.1.0 in the chat loop (AT:1089). The code
      serves 1.2.0 (MCP:146-151).
    - "18 tools carry published specs": SPEC has 19 (view_photo), and view_photo
      is missing from `reference/librarian.md`.
    - The 300/hour MCP rate limit and the 48,000-character cap are documented
      nowhere.
17. **The audit read path mislabels and under-records.**
    - `conversation_review.py` labels `/tools` rows `surface: "mcp"`
      (:627, :652).
    - The OAuth `clientId` is on the grant (`oauth-store.mts:695`) but never
      recorded, so the log cannot say which client (claude.ai, ChatGPT, Claude
      Code) made a call.

---

## Part 2: what the surface is today

**18 tools** in production (19 with a Brave key), 21,782 bytes of
`tools/list` (about 5,700 tokens). Capabilities `tools` only; stateless
streamable HTTP; OAuth 2.1 public clients, subscribers only; 500 calls a day
(doubled for supporting members, owner exempt), 300 an hour; 14-day audit
rows. Grouped by the job each tool does:

| Job | Tools |
|---|---|
| Find | `search_archive` (hybrid: Cohere embed + TF-IDF, RRF, rerank), `quote_search` (exact substring), `search_faq`, `media_search` |
| Read | `get_source`, `view_photo` (MCP image blocks, vision) |
| Inventory | `list_content`, `latest_content`, `corpus_stats` |
| Over time | `archive_lens`, `entity_lens` (strict whole-token matcher, first/latest, by year, reading path) |
| Links and people | `find_links`, `top_references`, `source_neighborhood` |
| Catalogues | `currently_history` |
| Serendipity | `archive_gems` |
| Verify | `claim_check` |
| Live web | `fetch_page` (`web_search` unbound) |

**What is already right, and worth protecting.**
- **The matcher is canonical and strict.** It has exact, phrase and opt-in
  stem modes, never silently loosens a requested mode, and takes first/latest
  only from strict hits. Every shipped matching bug is pinned as a negative
  fixture (`MATCHER.md`, `tests/matcher.test.mjs`).
- **The 2026-08-29 review rounds ran adversarial passes.** Eight rounds fixed
  matching, evidence spans and payload size.
- **Evidence entries carry the matched span.** A lens answer can be checked
  against its source.
- **`view_photo` gives the calling model vision over the archive.** The pattern
  keeps base64 out of audit rows and the Bedrock loop, and it is right.
- **`server_version` changes with the prompts fingerprint**, which gives clients
  a stale-schema signal.
- **Deploys are gated by evals**: matcher fixtures, response invariants,
  known answers and a recall baseline.

---

## Part 3: what the corpus holds that no tool exposes

Measured on disk. This is the raw material for moves 2 to 6.

| Asset | Size | State |
|---|---|---|
| Curated topic clusters (`corpus.topics[]`: name, description, first/last seen, representative issues, related topics) | 9 clusters | Built; **no Lambda reads them** |
| Embedding-based `similar_issues` (top 6 per issue) | 352 issues | Built into the S3 graph; **no reader**; the site copy is empty because CI builds the graph before embedding (`graph.py:327-343`) |
| Issue `summary.abstract`, `key_points`, `time_sensitivity`; chunk `issue_abstract` | 350 of 350 issues | Built **heuristically** (abstract = first 420 characters, corpus.py:205-215; no model); **never returned**; lens code that matches on `item.summary` is dead because the records passed in lack it (archive-lens.mts:154, :177) |
| Chunk `content_kind` (essay 2,802, reference 4,747, personal 576, links 611, meta 107) | 8,878 chunks | Built; never returned or filterable |
| Tropes (for example "open web and ownership" in 338 issues, "tools for thought" in 146) | 6 | Only via the unpublished `list_issues` |
| Registry-internal tools: `compare_eras`, `get_section`, `get_issue`, `domain_history`, `list_issues` | 5 | Unreachable over MCP (`-32602`) |
| Weekly topic pages (entities in 3 or more issues, related by co-mention) | 752 | Public on the site; no MCP equivalent |
| Issue `description` (curated teaser) and cover image | 351 / 352 | Dropped at corpus build |
| Blog categories (Crypto 560, Coffee 283, TeamSPS 276, Family 162…) | 35 on 2,731 posts | Dropped at corpus build; blog chunks carry `topics: []` |
| Section families: Fortune 265 issues, Journal 183, Currently 101, Reply All 23, Straw Poll 8, Yearly Thing 3, Echoes 2 | 2,209 headings, 135 distinct | Lost to H3 splitting (defect 5); era normalisation (`docs/sections.md:37-45`) never materialised |
| WT audio edition (listen URL, duration, chapters, VTT) | 172 issues, 1,096 chapters, ~56.5 h | Weekly render copy only, **by decision** (`wt-builder/docs/decisions.md:236-241`) |
| Photo place and time (WT Builder media carry caption, timestamp, location) | WT350+ | Not in media records; `media_search` has no source or issue filter |
| Link health (199 dead micro.blog posts with Wayback records; 1,391 LLM-audit findings) | | In `notes/audits/`, not in the corpus |

The public numbers for context: 352 Weekly Thing issues (886,078 words, 6,461
headline links), 10,443 blog posts (8,063 microposts, 2,380 titled; 913,207
words, 2000 to 2026), 1 Another Thing episode, ~14,000 images, 32 FAQ entries.

---

## Part 4: the proposal

### Move 1. Make it trustworthy

Defects 1 to 8 in Part 1, plus 13 (silent filter mistakes). The biggest single
fixes:
- **Truncation and errors (defects 1, 2).** Truncate structurally, dropping
  whole items and saying how many, instead of slicing text. Send `isError:true`
  with a closed `code` (`not_found`, `bad_request`, `too_large`,
  `not_configured`) and one executable next step. Validate before spending
  quota.
- **Photo descriptions (defect 3).** Call `annotate_media_descriptions` in the
  WT upload, and make `describe_media` a CI step for new images.
- **Sections (defect 5).** Materialise a `section_family` (Notable, Briefly,
  Journal, Currently, Featured, Fortune, Reply All, Echoes; eras mapped per
  `docs/sections.md`) on every chunk and link, and filter on that. Keep the
  article-title section as `heading`.
- **Commentary links (defect 6).** Extract links from commentary and Journal
  bodies into the link graph, and resolve `?ref=weekly-thing-N` query strings
  so `target_resolved` works.

### Move 2. Voice provenance (the biggest single lever)

A corpus of writing needs to know who wrote each sentence. Add a `voice` to
every chunk and to every evidence span:

- `jamie`: commentary, Journal, Currently, essays, blog posts
- `quoted`: blockquotes (the linked author's words)
- `link`: headline and link titles
- `thingy`: anything inside `<div class="from-thingy">` (Echoes, Membership,
  Thank-you, the three byline surfaces in `service-contracts.md:166-172`)

Then:
- Add a `voice` filter to `search_archive`, `quote_search`, `archive_lens`,
  `entity_lens` and `claim_check`.
- **Exclude `thingy` from evidence by default.** It stays reachable with
  `voice: "thingy"`.
- Evidence entries carry `voice`.

Three things fall out:
- "What does Jamie think about X" becomes one filtered lens.
- Claim checks stop citing Thingy's summaries of Jamie as proof of Jamie.
- WT Builder's client-side text filter retires.

This is WT Builder review item #9 ("per-passage author field, not built",
`wt-builder/docs/history/review-2026-09-27.md:534-540`), moved to the archive,
where it belongs.

Span tagging inside existing chunks needs no re-embed. Splitting quotes into
their own chunks would; `apps/librarian/AGENTS.md` puts a full re-embed at
$1 to 2 and about three minutes, so it is a cheap option if span tags prove
too coarse.

### Move 3. A skim layer

Agents run out of context before they run out of questions. Today "what was
2021 about" means reading issues. A `get_source` is ~40 KB (WT300: 40,622
characters, because `body` and `section_texts` carry the same text twice), so
38 issues will not fit.

- Return the curated `description` (Jamie's own dek, in all 352 issues' frontmatter
  and never read by the corpus build), plus `key_points`, on every
  source record: `list_content`, `latest_content`, lens `sources_by_id`, search
  hits. One `list_content year=2021` call then surveys the year.
- Give `search_archive` a `group_by: "source"` default. Today one query
  returned WT302 and its blog twin as two hits, and the same blog post twice,
  so 5 results held 3 sources.
- Give `get_source` a `format` (`outline` | `text` | `full`) and drop the
  duplicate body.
- Serialise compactly: indent-1 costs about 25%.
- Blog: 2,380 titled posts would need abstracts. That is a Haiku batch like
  the vision pass; microposts are their own abstract.

### Move 4. Structure out of hiding

**Filters on existing tools, not new tools:**
- `section_family`, from Move 1.
- `content_kind` (for example `essay` for "just Jamie's long-form").
- `category`, restoring the 35 blog categories dropped at build.
- `topic` meaning one of the nine curated clusters, alongside today's lexical
  topic.
- `trope`.
- `source_kind` on `search_archive`, `quote_search`, `media_search` and
  `claim_check`, which have none today although every other tool does.

**`source_neighborhood` "more like this"** should come from `similar_issues`
(embeddings) instead of shared domains. Live, WT351's neighbours include WT59
(2018) because both link to github.com and macstories.net. Fix the CI build
order so the graph has them.

**One new tool, `list_topics`.** It returns the nine clusters (description,
first/last seen, representative issues, related clusters) and the 752 site
topics with counts and their public page URLs. It is the card catalogue.

### Move 5. MCP-native affordances

- **Resources and templates.** `librarian://wt/{n}`, `librarian://blog/{id}`,
  `librarian://topic/{slug}`, `librarian://year/{yyyy}`; `resources/list`
  returns the newest issues. Clients that support resources can attach
  "WT351" as context without a tool round-trip. Declare `resources` with
  `listChanged` only if it can be honoured.
- **Prompts.** Four or five that encode the good call sequences:
  - "How has Jamie's thinking on {topic} changed" (a `voice:jamie` lens, then
    `get_source` on the turning points)
  - "Year in review: {year}"
  - "A reading path through {theme}"
  - "This week in past years"
  - "Research brief on {person or product}"

  This is where the routing knowledge in `agent-system.md` can reach MCP
  clients, which today get only the eight-line instructions string.
- **A typed contract.**
  - `outputSchema` plus `structuredContent`.
  - `readOnlyHint:true` on every tool, `openWorldHint:true` on `fetch_page`.
  - `limit` minimum and maximum in the schemas: none today; all 14 are clamped
    silently.
  - `additionalProperties:false`.
  - One `applied` echo (window, limit, mode, voice).
  - Cursors where totals exceed the limit.
- **One id everywhere.** The lenses emit `wt-351`, `blog-6034145` and slug ids
  such as `blog-this-weekend-i.html`; `get_source` and `source_neighborhood`
  accept none of them. Accept `id` on every source tool, and give every blog
  post a `microblog_id`-based id.
- **Absolute URLs.** Weekly Thing URLs are site-relative (`/archive/351/`,
  corpus.py:708). AT Builder already absolutises client-side, and MCP clients
  cannot.
- **MCP-specific descriptions** (see product call 2). The shared spec file tells
  third-party clients "URLs in results are citation metadata for the app; do
  not quote or narrate raw URLs", twelve times (1,248 bytes). In claude.ai
  there is no app layer, so the rule produces answers without links. For MCP:
  cite `WT<N>` with a markdown link to the absolute URL.

### Move 6. Time and author tools

- **Publish `compare_eras`.** It already exists (AT:1375-1388): two year ranges
  in, what is distinctive about each out. The call "how is 2025 Jamie
  different from 2018 Jamie" is a natural one.
- **`on_this_day`** (date or ISO week, optional year range). It returns what
  Jamie published around this date in each past year. Echoes already does this
  ("seasonal lens from about a year ago", `service-contracts.md:207-226`); the
  server should own it.
- **`link_history(url)`**, or a `url` filter on `find_links` (none exists
  today). It answers "have I linked this before, when, and what did I say".
  It is the curator's daily question, and WT Builder review #19 ("Echoed by
  Thingy in WTn" backlinks) wants the same index.
- **Distinctive yearly signals.** `corpus_stats` yearly top terms are raw
  counts; live, 2024's are "great, good, time, things". Score terms against the
  whole corpus (TF-IDF) so a year says "nfts" (2021) or "agentic" (2025).
- **At a major, merge `entity_lens` into `archive_lens`.** They share every
  argument, and entity adds only aliases. Fewer near-duplicate tools make tool
  choice easier.

---

## Part 5: `/retrieve` versus MCP for the builders

**Answer: keep `/retrieve`.** Moving WT Builder to MCP would be re-plumbing,
and it would make Echoes worse, not better. The value is in fixing the shared
retrieval layer once so that both doors get the fixes, and in retiring the
workarounds the builders carry today. WB = `wt-builder/src/server`,
AB = `at-builder/src/server`.

### What `/retrieve` is, and what it is used for

**On the server** it does one thing: hybrid passage search.
- `/retrieve` and MCP `search_archive` call the same `retrieve()` function
  (runtime.mts:1607; AT:413-419).
- The request is `{query, k (1 to 40, default 12), scope (default
  weekly_thing), filters.yearRange, filters.section, retrieve_secret}`
  (runtime.mts:1599-1605).
- Auth is a shared service secret compared with `timingSafeEqual`.
- One global bucket allows 600 calls an hour.
- It is covered by the API-wide contract version, 4.10.0, which answers 409
  for an unsupported major.

**On the consumer side** it is used in seven ways (Jamie's "retrieve does
other things" is right):

| # | Consumer | Shape | Model involved? |
|---|---|---|---|
| 1 | WT Echoes wand and per-echo redraft (WB/editorial.ts:1403-1415) | Up to 5 anchors, in parallel, k=12, no scope; fails loud | One LLM call **after** retrieval; no tool loop |
| 2 | WT link wand, "what Jamie wrote before" (WB/editorial.ts:1593-1622) | 1 call per link, k=6; best-effort | No |
| 3 | WT verify, "Retrievable by Thingy" (WB/verify.ts:337-350) | Issue title search, k=20; rechecks every 15 minutes for 24 h | No; it is an **ingest probe** done through semantic search |
| 4 | AT hooks (AB/wand.ts:369-409) | 1 call per section, k=8, scope `both` | No |
| 5 | AT prospecting (AB/wand.ts:491-560) | Its own `search_archive` client tool over `/retrieve`, 6 to 12 searches | **Yes**: a hand-written tool loop |
| 6 | Golden retrieval harness (`lambda/scripts/golden-retrieval.mjs`) | Production health check; the only caller that uses `filters` | No |
| 7 | quality-bench (`lambda/scripts/quality-bench.mjs`) | Model benchmarks | No |

### Why MCP is the wrong door for WT Builder

1. **Echoes has no model choosing tools.** Retrieval is deterministic:
   - one query per anchor
   - exclude the current issue and the two before it
   - dedupe by URL
   - rank deep archive first
   - four passages per anchor

   Only then does one LLM call write the section
   (WB/editorial.ts:868-987, :1455-1470). What MCP adds is a model choosing
   among tools, and nothing in Echoes is chosen by a model. None of the lens
   tools takes a block of issue text as input, and none does this
   stitching.
2. **MCP would take away things the builders use.**
   - Scope is fixed to `all` (runtime.mts:897).
   - `limit` is capped at 12, and verify asks for 20.
   - Results come back as JSON text subject to the 48,000-character cap
     (defect 1).
   - The descriptions tell models not to write URLs, while Echoes requires
     them.
   - Through Anthropic's API-side MCP connector (the `mcp_servers` beta, which
     is present in both builders' SDK 0.123.0; not verified against current
     API docs), the API calls the server itself. WT Builder could then no
     longer filter out Thingy's text before the model sees it, and AT Builder
     could no longer check citations against a `seen` set before its model
     sees results.
3. **Auth is the wrong kind.**
   - `/mcp` takes only user OAuth: public clients, authorization code plus
     rotating 30-day refresh tokens (`oauth-store.mts:17-21`).
   - A builder would have to hold Jamie's refresh token.
   - Its calls would land in Jamie's audit rows beside real MCP-client
     evidence.
   - It would hit the 300-an-hour limit, which the owner is not exempt from.
     WB verify alone can make ~96 calls per issue.
   - A service secret on `/mcp` was considered and declined on 2026-09-20
     (`at-builder/docs/decisions.md:78-91`).
4. **Publishing wants the pinned contract.** `/retrieve` is versioned, and
   WT Builder negotiates the major on every call (WB/integrations/
   librarian.ts:56-57). MCP tool shapes change with `server_version`, by
   design. A send-week Echoes run should not depend on a schema that may
   change between Tuesday and Sunday.

So the move would change the wire and not the results, give up the filters
and the contract, and add a credential to keep alive. That is the "plumbing
for no real benefit" case.

### Where the value is: the workarounds are findings about the server

Every workaround the builders carry is something the archive should do once.
The changes are additive, so they fit a minor contract bump (4.11), and the
same fields reach MCP through the shared `retrieve()` and `compactSource`.

| Workaround today | Server change | Retires |
|---|---|---|
| WT Builder text-matches every Thingy sentence of 40+ characters from its local DB and drops passages containing one (WB/editorial.ts:1172-1244; the comment calls it "the stopgap; the Librarian carrying an `author` on each passage is the fix"). AT Builder has **no filter at all** | `voice` on every passage; Thingy excluded by default (Move 2) | `withoutThingy` and its false drops of Jamie text an echo quoted, plus WT Builder review #9 |
| AT Builder absolutises `/archive/347/` (AB/librarian.ts:57-72) | Absolute `url` on every passage | AT Builder's rewrite, and the MCP URL problem |
| AT Builder computes the `WT312` citation label (AB/librarian.ts:74-80) | `label` on every passage | Citation-label drift between builders |
| WT Builder drops the current issue and the two before it after fetching (WB/editorial.ts:975) | `filters.exclude_issues` or `filters.before` | Lost slots: today excluded passages still use up the k |
| Echoes treats undated passages as deep archive (WB/editorial.ts:981-982), so the `/about/` and `/faq/` chunks in the WT corpus (corpus.py:515-532, `publish_date: None`) rank ahead of real issues | `filters.source_kind` that can drop `site_page`/`faq`, or exclude them by default on `/retrieve` | Site boilerplate that can surface as an "echo" |
| Verify searches the issue's own title with k=20 to learn whether it is indexed | `filters.issue_number`, which makes the probe exact | ~96 embed and rerank calls per send |
| `/retrieve` logs carry no caller (runtime.mts:1619-1625), so WT Builder, AT Builder, golden and bench look the same | A `caller` field, logged | "Which builder made that call" |

### Consumer defects found on the way (in the builder repos)

- **A. Echoes never searches the blog or podcast, though its prompt and
  contract say it may.**
  - The prompt says "his blog and the Another Thing podcast are welcome when
    the echo lives there" (WB/editorial.ts:398-402).
  - The contract says "blog and podcast pulls welcome"
    (`wt-builder/docs/service-contracts.md:203`).
  - But the client sends no `scope` (WB/integrations/librarian.ts:58), and
    the server default is `weekly_thing` (`shared/scope.mts:15-16`), so a blog
    or podcast echo cannot be retrieved.
  - The fix is one field (`scope: 'all'`), or a doc change if WT-only is the
    intent. Which one is Jamie's call (product call 6).
- **B. AT Builder can present Thingy's words as Jamie's.**
  - It searches with `scope: 'both'` and has no author handling (a grep of
    AB for thingy or author finds only a comment).
  - So WT350+ Echoes and Membership text can come back as hooks and
    prospecting evidence.
  - Move 2 fixes this server-side with no AT change.
- **C. The consumer docs are stale.**
  - runtime.mts:1603-1604 still names workshop_bot.
  - `AGENTS.md:34-36` says Thingy is a live `/retrieve` client; Thingy web
    never calls it.
  - The consumer registry at `librarian-contract.mts:38-44` omits at-builder,
    which pins 4.10.0.
  - The contract types passages as `archiveItem` and leaves out the fields
    both builders read (`text`, `issue_number`, `section`, `score`;
    `contracts/librarian-api.json:250-276`).
  - `docs/echoes.md` is Eddy-era.
  - `wt-builder/docs/integrations.md:73` says Membership calls retrieval; it
    reads support.json.

### The one place a richer door could pay: AT prospecting

AT Builder prospecting is a model-driven loop with a single search tool. It
would be better with `entity_lens`, `find_links`, `get_source` and the
`voice` filter. The 2026-09-20 decision stands, and this is not a
recommendation now. If prospecting quality becomes the constraint, the
smallest step is more AT client tools, each backed by a `/retrieve` addition.
The larger step is a service door modelled on `/tools`: list and call over
the same registry and invoker, with the retrieve secret, `surface: 'service'`
audit rows and its own quota. That door leaves `/mcp`'s public auth surface
untouched, which was the concern on 09-20. It is a product call (7), not a
defect.

**Capacity, unmeasured.** The stream Lambda has `ReservedConcurrentExecutions:
5` (`infra/cloudformation.yaml:338`), shared by `/chat`, `/mcp`, `/tools`
and `/retrieve`. An Echoes run fires five `/retrieve` calls in parallel, so
for their duration it can hold every slot, and a reader's `/chat` in that
window would be throttled. No latency or throttle figures are recorded
anywhere; `retrieve_completed` carries `duration_ms` in CloudWatch, and I did
not query it.

---

## Part 6: tool-surface consistency

The census over the 18 production tools.

**Argument names**
- **Scope and subject arguments have 2 to 4 aliases each, mostly
  undeclared.** Examples: `topic|entity|query` (list_content),
  `claim|claims|query|text` (claim_check), `theme|topic|query` and
  `mood|mode` (archive_gems), and `issue_number` meaning different things in
  `get_source` and `latest_content`. Declare one name per concept and keep
  aliases undocumented for compatibility.
- **Windows take four shapes:** `year_range`, `year`, `year_start/year_end`
  (top_references only) and `era` (undeclared). Settle on `year_range` plus a
  `year` shorthand.
- **Issue identifiers are typed inconsistently:** `string` in get_source,
  `integer|string` in list_content. `limit` is `number` in corpus_stats and
  `integer` elsewhere.

**Schemas and descriptions**
- **47 arguments have neither a description nor an enum.** No schema sets
  `additionalProperties:false`, and no `limit` declares a maximum.
- **Shared text is repeated across tools.** The URL sentence appears 12 times,
  `match_mode` 4 times and `case_sensitive` 4 times; about 1.7 KB is repeated
  per `tools/list`.
- **Descriptions talk about an "active source scope"** that MCP callers
  cannot set, because MCP always runs at `all` (RT:897).

**Response shapes**
- **Counts come in two shapes:** arrays of `{year, count}` in most tools,
  objects in `currently_history` and `top_references`.
- **Truncation has three signals:** `{omitted, note}` markers inside arrays,
  the prose hard-slice suffix, and nothing at all for `limit` cutoffs.

**Conventions worth writing into `apps/librarian/AGENTS.md`, each enforceable
in `tests/mcp.test.mjs` from the built declarations:**
- one declared name per concept
- `year_range` for windows
- `limit` with minimum, maximum and default in the schema
- `additionalProperties:false`
- `readOnlyHint` on every tool and `openWorldHint` on live ones
- every result carries `applied`
- errors carry `isError` and a code from a closed set
- truncation stays valid JSON with `omitted` counts
- no Thingy-app phrasing in MCP descriptions
- every id a tool emits is accepted by `get_source`

---

## Part 7: the call log, and observability to stage

**Census.**
- **Source:** `mcp-list --days 14`, read 2026-09-29 18:57 CT.
- **Scan:** 2 pages, not truncated.
- **Rows:** 54 in all. The oldest surviving row is from 2026-09-18; older
  rows have expired under the 14-day TTL.

**Headline: every call came from the owner. No reader has used the MCP in
the window.** Nineteen of the 54 calls are this review's own live probes
(2026-09-29). The remaining 35 fall on three days: 10 on 09-18, 23 on 09-25
and 2 on 09-26.

| Tool | Calls (probes) | Errors | avg / max ms | avg / max result chars |
|---|---|---|---|---|
| find_links | 16 (1) | 0 | 477 / 6,323 | 1,412 / 4,206 |
| source_neighborhood | 10 (1) | 0 | 2,173 / 2,862 | 12,242 / 27,943 |
| get_source | 8 (3) | 1 (a probe) | 428 / 2,938 | 11,184 / 41,841 |
| latest_content | 3 (1) | 0 | 3,618 / 6,170 | 3,887 / 7,874 |
| search_archive | 3 (1) | 0 | 4,026 / 6,218 | 10,204 / 13,264 |
| corpus_stats | 3 (1) | 0 | 3,042 / 7,636 | 36,353 / 43,596 |
| 9 others | 1 to 2 each, all probes | 0 | | |
| fetch_page | 0 | | | |

**What it says.**
- **Today the MCP has an audience of one.** Priority should follow that:
  1. First, the things that serve Jamie as author and curator: voice
     provenance, "have I linked this before", `on_this_day`, and the link
     graph.
  2. Reader polish (prompts, resources, descriptions for third-party
     clients) comes later, unless reader adoption is itself the goal. That is
     product call 8.
- **Organic use is about links.** find_links and source_neighborhood make up
  24 of the 35 organic calls, while search_archive has 2. The link graph's
  missing commentary and Journal links (defect 6) sit directly on the most
  used path.
- **No truncation was recorded and there was only one error.** The biggest
  result, corpus_stats at 43,596 characters, came within 4.4 K of the
  48,000 cap.
- **Slow calls exceeded 4.5 s five times:** latest_content twice, find_links,
  search_archive and corpus_stats. Across 54 calls that is too few for a p95.
- **Because every call is the owner's, quota exemption applied to all of
  them.** Defect 2's "spends quota on a bad call" has cost nobody yet.

**What the log still cannot say.**
- **Which client made a call.** The owner's 35 organic calls could be Jamie
  in claude.ai or agent sessions using his connector; there is no
  `client_id` (defect 17).
- **Which door a call came through.** The `mcp-list` index record drops
  `surface`, so any `/tools` web-app rows sharing the `mcp#` prefix are
  counted here too.
- **Which argument keys clients pass.** They are only visible per call
  through `mcp-show`, which this census did not read.
- **Anything older than 11 days.** Older rows have expired.

Improve Thingy's MCP remit covers this every three days, but
`AGENT-TEAM/summaries/` holds no recorded MCP findings. With no reader
traffic, there was nothing for it to find.

Smallest changes that would make the next review measurable:
1. **An aggregate mode in `conversation_review.py`** (`mcp-census --days N`):
   per tool calls, distinct readers, `tool_error` count, avg/p95/max
   `duration_ms`, avg/max `result_chars`, truncation count, and the argument
   **keys** (never values) per outcome. It reads the same rows, so it adds no
   new privacy surface.
2. **Record `client_id` on every audit row** (it is already on the grant) and
   the `initialize` client name where the client sends one. Split `surface`
   properly between `mcp` and `web`.
3. **MCP audit retention of 45 days**, matching conversations, instead of the
   hard-coded 14 (`retention.mts:27-29`). A two-week window is too short for
   a weekly-cadence corpus.

---

## Part 8: what I would do, in order

**Now, no decision needed (defects).**
1. Structural truncation that stays valid JSON; `isError` with a closed code
   set; validate before quota; drop `web_search` from the launch list when it
   is unbound (defects 1, 2).
2. Annotate WT media descriptions in the CI upload; add `describe_media` to CI
   for new images (defect 3).
3. Lens compaction that never unresolves `first`/`latest`/reading-path ids;
   `limit` bounds `sources_by_id` (defect 7).
4. `archive_gems`: return `sources_by_id` in theme mode, randomise
   `serendipity`, declare one of `mode`/`mood` (defect 8).
5. `find_links`: honour `case_sensitive`, stop entity_index over-admission,
   echo `match_mode` (defect 9).
6. Fix the docs and specs that are wrong today (defects 11, 12, 14, 16):
   Currently kinds from the data, `get_source` section examples, version
   strings, tool count, limits.
7. Echo applied filters; reject an inverted `year_range` (defect 13).
8. Trace and fix the de-punctuated passage text (defect 15).
9. Stale `/retrieve` docs and contract typing: the handler comment, the
   `AGENTS.md` "Thingy is a live client" line, at-builder in the consumer
   registry, passage fields in `librarian-api.json`, and the WT Builder
   Membership line (Part 5, C).

**Next, additive (needs a nod, not a design session).**
10. `section_family` on chunks and links, commentary links in the graph,
    `?ref=` resolution (defects 5, 6; Move 1).
11. Voice provenance with Thingy excluded from evidence by default (Move 2),
    on MCP **and** `/retrieve`. Then retire WT Builder's `withoutThingy`.
12. `/retrieve` 4.11, additive: `voice`, absolute `url`, `label`,
    `filters.exclude_issues`/`before`, `filters.source_kind`,
    `filters.issue_number`, a logged `caller`. Then retire AT Builder's
    URL and label rewrite and switch WT Builder verify to the exact lookup
    (Part 5).
13. Skim layer: abstracts on source records, `group_by: source`,
    `get_source format` (Move 3).
14. Filters: `source_kind` everywhere, `content_kind`, `category`, cluster
    `topic`, `trope`; `similar_issues` in `source_neighborhood`; `list_topics`
    (Move 4).
15. Annotations, `outputSchema`/`structuredContent`, `id` on every source tool,
    absolute URLs (Move 5).
16. Publish `compare_eras`; add `on_this_day` and a `url` filter on
    `find_links`; distinctive yearly terms (Move 6).
17. Resources and prompts (Move 5).
18. Observability: `mcp-census`, `client_id`, 45-day retention (Part 7).

**At the next major (breaking; batch them).**
19. One declared name per concept (retire the aliases from the schemas, and
    later from the code); `year_range` everywhere; `latest_content
    issue_number` renamed to `also_in_issue`; `entity_lens` folded into
    `archive_lens`; `claim_check` either becomes a real support judgment or is
    renamed `find_evidence`.

**Product calls for Jamie.**
1. **Thingy's words in the archive.** Exclude `voice: thingy` from evidence by
   default and keep it searchable on request (recommended), or exclude it from
   the index entirely. The trade-off: searchable Echoes are useful ("what did
   Thingy connect in WT351"), but without the default exclusion they
   contaminate every "what did Jamie say" answer.
2. **Links in MCP answers.** Let MCP descriptions diverge from the chat specs
   so third-party clients cite with links. The trade-off: two description sets
   to maintain (generated from one source with a surface flag), against
   uncited answers in claude.ai and ChatGPT today.
3. **Audio pointers.** Expose the WT audio edition (listen URL, duration,
   chapter titles) as metadata on issue records. The trade-off: the ratified
   decision keeps VTT and chapters as surface artifacts, not archive; a
   pointer read from the weekly render copy honours "text only" but adds a
   cross-repo read.
4. **Blog abstracts.** Spend a one-off Haiku batch on the 2,380 titled posts to
   extend the skim layer to the blog. The trade-off: a small paid pass and a
   new artifact to keep fresh, against a skim layer that covers only the
   Weekly Thing.
5. **Audit retention of 45 days instead of 14.** The trade-off: longer-lived
   reader tool arguments, against reviews that can see more than two weeks.
6. **Echoes scope.** Send `scope: 'all'` so the blog and podcast can echo, as
   the prompt and contract already say (recommended), or change both
   documents to say WT only. The trade-off: blog echoes widen what a reader
   discovers, but microposts are short and plentiful and may crowd out issue
   echoes. The anchor pool's four-per-anchor cap limits that.
7. **A service tool door for AT prospecting, later.** If prospecting quality
   becomes the constraint, expose the registry to service callers through a
   `/tools`-style door with the retrieve secret, not through `/mcp`. The
   trade-off: the full toolset for the builders' loops, against a third
   door to audit and keep in step. Not recommended now.
8. **Who the MCP is for.** In the last 11 days of log, every call came from
   the owner (Part 7).
   - **If it is Jamie's own instrument** (with agents acting for him),
     Moves 2 and 6 and the link-graph fixes come first, and reader polish
     waits.
   - **If reader adoption is a goal**, it needs a nudge beyond `/connect/`:
     for example, a mention in an issue, or a prompt that makes the first
     call obvious.

   The trade-off is where the next few sessions go.
