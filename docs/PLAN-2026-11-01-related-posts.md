# Plan: Thingy suggests related posts (2026-11-01)

**Status: steps 1 and 2 live (PR #103, MCP 2.10.0); step 3's job is built
(Sonnet, Batches API) and its 21-post sample waits on Jamie's review.** Nothing is written to micro.blog by this plan until Jamie
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
   kind, categories and its whole text with photo alt text and captions, up to
   6,000 characters, so 99.4% of posts whole) and its candidates (the same, up
   to 1,500 characters, 92% whole, plus a generated summary for a long one),
   with Thingy's voice. Thingy chooses up to three, or none, and for each gives
   evidence (words copied from the other post) and a line of at most 16 words.
   Rules: say only what the posts show; never a reason the posts don't state;
   prefer variety; at most one from a series; he/him for Jamie. The output is
   a sidecar keyed by microblog id with a hash of its inputs, so an unchanged
   post is never asked again.
   - The job checks every line and drops one that does not hold: evidence not
     in the other post, a number in neither post (or not the years between
     them), a line outside 30 to 125 characters, or one that does not end as a
     sentence (Sonnet once let JSON into a line). A dropped line asks Thingy
     again, once, directly.
   - Thingy's words never enter the corpus (a hard constraint): the sidecar
     lives beside it in S3, not in any chunk.
   - **Model: Sonnet 5.5 at medium effort through the Batches API** (Jamie,
     2026-11-01: "Opus seems like overkill for this. Try sonnet and use the
     batch api."). On the 21 sample posts, with the same inputs:
     - Sonnet v3 (this job): $0.13, every post answered, every claim checked
       held, 3 lines between 110 and 125 characters, no "Another" openers.
     - Sonnet at high effort: about as many tokens, more "Another" openers
       and a weaker pick (a ride chosen for its GPS map).
     - Opus at medium: accurate lines, but on 4 of 21 posts it wrote a
       placeholder ("x"), and on 3 of those kept thinking until the token
       limit, all of it billed. The cap is now 4,000 tokens (an answer takes
       about 200).
   - The whole blog: 10,417 posts with candidates (74 have none), in parts of
     2,000 requests (a batch is capped at 256 MB). Projected from the
     sample's tokens: about $40 to $52 batched plus about $10 of direct
     retries.
   - **First run: 21 posts, then stop for Jamie's review** (Camelback,
     Kubb King, the back-scratcher, Zuoz, a POAP claim, the Kindle order,
     espresso, Weekly Thing GPT, IndieWeb, Things 4 Good, a Mazie birthday,
     Hellweek, and more across the years and kinds). Only after Jamie's go
     does it run over the blog. Review page: `www.thingelstad.com/design/
     prototypes/thingy-related/review/` (local, not published).
4. **Theme: Thingy's panel** (thing-hugo, a separate release). `data/related.json`
   entries become `{url, why}`; the panel is headed as Thingy's, each pick shows
   its why line, and the panel ends with a link into Thingy about the post. A
   mock is on the local `thingy-related-mock` branch.
5. **The writer** (needs its own approval line): deterministic infra, never an
   agent, writes `data/related.json` to the custom root theme through the
   Themes API after the picks change. Its file size limit on micro.blog is
   still unknown (about 5 MB for every post).

## Open calls for Jamie

Jamie, 2026-11-01: "I envision Thingy's image being on each post and we
probably dump the other post to post navigation and only use this." What that
touches, under a post today: the trip card (1,585 posts are on a trip), the
Weekly Thing card, Related, Keep going (a category pick), Earlier / Later.

- Keep going and Earlier / Later go; the Thingy panel is the way onward.
- The trip card: same-trip posts are left out of Thingy's candidates because
  the card links a trip's days. If the card goes too, they must come back in.
- A post with no picks (about 1 in 20, and the 74 with no candidates) and a
  new post before the next run: the panel still shows Thingy's image and the
  link into Thingy, so every post has it.
- The Weekly Thing card is not navigation and stays.
- The heading ("Thingy suggests") and whether the "Explore with Thingy" pill
  stays beside the panel's own link into Thingy.
- Posts only, or Weekly Thing issues and Another Thing episodes as
  suggestions too?
