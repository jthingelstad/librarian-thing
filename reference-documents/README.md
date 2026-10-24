# Reference documents

Documents about Jamie (a bio, a resume, older writing, anything else that is
"about me") that the Librarian should always know. They join the reference
base: the Weekly Thing's site pages and FAQ, Things I've built, and
thingelstad.com's pages. The Librarian consults the reference base on every
search, whatever the reader's scope or source filter, and no caller can
select or exclude it. Nothing in it is dated, so on this day, latest
content, timelines, eras and year counts never show it, even a document
with a `date`.

## Two folders: published and unpublished

This repository is **public**. Everything in this folder is published the
moment it is pushed, to GitHub and to anyone who reads the repository.

| Folder | For | How it reaches the library |
| --- | --- | --- |
| `reference-documents/` (this folder, in git) | Documents that can be public: a bio, a resume, anything already published. | Merge to main; the library round pulls main's copy into the library's `reference/`. |
| `reference-unpublished/` (in the library only, never in git) | Documents that must not be in the public repository or published as a page: old personal wiki pages, forum posts, a life timeline with family names. | Placed in the library by hand (below). No round pulls, changes or removes it. |

**Unpublished is not hidden.** The Librarian searches both folders for every
reader, member or guest, and quotes and cites what it finds there. An
unpublished document is only kept out of git and off the web as a page of
its own. Do not put anything in either folder that the Librarian should
not say to a reader.

Both folders are one id space: a name in both (`bio.md` here and
`bio.md` unpublished) fails the round, the absorb and the build.

## Writing a document

One Markdown file per document (no subfolders). The file name is its id:
lowercase letters, digits and hyphens, ending in `.md`. `resume.md` is
fetched as `doc-resume` and cited by its title.

```markdown
---
title: Family weekends
updated: 2026-10-23
source: wiki.thingelstad.com (personal wiki, 2010-2015)
date: 2011-09-29
---

What the page said before its first heading.

## Lake weekends

_2011-07-04_

The text of this section, in Markdown.

## Winter weekends

...
```

| Field | | |
| --- | --- | --- |
| `title` | required | The name the Librarian cites the document by. |
| `updated` | required | The day the document was last revised, `YYYY-MM-DD`. |
| `url` | optional | A public address for the document, if one exists. Leave it out for a document that is not published anywhere; the citation then has no link. |
| `source` | optional | Free text: where the document came from, e.g. `wiki.thingelstad.com (personal wiki, 2010-2015)` or `Ponder group export (Nov-Dec 2025)`. Carried on every passage, so the Librarian can say where a fact came from ("from Jamie's 2011 wiki"). |
| `date` | optional | The document's own date, when it was first written, `YYYY-MM-DD`. Citation metadata only: the document stays undated for every date tool. |

No other front matter is accepted, and the text below it must not be
empty. Write the text as Jamie would want it quoted: the Librarian treats a
document as Jamie's own words.

### How a document is cut into passages

By its H2 sections. The text before the first `## ` heading is one passage
(its section is the document's title), then each `## ` heading starts the
next, and its passage's section is that heading. `#` and `###` headings stay
inside their section; a `## ` line inside a code fence is code. A section
too long for one passage (about 2,000 characters or 400 words with its
heading) is split the way site pages are, each piece after the first
opening with the last sixty or so words of the one before. So a forum export is best written one thread per
H2, with the thread's date on its first line. Every passage carries the
document's title, its section heading, `source` and `date`. Nothing assumes
a document is short.

## Adding or changing a published document

Edit this folder and merge to main. The library round
(`pipeline/library/library.py`, source `reference`, every morning and on
every push to main that touches this folder) pulls main's copy, and
`pipeline/reference/import_reference.py` checks every document on the way.
When the reference corpus's inputs move, the round starts the corpus build
(`build_reference_corpus` in `librarian-core/librarian_core/corpus.py`), and
the Librarian serves the new corpus after the deploy. Deleting a file here
deletes the document from the library on the next round.
`make librarian-reference-import` runs the same check locally and copies the
folder into `data/reference/`.

## Adding or changing an unpublished document

Jamie's step, from a checkout with the library's AWS access; never an
agent's. Keep the originals somewhere outside `data/`: an export clears and
rewrites `data/reference-unpublished/` from the library.

```sh
uv run --locked python pipeline/library/library.py download
uv run --locked python pipeline/library/library.py export
# copy, change or delete files in data/reference-unpublished/
uv run --locked python pipeline/corpus/build_reference.py --output /tmp/reference_corpus.json  # optional local check
uv run --locked python pipeline/library/library.py absorb
uv run --locked python pipeline/library/library.py upload
```

`absorb` checks every reference document first and absorbs nothing if one
is malformed. The upload counts as a change to the reference corpus's
inputs: the next library round (each morning at 12:17 UTC, which is 07:17
Central in daylight time and 06:17 in standard time, or run the Library
Round workflow, `library-round.yml`, from the Actions tab with only
`reference`) sees
the library has moved past the live corpus and starts the build, like a
change on main. On a Friday or Saturday the build waits for the send, as
every automatic build does. Removing more than a tenth of the folder at
once needs `absorb --allow-removals`.

## When a document is refused

A malformed document (no title, an `updated` or `date` that is not a day,
a `source` that is not text, an unknown field, a file name with capitals or
spaces, Windows line endings, a file that is not Markdown, headings with no
text under any of them) fails the round, the absorb and the build with the
file's name, and nothing changes until it is fixed. The round and the build
run in GitHub Actions, whose logs are public: a refused unpublished
document's file name (never its text) can appear there, so name files
plainly.

This README is never a document.
