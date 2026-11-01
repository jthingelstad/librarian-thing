# Plan: meaning-based retrieval and the embedding problem (2026-11-01)

**Status: measured. This PR makes a model switch safe and adds the eval;
the switch to Embed v4 is the next PR (What ships).**

## What was asked

Make the Librarian's meaning-based retrieval as good as possible, starting
with the embedding problem: map every producer and consumer of embeddings,
measure before changing anything, try Embed v4 and chunking, ship through the
corpus gate, and report how `similar_posts` changed for 21 posts. PR #104
(Thingy's related-post picks) waits on this ("We need to fix that embedding
problem first") and is not touched here. Photo embeddings are out of scope
(recommendation at the end).

## What was tried before, and what this does differently

| When | Commit | What |
| --- | --- | --- |
| 2026-08-29 | aa8e23cf | Chunks 260 → 400 words with a 60-word overlap; the embed header gained the date and the abstract and lost Topics; `embed_recipe` versions the input. |
| 2026-08-29 | 2f9f10a5 | Reciprocal-rank fusion of the lexical and semantic legs, filters inside the scan, rerank pool 40 → 100. |
| 2026-09-29 | d017bd17 | Verbatim overlap lead-ins. |
| 2026-09-30 | 222062d9 | Chunks sized to v3's 2,048-character budget: 84,453 Weekly Thing words had been in no embedding. |
| 2026-10-01 | 0f183603 | Count the inputs past v3's 512 tokens and warn. "Re-chunking by tokens is the real fix and moves chunk ids, so not tonight." |
| 2026-10-22 | afc730c6 | The embedding cache matches the embed input, not just the chunk id. |
| 2026-11-01 | 40b529f7 | `similar_posts` (MCP 2.10.0), on v3. |

Every step so far fitted the text to v3. Nobody had measured meaning
retrieval: the tool eval's queries share their key words with the answer, so
the lexical leg finds them and the semantic leg is never tested. No one had
tried v4. The note in `apps/librarian/AGENTS.md` ("re-embed cost is $1-2 + ~3
minutes") was a guess, and its time half is wrong (quotas below).

This plan measures first, with questions keyword search cannot answer, and
changes the model only where the numbers say so. It also fixes the reason a
model change was dangerous: the Lambda assumed every corpus shared one model.

## The map: who makes embeddings and who reads them

Producers (all through `librarian_core.corpus.fetch_bedrock_embeddings`):

- `pipeline/deploy/upload_corpus.py` (Weekly Thing), `upload_blog_corpus.py`,
  `upload_podcast_corpus.py`, `upload_reference_corpus.py`,
  `upload_links_corpus.py`: CI's corpus builds, with `--stage` for the gate.
  Each reuses the live corpus's vectors when the model, the dimensions, the
  `embed_recipe` and the chunk's embed input all match
  (`build_chunk_cache`, `merge_cached_embeddings`), so a model change is a full
  re-embed and nothing mixes.
- `pipeline/corpus/build.py --embed`, `build_links.py --embed`: local builds.
- `pipeline/eval/embed_variant.py` (new): the eval's own vectors, written
  beside the corpora, never into them.

Readers:

- **The Lambda** (`lambda/shared/retrieval.mts`): the query is embedded and
  scored by cosine against every chunk (`semanticScore`); the loader keeps the
  vectors as `Float64Array` (`corpus-loader.mts`). `/health` and `/retrieve`
  report `embedding_model`.
- **graph.json** (`librarian_core/graph.py`): `similar_issues`, each issue's
  six nearest by mean chunk vector, built in the WT upload and pushed to
  weekly.thingelstad.com's topic pages. A top-k with no threshold, so nothing
  to recalibrate.
- **similar_posts** (`librarian_core/related_posts.py`): each blog post's
  nearest posts, with a cosine floor of 0.45 tuned on v3. `source_neighborhood`
  serves them (MCP 2.10.0) and PR #104 reads them.
- **The corpus gate** (`pipeline/corpus/corpus_gate.py`): the truncation
  report counted inputs past v3's cap whatever the corpus's model.
- **The evals**: `eval-tools.mjs` (CI, over the candidates), `golden-retrieval.mjs`
  (live).
- **Clients**: WT Builder and AT Builder call `/retrieve`; the response's
  `embedding_model` is a string no client reads.

What a model mismatch did before this change:

- The Lambda embedded the query once, with the first embedded corpus's
  model, and reused that vector for every other corpus. A corpus on another
  model with another length scored every chunk 0 (`cosine` returns 0 on a
  length mismatch): its semantic leg went empty, silently, and lexical carried
  on. A corpus on another model with the same length (v4 at 1024 beside v3)
  was scored with a foreign vector: wrong order, no error.
- That window is real during a switch: CI uploads the corpora one after
  another before the deploy, and the corpus gate reads the live copy of any
  corpus a run did not rebuild (`EVAL_CORPUS_FALLBACK=s3`).
- `similar_posts`' floor would have cut a different share of candidates.
- The gate would have reported v3 truncation for a v4 corpus.

## The meaning eval

`pipeline/eval/build_meaning_set.py` writes questions with known answers
from the live corpora; `apps/librarian/lambda/scripts/eval-meaning.mjs` runs
the real `retrieve()` over them, four ways: lexical alone, semantic alone,
both fused, fused then reranked.

- **paraphrase** (140): the passage's idea in other words. A question that
  reuses a word rare in the corpus (in under 2% of chunks) and present in the
  target source is refused.
- **tail** (63): a paraphrase about text past token 515 of a chunk whose embed
  input runs past v3's 512 tokens, so v3 never read it.
- **direct** (79): the question a reader would type, names and all.

Every question carries a quote checked against the passage, so a hit is
judged by source (the issue, post, link, page, document, thing or episode)
and by span (a returned chunk holds the quote); both survive re-chunking. The
reranked mode also records where the answer sat in the reranker's pool.
266 questions are public (`apps/librarian/lambda/eval/meaning-set.json`); 16
about the unpublished reference documents stay in `tmp/`, never in git.
Query embeddings and rerank answers are cached in `tmp/eval/bedrock-cache/`,
keyed on the whole request, so a rerun costs nothing.

Generation cost $2.89 (Claude on Bedrock, 679k tokens in). A hand check of 30
questions found 27 clean, 3 weak but answerable from the passage, none wrong.

## Baseline: v3 as it runs today

Source MRR, all 282 questions:

| Questions | Lexical | Semantic | Fused | Reranked |
| --- | --- | --- | --- | --- |
| paraphrase (140) | 0.11 | 0.36 | 0.26 | 0.56 |
| tail (63) | 0.03 | 0.17 | 0.10 | 0.30 |
| direct (79) | 0.72 | 0.77 | 0.82 | 0.97 |
| all (282) | 0.26 | 0.43 | 0.38 | 0.62 |

Reranked, per corpus (MRR / recall@10 / the answer reached the reranker):

| Corpus | v3 |
| --- | --- |
| Weekly Thing (77) | 0.53 / 68% / 71% |
| blog (85) | 0.51 / 64% / 75% |
| reference (35) | 0.65 / 77% / 86% |
| links (60) | 0.75 / 78% / 80% |
| podcast (9) | 0.76 / 100% / 100% |
| documents (16) | 0.94 / 100% / 100% |
| all (282) | 0.62 / 73% / 79% |

What the baseline says:

- **The reranker is not the bottleneck.** Recall@20 after the rerank is 76%,
  and the answer reaches the reranker's pool 79% of the time (tail 48%,
  paraphrase 81%, direct 100%). It orders what it is given well; what it is
  not given it cannot find. The lever is the pool: the embeddings and the
  fusion.
- **Fusion costs paraphrases.** Fused (0.26) is below semantic alone (0.36) on
  paraphrase questions: the lexical leg fills half the pool with chunks that
  share incidental words.
- **Words lost to v3's cut are few.** Weekly Thing 0.55% of words, blog 0.30%,
  reference 1.5%, links 2.0% (the link note's character cut). The earlier
  "42% of reference inputs" counted inputs over 512 tokens, not words lost;
  the overlap lead-ins carry most of what is cut into the next chunk. The tail
  questions are those words, and v3 answers them worst.

## Fusion on v3

Reranked source MRR / recall@20 / pool recall, all questions:

| Variant | MRR | R@20 | Pool | Tail MRR / pool | Cost a run |
| --- | --- | --- | --- | --- | --- |
| today (RRF, equal weights, pool 100) | 0.62 | 76% | 79% | 0.30 / 48% | $0.56 |
| lexical weight 0.5 | 0.63 | 78% | 82% | 0.32 / 52% | $0.56 |
| lexical weight 0 (semantic-only pool) | 0.63 | 78% | 83% | 0.37 / 59% | $0.56 |
| pool 200 | 0.64 | 79% | 85% | 0.38 / 60% | $1.13 |

Fusion moves v3 a little. Dropping the lexical leg costs direct questions
(0.97 → 0.94), so it is not free.

## Embed v4

The whole archive embedded once on v4 at 1536 (`embed_variant.py`, $0.89).
v4's shorter vectors are the leading part of the 1536, so one embed measures
every length; its int8 vectors came back in the same call.

All questions, source MRR (reranked recall@10 and pool recall after the
slash):

| Variant | Semantic | Fused | Reranked |
| --- | --- | --- | --- |
| v3 (today) | 0.43 | 0.38 | 0.62 / 73% / 79% |
| v4 1536 | 0.53 | 0.41 | 0.64 / 76% / 83% |
| v4 1024 | 0.52 | 0.40 | 0.64 / 76% / 83% |
| v4 512 | 0.50 | | 0.62 / 75% / 80% |
| v4 256 | 0.46 | | 0.62 / 74% / 79% |
| v4 1536 int8 | 0.52 | | 0.64 / 76% / 83% |
| v4 1024, query embedded as a document | 0.55 | 0.41 | 0.65 / 76% / 84% |

- **v4 is better at meaning in every corpus.** Semantic alone, MRR: Weekly
  Thing 0.29 → 0.35, blog 0.43 → 0.50, reference 0.50 → 0.59, links
  0.53 → 0.62, podcast 0.71 → 0.94, documents 0.50 → 0.62. Paraphrases
  0.36 → 0.47, the words past v3's cut 0.17 → 0.24.
- **The reranker shrinks the gain to two points** (0.62 → 0.64), because it
  already rescues most of what v3 misses. More answers reach it (79% → 83%).
- **1024 is the length.** 1536 is within noise of it (0.53 vs 0.52 semantic,
  the same reranked); 512 and 256 cost two points reranked. 1024 is also
  v3's length, so the vectors take the same memory.
- **int8 scores as float does.** Worth it later for memory (What's left), not
  needed for quality.
- **Embed the query as a document.** Cohere's guidance is `search_query`
  for queries; `search_document` scored better on this set: semantic better on
  46 questions and worse on 18 (sign test p = 0.001), reranked better on 15
  and worse on 5 (p = 0.04). Every question here is a full question, so it
  is not an artifact of statement-shaped queries. Query side only, no
  re-embed.
- **Weekly Thing is the one corpus v4 does not lift after the rerank**
  (0.53 → 0.51; 0.53 with the query as a document). Its answers reach the
  reranker 73% of the time, the lowest of any corpus.

Chunking, Weekly Thing only (the corpus with the most text past v3's cut):

| Variant | Tokens embedded | Semantic | Reranked | WT reranked / pool |
| --- | --- | --- | --- | --- |
| v3, chunks as today | | 0.43 | 0.62 | 0.53 / 71% |
| v3, chunks sized to 512 tokens | 2.87M ($0.29) | 0.43 | 0.62 | 0.54 / 73% |
| v4, chunks as today | | 0.52 | 0.64 | 0.51 / 73% |
| v4, chunks twice as long | 0.99M ($0.12) | 0.51 | 0.64 | 0.50 / 74% |

Neither re-chunk moves the reranked score, and longer v4 chunks make Weekly
Thing's semantic leg worse (0.35 → 0.32). Re-chunking also moves every chunk
id. Chunking stays as it is.

Fusion on v4 at 1024 (reranked MRR / recall@10 / pool recall):

| Variant | Fused | Reranked | Tail pool |
| --- | --- | --- | --- |
| today (equal weights, pool 100) | 0.40 | 0.64 / 76% / 83% | 51% |
| lexical weight 0.5 | 0.45 | 0.64 / 75% / 85% | 57% |
| lexical weight 0 | 0.52 | 0.63 / 75% / 85% | |
| pool 200 | 0.40 | 0.64 / 77% / 88% | 62% |
| lexical 0.5 and pool 200 | 0.45 | 0.64 / 76% / 88% | 60% |

The pool finds more answers but the reranker does not lift them into the top
ten: the reranked score is 0.64 in every variant, and pool 200 doubles the
rerank cost. Dropping the lexical leg costs direct questions (0.95 → 0.93).
The fusion defaults stay. The fused order improving with less lexical weight
says the lexical leg itself is weak (What's left).

## Quotas and cost

- Embed v4 (`cohere.embed-v4:0`) on demand: 150,000 tokens a minute and 8.1M a
  day, neither adjustable. Its cross-region profile `us.cohere.embed-v4:0`
  (us-east-1, us-east-2, us-west-2): 300,000 a minute (adjustable) and 16.2M a
  day. The first eval run, on demand, was throttled after 4,608 Weekly Thing
  chunks; the rest ran on the profile. Vectors from the two agree to cosine
  0.9998.
- The whole archive is 7.44M tokens on v4 (measured: Weekly Thing 3.16M, blog
  1.98M, links 1.93M, reference 0.36M, podcast 3k). At $0.12 a million that
  is $0.89, and under the 300,000-a-minute limit at least 25 minutes (27 at the
  build's pace). The eval's own whole-archive embed cost exactly that. The builds now pace
  v4 under 280,000 a minute (estimated at 3.5 characters a token; Weekly Thing
  measured 3.66) and wait
  out a throttle, and the CI job's ceiling is 120 minutes, up from 60 (a run
  takes about 20 minutes before any re-embed).
- v3 costs $0.10 a million and has never hit a limit.

## What ships

**This PR (no change in what readers get; every corpus stays on v3):**

- Each corpus's own model and length pick its query vector: the Lambda embeds
  the query once per signature (`embeddingSignature`), never reuses one
  corpus's vector for another, and refuses a vector of the wrong length. The
  corpora can switch one at a time.
- `/health` and `/retrieve` report the loaded corpora's model, not the
  environment's default (comma-joined only while a switch is part way).
- Embed v4 in the builds: its request and response shapes, pacing under
  280,000 tokens a minute, waiting out a throttle, and a CI ceiling of 120
  minutes.
- The truncation report counts against the corpus model's own limit.
- v4's Bedrock grants, through the stack (the Lambda role) and the reviewed
  OIDC files (`deploy.json`, `runtime-boundary.json`), which Jamie applies.
- The meaning eval: the question set, its builder, `eval-meaning.mjs`, and
  `embed_variant.py`.

**The switch (next PR, once the grants are live and a day's v4 quota is
free):** v4 at 1024 for every corpus; the query embedded as a document on
v4; `SIMILAR_POSTS_FLOOR` 0.45 → 0.4365, which keeps the same 95.7% share of
each post's ten nearest; MCP 2.10.0 → 2.11.0; graph.json and similar_posts
rebuilt by the same run. CI re-embeds everything (7.4M tokens, $0.89, about
25 minutes), and the corpus gate stages, evaluates and promotes it like any
build. No change to `/retrieve`'s shape.

## similar_posts for the 21 posts

v3 against v4 at 1024 with the recalibrated floor. 100 of the 199 neighbours
stay; the nearest neighbour's median cosine moves from 0.664 to 0.641. My
reading of each list:

| Post | Kept | v4 is | Why |
| --- | --- | --- | --- |
| Hiking Camelback Mountain (1281768) | 6 / 10 | the same | hikes either way |
| USA Kubb King (1078813) | 4 / 10 | worse | championships traded for kubb in the yard |
| Professional services wish (4513948) | 1 / 1 | better | adds the TextExpander service wish |
| Zuoz to Chamanna Des-Cha Hut (1076458) | 6 / 10 | the same | fewer Swiss hikes, more trip logs |
| POAP at Night of Crypto (5474349) | 2 / 10 | better | crypto events over generic POAPs |
| Kindle 2 ordered (806398) | 3 / 10 | worse | gadget orders traded for short status posts |
| Espresso at Jim's (673171) | 2 / 10 | worse | follows "Jim" and "Linden Hills", not espresso |
| Weekly Thing GPT (5149122) | 5 / 10 | better | more of the AI-and-Weekly-Thing posts |
| IndieWeb (3941533) | 6 / 10 | worse | a Kickstarter and a MediaWiki bot creep in |
| Things 4 Good candles (1393116) | 5 / 10 | the same | candles either way |
| Mazie turned 17 (1598571) | 5 / 10 | worse | her birthdays traded for other Mazie posts |
| Hellweek Gear Test 1 (1076541) | 4 / 10 | the same | rides either way |
| Introducing the Weekly Thing (1074728) | 6 / 10 | the same | both good; v4 leans to 2017 |
| Ireland 2024 Day 4 (4137705) | 4 / 10 | better | more "Day 4" logs and the Ireland booking |
| Big Green Egg (805527) | 5 / 10 | better | drops a domain purchase |
| Quordle (1509501) | 6 / 10 | the same | games either way |
| Caribbean Vacation Day 1 (1076543) | 4 / 10 | the same | mixed either way |
| Clash Royale check-in (5664039) | 9 / 10 | the same | Clash either way |
| OmniFocus review (808678) | 7 / 10 | the same | OmniFocus either way |
| Registered for RAGBRAI (1075613) | 4 / 8 | the same | more rides, and a RailsConf registration |
| Release Notes gets Badges (6054518) | 6 / 10 | the same | mixed either way |

Five better, five worse, eleven the same: v4 neither fixes nor breaks
`similar_posts`. Where it is worse it follows a shared name or a post's form
(short status posts) over its subject. PR #104 should judge its picks on v4,
but nothing here says v4 helps it.

## Before and after, per corpus

Today (v3) against the switch (v4 at 1024, query as a document). Reranked
MRR / recall@10 / pool recall, then semantic alone:

| Corpus | Reranked before | Reranked after | Semantic before | Semantic after |
| --- | --- | --- | --- | --- |
| Weekly Thing (77) | 0.53 / 68% / 71% | 0.53 / 68% / 74% | 0.29 | 0.37 |
| blog (85) | 0.51 / 64% / 75% | 0.53 / 64% / 80% | 0.43 | 0.53 |
| reference (35) | 0.65 / 77% / 86% | 0.74 / 86% / 94% | 0.50 | 0.63 |
| links (60) | 0.75 / 78% / 80% | 0.81 / 88% / 92% | 0.53 | 0.63 |
| podcast (9) | 0.76 / 100% / 100% | 0.78 / 100% / 100% | 0.71 | 0.94 |
| documents (16) | 0.94 / 100% / 100% | 0.94 / 100% / 100% | 0.50 | 0.71 |
| all (282) | 0.62 / 73% / 79% | 0.65 / 76% / 84% | 0.43 | 0.55 |

By question type, reranked: paraphrase 0.56 → 0.61, tail 0.30 → 0.33,
direct 0.97 → 0.96.

## What's left

- **The switch PR** above, after Jamie applies the OIDC grants.
- **The keyword leg.** It is a TF-IDF cosine (no BM25, stemming, phrases or
  title weight). On its own it scores 0.26; fused with v4 it pulls semantic's
  0.55 down to 0.41, and only the reranker restores the order. Measure a
  BM25 leg (SQLite FTS5, which Node's built-in SQLite has, or BM25 in
  process) with this set plus a new set of name, quote and phrase questions,
  and release it through the corpus gate. Every path that does not rerank
  gains most.
- **Weekly Thing's pool.** A quarter of its answers never reach the reranker.
  Neither chunking nor fusion fixed it; the keyword leg is the next suspect.
- **CI cannot rerank.** The deploy role lacks `bedrock:Rerank`, so the
  candidate eval's rerank fails with AccessDenied and the gate never scores the
  reranked order (deploy run 41285778936). Granting it adds rerank cost to
  every deploy, so it is Jamie's call.
- **The semantic leg on a DynamoDB vector index** (Jamie, 2026-11-01, after
  the review below): `PLAN-2026-11-01-dynamodb-vectors.md` has the bake-off
  and the steps. Its step 2 is the binary vectors: embeddings are about 80%
  of the 675 MB of corpus JSON and are held as float64, and moving them out
  of the Lambda is what lets the Web Function take more than one request per
  environment (below).
- **OpenAI embeddings,** one eval run if Jamie wants the comparison. Its key
  must reach the run without passing through an agent.

## AWS review (Jamie, 2026-11-01)

- **Quotas are not the limit.** The throttling was the on-demand model id
  (150,000 tokens a minute); the cross-region profile takes 300,000, which is
  25 minutes for the whole archive. Only the 16.2M-a-day cap matters, and
  only for two full embeds in one day.
- **Lambda Web Functions: already in use** since 2026-10-13
  (`NativeArchiveFunction`), at one request per environment and up to five
  environments. October cost $10.47: memory time $9.43, CPU $0.84, because
  chat mostly waits on the model. Peak memory per environment was 1.0 to
  1.4 GB of 2 GB over the last two weeks, with two capacity throttles. Raising
  `MaxConcurrencyPerEnvironment` lets environments share their loaded
  corpora; `NATIVE-WEB.md` says to measure peak memory with all corpora
  loaded first (`profile-memory.mjs`), and binary vectors make the room.
- **S3 Vectors:** our 38,866 vectors at 1024 are about 160 MB, roughly a cent
  a month to store and a few dollars of requests at most. It does not improve
  answers: today's search is an exact scan, S3 Vectors is approximate, and
  each corpus query is a network call (about 100 ms). Its gain is memory and
  cold start, which binary vectors give without a new service and inside the
  corpus gate, which an S3 vector index (not versioned with the corpus) would
  not fit. Right when vectors outgrow Lambda memory, for instance photo
  embeddings.
- **Bedrock Knowledge Bases** would replace the chunking, the Thingy strip,
  the voice spans and the filters, and on S3 Vectors they search by meaning
  only: hybrid search needs OpenSearch Serverless, RDS or MongoDB.
- **OpenSearch** is a real search engine, but kept warm at 2 compute units
  ($0.24 an hour each) it is about $350 a month, more than the rest of the
  account; at its new zero minimum the first search after a quiet spell waits
  for it to start. Not for this size.
- **Anthropic** has no embedding model.

## Recommendation: photo embeddings

Out of scope here; nothing was built. `media_search` is word matching today:
every query word must match the photo's alt text, its vision description or
its post. "A dog asleep on a couch" misses a photo described as "a puppy
curled up on a sofa".

- **First, embed the descriptions, not the pixels.** 13,714 of the 13,796
  photos have a vision description (`data/librarian/media-descriptions.json`,
  median 184 characters, 2.5M characters in all, about 0.7M tokens). On Embed
  v4 that is about $0.08 and three minutes. A semantic leg beside
  `media_search`'s word match, fused the way `retrieve` fuses, would answer the
  paraphrase. The descriptions already say what the vision pass saw.
- **Measure it the way this plan did.** Write photo questions in other words
  than the description, with a known answer, and score the word match, the
  semantic leg and both together before shipping.
- **Embed the images only if the descriptions miss.** Embed v4 takes images
  in the same space as text, so a query could match a photo's pixels directly.
  That is a new pipeline (fetching 13,796 images, a vector per photo, a new
  corpus field), for questions about what a photo looks like that the
  descriptions do not say. Do it only if the description leg leaves those
  questions unanswered. The price list shows Embed v3 at $0.0001 an image
  (about $1.40 for the archive) and no separate image line for v4, so check
  v4's image price before any run.
