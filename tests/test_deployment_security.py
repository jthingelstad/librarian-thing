"""Regression coverage for deployment authorization and bucket safety."""

from __future__ import annotations

import importlib.util
import json
import re
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
    assert {action for action in actions if action.startswith("lambda:")} == {
        "lambda:GetResourcePolicy",
        "lambda:PutResourcePolicy",
        "lambda:GetWebFunctionEndpoint",
        "lambda:InvokeWebFunctionEndpoint",
        "lambda:GetWebFunctionRevision",
    }
    native = next(statement for statement in statements if statement["Sid"] == "NativePolicyOwner")
    assert all("web-function/weekly-thing-librarian-web-" in arn for arn in native["Resource"])
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
        if not all(action.startswith(("iam:Get", "iam:List")) for action in statement["Action"]):
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


def test_retired_http_services_have_no_cloudformation_grants():
    for statement in policy("cloudformation")["Statement"]:
        actions = statement["Action"]
        if isinstance(actions, str):
            actions = [actions]
        assert not any(
            action.startswith("apigateway:") or "FunctionUrl" in action for action in actions
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
        "AWS::Partition": "aws",
        "AWS::Region": "us-east-1",
        "LibrarianTable.Arn": table,
        "LibrarianTable.StreamArn": table + "/stream/test",
        "LibrarianEvalDlq.Arn": "arn:aws:sqs:us-east-1:999153317627:weekly-thing-librarian-eval-dlq",
        "CorpusBucket": "weekly-thing-librarian",
        "CorpusKey": "artifacts/corpus.json",
        "GraphKey": "artifacts/graph.json",
        "BlogCorpusKey": "artifacts/blog_corpus.json",
        "PodcastCorpusKey": "artifacts/podcast_corpus.json",
        "ReferenceCorpusKey": "artifacts/reference_corpus.json",
        "LinksCorpusKey": "artifacts/links_corpus.json",
        "KeywordIndexKey": "artifacts/keyword_index.db",
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


def test_tags_follow_the_account_standard(monkeypatch):
    standard = {
        "Application": "Thingelstad",
        "Project": "librarian",
        "Environment": "production",
        "Repository": "jthingelstad/librarian-thing",
    }
    assert deploy.STACK_TAGS == {**standard, "ManagedBy": "cloudformation"}
    assert deploy.REPOSITORY_TAGS == {**standard, "ManagedBy": "repository"}
    template = yaml.load(
        (ROOT / "apps/librarian/infra/cloudformation.yaml").read_text(), Loader=yaml.BaseLoader
    )
    # Stack tags propagate to every taggable resource; a per-resource tag would drift.
    assert [
        name
        for name, resource in template["Resources"].items()
        if "Tags" in resource.get("Properties", {})
    ] == []

    # Bucket bootstrap retires lowercase `project` and keeps unrelated tags.
    s3 = secure_bucket(monkeypatch)
    s3.get_bucket_lifecycle_configuration.return_value = {"Rules": []}
    s3.get_bucket_tagging.return_value = {
        "TagSet": [{"Key": "project", "Value": "Thingy"}, {"Key": "Keep", "Value": "yes"}]
    }
    deploy.ensure_private_bucket("weekly-thing-librarian")
    tag_set = s3.put_bucket_tagging.call_args.kwargs["Tagging"]["TagSet"]
    assert {tag["Key"]: tag["Value"] for tag in tag_set} == {
        "Keep": "yes",
        **deploy.REPOSITORY_TAGS,
    }


def test_bucket_bootstrap_keeps_logs_and_old_builds_one_month(monkeypatch) -> None:
    s3 = secure_bucket(monkeypatch)
    s3.get_bucket_tagging.return_value = {"TagSet": []}
    s3.get_bucket_lifecycle_configuration.return_value = {
        "Rules": [
            {"ID": "transition-bedrock-invocation-logs", "Status": "Enabled"},
            {"ID": "someone-elses-rule", "Status": "Enabled"},
        ]
    }
    deploy.ensure_private_bucket("weekly-thing-librarian")
    rules = {
        rule["ID"]: rule
        for rule in s3.put_bucket_lifecycle_configuration.call_args.kwargs[
            "LifecycleConfiguration"
        ]["Rules"]
    }

    # Bedrock prompts and responses, Thingy chats included, live one month.
    logs = rules["expire-bedrock-invocation-logs"]
    assert logs["Filter"] == {"Prefix": "logs/invocations/"}
    assert logs["Expiration"] == {"Days": 30}
    assert "Transitions" not in logs
    # A replaced corpus build lives one month; the current one is untouched.
    builds = rules["expire-replaced-corpus-builds"]
    assert builds["Filter"] == {"Prefix": "artifacts/"}
    assert builds["NoncurrentVersionExpiration"] == {"NoncurrentDays": 30}
    assert "Expiration" not in builds
    assert rules["clean-up-uploads-and-delete-markers"]["AbortIncompleteMultipartUpload"] == {
        "DaysAfterInitiation": 7
    }
    # The replaced rule goes; rules this code does not own stay.
    assert "transition-bedrock-invocation-logs" not in rules
    assert "someone-elses-rule" in rules


def test_digest_handled_failure_still_feeds_the_subscribe_failures_metric():
    template = yaml.load(
        (ROOT / "apps/librarian/infra/cloudformation.yaml").read_text(), Loader=yaml.BaseLoader
    )
    resources = template["Resources"]
    filters = [
        resource["Properties"]
        for resource in resources.values()
        if resource["Type"] == "AWS::Logs::MetricFilter"
        and resource["Properties"]["LogGroupName"] == "LibrarianDigestLogGroup"
    ]
    metric = next(
        f for f in filters if "subscribe_digest_blocked_list_failed" in f["FilterPattern"]
    )
    transformation = metric["MetricTransformations"][0]
    assert transformation["MetricNamespace"] == "WeeklyThingLibrarian"
    assert transformation["MetricName"] == "LibrarianSubscribeFailures"


def test_only_the_authorize_policy_forwards_a_cookie_and_only_thingy_email():
    template = yaml.load(
        (ROOT / "apps/librarian/infra/cloudformation.yaml").read_text(), Loader=yaml.BaseLoader
    )
    policies = {
        name: resource["Properties"]["OriginRequestPolicyConfig"]
        for name, resource in template["Resources"].items()
        if resource["Type"] == "AWS::CloudFront::OriginRequestPolicy"
    }
    authorize = policies.pop("NativeAuthorizeRequestPolicy")
    # The /authorize sign-in page prefills from thingy_email; the web session
    # cookie (__Host-thingy_session) must never reach librarian.thingelstad.com.
    assert authorize["CookiesConfig"] == {
        "CookieBehavior": "whitelist",
        "Cookies": ["thingy_email"],
    }
    external = policies["NativeExternalRequestPolicy"]
    assert authorize["HeadersConfig"] == external["HeadersConfig"]
    assert authorize["QueryStringsConfig"] == external["QueryStringsConfig"]
    for config in policies.values():
        assert config["CookiesConfig"] == {"CookieBehavior": "none"}
    caches = [
        resource["Properties"]["CachePolicyConfig"]
        for resource in template["Resources"].values()
        if resource["Type"] == "AWS::CloudFront::CachePolicy"
    ]
    for cache in caches:
        assert cache["ParametersInCacheKeyAndForwardedToOrigin"]["CookiesConfig"] == {
            "CookieBehavior": "none"
        }


def test_eval_failures_still_reach_the_dlq_and_the_stack_has_no_alarms():
    template = yaml.load(
        (ROOT / "apps/librarian/infra/cloudformation.yaml").read_text(), Loader=yaml.BaseLoader
    )
    resources = template["Resources"]
    mapping = resources["LibrarianEvalEventSource"]["Properties"]
    assert mapping["MaximumRetryAttempts"] == "3"
    assert mapping["DestinationConfig"]["OnFailure"]["Destination"] == "LibrarianEvalDlq.Arn"
    # Every alarm in this stack was retired 2026-11-03 (Jamie kept a handful
    # account-wide, none here). The topic stays: sibling site stacks name it.
    assert not [n for n, r in resources.items() if r["Type"] == "AWS::CloudWatch::Alarm"]
    assert resources["LibrarianAlarmTopic"]["Properties"]["TopicName"] == (
        "weekly-thing-librarian-alarms"
    )


# librarian.thingelstad.com has lived in the stack since 2026-11-02 (it was
# written by lambda/scripts/front-door.mjs before). These carry that writer's
# rules over to the template.
DOOR = [
    "LibrarianDistribution",
    "McpChallengeHeaders",
    "LibrarianAccessLogGroup",
    "LibrarianAccessLogSource",
    "LibrarianAccessLogDestination",
    "LibrarianAccessLogDelivery",
]
AUTH_ORIGIN = "LibrarianApiGatewayOrigin"
ARCHIVE_ORIGIN = "LibrarianStreamFunctionUrlOrigin"


def librarian_template():
    text = (ROOT / "apps/librarian/infra/cloudformation.yaml").read_text()
    return text, yaml.load(text, Loader=yaml.BaseLoader)["Resources"]


def test_the_door_is_retained_and_keeps_the_shared_web_acl():
    text, resources = librarian_template()
    for name in DOOR:
        assert resources[name]["DeletionPolicy"] == "Retain", name
        assert resources[name]["UpdateReplacePolicy"] == "Retain", name
    config = resources["LibrarianDistribution"]["Properties"]["DistributionConfig"]
    assert config["Aliases"] == ["librarian.thingelstad.com"]
    assert "WebACLId: !ImportValue edge-waf-WebAclArn" in text
    # The id lives in the stack now; nothing in the template pins it.
    assert "E18I2CIBERFMB7" not in text


def test_the_door_routes_to_the_native_endpoints_and_authorize_comes_first():
    _, resources = librarian_template()
    config = resources["LibrarianDistribution"]["Properties"]["DistributionConfig"]
    origins = {origin["Id"]: origin for origin in config["Origins"]}
    assert origins[AUTH_ORIGIN]["DomainName"] == "NativeAuthLiveEndpoint.DomainName"
    assert origins[ARCHIVE_ORIGIN]["DomainName"] == "NativeArchiveLiveEndpoint.DomainName"
    for origin in origins.values():
        assert origin["OriginAccessControlId"] == "NativeExternalOriginAccess.Id"
    default = config["DefaultCacheBehavior"]
    behaviors = config["CacheBehaviors"]
    # /authorize is first so no wider pattern ever claims it. /tools stays off
    # this door, and retired routes (curiosity map, 2026-08) have no behavior.
    assert [b["PathPattern"] for b in behaviors] == [
        "/authorize",
        "/chat",
        "/welcome",
        "/feedback",
        "/retrieve",
        "/mcp",
    ]
    authorize, *rest = behaviors
    assert authorize["TargetOriginId"] == AUTH_ORIGIN
    assert authorize["OriginRequestPolicyId"] == "NativeAuthorizeRequestPolicy.Id"
    assert authorize["FunctionAssociations"] == default["FunctionAssociations"]
    # Only /authorize forwards a cookie (thingy_email); the default and every
    # other behavior use the cookie-free request policy.
    for behavior in [default, *rest]:
        assert behavior["OriginRequestPolicyId"] == "NativeExternalRequestPolicy.Id"
    # The auth origin compresses; the archive never does, so SSE on /chat and
    # /mcp is never buffered.
    for behavior in [default, *behaviors]:
        auth = behavior["TargetOriginId"] == AUTH_ORIGIN
        assert behavior["Compress"] == ("true" if auth else "false")
        assert behavior["CachePolicyId"] == (
            "NativeCompressedCachePolicy.Id" if auth else "NativeExternalCachePolicy.Id"
        )
        assert behavior["ViewerProtocolPolicy"] == "https-only"
    assert [b["PathPattern"] for b in rest if b["TargetOriginId"] != ARCHIVE_ORIGIN] == []
    # Only /mcp restores the OAuth challenge header.
    assert [b["PathPattern"] for b in [default, *behaviors] if "ResponseHeadersPolicyId" in b] == [
        "/mcp"
    ]
    assert behaviors[-1]["ResponseHeadersPolicyId"] == "McpChallengeHeaders"


def test_mcp_challenge_names_the_protected_resource_and_never_overrides():
    _, resources = librarian_template()
    config = resources["McpChallengeHeaders"]["Properties"]["ResponseHeadersPolicyConfig"]
    assert set(config) == {"Name", "Comment", "CustomHeadersConfig"}
    [header] = config["CustomHeadersConfig"]["Items"]
    assert header["Header"] == "WWW-Authenticate"
    assert header["Value"] == (
        'Bearer resource_metadata="https://librarian.thingelstad.com'
        '/.well-known/oauth-protected-resource"'
    )
    assert header["Override"] == "false"


def test_door_access_log_records_no_client_ip_query_or_path():
    _, resources = librarian_template()
    group = resources["LibrarianAccessLogGroup"]["Properties"]
    assert group == {"LogGroupName": "/librarian/web-access", "RetentionInDays": "731"}
    source = resources["LibrarianAccessLogSource"]["Properties"]
    assert source["LogType"] == "ACCESS_LOGS"
    assert "${LibrarianDistribution}" in source["ResourceArn"]
    destination = resources["LibrarianAccessLogDestination"]["Properties"]
    assert destination["OutputFormat"] == "json"
    assert destination["DestinationResourceArn"].endswith(":log-group:${LibrarianAccessLogGroup}")
    delivery = resources["LibrarianAccessLogDelivery"]["Properties"]
    assert delivery["DeliverySourceName"] == "LibrarianAccessLogSource"
    assert delivery["DeliveryDestinationArn"] == "LibrarianAccessLogDestination.Arn"
    fields = delivery["RecordFields"]
    # GET /share/{token} carries a share token in the path.
    assert len(fields) == 13
    for field in fields:
        assert not re.search(r"c-ip|query|uri-stem|referer|cookie|x-forwarded", field, re.I), field


def test_cloudformation_keeps_the_door_but_cannot_make_or_delete_a_distribution():
    statements = policy("native-cloudformation")["Statement"]
    actions = [
        (action, statement["Resource"])
        for statement in statements
        for action in (
            statement["Action"] if isinstance(statement["Action"], list) else [statement["Action"]]
        )
    ]
    for action, resource in actions:
        assert not fnmatchcase("cloudfront:CreateDistribution", action), action
        assert not fnmatchcase("cloudfront:DeleteDistribution", action), action
        # The access log's pieces can be read, tagged and updated, never removed.
        arns = resource if isinstance(resource, list) else [resource]
        if any("web-access" in arn or ":delivery:" in arn for arn in arns):
            assert not action.startswith(("logs:Delete", "logs:Create")), action
    door = "arn:aws:cloudfront::999153317627:distribution/E18I2CIBERFMB7"
    assert [
        resource for action, resource in actions if action == "cloudfront:UpdateDistribution"
    ] == [door]
    assert [(a, r) for a, r in actions if a.startswith("wafv2:")] == [
        ("wafv2:GetWebACL", "arn:aws:wafv2:us-east-1:999153317627:global/webacl/edge/*")
    ]
