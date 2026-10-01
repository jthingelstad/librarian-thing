# Plans: the QA follow-ups Jamie asked for as plans (2026-10-01)

Jamie answered the 25 Librarian QA questions on 2026-09-30. Five answers asked
for a plan rather than a change. This document is those plans. Nothing here
has been built. Each plan ends with what Jamie needs to decide.

Numbers were measured on 2026-10-01 against the QA corpus (built from `main`
on 2026-09-30) and the local sibling checkouts, unless a line says otherwise.

The freeze matters for timing. From Fri 2026-10-02 00:00 CT until WT352 is
sent, nothing changes the corpus, `shared/retrieval.mts`, WT Builder or AT
Builder. Lambda-only MCP changes may still ship. Every plan below says which
side of that line its steps fall on.

| # | Plan | Repos | Size | Earliest |
|---|------|-------|------|----------|
| 1 | Weekly site dates in Chicago time (answer 5) | weekly.thingelstad.com | small | after WT352 |
| 2 | Journal permalinks repaired at the source (answer 2) | librarian-thing, weekly.thingelstad.com | medium | after WT352 |
| 3 | WT Builder canonical link checks (answer 14) | wt-builder | medium | after WT352 |
| 4 | Captions for the photos the vision pass missed (answer 17) | librarian-thing | small | filename search: now; captions: after WT352 |
| 5 | The Weekly Thing audio editions in the corpus (item A) | librarian-thing | small to medium | MCP side: now; freshness: after WT352 |

---

## 1. Weekly site dates in Chicago time

**What is wrong.** Every date the weekly site shows a reader is computed in
UTC. Jamie's rule is Chicago time. Four of 352 issues change day as a result:
- WT22 (00:00Z, Oct 6 in Chicago);
- WT35 (2018-01-07T01:28Z, Jan 6 in Chicago, matching its subject "Weekly
  Thing for January 6, 2018", but the site shows January 7);
- WT251 (Apr 24Z, Apr 23 in Chicago);
- WT299 (Nov 4Z, Nov 3 in Chicago).

None of the four crosses a month or year, so year tabs and archive stats
don't change today. Issues WT Builder sends are stamped noon UTC
(`publish.ts:109-111`), which is always the same day in Chicago. The bug only
shows on back-catalogue send times, but the code is wrong for any date.

**Where it is** (`apps/site/eleventy.config.js`):
- `dateFormat` (default format, line 79) and `dateShort` (line 92) both pass
  `timeZone: "UTC"`.
- `dateTimeShort` and the `year` filter are UTC too, but nothing uses them.
- `groupByYear` (line 299) and `_data/archiveStats.js` (lines 26, 50, 139)
  take the year and month in UTC.

Those filters feed the issue page's `<time>` (which Pagefind indexes), issue
cards, the archive list, the home page, podcast pages, the `.txt` issue text,
`llms.txt` and topic pages.

**What stays UTC, correctly:** the machine timestamps. These are
`article:published_time`, the Atom/RSS/podcast feed dates, the sitemap and
`archive.json`. They are instants and stay ISO or RFC 822 with an offset. No
URL depends on a date: issue URLs are `/archive/N/`, feed ids and podcast
GUIDs are number-based, and redirects use the Buttondown slug.

**Plan** (one small PR in weekly.thingelstad.com):

1. One constant, `SITE_TIME_ZONE = "America/Chicago"`, used by `dateFormat`,
   `dateShort`, `dateTimeShort`, `year`, `groupByYear` and `archiveStats`
   in place of `"UTC"` and `getUTC*`. `iso` and `rfc822` stay as they are.
2. Fix the topic-page format while there. Topic pages ask for
   `dateFormat('MMM yyyy')`, which the filter ignores, so they print a full
   date. Either honour a `month-year` format or change the call to the
   format the filter knows.
3. A test the site doesn't have yet. Its Playwright suite pins no dates.
   Add a filter unit test: WT35's `2018-01-07T01:28:21Z` renders "January 6,
   2018", noon UTC renders the same day, and `iso` is unchanged. Also run the
   build with `TZ=UTC` in CI so the runner's zone can never mask the bug.
4. Check the four pages after deploy: WT22, WT35, WT251 and WT299 show their
   Chicago day.
5. The Librarian side is already done: 2.2.0 files every source by its
   Chicago day.
6. WT Builder still slices UTC dates in three places: the audio back-catalogue
   episode date (`backfill.ts:111`), `import-prebuilder.ts:67` and
   `editorial.ts:1090`. For the four affected issues the back-catalogue
   episode date would be a day late. Move those to Chicago with the same
   helper in the same pass, after the freeze.

**Jamie decides:** nothing; the rule is set. This is a bug fix.

---

## 2. Journal permalinks repaired at the source

**What is wrong.** 481 Journal permalinks in Weekly Thing issues point at no
blog post in the corpus. 472 of them are on www.thingelstad.com, and most are
from 2017 to 2019 (170, 150 and 126). 476 of the 481 have a blog post on the
same day. Jamie's account: micro.blog changed the permalinks after the fact,
and the posts still exist at new URLs.

**What already landed.** The corpus work before the freeze ties each Journal
entry to the post it copies. It matches by permalink first, then by date and
text. Each WT chunk now carries
`journal_posts: [{url, copy_of_microblog_id, canonical_url, matched_by}]`.
The corpus top level carries `journal_copy_stats` and `journal_unmatched`. So
the Librarian already prefers the blog post even where the old link is dead.
This plan fixes the links themselves.

**Plan.**

1. **Build the map from the corpus, not by hand.** Every Journal entry with
   `matched_by: "date_text"` is an old permalink with a known new home: its
   `url` maps to `canonical_url`. Write that out as a reviewable CSV: issue,
   old URL, new URL, the date, the first 80 characters of both texts, and a
   text-similarity score. Add `journal_unmatched` as a second list with no
   proposed target.
2. **Confirm each pair with reads only.** GET the old URL (expect 404, or a
   redirect to the new one) and the new URL (expect 200). A host redirect
   from old to new confirms the pair outright. Rows whose similarity is low,
   or where both URLs answer 200, go to Jamie instead of into the repair.
3. **Repair both copies with one audit script.** Add
   `pipeline/audits/repair_journal_permalinks.py` that takes the reviewed CSV
   and rewrites:
   - `data/issues/N` (the canonical copy; pre-Builder repairs are what
     `pipeline/audits/` is for), and
   - `weekly.thingelstad.com/apps/site/archive/N.md` (the render copy, by
     sibling-relative path), committed in that repo.

   The script changes only exact link targets. It never touches link text
   or `audio_*` frontmatter. It is idempotent and has a `--dry-run` that
   prints the diff count per issue. Issues WT Builder wrote (WT350 on)
   are fixed in WT Builder and re-sent instead. None of those are expected
   on the list.
4. **Gate it.** The corpus gate fails if `journal_copy_stats.unmatched`
   rises above the count after the repair. Then a later regression in
   matching or ingest cannot quietly undo it.
5. **Out of scope:** the Buttondown archive copies of sent emails. They keep
   the old links. Buttondown's archive is not what readers or the Librarian
   read.

**Jamie decides:** whether rows where both URLs still answer 200 (two live
posts on the same day) are repaired or left alone.

---

## 3. WT Builder canonical link checks

**What exists.** WT Builder has a URL *matching* key and no URL *checks*.
- `linkKey` (`src/server/linked-before.ts:33-45`) drops the scheme, `www.`,
  the fragment, the trailing slash and tracking parameters (`utm_*`,
  `fbclid`, `gclid`, and others). It is used only to find "linked before"
  for the link wand. It never rewrites a URL and never fetches.
- The wand fetches the page when it drafts commentary (`fetchPublic`, up to
  5 redirects, 15 s). On error it says the page "could not be read", and it
  throws the final URL away.
- There is no dead-link check. Post-send verify (`verify.ts`) checks only
  image hotlinks.
- The Librarian has its own key, `linkUrlKey` (`archive-tools.mts:494-515`),
  with a *different* tracking-parameter list. Nothing anywhere handles AMP,
  mobile subdomains, shorteners or `rel=canonical`.

**The constraint that shapes the design.** `source_url` is how WT Builder
finds the Pinboard bookmark. Reconcile reads by it (`/posts/get?url=`), and
write-back sends it (`/posts/add url=... replace=yes`). Rewriting
`source_url` in WT Builder would make the next write-back create a *second*
bookmark. So the canonical URL must be a separate field: the bookmark keeps
its URL, and the issue renders the canonical one.

**Plan** (wt-builder, after the freeze):

1. **One canonicaliser, shared by contract.** A pure
   `canonicalUrl(url)`:
   - https, lowercase host, drop `www.` and `m.`/`mobile.`;
   - drop the fragment and the trailing slash;
   - drop the union of both tracking-parameter lists;
   - unwrap AMP paths (`/amp/`, `?amp`, `amp.` hosts, `cdn.ampproject.org`).

   It is fixture-tested, with the same fixtures copied into the Librarian
   tests so `linkKey` and `linkUrlKey` can't drift apart again.
2. **A link check, run on demand and once before send.** For every link in
   the issue (item URLs and inline URLs in commentary), fetch with
   `fetchPublic` and record `{status, final_url, canonical_hint}` on the
   item. `canonical_hint` is the page's `<link rel=canonical>` when it
   differs. Shorteners (t.co, wapo.st, bit.ly and the like) resolve to their
   final URL. Results are stored on the issue and applied with
   `savedFresh`, as WT Builder's AGENTS.md requires. A 403 or 429 from a site
   that blocks bots is "couldn't check", never "dead".
3. **Surface it as readiness, warn-only.** One readiness unit per issue,
   "Links checked", in the existing advisory list (`readiness()`,
   `issue.ts:1235`). It shows `partial` with a count when links are dead,
   non-canonical or shortened. One click applies the canonical URL to the
   *rendered* link. A dead link is a warning on the Send card, and
   `?force=1` with confirm overrides it, like every other gate (Jamie's
   "warn, don't block").
4. **Optionally, fix it in Pinboard too.** A "move bookmark" action deletes
   the old bookmark and adds one at the canonical URL with the same
   description, tags and commentary. It runs only when Jamie clicks it, never
   automatically, so the Pinboard record and the issue agree going forward.
5. **The archive.** Answer 14 also said to treat near-duplicates as one. The
   Librarian already merges them at read time with `linkUrlKey`. Rewriting
   old issues' URLs is not proposed: the read-time key covers them, and old
   issues should keep the links readers clicked.

**Jamie decides:**
- whether canonical URLs are applied to the rendered link only (recommended
  first) or also moved in Pinboard (step 4);
- whether the pre-send check is automatic or a button.

---

## 4. Captions for the photos the vision pass missed

**The premise needs one correction.** The QA finding's "279 photos" is a
search gap, not a captioning gap. Those photos' file names hold words, like
`strawpoll297.png` and `wikitribune.png`, that appear nowhere in their
searchable text. Most of them already have a vision description. What is
truly uncaptioned is smaller:

- **76 Weekly Thing photos have no description.** 64 failed the vision pass
  with `api_400`. 12 were never tried, because they are `http://` URLs
  (WT158, WT278, WT297-300) or on hosts outside the pass's allowlist
  (blotcdn.com, pbs.twimg.com, gallery.tinyletterapp.com, cdn.glitch.global).
- **257 sidecar entries failed with `api_400` across both corpora.** The
  2026-09-05 note says these were expired Buttondown presigned URLs. Only 13
  are. 196 are on www.thingelstad.com, 47 on files.thingelstad.com and 1 on
  cdn.uploads.micro.blog. Those are Jamie's own hosts, so the images are
  probably fine. The pass sends each image by URL
  (`describe_media.py:99`), so the API fetches it. A 400 there usually
  means the image was too large or its format was unsupported, not that the
  link was dead.

**Plan.**

1. **Make file names searchable (Lambda only, can ship during the freeze).**
   `media_search` derives words from each photo's file name at load:
   - split on punctuation and digit runs;
   - drop hashes, UUIDs, dimensions such as `1200` or `SX327`, and words
     under four letters;
   - match them at low weight, with a `match_reasons` entry `filename:
     'strawpoll'`.

   No corpus change is needed. An eval check pins `{"query":"strawpoll"}`
   at 2 or more results.
2. **Retry the failures by fetching locally.** Teach `describe_media.py` a
   `--retry-errors` mode:
   - download each image itself;
   - convert HEIC/WebP/oversized images to JPEG, at most 1,568 px on the long
     edge;
   - send the image as base64.

   Record a precise error for what still fails: `fetch_404`, `fetch_403`,
   `decode_error` or `api_400`. Fetching locally also lets the host allowlist
   gate only what we fetch, so the 12 never-tried photos join, with `http://`
   upgraded to `https://` where the host serves it. It is about 330 images on
   Haiku, well under $1.
3. **Rebuild through the gate.** Committing the refreshed sidecar triggers
   the WT and blog corpus rebuilds, which now pass the corpus gate before
   upload. This changes the corpus, so it goes after WT352.
4. **Keep it caught up.** New photos still need a manual `describe_media`
   run. Run it in the Monday sync workflow, after the blog sync, for new URLs
   only. That needs an Anthropic API key in this repo's CI secrets. Jamie
   adds it in GitHub's settings. We never read or move the value.

**Jamie decides:** whether to add the API key to CI so captions keep up on
their own (step 4), or keep the manual run.

---

## 5. The Weekly Thing audio editions in the corpus

**Where it stands.** The corpus already knows about the audio editions,
partly:

- 172 of 352 issues (WT180 to WT351) carry an `audio` pointer: URL, duration
  and chapters. `librarian_core.audio` reads it at build time from the
  weekly site's archive frontmatter, which is the only place WT Builder and
  the back-catalogue job write it.
- `list_content`, `latest_content` and `get_source` return `audio_url`, and
  `get_source` adds `audio_chapters`. Live today:
  `get_source {id: "wt-274"}` returns the MP3, 2,537 seconds and 8 chapters.
- The audio is a voice reading of the issue text, so its words are already
  in the corpus. Indexing the VTT transcripts would only duplicate them. The
  pointer stays a pointer (`audio.py`: "never its words").

**The gaps.**

1. **Freshness.** A pointer arrives only when this repo rebuilds the WT
   corpus. A new audio edition commits to the weekly site, not here, so
   nothing rebuilds. The back-catalogue job resumes on 10-02 at ten issues a
   day. Each of those stays invisible to the Librarian until the next issue
   send rebuilds the corpus, up to a week later.
2. **Nobody is told.** No tool description, `outputSchema` or Thingy prompt
   mentions audio. An agent has to stumble on `audio_url`.
3. **No way to ask for it.** "Which issues have audio?" and "how many hours
   of audio?" can't be answered without paging every issue.
4. **Search results don't carry it.** A `search_archive` or `find_evidence`
   passage from WT274's Journal doesn't say the Journal starts at 28:17 in
   the audio edition.

**Plan.**

1. **Pull, don't push, for freshness (corpus side, after WT352).** Add a
   daily scheduled job to `deploy.yml`, or to its own small workflow:
   - sparse-check out the weekly site's archive pages (as the deploy already
     does, read-only, no PAT);
   - compare each page's `audio_url` with the live corpus's issue pointers;
   - rebuild the WT corpus only when they differ.

   An audio pointer doesn't change chunk text, so every embedding comes from
   the cache and the rebuild costs no Bedrock. This keeps the domain's rule
   of one cross-repo push. The site never triggers this repo.
2. **Say it (Lambda only, can ship during the freeze):**
   - `list_content` and `latest_content` take `has_audio: true|false`;
   - `corpus_stats` reports `audio_editions: {count, total_seconds, first,
     last}`;
   - the tool descriptions and `outputSchema` name `audio_url`,
     `audio_duration_seconds` and `audio_chapters`;
   - the `librarian://wt/{n}` resource adds a "Listen" line with the length.
3. **Section to chapter (Lambda only).** WT Builder names chapters after
   sections (Featured, Currently, Notable, Journal, Briefly). So a WT
   passage can carry `audio: {url, start}` for its section's chapter, using
   the same exact section match the tools use. If there's no matching
   chapter, no `start` is given. Then "listen from the Journal" becomes a
   link with `#t=1697`. `get_source` with `section` returns that chapter's
   start too.
4. **Thingy.** One line in `agent-system.md`: when an issue has an audio
   edition and the reader asks to listen, or asks about the issue as a
   whole, offer the audio link and its length. Never offer it unprompted on
   every citation.
5. **Gate it.** A completeness check in the corpus gate: every site archive
   page with `audio_url` has a matching `issue.audio`. This is the check
   that would have caught a lag.

**Not proposed:** treating the audio editions as podcast sources. Another
Thing is the podcast. The audio editions are a way to listen to an issue,
so they stay on the issue.

**Jamie decides:** whether Thingy should mention the audio edition only on
request (recommended) or whenever it cites a whole issue.
