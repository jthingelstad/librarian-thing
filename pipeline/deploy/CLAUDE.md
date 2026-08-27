# pipeline/deploy/ — project memory

AWS deploy tooling for the Thingy Lambda stack. No README — this directory is operator-only.

## The three scripts

| Script | What it does |
|---|---|
| `aws.py` | Packages the two Lambda bundles, optionally uploads all Librarian corpora, uploads code to S3, then runs CloudFormation update-stack with the new code keys + secrets from `.env`. **The canonical deploy entrypoint.** |
| `upload_corpus.py` | Builds the Weekly Thing corpus + graph from `apps/site/archive/`, embeds via Bedrock Cohere, uploads to S3. Called by `aws.py` during full corpus deploys. |
| `upload_blog_corpus.py` | Builds the thingelstad.com blog corpus from `data/blog/posts`, embeds via Bedrock Cohere with S3 cache reuse, uploads to S3. Called by `aws.py` during full corpus deploys. |
| `upload_podcast_corpus.py` | Builds the Another Thing podcast corpus from `data/podcast/another-thing/episodes`, embeds via Bedrock Cohere with S3 cache reuse, uploads to S3. Called by `aws.py` during full corpus deploys. |
| `bedrock_logging.py` | Configures Bedrock model invocation logging (CloudWatch destination + S3 archive). One-time setup. |

## Invocation

Always via `make librarian-deploy` or `uv run --locked python pipeline/deploy/aws.py`.
The deploy script must run through the locked uv environment so dependencies such as
`boto3` and `python-dotenv` are available; do not invoke it with bare system Python.

```bash
# Default for code changes — skip the slow + paid corpus reupload
make librarian-deploy ARGS="--skip-corpus-upload"

# Full deploy (re-embeds + uploads all three corpora)
make librarian-deploy

# Direct equivalent when bypassing make
uv run --locked python pipeline/deploy/aws.py --skip-corpus-upload
```

The `--skip-corpus-upload` flag is the default for any **code-only** change (Lambda code, CloudFormation tweaks, env-var changes). Full corpus reupload refreshes **Weekly Thing + blog + podcast** and is **slow/paid**. Each source-specific uploader reuses embeddings from the previously deployed S3 artifact when chunk ids match. Only do a full deploy when:

- The corpus itself is stale (new issues to embed)
- The embed model has changed (Cohere v3 → v4, hypothetically)
- The corpus schema has changed (e.g., new chunk metadata field)

CI in `.github/workflows/deploy.yml` uploads all three corpus artifacts when production runs. External content first enters Studio through `.github/workflows/sync-external-content.yml`, which commits changes under `data/blog/**` and `data/podcast/**`; those commits then trigger production. Manual deploys are for local validation before commit.

## `aws.py` flow

1. **Smoke-test the Thingy model buckets** via minimal `InvokeModel` calls against `THINGY_DEFAULT_MODEL`, `THINGY_FAST_MODEL`, and `THINGY_ADVANCED_MODEL`. Refuses to deploy if any configured model isn't accessible from this account. Pass `--skip-smoke-test` to override.
2. **Ensure the private S3 bucket exists** (`ensure_private_bucket(bucket)`). Default bucket: `LIBRARIAN_BUCKET` env var or `weekly-thing-librarian`.
3. **Package both Lambda bundles** (`auth/` + `chat/`) — separate npm install + zip per bundle. Bundles ship independently because the auth Lambda is REST and the chat Lambda is response-streamed Function URL.
4. **Upload zips** to `s3://{bucket}/code/{auth,chat}-lambda/<unix-ts>.zip`. Timestamp keys so CloudFormation always sees a new version.
5. **Optional**: all corpus uploaders run — Weekly Thing corpus + graph, blog corpus, podcast corpus.
6. **CloudFormation update-stack** with the new code keys + secrets from `.env`: `SESSION_SECRET`, `LIBRARIAN_RETRIEVE_SECRET`, `BUTTONDOWN_API_KEY`.
7. **30-day log retention** on the auto-created log groups (`configure_log_retention`).
8. **Update `.env`** with the latest stack outputs: `LIBRARIAN_API_URL`, `LIBRARIAN_STREAM_URL`.

## Corpus upload flow

1. Weekly Thing: `upload_corpus.py` builds from `apps/site/archive/*.md`, embeds chunks, builds the graph, uploads `corpus.json` + `graph.json`.
2. Blog: `upload_blog_corpus.py` builds from `data/blog/posts/**/*.md`, reuses cached embeddings by chunk id, uploads `blog_corpus.json`.
3. Podcast: `upload_podcast_corpus.py` builds from `data/podcast/another-thing/episodes/*.json`, reuses cached embeddings by chunk id, uploads `podcast_corpus.json`.
4. The Lambda's `loadCorpus()`, `loadBlogCorpus()`, and `loadPodcastCorpus()` pick up new files on the next cold start or after `aws.py` triggers a new deployment.

Use `make librarian-corpora-upload` when code is unchanged and only the three S3 corpus artifacts need refresh.

## Secrets

Pulled from the repo-root `.env`. Required:

| Var | Source | What for |
|---|---|---|
| `BUTTONDOWN_API_KEY` | account secrets | Auth Lambda's subscriber verification |
| `LIBRARIAN_SESSION_SECRET` | (auto-generated if missing) | HMAC signing for session JWTs |
| `LIBRARIAN_RETRIEVE_SECRET` | shared secret | trusted `/retrieve` service auth |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | the `wt-archive` IAM user | Deploys + corpus upload |

The CloudFormation stack uses an IAM service role for execution; the local AWS credentials are just for `cloudformation:UpdateStack` + `s3:PutObject`.

## Bedrock regions

- **Embed model** (`cohere.embed-english-v3`): **us-east-1**.
- **Rerank model** (`cohere.rerank-v3-5:0`): **us-west-2** — only region with the rerank model. The Lambda's `BedrockAgentRuntimeClient` is constructed with explicit `region: 'us-west-2'` override.
- **Default model** (`us.anthropic.claude-sonnet-4-6`): cross-region inference profile for main chat/persona work.
- **Fast model** (`us.anthropic.claude-haiku-4-5-20251001-v1:0`): cross-region inference profile for small structured/background work.
- **Advanced model** (`us.anthropic.claude-opus-4-6-v1`): cross-region inference profile for Dispatch generation.

Don't move the rerank region. Don't change model bucket assignments without smoke-testing them against the deploy's account.

## CloudFormation template

Lives at `apps/librarian/infra/cloudformation.yaml`. Three Lambdas (auth + stream + eval), API Gateway (REST), Lambda Function URL (Stream, RESPONSE_STREAM mode), DynamoDB (canonical conversations + rate limits + user memory, with Streams enabled for eval), IAM role + policies, CloudWatch log groups, Bedrock IAM policies for embed/rerank/invoke, and a DynamoDB Stream event source mapping for the eval Lambda. See [`../../apps/librarian/CLAUDE.md`](../../apps/librarian/CLAUDE.md) for the runtime side of what's deployed.

## Conventions

- **`--skip-corpus-upload` is the default for code changes.** (Memory: `reference_librarian_deploy_flags.md`.)
- **Don't disable the smoke test casually.** The Bedrock model access check at deploy time prevents the most common "deployed but immediately broken" failure mode.
- **Stack name is `weekly-thing-librarian`** (`STACK_NAME` in `aws.py`). Don't rename without coordinating with `.env`-referenced outputs.
- **Log retention is 30 days.** Bedrock invocation logs go to a separate longer-retention destination via `bedrock_logging.py`.
