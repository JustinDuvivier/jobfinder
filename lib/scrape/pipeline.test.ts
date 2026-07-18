import { describe, it, expect, vi } from 'vitest';
import {
  runScrapePipeline,
  parseFields,
  titleMatchesExcludedTerm,
  HANDLERS,
  type RawJob,
  type PipelineDeps,
} from './pipeline';

const ALLOW: PipelineDeps = { isBlocked: () => false, exists: () => false };

function rawJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    jobId: '4012345678',
    title: 'AI Engineer',
    company: 'Stripe',
    location: 'New York, NY',
    url: 'https://www.linkedin.com/jobs/view/4012345678',
    postedAt: '2026-06-18',
    ...overrides,
  };
}

describe('handler order', () => {
  it('runs the six handlers in the documented order', () => {
    expect(HANDLERS.map((h) => h.stage)).toEqual([
      'field_parser',
      'title_filter',
      'blocklist',
      'deduplicator',
      'validator',
      'salary_normalizer',
    ]);
  });
});

describe('field parser', () => {
  it('accepts a complete job and normalizes whitespace', () => {
    const result = runScrapePipeline(rawJob({ title: '  AI   Engineer ' }), ALLOW);
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.job.title).toBe('AI Engineer');
      expect(result.job.company).toBe('Stripe');
    }
  });

  it.each([
    ['job id', { jobId: '' }],
    ['title', { title: '   ' }],
    ['company', { company: undefined }],
  ])('drops a job missing %s at the field parser', (_label, overrides) => {
    const result = runScrapePipeline(rawJob(overrides as Partial<RawJob>), ALLOW);
    expect(result).toMatchObject({ kind: 'dropped', stage: 'field_parser' });
  });

  it('derives the view URL from the job id when absent', () => {
    const result = runScrapePipeline(rawJob({ url: undefined }), ALLOW);
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.job.url).toBe('https://www.linkedin.com/jobs/view/4012345678');
    }
  });

  it('maps absent optional fields to null', () => {
    const result = runScrapePipeline(rawJob({ location: undefined, salary: undefined }), ALLOW);
    if (result.kind === 'accepted') {
      expect(result.job.location).toBeNull();
      expect(result.job.salary).toBeNull();
      expect(result.job.seniorityLevel).toBeNull();
      expect(result.job.employmentType).toBeNull();
      expect(result.job.jobFunction).toBeNull();
      expect(result.job.industries).toBeNull();
      expect(result.job.applicants).toBeNull();
    }
  });

  it('maps the criteria and applicant fields when a strategy provides them', () => {
    const result = runScrapePipeline(
      rawJob({
        seniorityLevel: ' Entry level ',
        employmentType: 'Full-time',
        jobFunction: 'Engineering',
        industries: 'Software Development',
        applicants: 'Over 200 applicants',
      }),
      ALLOW,
    );
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.job.seniorityLevel).toBe('Entry level');
      expect(result.job.employmentType).toBe('Full-time');
      expect(result.job.jobFunction).toBe('Engineering');
      expect(result.job.industries).toBe('Software Development');
      expect(result.job.applicants).toBe('Over 200 applicants');
    }
  });
});

describe('blocklist filter (FR-4)', () => {
  it('drops jobs from blocked companies (case/space-insensitive)', () => {
    const deps: PipelineDeps = { isBlocked: (c) => c === 'staffing agency inc', exists: () => false };
    const result = runScrapePipeline(rawJob({ company: '  Staffing   Agency   Inc ' }), deps);
    expect(result).toMatchObject({ kind: 'dropped', stage: 'blocklist' });
  });

  it('does not query the database for a blocked job (short-circuit before dedup)', () => {
    const exists = vi.fn(() => false);
    const deps: PipelineDeps = { isBlocked: () => true, exists };
    runScrapePipeline(rawJob(), deps);
    expect(exists).not.toHaveBeenCalled();
  });
});

describe('title filter (FR-4a)', () => {
  const SENIOR_TERMS = ['senior', 'sr', 'staff', 'lead'];
  const deps: PipelineDeps = {
    isBlocked: () => false,
    exists: () => false,
    isExcludedTitle: (t) => titleMatchesExcludedTerm(t, SENIOR_TERMS),
  };

  it.each(['Senior Software Engineer', 'Sr. AI Engineer', 'Staff ML Engineer', 'Engineering Lead'])(
    'drops over-senior title %s before any DB hit',
    (title) => {
      const exists = vi.fn(() => false);
      const result = runScrapePipeline(rawJob({ title }), { ...deps, exists });
      expect(result).toMatchObject({ kind: 'dropped', stage: 'title_filter' });
      expect(exists).not.toHaveBeenCalled(); // short-circuits before dedup
    },
  );

  it.each(['Software Engineer', 'Junior ML Engineer', 'Associate AI Engineer', 'Mid-Level Engineer'])(
    'keeps mid-and-below title %s',
    (title) => {
      const result = runScrapePipeline(rawJob({ title }), deps);
      expect(result.kind).toBe('accepted');
    },
  );

  it('runs after the field parser (a title-less job drops at the parser, not here)', () => {
    const result = runScrapePipeline(rawJob({ title: '' }), deps);
    expect(result).toMatchObject({ kind: 'dropped', stage: 'field_parser' });
  });

  it('excludes nothing when no isExcludedTitle predicate is supplied', () => {
    const result = runScrapePipeline(rawJob({ title: 'Senior Software Engineer' }), ALLOW);
    expect(result.kind).toBe('accepted');
  });
});

describe('titleMatchesExcludedTerm', () => {
  const TERMS = ['senior', 'sr', 'staff', 'lead', 'head of'];

  it('matches terms as whole words, case-insensitively', () => {
    expect(titleMatchesExcludedTerm('SENIOR Engineer', TERMS)).toBe(true);
    expect(titleMatchesExcludedTerm('Sr. Engineer', TERMS)).toBe(true);
    expect(titleMatchesExcludedTerm('Head of Data', TERMS)).toBe(true);
  });

  it('does not misfire on substrings', () => {
    expect(titleMatchesExcludedTerm('Staffing Coordinator', ['staff'])).toBe(false);
    expect(titleMatchesExcludedTerm('Leadership Program Associate', ['lead'])).toBe(false);
    expect(titleMatchesExcludedTerm('Disregard Specialist', ['sr'])).toBe(false);
  });

  it('returns false for an empty or blank-only term list', () => {
    expect(titleMatchesExcludedTerm('Senior Engineer', [])).toBe(false);
    expect(titleMatchesExcludedTerm('Senior Engineer', ['   '])).toBe(false);
  });

  it('treats regex metacharacters in a term literally (no injection)', () => {
    // A literal ".*" term must not behave like the match-anything regex.
    expect(titleMatchesExcludedTerm('Software Engineer', ['.*'])).toBe(false);
  });
});

describe('deduplicator (FR-3)', () => {
  it('drops a job that already exists', () => {
    const deps: PipelineDeps = { isBlocked: () => false, exists: (id) => id === '4012345678' };
    const result = runScrapePipeline(rawJob(), deps);
    expect(result).toMatchObject({ kind: 'dropped', stage: 'deduplicator' });
  });

  it('runs only after the field parser and blocklist pass', () => {
    const exists = vi.fn(() => false);
    const isBlocked = vi.fn(() => false);
    runScrapePipeline(rawJob(), { isBlocked, exists });
    // both consulted, in order, exactly once
    expect(isBlocked).toHaveBeenCalledTimes(1);
    expect(exists).toHaveBeenCalledTimes(1);
  });
});

// The precedence itself (field → prose → AI) is pinned in lib/salary.test.ts;
// these cover the stage's wiring: it delegates to the resolver, runs last, and
// only touches survivors.
describe('salary normalizer (runs last, only on survivors)', () => {
  it('normalizes the salary of an accepted job (annual /yr suffix dropped)', () => {
    const result = runScrapePipeline(rawJob({ salary: '$120,000/yr - $150,000/yr' }), ALLOW);
    if (result.kind === 'accepted') {
      expect(result.job.salary).toBe('$120,000 – $150,000');
    }
  });

  it('is not reached for a dropped job', () => {
    // A blocked job with a malformed salary should never touch normalization;
    // the result is the blocklist drop, salary untouched.
    const deps: PipelineDeps = { isBlocked: () => true, exists: () => false };
    const result = runScrapePipeline(rawJob({ salary: 'garbage' }), deps);
    expect(result.kind).toBe('dropped');
  });

  it('falls back to the description when the salary field is empty', () => {
    const description =
      'About the role. You will build ML systems.\nThe base salary range for this position is $140,000 - $175,000 per year, plus equity.';
    const result = runScrapePipeline(rawJob({ salary: undefined, description }), ALLOW);
    if (result.kind === 'accepted') {
      expect(result.job.salary).toBe('$140,000 – $175,000');
    } else {
      throw new Error('expected accepted');
    }
  });

  it('prefers the explicit salary field over the description', () => {
    const result = runScrapePipeline(
      rawJob({ salary: '$100k', description: 'pay range $200,000 - $250,000' }),
      ALLOW,
    );
    if (result.kind === 'accepted') {
      expect(result.job.salary).toBe('$100,000');
    } else {
      throw new Error('expected accepted');
    }
  });
});

describe('parseFields helper', () => {
  it('returns a normalized job for valid input', () => {
    expect(parseFields(rawJob())).not.toBeNull();
  });

  it('returns null for input the field parser drops', () => {
    expect(parseFields(rawJob({ company: '' }))).toBeNull();
  });
});
