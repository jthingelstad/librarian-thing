"""Regression coverage for deployment authorization and bucket safety."""

from __future__ import annotations

import importlib.util
import json
from fnmatch import fnmatchcase
from pathlib import Path
from unittest.mock import Mock

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("librarian_deploy", ROOT / "pipeline/deploy/aws.py")
assert SPEC and SPEC.loader
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


def policy(name):
    return json.loads((ROOT / "pipeline/deploy/iam" / f"{name}.json").read_text())


def secure_bucket(monkeypatch):
    s3 = Mock()
    s3.get_public_access_block.return_value = {
        "PublicAccessBlockConfiguration": {
            name: True
            for name in (
                "BlockPublicAcls",
                "IgnorePublicAcls",
                "BlockPublicPolicy",
                "RestrictPublicBuckets",
            )
        }
    }
    s3.get_bucket_versioning.return_value = {"Status": "Enabled"}
    s3.get_bucket_encryption.return_value = {
        "ServerSideEncryptionConfiguration": {
            "Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]
        }
    }
    monkeypatch.setattr(deploy.boto3, "client", lambda service: s3)
    return s3


def test_routine_deploy_only_reads_bucket_controls(monkeypatch):
    s3 = secure_bucket(monkeypatch)
    deploy.verify_private_bucket("weekly-thing-librarian")
    assert {call[0] for call in s3.mock_calls} == {
        "head_bucket",
        "get_public_access_block",
        "get_bucket_versioning",
        "get_bucket_encryption",
    }


@pytest.mark.parametrize(
    "setting",
    [
        "BlockPublicAcls",
        "IgnorePublicAcls",
        "BlockPublicPolicy",
        "RestrictPublicBuckets",
        "versioning",
        "encryption",
    ],
)
def test_insecure_bucket_stops_deployment(monkeypatch, setting):
    s3 = secure_bucket(monkeypatch)
    if setting == "versioning":
        s3.get_bucket_versioning.return_value = {"Status": "Suspended"}
    elif setting == "encryption":
        s3.get_bucket_encryption.return_value["ServerSideEncryptionConfiguration"]["Rules"] = []
    else:
        s3.get_public_access_block.return_value["PublicAccessBlockConfiguration"][setting] = False
    with pytest.raises(RuntimeError, match="administrator"):
        deploy.verify_private_bucket("weekly-thing-librarian")


def test_deploy_cannot_manage_iam_or_bucket_security():
    statements = policy("deploy")["Statement"]
    actions = {action for statement in statements for action in statement["Action"]}
    assert {action for action in actions if action.startswith("iam:")} == {"iam:PassRole"}
    assert not any(action.startswith("dynamodb:") for action in actions)
    assert not any(action.startswith("lambda:") for action in actions)
    assert not any(action.startswith("s3:PutBucket") for action in actions)
    assert not any(action.endswith("*") for action in actions)
    update = next(
        statement for statement in statements if "cloudformation:UpdateStack" in statement["Action"]
    )
    assert update["Condition"]["StringEquals"]["cloudformation:RoleArn"].endswith(
        ":role/weekly-thing-librarian-cloudformation"
    )


def test_cloudformation_cannot_change_itself_or_remove_boundaries():
    statements = policy("cloudformation-iam")["Statement"]
    for statement in statements:
        assert "iam:DeleteRolePermissionsBoundary" not in statement["Action"]
        assert "iam:CreatePolicyVersion" not in statement["Action"]
        assert "DeployOidc" not in statement["Resource"]
        assert "-cloudformation" not in statement["Resource"]
        if "iam:CreateRole" in statement["Action"]:
            assert statement["Condition"]["StringEquals"]["iam:PermissionsBoundary"].endswith(
                "Boundary"
            )
    template = (ROOT / "apps/librarian/infra/cloudformation.yaml").read_text()
    assert (
        "PermissionsBoundary: !Sub arn:aws:iam::${AWS::AccountId}:policy/WeeklyThingLibrarianRuntimeBoundary"
        in template
    )
    assert (
        "PermissionsBoundary: !Sub arn:aws:iam::${AWS::AccountId}:policy/WeeklyThingLibrarianEvaluationBoundary"
        in template
    )


def test_oidc_trust_accepts_only_this_repository_main():
    statement = policy("github-trust")["Statement"][0]
    equals = statement["Condition"]["StringEquals"]
    assert equals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
    assert equals["token.actions.githubusercontent.com:sub"] == [
        "repo:jthingelstad/librarian-thing:ref:refs/heads/main",
        "repo:jthingelstad@5351/librarian-thing@1258787307:ref:refs/heads/main",
    ]


def test_template_runtime_permissions_fit_reviewed_boundaries():
    # BaseLoader reads CloudFormation's tagged scalars without evaluating code.
    template = yaml.load(
        (ROOT / "apps/librarian/infra/cloudformation.yaml").read_text(), Loader=yaml.BaseLoader
    )
    table = (
        "arn:aws:dynamodb:us-east-1:999153317627:table/weekly-thing-librarian-LibrarianTable-test"
    )
    values = {
        "AWS::AccountId": "999153317627",
        "AWS::Region": "us-east-1",
        "LibrarianTable.Arn": table,
        "LibrarianTable.StreamArn": table + "/stream/test",
        "LibrarianEvalDlq.Arn": "arn:aws:sqs:us-east-1:999153317627:weekly-thing-librarian-eval-dlq",
        "CorpusBucket": "weekly-thing-librarian",
        "CorpusKey": "artifacts/corpus.json",
        "GraphKey": "artifacts/graph.json",
        "BlogCorpusKey": "artifacts/blog_corpus.json",
        "PodcastCorpusKey": "artifacts/podcast_corpus.json",
    }

    def resolve(resource):
        for key, value in values.items():
            resource = resource.replace("${" + key + "}", value)
        return values.get(resource, resource)

    def items(value):
        return value if isinstance(value, list) else [value]

    for logical, name in [
        ("LibrarianFunctionRole", "runtime-boundary"),
        ("BedrockEvaluationRole", "evaluation-boundary"),
    ]:
        boundary = policy(name)["Statement"]
        for inline in template["Resources"][logical]["Properties"]["Policies"]:
            for statement in inline["PolicyDocument"]["Statement"]:
                for action in items(statement["Action"]):
                    for resource in items(statement["Resource"]):
                        assert any(
                            grant["Effect"] == "Allow"
                            and any(
                                fnmatchcase(action, pattern) for pattern in items(grant["Action"])
                            )
                            and any(
                                fnmatchcase(resolve(resource), pattern)
                                for pattern in items(grant["Resource"])
                            )
                            for grant in boundary
                        ), f"Review {name}: {action} {resource} exceeds its boundary"
