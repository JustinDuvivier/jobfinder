/**
 * Tests for the scrape execution. Two concerns:
 *
 *  1. Detail-enrichment merge (primary strategy): criteria and applicant fields
 *     persist, the dedicated salary block wins over prose, prose mining runs on
 *     the detail-fetched description (which the pipeline's salary normalizer
 *     never saw), and a failed detail fetch is non-fatal.
 *  2. The two-source run (Greenhouse alongside the primary): both sources flow
 *     through the SAME pipeline into one queue, are deduped across sources, are
 *     tagged with their provenance, get their OWN MAX_JOBS budget, and are
 *     counted per-source; an enabled-but-keyless Greenhouse is surfaced, not run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { CONFIG } from '@/lib/test-fixtures';
import { runScrape } from './run';
import type { ScraperStrategy } from './strategy';
import type { RawJob } from './pipeline';
import type { JobDetail } from './linkedin-parser';

/** Primary-strategy fake state (LinkedIn/demo path). */
const fake: {
  raws: RawJob[];
  details: Record<string, JobDetail | Error>;
  lastMaxCount: number | null;
} = { raws: [], details: {}, lastMaxCount: null };

/** Greenhouse-strategy fake state. */
const ghFake: {
  raws: RawJob[];
  lastMaxCount: number | null;
  lastOptions: unknown;
} = { raws: [], lastMaxCount: null, lastOptions: null };

/** RapidAPI-key gate state, flipped per test. */
const rapid: { hasKey: boolean; key: string | undefined } = { hasKey: true, key: 'test-key' };

vi.mock('@/lib/scrape/strategy', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/scrape/strategy')>();
  const strategy: ScraperStrategy = {
    name: 'demo',
    async *scrape(_config, maxCount) {
      fake.lastMaxCount = maxCount;
      let n = 0;
      for (const raw of fake.raws) {
        if (n >= maxCount) return;
        yield raw;
        n += 1;
      }
    },
    async fetchDetail(jobId: string) {
      const detail = fake.details[jobId] ?? {};
      if (detail instanceof Error) throw detail;
      return detail;
    },
  };
  return { ...original, createStrategy: () => strategy };
});

vi.mock('@/lib/scrape/strategies/greenhouse', () => {
  class GreenhouseStrategy implements ScraperStrategy {
    readonly name = 'greenhouse' as const;
    constructor(options: unknown) {
      ghFake.lastOptions = options;
    }
    async *scrape(_config: unknown, maxCount: number): AsyncIterable<RawJob> {
      ghFake.lastMaxCount = maxCount;
      let n = 0;
      for (const raw of ghFake.raws) {
        if (n >= maxCount) return;
        yield raw;
        n += 1;
      }
    }
    async fetchDetail(): Promise<JobDetail> {
      return {};
    }
  }
  return { GreenhouseStrategy };
});

vi.mock('@/lib/env/rapidapi', () => ({
  hasRapidApiKey: () => rapid.hasKey,
  getRapidApiKey: () => (rapid.hasKey ? rapid.key : undefined),
}));

/** A LinkedIn card (numeric id, LinkedIn view URL). */
function card(jobId: string): RawJob {
  return {
    jobId,
    title: 'ML Engineer',
    company: 'Acme',
    location: 'New York, NY',
    url: `https://www.linkedin.com/jobs/view/${jobId}`,
    postedAt: '2026-07-11',
  };
}

/** A Greenhouse card (gh: namespaced id, real posting URL, complete record). */
function ghCard(id: string, company = 'Globex'): RawJob {
  return {
    jobId: `gh:${id}`,
    title: 'ML Engineer',
    company,
    location: 'Remote',
    url: `https://boards.greenhouse.io/${company.toLowerCase()}/jobs/${id}`,
    postedAt: '2026-07-11',
    description: 'Build models.',
  };
}

let db: DB;

beforeEach(() => {
  db = openDatabase(':memory:');
  fake.raws = [];
  fake.details = {};
  fake.lastMaxCount = null;
  ghFake.raws = [];
  ghFake.lastMaxCount = null;
  ghFake.lastOptions = null;
  rapid.hasKey = true;
  rapid.key = 'test-key';
});

afterEach(() => {
  db.close();
});

describe('runScrape detail enrichment', () => {
  it('persists the criteria fields, applicants, and structured description', async () => {
    fake.raws = [card('100')];
    fake.details['100'] = {
      description: 'About Us\n\n- Ship models\n- Own pipelines',
      seniorityLevel: 'Entry level',
      employmentType: 'Full-time',
      jobFunction: 'Engineering',
      industries: 'Software Development',
      applicants: 'Over 200 applicants',
    };

    const streamed: unknown[] = [];
    await runScrape(db, { onJob: (j) => streamed.push(j) });

    const job = repo.getJobByJobId(db, '100')!;
    expect(job.description).toBe('About Us\n\n- Ship models\n- Own pipelines');
    expect(job.seniorityLevel).toBe('Entry level');
    expect(job.employmentType).toBe('Full-time');
    expect(job.jobFunction).toBe('Engineering');
    expect(job.industries).toBe('Software Development');
    expect(job.applicants).toBe('Over 200 applicants');

    // The SSE payload carries the enrichment too, so freshly scraped rows
    // render their meta line in the queue without a refetch.
    expect(streamed).toHaveLength(1);
    expect(streamed[0]).toMatchObject({
      seniorityLevel: 'Entry level',
      employmentType: 'Full-time',
      jobFunction: 'Engineering',
      industries: 'Software Development',
      applicants: 'Over 200 applicants',
    });
  });

  it('mines the detail description prose for salary when no block exists', async () => {
    fake.raws = [card('200')];
    fake.details['200'] = {
      description: 'Great role. Pay Range: $112,000.00 - $208,000.00 salary per year. Benefits too.',
    };

    await runScrape(db);

    expect(repo.getJobByJobId(db, '200')!.salary).toBe('$112,000 – $208,000');
  });

  it('prefers the dedicated salary block over description prose', async () => {
    fake.raws = [card('300')];
    fake.details['300'] = {
      salary: '$135,000.00/yr - $175,000.00/yr',
      description: 'Compensation: $90,000 - $100,000 per year.',
    };

    await runScrape(db);

    expect(repo.getJobByJobId(db, '300')!.salary).toBe('$135,000 – $175,000');
  });

  it('keeps the card salary field over detail description prose', async () => {
    fake.raws = [{ ...card('350'), salary: '$100k' }];
    fake.details['350'] = { description: 'Compensation: $200,000 - $250,000 per year.' };

    await runScrape(db);

    expect(repo.getJobByJobId(db, '350')!.salary).toBe('$100,000');
  });

  it('leaves the pipeline-resolved salary untouched when the detail adds nothing', async () => {
    fake.raws = [{ ...card('360'), salary: '$120,000/yr - $150,000/yr' }];
    fake.details['360'] = {};

    await runScrape(db);

    expect(repo.getJobByJobId(db, '360')!.salary).toBe('$120,000 – $150,000');
  });

  it('still inserts the card-level job when the detail fetch fails', async () => {
    fake.raws = [card('400')];
    fake.details['400'] = new Error('network down');

    const summary = await runScrape(db);

    expect(summary.inserted).toBe(1);
    const job = repo.getJobByJobId(db, '400')!;
    expect(job.title).toBe('ML Engineer');
    expect(job.description).toBeNull();
  });
});

describe('runScrape primary-only defaults', () => {
  it('records the primary source as linkedin and reports a single-source summary', async () => {
    // No config row → greenhouse defaults off, so only the primary runs.
    fake.raws = [card('100')];

    const summary = await runScrape(db);

    expect(repo.getJobByJobId(db, '100')!.source).toBe('linkedin');
    expect(summary.bySource).toEqual([
      { source: 'linkedin', found: 1, blocked: 0, inserted: 1 },
    ]);
    expect(summary.warnings).toEqual([]);
    expect(summary.found).toBe(1);
    expect(summary.inserted).toBe(1);
  });
});

describe('runScrape two-source (Greenhouse alongside the primary)', () => {
  beforeEach(() => {
    repo.upsertUserConfig(db, { ...CONFIG, greenhouseEnabled: true });
  });

  it('inserts both sources through the same pipeline, each row tagged with its source', async () => {
    fake.raws = [card('100'), card('101')];
    ghFake.raws = [ghCard('200'), ghCard('201')];

    await runScrape(db);

    expect(repo.getJobByJobId(db, '100')!.source).toBe('linkedin');
    expect(repo.getJobByJobId(db, '101')!.source).toBe('linkedin');
    expect(repo.getJobByJobId(db, 'gh:200')!.source).toBe('greenhouse');
    expect(repo.getJobByJobId(db, 'gh:201')!.source).toBe('greenhouse');

    // Greenhouse was constructed with the server-side key and the lookback.
    expect(ghFake.lastOptions).toMatchObject({ apiKey: 'test-key' });
  });

  it('reports per-source counts whose sums equal the top-level totals', async () => {
    repo.addBlockedCompany(db, 'BlockedCo');
    fake.raws = [card('100'), card('101')];
    ghFake.raws = [ghCard('200', 'Globex'), ghCard('201', 'BlockedCo')];

    const summary = await runScrape(db);

    expect(summary.bySource).toEqual([
      { source: 'linkedin', found: 2, blocked: 0, inserted: 2 },
      { source: 'greenhouse', found: 2, blocked: 1, inserted: 1 },
    ]);
    expect(summary.found).toBe(4);
    expect(summary.blocked).toBe(1);
    expect(summary.inserted).toBe(3);
    expect(summary.warnings).toEqual([]);
  });

  it('dedups across sources and never collides a numeric id with a gh: id', async () => {
    // A gh job already in the table is skipped when Greenhouse re-yields it.
    repo.insertJob(
      db,
      {
        jobId: 'gh:300',
        company: 'Globex',
        title: 'ML Engineer',
        location: null,
        salary: null,
        description: null,
        url: 'https://boards.greenhouse.io/globex/jobs/300',
        postedAt: null,
        seniorityLevel: null,
        employmentType: null,
        jobFunction: null,
        industries: null,
        applicants: null,
      },
      'greenhouse',
    );

    fake.raws = [card('300')]; // numeric id '300' — distinct from 'gh:300'
    ghFake.raws = [ghCard('300')]; // 'gh:300' — already present, must be skipped

    const summary = await runScrape(db);

    // The numeric '300' and the namespaced 'gh:300' coexist as separate rows.
    expect(repo.getJobByJobId(db, '300')!.source).toBe('linkedin');
    expect(repo.getJobByJobId(db, 'gh:300')!.source).toBe('greenhouse');
    expect(summary.bySource).toEqual([
      { source: 'linkedin', found: 1, blocked: 0, inserted: 1 },
      { source: 'greenhouse', found: 1, blocked: 0, inserted: 0 },
    ]);
  });

  it('gives each source its own MAX_JOBS budget', async () => {
    // The primary yields more than the budget; Greenhouse still runs its own.
    fake.raws = Array.from({ length: 80 }, (_, i) => card(String(i + 1)));
    ghFake.raws = [ghCard('900'), ghCard('901'), ghCard('902')];

    const summary = await runScrape(db);

    expect(fake.lastMaxCount).toBe(75);
    expect(ghFake.lastMaxCount).toBe(75);
    expect(summary.bySource).toEqual([
      { source: 'linkedin', found: 75, blocked: 0, inserted: 75 },
      { source: 'greenhouse', found: 3, blocked: 0, inserted: 3 },
    ]);
  });

  it('surfaces a warning and skips Greenhouse when the key is missing', async () => {
    rapid.hasKey = false;
    rapid.key = undefined;
    fake.raws = [card('500')];
    ghFake.raws = [ghCard('600')];

    const summary = await runScrape(db);

    // The primary still ran and inserted.
    expect(repo.getJobByJobId(db, '500')!.source).toBe('linkedin');
    // Greenhouse did not run at all.
    expect(repo.getJobByJobId(db, 'gh:600')).toBeUndefined();
    expect(ghFake.lastMaxCount).toBeNull();
    expect(summary.bySource).toEqual([
      { source: 'linkedin', found: 1, blocked: 0, inserted: 1 },
    ]);
    expect(summary.warnings).toContain(
      'Greenhouse is enabled but RAPID_API_KEY is not set — skipped.',
    );
  });

  it('streams each inserted job with its correct source', async () => {
    fake.raws = [card('100')];
    ghFake.raws = [ghCard('200')];

    const streamed: Array<{ jobId: string; source: string }> = [];
    await runScrape(db, { onJob: (j) => streamed.push(j) });

    expect(streamed).toEqual([
      expect.objectContaining({ jobId: '100', source: 'linkedin' }),
      expect.objectContaining({ jobId: 'gh:200', source: 'greenhouse' }),
    ]);
  });
});
