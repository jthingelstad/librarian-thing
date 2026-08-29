# Improve Thingy

Your objective is: **Thingy's answers are grounded, cited, honest, and
improving; exact natural conversations and reader feedback close the loop.**

You own answer quality end to end: direct production-evidence review, the
golden retrieval set, prompts and tool ergonomics, sanitizer behavior, and the
smallest implementation changes that improve real answers. Codex does the
evaluation itself from exact evidence. Evaluation and implementation stay
together; you are not a ticket generator.

Read `CLAUDE.md`/`AGENTS.md`, `apps/librarian/CLAUDE.md`,
`AGENT-TEAM/WORKFLOW.md`, `AGENT-TEAM/README.md`, and this file.

Cadence: every three days, reviewing the prior seven days of natural Thingy use.

## Every run

1. Run preflight, then collect the bounded private index directly from the live
   DynamoDB table:

   ```sh
   uv run --locked python apps/librarian/admin/conversation_review.py list \
     --days 7 --limit 30 --sort attention
   ```

   This path is read-only. Do not sign in to Thingy, call a Thingy HTTP
   endpoint, send a magic-link email, create synthetic conversations, invoke an
   external model grader, or write evaluator state back to DynamoDB.
2. Collect the separate bounded MCP tool-call index from the same private,
   read-only DynamoDB review path:

   ```sh
   uv run --locked python apps/librarian/admin/conversation_review.py mcp-list \
     --days 7 --limit 30 --sort attention
   ```

   Only real `tools/call` invocations appear here; MCP initialize, tool-list,
   ping, and notification traffic is intentionally excluded. Retrieve one exact
   bounded tool call with `mcp-show <request-id>`. Librarian sees the selected
   tool, its arguments, bounded result evidence, runtime, and failure state. It
   does NOT receive the external client's original prompt, final synthesis, or
   feedback, so never infer final-answer quality from an MCP record.
3. Use both index signal sets to select every high-signal item plus a small natural
   sample of routine behavior. Retrieve exact details one conversation at a
   time:

   ```sh
   uv run --locked python apps/librarian/admin/conversation_review.py show \
     <conversation-id>
   ```

   The background evaluator's flags are triage hints, not a verdict. Codex must
   judge the exact question, available tool evidence, answer, citations,
   runtime outcome, and feedback itself. If the window is too small to support
   a conclusion, report `insufficient_sample` rather than manufacture traffic.
4. Evaluate the whole reader-visible outcome for native Thingy conversations:
   - factual claims and honest uncertainty;
   - whether citations support the nearby claims;
   - whether the tool trace shows Thingy had and used the right evidence;
   - unnecessary tool-call grind, deadline exhaustion, or missing ergonomics;
   - sanitizer/process narration, prompt leaks, and privacy boundaries;
   - reader feedback and whether a prior fix cleared in later natural use.
   For MCP, evaluate only what Librarian can prove: tool choice, argument fit,
   returned evidence, errors, truncation, and latency. Do not manufacture the
   missing external-client synthesis.
5. Reader conversations and MCP arguments are private. Raw index/detail output stays only in the
   active Codex run. Never quote or persist reader content, subscriber hashes,
   conversation titles, or feedback comments in commits, issues, automation
   memory, notes, or summaries. Durable findings use counts, anonymous
   signatures, and archetypes only (see `WORKFLOW.md`).
6. Curate the golden retrieval set when an exact natural regression reveals a
   missing deterministic case or a new corpus capability deserves coverage.
   Do not run live HTTP probes from this objective; Run the Librarian owns the
   public-probe and golden-suite execution boundary.
7. Prompt improvements live in `apps/librarian/lambda/prompts/*.md` and
   REQUIRE a redeploy — they are packaged with the Lambda, not hot-loaded.
8. Watch the answer-sanitizer leak classes: process narration and tool-name
   narration reaching readers.
9. Watch tool-usage patterns — tool call counts per archetype. A many-call
   grind on a routine question signals missing tool ergonomics, not a smarter
   model requirement.
10. Inspect open `objective:improve` issues for a Jamie decision or multi-run
   watch. A reproducible internal defect is fixed at the source with a realistic
   regression, full verification, required deployment, and later natural
   acceptance.

New reader-visible behavior, mode entitlements, or persona direction go to
Jamie as one concrete yes/no question with the smallest useful proposal.

## Success

Real reader-visible answers improve — grounded, cited, honest — not merely a
model-generated score. Exact natural evidence becomes a source fix and a
regression when warranted, feedback demonstrably changes later comparable
behavior, and a healthy window earns a quiet pass.
