# Plan: the Librarian tends the blog (2026-10-22)

**Status: proposed, waiting for Jamie's go.** Nothing is built and nothing has
been written to micro.blog. Every number below was measured read-only on
2026-10-22 (a full Micropub `q=source` pull, the Tinylytics API with the
read-only key, the Anthropic Models API, and the overhaul's cache in
`../www.thingelstad.com/dev/cache/categories/`).

**Revised the same day.** Jamie cut the scope to two jobs: "Lets remove
typo/grammer checking and link additions from the goal. Focus only on the alt
text and category management. That removes the need for a feedback loop and I
didn't like the GitHub issues approach anyway." Jamie also asked for it to be
"a librarian agent that is looking at my blog daily and tending to these
tasks", automated in Codex. This version is that plan.

Jamie, 2026-10-22: "The Librarian decides; micro.blog keeps them and stays the
source of authority for the blog." The Librarian becomes the authority for the
blog's **categories** (Featured included, since Featured is a category) and
its **alt text**. micro.blog still holds every post; the Librarian never
creates, deletes, retitles or re-dates one, and never changes a word Jamie
wrote.

## What Jamie decided

- "I never actually assign categories to a post." The Librarian owns the whole
  list. The one exception is **Weekly Thing**, which WT Builder sets.
- "It could create new categories." New trips and topics when the archive
  calls for them, telling Jamie after.
- "I would love it if the librarian managed features too. The librarian could
  get an API key for tinylytics to assist with that too!" Criteria and a count
  come first (below), before any post is chosen.
- "Also agree on the alt text. It should own that. The librarian is my partner
  for this." Fill empty alt only; never replace alt Jamie wrote.
- "Agree it would move to daily. Yes to alt fills. Yes it should use its own
  model key."
- Typo checking and link additions are out of scope (above).

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

## The Librarian agent: Tend the Blog

A fourth objective owner in `AGENT-TEAM/`, **Tend the Blog**
(`tend-the-blog.md`), run by a Codex app automation **every day at 5:30 a.m.
Central** (between Run the Librarian at 5:15 and Improve Thingy at 6:00), on
`gpt-5.6-terra` like the other daily owner. Its question: *is every post on
the blog filed and described the way the Librarian would file it?*

This changes `AGENT-TEAM/README.md`, which says "Do not add more agents; new
names would split outcomes these three already own." Tending the blog is a new
outcome, the first one that writes to Jamie's live site every day, so it gets
its own lease, its own run history and its own report rather than a daily
branch inside Keep the Archive True's three-day objective.

**Who decides what.** The agent tends; the repo's tools do the repeatable
work, so new posts are filed exactly the way the 9,459 already filed were:

- `make tend` (`pipeline/blog/tend/`) reads micro.blog, proposes categories
  with the overhaul's labeller (Opus 5.5, its schema and mapping), writes alt
  with the June backfill's vision call (Sonnet 5.5), and carries every guard
  below in code. Those calls use the Librarian's own Anthropic key.
- The agent reads each day's proposals against the posts before anything is
  written (a normal day is zero to six posts), decides the calls that need
  judgment (a new category, a post someone else changed, Featured), writes
  with `make tend ARGS=--write`, checks the live pages, and reports.

**The daily round:**

1. **Sync.** Read every post and page from micro.blog (21 `q=source` pages)
   and rewrite the `data/blog/` files whose rendered text changed. The GitHub
   workflow uses the same refresh and moves from Mondays to a daily backstop
   at 12:17 UTC (7:17 a.m. CDT, 6:17 a.m. CST).
2. **Describe new photos** (`describe_media.py`, Haiku 5.5) and **write
   summaries** for new or changed posts (`abstracts.py`, Sonnet 5.5). Both
   leave `run-librarian.md` step 8 and become daily.
3. **File categories** on posts the Librarian has never filed.
4. **Fill alt** on posts older than the newest sent Weekly Thing issue.
5. **Featured:** note candidates daily; decide on Sundays.
6. **Verify and close out.** Read each written post's live page (the
   categories in its footer), refresh those `data/blog/` files, make one
   commit (`data/blog/`, the sidecars, `data/blog-steward/`), push. The push
   runs `deploy.yml` once, through the corpus gate.

## How Jamie hears from it

No issues and no inbox to tend. The agent ends each run with the team's
report block in the Codex app:

```text
Outcome: HEALTHY | CHANGED | WATCHING | BLOCKED | NEEDS JAMIE
Objective: Tend the Blog
Evidence: 4 posts filed, 3 alts filled, Kubb 2026 created (10th post)
Action: ...
Next check: ...
Jamie: <one yes/no question, or None>
```

- **Told after** (CHANGED): new categories, Featured changes, alt counts,
  posts it left alone because someone else had changed them.
- **NEEDS JAMIE** only for the first Featured list, and for a forced rebuild
  if live pages stay stale after a re-file.
- **Run notes:** on any day it wrote, `AGENT-TEAM/notes/YYYY-MM-DD-blog-tend.md`
  lists each post with before and after. A quiet day gets no note. The weekly
  rollup in `AGENT-TEAM/summaries/` carries a Tend the Blog section.
- **The ledger in git** is the full audit trail.

## What moves into librarian-thing

The overhaul's tools stay in `../www.thingelstad.com/scripts/categories/` as
the record of the one-time run. The tools here are written fresh (the repo
rule: never copy code between repos), and the data becomes committed files in
`data/blog-steward/`:

| File | From | Holds |
|---|---|---|
| `categories.json` | `taxonomy.json`, `trips.json`, `assign.py` | all 124 categories: name, slug, group (trip, series, project, topic, kept), rule, dates, who made it |
| `collections.json` | `collections.json` | Jamie's 43 collection pages and the categories they map to |
| `labels.jsonl` | `labels.json` | one line per post: topics, subjects, gist, kind, substance, evergreen |
| `ledger.jsonl` | `assignments.json` + `writeback/log.jsonl` | one line per post: the categories the Librarian last wrote, Featured, alt it filled, Jamie-set flags |

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
- **Weekly Thing** is WT Builder's. The Librarian never adds or removes it,
  and adds its own categories around it in the usual order.
- **Alt edits:** re-fetch right before the write, change only the empty alt
  attribute, confirm every other byte is unchanged, never turn an `<img>` into
  markdown.
- **The open issue is WT Builder's.** Posts published after the newest issue
  in `data/issues/` (today WT353, 10-10) are Journal candidates in the open
  draft, where WT Builder's alt wand and reconcile work. No alt edits on them
  until that issue is sent; categories are fine, since WT Builder does not
  mirror them.
- **Never:** create or delete a post, change a title, date, status or any
  text, delete a category, or bring back Book or Travel Log.
- **Names compare by slug** ("Pokémon" is `pokemon`), so a spelling never
  creates a twin.
- **Daily caps:** 50 category writes and 20 alt edits. Past either, the run
  stops with NEEDS JAMIE.
- **Off switch:** a `data/blog-steward/PAUSED` file. `make tend` is a dry run
  unless given `--write`.

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

## Featured: criteria and how many

What Featured drives today: the blog's `/categories/featured/` page, the
Featured section of `llms.txt` (newest 25), and each archive year's photo tile
(the year's first Featured post with a camera photo, else the first photo from
July).

**Proposal: about 60 posts, two or three a year from 2004, never more than
100.** Featured is the shelf a new reader starts from: essays, how-tos,
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
- **Catch-up:** the 50 empty since July (posts since 10-10 wait for WT354),
  then the older ones that can still be fetched, 20 a day. The 158 dead 2017
  uploads and the ones marked unfillable stay as they are.
- From then on, daily, on posts past the newest sent issue.

## Doc updates (with the build)

- `AGENT-TEAM/README.md`: four owners; the "Do not add more agents" line
  names Tend the Blog as the deliberate exception. New
  `AGENT-TEAM/tend-the-blog.md`; label `objective:blog`.
- `AGENT-TEAM/automations.toml` and `SCHEDULE.md`: the new daily entry,
  rendered by `projects-sysadmin/scripts/render_automation_schedules.py`, then
  installed in the Codex app.
- `AGENTS.md` (this repo): "This repo does not publish" stays true, plus: the
  Librarian tends the blog's categories and alt text on micro.blog. The
  micro.blog key here, and in CI, writes metadata only.
- `ALIGNMENT.md`: a boundary row (blog categories and alt: the Librarian
  decides, micro.blog keeps).
- `run-librarian.md` step 8 points at Tend the Blog;
  `keep-archive-true.md` drops the weekly-sync check for the daily one.
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
2. **Data:** `data/blog-steward/` seeded and checked against the live pull
   (expect exactly the 7 Jamie-set posts to differ).
3. **`make tend` in dry run**, then the Tend the Blog objective and its
   automation, also dry run for one morning. Jamie reads that report.
4. **Writes on:** categories and alt daily; the alt catch-up at 20 a day.
5. **Featured:** the first list to Jamie; written on Jamie's go.
6. **Docs.**

**Cost.** The overhaul labelled 10,469 posts for about $19 at batch prices, a
fifth of a cent a post. A day's handful at full price is a few cents; alt is
one vision call a photo; the first Featured selection is a few dollars once.
Under $5 a month in the usual run, plus the Codex run itself.

## Decisions for Jamie

1. **Featured stays in?** It is a category, so this plan keeps it. If yes:
   about 60, two or three a year, first list shown before writing? (Or 25,
   just enough for `llms.txt`; or about 100.)
2. **A fourth owner**, Tend the Blog, daily at 5:30 a.m.? (The alternative is
   a daily branch inside Keep the Archive True.)
3. **A new topic** at 12 posts over two years: the right bar?
