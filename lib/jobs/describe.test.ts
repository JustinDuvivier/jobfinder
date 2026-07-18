import { describe, it, expect } from 'vitest';
import { describeJob } from './describe';
import type { Job } from '../types';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    jobId: 'lk-1',
    company: 'Stripe',
    title: 'AI Engineer',
    location: 'New York, NY',
    salary: '$160,000 – $210,000/yr',
    description: 'Build LLM features.',
    url: 'https://x',
    source: 'linkedin',
    postedAt: '2026-06-18',
    seniorityLevel: 'Entry level',
    employmentType: 'Full-time',
    jobFunction: 'Engineering and Information Technology',
    industries: 'Software Development',
    applicants: 'Over 200 applicants',
    status: 'scored',
    score: null,
    scoreReason: null,
    belowThreshold: false,
    rewrittenLatex: null,
    explanation: null,
    approvedPdfPath: null,
    latexHash: null,
    createdAt: 't',
    updatedAt: 't',
    ...overrides,
  };
}

describe('describeJob', () => {
  it('includes title, company, location, salary, criteria, applicants, and description', () => {
    const text = describeJob(job());
    expect(text).toContain('AI Engineer at Stripe');
    expect(text).toContain('Location: New York, NY');
    expect(text).toContain('Salary: $160,000 – $210,000/yr');
    expect(text).toContain('Seniority level: Entry level');
    expect(text).toContain('Employment type: Full-time');
    expect(text).toContain('Job function: Engineering and Information Technology');
    expect(text).toContain('Industries: Software Development');
    expect(text).toContain('Applicants: Over 200 applicants');
    expect(text).toContain('Build LLM features.');
  });

  it('omits absent optional fields', () => {
    const text = describeJob(
      job({
        location: null,
        salary: null,
        description: null,
        seniorityLevel: null,
        employmentType: null,
        jobFunction: null,
        industries: null,
        applicants: null,
      }),
    );
    expect(text).toBe('AI Engineer at Stripe');
  });
});
