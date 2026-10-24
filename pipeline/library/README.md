# The library

The Librarian's archive is one SQLite file, `library.db`, at
`s3://weekly-thing-librarian/artifacts/library.db`. It holds the pulled copies
of every source, byte for byte, and everything the Librarian makes or measures
(photo descriptions, blog abstracts, the catalog). Git holds code only; `data/`
left git on 2026-10-22 and is now a working copy that `export` writes and
nobody commits. The sources keep the content and its history; the library is
the Librarian's copy. Plan: `docs/PLAN-2026-10-22-blog-steward.md`.

    uv run --locked python pipeline/library/library.py download   # .library/library.db + its ETag
    uv run --locked python pipeline/library/library.py export     # library -> data/
    uv run --locked python pipeline/library/library.py round      # download, export, pull, upload
    uv run --locked python pipeline/library/library.py stale      # which corpora need a build

`round` is the whole morning pull: the Library Agent runs it on the Mac, and
`.github/workflows/library-round.yml` runs it daily at 12:17 UTC, on demand,
and when a source publishes. Each run uploads only over the copy it
downloaded (an S3 conditional write), so two rounds never overwrite each
other: the loser starts again. The bucket keeps replaced copies for 30 days.

## The tree

`export` writes these, and `absorb` (the end of every pull) takes back only
the prefix of the source it pulled. A pull that would remove more than 10%
of a source's files (and more than 5) is refused.

| Path in `data/` | From | Notes |
|---|---|---|
| `blog/posts/`, `blog/pages/`, `blog/index.json` | micro.blog | `pipeline/blog/ingest_blog.py --prune`, a full walk; refused when it sees under 90% of the known posts. The pages' passages are the reference corpus's; their records, links and photos stay in the blog corpus |
| `weekly/archive/<n>.md` | weekly.thingelstad.com `apps/site/archive/` | the source of authority for issues, `audio_*` included |
| `issues/<n>/archive.md` | derived | the weekly page less its web-only keys and generated notice; what the corpus reads. Never edit it: the next export overwrites it |
| `site/about.njk`, `site/support.njk`, `site/_data/support.json` | weekly.thingelstad.com `apps/site/` | `site_page` grounding chunks (origin story, membership, nonprofit history), in the reference corpus |
| `podcast/another-thing/episodes/` | another.thingelstad.com `content/episodes/` | `pipeline/podcast/import_another_thing.py` |
| `things/things.json` | thingelstad.xyz/things.json | Things I've built, normalized by `pipeline/things/import_things.py`, in the reference corpus. The registry decides a thing's status; its observations are evidence, never a status |
| `reference/<name>.md` | this repo's `reference-documents/` on main | published documents about Jamie (a bio, a resume), checked and mirrored by `pipeline/reference/import_reference.py`; the repo is public, so these are public. A file deleted on main is deleted here |
| `reference-unpublished/<name>.md` | by hand, never git | documents about Jamie kept out of the public repo (old wiki pages, forum posts). No pull touches them; Jamie places them with `export`, `absorb`, `upload` (below). Still searched by the Librarian for every reader: unpublished is not hidden |
| `librarian/media-descriptions.json` | the Librarian | photo descriptions, `pipeline/corpus/describe_media.py` |
| `librarian/blog-abstracts.json` | the Librarian | `pipeline/blog/abstracts.py` |
| `librarian/readers.json` | derived | the reader numbers each corpus carries (`readers_export`); never absorbed |

`data/librarian/corpus.json`, `graph.json` and the other build outputs are
built from the tree and never enter the library. `reference_corpus.json`
reads `weekly/archive/` (for the archive's size, which the site pages and
the FAQ quote), `site/`, `things/`, `blog/pages/`, `reference/` and
`reference-unpublished/`; the Weekly Thing corpus no longer reads `site/`
or `things/`.

## Reader numbers

`round --only readers` (the Library Agent's round includes it; the GitHub
round never does, because the Tinylytics key is only on otto) reads each
site's raw hits from Tinylytics (`pipeline/library/tinylytics.py`) and keeps
counts only: views per site, path and US Central day (`reader_days`), and
each kudo's path and time (`kudos`). No visitor, referrer, country or browser
is kept. The first pull reads from the day Tinylytics began counting the
site; after that a round re-reads the last three days it holds, so hits
Tinylytics later drops as spam drop here too, and reads through yesterday.
`reader_months` is a view over the days. `reindex` rebuilds `reader_paths`,
which ties each counted path to its source and measure: an issue's
`/archive/<n>/` (and the old Buttondown slugs) are views, `/email/<n>/` email
opens, `/feed/<n>/` feed reads; a path two sources share stays unattributed.

`export` writes `librarian/readers.json`, and each corpus build carries its
part as `readers` (`librarian_core/library/readers.py`): views by month since
tracking began, by day for the last 90 days, email opens and feed reads for
issues, kudos with their days, and each site's `tracked_since`. A count is
never all time: the blog has been counted since 2024-07-09. The numbers are
part of each corpus's fingerprint, so a round that moved them makes the
corpora stale; the Lambda shows them in `get_source` and sorts `list_content`
by them (MCP 2.7.0). Search ranking never uses them.

## A fix to the archive

Fix it at the source and let the next round pull it: an issue in weekly's
archive page, a post on micro.blog, an episode in another.thingelstad.com, a
thing in thingelstad.xyz. To pull now:

    gh workflow run library-round.yml -f only=weekly

Something the Librarian made (a description, an abstract) is edited in the
exported tree and taken back with `library.py absorb`, then `upload`.

## Reference documents

The reference corpus (`build_reference_corpus`, built and uploaded like the
other three) is the base the Librarian consults on every search and no
caller selects: the site pages, the FAQ, Things I've built, the blog's pages
and the documents about Jamie. The documents come in two folders, one id
space (`doc-<name>`; a name in both fails the pull, the absorb, the index
and the build). Their front matter and how they are cut into passages (by
H2 section) are in `reference-documents/README.md`.

- **Published** (`reference/`): written in git under `reference-documents/`
  and merged to main. A push to main that touches that folder runs the round
  with `only=reference`; the morning round pulls it too.
- **Unpublished** (`reference-unpublished/`): for documents that must not be
  in the public repository or published as a page. Jamie's step, never an
  agent's (it uploads the library):

      uv run --locked python pipeline/library/library.py download
      uv run --locked python pipeline/library/library.py export
      # add, change or delete files in data/reference-unpublished/
      uv run --locked python pipeline/library/library.py absorb
      uv run --locked python pipeline/library/library.py upload

  `export` clears and rewrites that folder from the library, so keep the
  originals elsewhere and copy them in after it. `absorb` checks every
  reference document first and absorbs nothing if one is malformed. The
  upload moves the reference corpus's fingerprint, so the next round's
  `stale` starts the build, as a change on main does.

A candidate from the library plus any local folder, written nowhere but its
output (no S3, no git):

    uv run --locked python pipeline/library/library.py download
    uv run --locked python pipeline/library/library.py export
    uv run --locked python pipeline/corpus/build_reference.py \
        --unpublished-dir ~/somewhere/docs --output /tmp/reference_corpus.json

Add `--embed` to embed it with Bedrock (Cohere), as the deploy does; without
it the candidate has no vectors and a local search ranks by words alone.

## What starts a corpus build

Each corpus records, as S3 metadata on its artifact, the fingerprint of the
library files it was built from. `stale` compares that with the library and
`deploy.yml` builds what moved. From Friday until the issue is sent (Friday
and Saturday, US Central) nothing automatic changes the corpus: the round
still updates the library and the build waits, until WT Builder's send names
its issue (`repository_dispatch` `issue-sent`).
