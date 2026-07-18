/**
 * One-off cost test: sample 100 random already-scraped jobs in an ISOLATED COPY
 * of the database, reset them to unscored, and score them for real, then report
 * the measured cost from the copy's ai_calls ledger and delete the copy. The
 * real jobs.db is opened read-only and never written.
 * Run: npx tsx scripts/test-100-scoring.mts
 * Delete this file once the question is settled.
 */
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '../lib/db';
import { runScoring } from '../lib/scoring/run';

// Minimal .env.local loader (no dotenv in deps)
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const REAL_DB = process.env.JOBFINDER_DB_PATH!;
const TEMP_DB = join(tmpdir(), 'jobfinder-test-run.db');
const TARGET = 100;

function cleanupTemp(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(TEMP_DB + suffix, { force: true });
    } catch {}
  }
}

async function main(): Promise<void> {
  // Snapshot the real ledger so we can prove the test spent nothing through it.
  const real = new Database(REAL_DB, { readonly: true });
  const realCallsBefore = (
    real.prepare('SELECT count(*) n FROM ai_calls').get() as { n: number }
  ).n;
  cleanupTemp();
  real.prepare('VACUUM INTO ?').run(TEMP_DB); // WAL-safe consistent copy
  real.close();

  const db = openDatabase(TEMP_DB);
  try {
    // Empty the copy's bookkeeping tables (keep jobs — we sample from them, and
    // user_config + blocked_companies so prompts/resume/filters are the real ones).
    db.pragma('foreign_keys = OFF');
    for (const t of [
      'resume_changes',
      'rewritten_latex_versions',
      'command_history',
      'ai_calls',
      'scrape_sessions',
    ]) {
      db.exec(`DELETE FROM ${t}`);
    }
    db.pragma('foreign_keys = ON');

    // --- Sample TARGET random real jobs and reset them to unscored ---
    // (Scraping fresh ones hits LinkedIn's IP rate limit; the cost test only
    // needs realistic postings, and the copy already holds ~1.6k of them.)
    db.exec(`
      DELETE FROM jobs WHERE id NOT IN (
        SELECT id FROM jobs
         WHERE description IS NOT NULL AND length(description) > 200
         ORDER BY random() LIMIT ${TARGET}
      );
      UPDATE jobs SET status = 'new', score = NULL, score_reason = NULL, below_threshold = 0;
    `);
    const sampled = (db.prepare('SELECT count(*) n FROM jobs').get() as { n: number }).n;
    console.log(`[sample] ${sampled} random jobs reset to 'new'`);

    // --- Score them all through the real interactive path (real API calls) ---
    console.log('[score] starting');
    let done = 0;
    const summary = await runScoring(db, {
      onScore: () => {
        done += 1;
        if (done % 10 === 0) console.log(`[score] ${done} scored`);
      },
      onError: (jobId, msg) => console.log(`[score] job ${jobId} FAILED: ${msg}`),
    });
    console.log(
      `[score] done — scored=${summary.scored} failed=${summary.failed.length} titleFiltered=${summary.titleFiltered}`,
    );

    // --- Measured cost from the isolated ledger ---
    const ledger = db
      .prepare(
        `SELECT count(*) n, sum(input_tokens) inp, sum(output_tokens) out,
                sum(cache_read_tokens) cr, sum(cache_creation_tokens) cw,
                round(sum(cost_usd), 4) cost
           FROM ai_calls`,
      )
      .get() as { n: number; inp: number; out: number; cr: number; cw: number; cost: number };
    const hitRate = ledger.cr / (ledger.inp + ledger.cr);
    console.log('\n=== MEASURED RESULT (isolated ledger) ===');
    console.log(`calls:               ${ledger.n}`);
    console.log(`input tokens:        ${ledger.inp}`);
    console.log(`output tokens:       ${ledger.out}`);
    console.log(`cache read tokens:   ${ledger.cr}`);
    console.log(`cache write tokens:  ${ledger.cw}`);
    console.log(`cache hit rate:      ${(hitRate * 100).toFixed(1)}%`);
    console.log(`estimated cost:      $${ledger.cost}`);
    console.log(`per scored job:      $${(ledger.cost / Math.max(1, ledger.n)).toFixed(5)}`);

    // --- Prove the real DB saw nothing ---
    const realAfter = new Database(REAL_DB, { readonly: true });
    const realCallsAfter = (
      realAfter.prepare('SELECT count(*) n FROM ai_calls').get() as { n: number }
    ).n;
    realAfter.close();
    console.log(
      `\nreal DB ai_calls rows before/after: ${realCallsBefore} → ${realCallsAfter} (${
        realCallsAfter === realCallsBefore ? 'untouched ✓' : 'CHANGED — a scheduled run fired!'
      })`,
    );
  } finally {
    db.close();
    cleanupTemp();
    console.log('temp DB deleted — nothing persisted.');
  }
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  cleanupTemp();
  process.exit(1);
});
