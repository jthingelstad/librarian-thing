# pipeline/deploy/ — project memory

AWS deploy tooling for the Thingy Lambda stack. No README — this directory is operator-only.

## The three scripts

| Script | What it does |
|---|---|
| `aws.py` | Packages the Event worker/shared bundle and both immutable native HTTP bundles, optionally uploads corpora, then updates CloudFormation without carrying application secrets. **The canonical deploy entrypoint.** |
| `upload_corpus.py` | Builds the Weekly Thing corpus + graph from `data/issues/*/archive.md`, embeds via Bedrock Cohere, uploads to S3. Called by `aws.py` during full corpus deploys. |
| `upload_blog_corpus.py` | Builds the thingelstad.com blog corpus from `data/blog/posts`, embeds via Bedrock Cohere with S3 cache reuse, uploads to S3. Called by `aws.py` during full corpus deploys. |
| `upload_podcast_corpus.py` | Builds the Another Thing podcast corpus from `data/podcast/another-thing/episodes`, embeds via Bedrock Cohere with S3 cache reuse, uploads to S3. Called by `aws.py` during full corpus deploys. |
| `upload_reference_corpus.py` | Builds the reference base (site pages, FAQ, Things I've built, thingelstad.com's pages, reference documents) from `data/`, embeds via Bedrock Cohere with S3 cache reuse, uploads `reference_corpus.json` to S3. Called by `aws.py` during full corpus deploys. |
| `upload_links_corpus.py` | Builds the links corpus (Linking Things' saved links, one passage each) from `data/links/`, embeds via Bedrock Cohere with S3 cache reuse, uploads `links_corpus.json` to S3. Called by `aws.py` during full corpus deploys. |
| `bedrock_logging.py` | Configures Bedrock model invocation logging (CloudWatch destination + S3 archive). One-time setup. |

## Invocation

Normal deployments run in GitHub Actions after a verified commit/push.
`make librarian-deploy` queues a code-only deploy of remote `main` and prints its
run URL; it needs GitHub authentication but no local AWS CLI session. Wait for
the run before reporting acceptance. Direct
`uv run --locked python pipeline/deploy/aws.py` is an exceptional local operation
requiring valid AWS credentials.
Local `.env` selects `AWS_PROFILE=cloud-engineer`; keep AWS access-key variables out of
that file and the calling shell so they cannot override the profile. Verify
local access with `aws sts get-caller-identity --profile cloud-engineer`. This session is
needed only for local AWS operations, not the GitHub deployment shortcut.
The deploy script must run through the locked uv environment so dependencies such as
`boto3` and `python-dotenv` are available; do not invoke it with bare system Python.

```bash
# Default for code changes — skip the slow + paid corpus reupload
make librarian-deploy ARGS="--skip-corpus-upload"

# Full deploy (re-embeds + uploads all three corpora)
make librarian-deploy-full

# Exceptional local deployment when bypassing make
uv run --locked python pipeline/deploy/aws.py --skip-corpus-upload
```

The `--skip-corpus-upload` flag is the default for any **code-only** change (Lambda code, CloudFormation tweaks, env-var changes). Full corpus reupload refreshes **Weekly Thing + blog + podcast** and is **slow/paid**. Each source-specific uploader reuses embeddings from the previously deployed S3 artifact when chunk ids match. Only do a full deploy when:

- The corpus itself is stale (new issues to embed)
- The embed model has changed (Cohere v3 → v4, hypothetically)
- The corpus schema has changed (e.g., new chunk metadata field)

CI in `.github/workflows/deploy.yml` exports the library to `data/` and builds and uploads the corpora the library or the code moved past. Content enters the library through the library round (`.github/workflows/library-round.yml`, and the Library Agent on the Mac), which starts `deploy.yml` when a corpus is stale (`pipeline/library/README.md`). Manual deploys are for local validation before commit.

## `aws.py` flow

1. **Check the Thingy model ids** (`THINGY_DEFAULT_MODEL`, `THINGY_FAST_MODEL`, `THINGY_PREMIUM_MODEL`). Thingy calls the Anthropic API since 2026-10, so each must be an Anthropic API id (`claude-...`); a Bedrock id refuses the deploy. CI holds no Anthropic key, so there the check is the id's shape; with `ANTHROPIC_API_KEY` set (a local deploy) it also looks each model up (`GET /v1/models/{id}`, no tokens spent). Pass `--skip-smoke-test` to override.
2. **Verify private bucket security** (`verify_private_bucket(bucket)`). Administrator-only `--bootstrap-bucket` creates or hardens it. Default bucket: `LIBRARIAN_BUCKET` env var or `weekly-thing-librarian`.
3. **Package shared modules and Event workers**, then create two native root entries (`web/auth.mjs`, `web/archive.mjs`) in versioned immutable bundles.
4. **Upload the Event worker zip** under `code/auth-lambda/` and immutable native bundles to the versioned source bucket. Snapshot live/rollback pins, probe candidates, then promote explicitly.
5. **Optional**: all corpus uploaders run: Weekly Thing corpus + graph, blog corpus, podcast corpus, reference corpus, links corpus.
6. **CloudFormation update-stack** with the new code keys and settings. No credentials: the Lambdas read them from the hand-kept `weekly-thing-librarian-runtime` secret.
7. **30-day log retention** on the auto-created log groups (`configure_log_retention`).
8. **Update `.env`** with the latest stack outputs: `LIBRARIAN_API_URL`, `LIBRARIAN_STREAM_URL`.

## Corpus upload flow

1. Weekly Thing: `upload_corpus.py` builds from `data/issues/*/archive.md`, embeds chunks, builds the graph, uploads `corpus.json` + `graph.json`.
2. Blog: `upload_blog_corpus.py` builds from `data/blog/posts/**/*.md`, reuses cached embeddings by chunk id, uploads `blog_corpus.json`.
3. Podcast: `upload_podcast_corpus.py` builds from `data/podcast/another-thing/episodes/*.json`, reuses cached embeddings by chunk id, uploads `podcast_corpus.json`.
4. Reference: `upload_reference_corpus.py` builds from `data/site/`, `data/things/`, `data/blog/pages/`, `data/reference/`, `data/reference-unpublished/` and the FAQ, reuses cached embeddings by chunk id, uploads `reference_corpus.json`. A malformed reference document fails the build with its file name.
5. Links: `upload_links_corpus.py` builds from `data/links/` (Linking Things' links.json and issues.json, snapshotted by `pipeline/links/import_links.py`), reuses cached embeddings by chunk id, uploads `links_corpus.json`. With no snapshot in the library the corpus is empty and the build says so.
6. The Lambda's `loadCorpus()`, `loadBlogCorpus()`, `loadPodcastCorpus()`, the reference loader (`REFERENCE_CORPUS_KEY`, searched by every retrieval) and the links loader (`LINKS_CORPUS_KEY`, read only when a request names source kind `link`) pick up new files on the next cold start or after `aws.py` triggers a new deployment.

Use `make librarian-corpora-upload` when code is unchanged and only the five S3 corpus artifacts need refresh.

## Secrets

A deploy needs no credentials (2026-10-07). The Lambdas' keys live in the
`weekly-thing-librarian-runtime` secret, which Jamie keeps by hand in the
Secrets Manager console; see "Env vars set in CloudFormation" in
`apps/librarian/AGENTS.md`. AWS deployment credentials come from GitHub OIDC
in CI (temporary per run).

The CloudFormation stack uses the scoped `weekly-thing-librarian-cloudformation` service role. CI also needs scoped corpus reads, Bedrock invocation, bucket-security inspection, and log setup. See `iam/README.md` for source policies and legacy local-consumer retirement.

## Bedrock regions

- **Embed model** (`cohere.embed-english-v3`): **us-east-1**.
- **Rerank model** (`cohere.rerank-v3-5:0`): **us-west-2** — only region with the rerank model. The Lambda's `BedrockAgentRuntimeClient` is constructed with explicit `region: 'us-west-2'` override.
- **Claude models** run on the Anthropic API, not Bedrock (2026-10): `THINGY_DEFAULT_MODEL` `claude-sonnet-5-5`, `THINGY_FAST_MODEL` `claude-haiku-5-5`, `THINGY_PREMIUM_MODEL` `claude-opus-5-5`, set in the stack. See [`../../apps/librarian/AGENTS.md`](../../apps/librarian/AGENTS.md) "Model gotchas".

Don't move the rerank region.

## CloudFormation template

Lives at `apps/librarian/infra/cloudformation.yaml`. Two native HTTP Web Functions (auth/archive), two Event Functions (eval/digest), DynamoDB (canonical conversations + rate limits + user memory, with Streams enabled for eval), IAM role + policies, CloudWatch log groups, Bedrock IAM policies for embed/rerank/invoke, and a DynamoDB Stream event source mapping for the eval Lambda. See [`../../apps/librarian/AGENTS.md`](../../apps/librarian/AGENTS.md) for the runtime side of what's deployed.

## Conventions

- **`--skip-corpus-upload` is the default for code changes.** (Memory: `reference_librarian_deploy_flags.md`.)
- **Don't disable the smoke test casually.** The model id check stops a Bedrock id (or a typo) from shipping. The Anthropic API key itself reaches the stack from the hand-kept `weekly-thing-librarian-anthropic` secret, and a missing secret fails the CloudFormation update.
- **Stack name is `weekly-thing-librarian`** (`STACK_NAME` in `aws.py`). Don't rename without coordinating with `.env`-referenced outputs.
- **Log retention is 30 days.** Bedrock invocation logs go to a separate longer-retention destination via `bedrock_logging.py`.
