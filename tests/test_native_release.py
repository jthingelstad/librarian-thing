"""Native release selection and parameter-preservation regression gates."""

import hashlib
import importlib.util
from pathlib import Path
from unittest.mock import Mock, call

import yaml

from pipeline.deploy.native_release import promotion

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("native_aws_deploy", ROOT / "pipeline/deploy/aws.py")
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


def test_small_template_uses_inline_body_without_upload(monkeypatch):
    client = Mock()
    monkeypatch.setattr(deploy.boto3, "client", lambda _name: client)
    assert deploy.stack_template("a" * 51_200, "weekly-thing-librarian") == {
        "TemplateBody": "a" * 51_200
    }
    client.put_object.assert_not_called()


def test_large_template_uploads_exact_utf8_to_private_content_addressed_key(monkeypatch):
    client = Mock()
    monkeypatch.setattr(deploy.boto3, "client", lambda _name: client)
    body = "é" * 25_601
    data = body.encode("utf-8")
    key = f"code/templates/{hashlib.sha256(data).hexdigest()}.yaml"
    assert deploy.stack_template(body, "weekly-thing-librarian") == {
        "TemplateURL": f"https://weekly-thing-librarian.s3.us-east-1.amazonaws.com/{key}"
    }
    client.put_object.assert_called_once_with(
        Bucket="weekly-thing-librarian", Key=key, Body=data, ContentType="application/x-yaml"
    )


def test_promotion_keeps_the_previous_live_revision_protected():
    output = {
        "NativeAuthCandidateRevision": "auth-new",
        "NativeArchiveCandidateRevision": "archive-new",
    }
    prior = {"NativeAuthLiveRevision": "auth-good", "NativeArchiveLiveRevision": "archive-good"}
    selected = {p["ParameterKey"]: p["ParameterValue"] for p in promotion(output, prior)}
    assert selected == {
        "NativeAuthLiveRevision": "auth-new",
        "NativeAuthRollbackRevision": "auth-good",
        "NativeArchiveLiveRevision": "archive-new",
        "NativeArchiveRollbackRevision": "archive-good",
    }


def test_routine_deploy_preserves_native_settings_and_accepts_first_bootstrap(monkeypatch):
    for previous in (
        [],
        [
            {"ParameterKey": "NativeWebEnabled", "ParameterValue": "true"},
            {"ParameterKey": "NativeAuthLiveRevision", "ParameterValue": "rev-good"},
        ],
    ):
        client = Mock()
        client.describe_stacks.return_value = {"Stacks": [{"Parameters": previous, "Outputs": []}]}
        monkeypatch.setattr(deploy.boto3, "client", lambda _name: client)
        deploy.deploy_stack(
            stack_name="weekly-thing-librarian",
            bucket="weekly-thing-librarian",
            code_key="code/auth",
            corpus_key="artifacts/corpus.json",
            graph_key="artifacts/graph.json",
            blog_corpus_key="artifacts/blog_corpus.json",
            podcast_corpus_key="artifacts/podcast_corpus.json",
            reference_corpus_key="artifacts/reference_corpus.json",
            links_corpus_key="artifacts/links_corpus.json",
            allowed_origin="https://thingy.thingelstad.com",
            thingy_magic_link_from_email="thingy@example.test",
            thingy_magic_link_base_url="https://thingy.thingelstad.com",
            thingy_effort="medium",
            log_level="INFO",
            auth_rate_limit_max="30",
            turnstile_mode_weekly="enforce",
            cloudformation_role_arn="arn:example:role/cfn",
        )
        parameters = client.update_stack.call_args.kwargs["Parameters"]
        assert {"StreamCodeKey", "StreamCustomDomainName", "StreamCertificateArn"}.isdisjoint(
            p["ParameterKey"] for p in parameters
        )
        native = [p for p in parameters if p["ParameterKey"].startswith("Native")]
        assert native == [
            {"ParameterKey": p["ParameterKey"], "UsePreviousValue": True} for p in previous
        ]


def test_http_retirement_preserves_native_functions_and_event_workers():
    template = yaml.load(deploy.TEMPLATE.read_text(), Loader=yaml.BaseLoader)
    resources = template["Resources"]
    event_functions = {
        name for name, resource in resources.items() if resource["Type"] == "AWS::Lambda::Function"
    }
    assert event_functions == {"LibrarianEvalFunction", "LibrarianDigestFunction"}
    assert not any(
        resource["Type"].startswith("AWS::ApiGateway") or resource["Type"] == "AWS::Lambda::Url"
        for resource in resources.values()
    )
    assert {
        "NativeAuthFunction",
        "NativeArchiveFunction",
        "NativeAuthRollbackEndpoint",
        "NativeArchiveRollbackEndpoint",
        "LibrarianTable",
        "NativeSourceBucket",
        "LibrarianEvalEventSource",
        "LibrarianSubscribeDigestRule",
    } <= resources.keys()
    for resource in resources.values():
        if resource["Type"] == "AWS::Logs::MetricFilter":
            assert resource["Properties"]["LogGroupName"] in {
                "NativeAuthLogs",
                "NativeArchiveLogs",
                "LibrarianDigestLogGroup",
            }
    assert "LibrarianRawStreamUrl" not in template["Outputs"]
    for name in ("LibrarianApiUrl", "LibrarianStreamUrl"):
        assert template["Outputs"][name]["Value"] == "https://librarian.thingelstad.com"


def test_log_setup_does_not_resolve_deleted_http_functions(monkeypatch):
    cloudformation, logs, sts = Mock(), Mock(), Mock()

    def resource(*, StackName, LogicalResourceId):
        assert LogicalResourceId == "LibrarianEvalFunction"
        return {"StackResourceDetail": {"PhysicalResourceId": "eval-worker"}}

    cloudformation.describe_stack_resource.side_effect = resource
    sts.get_caller_identity.return_value = {"Account": "999153317627"}
    clients = {"cloudformation": cloudformation, "logs": logs, "sts": sts}
    monkeypatch.setattr(deploy.boto3, "client", lambda name: clients[name])
    monkeypatch.setattr(deploy.boto3.session, "Session", lambda: Mock(region_name="us-east-1"))
    deploy.configure_log_retention("weekly-thing-librarian")
    assert logs.put_retention_policy.call_args_list == [
        call(logGroupName="/aws/lambda/eval-worker", retentionInDays=30),
        call(logGroupName="/aws/lambda/weekly-thing-librarian-web-auth.local", retentionInDays=30),
        call(
            logGroupName="/aws/lambda/weekly-thing-librarian-web-archive.local", retentionInDays=30
        ),
    ]
    logs.create_log_group.assert_called_once_with(logGroupName="/aws/lambda/eval-worker")


def test_log_setup_skips_a_missing_web_function_local_group(monkeypatch):
    cloudformation, logs, sts = Mock(), Mock(), Mock()
    cloudformation.describe_stack_resource.return_value = {
        "StackResourceDetail": {"PhysicalResourceId": "eval-worker"}
    }
    sts.get_caller_identity.return_value = {"Account": "999153317627"}

    class NotFound(Exception):
        pass

    logs.exceptions.ResourceNotFoundException = NotFound
    logs.exceptions.ResourceAlreadyExistsException = type("Exists", (Exception,), {})

    def retention(*, logGroupName, retentionInDays):
        if logGroupName.endswith("-web-auth.local"):
            raise NotFound()

    logs.put_retention_policy.side_effect = retention
    clients = {"cloudformation": cloudformation, "logs": logs, "sts": sts}
    monkeypatch.setattr(deploy.boto3, "client", lambda name: clients[name])
    monkeypatch.setattr(deploy.boto3.session, "Session", lambda: Mock(region_name="us-east-1"))
    deploy.configure_log_retention("weekly-thing-librarian")
    assert [c.kwargs["logGroupName"] for c in logs.put_retention_policy.call_args_list][-1] == (
        "/aws/lambda/weekly-thing-librarian-web-archive.local"
    )
