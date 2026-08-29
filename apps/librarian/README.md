# apps/librarian/ — Thingy

The AWS Lambda agent that answers reader questions against Jamie Thingelstad's published archive: The Weekly Thing, thingelstad.com, and Another Thing. "Librarian" is the system name in code; **Thingy** is the product name shown to users.

> Operational memory for editing this stack lives in [`CLAUDE.md`](CLAUDE.md). Full runtime guide — IAM cleanup plan, retrieval architecture, Tinylytics events, deployment checklist — is at [`../../reference/librarian.md`](../../reference/librarian.md).

## What it is

Three Lambdas behind one CloudFormation stack:

- **Auth Lambda** (REST via API Gateway) — handles Buttondown subscriber lookup, Fastmail/JMAP magic-link login, HMAC-signed session tokens, conversation list/get/create/rename/delete, profile updates, and per-answer feedback reactions.
- **Stream Lambda** (Function URL, response streaming) — handles `/chat` (SSE-streamed agent loop with server-side conversation history), `/welcome`, `/curiosity-map`, `/feedback`, and `/retrieve` (semantic JSON retrieval used by `workshop_bot` for its `archive__retrieve` tool + several pre-injection helpers).
- **Eval Lambda** (DynamoDB Stream trigger) — reviews updated server-side conversations out of band and writes summary/quality metadata back to DynamoDB.

> Historical note: the Dispatch feature was removed 2026-08; old dispatch rows expire via TTL.

The Q&A intelligence lives entirely here. Retrieval is **Bedrock Cohere embed → vector search → Cohere rerank** against a pre-embedded corpus in S3, with BM25 lexical fallback. Generation is Claude Sonnet via Bedrock Converse (cross-region inference profile, tool use enabled).

## Layout

```
apps/librarian/
├── README.md         ← this file
├── CLAUDE.md         ← operational memory
├── contracts/        ← generated, versioned client contract artifacts
├── lambda/           ← Node.js Lambda code (runtime: Node 24, arm64)
│   ├── chat/         ← Stream Lambda — /chat, /welcome, /curiosity-map, /retrieve
│   │   ├── handler.mts    (streaming entrypoint)
│   │   └── runtime.mts    (agent loop and routes)
│   ├── auth/         ← Auth Lambda — /auth, /feedback, conversations
│   ├── eval/         ← Eval Lambda — conversation reviews
│   ├── shared/       ← AWS clients, retrieval, Bedrock streaming, sessions
│   ├── prompts/      ← editable system prompts (packaged into both deployment artifacts)
│   └── tests/        ← Node tests
├── infra/
│   └── cloudformation.yaml   ← full stack: Lambdas, API Gateway, DynamoDB, IAM, CloudWatch
└── admin/            ← operator scripts for the live stack
```

## Deploy

Always via `make librarian-deploy` or `uv run --locked python pipeline/deploy/aws.py`.
The deploy script must run through the locked uv environment so dependencies such as
`boto3` and `python-dotenv` are available; do not invoke it with bare system Python.

```bash
# Code + infra only (skip the slow + paid corpus reupload) — the default for code changes
make librarian-deploy ARGS="--skip-corpus-upload"

# Full deploy (rebuilds + embeds + uploads Weekly Thing, blog, and podcast corpora)
make librarian-deploy

# Run Node tests
npm --prefix apps/librarian/lambda test
```

CI auto-detects code/infra changes in `apps/librarian/` and runs the deploy step from `.github/workflows/deploy.yml`. Manual deploys are for local validation before commit.

Corpus build/upload is source-specific but treated as one API concern:

- Weekly Thing corpus + graph: `pipeline/deploy/upload_corpus.py`
- thingelstad.com blog corpus: `pipeline/deploy/upload_blog_corpus.py`
- Another Thing podcast corpus: `pipeline/deploy/upload_podcast_corpus.py`

New external content enters Studio through the `Studio — Sync External Content`
workflow first. It ingests Micro.blog posts into `data/blog/`, imports podcast
episodes into `data/podcast/`, commits those changes, and the production workflow
then uploads the updated corpus artifacts.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Health check (returns model versions) |
| POST | `/chat` | session token (bearer) | SSE-streamed agent answer with tool use and server-side history |
| POST | `/welcome` | session token (bearer) | Agentic contextual welcome for authenticated users |
| POST | `/curiosity-map` | session token (bearer) | Generate and optionally store a curiosity-map artifact |
| POST | `/retrieve` | retrieval secret (body) | JSON semantic retrieval — top-K archive passages, used by `workshop_bot` |
| POST | `/feedback` | session token (bearer) | Per-answer reactions plus optional comments |
| POST | `/auth` | none / session token | Magic-link auth, user conversation management, and profile updates |
| POST | `/memory` | session token (bearer) | Thingy profile fetch and profile deletion (`get`, `delete_profile`; `refresh_profile` is a legacy no-op) |

## Versioned client contract

The backend source of truth is `lambda/shared/librarian-contract.mts`. It generates
`contracts/librarian-api.json` plus a SHA-256 sidecar. Thingy fetches the published
artifact, verifies the checksum, and generates its runtime validators and TypeScript
types from that single source. Both API front doors advertise
`x-librarian-contract-version`, and clients may send the same header to negotiate
compatibility. Requests without a version remain supported for older deployed clients;
an explicit unsupported version receives `409`.

```bash
npm --prefix apps/librarian/lambda run contract:generate
# In the Thingy checkout:
npm --prefix web run contract:sync
```

Contract changes are additive within `2.x`. A breaking endpoint or SSE event change must
introduce a new major artifact rather than weakening the existing schema.

## Tech stack

- **Node 24** (arm64) — Lambda runtime
- **AWS SDK v3** — `@aws-sdk/client-bedrock-runtime`, `client-bedrock-agent-runtime`, `client-dynamodb`, `client-s3`
- **Bedrock** — Cohere `embed-english-v3` (us-east-1), Cohere `rerank-v3-5:0` (us-west-2), Claude Sonnet 4.6 (cross-region inference)
- **DynamoDB** — conversation log, rate limits, per-user profile row
- **S3** — pre-embedded corpus, graph artifacts
- **API Gateway** + **Lambda Function URL** (response streaming) — two HTTP front doors; the Eval Lambda is event-driven by DynamoDB Streams

## Environment

Env vars are set in CloudFormation at deploy time from the repo-root `.env`. The full list (with deploy-side handling) is in [`CLAUDE.md`](CLAUDE.md). The headline secrets:

- `SESSION_SECRET` — HMAC signing key for session tokens
- `LIBRARIAN_RETRIEVE_SECRET` — shared secret for trusted `/retrieve` clients
- `BUTTONDOWN_API_KEY` — subscriber email verification
- `FASTMAIL_JMAP_TOKEN` — optional Fastmail JMAP token used to send Thingy magic-link login emails from `thingy@thingelstad.com`
- `THINGY_TINYLYTICS_EMAIL_SITE_UID` — optional Tinylytics site UID override for email tracking pixels; defaults to Thingy's public site UID

Public Thingy email sessions always require possession-based magic-link authentication before minting a token. There is no direct-session deploy flag. Session tokens last ten days and can be refreshed while still valid.

## Conversation modes

Mode availability is encoded in the signed session token as entitlements and enforced by both conversation creation and chat:

| Mode | Entitlement | Who gets it |
|---|---|---|
| `thingy` | `reader` | Any active subscriber |
| `research_guide` | `supporting_member` | Premium/supporting subscribers or `thingy-supporting-member` tag |
| `thought_partner` | `owner` | Jamie's owner email/hash or `thingy-owner` tag |
| `trusted_circle` | `trusted_circle` | `thingy-trusted-circle`, `thingy-family`, or `thingy-close-friends` tag |

The `admin/` directory has its own [`README.md`](admin/README.md) for operator reporting and live-stack tooling.

## Related reading

- [`CLAUDE.md`](CLAUDE.md) — operational memory (Bedrock model gotchas, retrieve internals, conventions)
- [`../../reference/librarian.md`](../../reference/librarian.md) — full runtime guide
- [`../workshop_bot/tools/thingy_retrieve.py`](../workshop_bot/tools/thingy_retrieve.py) — workshop_bot's client for the `/retrieve` endpoint
