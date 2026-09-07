# Archived one-shot scripts

Scripts in this folder were used to apply a specific cleanup once, synced to Buttondown, and are effectively frozen. They remain here as reference — patterns encoded in these scripts are useful when a similar problem recurs.

Do not re-run these against the current archive unless you explicitly intend to re-apply their transformation. Several (`convert_legacy`, `fetch_mailchimp`, `populate_missing_images`) depend on external data sources that may no longer exist.

## What each did

| Script | Commit | What it did |
|---|---|---|
| `audit_logo_refs.py` | `777aa70` | Scanned for orphan logo/image references as part of the MailChimp campaign HTML recovery investigation. |
| `backfill_issues_data_layer.py` | (this session) | One-shot historical backfill: walked `data/issues/{N}/` + `data/audio/manifest.json` for every shipped issue, filled the new `issues` + `issue_links` tables in `workshop.db`. Idempotent; future shipped issues file via `/eddy issue put-to-bed`. |
| `convert_legacy.py` | `247c892` | One-time: converted 129 legacy issues from HTML/MailChimp plaintext to clean markdown. The big bulk-migration script. |
| `fetch_mailchimp.py` | `777aa70` | Fetched MailChimp campaign HTML to recover 225 orphan image filenames. |
| `fix_archive_headings.py` | (this cleanup session) | Demoted H1 section titles to H2 (and link H2 → H3) in issues #132–#136. Applied + synced. |
| `fix_archive_links.py` | (this cleanup session) | Fixed 8 specific malformed markdown links (#40, #82, #126, #132, #136, #161, #221, #291). Applied + synced. |
| `intro_openers.txt` | `2f7224b` | Data file used by `remove_intro_template.py` — list of known intro-template prefixes to match. |
| `modernize_hr.py` | `9b9c2f4` | Modernized MailChimp-era section dividers to markdown `---`. |
| `populate_missing_images.py` | `6c2ad3d` | Recovered 103 hero images for MailChimp-era issues from campaign HTML. |
| `remove_about_section.py` | `bba2c4d` | Removed trailing "About" section from 137 archive issues. |
| `remove_forward_to_friends_block.py` | (this cleanup session) | Removed 13 MailChimp/early-Buttondown-era "forward this to friends" share-CTA blocks from 9 issues (#131, #142, #146, #156, #163, #164, #165, #167, #168). Applied + synced. |
| `remove_intro_template.py` | `2f7224b` | Removed boilerplate intro template that repeated across issues. |
| `remove_leading_date.py` | `9a1d246` | Stripped Tinyletter-era leading date and location datelines from #3–#22. |
| `remove_mailchimp_footer.py` | `b2909fb` | Removed MailChimp-era footer cruft + remaining header variants. |
| `remove_mailchimp_header.py` | `b4bc162` | Removed MailChimp-era top-of-body header block from 12 issues. |
| `remove_recent_issues.py` | `7108c2c` | Removed "Recent Issues" sidebar block pasted into body. |
| `remove_share_block.py` | `c790892` | Removed "Want to share this issue" block from 36 archive issues. |
| `remove_share_cta_block.py` | `7fb2691` | Removed trailing "Here are some other things…" share CTA block from 12 issues. |
| `repair_106.py` | `40930fa` | Issue-specific fix for #106 done alongside the micro→www rewrite. |
| `restore_mailchimp_images.py` | `777aa70` | Restored 225 MailChimp-hosted image references recovered from campaign HTML. |
| `restore_weekly_photo.py` | `18a0e49` | Restored "My Weekly Photo" image inside 76 MailChimp-era bodies. |
| `rewrite_micro_to_www.py` | `40930fa` | Rewrote `micro.thingelstad.com` → `www.thingelstad.com` across the archive. |
| `strip_tracking_params.py` | `ce7dcaf` | Stripped MailChimp tracking params (`mc_cid`, `mc_eid`) from archive URLs. |

## Active scripts

The current, re-runnable pipeline lives in sibling directories under `pipeline/` — `content/`, `audits/`, `corpus/`, `graph/`, `audio/`, `deploy/`, plus `status.py`. The unified content entrypoint is `pipeline/content/content.py`. See `AGENTS.md` for the operator overview.
