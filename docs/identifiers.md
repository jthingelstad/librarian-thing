# Identifiers & subject lines

How a Weekly Thing issue is identified and titled, and where each form is allowed
to appear. Two things are defined here: the **short identifier** (`WT<NUM>`) and the
**email subject line** (`WT<NUM> — <Theme>`).

Where this sits in the system: the identifier is what every surface uses to
refer to an issue; the subject line is a **Publish-phase** input composed by
the retired Studio process (specs in git history). For the
per-section body formatting and the platform eras, see [`sections.md`](sections.md).

## The short identifier: `WT<NUM>`

`WT<NUM>` is the one canonical short way to refer to an issue — `WT347`, not `#347`,
not `Issue 347`, not `Weekly Thing 347`. It is what appears in page chrome, feed
metadata, podcast titles, the llms.txt index, archive Q&A answers, and Jamie's own
prose inside issues.

`<NUM>` is the issue's `number` (assigned by the content pipeline from the subject
line, or auto-numbered by date for early issues). Most numbers are plain integers;
a few special issues carry suffixed numbers like `140-special`. The identifier has
no leading zeros and no space (`WT347`, `WT9`).

The long form **`Weekly Thing <NUM>`** (no `#`) survives in exactly one place: the
wordmark line above the title on an issue page (`Weekly Thing 347 · May 17, 2026`).
Anywhere else that needs a short reference uses `WT<NUM>`.

URLs are unaffected — issue pages stay at `/archive/<NUM>/`, markdown at
`/archive/<NUM>.txt`, the per-issue links feed at `/archive/<NUM>/links.xml`. The
identifier convention is about the *text shown to people*, not the path scheme.

This convention is **forward-looking, not retroactive in spirit**: new prose written
today refers to an old issue as `WT100` even though that issue predates the
convention. But it is **not applied destructively to stored content** — see "Forward-only
for stored content" below.

## The email subject line: `WT<NUM> — <Theme>`

Future issues ship with a subject of the form:

```
WT<NUM> — <Theme Phrase>
```

- The prefix `WT<NUM> — ` is fixed (em-dash `—`, not a hyphen, not a slash).
- The **theme phrase** is a synthesized 3–6-word phrase capturing the issue's
  intellectual center of gravity — not just the headline of one link. Title case.
  No exclamation points, no question-mark subjects, no marketing phrasing, no
  buzzwords. The whole subject should ideally stay under ~50 characters so it
  survives mobile truncation around 40.
- **Digest fallback:** when an issue is a varied grab-bag with no single theme, the
  phrase is a comma-separated list of 2–3 distinctive nouns from the issue:
  `WT<NUM> — Scrum, FilamentHound, DO_NOT_TRACK`.
- **Special issues** (travel, anniversary, sponsor reveal, family content) use the
  special topic directly: `WT322 — Banff & Lake Louise`, `WT — Nine Year Anniversary`.

Examples: `WT347 — The Death of Scrum`, `WT347 — Value Over Token Consumption`,
`WT347 — Agentic Coding Is a Trap`.

### How subjects get generated

The workshop_bot `compose-meta` job runs Eddy's `prompts/eddy/compose-subject.md`
prompt, which returns 5 `WT<NUM> — <theme>` options to `#editorial`; Jamie reacts to
pick one (or 🔄 to refresh). The chosen string is written verbatim to the issue's
`metadata.json` and later sent verbatim to Buttondown by
`pipeline/content/content.py publish`. Edit the prompt if the style needs tuning;
nothing downstream reformats the subject. (If `metadata.json` somehow has no
subject, `content.py` falls back to `WT<NUM>` alone.)

### History: three eras of subject lines

The archive is not uniform — see [`sections.md`](sections.md) for the platform-era table. Roughly:

| Issues | Era | Subject shape |
|---|---|---|
| ~#1–#41 | Tinyletter | `Weekly Thing for May 13, 2017` and similar — no number, no separator |
| ~#42–#345 | MailChimp / Buttondown | `Weekly Thing 345 / Codex, Headless, Wikiwise` — `Weekly Thing <NUM> / <tokens>` |
| #347 onward | new convention | `WT347 — Headless Everything` |

Anything that processes subjects needs to handle all three (the issue-number parser
in `pipeline/content/process_emails.py` already does). The title-display logic on an
issue page derives the headline by taking everything after the **last** ` — ` (new)
or ` / ` (legacy) separator, falling back to the whole subject for separator-less
early issues — so `WT347 — Headless Everything` shows an H1 of `Headless Everything`,
and `Weekly Thing 345 / Codex, Headless, Wikiwise` shows `Codex, Headless, Wikiwise`.

## Where each form appears

| Surface | Form | Notes |
|---|---|---|
| Email subject (new issues) | `WT<NUM> — <Theme>` | `metadata.json` → Buttondown |
| Issue page `<title>`, `og:title`, `twitter:title` | the issue's `subject` verbatim | so new issues read `WT347 — …`; old issues keep their stored subject |
| Issue page eyebrow (wordmark line) | `Weekly Thing <NUM>` | the one long-form exception; no `#` |
| Issue page H1 | the theme/headline tail of `subject` | last `—`/`/` segment, see above |
| Issue page prev/next pager, "Links from …" feed link title | `WT<NUM>` | |
| Archive index cards (number badge / cover numeral) | `WT<NUM>` | |
| Home page "latest issue" stamp | `WT<NUM>` | |
| Topic pages, issue-card partial | `WT<NUM>` | |
| Atom feed (`feed.xml`, `rss.xml`) entry titles | the issue's `subject` verbatim | |
| Per-issue links feed (`/archive/N/links.xml`) `<title>` / `<subtitle>` | `Links from <subject>` / `Links featured in WT<NUM> …` | |
| Podcast feed (`podcast.xml`) episode `<title>` | `WT<NUM> — <Theme>` for new issues; legacy `#<NUM> — <tail>` for the pre-convention episodes | branches on whether `subject` starts with `WT`; `<itunes:episode>`/`<guid>` stay numeric |
| `llms.txt` issue list | `WT<NUM> — <Theme>` for new issues; legacy `#<NUM> — <subject>` otherwise | same per-issue branch |
| Archive Q&A — inline citations, hover tooltips | `WT<NUM>` | regardless of issue age; see below |
| Prose inside issues (Notable "discuss on Reddit" line excepted) | `WT<NUM>` | Jamie's own writing convention |
| `/archive/<NUM>/` and other URLs | bare `<NUM>` | path scheme, not a display form |

## Archive Q&A

Reader-facing archive answers should refer to issues as `WT<NUM>`, for any issue,
old or new. This is enforced at two layers:

- **Prompt:** `apps/librarian/lambda/prompts/answer-style.md` tells the model to cite
  inline as `WT295` or `(WT295, WT297)` — never a bare `#295` or "issue 295".
- **Post-processing (defense in depth):** the web chat (`apps/site/librarian.njk`)
  and the Discord bridge (`apps/workshop_bot/tools/thingy_render.py`) both match
  `WT<NNN>` *and* a legacy bare `#<NNN>` and normalize to `WT<NNN>` when rewriting a
  cited reference into a link (`[WT287](https://weekly.thingelstad.com/archive/287/)`).
  A reference with no matching citation is left exactly as written — a stray `#5`
  that isn't an issue number is never touched. The Lambda's citation-ordering pass
  (`apps/librarian/lambda/shared/citations.mts`) likewise recognizes both forms when sorting sources by mention
  order.

Note: the corpus-embedding and rerank context strings (`librarian-core`'s
`Weekly Thing #{n}: {subject}` chunk header, the matching header in
`apps/librarian/lambda/shared/retrieval.mts`)
still use the `#` form. That text is model-internal context, never shown to a user,
and rewriting it would force a paid re-embed for no benefit — so it's intentionally
left alone.

## Forward-only for stored content

The naming convention changed going forward; the historical archive is **immutable**.
Concretely:

- Never edit a past issue's stored `subject` — not in `apps/site/archive/*.md`
  frontmatter, not in `data/buttondown/bodies|emails/*`, not in `apps/site/_data/emails.json`,
  not in Buttondown. Do not bulk find-and-replace old subjects into the new format.
- The 10 pre-convention podcast episodes keep their existing `#<NUM> — <date/tail>`
  titles — podcast clients key on those. The `podcast.njk` per-issue branch exists
  precisely so re-rendering doesn't disturb them.
- llms.txt entries for past issues keep their `#<NUM> — <subject>` form.
- It is fine, and expected, that re-rendering the site restamps the *page chrome*
  (`#79` → `WT79` on `/archive/79/` and on archive cards). That's a template-level
  display string, not stored content — and it makes the short identifier consistent
  everywhere a reader sees it.

When in doubt: change the template/generator/prompt that produces *new* output;
leave stored and already-published content untouched.

## Open item

`apps/workshop_bot/jobs/update_draft.py`'s `_reddit_tag_line` still emits
`Weekly Thing <NUM> tag in r/WeeklyThing` with `flair_name=Weekly%20Thing%20<NUM>`,
because that has to match the actual r/WeeklyThing post-flair names. If those flairs
are ever renamed to `WT<NUM>`, update that line and the URL parameter to match.
