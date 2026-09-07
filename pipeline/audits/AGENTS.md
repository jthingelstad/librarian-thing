# pipeline/audits/ — project memory

Repeatable archive audit + repair tooling. No README — this directory is operator-only. Output snapshots live in [`../../notes/audits/`](../../notes/audits/) with their own [`README.md`](../../notes/audits/README.md).

## The four audit scripts

| Script | What it does | Cost |
|---|---|---|
| `audit_archive.py` | **Static** regex/DOM audit of rendered HTML. Broken images, header hierarchy, malformed markdown, template-tag leakage. Reads `_site/` — needs a fresh build first (`npx @11ty/eleventy --config apps/site/eleventy.config.js`). | Free |
| `llm_audit_archive.py` | **LLM** semantic audit of raw markdown via Claude Opus 4.7. Typos, narrative breaks, dropped-URL links, migration artifacts. `--full` runs across all 344+ issues at concurrency 8. | ~$20, ~8 min at concurrency 8 |
| `audit_missing_micropost_photos.py` | Finds micropost photos silently lost during the MailChimp → Buttondown migration (no `mp-photo-alt[]=` marker). | Free |
| `build_missing_posts_report.py` | Enriches the "missing micro.blog posts" report with Wayback snapshots, newsletter heading, body paragraph. | Free (uses Wayback API) |

## The repair scripts

These take an audit's output and apply fixes back to `data/issues/{N}/archive.md`. **Always read what they propose before running** — they mutate the canonical archive store.

- `fix_micropost_photos.py` — restores photos where `mp-photo-alt[]=` markers survived in the body (146 photos across 21 issues at last run).
- `restore_missing_micropost_photos.py` — restores silently-lost single-photo microposts (407 photos across 60 issues at last run).
- `apply_audit_fixes.py` — apply LLM-suggested fixes from `tmp/llm-audit.json`. Operator chooses which suggestions to apply.
- `migrate_images_to_s3.py` — move restored photos from `cdn.uploads.micro.blog` (hot-linked) to `files.thingelstad.com/weekly-thing/<N>/journal/`. Deferred today; not yet run on the ~550 restored photos.

## Output convention

All scripts write to `tmp/` (gitignored) by default. **Copy results into `notes/audits/` to snapshot them** so the next session has context:

```bash
cp tmp/archive-audit*.md tmp/archive-audit*.json \
   tmp/llm-audit.md tmp/llm-audit.json \
   tmp/missing-photos.md tmp/missing-photos.json \
   tmp/missing-microblog-posts.md tmp/missing-microblog-posts.json \
   notes/audits/
```

The [`notes/audits/README.md`](../../notes/audits/README.md) documents what each snapshot is.

## Workflow when a new class of issue surfaces

1. Run the audit (`audit_archive.py` or `llm_audit_archive.py`).
2. Triage the findings — group by pattern (era-specific cruft? specific template? individual issues?).
3. If a pattern: write a fix in `pipeline/audits/<descriptive>.py`. Idempotent. Operator-runnable.
4. If a one-off: hand-edit `data/issues/{N}/archive.md` directly. Commit with a clear message.
5. Re-run `make build` to regenerate `apps/site/archive/{N}.md`.
6. Optionally re-run the audit to confirm the fix.
7. Snapshot the new audit output into `notes/audits/`.

## GitHub issue tracking

Open cleanup work is tracked in GitHub issues with labels:

- **By priority**: `quick-win`, `editorial-review`, `s3-migration`, `exploration`, `low-priority`, `blocked-external`
- **By size**: `size-small`, `size-medium`, `size-large`

## Open work (as of the last snapshot)

- **199 micro.blog posts 404** — sent to micro.blog as an issue. Hold restoration until they respond.
- **#319 missing S3 folder** — 47 images never uploaded. Deferred.
- **Buttondown-era microposts (13 cases, 72 photos)** — may be intentional text-only "read full post" pointers vs. actually missing. Needs editorial judgment.
- **S3 migration of ~550 restored photos** — currently hot-linked to `cdn.uploads.micro.blog`; needs `migrate_images_to_s3.py`.
- **LLM audit 165 high-severity findings** — the tier worth reviewing manually.

## Conventions

- **Never auto-apply LLM fixes blindly.** `apply_audit_fixes.py` prompts per suggestion; respect that.
- **Repair scripts are one-shot.** Once they've done their job, they retire to `pipeline/one-shot/` — see that directory's README for the retired list.
- **Always commit before running a repair script.** Easier to revert.
- **Audits write to `tmp/` by default.** Snapshot to `notes/audits/` when results are stable.
