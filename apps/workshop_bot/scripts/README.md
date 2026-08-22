# scripts/

Operational utilities for `apps/workshop_bot/`. Modeled on the `elixir-bot/scripts/` setup.

## `admin.sh`

Service control for the launchd agent (`com.weeklything.workshop-bot`).

```bash
apps/workshop_bot/scripts/admin.sh install   # write ~/Library/LaunchAgents/com.weeklything.workshop-bot.plist
apps/workshop_bot/scripts/admin.sh start     # launchctl bootstrap
apps/workshop_bot/scripts/admin.sh stop      # launchctl bootout
apps/workshop_bot/scripts/admin.sh restart
apps/workshop_bot/scripts/admin.sh status
apps/workshop_bot/scripts/admin.sh upgrade   # stop → fast-forward → uv sync --locked → start
apps/workshop_bot/scripts/admin.sh backup    # invokes backup_db.py
apps/workshop_bot/scripts/admin.sh tail      # tail -F logs/workshop.{log,err}
```

The plist runs `.venv/bin/python -m apps.workshop_bot.bot` with the repo root as working directory.
It starts automatically when the user launchd domain loads after login, and
launchd keeps it running if the process exits.

**Environment** — `admin.sh` uses the uv-managed `<repo>/.venv` exclusively.

**Logs** land at `apps/workshop_bot/logs/workshop.log` and `workshop.err` (gitignored).

## `backup_db.py`

Safe online SQLite backup of `apps/workshop_bot/data/workshop.db` (uses `sqlite3.Connection.backup()` — no need to stop the bot) plus tiered retention pruning.

```bash
uv run --locked python apps/workshop_bot/scripts/backup_db.py
```

- Output: `~/workshop-backups/workshop-YYYY-MM-DD-HHMMSS.db.gz` (gzip level 6)
- Integrity-checks the snapshot before compressing
- Retention: keep-all ≤28d · monthly 29–90d · quarterly 91–365d · delete >365d

Override via env:

- `WORKSHOP_DB_PATH` — source database (default: `<repo>/apps/workshop_bot/data/workshop.db`)
- `WORKSHOP_BACKUP_DIR` — destination dir (default: `~/workshop-backups`)

## `clean.py`

Remove local cache cruft under `apps/workshop_bot/`.

```bash
uv run --locked python apps/workshop_bot/scripts/clean.py        # __pycache__, .pytest_cache, .mypy_cache, .ruff_cache
uv run --locked python apps/workshop_bot/scripts/clean.py --db   # also remove apps/workshop_bot/data/workshop.db (destructive)
```

## First-time setup on a new server

```bash
# from the repo root
uv sync --locked --no-dev

# .env should already be at the repo root with bot tokens / API keys
apps/workshop_bot/scripts/admin.sh install
apps/workshop_bot/scripts/admin.sh start
apps/workshop_bot/scripts/admin.sh status
apps/workshop_bot/scripts/admin.sh tail
```
