# Plan: Thingy suggests related posts (2026-11-01)

**Status: steps 1 and 2 live (PR #103, MCP 2.10.0); step 3's job is built
and its 21-post sample waits on Jamie's review.** Nothing is written to micro.blog by this plan until Jamie
approves the writer (step 5).

## What Jamie decided

thing-hugo 2.0.39 (live 2026-11-01) draws up to three Related cards under a
post from `data/related.json` in the blog's custom root theme. A one-entry test
for Camelback is live. Jamie then asked for more than a title, and named who
should be speaking:

- "Can the related be more than just the title — either a short description or
  better why it is related?"
- "The librarian writing is the right idea but it should be Thingy not the
  librarian. This whole part can show up as Thingy suggesting related posts
  with context on each post page. It is then a super connected way back to
  Thingy and makes it clear "who" is talking."
- "If you find the related posts lacking you should feel free to change how
  Libearian is making those work. This would be the most extensive test and
  you can change librarian API, including updating the corpus."
- "Approved you can download the S3 corpus."

So the Librarian ranks candidates, Thingy chooses up to three and says why in
its own voice, and the theme shows them as Thingy's suggestions with a way into
Thingy.

## What the evaluation found

Measured on the live blog corpus (`artifacts/blog_corpus.json`, downloaded
2026-11-01: 10,491 posts and microposts, 115 pages; Cohere embed v3, 1024
dimensions) against `source_neighborhood`'s `related_sources`.

- **The lexical rule is the wrong tool for posts.** `related_sources` needs
  three shared distinctive words or picked domains, so a micropost with a photo
  and a sentence rarely has any, and long posts match on incidental words.
- **Embeddings find what the post is about.** Zuoz 2004 finds the 2023
  Pontresina hike; Kubb King finds the national championships; Hellweek finds
  the cycling posts; the IndieWeb posts find the IndieWeb Carnival; Things 4
  Good finds its results series. Camelback finds Gap of Dunloe, Flume Gorge and
  the Appalachian Trail.
- **Two weak spots.** Series crowding (every POAP claim finds the other POAP
  claims, every fundraiser update the others) and phrasing-only matches on
  very short posts ("Just ordered Kindle" finds "Got iPhone pre-ordered").
  Diversity in the ranking helps the first; Thingy's judgment handles both,
  and may choose none.
- **Scores are not comparable across posts.** The best match for Camelback
  scores about 0.50, a POAP claim about 0.88. Top-1 percentiles over every
  post, 5/10/25/50/75: 0.513 / 0.542 / 0.595 / 0.664 / 0.746. A fixed cut-off
  cannot decide what is good enough; it can only drop the obviously unrelated.

| Floor | Posts with 3 candidates above it | Posts with none |
| --- | --- | --- |
| 0.45 | 98% | 1% |
| 0.50 | 89% | 3% |
| 0.55 | 72% | 12% |
| 0.60 | 49% | 27% |

The floor is 0.45: it keeps candidates for nearly every post and leaves the
real decision to Thingy.

## The design

1. **Librarian corpus: `similar_posts` on each blog post** (this repo,
   `librarian_core/related_posts.py`, run by `upload_blog_corpus.py` after
   embedding, so the corpus gate checks it like everything else). For each
   post and micropost (pages are undated reference and take no part):
   - the post's vector is the mean of its chunk embeddings, normalised;
   - other posts from the same trip are left out (a trip is a category that
     names a year, "Arizona 2026"): the theme already links a trip's days, and
     its Keep going pick covers them;
   - at most one post from each other trip;
   - maximal marginal relevance over the 60 nearest (lambda 0.75), so the ten
     candidates are not ten posts of one series;
   - cosine floor 0.45, up to 10 candidates, stored as
     `similar_posts: [{microblog_id, score}]`, in pick order.
   numpy joins librarian-core's dependencies (it was only transitive).
2. **Librarian API: `source_neighborhood` returns `similar_posts`** for a blog
   post, resolved like `similar_issues`: id, label, subject, date, url,
   abstract, categories, score. MCP 2.10.0. Thingy's chat gets it for free
   ("what else did Jamie write like this?").
3. **Thingy's picks.** A job gives Thingy's model each post (title, date,
   abstract, categories, opening text) and its candidates (the same fields),
   with Thingy's voice from `prompts/agent-system.md`. Thingy chooses up to
   three, each with a why line (the prompt asks for 100 characters; up to 110
   is fine, up to 140 is kept and flagged, under 30 is dropped), and may choose
   none. Rules: say only what the two posts show (no invented connection);
   prefer variety; at most one from a series; refer to Jamie as he/him, as the
   chat does. The output is a sidecar keyed by microblog id with a hash of its
   inputs, so an unchanged post is never asked again.
   - Thingy's words never enter the corpus (a hard constraint): the sidecar
     lives beside it in S3, not in any chunk.
   - **First run: 21 posts, then stop for Jamie's review** (Camelback,
     Kubb King, the back-scratcher, Zuoz, a POAP claim, the Kindle order,
     espresso, Weekly Thing GPT, IndieWeb, Things 4 Good, a Mazie birthday,
     Hellweek, and more across the years and kinds). Only after Jamie's go
     does it run over the blog. `pipeline/blog/thingy_related.py`, Opus 5.5 at
     medium effort: $0.39 for the 21 (about $0.019 a post, so about $200 for
     the blog asked directly, about $100 through the Batches API). Thingy
     chose 3 for 15 posts, 2 for 3, 1 for 2, and none for the back-scratcher
     (one candidate). One first-run answer was a one-letter line, now refused
     and asked again. Review page: `www.thingelstad.com/design/prototypes/
     thingy-related/review/` (local, not published).
4. **Theme: Thingy's panel** (thing-hugo, a separate release). `data/related.json`
   entries become `{url, why}`; the panel is headed as Thingy's, each pick shows
   its why line, and the panel ends with a link into Thingy about the post. A
   mock is on the local `thingy-related-mock` branch.
5. **The writer** (needs its own approval line): deterministic infra, never an
   agent, writes `data/related.json` to the custom root theme through the
   Themes API after the picks change. Its file size limit on micro.blog is
   still unknown (about 5 MB for every post).

## Open calls for Jamie

- The heading ("Thingy suggests") and whether the "Explore with Thingy" pill
  stays beside the panel's own link into Thingy.
- Same-trip posts stay out (the trip navigation covers them)?
- Posts only, or Weekly Thing issues and Another Thing episodes as
  suggestions too?
- Does the panel replace Keep going's category pick?
