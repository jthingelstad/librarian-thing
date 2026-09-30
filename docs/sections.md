# Sections

What's in an issue, in reading order, and how each part is formatted. The authoritative assembly is
`tools/renderers.py:_compose_published_body` — every channel composes from this one shape.

## Reading order

| # | Section | Heading | Source | Required? |
|---|---|---|---|---|
| 1 | Intro | (none — prose) | `intro.md` (Jamie, Studio editor) | ✅ |
| 2 | Currently | `## Currently` | `currently_entries` DB (`/eddy currently`) | optional |
| 3 | Cover | (image + caption) | `cover.json` + `cover.jpg` (Jamie, Studio) | ✅ |
| 4 | Notable | `## Notable` | Pinboard bookmarks in-window, untagged | ✅ (≥1 of the 3 lists) |
| 5 | Journal | `## Journal` | micro.blog posts in-window — see [`journal-handling.md`](journal-handling.md) | ✅ |
| 6 | Briefly | `## Briefly` | Pinboard bookmarks tagged `_brief` | ✅ |
| 7 | Outro | (none — prose) | `outro.md` (Jamie, Studio editor) | optional |
| 8 | Haiku | (bold tercet) | `haiku.md` (`compose-haiku`, Jamie picks) | ✅ |
| 9 | Echoes | `## Echoes` | `echoes.md` — see [`echoes.md`](echoes.md) | ✅ |

**Featured** posts splice in before Notable — see [`featured-posts.md`](featured-posts.md). 

The trailer after Haiku is Echoes → "discuss on Reddit" line → `👨‍💻`.

## Per-section formatting

- **Notable** — for eamil only, leads with the Reddit-tag line (`_You can discuss any of these links at the Weekly
  Thing {N} tag…_`), then items. Each item: `### [Title](url)` then a blank line then commentary.
  **Two blank lines between items.**
- **Briefly** — commentary first, then the link, bolded: `{commentary} → **[Title](url)**`. No
  headings. **One blank line between items.**
- **Journal** — status update: `[Weekday @ H:MM AM/PM](url)` + content. Titled post (elevated):
  `### [Title](url)` + content. Weekday only (no date — the whole issue
  is one 7-day window). **Two blank lines between entries.** Details in
  [`journal-handling.md`](journal-handling.md).
- **Haiku** — `**line one  \nline two  \nline three**` (bold, hard breaks).

## A note on eras

Section names aren't uniform across the back catalog, but the structure is: 351 of the 352 issues in
`data/issues/` have H2 sections (the exception is the 140-special edition).

| Issues | Platform | Section traits |
|---|---|---|
| #1–~52 | Tinyletter | emoji H2s (`## Links 📌`, `## Photog 📷`, `## Microblog updates 🎈`); #39–49 file links under topic H2s (`## Tech`, `## Business`) |
| #~52–130 | MailChimp | emoji-suffixed headings (`## Featured Links 🏅`, `## Notable Links 📌`, `## Yet More Links 🍞`, `## Microposts 🎈`) |
| #131–187 | Buttondown | `## Must Read` / `## Recommended Links` / `## FYI`; the Journal is `Status Updates`, then `Stream`, then `Journal` |
| #188+ | Buttondown | canonical `## Featured` / `## Notable` / `## Journal` / `## Briefly`; H3-under-H2 links |

The corpus maps every era's name onto one **section family** (`SECTION_FAMILIES` in
`librarian_core/links.py`): Featured, Notable, Briefly, FYI, Journal, Currently, Photo, Fortune,
Reply All, Straw Poll, Give Back, Support, App, Yearly Thing, plus Intro for the prose before the
first heading. A heading no era used as a section is its own family. Chunks, section records and
link records carry `section_family`; an H3 item keeps its own title as `section`.
