# Plan: the Library Agent (2026-10-22)

**Status: proposed, waiting for Jamie's go.** Nothing is built and nothing has
been written to micro.blog. Every number below was measured read-only on
2026-10-22 (a full Micropub `q=source` pull, the Tinylytics API with the
read-only key, the Anthropic Models API, the overhaul's cache in
`../www.thingelstad.com/dev/cache/categories/`, and the Librarian's S3 bucket
settings).

Jamie, 2026-10-22: "The Librarian decides; micro.blog keeps them and stays the
source of authority for the blog." The Librarian becomes the authority for the
blog's **categories** (Featured included, since Featured is a category) and
its **alt text**. micro.blog still holds every post; the Librarian never
creates, deletes, retitles or re-dates one, and never changes a word Jamie
wrote.

Revised four times the same day as Jamie answered; Jamie's words are under
What Jamie decided. This version is v5.

## What Jamie decided

- "I never actually assign categories to a post." The Librarian owns the whole
  list. The one exception is **Weekly Thing**, which WT Builder sets.
- "It could create new categories." It tells Jamie after.
- "Also agree on the alt text. It should own that. The librarian is my partner
  for this." Fill empty alt only; never replace alt Jamie wrote.
- "Agree it would move to daily. Yes to alt fills. Yes it should use its own
  model key."
- **Scope:** "Lets remove typo/grammer checking and link additions from the
  goal. Focus only on the alt text and category management. That removes the
  need for a feedback loop and I didn't like the GitHub issues approach
  anyway."
- **A Library Agent**, "a better framing than "tend the blog"", and "it could
  change some of the other agent team". Then: "Good on Library Agent replacing
  Keep the Archive True."
- **Featured stays.** **Every run ends with suggestions:** "any suggested
  category changes… or any other content related items it wants to
  highlight."
- **Weekly Thing issues don't matter to it:** "it should not care about weekly
  thing issues." "WT Builder should automatically pick up an edit/improvment
  to the blog post when it does it's scan on open" (it does; below).
- **Reader numbers join the corpus:** "view information and kudos become
  additional metadata to augment on posts", bucketed in time "so Thingy can
  know if something is trending up or down", and kept private: "this data
  should all be private in the corpus… don't think this should be part of the
  repo. Would generate a lot of commit noise." Kudos are coming to Things I've
  built too.
- **Judgment, not counts:** "I'd rather avoid quantitative rules like this and
  have it be more informed by an agent looking at the content and trying to
  deliver the right experience for visitors."
- **Categories carry a description:** "micro.blog has a place for category
  descriptions."
- **Collections:** "Why not just remove collections entirely and swap them in
  for categories."
- **The catalog:** "should labels, ledger, etc… should this be a sqlite DB that
  we keep alongside the content? wondering if we need to think about the
  corpus differently."

## What I measured first

**Monday's sync will not bring in the category changes.** The sync workflow
runs `ingest_blog.py --since-last`, which fetches only posts it has never seen
and stops at the first page it already knows. Edits to existing posts never
reach `data/blog/`. Against the live blog today:

| Posts | What differs from `data/blog/` |
|---|---|
| 9,422 | categories only |
| 38 | body or title too (WT Builder link and alt write-backs, whitespace, the three shared-address posts 1074797/1074798/1074800) |
| 1,008 | nothing |
| 1 | never ingested (5918023, 2021-11-19, a backdated POAP Claims post) |

So `data/blog/` and Thingy still show the old categories, and Monday 10-26
changes nothing. The fix is step 1 of the build: a refresh that compares every
post and rewrites only the files that changed. It busts nothing:

- Categories are not in chunk text, so blog chunk ids (`blog:<id>:<n>:<hash>`)
  do not move and nothing re-embeds for the 9,422. The 38 body changes
  re-embed (cents).
- Abstracts key on `body_hash`; only the 38 can change. No new photos, so
  `describe_media` has nothing to do.
- Thingy's `list_content` `category` filter reads the corpus's own category
  set, so after the deploy it accepts the new names and refuses old ones
  (Book, Travel Log) with the list of real ones. No eval names a category.
- The push rebuilds the Weekly Thing and blog corpora through the corpus gate,
  as any `data/blog/**` change does.

**New posts.** The newest post is 6049062 (10-17). The micro.blog filters are
gone, so every post from now on is uncategorised until the Librarian runs.

**Alt text.** Since 2026-07-01 the blog has 81 `<img>` tags and 50 empty alts
(67 before WT Builder's wand filled some). 46 of the 50 already have a vision
description in `data/librarian/media-descriptions.json`. All time: 224 empty,
of which 158 are dead 2017 uploads and about 8 were marked unfillable in the
June backfill.

**WT Builder and the open issue.** WT Builder's scan takes micro.blog's edit
of any post Jamie has not edited in WT Builder ("adopted the Micro.blog edit"
in its log, `src/server/reconcile.ts`). Only a post edited on both sides asks
Keep mine or Take theirs, and its own write-back is compare-and-set, so it
never overwrites the Librarian's alt unseen.

**Categories on micro.blog.** 125 live. Micropub `q=category` returns names
only. A category's description is micro.blog's **Intro** field, set in the
web editor when editing a category (Manton, 2025-08-11, "Category
improvements"); no API for it turned up. thing-hugo already renders it at the
top of the category page (the term page's `.Content`).

**Collections.** 43 hand-made pages under `/collections/` linking 624 posts.
27 are trips or series that already have their own category, which the
overhaul filled from these pages. Four match an existing category: Minnebar
(Minnestar), TeamSPS Events (TeamSPS), Crypto (Crypto) and Best of …
(Featured). The Wordle Games index and its ten pages hold the games
themselves, not posts. `/collections/` is the index, and `/categories/` is
live.

**Featured.** Three posts today, all 2026 (5863188, 5872650, 5904586). The
overhaul's labels give every post a substance score; 297 posts score 4+ and
are evergreen. Blog views are led by search traffic to old posts (Big Green
Egg 2009, Peppa Pig DVD 2009). Kudos: 57 in all, on 45 posts. 3,897 posts
are linked from a Weekly Thing issue, mostly as Journal items.

**Keys.** `.env` has `ANTHROPIC_GENERAL_API_KEY`, `TINYLYTICS_API_KEY`
(read-only, `tly-ro-`) and `MICROBLOG_API_KEY`. `TINYLYTICS_SITE_UID` is the
Weekly Thing site's uid, not the blog's; the Librarian names the blog by its
id, 1521. `OPENAI_API_KEY` is not needed: the Codex agent runs on Jamie's
Codex account.

**Models** (live Models API, 2026-10-22): `claude-opus-5-5`,
`claude-sonnet-5-5`, `claude-haiku-5-5` and `claude-fable-5-1` are current.
`pipeline/blog/anthropic_client.py` still maps `sonnet` to `claude-sonnet-5`
and `opus` to `claude-opus-4-7`; both still answer but are a generation old.

## Where the library's data lives

The corpus is already not in git. CI builds the corpora, graph and embeddings
from what is in git and uploads them to S3 (`weekly-thing-librarian`), where
the Lambda reads them. What is in git is the input, and v4 of this plan was
going to add the Librarian's catalog and reader numbers to it. v5 splits the
data by what it is:

| What | Where | Why |
|---|---|---|
| **What was published:** issues, posts, pages, episodes, things | git, `data/` (unchanged) | Public text already. Its diffs show what changed on micro.blog. WT Builder commits issues there, and CI builds the corpus from it. |
| **What the Librarian knows and decides:** categories, labels, filings, the event log, suggestions, reader numbers | **`library.db`**, one SQLite file in S3 | Private, changes every day, and is the Librarian's own working state. None of it is public or belongs in commits. |
| **What Thingy answers from:** the corpora, graph, embeddings | S3 (unchanged) | Built by CI from git, joined with reader numbers when it answers. |

Photo descriptions and summaries are the Librarian's knowledge too, but they
stay committed sidecars for now: CI builds the corpus from them and they hold
nothing private. Moving them in later would end their commits, with CI reading
`library.db` from S3. Worth revisiting once the agent has run a few weeks.

**`library.db`** lives at `s3://weekly-thing-librarian/library/library.db`.
The bucket blocks public access, is encrypted, and is **versioned**, so every
day's copy is kept and any day can be restored. The Library Agent is its only
writer. Each round downloads it, works on the local copy, and uploads it only
if S3 still holds the copy it downloaded (a conditional write on the ETag), so
two runs can never overwrite each other. The tools live in
`pipeline/library/`.

| Table | Holds |
|---|---|
| `categories` | name, slug, kind (trip, series, project, topic, kept, Featured), **description**, why it exists, who made it, created, retired |
| `labels` | per post: topics, subjects, gist, kind, substance, evergreen, model, when |
| `filings` | per post: the categories the Librarian last wrote, Featured, the alt it filled, and whether Jamie set it by hand (what compare-and-set reads) |
| `events` | every write: when, which post or category, before, after, which run |
| `suggestions` | opened, text, status, closed |
| `reader_paths` | each Tinylytics path and the source id it belongs to (old Weekly Thing slugs included) |
| `reader_days` | per source, day and measure (views, email opens, feed reads): a count |
| `reader_months` | the same by month, for history before the daily rows begin |
| `kudos` | per source: each kudo and its date |

**Seeded from the overhaul**, so nothing already filed is classified again:
labels for 10,469 posts, the 125 categories and 56 trips, and filings from
what the write-back actually wrote (4,786 + 4,672 `ok` rows), checked against
the live pull before the first write. The 7 shadowed posts (377970, 1074798,
1074800, 1074801, 1075452, 1076156, 1076174) are seeded as **Jamie-set** and
never touched; the 129 posts filed with no category keep their empty filing.
The overhaul's tools stay in `../www.thingelstad.com/scripts/categories/` as
the record of that run; the tools here are written fresh.

## Reader numbers from Tinylytics

| Site | Tracked since | What it counts |
|---|---|---|
| Blog (1521) | 2024-07-10 | views of each post and page; 57 kudos |
| Weekly Thing (3063) | 2026-01-09 | per issue: web views (`/archive/<n>/` and old slugs), email opens (WT Builder's pixel, `/email/<n>/`, since WT339), feed reads (`/feed/<n>/`); 7 kudos |
| Another Thing (3059) | 2026-01-05 | 444 views, nearly all the home page; 1 kudo |
| Things I've built (3823) | 2026-10-13 | 128 views, mostly the home page; kudos coming |

Thingy's site (3424) counts the chat, not content, and stays out. Blog: of
60,167 views in two years, 34,061 land on 6,607 posts and pages matched by
URL; the rest is the home page, list and archive pages, and pages still to
match. Weekly Thing: 328 issues have web views, 14 have email opens, 91 have
feed reads (WT350: 1,190 opens, 351 web views, 41 feed reads).

**Bucketed by time.** Daily counts per source from the first run on, monthly
before that (the blog back to July 2024). Each morning one Tinylytics call per
site adds yesterday (10-21 was 171 blog views on 64 paths). The
first fill is monthly calls back to when each site began plus daily calls for
the last 90 days. Kudos come with their date. Email opens are per issue,
never per recipient.

**What Thingy gets.** At the end of each round the agent exports
`reader/reader.json` to the same bucket. For each post, page, issue, episode
and thing it holds views by month since tracking began, views by day for the
last 90 days, kudos with their dates, email opens and feed reads for issues,
and when tracking began. A 2009 post's count is views since July 2024, never
all time. The Lambda reads that one file next to the corpus and checks for a
new copy at most hourly, so the morning's numbers show without a deploy. Its
read policy gains that one key, not `library.db`.

- **Trending:** Thingy reads the series and can say whether something is
  rising or falling. `list_content` sorts by most read in a window (30 days, a
  year, all tracked time), by most kudos, and by the biggest change between
  the last 30 days and the 30 before.
- **`get_source`** carries the numbers. Search ranking does not change:
  popularity is not relevance.
- **Private:** never committed and never in chunk text. Thingy and the MCP use
  the numbers to answer, counts included. If Jamie would rather Thingy speak
  to readers in ranks and direction without exact counts, that is one switch.
- The fields are additive (a minor MCP version, no `/retrieve` major).

The Library Agent uses them for Featured and in its suggestions: an old post
drawing readers this week, kudos that arrived, an issue whose opens stand
out.

## The Library Agent, and the team around it

The Library Agent keeps the collection: everything that is in the library, how
it is filed, and how it is described. Its question: is everything in the
library current, correct, filed and described?

It **replaces Keep the Archive True** (approved) and takes **photo
descriptions and summaries** from Run the Librarian (step 8 of
`run-librarian.md`). The team stays three:

| Owner | When | Owns |
|---|---|---|
| **Library Agent** | daily, 5:00 a.m. | the archive data and its ingest, corpus and graph freshness, photo descriptions, summaries, the catalog and reader numbers, and on the blog: categories, their descriptions, Featured and alt text |
| **Run the Librarian** | daily, 5:15 a.m. | the API, MCP surface, deploys, alarms, cost (unchanged, minus step 8) |
| **Improve Thingy** | every three days, 6:00 a.m. | Thingy's answers (unchanged) |

It takes Keep the Archive True's 5:00 slot without the three-day guard, on
`gpt-5.6-terra` at high effort. The checkout lease is shared, so on mornings
the Library Agent is still writing at 5:15, Run the Librarian runs read-only
and checks the deploy the Library Agent just pushed.

**Who decides what.** The agent judges; the tools do the repeatable work.
`make blog-round` (`pipeline/blog/round/`) reads micro.blog, proposes
categories for new posts with the overhaul's labeller (Opus 5.5, its schema and
mapping), drafts alt with the June backfill's vision call (Sonnet 5.5), and
carries every guard below in code, on the Librarian's own Anthropic key. The
agent reads the proposals against the posts (a normal day is zero to six),
makes the calls that need judgment (a new category and its description, a post
someone else changed, Featured), writes with `ARGS=--write`, checks the live
pages and reports.

## The daily round

1. **Sync.** Read every post and page from micro.blog (21 `q=source` pages)
   and rewrite the `data/blog/` files whose rendered text changed; podcast as
   today. The GitHub workflow uses the same refresh and moves from Mondays to
   a daily backstop at 12:17 UTC (7:17 a.m. CDT, 6:17 a.m. CST).
2. **The archive checks** Keep the Archive True runs today: new issues match
   WT Builder's archive-leg receipts, the corpora and graph match their data,
   the graph push happened, tests are green, content shape holds.
3. **Describe new photos** (Haiku 5.5) and **write summaries** for new or
   changed posts (Sonnet 5.5).
4. **Reader numbers:** yesterday's counts and new kudos into `library.db`.
5. **File categories** on new posts, creating a category (with its
   description) when the archive calls for one.
6. **Fill alt** on any post with an empty one.
7. **Featured:** note candidates daily; decide on Sundays.
8. **Close out.** Read each written post's live page, upload `library.db`,
   export `reader.json`, and commit only what changed in `data/` (the blog
   refresh, the photo and summary sidecars). A push runs `deploy.yml` once
   through the corpus gate; a day with no content change makes no commit and
   no deploy. Content can change on a Friday or Saturday now, so `deploy.yml`'s
   note that nothing automatic changes the corpus from Friday until the send
   is rewritten.
9. **Report**, then suggestions.

## How Jamie hears from it

No issues and no inbox to tend. Each run ends in the Codex app with the
team's report block, then **Suggestions** (an illustrative morning; the names
are made up):

```text
Outcome: CHANGED
Objective: Library Agent
Evidence: 4 posts filed, 3 alts filled, Lisbon 2026 created with its description
Action: 7 category writes, 3 alt edits, verified live
Next check: tomorrow 5:00 a.m.
Jamie: None

Suggestions
- "Home Automation" could fold into "Smart Home"; the old page would 404.
- Board games keep coming up since 2023 with nowhere to go; worth a category if it continues.
- A 2014 smoker post is climbing: 140 views this week against about 10 a week before.
- 5918023 (2021-11-19) is a backdated POAP Claims post the old sync never saw.
```

- **Told after:** new categories, Featured changes, alt counts, posts it left
  alone because someone else had changed them.
- **Suggestions** are what it would like Jamie to decide or know, never a
  question it waits on: category changes it will not make itself because they
  move or remove pages (rename, merge, split, retire), and anything else about
  the content it noticed while working (a broken photo, a duplicate, a
  backdated post, a trip under way, what is climbing). It is not a typo or
  link hunt. A suggestion shows once when new; Sunday's run lists the ones
  still open; they are kept in `library.db`. To act on one, Jamie tells the
  Library Agent in Codex or does it on micro.blog. Nothing waits.
- **NEEDS JAMIE** only for the first Featured list, and for a forced rebuild
  if live pages stay stale after a re-file.
- **Run notes:** on a day it wrote to micro.blog,
  `AGENT-TEAM/notes/YYYY-MM-DD-library.md` lists each post with before and
  after. The `events` table is the full audit trail.

## Guards (in code, not just in the prompt)

- **Compare and set.** Before writing a post's categories, read them live. If
  they are not what `filings` says the Librarian last wrote, someone else
  changed them: write nothing, mark the post Jamie-set, adopt the live list
  and say so. The Librarian never argues with a hand edit.
- **The Weekly Thing category** is WT Builder's. The Librarian never adds or
  removes it.
- **Alt edits:** re-fetch right before the write, change only the empty alt
  attribute, confirm every other byte is unchanged, never turn an `<img>` into
  markdown.
- **Never:** create or delete a post, change a title, date, status or any
  text, delete a category, or bring back Book or Travel Log.
- **Names compare by slug** ("Pokémon" is `pokemon`), so a spelling never
  creates a twin.
- **Pace caps:** 50 category writes and 20 alt edits a day. They pace
  micro.blog's rebuilds (the 10-22 burst left half the pages stale), not
  judge content. Past either, the run stops with NEEDS JAMIE.
- **Off switch:** a `PAUSED` file in `pipeline/blog/round/`. `make blog-round`
  is a dry run unless given `--write`.

## Categories: judgment, not counts

The Library Agent creates a category when a visitor would be better served by
one: a trip someone would read start to finish, a subject Jamie keeps coming
back to, a series, a project on thingelstad.xyz. It decides by reading the
posts, not by counting them. The labels and the overhaul's trip runs are
evidence it reads, not rules it applies. A re-file of older posts into a new
category goes at the pace caps.

- **Every category has a description**: a sentence or two in plain words
  telling a visitor what they will find there. The agent writes one for each
  new category and drafts the rest of the 125, keeping any intro Jamie already
  wrote (it reads each live category page first).
- **Names:** Title Case, short, no "/" ("&" is fine), never a near-twin.
  **Order on a post:** trip, series, project, topics, kept; Featured last.
- **Renames, merges, splits and retirements** are suggestions, never its own
  move, because they move or remove pages.

**Descriptions reach micro.blog by hand.** Without an API for the Intro, the
first full set is applied once, in a session on the Mac with Claude in Chrome,
on Jamie's go. After that a new or changed description appears in the report
for Jamie to paste. Asking Manton for Intro in the API would let the agent do
it itself.

## Collections become categories

Jamie's idea, and the data supports it: the collection pages are hand-kept
lists of posts, and categories now do that job on their own.

| Collection pages | Becomes |
|---|---|
| 27 trips and series (Iceland, Yellowstone 2020, Pi Day, Morgan Remodel, …) | their own category, already filed |
| Minnebar, TeamSPS Events, Crypto, Best of … | Minnestar, TeamSPS, Crypto, Featured |
| Wordle Games and its ten pages | stay pages (they hold the games, not posts), linked from Lists |
| `/collections/` | `/categories/` |

Each collection page's own words become its category's description, then the
page becomes a redirect to the category (a micro.blog page whose body is only a
URL redirects), so old links and search results keep working. A trip reads
start to finish, so the theme step checks that trip category pages list oldest
first, as the collection pages do. The nav's Collections link becomes
Categories. This is a one-time set of page edits on micro.blog with its own
approval line, not daily work; the Librarian's ingest drops the redirected
pages from the corpus.

## Featured

What Featured drives: the blog's `/categories/featured/` page, the Featured
section of `llms.txt` (newest 25), and each archive year's photo tile.

Featured is the shelf a new visitor starts from: the posts that best show who
Jamie is and what the blog is, across all the years, not only the recent ones.
No target count and no quota per year; small enough to browse. The agent
picks by reading, with evidence:

- **Jamie's own signals first:** a post Jamie linked back to later, a Notable,
  kudos, a Best of … link.
- **Readers':** views and their trend, discounting the search-only traffic
  that floats Big Green Egg and Peppa Pig.
- **The labels:** substance and evergreen.
- **Never:** link posts, photo-only microposts, POAP claims, imported tweets,
  anything time-bound, or a post Jamie took off Featured (the `events` table
  remembers).

The first selection goes to Jamie as a list before anything is written,
because it changes year tiles at once. After that the agent considers each new
post a week after it goes up, looks over the whole shelf each quarter, and
reports changes. Today's three stay.

## Alt text

- Fill empty alt only. Any alt Jamie wrote stays, even a short one.
- The writer is `alt_text.generate_alt`, the one-line vision call with post
  context that did the June backfill (moved to Sonnet 5.5). The vision
  description sidecar is context, not the alt.
- **Catch-up:** the 50 empty since July, then the older ones that can still be
  fetched, at the pace cap. The 158 dead 2017 uploads and the ones marked
  unfillable stay as they are.
- From then on, daily, on every new post.

## Doc and code updates (with the build)

- `AGENT-TEAM/README.md`: the team table, the routing rules, label
  `objective:library` for `objective:archive`.
- `AGENT-TEAM/library-agent.md` replaces `keep-archive-true.md`;
  `run-librarian.md` loses step 8; `WORKFLOW.md`'s report gains Suggestions.
- `AGENT-TEAM/scripts/objective_lease.py`: objective `library` for `archive`;
  `tests/test_agent_team_objectives.py` pins it.
- `AGENT-TEAM/automations.toml` and `SCHEDULE.md`: `library-agent` daily at
  5:00, rendered by `projects-sysadmin/scripts/render_automation_schedules.py`;
  in the Codex app, Keep the Archive True is removed and the Library Agent
  installed.
- `pipeline/library/`: `library.db` schema, download and conditional upload,
  the seed from the overhaul, the Tinylytics reader, the `reader.json` export.
- The Lambda: reads `reader/reader.json` (one key added to its read policy in
  `cloudformation.yaml`); `get_source` and `list_content` show and sort by it;
  tests and the MCP reference (`mcp-surface.json`, `/connect/reference/`).
- `AGENTS.md` (this repo): the Library Agent keeps the blog's categories,
  descriptions and alt text on micro.blog; `library.db` is the catalog. The
  micro.blog key here writes metadata only.
- `ALIGNMENT.md`: a boundary row (blog categories and alt: the Librarian
  decides, micro.blog keeps).
- `docs/featured-posts.md`: rewritten. New `docs/blog-categories.md`: how the
  agent decides, names, descriptions.
- `../AGENTS.md` (thingelstad.com): "the blog's categories and alt text are
  the Librarian's; micro.blog keeps them".
- `../www.thingelstad.com/AGENTS.md`: the categories scripts are the
  overhaul's record; collections retired into categories.

## Build order

Each step is its own commit; tests with each.

1. **Refresh sync** (no micro.blog write): compare-every-post ingest, daily
   workflow, then one full refresh commit. Deploys through the corpus gate.
2. **The catalog:** `library.db` built, seeded from the overhaul, checked
   against the live pull (expect exactly the 7 Jamie-set posts to differ), and
   in S3.
3. **Reader numbers:** Tinylytics history and daily counts into `library.db`,
   `reader.json`, and the Lambda reading it (a stack deploy).
4. **`make blog-round` in dry run**, then the Library Agent replaces Keep the
   Archive True in the team and the Codex app. Its archive work runs as Keep
   the Archive True's does today; its blog writes stay dry for one morning,
   and Jamie reads that report.
5. **Writes on:** categories and alt daily; the alt catch-up at the pace cap.
6. **Descriptions:** drafted for all 125 categories, applied once on
   micro.blog on Jamie's go.
7. **Collections into categories:** the page redirects and the nav, on
   Jamie's go.
8. **Featured:** the first list to Jamie; written on Jamie's go.
9. **Docs.**

**Cost.** The overhaul labelled 10,469 posts for about $19 at batch prices. A
day's handful at full price is a few cents; alt is one vision call a photo;
the 125 descriptions and the first Featured selection are a few dollars once.
Tinylytics reads and the S3 files cost nothing worth counting. Under $5 a
month in the usual run, plus the Codex run itself.

## Decisions for Jamie

1. **Collections:** the swap above, with Wordle Games staying pages linked
   from Lists. Recommended.
2. **Descriptions on micro.blog:** the first set applied once with Claude in
   Chrome, then pasted from the report, and Manton asked for an API.
   Recommended, unless Jamie knows a way to set Intro from the API.
3. **Exact counts in Thingy's answers** to readers, or only ranks and
   direction? The plan uses counts (the reading of "private in the corpus").
