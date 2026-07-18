/**
 * The single SQLite client. better-sqlite3 is synchronous and in-process — the
 * right fit for a single-user local tool with one writer (the Next.js server).
 *
 * `getDb()` returns a process-wide singleton opened from JOBFINDER_DB_PATH,
 * applying the schema and running startup reconciliation on first open.
 * `openDatabase()` is the lower-level factory used by tests (e.g. with
 * ':memory:') so they never touch the real database file.
 *
 * See jobfinder-docs.md "Database — SQLite", "Local Dev Setup", and the
 * resilience requirement NFR-8 (interrupted background work is reconciled).
 */
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema';

export type DB = Database.Database;

/** Apply the schema. Idempotent — safe on an existing database. */
export function applySchema(db: DB): void {
  db.exec(SCHEMA_SQL);
}

/**
 * Reconcile scrape sessions interrupted by a process death (NFR-8). Any run
 * left 'running' when the process last died is marked 'failed' so the Jobs view
 * never shows "Scraping in progress…" forever. Returns the number reconciled.
 */
export function reconcileInterruptedScrapes(db: DB): number {
  const result = db
    .prepare(
      `UPDATE scrape_sessions
          SET status = 'failed',
              error = 'interrupted by restart',
              ended_at = datetime('now'),
              updated_at = datetime('now')
        WHERE status = 'running'`,
    )
    .run();
  return result.changes;
}

/**
 * Open a database at `path`, apply the schema, and reconcile interrupted
 * scrapes. Use ':memory:' in tests. Foreign keys are enforced (the schema sets
 * the pragma, and we set it again here defensively per-connection).
 */
/** The pre-FR-33 user_config columns that held resume assets, and the
 *  resume_assets row each one's content moves to. */
const LEGACY_ASSET_COLUMNS: ReadonlyArray<[column: string, asset: string]> = [
  ['resume_latex', 'base_resume'],
  ['source_of_truth', 'source_of_truth'],
  ['scoring_prompt', 'scoring_prompt'],
  ['rewrite_rules', 'rewrite_rules'],
];

/** Add columns introduced after a database was first created (idempotent). */
export function migrate(db: DB): void {
  const columnsOf = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
  const adder = (table: string) => {
    const existing = columnsOf(table);
    return (name: string, ddl: string): void => {
      if (!existing.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };
  };

  const configColumns = columnsOf('user_config');
  const addConfig = adder('user_config');
  addConfig('run_interval_minutes', `run_interval_minutes INTEGER NOT NULL DEFAULT 0`);
  addConfig('search_lookback_hours', `search_lookback_hours INTEGER NOT NULL DEFAULT 1`);
  addConfig('score_threshold', `score_threshold INTEGER NOT NULL DEFAULT 50`);
  addConfig(
    'excluded_title_terms',
    `excluded_title_terms TEXT NOT NULL DEFAULT '["senior","sr","staff","principal","lead","manager","director","head of","vp","chief","scientist"]'`,
  );
  // CHECK constraints can't be added via ALTER (see below_threshold below);
  // parseUserConfig validates the backend value for already-created databases.
  addConfig('scoring_backend', `scoring_backend TEXT NOT NULL DEFAULT 'ollama'`);
  addConfig('ollama_model', `ollama_model TEXT NOT NULL DEFAULT 'qwen3:4b-instruct-2507-q4_K_M'`);
  // CHECK omitted for ALTER (as above); the column default + app-level 0/1 writes
  // keep it well-formed on already-created databases.
  addConfig('greenhouse_enabled', `greenhouse_enabled INTEGER NOT NULL DEFAULT 0`);
  // FR-33 onboarding flag. A database that predates the column belongs to a
  // user who already ran the app, so grandfather them past the guided flow —
  // the flag defaults to 0 only for genuinely fresh databases.
  if (!configColumns.includes('onboarding_complete')) {
    addConfig('onboarding_complete', `onboarding_complete INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE user_config SET onboarding_complete = 1 WHERE id = 1`);
  }
  // FR-33: move any in-app-authored assets out of the legacy user_config
  // columns into resume_assets, once. ON CONFLICT DO NOTHING keeps an already-
  // migrated (or newly authored) row authoritative; blanking the legacy column
  // afterwards makes the copy one-shot, so a later per-asset revert (row
  // delete) is never resurrected by the next restart.
  for (const [column, asset] of LEGACY_ASSET_COLUMNS) {
    if (!configColumns.includes(column)) continue;
    db.prepare(
      `INSERT INTO resume_assets (name, content)
        SELECT ?, ${column} FROM user_config WHERE id = 1 AND trim(${column}) <> ''
        ON CONFLICT(name) DO NOTHING`,
    ).run(asset);
    db.exec(`UPDATE user_config SET ${column} = '' WHERE id = 1`);
  }

  const addJob = adder('jobs');
  // CHECK constraints can't be added via ALTER; the column default + app-level
  // writes (0/1) keep it well-formed on already-created databases.
  addJob('below_threshold', `below_threshold INTEGER NOT NULL DEFAULT 0`);
  // CHECK constraints can't be added via ALTER; the column default + app-level
  // writes keep it well-formed on already-created databases (the CHECK is only
  // present in fresh schemas). Existing rows backfill to 'linkedin'.
  addJob('source', `source TEXT NOT NULL DEFAULT 'linkedin'`);
  addJob('seniority_level', `seniority_level TEXT`);
  addJob('employment_type', `employment_type TEXT`);
  addJob('job_function', `job_function TEXT`);
  addJob('industries', `industries TEXT`);
  addJob('applicants', `applicants TEXT`);
}

export function openDatabase(path: string): DB {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  applySchema(db);
  migrate(db);
  reconcileInterruptedScrapes(db);
  return db;
}

let singleton: DB | null = null;

/** The process-wide database singleton, opened from JOBFINDER_DB_PATH. */
export function getDb(): DB {
  if (singleton) return singleton;
  const path = process.env.JOBFINDER_DB_PATH;
  if (!path) {
    throw new Error(
      'JOBFINDER_DB_PATH is not set. Add it to .env.local (native) — see the README. The Docker image sets it automatically.',
    );
  }
  singleton = openDatabase(path);
  return singleton;
}
