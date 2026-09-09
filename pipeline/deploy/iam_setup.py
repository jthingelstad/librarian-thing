"""Install and verify Librarian's reviewed IAM documents using an administrator.

No credentials or application data are read. Snapshots contain IAM policy metadata
only. CI cannot run this bootstrap with its deployment permissions.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import UTC, datetime
from pathlib import Path

import boto3

ACCOUNT = "999153317627"
DEPLOY_ROLE = "WeeklyThingLibrarianDeployOidc"
CFN_ROLE = "weekly-thing-librarian-cloudformation"
POLICY_PREFIX = f"arn:aws:iam::{ACCOUNT}:policy/"
DOCUMENTS = Path(__file__).with_name("iam")
BOUNDARIES = {
    "LibrarianFunctionRole": ("WeeklyThingLibrarianRuntimeBoundary", "runtime-boundary"),
    "BedrockEvaluationRole": ("WeeklyThingLibrarianEvaluationBoundary", "evaluation-boundary"),
}
DEPLOY_POLICY = "WeeklyThingLibrarianDeployScoped"
CFN_TRUST = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {"Service": "cloudformation.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }
    ],
}


def document(name: str) -> dict:
    return json.loads((DOCUMENTS / f"{name}.json").read_text())


def validate(session: boto3.Session) -> None:
    analyzer = session.client("accessanalyzer")
    for path in sorted(DOCUMENTS.glob("*.json")):
        if path.stem == "github-trust":
            continue
        findings = []
        for page in analyzer.get_paginator("validate_policy").paginate(
            policyDocument=path.read_text(), policyType="IDENTITY_POLICY"
        ):
            findings.extend(page["findings"])
        if findings:
            raise RuntimeError(f"{path.name}: {json.dumps(findings)}")
        print(f"Validated {path.name}: no findings")
    simulate(session)


def simulate(session: boto3.Session) -> None:
    """Check required operations and representative escape paths using AWS IAM."""
    iam = session.client("iam")
    base = f"arn:aws:iam::{ACCOUNT}:"
    stack = f"arn:aws:cloudformation:us-east-1:{ACCOUNT}:stack/weekly-thing-librarian/test"
    cases = [
        (
            "deploy",
            "s3:PutObject",
            "arn:aws:s3:::weekly-thing-librarian/code/auth-lambda/test.zip",
            True,
            {},
        ),
        (
            "deploy",
            "s3:PutObject",
            "arn:aws:s3:::weekly-thing-librarian/artifacts/blog_corpus.json",
            True,
            {},
        ),
        (
            "deploy",
            "s3:PutObject",
            "arn:aws:s3:::unrelated-private-bucket/code/test.zip",
            False,
            {},
        ),
        (
            "deploy",
            "s3:PutObject",
            "arn:aws:s3:::weekly-thing-librarian/artifacts/dispatches/test.json",
            False,
            {},
        ),
        (
            "deploy",
            "s3:PutBucketPublicAccessBlock",
            "arn:aws:s3:::weekly-thing-librarian",
            False,
            {},
        ),
        ("deploy", "iam:PutRolePolicy", base + "role/WeeklyThingLibrarianDeployOidc", False, {}),
        (
            "deploy",
            "cloudformation:UpdateStack",
            stack,
            True,
            {"cloudformation:RoleArn": base + "role/" + CFN_ROLE},
        ),
        ("deploy", "cloudformation:UpdateStack", stack, False, {}),
        (
            "deploy",
            "cloudformation:UpdateStack",
            stack,
            False,
            {"cloudformation:RoleArn": base + "role/unrelated"},
        ),
        (
            "deploy",
            "iam:PassRole",
            base + "role/" + CFN_ROLE,
            True,
            {"iam:PassedToService": "cloudformation.amazonaws.com"},
        ),
        (
            "deploy",
            "iam:PassRole",
            base + "role/unrelated",
            False,
            {"iam:PassedToService": "cloudformation.amazonaws.com"},
        ),
        (
            "cloudformation",
            "lambda:UpdateFunctionCode",
            f"arn:aws:lambda:us-east-1:{ACCOUNT}:function:weekly-thing-librarian-LibrarianFunction-test",
            True,
            {},
        ),
        (
            "cloudformation",
            "lambda:UpdateFunctionCode",
            f"arn:aws:lambda:us-east-1:{ACCOUNT}:function:unrelated",
            False,
            {},
        ),
        (
            "cloudformation",
            "dynamodb:GetItem",
            f"arn:aws:dynamodb:us-east-1:{ACCOUNT}:table/weekly-thing-librarian-LibrarianTable-test",
            False,
            {},
        ),
        (
            "cloudformation",
            "secretsmanager:CreateSecret",
            "*",
            True,
            {"secretsmanager:Name": "weekly-thing-librarian-golden-retrieval"},
        ),
        (
            "cloudformation",
            "secretsmanager:CreateSecret",
            "*",
            False,
            {"secretsmanager:Name": "unrelated-secret-test"},
        ),
        (
            "cloudformation",
            "secretsmanager:GetRandomPassword",
            "*",
            True,
            {},
        ),
        (
            "cloudformation",
            "secretsmanager:GetSecretValue",
            f"arn:aws:secretsmanager:us-east-1:{ACCOUNT}:secret:weekly-thing-librarian-golden-retrieval-test",
            True,
            {},
        ),
        (
            "cloudformation",
            "secretsmanager:GetSecretValue",
            f"arn:aws:secretsmanager:us-east-1:{ACCOUNT}:secret:unrelated-secret-test",
            False,
            {},
        ),
        (
            "cloudformation-iam",
            "iam:CreateRole",
            base + "role/weekly-thing-librarian-LibrarianFunctionRole-test",
            True,
            {"iam:PermissionsBoundary": POLICY_PREFIX + "WeeklyThingLibrarianRuntimeBoundary"},
        ),
        (
            "cloudformation-iam",
            "iam:CreateRole",
            base + "role/weekly-thing-librarian-LibrarianFunctionRole-test",
            False,
            {},
        ),
        (
            "cloudformation-iam",
            "iam:PutRolePermissionsBoundary",
            base + "role/weekly-thing-librarian-LibrarianFunctionRole-test",
            False,
            {"iam:PermissionsBoundary": base + "policy/unrelated"},
        ),
        (
            "cloudformation-iam",
            "iam:DeleteRolePermissionsBoundary",
            base + "role/weekly-thing-librarian-LibrarianFunctionRole-test",
            False,
            {},
        ),
        ("cloudformation-iam", "iam:PutRolePolicy", base + "role/" + CFN_ROLE, False, {}),
        (
            "runtime-boundary",
            "s3:GetObject",
            "arn:aws:s3:::unrelated-private-bucket/private.json",
            False,
            {},
        ),
        ("runtime-boundary", "iam:CreateUser", base + "user/unrelated", False, {}),
    ]
    for name, action, resource, allowed, context in cases:
        result = iam.simulate_custom_policy(
            PolicyInputList=[json.dumps(document(name))],
            ActionNames=[action],
            ResourceArns=[resource],
            ContextEntries=[
                {"ContextKeyName": key, "ContextKeyValues": [value], "ContextKeyType": "string"}
                for key, value in context.items()
            ],
        )["EvaluationResults"][0]
        if (result["EvalDecision"] == "allowed") != allowed:
            raise RuntimeError(
                f"Unexpected IAM simulation: {name} {action} {resource}: {result['EvalDecision']}"
            )
    print(f"IAM allow/deny simulations passed: {len(cases)}")

    # Check the real inline runtime policies against the proposed boundaries.
    # Only IAM documents are read, never Lambda environments or table contents.
    def decisions(results):
        values = {}
        for result in results:
            if result.get("ResourceSpecificResults"):
                for resource in result["ResourceSpecificResults"]:
                    values[(result["EvalActionName"], resource["EvalResourceName"])] = resource[
                        "EvalResourceDecision"
                    ]
            else:
                values[(result["EvalActionName"], result["EvalResourceName"])] = result[
                    "EvalDecision"
                ]
        return values

    checked = 0
    for logical, role in stack_roles(session).items():
        _, filename = BOUNDARIES[logical]
        for page in iam.get_paginator("list_role_policies").paginate(RoleName=role):
            for name in page["PolicyNames"]:
                body = iam.get_role_policy(RoleName=role, PolicyName=name)["PolicyDocument"]
                for statement in body["Statement"]:
                    actions = statement["Action"]
                    resources = statement["Resource"]
                    request = dict(
                        PolicyInputList=[json.dumps(body)],
                        ActionNames=actions if isinstance(actions, list) else [actions],
                        ResourceArns=resources if isinstance(resources, list) else [resources],
                        ContextEntries=[
                            {
                                "ContextKeyName": "s3:prefix",
                                "ContextKeyValues": ["eval/datasets/test.json"],
                                "ContextKeyType": "string",
                            }
                        ],
                    )
                    baseline = decisions(iam.simulate_custom_policy(**request)["EvaluationResults"])
                    results = iam.simulate_custom_policy(
                        **request,
                        PermissionsBoundaryPolicyInputList=[json.dumps(document(filename))],
                    )["EvaluationResults"]
                    for key, decision in decisions(results).items():
                        if decision != baseline[key]:
                            raise RuntimeError(
                                f"Boundary changes current runtime access: {logical} {key}"
                            )
                    checked += len(baseline)
    print(f"Existing runtime permissions preserved: {checked} action/resource checks")


def managed_document(iam, arn: str) -> dict:
    version = iam.get_policy(PolicyArn=arn)["Policy"]["DefaultVersionId"]
    return iam.get_policy_version(PolicyArn=arn, VersionId=version)["PolicyVersion"]["Document"]


def role_snapshot(iam, name: str) -> dict:
    try:
        role = iam.get_role(RoleName=name)["Role"]
    except iam.exceptions.NoSuchEntityException:
        return {"exists": False}
    attached = [
        item
        for page in iam.get_paginator("list_attached_role_policies").paginate(RoleName=name)
        for item in page["AttachedPolicies"]
    ]
    inline = {
        policy: iam.get_role_policy(RoleName=name, PolicyName=policy)["PolicyDocument"]
        for page in iam.get_paginator("list_role_policies").paginate(RoleName=name)
        for policy in page["PolicyNames"]
    }
    return {
        "exists": True,
        "trust": role["AssumeRolePolicyDocument"],
        "boundary": role.get("PermissionsBoundary"),
        "boundary_document": managed_document(
            iam, role["PermissionsBoundary"]["PermissionsBoundaryArn"]
        )
        if role.get("PermissionsBoundary")
        else None,
        "attached": {
            item["PolicyArn"]: managed_document(iam, item["PolicyArn"]) for item in attached
        },
        "inline": inline,
    }


def put_managed(iam, name: str, body: dict) -> str:
    arn = POLICY_PREFIX + name
    encoded = json.dumps(body)
    try:
        existing = managed_document(iam, arn)
    except iam.exceptions.NoSuchEntityException:
        iam.create_policy(
            PolicyName=name, PolicyDocument=encoded, Tags=[{"Key": "project", "Value": "Thingy"}]
        )
    else:
        if existing != body:
            versions = iam.list_policy_versions(PolicyArn=arn)["Versions"]
            if len(versions) >= 5:
                oldest = min(
                    (v for v in versions if not v["IsDefaultVersion"]),
                    key=lambda v: v["CreateDate"],
                )
                iam.delete_policy_version(PolicyArn=arn, VersionId=oldest["VersionId"])
            iam.create_policy_version(PolicyArn=arn, PolicyDocument=encoded, SetAsDefault=True)
    return arn


def stack_roles(session: boto3.Session) -> dict[str, str]:
    cfn = session.client("cloudformation")
    return {
        name: cfn.describe_stack_resource(
            StackName="weekly-thing-librarian", LogicalResourceId=name
        )["StackResourceDetail"]["PhysicalResourceId"]
        for name in BOUNDARIES
    }


def apply(session: boto3.Session, snapshot_dir: Path) -> None:
    iam = session.client("iam")
    roles = stack_roles(session)
    snapshot_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = snapshot_dir / f"iam-before-{datetime.now(UTC).strftime('%Y%m%dT%H%M%S%fZ')}.json"
    snapshot = {name: role_snapshot(iam, name) for name in [DEPLOY_ROLE, CFN_ROLE, *roles.values()]}
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as handle:
        json.dump(snapshot, handle, indent=2, default=str)
    print(f"IAM rollback metadata: {path}")

    # Bound the existing application roles BEFORE delegating policy management.
    for logical, (name, filename) in BOUNDARIES.items():
        arn = put_managed(iam, name, document(filename))
        iam.put_role_permissions_boundary(RoleName=roles[logical], PermissionsBoundary=arn)

    try:
        iam.get_role(RoleName=CFN_ROLE)
    except iam.exceptions.NoSuchEntityException:
        iam.create_role(
            RoleName=CFN_ROLE,
            AssumeRolePolicyDocument=json.dumps(CFN_TRUST),
            Tags=[{"Key": "project", "Value": "Thingy"}],
        )
    else:
        iam.update_assume_role_policy(RoleName=CFN_ROLE, PolicyDocument=json.dumps(CFN_TRUST))
    for name in ("cloudformation", "cloudformation-iam"):
        iam.put_role_policy(
            RoleName=CFN_ROLE, PolicyName=name, PolicyDocument=json.dumps(document(name))
        )

    arn = put_managed(iam, DEPLOY_POLICY, document("deploy"))
    iam.attach_role_policy(RoleName=DEPLOY_ROLE, PolicyArn=arn)
    # The same policy also caps any accidentally reattached legacy permissions.
    iam.put_role_permissions_boundary(RoleName=DEPLOY_ROLE, PermissionsBoundary=arn)
    iam.update_assume_role_policy(
        RoleName=DEPLOY_ROLE, PolicyDocument=json.dumps(document("github-trust"))
    )
    for old in snapshot[DEPLOY_ROLE]["attached"]:
        if old != arn:
            iam.detach_role_policy(RoleName=DEPLOY_ROLE, PolicyArn=old)
    for old in snapshot[DEPLOY_ROLE]["inline"]:
        iam.delete_role_policy(RoleName=DEPLOY_ROLE, PolicyName=old)
    verify(session)


def verify(session: boto3.Session) -> None:
    iam = session.client("iam")
    deployed = role_snapshot(iam, DEPLOY_ROLE)
    assert deployed["trust"] == document("github-trust"), "OIDC trust drift"
    assert deployed["attached"] == {POLICY_PREFIX + DEPLOY_POLICY: document("deploy")}, (
        "Deploy policy drift"
    )
    assert not deployed["inline"], "Unexpected deploy inline policy"
    assert deployed["boundary"]["PermissionsBoundaryArn"] == POLICY_PREFIX + DEPLOY_POLICY
    cfn = role_snapshot(iam, CFN_ROLE)
    assert cfn["trust"] == CFN_TRUST, "CloudFormation trust drift"
    assert not cfn["attached"], "Unexpected CloudFormation managed policy"
    assert cfn["inline"] == {
        name: document(name) for name in ("cloudformation", "cloudformation-iam")
    }, "CloudFormation policy drift"
    for logical, role in stack_roles(session).items():
        name, filename = BOUNDARIES[logical]
        assert (
            iam.get_role(RoleName=role)["Role"]["PermissionsBoundary"]["PermissionsBoundaryArn"]
            == POLICY_PREFIX + name
        )
        assert managed_document(iam, POLICY_PREFIX + name) == document(filename)
    print("Live IAM matches reviewed source; no inherited deployment policies")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("validate", "apply", "verify"))
    parser.add_argument("--profile", required=True)
    parser.add_argument("--snapshot-dir", type=Path)
    args = parser.parse_args()
    session = boto3.Session(profile_name=args.profile, region_name="us-east-1")
    if session.client("sts").get_caller_identity()["Account"] != ACCOUNT:
        raise RuntimeError("Wrong AWS account")
    if args.command in ("validate", "apply"):
        validate(session)
    if args.command == "apply":
        if args.snapshot_dir is None:
            parser.error("apply requires --snapshot-dir outside the repository")
        if args.snapshot_dir.resolve().is_relative_to(DOCUMENTS.parents[2]):
            parser.error("snapshots must be outside the repository")
        apply(session, args.snapshot_dir)
    elif args.command == "verify":
        verify(session)


if __name__ == "__main__":
    main()
