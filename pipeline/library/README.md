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
| `blog/posts/`, `blog/pages/`, `blog/index.json` | micro.blog | `pipeline/blog/ingest_blog.py --prune`, a full walk; refused when it sees under 90% of the known posts |
| `weekly/archive/<n>.md` | weekly.thingelstad.com `apps/site/archive/` | the source of authority for issues, `audio_*` included |
| `issues/<n>/archive.md` | derived | the weekly page less its web-only keys and generated notice; what the corpus reads. Never edit it: the next export overwrites it |
| `site/about.njk`, `site/support.njk`, `site/_data/support.json` | weekly.thingelstad.com `apps/site/` | `site_page` grounding chunks (origin story, membership, nonprofit history) |
| `podcast/another-thing/episodes/` | another.thingelstad.com `content/episodes/` | `pipeline/podcast/import_another_thing.py` |
| `things/things.json` | thingelstad.xyz/things.json | Things I've built, normalized by `pipeline/things/import_things.py`. The registry decides a thing's status; its observations are evidence, never a status |
| `librarian/media-descriptions.json` | the Librarian | photo descriptions, `pipeline/corpus/describe_media.py` |
| `librarian/blog-abstracts.json` | the Librarian | `pipeline/blog/abstracts.py` |

`data/librarian/corpus.json`, `graph.json` and the other build outputs are
built from the tree and never enter the library.

## A fix to the archive

Fix it at the source and let the next round pull it: an issue in weekly's
archive page, a post on micro.blog, an episode in another.thingelstad.com, a
thing in thingelstad.xyz. To pull now:

    gh workflow run library-round.yml -f only=weekly

Something the Librarian made (a description, an abstract) is edited in the
exported tree and taken back with `library.py absorb`, then `upload`.

## What starts a corpus build

Each corpus records, as S3 metadata on its artifact, the fingerprint of the
library files it was built from. `stale` compares that with the library and
`deploy.yml` builds what moved. From Friday until the issue is sent (Friday
and Saturday, US Central) nothing automatic changes the corpus: the round
still updates the library and the build waits, until WT Builder's send names
its issue (`repository_dispatch` `issue-sent`).
