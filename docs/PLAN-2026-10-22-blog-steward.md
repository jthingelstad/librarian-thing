# Plan: the Library Agent (2026-10-22)

**Status: proposed, waiting for Jamie's go.** Nothing is built and nothing has
been written to micro.blog. Every number below was measured read-only on
2026-10-22 (a full Micropub `q=source` pull, the Tinylytics API with the
read-only key, the Anthropic Models API, and the overhaul's cache in
`../www.thingelstad.com/dev/cache/categories/`).

Jamie, 2026-10-22: "The Librarian decides; micro.blog keeps them and stays the
source of authority for the blog." The Librarian becomes the authority for the
blog's **categories** (Featured included, since Featured is a category) and
its **alt text**. micro.blog still holds every post; the Librarian never
creates, deletes, retitles or re-dates one, and never changes a word Jamie
wrote.

**Revised three times the same day.** First Jamie cut the scope: "Lets remove
typo/grammer checking and link additions from the goal. Focus only on the alt
text and category management. That removes the need for a feedback loop and I
didn't like the GitHub issues approach anyway." Then Jamie reframed the agent:
"yes featured should stay … I think a Library Agent is a better framing than
"tend the blog"… I also think it could change some of the other agent team… I
think the agent should end each run with any suggested category changes… or
any other content related items it wants to highlight. I do NOT think it
shoudl ignore posts that are waiting for a weekly thing issue… it should not
care about weekly thing issues." And: "WT Builder should automatically pick up
an edit/improvment to the blog post when it does it's scan on open." Last:
"we've lost anything from looking at Tinylytics data… I had hoped we would
bring that into the corpus too … that way view information and kudos become
additional metadata to augment on posts." This version is that plan.

## What Jamie decided

- "I never actually assign categories to a post." The Librarian owns the whole
  list. The one exception is **Weekly Thing**, which WT Builder sets.
- "It could create new categories." New trips and topics when the archive
  calls for them, telling Jamie after.
- **Featured stays**, chosen with Tinylytics' help ("The librarian could get
  an API key for tinylytics to assist with that too!").
- "Also agree on the alt text. It should own that. The librarian is my partner
  for this." Fill empty alt only; never replace alt Jamie wrote.
- "Agree it would move to daily. Yes to alt fills. Yes it should use its own
  model key."
- **A Library Agent**, and the agent team can change around it.
- **Every run ends with suggestions:** category changes and anything else
  about the content worth Jamie's eye.
- **Weekly Thing issues don't matter to it.** Every post is tended the same,
  whether or not an issue will carry it.
- **Reader numbers join the corpus:** Tinylytics views and kudos become
  metadata on every post, issue, episode and thing.
- Typo checking, link additions and a GitHub-issue channel are out.

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
never overwrites the Librarian's alt unseen. An alt filled on a post headed for
WT354 arrives in the issue already filled.

**Featured.** Three posts today, all 2026 (5863188, 5872650, 5904586). The
overhaul's labels give every post a substance score: 1 (2,373), 2 (5,641),
3 (2,112), 4 (325), 5 (18); 297 posts are 4+ and evergreen. Tinylytics (blog
site 1521): 60,167 views over two years on 10,473 paths, led by search
traffic to old posts (Big Green Egg 2009, Peppa Pig DVD 2009, Camelback 2021).
Kudos: 57 in all, on 45 posts. Views alone cannot pick Featured; kudos are too
few to lead. 3,897 posts are linked from a Weekly Thing issue, mostly as
Journal items, so one link means little and two or more means something.

**Keys.** `.env` has `ANTHROPIC_GENERAL_API_KEY`, `TINYLYTICS_API_KEY`
(read-only, `tly-ro-`) and `MICROBLOG_API_KEY`. `TINYLYTICS_SITE_UID` is the
Weekly Thing site's uid, not the blog's; the Librarian names the blog by its
id, 1521. `OPENAI_API_KEY` is not needed: the Codex agent runs on Jamie's
Codex account, not on an API key.

**Models** (live Models API, 2026-10-22): `claude-opus-5-5`,
`claude-sonnet-5-5`, `claude-haiku-5-5` and `claude-fable-5-1` are current.
`pipeline/blog/anthropic_client.py` still maps `sonnet` to `claude-sonnet-5`
and `opus` to `claude-opus-4-7`; both still answer but are a generation old.

## Reader numbers from Tinylytics

**What Tinylytics holds** (read-only key, measured 2026-10-22):

| Site | Tracked since | What it counts |
|---|---|---|
| Blog (1521) | 2024-07-10 | views of each post and page; 57 kudos, all on posts |
| Weekly Thing (3063) | 2026-01-09 | per issue: web views (`/archive/<n>/` and the old slugs), email opens (the pixel WT Builder puts in each email, `/email/<n>/`, since WT339), feed reads (`/feed/<n>/`); 7 kudos |
| Another Thing (3059) | 2026-01-05 | 444 views, nearly all the home page; 1 kudo, on an episode |
| Things I've built (3823) | 2026-10-13 | 128 views, mostly the home page |

Thingy's site (3424) counts the chat, not content, and stays out. Tinylytics
keeps crawlers out of hits.

- **Blog:** of 60,167 views in two years, 34,061 land on 6,607 posts and pages
  matched by URL. The rest is the home page (10,995), list, category and
  archive pages (9,158), and pages still to match (5,953: `/lists/…`,
  `/collections/…`, `/about/…`).
- **Weekly Thing:** 328 issues have web views, 14 have email opens, 91 have
  feed reads. WT350: 1,190 email opens, 351 web views, 41 feed reads.

**What the corpus gets.** A sidecar, `data/librarian/reader-stats.json`,
written by `pipeline/corpus/reader_stats.py` with the read-only key in the
local `.env` (CI reads the committed file and needs no new secret). Each
source record gains a `reader` block, display metadata like the blog
abstracts and never chunk text, so nothing re-embeds:

- every post, page, issue, episode and thing: `views`, `views_30d`, `kudos`
  (an issue's views are its web page's);
- each with its site's `tracked_since` and the refresh date, so a count never
  passes for an all-time number: a 2009 post's views are its views since July
  2024.

**The file is public.** librarian-thing is a public repository and the
sidecars are committed (the corpus itself is not), so whatever goes in
`reader-stats.json` is on GitHub. That is why **email opens and feed reads
stay out of it**: they are the newsletter's own numbers. The Library Agent
reads them from Tinylytics during its round and uses them in its report
without writing them down anywhere public. Putting them in Thingy too would
need a CI secret or a private store, and Jamie's word first.

**Where it shows.** `get_source` carries the block; `list_content` can sort by
most read and most kudos; Thingy reads both through its tools, so "my
most-read posts this year" or "which issues got kudos" has an answer. Search
ranking does not change: popularity is not relevance, and making it a ranking
signal would be its own decision. The fields are additive (a minor MCP
version, no `/retrieve` major).

**How the Library Agent uses it.** Refreshed in each morning's round and
committed with the day's work. It weighs Featured and feeds the suggestions:
an old post drawing readers this week, kudos that arrived, an issue whose
opens stand out.

## The Library Agent, and the team around it

The Library Agent keeps the collection: everything that is in the library, how
it is filed, and how it is described. Its question: *is everything in the
library current, correct, filed and described?*

It **replaces Keep the Archive True** (whose work is the collection already)
and takes **photo descriptions and summaries** from Run the Librarian (step 8
of `run-librarian.md`, content work in an infrastructure owner's run). The
team stays three, so the README's "Do not add more agents" stands:

| Owner | When | Owns |
|---|---|---|
| **Library Agent** | daily, 5:00 a.m. | the archive data and its ingest, corpus and graph freshness, photo descriptions, summaries and reader numbers, and on the blog: categories, Featured and alt text |
| **Run the Librarian** | daily, 5:15 a.m. | the API, MCP surface, deploys, alarms, cost (unchanged, minus step 8) |
| **Improve Thingy** | every three days, 6:00 a.m. | Thingy's answers (unchanged) |

The Library Agent takes Keep the Archive True's 5:00 slot and drops its
three-day date guard, on `gpt-5.6-terra` at high effort like the owner it
replaces. The checkout lease is shared, so on mornings the Library Agent is
still writing at 5:15, Run the Librarian runs read-only and checks the deploy
the Library Agent just pushed.

**Who decides what.** The agent judges; the repo's tools do the repeatable
work, so new posts are filed exactly the way the 9,459 already filed were:

- `make blog-round` (`pipeline/blog/round/`) reads micro.blog, proposes
  categories with the overhaul's labeller (Opus 5.5, its schema and mapping),
  writes alt with the June backfill's vision call (Sonnet 5.5), and carries
  every guard below in code. Those calls use the Librarian's own Anthropic key.
- The agent reads each day's proposals against the posts before anything is
  written (a normal day is zero to six posts), decides the calls that need
  judgment (a new category, a post someone else changed, Featured), writes
  with `make blog-round ARGS=--write`, checks the live pages, and reports.

## The daily round

1. **Sync.** Read every post and page from micro.blog (21 `q=source` pages)
   and rewrite the `data/blog/` files whose rendered text changed; podcast as
   today. The GitHub workflow uses the same refresh and moves from Mondays to
   a daily backstop at 12:17 UTC (7:17 a.m. CDT, 6:17 a.m. CST).
2. **The archive checks** Keep the Archive True runs today: new issues match
   WT Builder's archive-leg receipts, the corpora and graph match their data,
   the graph push happened, tests are green, content shape holds.
3. **Describe new photos** (`describe_media.py`, Haiku 5.5), **write
   summaries** for new or changed posts (`abstracts.py`, Sonnet 5.5), and
   **refresh reader numbers** from Tinylytics (`reader_stats.py`).
4. **File categories** on posts the Librarian has never filed.
5. **Fill alt** on any post with an empty one.
6. **Featured:** note candidates daily; decide on Sundays.
7. **Verify and close out.** Read each written post's live page (the
   categories in its footer), refresh those `data/blog/` files, make one
   commit (`data/blog/`, the sidecars, `data/blog-catalog/`), push. The push
   runs `deploy.yml` once, through the corpus gate (about 15 minutes, every
   embedding from the cache). That is Fridays and Saturdays too, so
   `deploy.yml`'s note that nothing automatic changes the corpus from Friday
   until the send stops being true and is rewritten.
8. **Report**, then suggestions (below).

## How Jamie hears from it

No issues and no inbox to tend. Each run ends in the Codex app with the
team's report block, then a **Suggestions** list (an illustrative morning;
the category names are made up):

```text
Outcome: CHANGED
Objective: Library Agent
Evidence: 4 posts filed, 3 alts filled, Lisbon 2026 created (10th post)
Action: 7 category writes, 3 alt edits, verified live
Next check: tomorrow 5:00 a.m.
Jamie: None

Suggestions
- "Home Automation" (9 posts) could merge into "Smart Home" (41); the old page would 404.
- 11 posts since 2023 about board games carry no topic; one more makes a category.
- A 2014 smoker post drew 140 views this week, most from search; a Featured candidate.
- 5918023 (2021-11-19) is a backdated POAP Claims post the old sync never saw.
```

- **Told after** (in Evidence and Action): new categories, Featured changes,
  alt counts, posts it left alone because someone else had changed them.
- **Suggestions** are what it would like Jamie to decide or know, never a
  question it waits on:
  - **Category changes it will not make itself**, because they move or remove
    pages: rename, merge, split or retire a category; a topic nearing the bar;
    a collection page that could become a category.
  - **Anything else about the content** it noticed while doing its work: a
    broken or missing photo, a post that looks duplicated or empty, a
    backdated post, a trip under way, a post it would feature next. It is not
    a typo or link hunt.
  - A suggestion shows once, when new. Sunday's run lists the ones still open.
    One goes away when Jamie acts on it, says no, or its reason is gone. They
    are kept in `data/blog-catalog/suggestions.jsonl`.
  - To act on one, Jamie tells the Library Agent in Codex (the README's "Run
    <objective> now" form works) or does it on micro.blog. Nothing waits.
- **NEEDS JAMIE** only for the first Featured list, and for a forced rebuild
  if live pages stay stale after a re-file.
- **Run notes:** on any day it wrote to micro.blog,
  `AGENT-TEAM/notes/YYYY-MM-DD-library.md` lists each post with before and
  after. A quiet day gets no note. The weekly rollup in `AGENT-TEAM/summaries/`
  carries a Library section.
- **The ledger in git** is the full audit trail.

## What moves into librarian-thing

The overhaul's tools stay in `../www.thingelstad.com/scripts/categories/` as
the record of the one-time run. The tools here are written fresh (the repo
rule: never copy code between repos), and the data becomes committed files in
`data/blog-catalog/`, the library's catalogue of the blog:

| File | From | Holds |
|---|---|---|
| `categories.json` | `taxonomy.json`, `trips.json`, `assign.py` | all 124 categories: name, slug, group (trip, series, project, topic, kept), rule, dates, who made it |
| `collections.json` | `collections.json` | Jamie's 43 collection pages and the categories they map to |
| `labels.jsonl` | `labels.json` | one line per post: topics, subjects, gist, kind, substance, evergreen |
| `ledger.jsonl` | `assignments.json` + `writeback/log.jsonl` | one line per post: the categories the Librarian last wrote, Featured, alt it filled, Jamie-set flags |
| `suggestions.jsonl` | new | open and closed suggestions |

Sorted one-line-per-post files keep each day's diff to the posts it touched.
The ledger is seeded from what the write-back actually wrote (4,786 + 4,672
`ok` rows) and checked against the live pull before the first write. The 7
shadowed posts (377970, 1074798, 1074800, 1074801, 1075452, 1076156, 1076174)
are seeded as **Jamie-set** and never touched. The 129 posts filed with no
category keep their empty row, so nothing already filed is classified again.

## Guards (in code, not just in the prompt)

- **Compare and set.** Before writing a post's categories, read them live. If
  they are not what the ledger says the Librarian last wrote, someone else
  changed them: write nothing, mark the post Jamie-set, adopt the live list
  and say so in the report. The Librarian never argues with a hand edit.
- **The Weekly Thing category** is WT Builder's. The Librarian never adds or
  removes it, and adds its own categories around it in the usual order.
- **Alt edits:** re-fetch right before the write, change only the empty alt
  attribute, confirm every other byte is unchanged, never turn an `<img>` into
  markdown.
- **Never:** create or delete a post, change a title, date, status or any
  text, delete a category, or bring back Book or Travel Log.
- **Names compare by slug** ("Pokémon" is `pokemon`), so a spelling never
  creates a twin.
- **Daily caps:** 50 category writes and 20 alt edits. Past either, the run
  stops with NEEDS JAMIE.
- **Off switch:** a `data/blog-catalog/PAUSED` file. `make blog-round` is a
  dry run unless given `--write`.

## Pacing and rebuilds

- A day's few writes rebuild their pages in about 10 seconds.
- A re-file of many old posts (a new topic filed back through the archive,
  the alt catch-up) is spread over days under the daily caps, at the
  write-back's pace (2.5 s between writes). After each day the agent checks
  the live pages; only if they stay stale does it ask Jamie to force a
  rebuild. The 10-22 burst of thousands left half the pages stale; 50 a day
  should not, and the check will show it.

## New categories

The Librarian creates a category when the archive calls for it, and tells
Jamie after:

- **Trips:** the overhaul's rule. Ten posts in a run with no 14-day gap, or a
  collection page Jamie made. Named like the 56 there are ("Porto 2026",
  "Switzerland & Italy 2023"). While a trip is under way it is created at the
  tenth post and the first nine are filed back.
- **Topics:** when at least 12 posts over at least two years carry labels no
  topic covers. It writes the rule into `categories.json` and files the old
  posts that fit, under the daily cap.
- **Series:** a title pattern seen three or more times ("Escape Rooms of …").
- **Projects:** a thing on thingelstad.xyz with five or more posts about it.
- **Names:** Title Case, short, no "/" ("&" is fine), never a near-twin of an
  existing name. **Order on a post:** trip, series, project, topics, kept;
  Featured last.

Renames, merges, splits and retirements are suggestions, never its own move.

## Featured: criteria and how many

What Featured drives today: the blog's `/categories/featured/` page, the
Featured section of `llms.txt` (newest 25), and each archive year's photo tile
(the year's first Featured post with a camera photo, else the first photo from
July).

**About 60 posts, two or three a year from 2004, never more than 100.**
Featured is the shelf a new reader starts from: essays, how-tos,
remembrances, announcements of things Jamie built, the best trip logs and
reviews.

1. **Pool:** substance 4 or 5 and evergreen (297 today), plus any post with
   kudos or linked from two or more Weekly Thing issues.
2. **Weighed, not scored:** Jamie's own signals first (Jamie linked back to
   it later, it was a Notable or a Featured section, it got kudos), then
   readers' (two years of Tinylytics views, discounting the search-only
   traffic that floats Big Green Egg and Peppa Pig), then the labels.
3. **Spread:** at least one per year that has a candidate, at most six in any
   year, so 2024–2026 do not crowd out 2004–2015.
4. **Never:** link posts, photo-only microposts, POAP claims, imported tweets,
   anything time-bound, or a post Jamie took off Featured (the ledger
   remembers and never re-adds it).

**Cadence.** The first selection is shown to Jamie as a list before anything
is written, because it changes year tiles at once. After that the Librarian
considers each new post a week after it goes up (so views and kudos have
arrived), reviews the whole shelf each quarter, and reports changes. The three
Featured posts today stay.

## Alt text

- Fill empty alt only. Any alt Jamie wrote stays, even a short one.
- The writer is `alt_text.generate_alt`, the one-line Sonnet vision call with
  post context that did the June backfill (moved to Sonnet 5.5). The vision
  description sidecar is context, not the alt.
- **Catch-up:** the 50 empty since July, then the older ones that can still be
  fetched, 20 a day. The 158 dead 2017 uploads and the ones marked unfillable
  stay as they are.
- From then on, daily, on every new post.

## Doc and code updates (with the build)

- `AGENT-TEAM/README.md`: the team table (Library Agent, Run the Librarian,
  Improve Thingy), the routing rules, and label `objective:library` for
  `objective:archive` (no open issue carries it today).
- `AGENT-TEAM/library-agent.md` replaces `keep-archive-true.md`;
  `run-librarian.md` loses step 8; `WORKFLOW.md`'s report gains the
  Suggestions list for the Library Agent.
- `AGENT-TEAM/scripts/objective_lease.py`: objective `library` for `archive`;
  `tests/test_agent_team_objectives.py` pins the new id and schedule.
- `AGENT-TEAM/automations.toml` and `SCHEDULE.md`: `library-agent` daily at
  5:00 without the date guard, rendered by
  `projects-sysadmin/scripts/render_automation_schedules.py`; in the Codex
  app, Keep the Archive True is removed and the Library Agent installed.
- `AGENTS.md` (this repo): "This repo does not publish" stays true, plus: the
  Library Agent keeps the blog's categories and alt text on micro.blog. The
  micro.blog key here, and in CI, writes metadata only.
- `ALIGNMENT.md`: a boundary row (blog categories and alt: the Librarian
  decides, micro.blog keeps).
- Reader numbers: `deploy.yml` watches `data/librarian/reader-stats.json`
  like the other sidecars; `librarian-core` attaches the `reader` block;
  the Lambda's `get_source` and `list_content` show and sort by it, with
  tests and the MCP reference (`mcp-surface.json`, `/connect/reference/`).
- `docs/featured-posts.md`: rewritten (it still describes Studio's Featured
  section). New `docs/blog-categories.md`: the naming and filing rules.
- `../AGENTS.md` (thingelstad.com): the publishing rule gains "the blog's
  categories and alt text are the Librarian's; micro.blog keeps them".
- `../www.thingelstad.com/AGENTS.md`: the categories scripts are the
  overhaul's record; the Librarian owns filing from here.

## Build order

Each step is its own commit; tests with each.

1. **Refresh sync** (no micro.blog write): compare-every-post ingest, daily
   workflow, then one full refresh commit. Deploys through the corpus gate.
2. **Reader numbers:** the Tinylytics sidecar, the `reader` block in the
   corpus, and `get_source` and `list_content` in the Lambda. Deploys through
   the corpus gate.
3. **Data:** `data/blog-catalog/` seeded and checked against the live pull
   (expect exactly the 7 Jamie-set posts to differ).
4. **`make blog-round` in dry run**, then the Library Agent replaces Keep the
   Archive True in the team and the Codex app. Its archive work runs as Keep
   the Archive True's does today; its blog writes stay dry for one morning,
   and Jamie reads that report.
5. **Writes on:** categories and alt daily; the alt catch-up at 20 a day.
6. **Featured:** the first list to Jamie; written on Jamie's go.
7. **Docs.**

**Cost.** The overhaul labelled 10,469 posts for about $19 at batch prices, a
fifth of a cent a post. A day's handful at full price is a few cents; alt is
one vision call a photo; the first Featured selection is a few dollars once;
Tinylytics reads cost nothing. Under $5 a month in the usual run, plus the
Codex run itself.

## Decisions for Jamie

1. **The team change:** the Library Agent replaces Keep the Archive True and
   takes photo descriptions and summaries from Run the Librarian, daily at
   5:00 a.m.; the team stays three.
2. **Who sees reader numbers:** views and kudos in the public repository,
   Thingy and the MCP, or only in the Librarian's own work (Featured,
   suggestions, "most read" order with no count shown)? Recommended: views
   and kudos for everyone; email opens and feed reads for the Library Agent
   only.
3. **A new topic** at 12 posts over two years: the right bar? (Used unless
   Jamie says otherwise.)
