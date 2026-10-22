# Plan: the Library and the Library Agent (2026-10-22)

**Status: proposed, waiting for Jamie's go.** Nothing is built and nothing has
been written to micro.blog. Every number below was measured read-only on
2026-10-22 (a full Micropub `q=source` pull, the Tinylytics API with the
read-only key, the Anthropic Models API, the overhaul's cache in
`../www.thingelstad.com/dev/cache/categories/`, the weekly.thingelstad.com and
WT Builder checkouts, and the Librarian's S3 bucket, lifecycle and CI policy).

This is v6. v5 kept published text in git, the catalog in SQLite and reader
numbers in a third file. Jamie: "I'm not confident in our plan on how this data
is being managed and what is going in git versus s3 versus sqlite. It seems
very scattered." So v6 starts with one rule for where data lives (Part 1), and
the agent that keeps the blog's categories and alt text is built on it
(Part 2).

## What Jamie decided

- "The Librarian decides; micro.blog keeps them and stays the source of
  authority for the blog." It owns the blog's **categories** ("I never
  actually assign categories to a post"; "It could create new categories") and
  its **alt text** ("It should own that. The librarian is my partner for
  this."). The **Weekly Thing** category stays WT Builder's.
- Daily, on its own model key. Typos, links and GitHub issues are cut: "Focus
  only on the alt text and category management."
- A **Library Agent** replaces Keep the Archive True. **Featured stays.**
  **Every run ends with suggestions.** It "should not care about weekly thing
  issues", and WT Builder picks up its blog edits when it scans.
- **Reader numbers** become "additional metadata to augment on posts",
  bucketed in time "so Thingy can know if something is trending up or down",
  private and not in the repo. Kudos are coming to Things I've built.
- **Judgment, not counts:** "an agent looking at the content and trying to
  deliver the right experience for visitors."
- **Categories carry a description**, and **collections fold into
  categories**.
- **Where the data lives:** "it seems odd to have the blog posts in git". WT
  Builder publishes to Buttondown, its own S3 bucket and weekly.thingelstad.com,
  and "the copy sent to library is yet a 4th copy and a distinct publish… that
  could easily be switched to pulling from the copy in weekly.thingelstad.com".
  "The content versions are a problem the SOURCES should handle, not the
  library." Any run can start "uncached" in a GitHub Action, downloading from
  S3. On SQLite: "It feels like having a database for that would make corpus
  wide analysis easier, but maybe not?" (answered below: yes).

# Part 1: The library

## The rule

- **Sources keep the content and its history.** micro.blog (the blog and its
  pages), weekly.thingelstad.com (Weekly Thing issues as WT Builder sends
  them), another.thingelstad.com (episodes), thingelstad.xyz (Things I've
  built), Tinylytics (reader numbers). Content is edited there and only there.
- **The library is one SQLite file**, `library.db`, in the Librarian's private
  S3 bucket: a copy of what every source published, plus everything the
  Librarian makes or measures about it.
- **The corpus is built from the library**, and only from it. Thingy and the
  MCP answer from the corpus.
- **librarian-thing in git is code, tests and docs.** No content.

```text
micro.blog ──┐
weekly ──────┤                      ┌─> corpora, graph, embeddings ─> Thingy, MCP
another ─────┼─> pull ─> library.db ┤
xyz ─────────┤        (S3, private) └─> Library Agent ─> categories, alt ─> micro.blog
Tinylytics ──┘
```

## What changes

| Today | After |
|---|---|
| `data/blog/`: 10,585 files in git, synced Mondays, new posts only, so the 9,422 posts re-filed in the overhaul never arrive | pulled from micro.blog every morning, every post compared |
| `data/issues/`: 1,075 files, the fourth copy WT Builder commits after each send | pulled from weekly.thingelstad.com's `apps/site/archive/<n>.md` |
| `data/podcast/`, `data/things/`, `data/site/` | pulled from another.thingelstad.com, thingelstad.xyz, and weekly's about and support pages |
| `data/librarian/`: 12,278 photo descriptions and the blog summaries, committed | tables in the library |
| the catalog and reader numbers (v5: SQLite plus `reader.json`) | tables in the library; reader numbers ride in the corpus |
| the corpus build reads git | reads the library: same corpora, same chunk ids, same gate |

## Facts, checked

- **WT Builder publishes three places:** Buttondown, the podcast audio and
  covers to its CDN bucket, and `apps/site/archive/<n>.md` on
  weekly.thingelstad.com. A fourth leg, "the archive feed" in
  `src/server/publish.ts`, commits the same issue to `data/issues/<n>/` here.
- **weekly has everything the library needs.** 351 of 353 issue bodies match
  the library's copy byte for byte. Its front matter is a superset (it adds the
  audio fields, layout, permalink and tags). `links.json` repeats the front
  matter's links, domains and word count; `metadata.json` repeats the rest.
- **They match because WT Builder made them match:** `rerender:archive`
  renders WT1 to WT349's pages on weekly from the library's copy, so the fall
  repairs are on weekly too. (I said earlier the repairs lived only here. That
  was wrong.)
- **The two that differ are WT Builder's first two sends.** WT350: the
  library's copy adds image width and height. WT351: the library's copy points
  five images at files.thingelstad.com, weekly's at micro.blog uploads, and
  weekly has a magazine image the library's lacks. weekly is the authority
  (Jamie, 10-01), so the library takes weekly's; WT351's five photos are
  described again (cents).
- **Nothing else in WT Builder reads the library's copy.** linked-before reads
  WT Builder's own records. (I said otherwise earlier. Also wrong.)
- **The corpus build already reads weekly:** `deploy.yml` checks out weekly's
  archive pages for the audio fields.

## library.db

`s3://weekly-thing-librarian/artifacts/library.db`, about 90 MB. The bucket
blocks public access, is encrypted and versioned, and its existing rule
`expire-replaced-corpus-builds` keeps a replaced copy under `artifacts/` for 30
days. One current copy, and 30 days to undo a bad round. That window is for
recovery, not history: history is the sources' job.

| | Table | Holds |
|---|---|---|
| **Pulled** | `sources` | one row per post, page, issue, episode, thing and site page: its id (`blog-<id>`, `wt-<n>`, `page-<id>`, `ep-<n>`, `thing-<id>`), kind, URL, title, dates, the body and properties as the source has them, a hash, and when it was pulled |
| | `media` | each image in a source, with its alt as published |
| **Made** | `descriptions` | the vision description of each image |
| | `summaries` | each blog post's abstract, keyed by body hash |
| | `categories` | name, slug, kind (trip, series, project, topic, kept, Featured), **description**, why it exists, who made it, created, retired |
| | `labels` | per post: topics, subjects, gist, kind, substance, evergreen, model, when |
| | `filings` | per post: the categories the Librarian last wrote, Featured, the alt it filled, and whether Jamie set it by hand |
| | `events` | every write to micro.blog: when, which post or category, before, after, which run |
| | `suggestions` | opened, text, status, closed |
| **Measured** | `reader_paths` | each Tinylytics path and the source it belongs to (old Weekly Thing slugs included) |
| | `reader_days`, `reader_months` | per source, day or month, and measure (views, email opens, feed reads): a count |
| | `kudos` | per source: each kudo and its date |

A pull replaces a source's row in place; there is no revisions table. The
made and measured tables exist nowhere else, which is what the 30 days of
copies protect. The Recovery Manager's Saturday restore check should open the
newest copy and check its counts (a projects-sysadmin change).

**Seeded from the overhaul**, so nothing already filed is classified again:
labels for 10,469 posts, the 125 categories and 56 trips, and filings from what
the write-back actually wrote (4,786 + 4,672 `ok` rows), checked against the
live pull. The 7 shadowed posts (377970, 1074798, 1074800, 1074801, 1075452,
1076156, 1076174) are seeded as **Jamie-set** and never touched; the 129 posts
filed with no category keep their empty filing.

## Why SQLite

Jamie asked whether it is a good idea. It is, for this:

- **One file, one writer, about 90 MB.** It downloads in seconds, needs no
  server, and costs nothing to keep.
- **Questions across the whole archive become a query:** posts per category per
  year, kudos by category, photos still without alt, which issues linked a
  post, what is climbing this month. Today each is a script over 10,000 files.
- **Easy to look inside:** `sqlite3` or Datasette on the Mac, and DuckDB reads
  the same file for heavier analysis. Python has it built in.

What it costs:

- The whole file moves every run. Fine at 90 MB; it would not be at 10 GB.
- One writer at a time. The conditional upload below makes a second writer
  fail instead of overwrite.
- Changes are no longer readable as git diffs. The `events` table records
  every write the agent makes, and each source keeps its own history.
- About 20 Python files and 5 test files read `data/` today, most through
  `librarian_core/paths.py`. They move to one small library reader in one step.

Not chosen: JSON files in S3 (no queries), Postgres on RDS (a server for one
writer), DynamoDB (poor at the analysis). The corpus the Lambda reads stays
JSON; serving it from SQLite is a separate question for later.

## How a run uses it

Every run, wherever it runs:

1. Download `library.db` and note its ETag.
2. Pull the sources and do its work on the local copy.
3. Upload only if S3 still holds the copy it downloaded (a conditional write
   on the ETag). If another run got there first, download again and redo the
   round. That is safe because every pull and every micro.blog write is
   compare-and-set.

So no machine keeps state worth losing. The Library Agent runs the round on
the Mac each morning. The same round runs "uncached" in a GitHub Action from
nothing but the S3 copy. `make library ARGS=--from-sources` rebuilds the
pulled tables from the sources into a fresh file and keeps the made and
measured ones.

- **GitHub:** `sync-external-content.yml` becomes the GitHub round: a daily
  pull at 12:17 UTC as a backstop for a morning the Mac missed, and a full
  round on demand. The pull uses the micro.blog secrets already there. A full
  round (describing photos, Tinylytics) needs the Anthropic and Tinylytics keys
  added as repository secrets, by Jamie.
- **CI's access:** `WeeklyThingLibrarianDeployScoped` allows S3 key by key and
  cannot read the library yet. It needs `artifacts/library.db` (get and put).
  That policy is not in a stack, so this is an IAM edit outside a deploy and
  waits for Jamie's go.

## Building the corpus from it

- `deploy.yml` downloads the library, builds the corpora and graph from it, and
  runs the corpus gate as today. Embeddings stay cached by chunk id, and a
  chunk id does not depend on where its text was read, so the move re-embeds
  nothing.
- Reader numbers ride in the corpus as metadata on each source (Part 2). No
  separate reader file, and the Lambda's read policy does not change.
- **What starts a build:** the Library Agent at the end of a round that
  changed the library, WT Builder after a send, the daily schedule as a
  backstop, and code pushes as today. The rule that nothing automatic changes
  the corpus from Friday until the send stays: on those days the round updates
  the library and the build waits.
- The graph push to weekly's topic pages is unchanged.

## WT Builder after the switch

A WT Builder pull request, under its two-tier workflow.

- **The archive leg stops sending text.** It starts the Librarian's build for
  issue N instead, which pulls the issue from weekly, and keeps its receipt so
  the Library Agent can check that every sent issue arrived. (The alternative
  is dropping the leg; a send then reaches Thingy the next morning.)
- **`rerender:archive` retires.** A back-catalogue repair becomes an edit to
  the page on weekly, through the same `editTree` path the audio backfill
  uses, and the library pulls it. `pipeline/audits/` points at weekly's pages.
- This repo's AGENTS.md loses "`data/issues/` is written by WT Builder", and
  WT Builder's `docs/decisions.md` records the change.

## The switch, checked before it ships

Build today's corpora twice, from git and from the library, and compare them
chunk by chunk. Only these differences are expected: 9,422 posts' categories,
38 changed bodies (WT Builder's link and alt write-backs, whitespace, the three
shared-address posts), post 5918023 (a backdated POAP Claims post the old sync
never saw), WT350's image attributes and WT351's images. Anything else stops
the switch. Then `data/` leaves git in one commit (history keeps it), and the
first deploy from the library is when Thingy sees the new categories.

# Part 2: The Library Agent

## Reader numbers from Tinylytics

| Site | Tracked since | What it counts |
|---|---|---|
| Blog (1521) | 2024-07-10 | views of each post and page; 57 kudos on 45 posts |
| Weekly Thing (3063) | 2026-01-09 | per issue: web views (`/archive/<n>/` and old slugs), email opens (`/email/<n>/`, since WT339), feed reads (`/feed/<n>/`); 7 kudos |
| Another Thing (3059) | 2026-01-05 | 444 views, nearly all the home page; 1 kudo |
| Things I've built (3823) | 2026-10-13 | 128 views, mostly the home page; kudos coming |

Thingy's site (3424) counts the chat, not content, and stays out. Blog: of
60,167 views in two years, 34,061 land on 6,607 posts and pages matched by
URL. Weekly Thing: 328 issues have web views, 14 have email opens, 91 have
feed reads.

- **Bucketed by time:** daily counts per source from the first run on, monthly
  before that (the blog back to July 2024). Each round adds yesterday with one
  Tinylytics call per site. Email opens are per issue, never per recipient.
- **In the corpus:** each source carries views by month since tracking began,
  views by day for the last 90 days, kudos with their dates, email opens and
  feed reads for issues, and when tracking began. A 2009 post's count is views
  since July 2024, never all time. Never in chunk text.
- **What Thingy does with it:** says whether something is rising or falling;
  `list_content` sorts by most read in a window, by kudos, and by the biggest
  change between the last 30 days and the 30 before; `get_source` shows the
  numbers. Search ranking does not change: popularity is not relevance. An
  additive MCP minor version.

## The Library Agent, and the team around it

It keeps the collection: everything in the library, how it is filed, and how it
is described. Its question: is everything current, correct, filed and
described? It **replaces Keep the Archive True** and takes photo descriptions
and summaries from Run the Librarian (step 8 of `run-librarian.md`). The team
stays three:

| Owner | When | Owns |
|---|---|---|
| **Library Agent** | daily, 5:00 a.m. | the library and its pulls, corpus and graph freshness, photo descriptions, summaries, reader numbers, and on the blog: categories, their descriptions, Featured and alt text |
| **Run the Librarian** | daily, 5:15 a.m. | the API, MCP surface, deploys, alarms, cost (unchanged, minus step 8) |
| **Improve Thingy** | every three days, 6:00 a.m. | Thingy's answers (unchanged) |

It runs on `gpt-5.6-terra` at high effort in Keep the Archive True's slot. The
agent judges; the tools do the repeatable work. `make blog-round`
(`pipeline/blog/round/`) proposes categories for new posts with the overhaul's
labeller (Opus 5.5), drafts alt with the June backfill's vision call (Sonnet
5.5), and carries every guard below in code, on the Librarian's own Anthropic
key. The agent reads the proposals against the posts, makes the calls that
need judgment (a new category and its description, a post someone else
changed, Featured), writes with `ARGS=--write`, checks the live pages and
reports. `anthropic_client.py`'s `sonnet` and `opus` move to the 5.5 models
(they map to `claude-sonnet-5` and `claude-opus-4-7` today).

## The daily round

1. **Pull** every source into the library (micro.blog is 21 `q=source` pages).
2. **Check** what Keep the Archive True checks today: every sent issue
   arrived, the corpora and graph match the library, the graph push happened,
   tests are green.
3. **Describe** new photos (Haiku 5.5) and **summarise** new or changed posts
   (Sonnet 5.5).
4. **Reader numbers:** yesterday's counts and new kudos.
5. **File categories** on new posts, creating a category (with its
   description) when the archive calls for one.
6. **Fill alt** on any post with an empty one.
7. **Featured:** note candidates daily; decide on Sundays.
8. **Close out:** read each written post's live page, upload the library, and
   start the corpus build if the library changed (not Friday or Saturday
   before the send). No commit.
9. **Report**, then suggestions.

## How Jamie hears from it

No issues and no inbox. Each run ends in the Codex app with the team's report
block, then **Suggestions** (an illustrative morning; the names are made up):

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
```

- **Told after:** new categories, Featured changes, alt counts, posts it left
  alone because someone else had changed them.
- **Suggestions** are what it would like Jamie to decide or know, never a
  question it waits on: renames, merges, splits and retirements (they move or
  remove pages), and anything about the content it noticed (a broken photo, a
  duplicate, a backdated post, a trip under way, what is climbing). Not a typo
  or link hunt. A suggestion shows once when new; Sunday lists the open ones.
  Jamie acts on one by telling the agent in Codex or on micro.blog.
- **NEEDS JAMIE** only for the first Featured list, and a forced rebuild if
  live pages stay stale after a re-file.
- The `events` table is the audit trail; there are no run-note commits.

## Guards (in code, not just the prompt)

- **Compare and set.** Read a post's categories live before writing. If they
  are not what `filings` says the Librarian last wrote, someone else changed
  them: write nothing, mark the post Jamie-set, adopt the live list, say so.
- **The Weekly Thing category** is WT Builder's; never added or removed.
- **Alt edits:** re-fetch right before the write, change only the empty alt
  attribute, confirm every other byte is unchanged, never turn an `<img>` into
  markdown.
- **Never:** create or delete a post, change a title, date, status or any
  text, delete a category, or bring back Book or Travel Log.
- **Names compare by slug** ("Pokémon" is `pokemon`), so a spelling never makes
  a twin.
- **Pace caps:** 50 category writes and 20 alt edits a day, to pace
  micro.blog's rebuilds (the 10-22 burst left half the pages stale). Past
  either, the run stops with NEEDS JAMIE.
- **Off switch:** a `PAUSED` file in `pipeline/blog/round/`. `make blog-round`
  is a dry run unless given `--write`.

## Categories: judgment, not counts

The agent creates a category when a visitor would be better served by one: a
trip someone would read start to finish, a subject Jamie keeps coming back to,
a series, a project on thingelstad.xyz. It decides by reading the posts; the
labels and trip runs are evidence, not rules.

- **Every category has a description:** a sentence or two telling a visitor
  what they will find. It writes one for each new category and drafts the rest
  of the 125, keeping any intro Jamie already wrote.
- **Names:** Title Case, short, no "/" ("&" is fine), never a near-twin.
  **Order on a post:** trip, series, project, topics, kept; Featured last.

**Descriptions reach micro.blog by hand.** A category's description is
micro.blog's **Intro** field, set in the web editor (Manton, 2025-08-11,
"Category improvements"); no API for it turned up, and thing-hugo already
renders it on the category page. The first full set is applied once from the
Mac with Claude in Chrome, on Jamie's go; after that a new description appears
in the report for Jamie to paste. Asking Manton for Intro in the API would let
the agent do it.

## Collections become categories

| Collection pages (43, linking 624 posts) | Becomes |
|---|---|
| 27 trips and series (Iceland, Yellowstone 2020, Pi Day, Morgan Remodel, …) | their own category, already filed |
| Minnebar, TeamSPS Events, Crypto, Best of … | Minnestar, TeamSPS, Crypto, Featured |
| Wordle Games and its ten pages | stay pages (they hold the games), linked from Lists |
| `/collections/` | `/categories/` |

Each collection page's words become its category's description, then the page
becomes a redirect to the category (a micro.blog page whose body is only a URL
redirects), so old links keep working. Trip category pages list oldest first,
as the collection pages do. The nav's Collections link becomes Categories. A
one-time set of page edits with its own approval line.

## Featured

Featured drives `/categories/featured/`, the Featured section of `llms.txt`
and each archive year's photo tile. It is the shelf a new visitor starts from:
the posts that best show who Jamie is, across all the years. No target count.
The agent picks by reading, with evidence: Jamie's own signals first (a post
Jamie linked back to, a Notable, kudos, a Best of … link), then readers'
(views and their trend, discounting search-only traffic like the 2009 Big
Green Egg and Peppa Pig posts), then the labels (substance, evergreen). Never
link posts, photo-only microposts, POAP claims, imported tweets, anything
time-bound, or a post Jamie took off Featured. The first selection goes to
Jamie as a list before anything is written; after that each new post is
considered a week after it goes up and the shelf reviewed each quarter. The
three there today stay.

## Alt text

- Fill empty alt only; any alt Jamie wrote stays, even a short one.
- The writer is `alt_text.generate_alt`, the vision call with post context
  that did the June backfill, moved to Sonnet 5.5. The photo description is
  context, not the alt.
- **Catch-up:** the 50 empty since July (46 already described), then older
  ones that can still be fetched, at the pace cap. The 158 dead 2017 uploads
  and those marked unfillable in June stay as they are.

## Doc and code updates

- `pipeline/library/`: the schema, the pulls, download and conditional upload,
  the seed, the Tinylytics reader, `--from-sources`.
- `librarian_core/paths.py` and the readers of `data/` move to the library;
  tests use a small fixture library built from a handful of sources.
- `deploy.yml` and `sync-external-content.yml` as above; `data/` removed.
- The Lambda: `get_source` and `list_content` show and sort by reader numbers;
  tests and the MCP reference (`mcp-surface.json`, `/connect/reference/`).
- WT Builder: the archive leg, `rerender:archive`, `docs/decisions.md`.
- `AGENT-TEAM/`: `library-agent.md` replaces `keep-archive-true.md`;
  `run-librarian.md` loses step 8; the README team table and routing;
  `objective_lease.py` and its test (`library` for `archive`);
  `automations.toml` and `SCHEDULE.md` (rendered by projects-sysadmin); in the
  Codex app, Keep the Archive True is removed and the Library Agent installed.
- `AGENTS.md`, `ALIGNMENT.md`, `README.md` here; `../AGENTS.md`; the
  `../www.thingelstad.com/AGENTS.md` note that collections retired;
  `docs/featured-posts.md` rewritten; a new `docs/blog-categories.md`.

## Build order

Each step is its own commit, with tests.

1. **The library:** schema, pulls from every source, descriptions and
   summaries imported, the catalog seeded, uploaded to S3. Nothing reads it
   yet.
2. **The switch:** CI's policy gains `artifacts/library.db`; the corpus built
   from the library and checked against the build from git; `deploy.yml` and
   the GitHub round; the WT Builder pull request; `data/` leaves git. Deploys
   through the corpus gate, and Thingy sees the new categories.
3. **Reader numbers:** Tinylytics history and daily counts, carried in the
   corpus, shown and sorted by Thingy and the MCP (a stack deploy).
4. **`make blog-round` in dry run,** and the Library Agent replaces Keep the
   Archive True. Its blog writes stay dry for one morning; Jamie reads that
   report.
5. **Writes on:** categories and alt daily; the alt catch-up at the pace cap.
6. **Descriptions** drafted for all 125 categories, applied on Jamie's go.
7. **Collections into categories,** on Jamie's go.
8. **Featured:** the first list to Jamie, written on Jamie's go.
9. **Docs.**

**Cost.** The overhaul labelled 10,469 posts for about $19 at batch prices. A
day's handful is a few cents; the 125 descriptions and the first Featured list
are a few dollars once. A month of 90 MB copies in S3 is about six cents.
Under $5 a month, plus the Codex run.

## Decisions for Jamie

1. **Collections:** the swap above. Recommended.
2. **Descriptions:** applied once with Claude in Chrome, then pasted from the
   report, and Manton asked for an API. Recommended.
3. **Exact counts in Thingy's answers** to readers, or only ranks and
   direction? The plan uses counts.
4. **WT Builder's archive leg:** becomes the nudge that starts the build
   (recommended), or goes, and a send reaches Thingy the next morning.
5. **Repository secrets** (Anthropic, Tinylytics) for a full round from
   GitHub. Not needed to build; the pull and the corpus build need none.
