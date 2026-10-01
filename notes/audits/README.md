# Archive Audits

Point-in-time snapshots of the archive audit + cleanup work. Checked in so
future sessions can pick up the thread without re-running everything.

## Files

| File | What it is |
|---|---|
| `archive-audit-summary.md` | **Start here.** Hand-written handoff tying both audits together, applied fixes, and remaining decisions. |
| `archive-audit.md` / `.json` | Static regex/DOM audit of rendered HTML. Broken images, header hierarchy, malformed markdown, template-tag leakage. Produced by `pipeline/audits/audit_archive.py`. |
| `llm-audit.md` / `.json` | LLM (Claude Opus 4.7) semantic audit of raw markdown. Typos, narrative breaks, dropped-URL links, migration artifacts. Produced by `pipeline/audits/llm_audit_archive.py`. |
| `missing-photos.md` / `.json` | Micropost photos silently lost during the MailChimp → Buttondown migration (no `mp-photo-alt[]=` marker to signal them). Produced by `pipeline/audits/audit_missing_micropost_photos.py`. |
| `journal-permalinks-2026-10-01.csv` | The reviewed map of 432 dead Journal permalinks (WT1–WT327) to the blog posts they copy, built from the corpus's `date_text` matches by `pipeline/audits/journal_permalink_map.py` and confirmed with GETs only (every old URL 404, every target 200). 38 rows under 0.9 text similarity were approved by Jamie 2026-10-01 (the missing words are hashtags and mentions micro.blog dropped when it merged same-day microposts). Applied to both copies by `repair_journal_permalinks.py`. |
| `journal-permalinks-unmatched-2026-10-01.csv` | The 33 Journal entries the build ties to no post; no target proposed, left as they are. The corpus gate holds this as a ceiling (`pipeline/corpus/corpus_gate.py`). |
| `missing-microblog-posts.md` / `.json` | 199 micro.blog posts referenced from newsletter issues that now 404 on `thingelstad.com`. Enriched with Wayback snapshot URLs, newsletter heading, and body paragraph for recovery. Produced by `pipeline/audits/build_missing_posts_report.py`. Tracked as GitHub issue (see repo issues). |

## How to regenerate

All scripts write to `tmp/` (gitignored) by default — copy results into
`notes/audits/` to snapshot them.

```bash
# Static audit (requires fresh _site/; rebuild with `npx @11ty/eleventy` first)
python pipeline/audits/audit_archive.py

# LLM audit (~$20 on Opus 4.7, ~8 minutes at concurrency 8)
python pipeline/audits/llm_audit_archive.py --full --concurrency 8

# Missing micropost photo audit
python pipeline/audits/audit_missing_micropost_photos.py

# Enriched missing-microblog report (with Wayback lookups)
python pipeline/audits/build_missing_posts_report.py

# Snapshot all outputs into notes/audits/
cp tmp/archive-audit*.md tmp/archive-audit*.json \
   tmp/llm-audit.md tmp/llm-audit.json \
   tmp/missing-photos.md tmp/missing-photos.json \
   tmp/missing-microblog-posts.md tmp/missing-microblog-posts.json \
   notes/audits/
```

## Fixes applied (as of this snapshot)

Synced to Buttondown via `pipeline/content/sync_to_buttondown.py --yes`:

| Fix | Issues | Script |
|---|---|---|
| Demote in-body H1 section titles → H2 (plus link H2 → H3) | 132–136 | `pipeline/one-shot/fix_archive_headings.py` |
| 8 malformed markdown links (parens in URLs, spaces, stray chars) | 40, 82, 126, 132, 136, 161, 221, 291 | `pipeline/one-shot/fix_archive_links.py` |
| Restore micropost photos where `mp-photo-alt[]=` markers survived (146 photos, 21 issues) | 84, 86, 91, 92, 94–102, 105, 107, 108, 111, 114–116, 118 | `pipeline/audits/fix_micropost_photos.py` |
| Restore silently-lost single-photo micropost photos (407 photos, 60 issues) | 43–130 MailChimp + 1 Tinyletter | `pipeline/audits/restore_missing_micropost_photos.py` |

Total: **~550 photos restored**, many dozens of structural/typo fixes.

## Still open

See `archive-audit-summary.md` for the full punch list. Highlights:

- **199 micro.blog posts 404ed** — sent to micro.blog as an issue (see GitHub issues). Hold restoration until they respond.
- **#319 missing S3 folder** — 47 images never uploaded to the S3 bucket. Deferred.
- **Buttondown-era microposts (13 cases, 72 photos)** — may be intentional text-only "read full post" pointers vs. actually missing. Needs editorial judgment.
- **S3 migration of the ~550 restored photos** — currently hot-linked to `cdn.uploads.micro.blog`; modern issues use `files.thingelstad.com/weekly-thing/N/journal/` with resized derivatives.
- LLM audit has 1,391 findings across 344 issues — the 165 high-severity ones are the tier worth reviewing.
