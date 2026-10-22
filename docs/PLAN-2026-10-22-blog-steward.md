# Plan: the Librarian as steward of the blog (2026-10-22)

**Status: proposed, waiting for Jamie's go.** Nothing is built, nothing is
committed outside this file, and nothing has been written to micro.blog.
Every number below was measured read-only on 2026-10-22 (a full Micropub
`q=source` pull, the Tinylytics API with the read-only key, the Anthropic
Models API, and the overhaul's cache in
`../www.thingelstad.com/dev/cache/categories/`).

Jamie, 2026-10-22: "The Librarian decides; micro.blog keeps them and stays the
source of authority for the blog." The Librarian becomes the authority for the
blog's **categories**, its **Featured** posts and its **alt text**. micro.blog
still holds every post; the Librarian never creates, deletes, retitles or
re-dates one.

## What Jamie decided

- "I never actually assign categories to a post." The Librarian owns the whole
  list. The one exception is **Weekly Thing**, which WT Builder sets.
- "It could create new categories." New trips and topics when the archive
  calls for them, telling Jamie after.
- "I would love it if the librarian managed features too. The librarian could
  get an API key for tinylytics to assist with that too!" Criteria and a count
  come first (this plan), before any post is chosen.
- "Also agree on the alt text. It should own that. The librarian is my partner
  for this." Fill empty alt only; never replace alt Jamie wrote.
- "Agree it would move to daily. Yes to alt fills. Yes it should use its own
  model key."
- Typos: "If there was a way for the Librarian to notice typos that would be
  incredible but would need a way for the librarian to contact me."
- Links: "The librarian could do link augmentation and add links to posts
  where one makes sense, particularly internal links to other blog posts or
  categories but could include links to public sites."

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
gone, so every post from now on is uncategorised until the steward runs.

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

**Keys.** `.env` has `ANTHROPIC_GENERAL_API_KEY`, `OPENAI_API_KEY`,
`TINYLYTICS_API_KEY` (read-only, `tly-ro-`) and `MICROBLOG_API_KEY`.
`TINYLYTICS_SITE_UID` is the Weekly Thing site's uid, not the blog's; the
steward names the blog by its id, 1521. This plan uses no OpenAI key.

**Models** (live Models API, 2026-10-22): `claude-opus-5-5`,
`claude-sonnet-5-5`, `claude-haiku-5-5` and `claude-fable-5-1` are current.
`pipeline/blog/anthropic_client.py` still maps `sonnet` to `claude-sonnet-5`
and `opus` to `claude-opus-4-7`; both still answer but are a generation old.

## The daily pass

One command, `make steward` (`pipeline/blog/steward/`), run every morning by
**Keep the Archive True**. Its date guard keeps gating the full three-day
objective; on every day, due or not, it runs the steward first. No new agent.
The Codex run starts the pass, reads its report and handles anything it
flags. The decisions themselves are Claude calls made inside the pass, on the
Librarian's own key (`ANTHROPIC_GENERAL_API_KEY` from this repo's `.env`).

In order, at about 5:00 a.m. Central:

1. **Sync.** Read every post and page from micro.blog (21 `q=source` pages)
   and rewrite the `data/blog/` files whose rendered text changed. This
   replaces `--since-last` here and in the GitHub workflow, which moves from
   Mondays to a daily backstop at 12:17 UTC (7:17 a.m. CDT, 6:17 a.m. CST).
2. **Describe new photos.** `describe_media.py` (Haiku 5.5) on new image URLs.
3. **Write summaries.** `abstracts.py` (Sonnet 5.5) on new or changed bodies.
   Steps 2 and 3 leave `run-librarian.md` step 8 and become daily.
4. **File categories** on posts the Librarian has never filed (normally the
   day's new posts). Label with the overhaul's schema on Opus 5.5 (the model
   that labelled the archive), map to the list, assign with the overhaul's
   rules (below), write.
5. **Fill alt** on posts older than the newest sent Weekly Thing issue.
6. **Featured.** Daily: note posts that meet the criteria. Weekly (Sundays):
   decide. Below.
7. **Typos and links.** Read the day's posts and queue suggestions for Jamie.
8. **Close out.** Re-read every post it wrote, refresh those files, and make
   one commit (`data/blog/`, the sidecars, `data/blog-steward/`). The push
   runs `deploy.yml` once, through the corpus gate.

A typical day is zero to six posts and a few cents of model calls.

## What moves into librarian-thing

The overhaul's tools stay in `../www.thingelstad.com/scripts/categories/` as
the record of the one-time run. The steward is written fresh here (the repo
rule: never copy code between repos), and its data becomes committed files in
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

## Guards

- **Compare and set.** Before writing a post's categories, read them live. If
  they are not what the ledger says the Librarian last wrote, someone else
  changed them: write nothing, mark the post Jamie-set, adopt the live list
  and say so in the run note. The Librarian never argues with a hand edit.
- **Weekly Thing** is WT Builder's. The Librarian never adds or removes it,
  and adds its own categories around it in the usual order.
- **Body edits** (alt, approved typo fixes, links): re-fetch right before the
  write, change only the exact span, confirm every other byte is unchanged,
  never turn an `<img>` into markdown.
- **The open issue is WT Builder's.** Posts published after the newest issue
  in `data/issues/` (today WT353, 10-10) are Journal candidates in the open
  draft, where WT Builder's alt wand and reconcile work. The Librarian makes
  no body edits on them until that issue is sent; categories are fine, since
  WT Builder does not mirror them.
- **Never:** create or delete a post, change a title, date or status, delete
  a category, or bring back Book or Travel Log.
- **Names compare by slug** ("Pokémon" is `pokemon`), so a spelling never
  creates a twin.
- **Daily caps:** 50 category writes and 20 body edits. Past either, the pass
  stops and asks.
- **Off switch:** a `data/blog-steward/PAUSED` file, or `--dry-run` (the
  default for a hand run; the automation passes `--write`).

## Pacing and the rebuild ask

- A day's few writes rebuild their pages in about 10 seconds. No ask.
- A re-file of many old posts (a new topic applied back through the archive,
  the alt catch-up) runs at the write-back's pace (2.5 s, a calm pause every
  50, back-off on throttling) and stays under 390 writes a run. When it
  finishes the Librarian asks Jamie to force a rebuild, naming the count,
  because a burst leaves about half the live pages stale and a theme Pull
  does not fix it.

## New categories

The Librarian creates a category when the archive calls for it, and tells
Jamie after:

- **Trips:** the overhaul's rule. Ten posts in a run with no 14-day gap, or a
  collection page Jamie made. Named like the 56 there are ("Porto 2026",
  "Switzerland & Italy 2023"). While a trip is under way it is created at the
  tenth post and the first nine are filed back.
- **Topics:** when at least 12 posts over at least two years carry labels no
  topic covers. It writes the rule into `categories.json`, files the old posts
  that fit (paced), and reports.
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
2. **Weighed, not scored:** Jamie's own signals first (Jamie linked back to it
   later, it was a Notable or a Featured section, it got kudos), then
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
arrived), reviews the whole shelf each quarter, and tells Jamie after. The
three Featured posts today stay.

## Alt text

- Fill empty alt only. Any alt Jamie wrote stays, even a short one.
- The writer is `alt_text.generate_alt`, the one-line Sonnet vision call with
  post context that did the June backfill (moved to Sonnet 5.5). The vision
  description sidecar is context, not the alt.
- **Catch-up:** the 50 empty since July (posts since 10-10 wait for WT354),
  then the older ones that can still be fetched. The 158 dead 2017 uploads and
  the ones marked unfillable stay as they are.
- From then on, daily, on posts past the newest sent issue.

## Typos and links: suggested, then applied on Jamie's tick

Both change Jamie's words or what a reader clicks, so the Librarian proposes
and Jamie decides:

- **Typos:** `typo_scan.py` on each day's posts: simple, certain typos only.
- **Links:** where a phrase already in the post names something the archive
  has (an earlier post, a category, a Weekly Thing issue) or a well-known
  public page. Rules: wrap existing words only, never add or change a word;
  at most two per post; never inside a quote, heading, image or existing
  link; only URLs that answer 200. Content links carry no `ref`.

**The channel (recommended):** one GitHub issue a week in librarian-thing,
labelled `objective:archive`, "Steward's notes, week of …". Each suggestion is
a checkbox with the post link and the exact before and after. Jamie ticks the
ones to apply; the next morning's pass applies them under the body-edit
guards, notes them, and closes the issue at the week's end. The same issue
carries the rest of the week's news: new categories, Featured changes, rebuild
asks. GitHub notifies Jamie by email and app.

## Reporting

- **Run notes:** Keep the Archive True writes
  `AGENT-TEAM/notes/YYYY-MM-DD-archive-blog-steward.md` on any day it wrote:
  each post with before and after, new categories, Featured changes, alt
  counts, Jamie-set skips, asks. A quiet day gets no note, only the
  automation's Latest run line. The weekly rollup carries a steward section.
- **The ledger in git** is the full audit trail.

## Doc updates (with the build)

- `AGENTS.md` (this repo): "This repo does not publish" stays true, plus: it
  is the blog's steward and writes categories, Featured, empty alt and
  approved fixes to micro.blog. The micro.blog key here, and in CI, writes
  metadata only.
- `ALIGNMENT.md`: a boundary row (blog categories, Featured and alt: the
  Librarian decides, micro.blog keeps). "Nothing here writes to a reader"
  still holds: it sends no email.
- `AGENT-TEAM/keep-archive-true.md`: a daily blog-steward section;
  `run-librarian.md` step 8 points at it. The automation prompt changes in
  `projects-sysadmin`'s renderer, then `automations.toml` is re-rendered.
- `docs/featured-posts.md`: rewritten (it still describes Studio's Featured
  section). New `docs/blog-categories.md`: the naming and filing rules.
- `../AGENTS.md` (thingelstad.com): the publishing rule gains "the blog's
  categories, Featured and alt text are the Librarian's; micro.blog keeps
  them".
- `../www.thingelstad.com/AGENTS.md`: the categories scripts are the
  overhaul's record; the Librarian owns filing from here.

## Build order

Each step is its own commit; tests with each.

1. **Refresh sync** (no micro.blog write): compare-every-post ingest, daily
   workflow, then one full refresh commit. Deploys through the corpus gate.
2. **Steward data:** `data/blog-steward/` seeded and checked against the live
   pull (expect exactly the 7 Jamie-set posts to differ).
3. **The pass in dry run** for one morning: its report shows what it would
   file, fill and suggest. Jamie reads it.
4. **Writes on:** categories and alt daily; the alt catch-up paced, then a
   rebuild ask.
5. **Featured:** the first list to Jamie; written on Jamie's go.
6. **Typos and links** through the weekly issue.
7. **Docs and the automation prompt.**

**Cost.** The overhaul labelled 10,469 posts for about $19 at batch prices, a
fifth of a cent a post. A day's handful at full price is a few cents; alt is
one vision call a photo; the first Featured selection is a few dollars once.
Under $5 a month in the usual run.

## Decisions for Jamie

1. **Featured:** about 60, two or three a year, first list shown before
   writing? (Or 25, just enough for `llms.txt`; or about 100.)
2. **Channel:** the weekly GitHub issue with checkboxes? (Or a section in the
   Librarian's 7 a.m. digest email, which means storing the notes where the
   Lambda can read them; or Telegram through Otto.)
3. **Links:** suggested for the first month, then written and reported if
   most get ticked? Or written from day one?
4. **A new topic** at 12 posts over two years: the right bar?
