# AGENT-TEAM operating model

The Librarian is maintained by three objective owners. An owner is accountable
for an outcome, not a job type or a directory, and follows evidence through
diagnosis, code, tests, deploy, and acceptance in the same run.

Read `CLAUDE.md`/`AGENTS.md` -> this file -> `AGENT-TEAM/README.md` -> the
selected objective file before acting. Read `apps/librarian/CLAUDE.md` whenever
the Lambda stack is in scope, and `ALIGNMENT.md` when a question crosses repos.

## Operating loop

1. Run `AGENT-TEAM/scripts/preflight.sh`. A dirty, behind, diverged, detached,
   or unexpectedly ahead checkout makes the run read-only.
2. Measure current state from authoritative evidence — GitHub Actions runs,
   CloudWatch alarms and structured logs, live read-only endpoint probes, test
   output, git history. Comments and memory are hypotheses, not evidence.
3. Decide whether a real objective gap exists. A healthy no-op is a complete,
   successful run.
4. Only when a safe, authorized gap requires mutation, claim the checkout with
   `python3 AGENT-TEAM/scripts/objective_lease.py claim <run|archive|improve>`.
   Retain the returned `lease_id`; a held lease leaves the run read-only, and
   never clear one merely because it looks old. A normal claim records the
   Codex thread as its holder, not the short-lived claim subprocess.
5. Fix the gap at its source in the same run and pin it with a regression test;
   do not substitute a warning, a prompt rule, or a ticket chain.
6. Run `AGENT-TEAM/scripts/verify.sh` before commit; it mirrors the Python and
   Lambda CI gates, including formatting, lint, dependency audits, tests, and
   the generated contract check. Immediately before the first edit and again
   before push, run `objective_lease.py check-base <objective> --lease-id
   <lease_id>`. This proves the lease is yours, the tree is clean, and
   `origin/main` has not moved since the claim. Do not rerun start-of-run
   preflight after committing: it correctly rejects the current run's ahead
   commit as unpublished work.
7. Commit and push only current-run work, directly to `main`.
8. Verify live: the deploy workflow completes and the affected surface answers
   correctly. A green push is not acceptance; the running system is.
9. Release the lease with `objective_lease.py release <objective> --lease-id
   <lease_id>` only after the tree is clean and synchronized with `origin/main`.
   Automatic stale clearing additionally requires an unchanged HEAD and a
   recorded dead durable process. Otherwise inspect the holder and use
   `clear-manual --holder-id <exact-id> --confirm-inactive`. If safe cleanup is
   impossible, leave the lease in place and report it.

## Secret Safety

- MUST load the `aws-secrets-manager` skill first for any secret, credential,
  API key, token, or password task.
- MUST NOT call `secretsmanager get-secret-value` or `batch-get-secret-value`,
  and never print, copy, or paste credential values into output, notes,
  issues, or commits. Secrets resolve at runtime, never into context.

## Reader privacy

Reader conversations are PRIVATE. Evidence about Thingy's behavior stays
aggregate or anonymized — counts, flags, signatures, archetypes. Never quote
reader message content into notes, issues, or summaries.

## Issues are the exception ledger

Do not open an issue to authorize, claim, route, or close same-run work. Keep
one only when work spans runs, an external dependency blocks it, or Jamie must
decide — with exactly one objective label (see `README.md`).

## Reporting

End every run as one of:

```text
Outcome: HEALTHY | CHANGED | WATCHING | BLOCKED | NEEDS JAMIE
Objective: <objective name>
Evidence: <most decision-relevant facts>
Action: <what changed, or None>
Next check: <natural event/date, or None>
Jamie: <one yes/no question, or None>
```

Report the measured outcome and remaining risk, not workflow ceremony.
