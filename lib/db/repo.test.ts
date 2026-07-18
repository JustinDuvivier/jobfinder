import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from './index';
import * as repo from './repo';
import { CONFIG as BASE_CONFIG } from '../test-fixtures';
import { JOB_STATUSES } from '../types';
import type { JobStatus, UserConfig } from '../types';
import { DECISION_QUEUE_STATUSES, TRACKER_STATUSES } from '../status/transitions';
import type { DiffBlock } from '../diff';

let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
});

const CONFIG: UserConfig = {
  ...BASE_CONFIG,
  resumeLatex: '\\documentclass{article}',
  keywords: ['AI Engineer', 'ML Engineer'],
  locations: ['New York', 'New Jersey'],
  runIntervalMinutes: 30,
};

describe('user_config', () => {
  it('returns undefined before Setup is saved', () => {
    expect(repo.getUserConfig(db)).toBeUndefined();
  });

  it('round-trips config including keyword/location arrays', () => {
    repo.upsertUserConfig(db, CONFIG);
    expect(repo.getUserConfig(db)).toEqual(CONFIG);
  });

  it('round-trips greenhouseEnabled as a boolean (true persists, default is false)', () => {
    repo.upsertUserConfig(db, { ...CONFIG, greenhouseEnabled: true });
    expect(repo.getUserConfig(db)!.greenhouseEnabled).toBe(true);

    repo.upsertUserConfig(db, { ...CONFIG, greenhouseEnabled: false });
    expect(repo.getUserConfig(db)!.greenhouseEnabled).toBe(false);
  });

  it('updates the existing row rather than inserting a second', () => {
    repo.upsertUserConfig(db, CONFIG);
    repo.upsertUserConfig(db, { ...CONFIG, ownerName: 'New_Name', keywords: ['Solutions Engineer'] });
    const config = repo.getUserConfig(db)!;
    expect(config.ownerName).toBe('New_Name');
    expect(config.keywords).toEqual(['Solutions Engineer']);
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM user_config`).get() as { n: number }).n;
    expect(count).toBe(1);
  });
});

describe('blocked_companies', () => {
  it('adds, lists (normalized), checks, and removes', () => {
    repo.addBlockedCompany(db, '  Staffing   Agency  Inc ');
    expect(repo.listBlockedCompanies(db)).toEqual(['staffing agency inc']);
    expect(repo.isCompanyBlocked(db, 'STAFFING agency inc')).toBe(true);
    expect(repo.isCompanyBlocked(db, 'Other Co')).toBe(false);

    repo.removeBlockedCompany(db, 'Staffing Agency Inc');
    expect(repo.listBlockedCompanies(db)).toEqual([]);
  });

  it('is idempotent on re-adding the same company', () => {
    repo.addBlockedCompany(db, 'Acme');
    repo.addBlockedCompany(db, 'acme');
    expect(repo.listBlockedCompanies(db)).toEqual(['acme']);
  });

  it('removes the newly-blocked company’s queued jobs (new/scored) only', () => {
    const insert = db.prepare(
      `INSERT INTO jobs (job_id, company, title, url, status) VALUES (?, ?, 'T', 'u', ?)`,
    );
    insert.run('j1', 'Acme', 'new');
    insert.run('j2', 'Acme Corp', 'scored'); // different normalized name — kept
    insert.run('j3', 'Acme', 'applied'); // not in the queue — kept
    insert.run('j4', 'acme', 'scored'); // same normalized name — removed

    const removed = repo.addBlockedCompany(db, 'Acme');
    expect(removed).toBe(2); // j1 and j4

    const remaining = (
      db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }
    ).n;
    expect(remaining).toBe(2); // j2, j3
  });
});

describe('deleteJob', () => {
  it('removes a single job by id and leaves the rest', () => {
    const insert = db.prepare(
      `INSERT INTO jobs (job_id, company, title, url, status) VALUES (?, ?, 'T', 'u', 'new')`,
    );
    insert.run('j1', 'Acme');
    insert.run('j2', 'Beta');
    const target = repo.getJobByJobId(db, 'j1')!;

    repo.deleteJob(db, target.id);

    expect(repo.getJobByJobId(db, 'j1')).toBeUndefined();
    expect(repo.getJobByJobId(db, 'j2')).toBeDefined();
  });
});

describe('resume_changes (replaceResumeChanges / getResumeChanges)', () => {
  const BLOCKS: DiffBlock[] = [
    { blockType: 'equal', content: '\\section{Skills} ', seq: 0 },
    { blockType: 'delete', content: 'Java', seq: 1 },
    { blockType: 'insert', content: 'TypeScript', seq: 2 },
  ];

  function insertJob(jobId: string): number {
    const result = db
      .prepare(
        `INSERT INTO jobs (job_id, company, title, url, status) VALUES (?, 'Acme', 'T', 'u', 'rewriting')`,
      )
      .run(jobId);
    return Number(result.lastInsertRowid);
  }

  it('returns an empty array for a job with no stored diff', () => {
    const id = insertJob('r1');
    expect(repo.getResumeChanges(db, id)).toEqual([]);
  });

  it('round-trips the diff blocks', () => {
    const id = insertJob('r1');
    repo.replaceResumeChanges(db, id, BLOCKS);
    expect(repo.getResumeChanges(db, id)).toEqual(BLOCKS);
  });

  it('reads blocks back in seq order regardless of insertion order', () => {
    const id = insertJob('r1');
    repo.replaceResumeChanges(db, id, [BLOCKS[2], BLOCKS[0], BLOCKS[1]]);
    expect(repo.getResumeChanges(db, id).map((b) => b.seq)).toEqual([0, 1, 2]);
  });

  it('replaces the previous diff instead of appending (regenerate)', () => {
    const id = insertJob('r1');
    repo.replaceResumeChanges(db, id, BLOCKS);
    const regenerated: DiffBlock[] = [{ blockType: 'equal', content: 'unchanged', seq: 0 }];
    repo.replaceResumeChanges(db, id, regenerated);
    expect(repo.getResumeChanges(db, id)).toEqual(regenerated);
  });

  it('keeps diffs isolated per job', () => {
    const a = insertJob('r1');
    const b = insertJob('r2');
    repo.replaceResumeChanges(db, a, BLOCKS);
    expect(repo.getResumeChanges(db, b)).toEqual([]);
  });

  it('cascades away when the job is deleted', () => {
    const id = insertJob('r1');
    repo.replaceResumeChanges(db, id, BLOCKS);
    repo.deleteJob(db, id);
    const orphans = (
      db.prepare(`SELECT COUNT(*) AS n FROM resume_changes WHERE job_id = ?`).get(id) as {
        n: number;
      }
    ).n;
    expect(orphans).toBe(0);
  });
});

describe('setExplanation', () => {
  function insertJob(): number {
    const result = db
      .prepare(
        `INSERT INTO jobs (job_id, company, title, url, status) VALUES ('e1', 'Acme', 'T', 'u', 'rewriting')`,
      )
      .run();
    return Number(result.lastInsertRowid);
  }

  it('stores the explanation JSON on the job', () => {
    const id = insertJob();
    const json = JSON.stringify({ summary: 's', bullets: ['b'] });
    repo.setExplanation(db, id, json);
    expect(repo.getJobById(db, id)!.explanation).toBe(json);
  });

  it('clears the explanation when given null', () => {
    const id = insertJob();
    repo.setExplanation(db, id, JSON.stringify({ summary: 's', bullets: [] }));
    repo.setExplanation(db, id, null);
    expect(repo.getJobById(db, id)!.explanation).toBeNull();
  });
});

describe('listAllJobs', () => {
  it('returns every job grouped by company (case-insensitive), newest first within a company', () => {
    const insert = db.prepare(
      `INSERT INTO jobs (job_id, company, title, url, status) VALUES (?, ?, ?, 'u', ?)`,
    );
    insert.run('a1', 'beta corp', 'Older', 'applied');
    insert.run('a2', 'Beta Corp', 'Newer', 'new');
    insert.run('a3', 'Acme', 'Solo', 'scored');

    const all = repo.listAllJobs(db);
    // Acme sorts first; the two Beta rows group together (case-insensitive) with
    // the newest (higher id) first — so 'Beta Corp' (Newer) precedes 'beta corp'.
    expect(all.map((j) => j.company)).toEqual(['Acme', 'Beta Corp', 'beta corp']);
    const beta = all.filter((j) => j.company.toLowerCase() === 'beta corp');
    expect(beta.map((j) => j.title)).toEqual(['Newer', 'Older']);
  });

  it('returns an empty array when there are no jobs', () => {
    expect(repo.listAllJobs(db)).toEqual([]);
  });
});

describe('listRewriteQueue', () => {
  it('returns only rewriting jobs, oldest-first by id', () => {
    const insert = db.prepare(
      `INSERT INTO jobs (job_id, company, title, url, status) VALUES (?, ?, ?, 'u', ?)`,
    );
    insert.run('r1', 'Acme', 'First', 'rewriting');
    insert.run('x1', 'Acme', 'Approved', 'approved'); // excluded
    insert.run('r2', 'Beta', 'Second', 'rewriting');
    insert.run('n1', 'Gamma', 'New', 'new'); // excluded

    const queue = repo.listRewriteQueue(db);
    expect(queue.map((j) => j.title)).toEqual(['First', 'Second']);
    expect(queue.every((j) => j.status === 'rewriting')).toBe(true);
  });

  it('returns an empty array when nothing is being rewritten', () => {
    expect(repo.listRewriteQueue(db)).toEqual([]);
  });
});

describe('getLastScrapeEndedAt', () => {
  it('returns null when no scrape has ever run', () => {
    expect(repo.getLastScrapeEndedAt(db)).toBeNull();
  });

  it('returns null when the only session is still running (no ended_at)', () => {
    db.prepare(`INSERT INTO scrape_sessions (strategy, status) VALUES ('demo','running')`).run();
    expect(repo.getLastScrapeEndedAt(db)).toBeNull();
  });

  it('returns the most recent ended_at as UTC epoch ms, across outcomes', () => {
    const insert = db.prepare(
      `INSERT INTO scrape_sessions (strategy, status, ended_at) VALUES ('demo', ?, ?)`,
    );
    insert.run('completed', '2026-07-01 10:00:00');
    insert.run('failed', '2026-07-02 08:30:00'); // latest — failed runs still count
    insert.run('completed', '2026-06-30 23:59:59');

    expect(repo.getLastScrapeEndedAt(db)).toBe(Date.parse('2026-07-02T08:30:00Z'));
  });
});

describe('resetPipeline', () => {
  it('wipes all jobs and scrape sessions but keeps config and the blocklist', () => {
    repo.upsertUserConfig(db, CONFIG);
    repo.addBlockedCompany(db, 'Acme');
    const insert = db.prepare(
      `INSERT INTO jobs (job_id, company, title, url, status) VALUES (?, 'C', 'T', 'u', ?)`,
    );
    insert.run('j1', 'new');
    insert.run('j2', 'applied');
    db.prepare(`INSERT INTO scrape_sessions (strategy, status) VALUES ('demo','completed')`).run();

    const deleted = repo.resetPipeline(db);
    expect(deleted).toBe(2);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n).toBe(0);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM scrape_sessions`).get() as { n: number }).n,
    ).toBe(0);
    // Preserved.
    expect(repo.getUserConfig(db)).toEqual(CONFIG);
    expect(repo.listBlockedCompanies(db)).toEqual(['acme']);
  });

  it('cascades to a job’s rewrite versions and command history', () => {
    const jobId = repo.insertJob(db, {
      jobId: 'jx',
      company: 'C',
      title: 'T',
      location: null,
      salary: null,
      description: null,
      url: 'u',
      postedAt: null,
      seniorityLevel: null,
      employmentType: null,
      jobFunction: null,
      industries: null,
      applicants: null,
    });
    db.prepare(
      `INSERT INTO rewritten_latex_versions (job_id, content, source_type) VALUES (?, 'x', 'autosave')`,
    ).run(jobId);
    db.prepare(
      `INSERT INTO command_history (command_type, job_id, previous_status, new_status) VALUES ('PassJob', ?, 'scored', 'passed')`,
    ).run(jobId);

    repo.resetPipeline(db);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM rewritten_latex_versions`).get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM command_history`).get() as { n: number }).n,
    ).toBe(0);
  });
});

describe('status-set queries follow the named sets from the status module', () => {
  beforeEach(() => {
    const insert = db.prepare(
      `INSERT INTO jobs (job_id, company, title, url, status) VALUES (?, 'C', 'T', 'u', ?)`,
    );
    for (const status of JOB_STATUSES) insert.run(`st-${status}`, status);
  });

  it('listDecisionQueue returns exactly the DECISION_QUEUE_STATUSES jobs', () => {
    expect(repo.listDecisionQueue(db).map((j) => j.status).sort()).toEqual(
      [...DECISION_QUEUE_STATUSES].sort(),
    );
  });

  it('listTrackerJobs returns exactly the TRACKER_STATUSES jobs', () => {
    expect(repo.listTrackerJobs(db).map((j) => j.status).sort()).toEqual(
      [...TRACKER_STATUSES].sort(),
    );
  });

  it('clearDecisionQueue deletes exactly the DECISION_QUEUE_STATUSES jobs, and reports the count', () => {
    expect(repo.clearDecisionQueue(db)).toBe(DECISION_QUEUE_STATUSES.length);
    const remaining = repo.listAllJobs(db).map((j) => j.status);
    for (const status of DECISION_QUEUE_STATUSES) expect(remaining).not.toContain(status);
    expect(remaining).toHaveLength(JOB_STATUSES.length - DECISION_QUEUE_STATUSES.length);
    // Second sweep finds nothing left to clear.
    expect(repo.clearDecisionQueue(db)).toBe(0);
  });

  it('setScore only rescores jobs still in the decision queue', () => {
    const rows = db.prepare(`SELECT id, status FROM jobs`).all() as Array<{
      id: number;
      status: JobStatus;
    }>;
    for (const row of rows) repo.setScore(db, row.id, 55, 'r');
    for (const row of rows) {
      const job = repo.getJobById(db, row.id)!;
      if (DECISION_QUEUE_STATUSES.includes(row.status)) {
        expect(job.status).toBe('scored');
        expect(job.score).toBe(55);
      } else {
        // Past triage: untouched, never reset to scored.
        expect(job.status).toBe(row.status);
        expect(job.score).toBeNull();
      }
    }
  });

  it('addBlockedCompany removes only the decision-queue jobs of that company', () => {
    expect(repo.addBlockedCompany(db, 'C')).toBe(DECISION_QUEUE_STATUSES.length);
    const remaining = repo.listAllJobs(db).map((j) => j.status);
    expect(new Set(remaining)).toEqual(
      new Set(JOB_STATUSES.filter((s) => !DECISION_QUEUE_STATUSES.includes(s))),
    );
  });
});

describe('setScore + auto-filter flag (FR-9a)', () => {
  function seed(jobId: string): number {
    return repo.insertJob(db, {
      jobId,
      company: 'C',
      title: 'T',
      location: null,
      salary: null,
      description: null,
      url: 'u',
      postedAt: null,
      seniorityLevel: null,
      employmentType: null,
      jobFunction: null,
      industries: null,
      applicants: null,
    });
  }

  it('records the score, moves new → scored, and defaults the flag off', () => {
    const id = seed('s1');
    repo.setScore(db, id, 82, 'great fit');
    const job = repo.getJobById(db, id)!;
    expect(job.status).toBe('scored');
    expect(job.score).toBe(82);
    expect(job.belowThreshold).toBe(false);
  });

  it('sets below_threshold when flagged, and the flag round-trips as a boolean', () => {
    const id = seed('s2');
    repo.setScore(db, id, 31, 'weak fit', true);
    const job = repo.getJobById(db, id)!;
    expect(job.score).toBe(31);
    expect(job.status).toBe('scored');
    expect(job.belowThreshold).toBe(true);
  });

  it('excludes flagged jobs from the decision queue but keeps them in listAllJobs', () => {
    const keep = seed('keep');
    const hide = seed('hide');
    repo.setScore(db, keep, 80, 'strong'); // unflagged → in queue
    repo.setScore(db, hide, 20, 'weak', true); // flagged → out of queue

    const queue = repo.listDecisionQueue(db);
    expect(queue.map((j) => j.jobId)).toEqual(['keep']);

    // Still present as data for analytics/Companies.
    expect(repo.listAllJobs(db).map((j) => j.jobId).sort()).toEqual(['hide', 'keep']);
  });

  it('keeps a brand-new (unscored) job in the queue — the flag only applies once scored', () => {
    seed('fresh'); // status 'new', below_threshold 0
    expect(repo.listDecisionQueue(db).map((j) => j.jobId)).toEqual(['fresh']);
  });
});

describe('setSalary', () => {
  function seed(): number {
    return repo.insertJob(db, {
      jobId: 'sal1',
      company: 'C',
      title: 'T',
      location: null,
      salary: null,
      description: null,
      url: 'u',
      postedAt: null,
      seniorityLevel: null,
      employmentType: null,
      jobFunction: null,
      industries: null,
      applicants: null,
    });
  }

  it('stores a manually entered salary', () => {
    const id = seed();
    repo.setSalary(db, id, '$120k–150k');
    expect(repo.getJobById(db, id)!.salary).toBe('$120k–150k');
  });

  it('clears the salary when given null', () => {
    const id = seed();
    repo.setSalary(db, id, '$120k');
    repo.setSalary(db, id, null);
    expect(repo.getJobById(db, id)!.salary).toBeNull();
  });
});

describe('insertJob source provenance', () => {
  const JOB = {
    jobId: 'src1',
    company: 'C',
    title: 'T',
    location: null,
    salary: null,
    description: null,
    url: 'u',
    postedAt: null,
    seniorityLevel: null,
    employmentType: null,
    jobFunction: null,
    industries: null,
    applicants: null,
  };

  it("defaults source to 'linkedin' when the caller omits it", () => {
    const id = repo.insertJob(db, JOB);
    expect(repo.getJobById(db, id)!.source).toBe('linkedin');
  });

  it("persists an explicit 'greenhouse' source and reads it back", () => {
    const id = repo.insertJob(db, { ...JOB, jobId: 'src2' }, 'greenhouse');
    expect(repo.getJobById(db, id)!.source).toBe('greenhouse');
  });

  it('mapJobRow surfaces the source column on the domain type', () => {
    repo.insertJob(db, { ...JOB, jobId: 'src3' }, 'greenhouse');
    const job = repo.getJobByJobId(db, 'src3')!;
    expect(job.source).toBe('greenhouse');
  });
});

describe('listAiUsageSummary (FR-27)', () => {
  /** Seed one ai_calls row at a relative time, e.g. ageModifier '-2 days'. */
  function seedCall(
    callType: string,
    opts: {
      ageModifier?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      costUsd?: number;
      error?: string;
      model?: string;
    } = {},
  ): void {
    db.prepare(
      `INSERT INTO ai_calls
         (call_type, model, input_tokens, output_tokens, cache_creation_tokens,
          cache_read_tokens, cost_usd, error, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, datetime('now', ?))`,
    ).run(
      callType,
      opts.model ?? 'claude-haiku-4-5-20251001',
      opts.error ? null : (opts.inputTokens ?? 0),
      opts.error ? null : (opts.outputTokens ?? 0),
      opts.error ? null : (opts.cacheReadTokens ?? 0),
      opts.error ? null : (opts.costUsd ?? 0),
      opts.error ?? null,
      opts.ageModifier ?? '-1 minute',
    );
  }

  it('returns empty periods and a null cache rate on an empty ledger', () => {
    expect(repo.listAiUsageSummary(db)).toEqual({
      today: [],
      last7Days: [],
      cacheHitRate7d: null,
      scoreCalls7d: 0,
    });
  });

  it('groups 7-day totals by call type and excludes older rows', () => {
    seedCall('score', { inputTokens: 500, outputTokens: 200, costUsd: 0.001 });
    seedCall('score', { inputTokens: 300, outputTokens: 100, costUsd: 0.0005, ageModifier: '-2 days' });
    seedCall('rewrite', { inputTokens: 1000, outputTokens: 2000, costUsd: 0.03 });
    seedCall('score', { inputTokens: 999, outputTokens: 999, ageModifier: '-8 days' }); // outside window

    const summary = repo.listAiUsageSummary(db);
    expect(summary.last7Days).toEqual([
      {
        callType: 'rewrite',
        calls: 1,
        inputTokens: 1000,
        outputTokens: 2000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.03,
      },
      {
        callType: 'score',
        calls: 2,
        inputTokens: 800,
        outputTokens: 300,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        costUsd: expect.closeTo(0.0015, 10),
      },
    ]);
  });

  it('limits "today" to rows since UTC midnight', () => {
    seedCall('score', { inputTokens: 500 });
    seedCall('score', { inputTokens: 300, ageModifier: '-2 days' });

    const summary = repo.listAiUsageSummary(db);
    expect(summary.today).toHaveLength(1);
    expect(summary.today[0].inputTokens).toBe(500);
    expect(summary.last7Days[0].calls).toBe(2);
  });

  it('computes the cache hit rate as reads / (inputs + reads) over 7 days', () => {
    seedCall('score', { inputTokens: 200, cacheReadTokens: 3800 });
    seedCall('score', { inputTokens: 200, cacheReadTokens: 3800 });

    const summary = repo.listAiUsageSummary(db);
    expect(summary.cacheHitRate7d).toBeCloseTo(7600 / 8000, 10);
    expect(summary.scoreCalls7d).toBe(2);
  });

  it('scopes cache health to Anthropic models: local rows never dilute the rate', () => {
    // One warm Anthropic score plus a cacheless local score (FR-6 default):
    // the rate must stay the Anthropic row's own, or the cold-cache warning
    // would fire permanently once local scoring is the default.
    seedCall('score', { inputTokens: 200, cacheReadTokens: 3800 });
    seedCall('score', { inputTokens: 5500, model: 'batiai/qwen3.6-27b:iq3' });

    const summary = repo.listAiUsageSummary(db);
    expect(summary.cacheHitRate7d).toBeCloseTo(3800 / 4000, 10);
    expect(summary.scoreCalls7d).toBe(1); // the Anthropic score only
  });

  it('reports no cache signal at all for an all-local week (warning suppressed)', () => {
    seedCall('score', { inputTokens: 5500, model: 'batiai/qwen3.6-27b:iq3' });
    seedCall('score', { inputTokens: 5300, model: 'batiai/qwen3.6-27b:iq3' });

    const summary = repo.listAiUsageSummary(db);
    expect(summary.cacheHitRate7d).toBeNull();
    expect(summary.scoreCalls7d).toBe(0);
  });

  it('counts error rows as calls but not toward tokens or score-call health', () => {
    seedCall('score', { error: 'rate limited' });
    seedCall('score_batch', { inputTokens: 100, cacheReadTokens: 400 });
    seedCall('salary', { inputTokens: 50 });

    const summary = repo.listAiUsageSummary(db);
    const score = summary.last7Days.find((r) => r.callType === 'score')!;
    expect(score.calls).toBe(1);
    expect(score.inputTokens).toBe(0);
    expect(summary.scoreCalls7d).toBe(1); // the successful batch call only
  });
});

describe('listAiCalls (FR-27)', () => {
  function seedCall(callType: string, jobId: number | null, costUsd: number | null): number {
    return Number(
      db
        .prepare(
          `INSERT INTO ai_calls (call_type, model, job_id, input_tokens, output_tokens, cost_usd)
           VALUES (?, 'claude-haiku-4-5-20251001', ?, 500, 200, ?)`,
        )
        .run(callType, jobId, costUsd).lastInsertRowid,
    );
  }

  function seedJob(jobId: string): number {
    return Number(
      db
        .prepare(`INSERT INTO jobs (job_id, company, title, url) VALUES (?, 'Acme', 'AI Engineer', 'u')`)
        .run(jobId).lastInsertRowid,
    );
  }

  it('returns calls newest first with the job identity joined in', () => {
    const jobId = seedJob('j1');
    seedCall('score', jobId, 0.001);
    seedCall('rewrite', jobId, 0.03);

    const calls = repo.listAiCalls(db);
    expect(calls.map((c) => c.callType)).toEqual(['rewrite', 'score']);
    expect(calls[0]).toMatchObject({
      jobId,
      jobCompany: 'Acme',
      jobTitle: 'AI Engineer',
      inputTokens: 500,
      outputTokens: 200,
      costUsd: 0.03,
    });
    expect(calls[0].createdAt).toBeTruthy();
  });

  it('keeps rows whose job is gone (job fields null)', () => {
    const jobId = seedJob('j1');
    seedCall('score', jobId, 0.001);
    db.prepare(`DELETE FROM jobs WHERE id = ?`).run(jobId);

    const calls = repo.listAiCalls(db);
    expect(calls).toHaveLength(1);
    expect(calls[0].jobId).toBeNull();
    expect(calls[0].jobCompany).toBeNull();
  });

  it('honors the limit', () => {
    const jobId = seedJob('j1');
    for (let i = 0; i < 5; i++) seedCall('score', jobId, 0.001);
    expect(repo.listAiCalls(db, 3)).toHaveLength(3);
  });
});
