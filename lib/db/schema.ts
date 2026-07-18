/**
 * The complete SQLite schema — nine tables — applied on first run when the
 * database file does not yet exist. Kept as a TS string rather than a loose
 * .sql file so it is bundler-safe inside Next's server runtime (no runtime
 * filesystem read of a non-bundled asset).
 *
 * Every statement is idempotent (IF NOT EXISTS) so applying it to an existing
 * database is a no-op. The `status` CHECK constraint mirrors the JobStatus
 * union in lib/types.ts — keep the two in sync.
 *
 * See jobfinder-docs.md "Database Schema".
 */
import { DEFAULT_OWNER_NAME } from '../types';

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Setup config (FR-25). Single row, pinned to id = 1. The four resume assets
-- are NOT columns here — they live in resume_assets (FR-33). Databases created
-- before FR-33 carry vestigial resume_latex/source_of_truth/scoring_prompt/
-- rewrite_rules columns; migrate() moves their content into resume_assets once
-- and blanks them. Databases that predate the Proxycurl-strategy removal carry
-- a vestigial search_url column (unused, left in place — its DEFAULT '' keeps
-- the upsert working without naming it); a stored 'proxycurl' strategy is
-- coerced to 'linkedin' by migrate().
CREATE TABLE IF NOT EXISTS user_config (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  scraper_strategy TEXT NOT NULL DEFAULT 'linkedin'
                     CHECK (scraper_strategy IN ('demo','linkedin')),
  -- Orthogonal source toggle: Greenhouse runs alongside the primary strategy.
  greenhouse_enabled INTEGER NOT NULL DEFAULT 0 CHECK (greenhouse_enabled IN (0,1)),
  owner_name       TEXT NOT NULL DEFAULT '${DEFAULT_OWNER_NAME}',
  -- Saved-search inputs (FR-2/FR-25): JSON arrays. The LinkedIn guest strategy
  -- runs the cross product of these.
  keywords         TEXT NOT NULL DEFAULT '["AI Engineer","Machine Learning Engineer","ML Engineer","Software Engineer","Forward Deployed Engineer","Solutions Engineer"]',
  locations        TEXT NOT NULL DEFAULT '["New York","New Jersey"]',
  -- Title-exclusion terms (FR-4a): whole-word matches drop over-senior postings
  -- that LinkedIn's leaky f_E filter lets through. Empty = no title filtering.
  excluded_title_terms TEXT NOT NULL DEFAULT '["senior","sr","staff","principal","lead","manager","director","head of","vp","chief","scientist"]',
  -- Auto-run cadence in minutes while the app is open; 0 = manual only.
  run_interval_minutes INTEGER NOT NULL DEFAULT 0,
  -- Only scrape jobs posted within this many hours (LinkedIn f_TPR). Default 1.
  search_lookback_hours INTEGER NOT NULL DEFAULT 1,
  -- Auto-filter: a freshly scored job whose fit score is below this is flagged
  -- (jobs.below_threshold) and kept out of the decision queue. Default 50.
  score_threshold  INTEGER NOT NULL DEFAULT 50,
  -- Scoring backend (FR-6): the local Ollama model by default; 'anthropic'
  -- restores Haiku scoring. ollama_model is the tag the local backend runs.
  scoring_backend  TEXT NOT NULL DEFAULT 'ollama'
                     CHECK (scoring_backend IN ('ollama','anthropic')),
  ollama_model     TEXT NOT NULL DEFAULT 'qwen3:4b-instruct-2507-q4_K_M',
  -- First-run onboarding (FR-33): set to 1 when the guided flow is finished.
  -- The pipeline gate also lifts once a user base resume exists (DB or file).
  onboarding_complete INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_complete IN (0,1)),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- In-app-authored resume assets (FR-33) — the top layer of the per-file
-- resolution in-app (this table) → resume/ file → resume-example/ starter.
-- A row exists only for an asset authored in the app; deleting it reverts that
-- asset to the file/example fallback. The name CHECK mirrors RESUME_ASSET_NAMES
-- in lib/types.ts — keep the two in sync.
CREATE TABLE IF NOT EXISTS resume_assets (
  name       TEXT PRIMARY KEY CHECK (name IN
               ('base_resume','source_of_truth','scoring_prompt','rewrite_rules')),
  content    TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Primary table. job_id is the LinkedIn posting id (dedup key, FR-3);
-- id is the internal autoincrement key referenced by child tables.
CREATE TABLE IF NOT EXISTS jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            TEXT NOT NULL UNIQUE,
  company           TEXT NOT NULL,
  title             TEXT NOT NULL,
  location          TEXT,
  salary            TEXT,
  description       TEXT,
  url               TEXT NOT NULL,
  -- Provenance: which site the posting came from. Mirrors the JobSource union in
  -- lib/types.ts — keep the two in sync. Defaults to 'linkedin' so all existing
  -- rows and the LinkedIn/demo path resolve there.
  source            TEXT NOT NULL DEFAULT 'linkedin' CHECK (source IN ('linkedin','greenhouse')),
  posted_at         TEXT,
  -- LinkedIn's structured job-criteria fields + applicant caption, scraped
  -- from the guest detail page (best-effort enrichment, often present).
  seniority_level   TEXT,
  employment_type   TEXT,
  job_function      TEXT,
  industries        TEXT,
  applicants        TEXT,
  status            TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
                       'new','scored','passed','rewriting','approved','applied',
                       'interview','offer','accepted','rejected','withdrawn','ghosted'
                     )),
  score             INTEGER,
  score_reason      TEXT,
  -- Auto-filter flag (FR-9a): set when a job is scored below the configured
  -- score_threshold. Flagged jobs stay in the table as data but are excluded
  -- from the decision queue. A flag, not a status — orthogonal to the lifecycle.
  below_threshold   INTEGER NOT NULL DEFAULT 0 CHECK (below_threshold IN (0,1)),
  rewritten_latex   TEXT,
  explanation       TEXT,            -- JSON {summary, bullets}
  approved_pdf_path TEXT,
  latex_hash        TEXT,            -- SHA-256 of most recently compiled LaTeX
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
-- Decision-queue query: WHERE status IN (...) ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at DESC);

-- The computed diff from the server-side diff-match-patch run the rewrite
-- route performs when the stream completes, persisted in the same transaction
-- as the rewrite. Stored here and nowhere else so the jobs list stays
-- lightweight.
CREATE TABLE IF NOT EXISTS resume_changes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  block_type TEXT NOT NULL CHECK (block_type IN ('insert','delete','equal')),
  content    TEXT NOT NULL,
  seq        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resume_changes_job ON resume_changes(job_id);

-- Version history for the rewritten LaTeX. Undo references a row id here,
-- which is what defeats the autosave-vs-undo race.
CREATE TABLE IF NOT EXISTS rewritten_latex_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('ai_generation','autosave')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_versions_job ON rewritten_latex_versions(job_id);

-- The undo stack. version_id pins the rewritten_latex_versions row active when
-- the command executed (NULL for commands that do not touch the rewrite).
CREATE TABLE IF NOT EXISTS command_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  command_type    TEXT NOT NULL,
  job_id          INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  previous_status TEXT,
  new_status      TEXT,
  version_id      INTEGER REFERENCES rewritten_latex_versions(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_command_history_job ON command_history(job_id);

-- One row per source per scrape run (the primary strategy, plus Greenhouse when
-- enabled), tagged by its strategy name. Startup reconciliation inspects
-- 'running' rows and getLastScrapeEndedAt takes MAX(ended_at), both fine across
-- multiple rows per run. Databases that predate the Proxycurl-strategy removal
-- carry a vestigial nullable search_url column (unused, left in place).
CREATE TABLE IF NOT EXISTS scrape_sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy   TEXT NOT NULL,
  found      INTEGER NOT NULL DEFAULT 0,
  blocked    INTEGER NOT NULL DEFAULT 0,
  inserted   INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'running'
               CHECK (status IN ('running','completed','failed')),
  error      TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at   TEXT
);

-- The company blocklist (FR-4). name_normalized is lower-cased + trimmed.
CREATE TABLE IF NOT EXISTS blocked_companies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name_normalized TEXT NOT NULL UNIQUE,
  added_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_blocked_name ON blocked_companies(name_normalized);

-- Per-request AI telemetry ledger (FR-27): one row per Anthropic call.
-- Written best-effort by lib/ai/telemetry.ts — a failed insert never fails the
-- user-facing operation. Token fields are NULL when the call errored before a
-- response; cost_usd is a snapshot computed at write time (prices change).
-- Existing databases pick this table up because applySchema runs on every open.
CREATE TABLE IF NOT EXISTS ai_calls (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  call_type              TEXT NOT NULL CHECK (call_type IN
                           ('score','score_batch','rewrite','explain','salary')),
  model                  TEXT NOT NULL,
  job_id                 INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  input_tokens           INTEGER,
  output_tokens          INTEGER,
  cache_creation_tokens  INTEGER,
  cache_read_tokens      INTEGER,
  cost_usd               REAL,
  latency_ms             INTEGER,
  stop_reason            TEXT,
  error                  TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_job ON ai_calls(job_id);
CREATE INDEX IF NOT EXISTS idx_ai_calls_created ON ai_calls(created_at);
`;
