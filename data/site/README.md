# Site grounding snapshots

Copies of the weekly.thingelstad.com pages the Librarian corpus embeds as
`site_page` grounding chunks (origin story, supporting membership, nonprofit
history). The render templates moved to the `weekly.thingelstad.com` repo in
the 2026-08 split; the corpus build must stay self-contained, so it reads
these snapshots instead of reaching across repos.

When `/about/` or `/members/` change meaningfully, re-copy:

    cp ../weekly.thingelstad.com/apps/site/{about,support}.njk data/site/
    cp ../weekly.thingelstad.com/apps/site/_data/support.json data/site/_data/

These pages change rarely; drift here costs grounding freshness, not
correctness of published content.
