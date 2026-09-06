# Run the Librarian — OIDC deployment hardening

Jamie approved proceeding in the September 6 OIDC assessment task after confirming
that GitHub deployments would not require an active local AWS CLI session.

## Changed and accepted

- Implementation commit: `1587cd3d1095b0fb1237b4f6d0ffe5c8d4517d3b`.
- Production workflow: https://github.com/jthingelstad/librarian-thing/actions/runs/34035320313
  succeeded through OIDC, including tool-surface evaluation and Lambda deployment.
- `WeeklyThingLibrarianDeployOidc` now has only `WeeklyThingLibrarianDeployScoped`,
  also installed as its permissions boundary. The six inherited managed-policy
  attachments and inline Bedrock policy were removed from this role.
- The live stack is `UPDATE_COMPLETE` and uses
  `arn:aws:iam::999153317627:role/weekly-thing-librarian-cloudformation`.
  CloudTrail confirms all three Lambda code updates by that service role.
- The application and Bedrock evaluation roles have reviewed permissions boundaries.
- GitHub repository secrets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` were
  deleted after the successful scoped deployment. Current workflows reference neither.
- Read-only verification using the already-valid `jamie` session confirmed source/live
  IAM policy and OIDC trust equality. The standing auditor was not broadened.
- IAM Access Analyzer: no findings in all five permissions documents.
- IAM simulation: 21 allow/deny cases passed; 83 existing runtime action/resource
  decisions preserved by the boundaries.
- Repository gates: 53 Python tests, 264 Lambda tests, formatting/lint/types/generated
  contract, and both dependency audits passed. CloudFormation lint and three Guard
  boundary rules passed. Retrieval golden checks passed 12/12 after boundary installation.
- Production health returned 200, all 16 Librarian alarms were OK, the stack operation
  had no failed events, and CloudTrail log/digest delivery had no reported errors.
- IAM-only rollback metadata is private and outside the repository at
  `/private/tmp/librarian-iam-rollback/iam-before-20260906T131051148165Z.json`.
  Recovery instructions are in `pipeline/deploy/iam/README.md`.

## Remaining acceptance and credential work

This completes the scoped GitHub deployment path. It does not complete every
acceptance item of projects-sysadmin#36:

- Observe the next normal corpus refresh and subsequent natural deployment. This
  implementation run deployed code; corpus permission paths were simulated, while
  real corpus reads and code uploads succeeded in CI. No artificial content was
  created or unnecessary corpus re-embedding triggered.
- Keep `wt-archive` IAM keys active until actual local consumers have migrated.
  A bounded 500-event, metadata-only sample covering August 30–September 5 includes
  local Python stack inspection/deployment, CLI log reads, and Node.js Bedrock
  Converse. Environment-file variable-name presence does not prove which exact
  key a consumer uses; no credential values were read, matched, hashed, or copied.
- Librarian admin/review tools still load `.env`; unattended local authentication
  needs a deliberate replacement. GitHub OIDC does not authenticate Mac processes.
- No IAM-user access keys were disabled/deleted, and no application secrets or
  reader data were modified. Keep the security exception open for this remainder.

## Follow-up validation

Manual `gh workflow run deploy.yml --ref main -f scope=code` succeeded after both
GitHub AWS secrets were deleted: run
https://github.com/jthingelstad/librarian-thing/actions/runs/34035545126
The corpus upload steps were skipped as intended; authentication and code deploy
succeeded without any local AWS credentials being supplied to GitHub.

CloudTrail inspection after the first rollout found six denied, optional
CloudFormation metadata checks despite successful deployment. The follow-up
policy change allows only reading the service role's own policies, listing the
two application boundaries' attachments, and listing the artifact bucket's tags.
It adds no mutation permissions or access to unrelated roles/buckets. The IAM
verifier also checks the CloudFormation service trust against its source.

The existing `make librarian-deploy` shortcut now dispatches the GitHub code
workflow (legacy `ARGS="--skip-corpus-upload"` remains accepted), and the Run
objective waits for the pushed workflow instead of deploying local files.
`make librarian-deploy-full` is the explicit corpus-refresh option.

The metadata-read correction deployed successfully in run
https://github.com/jthingelstad/librarian-thing/actions/runs/34035671087
An initial bounded CloudTrail sample for that operation contained 25 service-role
events and no AccessDenied errors. Continue checking normal deployment activity
as CloudTrail delivery completes; absence in this bounded sample is not a claim
about all account activity.
