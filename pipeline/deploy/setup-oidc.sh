#!/usr/bin/env bash
# One-time bootstrap: GitHub Actions OIDC deploy role for this repo.
#
# Creates the GitHub OIDC identity provider (account-wide, shared by any
# future repo roles) and a deploy role trusted ONLY by pushes to main of
# jthingelstad/librarian-thing, carrying the same permission set as the
# static wt-archive IAM user it replaces. Run it as an admin identity:
#
#     bash pipeline/deploy/setup-oidc.sh
#
# Afterwards, .github/workflows/deploy.yml switches to
# aws-actions/configure-aws-credentials with the printed role ARN, and the
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY repo secrets (plus the
# wt-archive access keys themselves) can be retired.
set -euo pipefail

ACCOUNT_ID=999153317627
ROLE_NAME=WeeklyThingLibrarianDeployOidc
PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"

if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; then
  aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 >/dev/null
  echo "Created GitHub OIDC provider."
else
  echo "GitHub OIDC provider already exists."
fi

TRUST=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {"Federated": "${PROVIDER_ARN}"},
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": [
            "repo:jthingelstad/librarian-thing:ref:refs/heads/main",
            "repo:jthingelstad@5351/librarian-thing@1258787307:ref:refs/heads/main"
          ]
        }
      }
    }
  ]
}
JSON
)

if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --description "GitHub Actions OIDC deploy role for librarian-thing, replaces static wt-archive keys in CI" \
    --max-session-duration 3600 \
    --assume-role-policy-document "$TRUST" \
    --tags Key=project,Value=Thingy >/dev/null
  echo "Created role ${ROLE_NAME}."
else
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST"
  echo "Role ${ROLE_NAME} already exists; trust policy refreshed."
fi

# Same permission set as the wt-archive user (tighten later if desired).
for POLICY_ARN in \
  "arn:aws:iam::${ACCOUNT_ID}:policy/WeeklyThingLibrarianDeploy" \
  "arn:aws:iam::${ACCOUNT_ID}:policy/WeeklyThingLibrarianOpsExtras" \
  "arn:aws:iam::aws:policy/AmazonS3FullAccess" \
  "arn:aws:iam::aws:policy/AmazonBedrockFullAccess" \
  "arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess_v2" \
  "arn:aws:iam::aws:policy/AWSLambda_FullAccess"; do
  aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY_ARN"
done

# Copy the wt-archive inline Bedrock policy onto the role.
aws iam get-user-policy --user-name wt-archive --policy-name WeeklyThingBedrockInvoke \
  --query PolicyDocument --output json > /tmp/wt-bedrock-invoke.json
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name WeeklyThingBedrockInvoke \
  --policy-document file:///tmp/wt-bedrock-invoke.json
rm -f /tmp/wt-bedrock-invoke.json

echo
echo "Deploy role ready:"
aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text
