/**
 * Data-access layer — the typed SQLite reads/writes the Command layer and route
 * handlers build on. Row shapes (snake_case columns) are mapped to the camelCase
 * domain types once, here. All writes go through the single server-side writer.
 */
import type { DB } from './index';
import type {
  Job,
  JobStatus,
  JobSource,
  CommandType,
  ResumeAssetName,
  RewriteVersionSource,
  UserConfig,
  ScraperStrategyName,
  ScoringBackendName,
} from '../types';
import { normalizeCompanyName } from '../companies';
import { DECISION_QUEUE_STATUSES, TRACKER_STATUSES } from '../status/transitions';
import type { NormalizedJob } from '../scrape/pipeline';
import type { DiffBlock } from '../diff';

/**
 * A `status IN (?, …)` predicate with one placeholder per status — spread the
 * same set as bind parameters. Keeps the named sets from the status module the
 * only encoding of which statuses a query covers.
 */
function statusIn(statuses: readonly JobStatus[]): string {
  return `status IN (${statuses.map(() => '?').join(',')})`;
}

interface JobRow {
  id: number;
  job_id: string;
  company: string;
  title: string;
  location: string | null;
  salary: string | null;
  description: string | null;
  url: string;
  source: JobSource;
  posted_at: string | null;
  seniority_level: string | null;
  employment_type: string | null;
  job_function: string | null;
  industries: string | null;
  applicants: string | null;
  status: JobStatus;
  score: number | null;
  score_reason: string | null;
  below_threshold: number;
  rewritten_latex: string | null;
  explanation: string | null;
  approved_pdf_path: string | null;
  latex_hash: string | null;
  created_at: string;
  updated_at: string;
}

export function mapJobRow(row: JobRow): Job {
  return {
    id: row.id,
    jobId: row.job_id,
    company: row.company,
    title: row.title,
    location: row.location,
    salary: row.salary,
    description: row.description,
    url: row.url,
    source: row.source,
    postedAt: row.posted_at,
    seniorityLevel: row.seniority_level,
    employmentType: row.employment_type,
    jobFunction: row.job_function,
    industries: row.industries,
    applicants: row.applicants,
    status: row.status,
    score: row.score,
    scoreReason: row.score_reason,
    belowThreshold: row.below_threshold !== 0,
    rewrittenLatex: row.rewritten_latex,
    explanation: row.explanation,
    approvedPdfPath: row.approved_pdf_path,
    latexHash: row.latex_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Fetch a job by internal primary key. */
export function getJobById(db: DB, id: number): Job | undefined {
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
  return row ? mapJobRow(row) : undefined;
}

/** Fetch a job by LinkedIn job id (the dedup key). */
export function getJobByJobId(db: DB, jobId: string): Job | undefined {
  const row = db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).get(jobId) as JobRow | undefined;
  return row ? mapJobRow(row) : undefined;
}

/**
 * Insert a freshly scraped job (status defaults to 'new'); returns its id.
 * `source` records provenance and defaults to 'linkedin', so the LinkedIn/demo
 * scrape path stays unchanged; Greenhouse callers pass 'greenhouse' explicitly.
 */
export function insertJob(db: DB, job: NormalizedJob, source: JobSource = 'linkedin'): number {
  const info = db
    .prepare(
      `INSERT INTO jobs (job_id, company, title, location, salary, description, url, source, posted_at,
                         seniority_level, employment_type, job_function, industries, applicants)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      job.jobId,
      job.company,
      job.title,
      job.location,
      job.salary,
      job.description,
      job.url,
      source,
      job.postedAt,
      job.seniorityLevel,
      job.employmentType,
      job.jobFunction,
      job.industries,
      job.applicants,
    );
  return Number(info.lastInsertRowid);
}

/**
 * The decision queue: jobs awaiting a decision (new/scored), newest first.
 * Auto-filtered jobs (below_threshold = 1, scored under the configured cutoff)
 * are excluded — they remain in the table for analytics but never clutter the
 * queue (FR-9, FR-9a). This is the operational query; data/analytics queries
 * (listAllJobs, the dashboard) deliberately include flagged rows.
 */
export function listDecisionQueue(db: DB, limit = 50): Job[] {
  const rows = db
    .prepare(
      `SELECT * FROM jobs
        WHERE ${statusIn(DECISION_QUEUE_STATUSES)} AND below_threshold = 0
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...DECISION_QUEUE_STATUSES, limit) as JobRow[];
  return rows.map(mapJobRow);
}

/** Tracker jobs: approved and everything downstream, most-recently-changed first. */
export function listTrackerJobs(db: DB): Job[] {
  const rows = db
    .prepare(
      `SELECT * FROM jobs
        WHERE ${statusIn(TRACKER_STATUSES)}
        ORDER BY updated_at DESC`,
    )
    .all(...TRACKER_STATUSES) as JobRow[];
  return rows.map(mapJobRow);
}

/**
 * Every job, ordered by company (case-insensitive) then newest first. Backs the
 * Companies view, which groups all postings — across every status — by employer.
 */
export function listAllJobs(db: DB): Job[] {
  const rows = db
    .prepare(
      // id DESC tiebreaks within a company: datetime('now') is second-resolution,
      // so rows inserted in the same second share a created_at.
      `SELECT * FROM jobs ORDER BY company COLLATE NOCASE ASC, created_at DESC, id DESC`,
    )
    .all() as JobRow[];
  return rows.map(mapJobRow);
}

/** Jobs in a given status, newest first, paginated. */
export function listJobsByStatusPaged(
  db: DB,
  status: JobStatus,
  limit: number,
  offset: number,
): Job[] {
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(status, limit, offset) as JobRow[];
  return rows.map(mapJobRow);
}

/**
 * Delete every job in the decision queue (status new/scored) and return how many
 * were removed. Used by the Jobs "Clear all" action. Only touches the queue —
 * jobs being tailored, approved, or tracked are left untouched.
 */
export function clearDecisionQueue(db: DB): number {
  return db
    .prepare(`DELETE FROM jobs WHERE ${statusIn(DECISION_QUEUE_STATUSES)}`)
    .run(...DECISION_QUEUE_STATUSES).changes;
}

/**
 * Wipe all job and pipeline data for a fresh start: every job (which cascades to
 * resume_changes, rewritten_latex_versions, and command_history via ON DELETE
 * CASCADE) plus the scrape-session log. Deliberately preserves user_config,
 * the in-app resume assets (resume_assets), and the company blocklist —
 * "start fresh" means fresh *jobs*, not re-doing Setup. Returns the number of
 * jobs removed.
 */
export function resetPipeline(db: DB): number {
  const tx = db.transaction(() => {
    const deleted = db.prepare(`DELETE FROM jobs`).run().changes;
    db.prepare(`DELETE FROM scrape_sessions`).run();
    return deleted;
  });
  return tx();
}

/** Count of jobs in a given status. */
export function countJobsByStatus(db: DB, status: JobStatus): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = ?`).get(status) as { n: number }
  ).n;
}

/** The stored diff blocks for a job, in order. */
export function getResumeChanges(db: DB, jobId: number): DiffBlock[] {
  const rows = db
    .prepare(`SELECT block_type, content, seq FROM resume_changes WHERE job_id = ? ORDER BY seq ASC`)
    .all(jobId) as Array<{ block_type: DiffBlock['blockType']; content: string; seq: number }>;
  return rows.map((r) => ({ blockType: r.block_type, content: r.content, seq: r.seq }));
}

/**
 * The rewrite queue: every job currently being tailored (status 'rewriting'),
 * in a stable oldest-first order so the in-page prev/next navigator does not
 * reshuffle as autosave bumps updated_at. id ASC tiebreaks within a second.
 */
export function listRewriteQueue(db: DB): Job[] {
  const rows = db
    .prepare(`SELECT * FROM jobs WHERE status = 'rewriting' ORDER BY created_at ASC, id ASC`)
    .all() as JobRow[];
  return rows.map(mapJobRow);
}

/** The ids of jobs in a given status. */
export function listJobIdsByStatus(db: DB, status: JobStatus): number[] {
  const rows = db
    .prepare(`SELECT id FROM jobs WHERE status = ? ORDER BY created_at DESC`)
    .all(status) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

/**
 * Record a score (and rationale) and move the job new → scored. `belowThreshold`
 * flags a job scored under the configured cutoff so the decision queue excludes
 * it (FR-9a); the flag is written alongside the score in the same statement.
 * Guarded so a job already past triage is never reset to scored.
 */
export function setScore(
  db: DB,
  id: number,
  score: number,
  reason: string,
  belowThreshold = false,
): void {
  db.prepare(
    `UPDATE jobs SET score = ?, score_reason = ?, below_threshold = ?,
            status = 'scored', updated_at = datetime('now')
       WHERE id = ? AND ${statusIn(DECISION_QUEUE_STATUSES)}`,
  ).run(score, reason, belowThreshold ? 1 : 0, id, ...DECISION_QUEUE_STATUSES);
}

/**
 * Store a job's salary — from description mining, the AI lookup, or a manual
 * edit. `null` clears it (manual "remove"), which is why the parameter is
 * nullable rather than a bare string.
 */
export function setSalary(db: DB, id: number, salary: string | null): void {
  db.prepare(`UPDATE jobs SET salary = ?, updated_at = datetime('now') WHERE id = ?`).run(
    salary,
    id,
  );
}

/** Store the change explanation JSON ({summary, bullets}); `null` clears it. */
export function setExplanation(db: DB, id: number, json: string | null): void {
  db.prepare(`UPDATE jobs SET explanation = ?, updated_at = datetime('now') WHERE id = ?`).run(
    json,
    id,
  );
}

/** Replace a job's computed diff blocks (resume_changes) atomically. */
export function replaceResumeChanges(db: DB, jobId: number, blocks: DiffBlock[]): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM resume_changes WHERE job_id = ?`).run(jobId);
    const insert = db.prepare(
      `INSERT INTO resume_changes (job_id, block_type, content, seq) VALUES (?, ?, ?, ?)`,
    );
    for (const block of blocks) {
      insert.run(jobId, block.blockType, block.content, block.seq);
    }
  })();
}

export function updateJobStatus(db: DB, id: number, status: JobStatus): void {
  db.prepare(`UPDATE jobs SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
}

/**
 * Delete a single job by primary key (cascades to its resume_changes,
 * rewritten_latex_versions, and command_history). Used to drop a queued job that
 * should never have been scored — e.g. an over-senior title that slipped past
 * the scrape-time title filter (FR-4a).
 */
export function deleteJob(db: DB, id: number): void {
  db.prepare(`DELETE FROM jobs WHERE id = ?`).run(id);
}

/** Set (or clear, with null) the denormalized current rewritten LaTeX. */
export function setRewrittenLatex(db: DB, id: number, latex: string | null): void {
  db.prepare(`UPDATE jobs SET rewritten_latex = ?, updated_at = datetime('now') WHERE id = ?`).run(
    latex,
    id,
  );
}

/** Record the SHA-256 of the most recently compiled LaTeX. */
export function setLatexHash(db: DB, id: number, hash: string): void {
  db.prepare(`UPDATE jobs SET latex_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(
    hash,
    id,
  );
}

/** Set approved_pdf_path and status together (the approval write). */
export function setApprovedPdf(db: DB, id: number, path: string, status: JobStatus): void {
  db.prepare(
    `UPDATE jobs SET approved_pdf_path = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(path, status, id);
}

/** Clear approved_pdf_path and set status (the approval undo). */
export function clearApprovedPdf(db: DB, id: number, status: JobStatus): void {
  db.prepare(
    `UPDATE jobs SET approved_pdf_path = NULL, status = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(status, id);
}

// --- rewritten_latex_versions ---

export interface RewriteVersionRow {
  id: number;
  job_id: number;
  content: string;
  source_type: RewriteVersionSource;
  created_at: string;
}

/** Append a version row and return its id. */
export function appendRewriteVersion(
  db: DB,
  jobId: number,
  content: string,
  sourceType: RewriteVersionSource,
): number {
  const info = db
    .prepare(
      `INSERT INTO rewritten_latex_versions (job_id, content, source_type) VALUES (?, ?, ?)`,
    )
    .run(jobId, content, sourceType);
  return Number(info.lastInsertRowid);
}

/** The id of the most recently inserted version for a job, if any. */
export function getLatestRewriteVersionId(db: DB, jobId: number): number | undefined {
  const row = db
    .prepare(`SELECT id FROM rewritten_latex_versions WHERE job_id = ? ORDER BY id DESC LIMIT 1`)
    .get(jobId) as { id: number } | undefined;
  return row?.id;
}

/** Read a specific version row by id — the basis of race-free undo. */
export function getRewriteVersion(db: DB, versionId: number): RewriteVersionRow | undefined {
  return db.prepare(`SELECT * FROM rewritten_latex_versions WHERE id = ?`).get(versionId) as
    | RewriteVersionRow
    | undefined;
}

// --- command_history ---

export interface CommandRow {
  id: number;
  command_type: CommandType;
  job_id: number;
  previous_status: JobStatus | null;
  new_status: JobStatus | null;
  version_id: number | null;
  created_at: string;
}

export interface InsertCommandInput {
  commandType: CommandType;
  jobId: number;
  previousStatus: JobStatus | null;
  newStatus: JobStatus | null;
  versionId: number | null;
}

export function insertCommand(db: DB, input: InsertCommandInput): number {
  const info = db
    .prepare(
      `INSERT INTO command_history (command_type, job_id, previous_status, new_status, version_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.commandType, input.jobId, input.previousStatus, input.newStatus, input.versionId);
  return Number(info.lastInsertRowid);
}

/** The most recent command for a job — the top of its undo stack. */
export function getLatestCommand(db: DB, jobId: number): CommandRow | undefined {
  return db
    .prepare(`SELECT * FROM command_history WHERE job_id = ? ORDER BY id DESC LIMIT 1`)
    .get(jobId) as CommandRow | undefined;
}

export function deleteCommand(db: DB, id: number): void {
  db.prepare(`DELETE FROM command_history WHERE id = ?`).run(id);
}

// --- scrape_sessions ---

/** Open a scrape session row in 'running' state; returns its id. */
export function createScrapeSession(db: DB, strategy: string, searchUrl: string | null): number {
  const info = db
    .prepare(`INSERT INTO scrape_sessions (strategy, search_url, status) VALUES (?, ?, 'running')`)
    .run(strategy, searchUrl);
  return Number(info.lastInsertRowid);
}

export interface ScrapeSessionResult {
  found: number;
  blocked: number;
  inserted: number;
  status: 'completed' | 'failed';
  error?: string | null;
}

/** Close out a scrape session with its final counts and status. */
export function finishScrapeSession(db: DB, id: number, result: ScrapeSessionResult): void {
  db.prepare(
    `UPDATE scrape_sessions
        SET found = ?, blocked = ?, inserted = ?, status = ?, error = ?,
            updated_at = datetime('now'), ended_at = datetime('now')
      WHERE id = ?`,
  ).run(result.found, result.blocked, result.inserted, result.status, result.error ?? null, id);
}

/**
 * Epoch ms the most recent scrape run ended (any outcome), or null if none has
 * ever run. Anchors the auto-run scheduler so the next-run time derives from
 * the actual last run rather than resetting on process restart. `ended_at` is
 * SQLite `datetime('now')` — UTC without a zone suffix, hence the 'Z'.
 */
export function getLastScrapeEndedAt(db: DB): number | null {
  const row = db
    .prepare(`SELECT MAX(ended_at) AS endedAt FROM scrape_sessions`)
    .get() as { endedAt: string | null } | undefined;
  if (!row?.endedAt) return null;
  const ms = Date.parse(row.endedAt.replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? null : ms;
}

// --- user_config (the single Setup row, id = 1) ---

interface UserConfigRow {
  search_url: string;
  scraper_strategy: ScraperStrategyName;
  greenhouse_enabled: number;
  owner_name: string;
  keywords: string;
  locations: string;
  excluded_title_terms: string;
  run_interval_minutes: number;
  search_lookback_hours: number;
  score_threshold: number;
  scoring_backend: ScoringBackendName;
  ollama_model: string;
}

/** Parse a JSON string column into a string[], tolerating malformed values. */
function parseStringArray(json: string): string[] {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Read the Setup config row, or undefined if Setup has not been saved yet. */
export function getUserConfig(db: DB): UserConfig | undefined {
  const row = db.prepare(`SELECT * FROM user_config WHERE id = 1`).get() as
    | UserConfigRow
    | undefined;
  if (!row) return undefined;
  return {
    searchUrl: row.search_url,
    scraperStrategy: row.scraper_strategy,
    greenhouseEnabled: row.greenhouse_enabled !== 0,
    ownerName: row.owner_name,
    keywords: parseStringArray(row.keywords),
    locations: parseStringArray(row.locations),
    excludedTitleTerms: parseStringArray(row.excluded_title_terms),
    runIntervalMinutes: row.run_interval_minutes,
    searchLookbackHours: row.search_lookback_hours,
    scoreThreshold: row.score_threshold,
    scoringBackend: row.scoring_backend,
    ollamaModel: row.ollama_model,
  };
}

/** Insert or update the single Setup config row (id = 1). Never touches the
 *  onboarding flag — that is setOnboardingComplete's job. */
export function upsertUserConfig(db: DB, config: UserConfig): void {
  db.prepare(
    `INSERT INTO user_config
       (id, search_url, scraper_strategy, greenhouse_enabled, owner_name, keywords, locations,
        excluded_title_terms, run_interval_minutes, search_lookback_hours,
        score_threshold, scoring_backend, ollama_model, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       search_url = excluded.search_url,
       scraper_strategy = excluded.scraper_strategy,
       greenhouse_enabled = excluded.greenhouse_enabled,
       owner_name = excluded.owner_name,
       keywords = excluded.keywords,
       locations = excluded.locations,
       excluded_title_terms = excluded.excluded_title_terms,
       run_interval_minutes = excluded.run_interval_minutes,
       search_lookback_hours = excluded.search_lookback_hours,
       score_threshold = excluded.score_threshold,
       scoring_backend = excluded.scoring_backend,
       ollama_model = excluded.ollama_model,
       updated_at = datetime('now')`,
  ).run(
    config.searchUrl,
    config.scraperStrategy,
    config.greenhouseEnabled ? 1 : 0,
    config.ownerName,
    JSON.stringify(config.keywords),
    JSON.stringify(config.locations),
    JSON.stringify(config.excludedTitleTerms),
    config.runIntervalMinutes,
    config.searchLookbackHours,
    config.scoreThreshold,
    config.scoringBackend,
    config.ollamaModel,
  );
}

/** True once the guided first-run flow has been finished (FR-33). */
export function isOnboardingComplete(db: DB): boolean {
  const row = db
    .prepare(`SELECT onboarding_complete AS done FROM user_config WHERE id = 1`)
    .get() as { done: number } | undefined;
  return row !== undefined && row.done !== 0;
}

/** Mark the guided first-run flow finished, creating the config row if needed
 *  (every other column has a schema default). */
export function setOnboardingComplete(db: DB): void {
  db.prepare(
    `INSERT INTO user_config (id, onboarding_complete) VALUES (1, 1)
     ON CONFLICT(id) DO UPDATE SET onboarding_complete = 1, updated_at = datetime('now')`,
  ).run();
}

// --- resume_assets (FR-33) ---

/** Every in-app-authored asset, keyed by name. Absent key = not authored
 *  in-app; that asset resolves to the resume/ file or example fallback. */
export function getResumeAssets(db: DB): Partial<Record<ResumeAssetName, string>> {
  const rows = db.prepare(`SELECT name, content FROM resume_assets`).all() as Array<{
    name: ResumeAssetName;
    content: string;
  }>;
  const assets: Partial<Record<ResumeAssetName, string>> = {};
  for (const row of rows) assets[row.name] = row.content;
  return assets;
}

/** Author (or re-author) one asset in-app — it now wins the resolution. */
export function setResumeAsset(db: DB, name: ResumeAssetName, content: string): void {
  db.prepare(
    `INSERT INTO resume_assets (name, content) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`,
  ).run(name, content);
}

/** Revert one asset to its file/example fallback by dropping the in-app row. */
export function deleteResumeAsset(db: DB, name: ResumeAssetName): void {
  db.prepare(`DELETE FROM resume_assets WHERE name = ?`).run(name);
}

// --- blocked_companies (FR-4) ---

/**
 * Add a company to the blocklist (idempotent). Optionally also removes any of
 * its jobs still in the decision queue (new/scored) so they do not linger.
 * Returns the number of queued jobs removed.
 */
export function addBlockedCompany(db: DB, name: string): number {
  const normalized = normalizeCompanyName(name);
  if (normalized.length === 0) return 0;
  db.prepare(`INSERT OR IGNORE INTO blocked_companies (name_normalized) VALUES (?)`).run(normalized);

  // One-time cleanup of queued jobs from the newly-blocked company.
  const queued = db
    .prepare(`SELECT id, company FROM jobs WHERE ${statusIn(DECISION_QUEUE_STATUSES)}`)
    .all(...DECISION_QUEUE_STATUSES) as Array<{ id: number; company: string }>;
  const removeStmt = db.prepare(`DELETE FROM jobs WHERE id = ?`);
  let removed = 0;
  for (const job of queued) {
    if (normalizeCompanyName(job.company) === normalized) {
      removeStmt.run(job.id);
      removed += 1;
    }
  }
  return removed;
}

export function removeBlockedCompany(db: DB, name: string): void {
  db.prepare(`DELETE FROM blocked_companies WHERE name_normalized = ?`).run(
    normalizeCompanyName(name),
  );
}

/** All blocked company names (normalized), oldest first. */
export function listBlockedCompanies(db: DB): string[] {
  const rows = db
    .prepare(`SELECT name_normalized FROM blocked_companies ORDER BY id ASC`)
    .all() as Array<{ name_normalized: string }>;
  return rows.map((r) => r.name_normalized);
}

/** True if a (raw or normalized) company name is on the blocklist. */
export function isCompanyBlocked(db: DB, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM blocked_companies WHERE name_normalized = ?`)
    .get(normalizeCompanyName(name));
  return row !== undefined;
}

// --- ai_calls (FR-27) ---

/** Aggregated ledger totals for one call type over a period. */
export interface AiUsageRow {
  callType: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface AiUsageSummary {
  /** Totals per call type since UTC midnight. */
  today: AiUsageRow[];
  /** Totals per call type over the last 7 days. */
  last7Days: AiUsageRow[];
  /**
   * sum(cache_read_tokens) / sum(input_tokens + cache_read_tokens) over the
   * last 7 days, or null when there are no tokens. Near zero while score calls
   * exist means the cached scoring prefix broke (a silent invalidator).
   */
  cacheHitRate7d: number | null;
  /** Successful scoring calls (score + score_batch) in the last 7 days. */
  scoreCalls7d: number;
}

interface AiUsageAggRow {
  call_type: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

/** Per-call-type totals since `datetime('now', modifier)`. Error rows count as
 *  calls but contribute no tokens (their token columns are NULL). */
function aiUsageSince(db: DB, modifier: string): AiUsageRow[] {
  const rows = db
    .prepare(
      `SELECT call_type,
              COUNT(*)                            AS calls,
              COALESCE(SUM(input_tokens), 0)          AS input_tokens,
              COALESCE(SUM(output_tokens), 0)         AS output_tokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
              COALESCE(SUM(cache_read_tokens), 0)     AS cache_read_tokens,
              COALESCE(SUM(cost_usd), 0)              AS cost_usd
         FROM ai_calls
        WHERE created_at >= datetime('now', ?)
        GROUP BY call_type
        ORDER BY call_type`,
    )
    .all(modifier) as AiUsageAggRow[];
  return rows.map((r) => ({
    callType: r.call_type,
    calls: r.calls,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    cacheReadTokens: r.cache_read_tokens,
    costUsd: r.cost_usd,
  }));
}

/** One ledger row for the /usage page, with the job's identity joined in. */
export interface AiCallRow {
  id: number;
  callType: string;
  model: string;
  jobId: number | null;
  /** Company/title of the job the call belongs to; null when the call had no
   *  job or the job row was since deleted (job_id is ON DELETE SET NULL). */
  jobCompany: string | null;
  jobTitle: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  stopReason: string | null;
  error: string | null;
  createdAt: string;
}

interface AiCallDbRow {
  id: number;
  call_type: string;
  model: string;
  job_id: number | null;
  job_company: string | null;
  job_title: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  stop_reason: string | null;
  error: string | null;
  created_at: string;
}

/** The most recent AI calls, newest first — the /usage ledger view (FR-27). */
export function listAiCalls(db: DB, limit = 200): AiCallRow[] {
  const rows = db
    .prepare(
      `SELECT c.*, j.company AS job_company, j.title AS job_title
         FROM ai_calls c
         LEFT JOIN jobs j ON j.id = c.job_id
        ORDER BY c.id DESC
        LIMIT ?`,
    )
    .all(limit) as AiCallDbRow[];
  return rows.map((r) => ({
    id: r.id,
    callType: r.call_type,
    model: r.model,
    jobId: r.job_id,
    jobCompany: r.job_company,
    jobTitle: r.job_title,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    cacheReadTokens: r.cache_read_tokens,
    costUsd: r.cost_usd,
    latencyMs: r.latency_ms,
    stopReason: r.stop_reason,
    error: r.error,
    createdAt: r.created_at,
  }));
}

/** The dashboard's AI-usage readout: today/7-day totals + cache health (FR-27). */
export function listAiUsageSummary(db: DB): AiUsageSummary {
  // Cache health is an Anthropic concern: local Ollama rows carry no billed
  // cache and would otherwise dilute the hit rate to a permanent false alarm
  // once local scoring is the default (FR-6), so the metric is scoped to
  // Anthropic model ids.
  const cache = db
    .prepare(
      `SELECT COALESCE(SUM(cache_read_tokens), 0) AS reads,
              COALESCE(SUM(input_tokens), 0)      AS inputs,
              SUM(CASE WHEN call_type IN ('score', 'score_batch') AND error IS NULL
                       THEN 1 ELSE 0 END)         AS score_calls
         FROM ai_calls
        WHERE created_at >= datetime('now', '-7 days')
          AND model LIKE 'claude-%'`,
    )
    .get() as { reads: number; inputs: number; score_calls: number | null };
  const denominator = cache.inputs + cache.reads;
  return {
    today: aiUsageSince(db, 'start of day'),
    last7Days: aiUsageSince(db, '-7 days'),
    cacheHitRate7d: denominator > 0 ? cache.reads / denominator : null,
    scoreCalls7d: cache.score_calls ?? 0,
  };
}
