-- Workshop Bot SQLite schema. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  output_type TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  status TEXT DEFAULT 'ready',
  created_at TEXT DEFAULT (datetime('now')),
  related_issue INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_outputs_agent_created
  ON agent_outputs(agent_name, created_at DESC);

CREATE TABLE IF NOT EXISTS link_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  title TEXT,
  description TEXT,
  pinboard_tags TEXT,
  linky_summary TEXT,
  linky_themes TEXT,
  archive_resonance TEXT,
  status TEXT DEFAULT 'unpublished',
  pinboard_added TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  used_in_issue INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_link_candidates_url
  ON link_candidates(url);

-- One row per logical agent invocation (cron fire, slash command, @-mention).
-- Token columns capture the Anthropic-side usage so cost can be reconstructed
-- from the table; the model column gives the price tier. A single run may
-- make multiple LLM calls (pinboard-scan's per-link loop, refresh-loop
-- retries) — the token columns are accumulated totals across the run.
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  error TEXT,
  records_written INTEGER,
  -- LLM accounting (filled by AgentRun.record_meta from agent_loop's
  -- response.usage on every iteration). NULL when no LLM call ran.
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_create_tokens INTEGER,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_started
  ON agent_runs(agent_name, started_at DESC);

-- Agent memory — notes a persona wants to carry forward beyond the
-- conversation in any one Discord thread. Shared across personas (by
-- design — Eddy can read what Patty observed, Marky can see what Linky
-- noticed) and attributed via agent_name.
CREATE TABLE IF NOT EXISTS agent_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  kind TEXT NOT NULL,                          -- 'preference', 'observation',
                                               -- 'todo', 'context', 'theme'
  key TEXT,                                    -- short label, optional
  content TEXT NOT NULL,
  related_issue INTEGER,
  status TEXT NOT NULL DEFAULT 'active',       -- 'active', 'resolved', 'stale'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_notes_agent_status_created
  ON agent_notes(agent_name, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_notes_kind_status
  ON agent_notes(kind, status);

-- Subscriber activity Marky surfaces — populated either by webhook (later)
-- or by a periodic Buttondown poll. Email is hashed before storage so we
-- never persist raw email addresses for the supporter program tracking.
CREATE TABLE IF NOT EXISTS subscriber_events_seen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL,                   -- Buttondown subscriber id
  email_hash TEXT NOT NULL,
  event_type TEXT NOT NULL,                    -- 'created', 'unsubscribed',
                                               -- 'churned'
  event_date TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriber_events_external
  ON subscriber_events_seen(external_id, event_type);

-- URLs Linky has already shown to Jamie from the discovery feed set
-- (Pinboard popular is currently defined but disabled). Records the *first* sighting
-- + Linky's verdict on that sighting. The companion
-- `popular_seen_sightings` table records *every* (url, source)
-- sighting across all feeds and all scans, so cross-source signal
-- (a URL bouncing between communities over time) can drive an
-- "uplift" re-evaluation card.
CREATE TABLE IF NOT EXISTS pinboard_popular_seen (
  url TEXT PRIMARY KEY,
  title TEXT,
  posted_by TEXT,
  judged_interesting INTEGER,                  -- 1 / 0 / NULL (not judged yet)
  judgment_note TEXT,
  verdict_source TEXT,                         -- which feed produced the verdict (uplift-block label)
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-(url, source) sighting log — every time a discovery feed shows
-- Linky a URL, we record it here. `pinboard_popular_seen` carries the
-- *first* sighting + verdict (insert-or-ignore); this table carries
-- the full timeline. The job uses it to answer: "has THIS feed seen
-- this URL before?" If no — and `pinboard_popular_seen` already has
-- the URL — it's a cross-source uplift candidate: Linky writes a
-- re-evaluation card with the prior sightings + verdict as context.
CREATE TABLE IF NOT EXISTS popular_seen_sightings (
  url TEXT NOT NULL,
  source TEXT NOT NULL,                        -- 'popular' / future feed source names
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (url, source)
);

CREATE INDEX IF NOT EXISTS idx_popular_seen_sightings_url
  ON popular_seen_sightings(url);

-- Jamie's explicit feedback on Linky's discovery/research cards. This is
-- separate from `pinboard_popular_seen`: that table is a dedup/verdict ledger
-- whose "interesting" rows include Linky's own card-post decisions; this table
-- is the human calibration signal Linky can read before future scans.
CREATE TABLE IF NOT EXISTS linky_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  title TEXT,
  source TEXT NOT NULL,
  discord_message_id TEXT,
  action TEXT NOT NULL,                         -- reply / save / brief / reviewed / rejected
  label INTEGER NOT NULL,                       -- +2 positive, -1 weak negative, -2 hard negative
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_linky_feedback_created
  ON linky_feedback(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_linky_feedback_url
  ON linky_feedback(url);

-- Durable synthesis over `linky_feedback`. The scan prompt uses this
-- profile first, then a few recent examples. Rebuilt when the feedback
-- fingerprint changes.
CREATE TABLE IF NOT EXISTS linky_feedback_profiles (
  source TEXT PRIMARY KEY,
  profile_md TEXT NOT NULL,
  feedback_count INTEGER NOT NULL,
  feedback_latest_at TEXT,
  synthesized_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Items from Jamie's Pinboard "to read" pile that Linky has already
-- researched (URL fetched, summary written). Lets the research handler
-- pick up where it left off across runs.
CREATE TABLE IF NOT EXISTS pinboard_research_done (
  url TEXT PRIMARY KEY,
  title TEXT,
  summary TEXT,
  confidence TEXT,                             -- ✦ / · / ⊘
  fit_note TEXT,
  researched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Decommissioned tables — dropped here so a long-lived DB converges with
-- a fresh install. (Idempotent: no-op if they never existed.)
--   agent_inbox    — typed inter-agent handoffs; the content-loop redesign
--                    is closed-loop with no agent-to-agent messaging
--                    (Jamie is the integrator).
--   analytics      — superseded by campaign_metrics + the live tinylytics/
--                    buttondown surfaces; never populated.
--   supporter_events / channel_routes — reserved in the original sketch,
--                    never wired; the goals table + env-var channel ids
--                    cover the same ground.
--   thingy_tokens / thingy_requests / thingy_conversations — Thingy moved
--                    to its own process (apps/thingy_bridge/); these
--                    tables now live in apps/thingy_bridge/db/schema.sql.
DROP INDEX IF EXISTS idx_agent_inbox_recipient;
DROP TABLE IF EXISTS agent_inbox;
DROP TABLE IF EXISTS analytics;
DROP TABLE IF EXISTS supporter_events;
DROP TABLE IF EXISTS channel_routes;
DROP INDEX IF EXISTS idx_thingy_requests_bot_msg;
DROP INDEX IF EXISTS idx_thingy_conversations_ended;
DROP TABLE IF EXISTS thingy_tokens;
DROP TABLE IF EXISTS thingy_requests;
DROP TABLE IF EXISTS thingy_conversations;
-- image_alt_cache — journal alts now live on micro.blog itself
-- (filled + persisted by tools.content.microblog.fill_missing_alts);
-- cover alt lives in cover.json. No remaining consumer of the cache.
DROP TABLE IF EXISTS image_alt_cache;

-- Issue windows — operator-set publishing schedule. Replaces the prior
-- auto-derived in-flight resolver (which combined S3 folder names with
-- the latest published issue). Jamie sets the active window via the
-- ``/workshop issue start`` slash command; agents read it via
-- ``issue__current_window`` and historical metadata via
-- ``issue__list_windows``.
--
-- Date semantics:
--   - pub_date is the Saturday the issue is published (display).
--   - end_date = pub_date - 1 day (content cutoff).
--   - start_date = end_date - day_count days (previous issue's cutoff;
--     so day_count=7 captures the seven days strictly after start_date
--     up to and including end_date).
--   - day_count is usually 7; 14 for double issues.
--
-- Exactly one row may have is_active=1; enforced by the partial unique
-- index below.
CREATE TABLE IF NOT EXISTS issue_windows (
  issue_number INTEGER PRIMARY KEY,
  pub_date TEXT NOT NULL,                        -- YYYY-MM-DD, Saturday
  end_date TEXT NOT NULL,                        -- YYYY-MM-DD = pub_date - 1
  start_date TEXT NOT NULL,                      -- YYYY-MM-DD = end_date - day_count
  day_count INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  set_at TEXT NOT NULL DEFAULT (datetime('now')),
  set_by TEXT,
  -- Publishing-spine phase of the active issue: 'write' → 'build' →
  -- 'publish' → 'share'. See docs/publishing-process.md. start-issue seeds
  -- 'build'; `mark built` flips to 'publish'; put-to-bed moves it to 'share'.
  -- The phase vocabulary is owned in code (tools/content/production_types.py);
  -- set_issue_phase validates against it.
  phase TEXT NOT NULL DEFAULT 'build',
  -- Publish record — stamped by `publish buttondown` when the issue ships.
  -- These are publish-path state, NOT authored content (which lives in
  -- production_content); kept here on the newsletter's detail table so the
  -- status gate + archive front matter read them without a content round-trip.
  buttondown_id TEXT NOT NULL DEFAULT '',
  absolute_url  TEXT NOT NULL DEFAULT ''
);

-- Multiple newsletters may be in flight at once (some in build, some in
-- share) — there is NO single-active constraint. is_active = 1 means
-- "in flight, not yet put to bed". The legacy partial-unique index
-- idx_issue_windows_active_unique is dropped by migration 0017. A plain
-- index keeps the "list active windows" scan cheap.
CREATE INDEX IF NOT EXISTS idx_issue_windows_active
  ON issue_windows(is_active) WHERE is_active = 1;

-- Durable publish-runbook state. Jobs update their own leg so the web app can
-- recover after a restart and show partial completion without reconstructing
-- it from Discord messages.
CREATE TABLE IF NOT EXISTS issue_publish_legs (
  issue_number INTEGER NOT NULL REFERENCES issue_windows(issue_number) ON DELETE CASCADE,
  leg          TEXT NOT NULL,
  status       TEXT NOT NULL, -- running | succeeded | failed | waived
  message      TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT,
  completed_at TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (issue_number, leg)
);

-- (The issue_cards table — per-phase Discord card handles — was retired with
-- the phase cards; production status is the web scoreboard now. Migration 0020
-- drops it on existing DBs.)

-- Productions — the internal newsletter issue registry. The table name
-- survives the old multi-type architecture, but Studio now treats newsletter
-- issues as the only first-class work object.
--
-- issue_windows stays as the *newsletter detail/working table* (it carries the
-- rich window fields + the live publish path), linked from here by
-- detail_issue_number. `details` is retained for compatibility and small issue
-- metadata.
--
-- id is the human display code: WT350. seq is the issue_number. phase is
-- validated by the code-side registry in tools/content/production_types.py —
-- deliberately NOT a CHECK constraint, so adding a phase needs no migration.
CREATE TABLE IF NOT EXISTS productions (
  id                  TEXT PRIMARY KEY,              -- 'WT350'
  production_type     TEXT NOT NULL,                 -- 'newsletter'
  seq                 INTEGER NOT NULL,              -- issue_number
  title               TEXT NOT NULL,
  phase               TEXT NOT NULL,                 -- per-type vocab; validated in code
  status              TEXT NOT NULL DEFAULT 'active',-- production_types.STATUSES (validated in code)
  due_at              TEXT,                          -- ISO date; newsletter = pub_date
  pub_date            TEXT,                          -- newsletter Saturday; NULL otherwise
  source              TEXT NOT NULL DEFAULT '',      -- surface label, e.g. 'weekly.thingelstad.com'
  details             TEXT,                          -- JSON: small compatibility fields
  detail_issue_number INTEGER,                       -- newsletter -> issue_windows.issue_number
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  created_by          TEXT,
  updated_by          TEXT,
  UNIQUE(production_type, seq)
);

CREATE INDEX IF NOT EXISTS idx_productions_type_status
  ON productions(production_type, status);
CREATE INDEX IF NOT EXISTS idx_productions_status_due
  ON productions(status, due_at);

-- Authored content, moved out of the S3 atoms/ prefix. One row per
-- (production_id, name). `body` is the raw text the S3 atom held — JSON blocks
-- (cover, metadata) are stored as their literal JSON string (callers json.loads
-- them), cta/thanks keep their `kind:` YAML frontmatter verbatim. Presence == a
-- row exists. S3 is now publishing-only (generated outputs + binaries);
-- nothing reads authored content from S3.
CREATE TABLE IF NOT EXISTS production_content (
  production_id TEXT NOT NULL,                 -- 'WT350'
  name          TEXT NOT NULL,                 -- 'intro.md' | 'cover.json' | 'cta-1.md'
  body          TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by    TEXT,
  PRIMARY KEY (production_id, name)
);

CREATE INDEX IF NOT EXISTS idx_production_content_pid
  ON production_content(production_id);

-- Issue tasks — the interactive half of the newsletter state engine. Each
-- issue is phase + content + tasks; a task has an owner (jamie or Eddy) and a
-- status. `origin='added'` rows are ad-hoc/assigned (here); the
-- `origin='computed'` required tasks are projected from content state and are
-- not stored. Eddy can claim + complete his owned tasks via the tasks__* tools.
CREATE TABLE IF NOT EXISTS production_tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  production_id TEXT NOT NULL,
  title         TEXT NOT NULL,
  owner         TEXT NOT NULL DEFAULT 'jamie',  -- jamie | eddy
  status        TEXT NOT NULL DEFAULT 'todo',   -- todo | doing | done | blocked
  origin        TEXT NOT NULL DEFAULT 'added',  -- added | computed
  phase         TEXT,                           -- the phase this task belongs to (optional)
  detail        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    TEXT
);

CREATE INDEX IF NOT EXISTS idx_production_tasks_pid
  ON production_tasks(production_id, status);

-- In-web conversations — legacy Eddy chat threads on newsletter issue pages.
-- The primary workflow is the Studio web UI; chat is retained only as a
-- lightweight repair/ad-hoc surface.
CREATE TABLE IF NOT EXISTS production_chats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  context_key TEXT NOT NULL,
  role        TEXT NOT NULL,                 -- 'user' (Jamie) | 'assistant'
  persona     TEXT,                          -- which agent (assistant rows)
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_production_chats_ctx
  ON production_chats(context_key, id);

-- Job locks — single-asset serialization for the jobs pipeline. A job
-- acquires a row per file it intends to write before starting; another
-- job that wants the same file sees the row and bails with an "already
-- running" message. Released on completion (success or failure). A lock
-- whose pid is no longer a live process is treated as stale and stolen.
CREATE TABLE IF NOT EXISTS job_locks (
  asset TEXT PRIMARY KEY,                        -- e.g. '458/draft.md'
  job TEXT NOT NULL,                             -- job name holding the lock
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  pid INTEGER NOT NULL
);

-- draft_digests (the update-draft projection snapshots) was dropped with
-- the retired update-draft job — the DB is the draft; there's no
-- projection to diff. DROP below so long-lived DBs converge.
DROP TABLE IF EXISTS draft_digests;

-- Goals — Patty's milestone progression. At most one row with
-- achieved_at IS NULL (the active goal). Jamie marks achieved_at when a
-- milestone hits and inserts the next. target_kind is 'members' (live
-- count from Buttondown) or 'dollars' (live total from Stripe).
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_kind TEXT NOT NULL,
  target_value INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (date('now')),
  achieved_at TEXT,
  notes TEXT
);

-- Seed Jamie's current active milestone if the table is empty (idempotent —
-- this whole file re-runs on every boot).
INSERT INTO goals (target_kind, target_value, started_at)
SELECT 'members', 50, '2026-05-11'
WHERE NOT EXISTS (SELECT 1 FROM goals);

-- Campaigns — Marky's ad-placement ledger. One row per placement
-- (an ad in a newsletter, a LinkedIn post, etc.), created by
-- /marky campaign add. Status: 'live' while daily-metrics is polling
-- it, 'sunset' once it's over (historical record only). `ref` is the
-- attribution key Tinylytics + Buttondown look up. `url` is the raw
-- destination URL people clicked (covers UTM-era placements that
-- predate the `?ref=` scheme). `platform` groups placements by channel
-- (DenseDiscovery / LinkedIn / Bluesky / …). `actual_signups` is the
-- current attribution count, denormalised onto the campaign row by
-- daily-metrics after each poll and by Marky via the agent tool for
-- manual corrections — KPI lives at the top of the row, not behind a
-- join. `cost` is dollars paid (nullable; organic placements leave it
-- empty). `copy` holds the placement creative for perf-against-copy.
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  ref TEXT NOT NULL,
  url TEXT,
  platform TEXT,
  status TEXT NOT NULL DEFAULT 'live',
  started_at TEXT NOT NULL DEFAULT (date('now')),
  actual_signups INTEGER,
  cost REAL,
  copy TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_campaigns_ref ON campaigns(ref);

-- Campaign metrics — append-only per-poll trajectory. daily-metrics
-- inserts one row per live campaign each run; a 90-day window is
-- plenty, older rows can age out. Signups only (traffic was dropped
-- in migration 0013 — signups is the KPI; site-traffic noise wasn't
-- pulling its weight).
CREATE TABLE IF NOT EXISTS campaign_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_name TEXT NOT NULL REFERENCES campaigns(name),
  ran_at TEXT NOT NULL DEFAULT (datetime('now')),
  signups INTEGER
);

CREATE INDEX IF NOT EXISTS idx_campaign_metrics_name
  ON campaign_metrics(campaign_name, ran_at DESC, id DESC);

-- Thingy conversations moved to apps/thingy_bridge/db/schema.sql with the
-- two-process split; the DROP above handles long-lived workshop.db files
-- that still have the table from before the split.

-- Follow-ups — an agent (or Jamie) commits to revisiting something at a
-- future time or when the in-flight issue reaches a number. The hourly
-- `follow-up-sweep` job fires the due ones: runs the named persona's agent
-- loop with the note + current context and posts a check-in. There are no
-- per-persona heartbeats — this is the deliberate, targeted exception, and
-- it only does anything when a real commitment comes due.
CREATE TABLE IF NOT EXISTS follow_ups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona TEXT NOT NULL,                          -- who follows up: 'eddy' / 'linky' / 'marky' / 'patty'
  channel_env TEXT,                               -- env var of the channel to post to; NULL = persona's home channel
  trigger_kind TEXT NOT NULL,                     -- 'time' | 'issue'
  due_at TEXT,                                    -- ISO datetime (YYYY-MM-DDTHH:MM:SS) — set when trigger_kind='time'
  trigger_issue INTEGER,                          -- issue number — fires once the active in-flight issue >= this; set when trigger_kind='issue'
  note TEXT NOT NULL,                             -- what was committed to (fed back to the agent verbatim)
  created_by TEXT,                                -- who set it: a Discord user, or the persona itself
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  fired_at TEXT,                                  -- when the sweep fired it; NULL = still open
  cancelled_at TEXT                               -- NULL unless cancelled
);

CREATE INDEX IF NOT EXISTS idx_follow_ups_open
  ON follow_ups(fired_at, cancelled_at, trigger_kind);

-- Per-link research cards Linky has posted to #research. Lets the reply
-- listener resolve a Discord reply back to the URL it's commenting on,
-- so Jamie's reply can be written straight to that Pinboard bookmark's
-- description. One row per posted card; never updated (each card is its
-- own immutable post). `source` is one of:
--   - 'popular'       — Pinboard's popular feed   (URL may not yet be bookmarked)
--   - 'toread'        — Jamie's own toread + public Pinboard bookmarks
-- Source names are declared in apps/workshop_bot/tools/feeds/feed_registry.py's
-- `DISCOVERY_FEEDS` registry (one entry per discovery feed) plus the
-- separate `toread` lane. Retired discovery-source rows are removed by
-- the 0009 cleanup migration.
-- `title` is the source-side title we captured at post time, used as
-- the fallback title when a discovery-feed reply / reaction creates a
-- new bookmark.
CREATE TABLE IF NOT EXISTS linky_research_messages (
  discord_message_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  source TEXT NOT NULL,                           -- see comment above
  title TEXT,
  posted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_linky_research_messages_posted
  ON linky_research_messages(posted_at DESC);

-- Currently types — the pool of "labels" a Currently entry can hang off
-- of (Listening, Watching, Installing, …). Editable: Jamie adds a type
-- via ``/eddy currently add-type`` or by asking Eddy in #editorial; new
-- types need no code change.
--
-- Types deliberately have NO intrinsic render order. Ordering is a
-- per-issue editorial choice (see ``currently_entries.position``). The
-- set of types is a flat pool to draw from; how they sequence within a
-- given issue is Eddy's call (insertion-order by default, reorderable
-- via the ``currently__reorder`` agent tool / ``/eddy currently reorder``).
--
-- ``last_used_issue`` / ``last_used_at`` are a denormalised recency
-- cache, updated by ``currently_set_entry`` on UPSERT (MAX with prior
-- value) and by ``currently_clear_entry`` (recomputed from
-- ``currently_entries`` since clearing a current entry doesn't erase
-- historical usage). Lets ``currently__suggest_stale`` be a single
-- ORDER BY query.
CREATE TABLE IF NOT EXISTS currently_types (
  label TEXT PRIMARY KEY,                          -- 'Listening', 'Printing', …
  is_active INTEGER NOT NULL DEFAULT 1,            -- 0 = retired (kept for history)
  last_used_issue INTEGER,                         -- max issue with a non-empty entry; NULL = never used
  last_used_at TEXT,                               -- timestamp of the most recent set; NULL = never used
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed the canonical types if the table is empty (idempotent — same
-- shape as the goals seed). No order — types are a pool, not a sequence.
INSERT INTO currently_types (label)
SELECT column1 FROM (VALUES
  ('Listening'), ('Watching'), ('Reading'), ('Playing'),
  ('Installing'), ('Dining'), ('Cooking'), ('Making'),
  ('Drinking'), ('Printing')
)
WHERE NOT EXISTS (SELECT 1 FROM currently_types);

-- Currently entries — per-issue values keyed by (issue_number, label).
-- One value per type per issue (overwrite to change). ``value`` may
-- contain markdown (links especially).
--
-- ``position`` drives render order *for that issue only*. Defaults to
-- ``MAX(existing for issue) + 1`` on insert (insertion order). Eddy can
-- override via the ``currently__reorder`` agent tool / ``/eddy currently
-- reorder`` slash — useful when an issue has 3+ entries and a
-- particular sequencing reads better narratively.
CREATE TABLE IF NOT EXISTS currently_entries (
  issue_number INTEGER NOT NULL,
  type_label TEXT NOT NULL REFERENCES currently_types(label),
  value TEXT NOT NULL,
  position INTEGER NOT NULL,                       -- render order within this issue
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (issue_number, type_label)
);

CREATE INDEX IF NOT EXISTS idx_currently_entries_by_type
  ON currently_entries(type_label, issue_number DESC);

CREATE INDEX IF NOT EXISTS idx_currently_entries_render
  ON currently_entries(issue_number, position);

-- Issue items — one row per individually-addressable piece of content in
-- an issue (Notable link, Brief link, Journal entry). Replaces the
-- byte-chunk reorder model that lived in tools/content/chunks.py
-- (retired): reorders are ``UPDATE position``, promotions are column
-- flips, editorial comments anchor to ``item_id``.
--
-- Sectioning:
--   - section IN ('notable','brief','journal')
--   - position — 1-indexed ordinal within (issue_number, section). Kept
--     contiguous by ``tools/issue_items.reorder``; not enforced by the
--     schema (an in-progress sync may temporarily have gaps).
--
-- Promotion (Journal-only at the prompt layer; the schema allows any
-- section so future designs aren't blocked):
--   - is_promoted=1 lifts the item out of its parent section into a
--     standalone featured section.
--   - promoted_position ∈ ('after_notable','after_journal','after_brief')
--   - promoted_heading carries the standalone section's H2 text.
--
-- Source identity:
--   - source ∈ ('pinboard','microblog','manual')
--   - source_id — upstream stable id (Pinboard URL hash, micro.blog post
--     URL, etc.). Used as the UPSERT key alongside (issue_number, source).
--
-- Body shape:
--   - title — H3 link text (Notable, elevated Journal) or "" (status posts)
--   - url — primary link target
--   - body_md — source-owned commentary (Notable), full post body (Journal —
--     already image-rehosted), pre-arrow commentary (Brief; the bolded link is
--     rendered from title+url, not stored in body_md)
--   - body_override — editor-owned replacement body used by Studio renderers;
--     sync never writes it, so inline editorial edits survive refresh
--   - metadata_json — per-source extras: weekday-time label (Journal),
--     brief tag flag, image rehost manifest, etc.
CREATE TABLE IF NOT EXISTS issue_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_number INTEGER NOT NULL,
  section TEXT NOT NULL,
  section_override TEXT,                      -- editor-owned (atom editor); render reads COALESCE(section_override, section); sync never writes it
  excluded INTEGER NOT NULL DEFAULT 0,        -- editor-owned; deselected from the issue (render skips); survives sync
  position INTEGER NOT NULL,
  is_promoted INTEGER NOT NULL DEFAULT 0,
  promoted_position TEXT,
  promoted_heading TEXT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  url TEXT,
  title TEXT,
  body_md TEXT,
  body_override TEXT,                         -- editor-owned body replacement; render reads COALESCE(body_override, body_md); sync never writes it
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(issue_number, source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_issue_items_issue_section_pos
  ON issue_items(issue_number, section, position);

-- Editorial comments — Eddy's draft-review items, anchored to issue_items
-- rows (or to a whole section / the whole issue) and stamped with a
-- stable human-readable handle for the HTML drawer + Discord lookup.
-- Re-reviews supersede earlier comments via ``replaced_by_id`` rather
-- than deleting them, so cross-iteration history is queryable.
--
-- Handle shape: ``E{issue}-{letter}{ordinal}`` e.g. ``E349-N1``,
-- ``E349-J2``, ``E349-X1`` (hygiene), ``E349-W1`` (whole-issue). Letters:
--   N notable · B brief · J journal · C currently · V cover (visual) ·
--   I intro · O outro · H haiku · X hygiene · W whole-issue
--
-- Ordinals are 1-indexed within (issue, letter) across history — once a
-- handle is assigned it never reuses, even after the comment is
-- superseded. This gives Jamie a stable ID he can paste back into
-- Discord days later without ambiguity.
--
-- Scope:
--   - 'item'    — anchored to ``item_id``; ``section`` set for convenience
--   - 'section' — anchored to ``section`` only
--   - 'issue'   — whole-issue observation (letter='W')
--   - 'hygiene' — deliverability/voice/anchor-text lens (letter='X')
--
-- Verdict:
--   - 'positive'   — calling out something working
--   - 'suggestion' — proposed change (default)
--   - 'blocker'    — ship-critical (anchor mismatch, dead link, voice slip)
-- ``closed_at`` is set when a *new* review pass returned PASS — there's
-- no replacement comment to chain via ``replaced_by_id``, but the prior
-- pass's guidance is stale and shouldn't surface in the drawer. The
-- ``list_open_comments`` filter checks both ``replaced_by_id IS NULL``
-- and ``closed_at IS NULL`` so a closed row drops out of the open set
-- the same way a superseded row does. History is preserved either way.
CREATE TABLE IF NOT EXISTS editorial_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  scope TEXT NOT NULL,
  item_id INTEGER REFERENCES issue_items(id),
  section TEXT,
  verdict TEXT NOT NULL DEFAULT 'suggestion',
  anchor_text TEXT,
  body_md TEXT NOT NULL,
  reasoning_md TEXT,
  replaced_by_id INTEGER REFERENCES editorial_comments(id),
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_editorial_comments_handle
  ON editorial_comments(handle);

CREATE INDEX IF NOT EXISTS idx_editorial_comments_issue_open
  ON editorial_comments(issue_number, replaced_by_id, created_at DESC);

-- Issues — the canonical per-issue historical record. One row per
-- *published* issue. Distinct from ``issue_windows`` (which tracks the
-- in-flight workshop window): ``issues`` is the archive Marky/Linky/Eddy
-- query for exact lookups, the future authoritative source the site's
-- generator can read from instead of static ``data/issues/{N}/`` files.
--
-- Populated two ways:
--   1. One-shot historical backfill (``pipeline/one-shot/backfill_issues_data_layer.py``)
--      walks the static repo for every shipped issue.
--   2. ``/eddy issue put-to-bed`` files the just-shipped active issue
--      and closes its ``issue_windows`` row.
--
-- ``era`` is derived from ``number`` — 1–41 tinyletter, 42–130 mailchimp,
-- 131+ buttondown. Carried as a column for cheap GROUP BY.
CREATE TABLE IF NOT EXISTS issues (
  number             INTEGER PRIMARY KEY,
  subject            TEXT NOT NULL,
  slug               TEXT NOT NULL DEFAULT '',
  description        TEXT NOT NULL DEFAULT '',
  publish_date       TEXT NOT NULL,                  -- ISO date YYYY-MM-DD
  image              TEXT NOT NULL DEFAULT '',
  absolute_url       TEXT NOT NULL DEFAULT '',
  buttondown_id      TEXT NOT NULL DEFAULT '',
  word_count         INTEGER NOT NULL DEFAULT 0,
  notable_count      INTEGER NOT NULL DEFAULT 0,
  briefly_count      INTEGER NOT NULL DEFAULT 0,
  domain_count       INTEGER NOT NULL DEFAULT 0,
  link_count         INTEGER NOT NULL DEFAULT 0,
  audio_url          TEXT NOT NULL DEFAULT '',
  audio_duration_s   INTEGER,                        -- NULL = no audio
  audio_byte_size    INTEGER,
  audio_voice        TEXT NOT NULL DEFAULT '',       -- e.g. 'openai-tts-1-hd:echo'
  era                TEXT NOT NULL,                  -- 'tinyletter' | 'mailchimp' | 'buttondown'
  filed_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_issues_publish_date
  ON issues(publish_date DESC);

CREATE INDEX IF NOT EXISTS idx_issues_era
  ON issues(era);

-- Every link ever shipped, sourced from ``data/issues/{N}/links.json``.
-- One row per Notable or Briefly link; section carries which list it came
-- from. ``position`` is 0-indexed within (issue_number, section).
--
-- ``heading_context`` is the inline H3 / bolded-link surrounding text
-- captured by the librarian extraction — kept for resonance / display.
CREATE TABLE IF NOT EXISTS issue_links (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_number       INTEGER NOT NULL REFERENCES issues(number) ON DELETE CASCADE,
  section            TEXT NOT NULL,                  -- 'notable' | 'briefly'
  position           INTEGER NOT NULL,
  url                TEXT NOT NULL,
  text               TEXT NOT NULL DEFAULT '',
  domain             TEXT NOT NULL DEFAULT '',
  heading_context    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_issue_links_domain
  ON issue_links(domain, issue_number);

CREATE INDEX IF NOT EXISTS idx_issue_links_url
  ON issue_links(url);

CREATE INDEX IF NOT EXISTS idx_issue_links_issue_section
  ON issue_links(issue_number, section, position);

-- Feedbin starred items — dedup record for the ingester. Jamie stars an
-- article in Feedbin; the ``feedbin-ingest`` job creates a corresponding
-- ``toread=yes shared=yes`` bookmark in Pinboard and records the item's
-- stable GUID here so the next poll doesn't re-create it. (Pinboard's
-- own ``posts/add replace=no`` is a backstop, but we still dedup
-- locally to keep the per-poll workload empty most of the time.)
CREATE TABLE IF NOT EXISTS feedbin_starred_seen (
  guid          TEXT PRIMARY KEY,                       -- feedbin item guid
  url           TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  pinboard_result TEXT,                                 -- 'done' | 'item already exists' | NULL on error
  seen_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedbin_starred_seen_url
  ON feedbin_starred_seen(url);

-- Read-only roll-up over issue_links. No backfill needed — always
-- consistent with whatever issue_links currently contains.
CREATE VIEW IF NOT EXISTS domain_stats AS
SELECT
  domain,
  COUNT(*)                     AS link_count,
  COUNT(DISTINCT issue_number) AS issue_count,
  MIN(issue_number)            AS first_issue,
  MAX(issue_number)            AS last_issue
FROM issue_links
WHERE domain != ''
GROUP BY domain;
