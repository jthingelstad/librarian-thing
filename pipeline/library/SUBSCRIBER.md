# Publishing subscriber rehearsal

The sync stack proposes a disabled archive-leg rule targeting this exact
`library-round.yml` workflow. A ping uses `dry_run: true`: only the rehearsal
job runs, with contents-read permission, no checkout, OIDC, secrets, source
pull, upload, build or further dispatch. No live rehearsal ran this night.

A real archive event supplies `only: weekly`, its numeric issue and
`dry_run: false`, preserving the existing source pull and weekend-hold
semantics. Duplicate deliveries can run again; the conditional library
upload and stale-corpus check remain the guards. This is at-least-once
delivery, not an exactly-once promise.

Leave this PR unmerged and undeployed until Jamie reviews it alongside the
sync subscriber PR and the step-5 receipts PR. Jamie adds
`github_librarian_actions_token` to sync-runtime: a fine-grained GitHub PAT
limited to librarian-thing, Actions write. GitHub does not scope this token
to one workflow; the sync connection endpoint and role pin the workflow.
No value enters a session. Configure only the rehearsal lane first. Keep
WT Builder's direct issue-sent dispatch until one natural real send has a
linked successful workflow and a received arrival; then review its cutover.
