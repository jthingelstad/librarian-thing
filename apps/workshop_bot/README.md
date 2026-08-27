# Workshop Bot — Newsletter Studio Runtime

Workshop Bot is the private Studio runtime for publishing **The Weekly Thing**
newsletter. The product surface is the Studio web app; Discord is secondary and
mostly gives Eddy a place to post editorial notes and follow-ups.

> Operational memory for working in this codebase lives in [`CLAUDE.md`](CLAUDE.md).

## What It Runs

- One Discord persona: **Eddy**, Jamie's newsletter assistant.
- The private web app for creating, editing, reviewing, and publishing issues.
- A small scheduler:
  - `sync-issue-daily`
  - `follow-up-sweep`
- The local tool registry Eddy uses for archive lookup, issue state, Currently,
  editorial notes, content atoms, tasks, and follow-ups.

Retired from the active runtime: Scout, Linky, Marky, Patty, seeds/gardening,
generic productions, projects, blog-post production, podcast production,
campaign work, and proactive slate/garden check-ins.

## Quick Start

```bash
# from the repo root
uv sync --locked
cp .env.example .env

uv run --locked python -m apps.workshop_bot.bot
```

For production use, run under launchd via `scripts/admin.sh` and keep the Mac
awake so the Discord gateway and web app stay reachable.

## Tests

```bash
uv run --locked pytest apps/workshop_bot/tests
```

`make test-workshop-env` loads `.env` first; use only for runtime-config smoke
checks.

## Environment

The runtime reads the repo-root `.env`.

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN_EDDY` | Eddy's Discord bot token |
| `DISCORD_SERVER_ID` | Guild-scoped slash command sync |
| `DISCORD_CHANNEL_EDITORIAL` | Eddy's home channel and publish/status notifications |
| `DISCORD_CHANNEL_CHATTER` | Startup/status line |
| `ANTHROPIC_EDDY_API_KEY` | Eddy LLM calls |
| `ANTHROPIC_GENERAL_API_KEY` | Offline eval and non-persona pipeline calls |
| `BUTTONDOWN_API_KEY` | Email publishing |
| `PINBOARD_API_TOKEN` | Source sync / bookmark reads |
| `MICROBLOG_API_KEY` | Journal source sync |
| `OPENAI_API_KEY` | TTS for the audio pipeline |
| `LIBRARIAN_RETRIEVE_SECRET` | Semantic archive retrieval |
| `GITHUB_PAT_TOKEN` | Website publish commit |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_DEFAULT_REGION` | S3 assets |
| `WORKSHOP_DB_PATH` | SQLite path, defaults to `apps/workshop_bot/data/workshop.db` |
| `WORKSHOP_SCHEDULER_ENABLED` | Set `0` to disable scheduled jobs |

Legacy env vars for retired personas or systems may still exist in `.env` while
old modules are cleaned up, but `bot.py` only starts Eddy.

## Storage

- SQLite at `apps/workshop_bot/data/workshop.db` stores issue windows, issue
  rows, authored content atoms, issue items, Currently entries, editorial
  comments, tasks, follow-ups, and agent run telemetry.
- S3 at `s3://files.thingelstad.com/weekly-thing/{N}/` stores publishing assets
  and generated outputs only.

## Boundaries

- Jamie writes every word.
- Studio is upstream of publishing.
- `weekly.thingelstad.com` renders the public site/archive from Studio output.
- Buttondown sends the email after Studio creates or updates the draft.
- The Librarian `/retrieve` contract remains separate and should not be changed
  casually from workshop work.
