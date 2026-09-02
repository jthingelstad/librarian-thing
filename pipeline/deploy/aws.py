"""Package and deploy Thingy to AWS with CloudFormation."""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from dotenv import load_dotenv

REPO = Path(__file__).resolve().parents[2]
STACK_NAME = "weekly-thing-librarian"
TEMPLATE = REPO / "apps" / "librarian" / "infra" / "cloudformation.yaml"
LAMBDA_DIR = REPO / "apps" / "librarian" / "lambda"
LAMBDA_DIST_DIR = LAMBDA_DIR / "dist"
BUILD_DIR = REPO / "tmp" / "librarian_lambda"
STREAM_BUILD_DIR = REPO / "tmp" / "librarian_chat_lambda"
ZIP_PATH = REPO / "tmp" / "librarian_lambda.zip"
STREAM_ZIP_PATH = REPO / "tmp" / "librarian_chat_lambda.zip"
DEFAULT_LIBRARIAN_BUCKET = "weekly-thing-librarian"
PRIVATE_CODE_PREFIX = "code/auth-lambda"
PRIVATE_STREAM_CODE_PREFIX = "code/chat-lambda"
PRIVATE_CORPUS_KEY = "artifacts/corpus.json"
PRIVATE_GRAPH_KEY = "artifacts/graph.json"
PRIVATE_BLOG_CORPUS_KEY = "artifacts/blog_corpus.json"
PRIVATE_PODCAST_CORPUS_KEY = "artifacts/podcast_corpus.json"
DEFAULT_ALLOWED_ORIGINS = "https://weekly.thingelstad.com,https://thingy.thingelstad.com,http://localhost:8080,http://127.0.0.1:8080,http://localhost:4178,http://127.0.0.1:4178"
PROJECT_TAG_KEY = "project"
PROJECT_TAG_VALUE = "Thingy"
THINGY_MODEL_ENV_NAMES = (
    "THINGY_DEFAULT_MODEL",
    "THINGY_FAST_MODEL",
    "THINGY_PREMIUM_MODEL",
)
_lambda_dist_ready = False


def thingy_models_from_template() -> dict[str, str]:
    text = TEMPLATE.read_text()
    models: dict[str, str] = {}
    for name in THINGY_MODEL_ENV_NAMES:
        match = re.search(rf"{name}:\s*(\S+)", text)
        if not match:
            raise RuntimeError(f"Could not find {name} in {TEMPLATE}")
        models[name] = match.group(1).strip("'\"")
    return models


def smoke_test_model(model_id: str, label: str = "model") -> None:
    print(f"Smoke testing Bedrock InvokeModel for {label} {model_id}...")
    region = os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION") or "us-east-1"
    client = boto3.client("bedrock-runtime", region_name=region)
    body = json.dumps(
        {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 5,
            "messages": [{"role": "user", "content": "ping"}],
        }
    )
    try:
        client.invoke_model(modelId=model_id, contentType="application/json", body=body)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code == "ValidationException":
            raise RuntimeError(
                f"Bedrock rejected model id {model_id!r}. Verify the inference profile exists "
                f"with `aws bedrock list-inference-profiles`. Re-run with --skip-smoke-test to override."
            ) from exc
        if code == "AccessDeniedException":
            raise RuntimeError(
                f"Caller lacks bedrock:InvokeModel for {model_id!r}. Check IAM on the deploying identity."
            ) from exc
        raise
    print("  OK")


def smoke_test_thingy_models(models: dict[str, str]) -> None:
    for label, model_id in models.items():
        smoke_test_model(model_id, label)


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def run(args: list[str], cwd: Path = REPO) -> None:
    subprocess.run(args, cwd=cwd, check=True)


def ensure_lambda_dist() -> None:
    global _lambda_dist_ready
    if _lambda_dist_ready:
        return
    run(["npm", "ci", "--no-audit", "--no-fund"], cwd=LAMBDA_DIR)
    run(["npm", "run", "build"], cwd=LAMBDA_DIR)
    _lambda_dist_ready = True


def copy_lambda_source(build_dir: Path) -> None:
    ensure_lambda_dist()
    if build_dir.exists():
        shutil.rmtree(build_dir)
    build_dir.mkdir(parents=True)

    for name in ("package.json", "package-lock.json"):
        shutil.copy2(LAMBDA_DIR / name, build_dir / name)
    run(["npm", "ci", "--omit=dev", "--no-audit", "--no-fund"], cwd=build_dir)

    for name in ("auth", "chat", "eval", "shared", "prompts"):
        shutil.copytree(LAMBDA_DIST_DIR / name, build_dir / name, dirs_exist_ok=True)


def zip_build_dir(build_dir: Path, zip_path: Path) -> None:
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in build_dir.rglob("*"):
            if path.is_file():
                archive.write(path, path.relative_to(build_dir))


def package_lambda() -> None:
    copy_lambda_source(BUILD_DIR)
    zip_build_dir(BUILD_DIR, ZIP_PATH)


def package_stream_lambda() -> None:
    copy_lambda_source(STREAM_BUILD_DIR)
    zip_build_dir(STREAM_BUILD_DIR, STREAM_ZIP_PATH)


def upload_file(bucket: str, key: str, path: Path, content_type: str) -> None:
    boto3.client("s3").upload_file(str(path), bucket, key, ExtraArgs={"ContentType": content_type})


def ensure_private_bucket(bucket: str) -> None:
    """Create and harden the private Librarian artifact bucket when needed."""
    s3 = boto3.client("s3")
    region = (
        boto3.session.Session().region_name or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
    )
    try:
        s3.head_bucket(Bucket=bucket)
    except s3.exceptions.ClientError as exc:
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if status not in (301, 403, 404) and code not in {"404", "NoSuchBucket", "NotFound"}:
            raise
        if status == 403:
            raise RuntimeError(
                f"Cannot access s3://{bucket}; choose a bucket you own or fix IAM"
            ) from exc
        kwargs = {"Bucket": bucket}
        if region != "us-east-1":
            kwargs["CreateBucketConfiguration"] = {"LocationConstraint": region}
        s3.create_bucket(**kwargs)
        waiter = s3.get_waiter("bucket_exists")
        waiter.wait(Bucket=bucket)

    s3.put_public_access_block(
        Bucket=bucket,
        PublicAccessBlockConfiguration={
            "BlockPublicAcls": True,
            "IgnorePublicAcls": True,
            "BlockPublicPolicy": True,
            "RestrictPublicBuckets": True,
        },
    )
    s3.put_bucket_versioning(Bucket=bucket, VersioningConfiguration={"Status": "Enabled"})
    s3.put_bucket_encryption(
        Bucket=bucket,
        ServerSideEncryptionConfiguration={
            "Rules": [
                {
                    "ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"},
                    "BucketKeyEnabled": False,
                }
            ]
        },
    )
    try:
        current_tags = s3.get_bucket_tagging(Bucket=bucket).get("TagSet", [])
    except s3.exceptions.ClientError as exc:
        if exc.response.get("Error", {}).get("Code") != "NoSuchTagSet":
            raise
        current_tags = []
    s3.put_bucket_tagging(
        Bucket=bucket,
        Tagging={
            "TagSet": [
                *[tag for tag in current_tags if tag.get("Key") != PROJECT_TAG_KEY],
                {"Key": PROJECT_TAG_KEY, "Value": PROJECT_TAG_VALUE},
            ]
        },
    )
    managed_lifecycle_rules = [
        {
            "ID": "expire-old-lambda-packages",
            "Status": "Enabled",
            "Filter": {"Prefix": "code/"},
            "Expiration": {"Days": 30},
            "NoncurrentVersionExpiration": {"NoncurrentDays": 30},
        },
        {
            "ID": "transition-bedrock-invocation-logs",
            "Status": "Enabled",
            "Filter": {"Prefix": "logs/invocations/"},
            "Transitions": [{"Days": 90, "StorageClass": "GLACIER_IR"}],
            "NoncurrentVersionExpiration": {"NoncurrentDays": 90},
        },
        {
            "ID": "expire-thingy-dispatch-artifacts",
            "Status": "Enabled",
            "Filter": {"Prefix": "artifacts/dispatches/"},
            "Expiration": {"Days": 90},
            "NoncurrentVersionExpiration": {"NoncurrentDays": 30},
        },
    ]
    try:
        current_lifecycle_rules = s3.get_bucket_lifecycle_configuration(Bucket=bucket).get(
            "Rules", []
        )
    except s3.exceptions.ClientError as exc:
        if exc.response.get("Error", {}).get("Code") != "NoSuchLifecycleConfiguration":
            raise
        current_lifecycle_rules = []
    managed_ids = {rule["ID"] for rule in managed_lifecycle_rules}
    s3.put_bucket_lifecycle_configuration(
        Bucket=bucket,
        LifecycleConfiguration={
            "Rules": [
                *[rule for rule in current_lifecycle_rules if rule.get("ID") not in managed_ids],
                *managed_lifecycle_rules,
            ]
        },
    )


def deploy_stack(
    *,
    stack_name: str,
    bucket: str,
    code_key: str,
    stream_code_key: str,
    corpus_key: str,
    graph_key: str,
    blog_corpus_key: str,
    podcast_corpus_key: str,
    allowed_origin: str,
    buttondown_api_key: str,
    session_secret: str | None,
    librarian_retrieve_secret: str | None,
    fastmail_jmap_token: str | None,
    brave_search_api_key: str | None,
    thingy_web_origin_token: str | None,
    thingy_magic_link_from_email: str,
    thingy_magic_link_base_url: str,
    stream_custom_domain_name: str,
    stream_certificate_arn: str,
    log_level: str,
    auth_rate_limit_max: str,
    cloudformation_role_arn: str | None,
) -> tuple[dict[str, str], bool]:
    cloudformation = boto3.client("cloudformation")
    body = TEMPLATE.read_text(encoding="utf-8")

    exists = True
    existing_parameter_keys: set[str] = set()
    try:
        stack = cloudformation.describe_stacks(StackName=stack_name)["Stacks"][0]
        existing_parameter_keys = {
            str(param.get("ParameterKey"))
            for param in stack.get("Parameters", [])
            if param.get("ParameterKey")
        }
    except cloudformation.exceptions.ClientError:
        exists = False

    generated_session_secret = False
    session_parameter: dict[str, str | bool]
    if session_secret:
        session_parameter = {"ParameterKey": "SessionSecret", "ParameterValue": session_secret}
    elif exists:
        session_parameter = {"ParameterKey": "SessionSecret", "UsePreviousValue": True}
    else:
        session_parameter = {
            "ParameterKey": "SessionSecret",
            "ParameterValue": secrets.token_urlsafe(48),
        }
        generated_session_secret = True

    retrieve_parameter: dict[str, str | bool]
    if librarian_retrieve_secret:
        retrieve_parameter = {
            "ParameterKey": "LibrarianRetrieveSecret",
            "ParameterValue": librarian_retrieve_secret,
        }
    elif exists and "LibrarianRetrieveSecret" in existing_parameter_keys:
        retrieve_parameter = {
            "ParameterKey": "LibrarianRetrieveSecret",
            "UsePreviousValue": True,
        }
    else:
        raise RuntimeError("LIBRARIAN_RETRIEVE_SECRET is required")

    if fastmail_jmap_token:
        fastmail_parameter = {
            "ParameterKey": "FastmailJmapToken",
            "ParameterValue": fastmail_jmap_token,
        }
    elif exists and "FastmailJmapToken" in existing_parameter_keys:
        fastmail_parameter = {"ParameterKey": "FastmailJmapToken", "UsePreviousValue": True}
    else:
        fastmail_parameter = {"ParameterKey": "FastmailJmapToken", "ParameterValue": ""}

    origin_token_parameter: dict[str, str | bool]
    if thingy_web_origin_token:
        origin_token_parameter = {
            "ParameterKey": "ThingyWebOriginToken",
            "ParameterValue": thingy_web_origin_token,
        }
    elif exists and "ThingyWebOriginToken" in existing_parameter_keys:
        origin_token_parameter = {"ParameterKey": "ThingyWebOriginToken", "UsePreviousValue": True}
    else:
        origin_token_parameter = {"ParameterKey": "ThingyWebOriginToken", "ParameterValue": ""}

    if brave_search_api_key:
        brave_parameter = {
            "ParameterKey": "BraveSearchApiKey",
            "ParameterValue": brave_search_api_key,
        }
    elif exists and "BraveSearchApiKey" in existing_parameter_keys:
        brave_parameter = {"ParameterKey": "BraveSearchApiKey", "UsePreviousValue": True}
    else:
        brave_parameter = {"ParameterKey": "BraveSearchApiKey", "ParameterValue": ""}

    parameters = [
        {"ParameterKey": "AllowedOrigin", "ParameterValue": allowed_origin},
        {"ParameterKey": "CodeBucket", "ParameterValue": bucket},
        {"ParameterKey": "CodeKey", "ParameterValue": code_key},
        {"ParameterKey": "StreamCodeKey", "ParameterValue": stream_code_key},
        {"ParameterKey": "CorpusBucket", "ParameterValue": bucket},
        {"ParameterKey": "CorpusKey", "ParameterValue": corpus_key},
        {"ParameterKey": "GraphKey", "ParameterValue": graph_key},
        {"ParameterKey": "BlogCorpusKey", "ParameterValue": blog_corpus_key},
        {"ParameterKey": "PodcastCorpusKey", "ParameterValue": podcast_corpus_key},
        {"ParameterKey": "ButtondownApiKey", "ParameterValue": buttondown_api_key},
        session_parameter,
        retrieve_parameter,
        fastmail_parameter,
        origin_token_parameter,
        brave_parameter,
        {"ParameterKey": "LogLevel", "ParameterValue": log_level},
        {"ParameterKey": "AuthRateLimitMax", "ParameterValue": auth_rate_limit_max},
        {
            "ParameterKey": "ThingyMagicLinkFromEmail",
            "ParameterValue": thingy_magic_link_from_email,
        },
        {"ParameterKey": "ThingyMagicLinkBaseUrl", "ParameterValue": thingy_magic_link_base_url},
        {"ParameterKey": "StreamCustomDomainName", "ParameterValue": stream_custom_domain_name},
        {"ParameterKey": "StreamCertificateArn", "ParameterValue": stream_certificate_arn},
    ]
    stack_options = {
        "TemplateBody": body,
        "Parameters": parameters,
        "Capabilities": ["CAPABILITY_IAM"],
        "Tags": [{"Key": PROJECT_TAG_KEY, "Value": PROJECT_TAG_VALUE}],
    }
    if cloudformation_role_arn:
        stack_options["RoleARN"] = cloudformation_role_arn

    if exists:
        try:
            cloudformation.update_stack(
                StackName=stack_name,
                **stack_options,
            )
            waiter_name = "stack_update_complete"
        except cloudformation.exceptions.ClientError as exc:
            if "No updates are to be performed" in str(exc):
                return stack_outputs(cloudformation, stack_name), generated_session_secret
            raise
    else:
        cloudformation.create_stack(
            StackName=stack_name,
            **stack_options,
        )
        waiter_name = "stack_create_complete"

    try:
        cloudformation.get_waiter(waiter_name).wait(StackName=stack_name)
    except Exception:
        # Surface the actual resource failures - the waiter error alone only
        # says the stack rolled back, which is undiagnosable from CI logs.
        try:
            events = cloudformation.describe_stack_events(StackName=stack_name)["StackEvents"]
            for event in events[:40]:
                status = event.get("ResourceStatus", "")
                if "FAILED" in status or "ROLLBACK" in status:
                    print(
                        f"CFN {status} {event.get('LogicalResourceId')}: "
                        f"{event.get('ResourceStatusReason', '')}"
                    )
        except Exception as inner:
            print(f"Could not fetch stack events: {inner}")
        raise
    return stack_outputs(cloudformation, stack_name), generated_session_secret


def stack_output(cloudformation, stack_name: str, key: str) -> str:
    return stack_outputs(cloudformation, stack_name).get(key, "")


def stack_outputs(cloudformation, stack_name: str) -> dict[str, str]:
    stack = cloudformation.describe_stacks(StackName=stack_name)["Stacks"][0]
    result = {}
    for output in stack.get("Outputs", []):
        if output.get("OutputKey"):
            result[str(output["OutputKey"])] = str(output.get("OutputValue", ""))
    return result


def stack_resource_physical_id(cloudformation, stack_name: str, logical_id: str) -> str:
    resource = cloudformation.describe_stack_resource(
        StackName=stack_name, LogicalResourceId=logical_id
    )["StackResourceDetail"]
    return str(resource.get("PhysicalResourceId", ""))


def configure_log_retention(stack_name: str, days: int = 30) -> None:
    cloudformation = boto3.client("cloudformation")
    logs = boto3.client("logs")
    session = boto3.session.Session()
    region = session.region_name or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
    account_id = boto3.client("sts").get_caller_identity()["Account"]
    for logical_id in ("LibrarianFunction", "LibrarianStreamFunction", "LibrarianEvalFunction"):
        function_name = stack_resource_physical_id(cloudformation, stack_name, logical_id)
        if not function_name:
            continue
        log_group_name = f"/aws/lambda/{function_name}"
        try:
            logs.create_log_group(logGroupName=log_group_name)
        except logs.exceptions.ResourceAlreadyExistsException:
            pass
        logs.put_retention_policy(logGroupName=log_group_name, retentionInDays=days)
        log_group_arn = f"arn:aws:logs:{region}:{account_id}:log-group:{log_group_name}"
        try:
            logs.tag_resource(resourceArn=log_group_arn, tags={PROJECT_TAG_KEY: PROJECT_TAG_VALUE})
        except ClientError:
            logs.tag_log_group(
                logGroupName=log_group_name, tags={PROJECT_TAG_KEY: PROJECT_TAG_VALUE}
            )


def update_env_file(values: dict[str, str]) -> None:
    env_path = REPO / ".env"
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    remaining = {key: value for key, value in values.items() if value}
    updated: list[str] = []
    for line in lines:
        key = line.split("=", 1)[0] if "=" in line else ""
        if key in remaining:
            updated.append(f"{key}={remaining.pop(key)}")
        else:
            updated.append(line)
    for key, value in remaining.items():
        updated.append(f"{key}={value}")
    env_path.write_text("\n".join(updated).rstrip() + "\n", encoding="utf-8")


def upload_librarian_corpora(args: argparse.Namespace, bucket: str) -> None:
    """Build/embed/upload every corpus the Librarian API can load.

    The stream Lambda now answers over three independent S3 artifacts:
    Weekly Thing (plus graph), thingelstad.com blog, and Another Thing
    podcast. A "full" deploy should refresh all three so code/schema changes
    don't leave the optional corpora on an older shape.
    """
    tmp_dir = REPO / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    run(
        [
            sys.executable,
            "pipeline/deploy/upload_corpus.py",
            "--bucket",
            bucket,
            "--key",
            args.corpus_key,
            "--graph-key",
            args.graph_key,
            "--keep-output",
            str(tmp_dir / "librarian_embedded_corpus.json"),
        ]
    )
    run(
        [
            sys.executable,
            "pipeline/deploy/upload_blog_corpus.py",
            "--bucket",
            bucket,
            "--key",
            args.blog_corpus_key,
            "--keep-output",
            str(tmp_dir / "librarian_embedded_blog_corpus.json"),
        ]
    )
    run(
        [
            sys.executable,
            "pipeline/deploy/upload_podcast_corpus.py",
            "--bucket",
            bucket,
            "--key",
            args.podcast_corpus_key,
            "--keep-output",
            str(tmp_dir / "librarian_embedded_podcast_corpus.json"),
        ]
    )


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack-name", default=STACK_NAME)
    parser.add_argument(
        "--bucket", default=os.environ.get("LIBRARIAN_BUCKET") or DEFAULT_LIBRARIAN_BUCKET
    )
    parser.add_argument(
        "--allowed-origin",
        default=os.environ.get("LIBRARIAN_ALLOWED_ORIGIN", DEFAULT_ALLOWED_ORIGINS),
    )
    parser.add_argument(
        "--corpus-key", default=os.environ.get("LIBRARIAN_CORPUS_KEY", PRIVATE_CORPUS_KEY)
    )
    parser.add_argument(
        "--graph-key", default=os.environ.get("LIBRARIAN_GRAPH_KEY", PRIVATE_GRAPH_KEY)
    )
    parser.add_argument(
        "--blog-corpus-key",
        default=os.environ.get("LIBRARIAN_BLOG_CORPUS_KEY", PRIVATE_BLOG_CORPUS_KEY),
    )
    parser.add_argument(
        "--podcast-corpus-key",
        default=os.environ.get("LIBRARIAN_PODCAST_CORPUS_KEY", PRIVATE_PODCAST_CORPUS_KEY),
    )
    parser.add_argument(
        "--cloudformation-role-arn", default=os.environ.get("LIBRARIAN_CLOUDFORMATION_ROLE_ARN")
    )
    parser.add_argument("--log-level", default=os.environ.get("LIBRARIAN_LOG_LEVEL", "INFO"))
    parser.add_argument(
        "--auth-rate-limit-max", default=os.environ.get("LIBRARIAN_AUTH_RATE_LIMIT_MAX", "30")
    )
    parser.add_argument(
        "--thingy-magic-link-from-email",
        default=os.environ.get("THINGY_MAGIC_LINK_FROM_EMAIL", "thingy@thingelstad.com"),
    )
    parser.add_argument(
        "--thingy-magic-link-base-url",
        # /signin/ owns magic-link redemption; landing on the root relied on a
        # client-side forwarding hop (kept for emails already in flight).
        default=os.environ.get("THINGY_MAGIC_LINK_BASE_URL", "https://thingy.thingelstad.com/signin/"),
    )
    parser.add_argument(
        "--stream-custom-domain-name",
        default=os.environ.get("LIBRARIAN_STREAM_CUSTOM_DOMAIN_NAME", ""),
    )
    parser.add_argument(
        "--stream-certificate-arn", default=os.environ.get("LIBRARIAN_STREAM_CERTIFICATE_ARN", "")
    )
    parser.add_argument("--skip-corpus-upload", action="store_true")
    parser.add_argument("--skip-bucket-bootstrap", action="store_true")
    parser.add_argument("--skip-smoke-test", action="store_true")
    args = parser.parse_args()

    bucket = args.bucket
    if not bucket:
        raise RuntimeError("Provide --bucket or LIBRARIAN_BUCKET")

    if not args.skip_smoke_test:
        smoke_test_thingy_models(thingy_models_from_template())

    if not args.skip_bucket_bootstrap:
        ensure_private_bucket(bucket)

    package_lambda()
    package_stream_lambda()
    code_key = f"{PRIVATE_CODE_PREFIX}/{int(time.time())}.zip"
    stream_code_key = f"{PRIVATE_STREAM_CODE_PREFIX}/{int(time.time())}.zip"
    upload_file(bucket, code_key, ZIP_PATH, "application/zip")
    print(f"Uploaded Lambda package to s3://{bucket}/{code_key}")
    upload_file(bucket, stream_code_key, STREAM_ZIP_PATH, "application/zip")
    print(f"Uploaded streaming Lambda package to s3://{bucket}/{stream_code_key}")

    if not args.skip_corpus_upload:
        upload_librarian_corpora(args, bucket)

    session_secret = os.environ.get("LIBRARIAN_SESSION_SECRET")
    thingy_web_origin_token = os.environ.get("THINGY_WEB_ORIGIN_TOKEN") or None
    librarian_retrieve_secret = os.environ.get("LIBRARIAN_RETRIEVE_SECRET") or None
    fastmail_jmap_token = (
        os.environ.get("FASTMAIL_JMAP_TOKEN")
        or os.environ.get("THINGY_FASTMAIL_JMAP_TOKEN")
        or os.environ.get("THINGY_JMAP_TOKEN")
        or None
    )
    brave_search_api_key = os.environ.get("BRAVE_SEARCH_API_KEY") or None
    outputs, generated_session_secret = deploy_stack(
        stack_name=args.stack_name,
        bucket=bucket,
        code_key=code_key,
        stream_code_key=stream_code_key,
        corpus_key=args.corpus_key,
        graph_key=args.graph_key,
        blog_corpus_key=args.blog_corpus_key,
        podcast_corpus_key=args.podcast_corpus_key,
        allowed_origin=args.allowed_origin,
        buttondown_api_key=require_env("BUTTONDOWN_API_KEY"),
        session_secret=session_secret,
        librarian_retrieve_secret=librarian_retrieve_secret,
        fastmail_jmap_token=fastmail_jmap_token,
        brave_search_api_key=brave_search_api_key,
        thingy_web_origin_token=thingy_web_origin_token,
        thingy_magic_link_from_email=args.thingy_magic_link_from_email,
        thingy_magic_link_base_url=args.thingy_magic_link_base_url,
        stream_custom_domain_name=args.stream_custom_domain_name,
        stream_certificate_arn=args.stream_certificate_arn,
        log_level=args.log_level.upper(),
        auth_rate_limit_max=str(args.auth_rate_limit_max),
        cloudformation_role_arn=args.cloudformation_role_arn,
    )
    for key, value in sorted(outputs.items()):
        print(f"{key}={value}")
    configure_log_retention(args.stack_name)
    update_env_file(
        {
            "LIBRARIAN_API_URL": outputs.get("LibrarianApiUrl", ""),
            "LIBRARIAN_STREAM_URL": outputs.get("LibrarianStreamUrl", ""),
        }
    )
    if generated_session_secret:
        print(
            "Generated an initial session secret for this stack. Future updates will reuse it unless LIBRARIAN_SESSION_SECRET is set."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
