# Librarian deployment IAM

GitHub Actions deploys `main` using OIDC. No active AWS CLI session on the Mac
is required. To deploy the committed production code manually:

```sh
gh workflow run deploy.yml --ref main -f scope=code
# Equivalent shortcut (also accepts legacy ARGS="--skip-corpus-upload"):
make librarian-deploy
```

Use `scope=full` only when all corpora need rebuilding/uploading; embedding can
incur Bedrock charges. Pushes still rebuild only affected corpora.
`make librarian-deploy-full` dispatches that full workflow. These commands queue
a run and print its URL; use `gh run watch <run-id> --exit-status` to wait for
acceptance. Commit and push first: GitHub deploys remote `main`, never uncommitted
local files. Direct `uv run --locked python pipeline/deploy/aws.py` remains an
exceptional local operation requiring valid AWS credentials.

## Authority

- `deploy.json`: private `code/*` and four corpus/graph objects, bucket-security
  inspection, current embedding/model smoke checks, log retention, and updates
  to the one stack using the exact CloudFormation service role. No direct
  Lambda, DynamoDB, IAM-policy, or bucket-security administration.
- `cloudformation.json`: service control-plane operations for the existing
  Librarian resources. No table-item reads or writes. API and event-source
  mapping identifiers are deliberately pinned to production: replacing those
  resources or enabling the optional CloudFront distribution needs a reviewed
  administrator policy update first.
- `cloudformation-iam.json`: only the application's two role-name families.
  New roles must have the corresponding reviewed permissions boundary. The
  service role cannot remove boundaries, edit boundary policies, edit itself,
  or edit the OIDC role. Passing roles is restricted to the intended services.
- `runtime-boundary.json` and `evaluation-boundary.json`: cap the application
  roles at their existing runtime permissions. These policies are managed by
  an administrator, outside the application stack. New model permissions must
  be reflected here before a model rollout.
- `github-trust.json`: exact repository/main subjects, including GitHub's
  immutable-ID form, and audience `sts.amazonaws.com`.

The OIDC role's scoped managed policy is also its permissions boundary, so
accidentally attaching a legacy broad policy cannot increase its permissions.
The service role and boundaries are installed directly in this personal AWS
account; they do not introduce an additional infrastructure stack.

## Apply and independently verify

An administrator session is needed for this one-time setup, not for deployment:

```sh
bash pipeline/deploy/setup-oidc.sh validate --profile jamie
bash pipeline/deploy/setup-oidc.sh apply --profile jamie --snapshot-dir /private/tmp/librarian-iam-rollback
bash pipeline/deploy/setup-oidc.sh verify --profile jamie
```

`apply` validates every permissions document with IAM Access Analyzer and fails
on any finding, saves private IAM rollback metadata outside the repository,
installs application boundaries before delegating their management, installs the
CloudFormation service role, and replaces the OIDC role's legacy attachments.
`verify` compares live IAM policies and trust with source. Never widen the
standing auditor merely to get past an access denial; use an authorized reader.

Routine deployment checks public-access blocking, versioning, and AES256 bucket
encryption. Bucket creation/hardening is now an explicit administrator operation
(`aws.py --bootstrap-bucket`), rather than a permission available to CI.

## Rollback and acceptance

Before applying, ensure the production workflow is idle and preserve the IAM
snapshot path. Apply only alongside the workflow/script changes that pass the
service role. If a required operation is denied, use the exact CloudTrail action
and resource to correct the reviewed policy, validate again, and retry.

CloudFormation keeps its service role once associated with a stack. Do not delete
that role or try to roll back to a role-less stack. An administrator can restore
its prior inline documents from the snapshot (when it previously existed) or
correct the new service role. Preserve application boundaries and their policies.
As a last-resort recovery, an administrator can restore the old OIDC attachments
from the snapshot and its prior boundary; that temporarily reopens the original
security gap and must be followed by a scoped correction. Do not grant CI the
ability to execute this recovery.

Acceptance includes Access Analyzer, allow/deny IAM simulation, repository gates,
a successful production OIDC code deploy, normal corpus-upload acceptance,
source/live policy equality, healthy API/alarms, and a subsequent natural deploy.
Runtime policy boundaries require checking that the current Lambda and evaluation
permissions remain allowed before applying them.

## Legacy credentials

Removing unused `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` GitHub secrets
is separate from disabling the `wt-archive` IAM access keys. CI no longer uses
them. The legacy keys must remain active until every actual consumer is migrated.

The September 6 metadata-only inventory found recent `wt-archive` activity from
local Boto3 stack inspection/deployment, AWS CLI log inspection, and Node.js
Bedrock Converse. Librarian's admin/review scripts load `.env`; local `.env`
files in Librarian, Thingy, WT Builder, and the weekly site contain AWS key
variable names. This does not establish that those files hold the same key.
No key values were inspected or compared. Exact consumer attribution and
replacement authentication remain prerequisites to IAM-key retirement.

Interactive local deployments may use a temporary AWS session. Unattended local
work needs its own approved authentication path or migration to GitHub Actions;
GitHub OIDC does not authenticate processes running on this Mac.
