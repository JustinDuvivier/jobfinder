/**
 * Shared test fixtures: the canonical full UserConfig and the job-insert
 * helper, defined once so the shapes don't drift across per-file copies.
 * Tests spread-override individual fields as needed, e.g.
 * `{ ...CONFIG, resumeLatex: RESUME }`. Not a test file itself — vitest only
 * collects *.test.ts.
 */
import type { DB } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import type { JobStatus, UserConfig } from '@/lib/types';
import type { ScoreResult } from '@/lib/ai/score';

/** A complete user config; tests override individual fields as needed. */
export const CONFIG: UserConfig = {
  resumeLatex: '\\documentclass{article}\\begin{document}Engineer\\end{document}',
  sourceOfTruth: 'Shipped X.',
  searchUrl: '',
  scraperStrategy: 'linkedin',
  greenhouseEnabled: false,
  ownerName: 'Alex_Candidate',
  keywords: ['Engineer'],
  locations: ['New York'],
  excludedTitleTerms: ['senior', 'staff'],
  scoringPrompt: 'Score the candidate.',
  rewriteRules: 'Tailor minimally.',
  runIntervalMinutes: 0,
  searchLookbackHours: 2,
  // Transport tests mock the Anthropic client/scoreJob; backend-routing tests
  // flip this to 'ollama' explicitly.
  scoringBackend: 'anthropic',
  ollamaModel: 'batiai/qwen3.6-27b:iq3',
  scoreThreshold: 60,
};

/** A passing score result for the mocked scoreJob. */
export const RESULT: ScoreResult = {
  score: 80,
  reasoning: 'fits',
  keyMatches: [],
  concerns: [],
  comparison: [],
  experience: null,
  parkedForReview: false,
};

/** Overridable fields of the seeded job row; everything else stays minimal. */
interface TestJobOverrides {
  company?: string;
  title?: string;
  description?: string;
  /** Applied via UPDATE after the insert (insertJob always creates `new` rows). */
  status?: JobStatus;
}

/** Insert a minimal job row (default status `new`) and return its row id. */
export function insertTestJob(db: DB, jobId: string, overrides: TestJobOverrides = {}): number {
  const rowId = repo.insertJob(db, {
    jobId,
    company: overrides.company ?? 'Acme',
    title: overrides.title ?? 'Engineer',
    location: null,
    salary: null,
    description: overrides.description ?? 'Build things.',
    url: `https://example.com/${jobId}`,
    postedAt: null,
    seniorityLevel: null,
    employmentType: null,
    jobFunction: null,
    industries: null,
    applicants: null,
  });
  if (overrides.status) {
    db.prepare(`UPDATE jobs SET status = ? WHERE id = ?`).run(overrides.status, rowId);
  }
  return rowId;
}
