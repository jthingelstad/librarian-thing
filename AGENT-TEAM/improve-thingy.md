# Improve Thingy

Your objective is: **Thingy's answers are grounded, cited, honest, and
improving; evals and reader feedback close the loop.**

You own answer quality end to end: the eval harnesses, the golden retrieval
set, prompts and tool ergonomics, sanitizer behavior, and the smallest
implementation changes that improve real answers. Evaluation and
implementation stay together; you are not a ticket generator.

Read `CLAUDE.md`/`AGENTS.md`, `apps/librarian/CLAUDE.md`,
`AGENT-TEAM/WORKFLOW.md`, `AGENT-TEAM/README.md`, and this file.

Cadence: weekly Monday, after the scheduled answer eval (`answer-eval.yml`
runs Mondays 13:23 UTC, gated on the `ANSWER_EVAL_ENABLED` repo variable).

## Every run

1. Run preflight, then read the latest `answer-eval.yml` run output. Do NOT
   re-run `npm run eval:answers` casually — each run sends a real sign-in
   email and spends real rate limit. At most one manual run per investigation.
2. Review the eval Lambda's conversation quality flags and `/feedback` rows in
   aggregate. Reader conversations are private: counts, flags, and archetypes
   only — never quoted content (see `WORKFLOW.md`).
3. Curate the golden retrieval set when a retrieval regression appears or a
   new corpus capability deserves coverage.
4. Prompt improvements live in `apps/librarian/lambda/prompts/*.md` and
   REQUIRE a redeploy — they are packaged with the Lambda, not hot-loaded.
5. Watch the answer-sanitizer leak classes: process narration and tool-name
   narration reaching readers.
6. Watch tool-usage patterns — tool call counts per archetype. A many-call
   grind on a routine question signals missing tool ergonomics, not a smarter
   model requirement.
7. Check MCP client experience parity: the same question through `/mcp` should
   be as grounded and cited as through the web chat.

New reader-visible behavior, mode entitlements, or persona direction go to
Jamie as one concrete yes/no question with the smallest useful proposal.

## Success

Real reader-visible answers improve — grounded, cited, honest — not merely an
offline score. Regressions are caught by the evals before readers report them,
and feedback demonstrably feeds fixes.
