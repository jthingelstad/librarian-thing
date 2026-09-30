# Plan 2026-09-29: the Librarian MCP and the corpus behind it

This plan implements `docs/REVIEW-2026-09-29-mcp-corpus.md`. It covers three
repos: librarian-thing (LT), wt-builder (WB) and at-builder (AB), plus small
edits to thingy.thingelstad.com. Approved 2026-09-29; work starts with Phase 1.

## What Jamie decided (2026-09-29)

- "I agree with every recommendation you have." That covers the six moves,
  the ordered list and product calls 2 to 5.
- "This tool is for me and readers." Both audiences, so Phase 5 invites
  readers once the surface is ready.
- "I love the idea of an on this day tool." It ships early, in Phase 2.
- "It is a huge miss if Echoes isn't getting the blog and podcast." This is
  Phase 1, targeted at WT352.
- "Thingy's echoes section should be excluded from the corpus entirely."
  This replaces the recommended "keep it out of evidence by default". The
  voice work below therefore tags only `jamie`, `quoted` and `link`.

## Shape

| Phase | What ships | Versions | When |
|---|---|---|---|
| 1 | Thingy out of the corpus; Echoes reaches the blog and podcast; `/retrieve` 4.11 | contract 4.11.0 | Wed 09-30 to Thu 10-01, live before WT352's window |
| 2 | Trust fixes, `on_this_day`, photo descriptions, observability | MCP 1.3.0 | From Fri 10-02 (MCP-only), the rest after WT352 is sent |
| 3 | Structure and voice in the corpus; filters, skim layer, `list_topics`, `compare_eras`, link history; Echoes "this week in past years" | MCP 1.4.0, contract 4.12.0 | Week of 10-05 |
| 4 | MCP-native and breaking cleanup: resources, prompts, schemas, one name per concept | MCP 2.0.0 | Week of 10-12, before readers are invited |
| 5 | Readers: `/connect/` rewrite, docs, the invitation | | After Phase 4 |

**Send-week freeze.** WT352 is dated Saturday 10-03, and its window opens
Friday 00:00 CT. The WT audio backfill also resumes that Friday.

- **Frozen:** WB and AB deploys, and LT changes that touch the corpus or
  `shared/retrieval.mts`, from Friday 10-02 00:00 CT until WT352 is sent.
- **Allowed:** MCP-only Lambda deploys, meaning code that `/retrieve` does not
  run.

**Process in every repo.**
- **LT:**
  - Claim the lease with `AGENT-TEAM/scripts/objective_lease.py`, run
    `check-base` before the first edit and before each push, and run
    `make check`.
  - Push to `main`; CI (`deploy.yml`) tests, runs the tool eval, rebuilds,
    embeds only changed chunks and deploys. Chunk ids hash chunk text
    (`corpus.py:682-686`), so text changes re-embed only what changed.
  - `EMBED_RECIPE_VERSION` stays at 2 throughout, so there is **no paid full
    re-embed**.
- **WB and AB:** `npm test` and `npm run typecheck`, commit to `main`, then
  `npm run deploy`. That is the only sanctioned restart.
- **Docs and fixtures** ship in the same commit as the change they describe.

---

## Phase 1: Echoes gets the whole archive, and Thingy leaves the corpus

**Order matters:** LT deploys and is verified first. WB and AB follow the same
day. WB's `withoutThingy` is retired only after a live read shows the corpus
is clean.

### LT corpus
1. **Strip every Thingy block before anything reads the issue.**
   - **What:** add `strip_thingy_blocks(md)` in `librarian_core/corpus.py`. It
     is a non-greedy `re.S` match on the WB frame: `<div class="from-thingy">`,
     the label `<p>`, the markdown, then `</div>` on its own line
     (WB/src/shared/render/website.ts:57-71).
   - **Where it runs:** in `build_corpus` right after `read_issue` (:704), so
     that it precedes word counts, sections, topics, the abstract, media,
     Currently and chunks. Also in `journal_blog_xref` (:949).
   - **Where it must not run:** inside `read_issue`, which also reads blog
     posts.
   - **Free side effects:**
     - The now-empty `## Echoes` section drops out on its own (:178).
     - The graph (`entity_index`, tropes, `similar_issues`) and the topic
       push to weekly inherit the strip, because `graph.load_corpus` calls
       `build_corpus`.
   - **Tests:** a fixture copied from WT351's real frame, asserting that no
     Echoes or Membership text survives and that everything else is
     byte-identical. The frame is now a cross-repo contract, pinned on both
     sides: WB `tests/echoes.test.ts:64,73,136-147` and the new LT test.
   - **Scope:** this removes **both** of the Thingy blocks WT350 and WT351
     carry, Echoes and Membership (which includes the thank-you line). One
     rule follows the byline, and the Membership copy is a support note, not
     archive. Jamie confirmed.
2. **Drop the `None` bucket.** `issue_vectors` in `graph.py:334` collects
   site and FAQ chunks under `None`, which can appear in `similar_issues`.
   Skip chunks without an issue number.

### LT Lambda, `/retrieve` contract 4.11.0 (additive)
3. **Passage fields** in `compactSource` (`shared/retrieval.mts:328-354`):
   - `id`
   - an absolute `url`: WT uses `https://weekly.thingelstad.com/archive/N/`,
     and site pages resolve against weekly
   - `label`: `WT312`, the blog title, or `AT1`
   - `source_kind` stated honestly: WT chunks say `weekly_thing`, not
     `chunk`; `site_page` and `faq` are kept as themselves.

   Fix `urlKey` (`shared/archive-tools.mts:755-770`) so that an absolute
   weekly URL and `/archive/N/` key the same. This also fixes Thingy web's
   `/about/` and `/faq/` links, which currently resolve to the wrong host.
4. **Filters:**
   - `filters.source_kind`, an include or exclude list
   - `filters.exclude_issues`
   - `filters.before`, a date
   - `filters.issue_number`, an exact lookup

   All of them run inside the scan, before top-k, as year and section do now.
5. **Caller and logging.** Add an optional `caller` string, and log `caller`,
   `scope` and the filter keys on `retrieve_completed` (runtime.mts:1619-1625).
6. **Contract:**
   - Type the passage fields in `shared/librarian-contract.mts` (`/retrieve`
     at :308-330).
   - Bump to 4.11.0, with an entry in the changelog comment (:1-35).
   - Add at-builder to the consumer registry (:38-44).
   - Run `npm run contract:generate`.
   - Fix the stale workshop_bot comment (runtime.mts:1563-1568, :1603-1604)
     and the `AGENTS.md:34-36` "Thingy is a live client" line.
   - Thingy web: `npm run contract:sync`.

### WB (after the LT deploy is verified)
7. **Reach the whole archive.** Extend `retrieve()` (`integrations/librarian.ts:44`)
   to take scope, filters and caller. Echoes sends:
   - `scope: 'all'`
   - `filters: {source_kind: {exclude: ['site_page','faq']}, exclude_issues: [n, n-1, n-2]}`
   - `caller: 'wt-builder'`

   With the exclusion done on the server, excluded issues no longer take up
   the k.
8. **Make Echoes blog- and podcast-aware:**
   - **Types:** extend the `Passage` type (:24-33) with `source_kind`,
     `label`, `show`, `episode_number` and `also_in_issues`.
   - **`passageContext`** (editorial.ts:990-1005) prints the label and kind
     for every passage.
   - **Prompt** (:394-440): add citation examples for a blog post and an
     episode next to `[WT210](…)`.
   - **Grounding** (`echoGrounding`, :1053-1111):
     - accept the absolute URLs
     - accept a WT number that comes from a passage's `also_in_issues`
     - check podcast labels
   - **Pool** (`poolEchoPassages`): drop the "undated means deep archive" rule
     (:981-982). Site pages no longer arrive.
   - **UI:** Inspector and canvas labels come from the passage `label`.
   - **Tests:** `editorial.test.ts` and `editorial-draft.test.ts` get fixtures
     for mixed passages.
   - The four-per-anchor cap and "primarily the Weekly Thing" stay as they
     are.
9. **Retire `withoutThingy`.**
   - **Code:** editorial.ts:1172-1244, the call sites at :1408, :1421 and
     :1607, `DraftRequest.thingy`, and index.ts:399-406.
   - **Tests:** editorial.test.ts:356-388, editorial-draft.test.ts:108-133,
     and `tests/draft-routes.test.ts`.
   - **Keep:** `issueExcerpt`'s own Thingy skip, which filters local documents.
10. **Exact verify probe.** `verify.ts:337-349` calls
    `retrieve(title, 1, {filters: {issue_number: n}})`. One precise call
    replaces the semantic probe at k=20.
11. **Pin and docs.**
    - Pin 4.11.0.
    - `docs/service-contracts.md`: Echoes (:199-260; "No /retrieve contract
      change" at :220-221 is no longer true) and the stopgap at :227-238.
    - `docs/integrations.md:66-73`.
    - A `docs/decisions.md` entry under "Publishing and the archive".
    - Mark review item #9 as done.

### AB
12. **Use the server's URL and label.**
    - Drop `absoluteUrl` and `citationLabel` (`src/server/librarian.ts:57-80`)
      in favour of the server's `url` and `label`. This also removes the
      latent wrong host for podcast URLs.
    - Send `caller: 'at-builder'` and pin 4.11.0.
    - Update `tests/units.test.ts:331-339` and `docs/integrations.md:21-27`.
    - AB gets the Thingy exclusion from the server with no code of its own.

### Verify (reads only)
- **Thingy text is gone.** Through the MCP connector:
  - `quote_search` for a sentence from WT351's Echoes returns 0 hits.
  - `get_source WT351` has no Echoes or Membership.
  - `claim_check "Jamie installed Locally AI in WT328"` puts WT328 first.
- **WB test suite green.**
- **Echoes calls land as intended.** After Jamie next drafts Echoes, the
  CloudWatch `retrieve_completed` lines show `caller: wt-builder, scope:
  all`. That is a log read, done in US Central.
- **Done when:** WT352's Echoes can cite a blog post or episode, and no
  retrieved passage contains Thingy text.

---

## Phase 2: trust fixes, `on_this_day`, observability (MCP 1.3.0)

Non-breaking. Everything here lands in LT, plus one local batch.

1. **Valid JSON under the cap.**
   - `renderToolResultText` (`shared/mcp.mts:111-127`) trims whole list items
     until the result fits, and adds `omitted` counts instead of slicing
     text.
   - Serialise compactly (no indent), which saves about 25%.
2. **Errors that say so.**
   - An `{error}` result goes out with `isError: true` and a `code` from
     `not_found`, `bad_request`, `too_large` and `not_configured`, plus one
     next step.
   - Validate arguments against the declared schema **before**
     `spendQuota` (mcp.mts:281).
   - Drop `web_search` from `MCP_LAUNCH_TOOLS` when it is unbound.
   - Web (`/tools`) gets the same treatment.
3. **`on_this_day`, a new tool** (details below). It uses today's records,
   and the Phase 3 skim fields enrich it automatically.
4. **Photo descriptions in production.**
   - Call `annotate_media_descriptions` in `pipeline/deploy/upload_corpus.py`
     (before :160-168).
   - Run `pipeline/corpus/describe_media.py` locally for the images added
     since 2026-09-05. There are about 20; the cost is cents, and the local
     `.env` key is the one it already uses.
   - Add that step to the weekly Run Librarian procedure
     (`AGENT-TEAM/run-librarian.md`).
   - A CI step would need a new GitHub secret, so it is not proposed.
5. **Lens results that resolve.**
   - Lens compaction (`archive-lens.mts:536-543`) keeps `first`, `latest` and
     the reading-path ids resolved.
   - `limit` bounds `sources_by_id`.
   - Fix the reading-path reason overwrite.
6. **`archive_gems`:**
   - return `sources_by_id` in theme mode
   - make `serendipity` random again (AT:1758)
   - report a `mode`/`mood` conflict instead of silently choosing one
7. **`find_links`:**
   - honour `case_sensitive` (AT:577-598)
   - stop admitting every link of an `entity_index` issue (AT:591-593, :613);
     require the match in the link's own text or title
   - echo `match_mode` and `match_reasons`
8. **Correct the facts in specs and docs.**
   - Currently kinds from the data (20, with variants such as "installing
     more" folded into their kind).
   - `get_source` section examples.
   - `latest_content issue_number` described as what it does.
   - `corpus_stats` stamps `serverVersion()` (AT:1089).
   - Tool counts, the 300/hour limit and the 48,000-character cap in
     `reference/librarian.md`, `apps/librarian/AGENTS.md` and `README.md`.
9. **An `applied` echo** on every tool: window, limit and mode. An inverted
   `year_range` becomes `bad_request`. Fix "1 years" and drop `issue_year`
   from blog hits.
10. **Trace the de-punctuated passage text** (review defect 15) and fix it
    where it enters stored text.
11. **Observability:**
    - **Audit rows** (`shared/mcp-audit-store.mts`) record `client_id` (from
      `validateAccessToken`, RT:1109), the registered `client_name`,
      `server_version` and `surface`.
    - **Retention** of 45 days (`shared/retention.mts:4`). It applies to new
      rows only.
    - **A census op** (`conversation_review.py mcp-census --days N`) gives
      aggregates per tool and per client: calls, readers, errors,
      avg/p95/max ms, result size, truncation, and argument **keys** only.
    - Fix the `surface` label (:627, :652).
12. **Start the conventions test** (`tests/mcp-conventions.test.mjs`). It runs
    over the built declarations and asserts what holds from this phase on:
    - every `limit` declares a maximum
    - errors carry `isError` and a code
    - truncated output parses as JSON
    - every emitted id is accepted by `get_source`

    Phase 4 tightens it.

### `on_this_day`
- **Arguments:**
  - `date`: `YYYY-MM-DD` or `MM-DD`. The default is today in America/Chicago.
  - `window_days`: 0 to 7, default 0.
  - `year_range`.
  - `source_kind`: default all three.
  - `include_microposts`: default true.
  - `limit_per_year`: default 5, maximum 20.
- **Matching:** the month-day of `publish_date[:10]`.
  - Blog dates come from the permalink, which is the local date.
  - WT timestamps are UTC noon, which is the same calendar day.
  - Podcast dates are plain dates.
  - Past years only. February 29 folds into February 28 in other years.
- **Returns:**
  - `applied`: date, window, timezone and years.
  - `years[]`, newest first, each with `years_ago` and items.
  - Each item carries `{id, label, source_kind, title, date, url, excerpt}`.
    The excerpt becomes the description or abstract once Phase 3 adds them.
  - A post's first photo as `{url, alt}` when it has one, so `view_photo` can
    show it.
- **The same helper** also backs the Phase 3 `/retrieve` calendar filter and
  a Phase 4 resource and prompt.

**Verify:**
- `media_search "Cliffs of Moher"` returns WT291 photos with descriptions.
- `get_source 9999` returns `isError` with `not_found`.
- `list_content limit=120` parses as JSON.
- `on_this_day` for today returns years with items.
- A new audit row carries `client_id`.

---

## Phase 3: structure and voice (MCP 1.4.0, contract 4.12.0)

### LT corpus
1. **`section_family`.**
   - `split_sections` (`corpus.py:163-180`) carries the last H2 as the
     family.
   - Era names map onto families, next to `NOTABLE_SECTIONS` and
     `BRIEFLY_SECTIONS` in `links.py:26-39`. Families: Notable, Briefly,
     Journal, Currently, Featured, Photo, Fortune, Reply All, Straw Poll,
     Give Back, Yearly Thing, FYI.
   - The family is stamped on chunks, section records and links.
   - The H3 stays as `heading`.
   - `docs/sections.md:37-45` is corrected: 351 of 352 issues do have H2s.
2. **Commentary and Journal links.**
   - Extract links from bodies in the section loop (:792-834) with a
     `link_role` of headline, commentary or journal, deduped against the
     frontmatter headline links.
   - Widen `_JOURNAL_ENTRY_LINK_RE` (:242) to cover the "Nov 1, 2024 at
     7:41 PM" and "[7:00 PM]" styles.
   - Strip query strings such as `?ref=weekly-thing` before
     `_normalize_blog_path` (:930-935).
   - Resolve links to weekly issues and podcast episodes
     (`target_resolved`).
3. **Voice spans.** Every chunk carries
   `spans: [{voice, start, end}]` over its text:
   - blockquotes are `quoted`
   - headline link titles are `link`
   - everything else is `jamie`

   The embedding input is unchanged, so no re-embed is needed.
4. **Skim fields and the rest of the structure:**
   - Issues get `description`, Jamie's dek from the frontmatter.
   - Blog posts get `categories` and the full `published` time.
   - Chunks expose `content_kind`.
5. **Blog abstracts.**
   - One Haiku 4.5 batch over the 2,380 titled posts, through
     `pipeline/blog/anthropic_client.py`. Estimated cost is about $3 at that
     file's rates: roughly 1.3M tokens in and 0.3M out.
   - Stored in a sidecar, `data/librarian/blog-abstracts.json`, keyed
     `microblog_id → {body_hash, abstract, model, generated_at}`. The hash
     means an edited post is redone.
   - Generated abstracts are **display metadata**: labelled
     `abstract_source: generated`, never embedded and never matched as
     Jamie's words. This follows the same principle as excluding Thingy.
   - Microposts are their own abstract.
6. **Similar issues on the site too.**
   - Build `data/librarian/graph.json` from the embedded corpus, or pull the
     S3 graph after upload (`deploy.yml:193` currently runs before
     embedding).
   - Weekly then receives real `similar_issues`. Showing them on the site
     is a later, optional change.
7. **Audio pointers.**
   - CI checks out weekly.thingelstad.com **read-only** with the existing
     `STUDIO_PAT_TOKEN`.
   - The build reads `apps/site/archive/N.md` frontmatter for `audio_url`,
     `audio_duration_seconds` and `audio_chapters` (start and title only).
   - Issue records get `audio: {url, duration_seconds, chapters}`.
   - Transcripts and VTT stay out, which honours "text only". This reads a
     sibling repo and adds no new cross-repo push.

### LT Lambda
8. **Filters:**
   - `voice`, `section_family`, `content_kind`, `category`, `trope`, and
     `topic` as a cluster.
   - `source_kind` on `search_archive`, `quote_search`, `media_search` and
     `claim_check`.
   - An issue filter on `media_search`.
   - Lexical tools match within the requested voice's spans. Semantic search
     reranks on the voice-filtered text.
   - Evidence entries carry `voice`.
9. **Skim layer:**
   - `description`, `abstract` and `key_points` on every source record.
   - `search_archive` groups by source by default.
   - `on_this_day` excerpts upgrade automatically.
10. **Structure tools:**
    - `list_topics`, a new tool: the 9 clusters and the 752 site topics, with
      counts and page URLs.
    - Publish `compare_eras`, taking two `year_range`s.
    - `source_neighborhood` uses `similar_issues` for "more like this", and
      `also_in_issues` plus commentary links for `cross_source_links`.
11. **Author tools:**
    - A `url` filter and `link_role` on `find_links` answer "have I linked
      this before".
    - `corpus_stats` yearly terms are scored against the whole corpus.
12. **`/retrieve` 4.12.0, additive:**
    - `filters.voice`
    - `filters.section_family`
    - `filters.calendar: {date, window_days}`, the on-this-day window as a
      filter on search

### WB and AB (after 4.12 is live)
13. **Echoes, "this week in past years".**
    - This replaces the one-year-ago WT lens (`pickSeasonalIssue`,
      editorial.ts:1118-1137).
    - A pseudo-anchor runs the issue's own text through `/retrieve` with
      `filters.calendar` (the issue date, ±7 days). The result is passages
      from this week in every past year, across all three sources, pooled
      like the other anchors.
    - The `seasonal` parameter and its plumbing go away.
    - `listIssueDates` and `issueExcerpt` stay, because other features use
      them.
    - Per Jamie, it is a hint: at most two passages, pooled after the topical
     anchors.
14. **Link wand.** It adds a "linked before in WTn" block from the
    `find_links` `url` capability.
15. **Pins** move to 4.12.0 in both builders.

**Verify:**
- `search_archive section_family=Journal` returns WT351's Journal.
- `find_links url=<a thingelstad.com post linked in WT351's Journal>`
  returns WT351.
- `archive_lens voice=jamie` evidence carries no `quoted` spans.
- `list_topics` returns 9 clusters.
- An Echoes draft for WT353 includes a past-years passage. Jamie runs it; I
  read the result.

---

## Phase 4: MCP-native, and the breaking batch (MCP 2.0.0)

This comes before readers are invited, while the audience is still Jamie
alone.
1. **Descriptions per surface.**
   - Spec entries gain an optional `mcp` block; `mcpToolDeclarations`
     (mcp.mts:97-105) prefers it.
   - MCP descriptions drop the app phrasing and say "cite `WT<N>` with a
     markdown link to `url`".
   - The chat keeps its own wording.
   - The conventions test forbids "the app" in MCP text.
2. **Annotations.** `readOnlyHint` on every tool; `openWorldHint` on
   `fetch_page`.
3. **Output schemas.**
   - `outputSchema` plus `structuredContent` on every tool.
   - The schemas live in the spec and are stripped before the Bedrock
     binding (RT:581).
4. **Resources and templates:**
   - `librarian://wt/{n}`
   - `librarian://blog/{id}`
   - `librarian://topic/{slug}`
   - `librarian://year/{yyyy}`
   - `librarian://on-this-day/{mm-dd}`

   `resources/list` returns the newest issues. Each `resources/read` counts
   against the MCP quota and is audited as `resource:<kind>`.
5. **Prompts:**
   - how Jamie's thinking on a topic has changed
   - a year in review
   - a reading path
   - this week in past years
   - a research brief on a person or product

   The instructions string points at them.
6. **The breaking batch:**
   - **Argument names.** One declared name per concept. `year_range` for
     every window, with `year` kept as shorthand.
   - **Schema strictness.** Declared `limit` bounds, and
     `additionalProperties: false`.
   - **`latest_content`.** `issue_number` becomes `also_in_issue`.
   - **Merge.** `entity_lens` folds into `archive_lens` (aliases become an
     argument).
   - **Rename.** `claim_check` becomes `find_evidence`, which returns
     evidence per claim with voice and makes no verdict. The calling model
     does the judging.
   - **`get_source`.** It gains `format` (outline, text or full) and stops
     sending the body twice.
   - **One shape** for counts and for truncation signals.
7. **Consumers moved in the same pass:**
   - `prompts/agent-system.md` routing (:34-53, :88-90) and corpus kinds
     (:13-17)
   - `EXPECTED_PARAMS` and known answers in `scripts/eval-tools.mjs`, plus a
     reviewed `eval/baseline.json`
   - `MATCHER.md`
   - Thingy web test fixtures (`tests/thingy-webmcp.test.mjs`,
     `scripts/smoke-browser.mjs:145`) and `docs/THINGY_SURFACES.md:14`
8. **Tighten the conventions test** to the full list in review Part 6.

**Verify:**
- `initialize` shows 2.0.0 with tools, resources and prompts.
- `tools/list` stays under about 6K tokens.
- `resources/read librarian://wt/351` works.
- `prompts/list` returns the five prompts.
- One tool call returns `structuredContent`.

Jamie may need to refresh the claude.ai connector once so that it picks up
the new tool list.

---

## Phase 5: readers

1. **Rewrite `/connect/`** (thingy web `connect/index.html`). Cover:
   - what the archive holds
   - five example asks, with On This Day first
   - how to connect from claude.ai, ChatGPT and Claude Code
   - fair-use limits (500 a day, 300 an hour)
2. **Update the docs:** `reference/librarian.md`, `apps/librarian/AGENTS.md`,
   `README.md`, and the MCP instructions string.
3. **The invitation.** Jamie writes the mention in an issue, in his own words.
   Thingy never writes as Jamie. WB is ready whenever he is.
4. **Two weeks after the invitation:** read `mcp-census`, with Jamie's
   approval at that time, to see reader uptake and which tools readers
   actually reach for.

---

## Risks and how each is handled

- **Blog or podcast echoes could crowd out issues.**
  - The prompt keeps "primarily the Weekly Thing".
  - The four-per-anchor cap stays.
  - Jamie reads WT352's Echoes.
  - Rolling back is one field (`scope`) in WB.
- **Retrieval recall moves.** Stripping blocks and grouping by source both
  change recall. The CI eval baseline is updated only after a reviewed diff
  (`eval-tools.mjs --update-baseline`).
- **The Thingy frame becomes a cross-repo contract.** It is pinned by tests
  in both WB and LT and documented in `service-contracts.md` and LT
  `AGENTS.md`.
- **Capacity.** The stream Lambda's reserved concurrency is 5, and Echoes
  fires 5 calls in parallel. Phase 2 reads the Lambda `Throttles` metric
  before anyone proposes raising it; the cap came from security audit M3.
- **Breaking MCP 2.0.** It lands before any reader is invited, and
  `server_version` tells clients to refetch the tool list.

## Deliberately unchanged

- **Weekly's `/archive/N.txt` and `llms.txt`** still show the published issue
  with its labelled "From Thingy" blocks. They are the issue as sent, not the
  corpus.
- **No service secret on `/mcp` and no anonymous MCP tier.** Both are standing
  decisions. The AT prospecting tool door stays "later".
- **Transcripts and VTT stay out of the archive.** Only the audio pointer is
  added.
- **WB review items #16 and #19** (Echoes remembering across issues, and
  backlinks) are separate work.

## Jamie's answers (2026-09-29)

1. "Membership should be filtered too." Every Thingy-bylined block is stripped.
2. The past-years lens: "Yes, and that is just a hint. Calendar is less
   important for echoes than topics and themes." The calendar anchor is
   therefore a light hint: it is capped at two passages, pooled last, and the
   prompt says topical connections come first.
3. MCP 2.0 before readers: "Yes."

Approved to implement phases 1 to 5, including the blog-abstract batch.
