/**
 * Self-consistency checks for golden/score.golden.json — the scoring-prompt
 * eval set used to compare scoring models (Haiku vs. a local model). No model
 * is called here (model output is non-deterministic; CLAUDE.md forbids
 * asserting it). Instead this pins the golden file's *expectations* to the
 * deterministic policy code in this module, so the eval set can never drift
 * from what the app would actually enforce:
 *
 * - every quote fragment appears verbatim in its posting (a model copying
 *   faithfully can always satisfy the check);
 * - requiredYearsFromQuote(fragment) re-derives exactly the expected years;
 * - gap ranges are the arithmetic consequence of the years ranges;
 * - no expected score range exceeds the gapScoreCap the app would apply.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requiredYearsFromQuote, gapScoreCap, PARKED_REVIEW_SCORE } from './score';
import { loadResumeAssets, clearResumeAssetsCache } from '../resume/load';

type Range = [number, number];

interface QuoteExpectation {
  equals?: string;
  contains?: string;
}

interface CaseExpected {
  requiredQuote: QuoteExpectation;
  requiredYears: { exact?: number; range?: Range };
  gapYearsRange: Range;
  scoreRange: Range;
  yearsRowVerdicts?: string[];
  concernsMustMentionShortfall: boolean;
  recallCritical?: boolean;
}

interface EvalCase {
  id: string;
  source: { type: 'job-detail-golden' | 'inline'; jobId?: string };
  jobDescription?: string;
  expected: CaseExpected;
}

interface ScoreGolden {
  candidateYearsRange: Range;
  cases: EvalCase[];
}

const GOLDEN_DIR = join(process.cwd(), 'golden');

function loadGolden<T>(name: string): T {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8')) as T;
}

const golden = loadGolden<ScoreGolden>('score.golden.json');
const details = loadGolden<Record<string, { description: string }>>('job-detail.golden.json');

/** The expected required-years bounds ([n, n] for an exact expectation). */
function requiredBounds(expected: CaseExpected): Range {
  const { exact, range } = expected.requiredYears;
  if (exact !== undefined) return [exact, exact];
  if (range !== undefined) return range;
  throw new Error('requiredYears must set exact or range');
}

/** The posting text the model sees for a case, from fixture or inline. */
function postingText(c: EvalCase): string {
  if (c.source.type === 'inline') return c.jobDescription ?? '';
  return details[c.source.jobId ?? '']?.description ?? '';
}

describe('golden: score eval set', () => {
  it('has a plausible shared candidate-years range', () => {
    const [min, max] = golden.candidateYearsRange;
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeGreaterThan(min);
  });

  it('brackets the years the effective source of truth states explicitly', () => {
    // Step 2 of the scoring prompt tells the model to copy the profile's
    // stated figure, and every gap range below derives from this bracket —
    // so when the stated years change, the eval set must change with them
    // instead of silently reporting mass model failure. The effective source
    // of truth is the user's private resume/source_of_truth.md when present,
    // else the committed resume-example/ fallback, so this holds in a fresh
    // clone too.
    clearResumeAssetsCache();
    const sot = loadResumeAssets().sourceOfTruth;
    const stated = /\*\*Years of experience[^:]*:\s*~?(\d+(?:\.\d+)?)\s*years/.exec(sot);
    expect(stated).not.toBeNull();
    const years = Number(stated![1]);
    const [min, max] = golden.candidateYearsRange;
    expect(years).toBeGreaterThanOrEqual(min);
    expect(years).toBeLessThanOrEqual(max);
  });

  it('has non-empty, uniquely identified cases', () => {
    expect(golden.cases.length).toBeGreaterThan(0);
    const ids = golden.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(golden.cases.map((c) => [c.id, c] as const))(
    '%s: expectations are well-formed',
    (_id, c) => {
      const { requiredQuote, requiredYears, gapYearsRange, scoreRange, yearsRowVerdicts } =
        c.expected;
      // Exactly one quote mode and one years mode.
      expect([requiredQuote.equals, requiredQuote.contains].filter((v) => v !== undefined)).toHaveLength(1);
      expect([requiredYears.exact, requiredYears.range].filter((v) => v !== undefined)).toHaveLength(1);
      expect(gapYearsRange[0]).toBeLessThanOrEqual(gapYearsRange[1]);
      expect(scoreRange[0]).toBeLessThanOrEqual(scoreRange[1]);
      expect(scoreRange[0]).toBeGreaterThanOrEqual(0);
      expect(scoreRange[1]).toBeLessThanOrEqual(100);
      for (const verdict of yearsRowVerdicts ?? []) {
        expect(['match', 'partial', 'gap']).toContain(verdict);
      }
    },
  );

  it.each(golden.cases.map((c) => [c.id, c] as const))(
    '%s: posting exists and contains the quote fragment verbatim',
    (_id, c) => {
      const posting = postingText(c);
      expect(posting.length).toBeGreaterThan(0);
      if (c.source.type === 'job-detail-golden') {
        // Real cases reference the captured fixture; no duplicated text.
        expect(c.jobDescription).toBeUndefined();
      }
      const fragment = c.expected.requiredQuote.contains;
      if (fragment !== undefined) expect(posting).toContain(fragment);
    },
  );

  it.each(golden.cases.map((c) => [c.id, c] as const))(
    '%s: quote expectation re-derives the expected required years',
    (_id, c) => {
      const { equals, contains } = c.expected.requiredQuote;
      if (contains !== undefined) {
        // The app reads the years from the copied quote; the fragment must
        // yield exactly the years this case expects the model to report.
        expect(requiredYearsFromQuote(contains)).toBe(c.expected.requiredYears.exact);
      } else {
        // "none stated": the quote carries no number, so the app falls back
        // to the model's own inferred required_years — the path this probes.
        expect(requiredYearsFromQuote(equals ?? '')).toBeNull();
        expect(c.expected.requiredYears.range).toBeDefined();
      }
    },
  );

  it.each(golden.cases.map((c) => [c.id, c] as const))(
    '%s: gap range is the arithmetic consequence of the years ranges',
    (_id, c) => {
      const [reqMin, reqMax] = requiredBounds(c.expected);
      const [candMin, candMax] = golden.candidateYearsRange;
      expect(c.expected.gapYearsRange).toEqual([reqMin - candMax, reqMax - candMin]);
    },
  );

  it.each(golden.cases.map((c) => [c.id, c] as const))(
    '%s: score range matches the cap — or the park — the app would apply',
    (_id, c) => {
      const [reqMin] = requiredBounds(c.expected);
      const [, candMax] = golden.candidateYearsRange;
      const { equals, contains } = c.expected.requiredQuote;
      const quoteYears = requiredYearsFromQuote(contains ?? equals ?? '');
      const loosestCap = gapScoreCap(reqMin - candMax);
      if (quoteYears === null && loosestCap < PARKED_REVIEW_SCORE) {
        // Inferred requirement whose gap exceeds 2 years even at the most
        // favorable read: the app parks the persisted score at exactly 70
        // with the review flag (FR-6a), whatever the model scored.
        expect(c.expected.scoreRange).toEqual([PARKED_REVIEW_SCORE, PARKED_REVIEW_SCORE]);
      } else {
        expect(c.expected.scoreRange[1]).toBeLessThanOrEqual(loosestCap);
      }
    },
  );

  it.each(golden.cases.filter((c) => c.expected.recallCritical).map((c) => [c.id, c] as const))(
    '%s: recall-critical floor clears the default FR-9a threshold',
    (_id, c) => {
      // recallCritical means an underscore hides a genuine match behind the
      // auto-filter — which is only true when the expected floor sits at or
      // above the default threshold (50).
      expect(c.expected.scoreRange[0]).toBeGreaterThanOrEqual(50);
    },
  );
});
