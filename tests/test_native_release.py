"""Native release selection and parameter-preservation regression gates."""

import importlib.util
from pathlib import Path
from unittest.mock import Mock

from pipeline.deploy.native_release import promotion

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("native_aws_deploy", ROOT / "pipeline/deploy/aws.py")
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


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


def test_legacy_deploy_preserves_native_settings_and_accepts_first_bootstrap(monkeypatch):
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
            stream_code_key="code/chat",
            corpus_key="artifacts/corpus.json",
            graph_key="artifacts/graph.json",
            blog_corpus_key="artifacts/blog_corpus.json",
            podcast_corpus_key="artifacts/podcast_corpus.json",
            allowed_origin="https://thingy.thingelstad.com",
            thingy_magic_link_from_email="thingy@example.test",
            thingy_magic_link_base_url="https://thingy.thingelstad.com",
            stream_custom_domain_name="",
            stream_certificate_arn="",
            log_level="INFO",
            auth_rate_limit_max="30",
            cloudformation_role_arn="arn:example:role/cfn",
        )
        parameters = client.update_stack.call_args.kwargs["Parameters"]
        native = [p for p in parameters if p["ParameterKey"].startswith("Native")]
        assert native == [
            {"ParameterKey": p["ParameterKey"], "UsePreviousValue": True} for p in previous
        ]
