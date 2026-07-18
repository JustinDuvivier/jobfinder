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
/** Add columns introduced after a database was first created (idempotent). */
export function migrate(db: DB): void {
  const adder = (table: string) => {
    const existing = (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    return (name: string, ddl: string): void => {
      if (!existing.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };
  };

  const addConfig = adder('user_config');
  addConfig('scoring_prompt', `scoring_prompt TEXT NOT NULL DEFAULT ''`);
  addConfig('rewrite_rules', `rewrite_rules TEXT NOT NULL DEFAULT ''`);
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
      'JOBFINDER_DB_PATH is not set. Copy .env.local.example to .env.local and set it.',
    );
  }
  singleton = openDatabase(path);
  return singleton;
}
