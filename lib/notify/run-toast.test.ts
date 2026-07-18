/**
 * run-toast tests — the pure scheduled-run toast pipeline (FR-28): folding
 * scored outcomes into the run's notable tally (strong matches vs. FR-6a
 * parks, threshold-vs-park independence in both directions) and composing at
 * most one toast in the exact ticket formats, bounded to toast-safe lengths.
 * No spawns, no DB — pure data in, `{title, message} | null` out.
 */
import { describe, it, expect } from 'vitest';
import {
  composeRunToast,
  emptyNotables,
  recordOutcome,
  type RunNotables,
  type ScoredOutcome,
} from './run-toast';

const outcome = (over: Partial<ScoredOutcome> = {}): ScoredOutcome => ({
  company: 'Acme',
  title: 'Senior Dev',
  score: 91,
  parkedForReview: false,
  ...over,
});

/** Fold a run's outcomes at the given threshold — what warm-first does per settle. */
const tally = (outcomes: ScoredOutcome[], scoreThreshold: number): RunNotables =>
  outcomes.reduce((n, o) => recordOutcome(n, o, scoreThreshold), emptyNotables());

describe('recordOutcome', () => {
  it('counts a score at or above the threshold as a strong match and tracks the best', () => {
    const n = tally(
      [outcome({ company: 'Other', score: 60 }), outcome({ score: 91 }), outcome({ company: 'Low', score: 59 })],
      60,
    );
    expect(n.strongMatches).toBe(2); // 59 is below the threshold — not notable
    expect(n.bestStrong).toEqual({ company: 'Acme', title: 'Senior Dev', score: 91 });
    expect(n.parkedForReview).toBe(0);
  });

  it('counts a parked job even when the threshold is above the parking line (FR-6a)', () => {
    const n = tally([outcome({ score: 70, parkedForReview: true })], 90);
    expect(n.parkedForReview).toBe(1);
    expect(n.strongMatches).toBe(0);
    expect(n.firstParked).toEqual({ company: 'Acme', title: 'Senior Dev' });
  });

  it('never folds a parked job into the strong-match count when the threshold is below 70', () => {
    const n = tally(
      [outcome({ score: 80 }), outcome({ company: 'ParkedCo', score: 70, parkedForReview: true })],
      60,
    );
    expect(n.strongMatches).toBe(1); // the park score is a placeholder, not an earned 70
    expect(n.parkedForReview).toBe(1);
    expect(n.bestStrong?.company).toBe('Acme');
  });

  it('does not mutate the tally it was given', () => {
    const before = emptyNotables();
    recordOutcome(before, outcome(), 60);
    expect(before).toEqual(emptyNotables());
  });
});

describe('composeRunToast', () => {
  it('stays silent when the run scored nothing notable', () => {
    expect(composeRunToast(emptyNotables())).toBeNull();
    expect(composeRunToast(tally([outcome({ score: 40 })], 60))).toBeNull();
  });

  it('headlines a single strong match with company, title, and fit', () => {
    // Joined, this is the ticket's `💯 Strong match — Acme — Senior Dev · fit 91/100`.
    expect(composeRunToast(tally([outcome()], 60))).toEqual({
      title: '💯 Strong match',
      message: 'Acme — Senior Dev · fit 91/100',
    });
  });

  it('summarizes several strong matches with a count and the best', () => {
    // Joined: `💯 3 strong matches · best: Acme 91/100`.
    const n = tally([outcome({ score: 84 }), outcome({ score: 91 }), outcome({ score: 77 })], 60);
    expect(composeRunToast(n)).toEqual({
      title: '💯 3 strong matches',
      message: 'best: Acme 91/100',
    });
  });

  it('appends the parked count to a mixed run', () => {
    // Joined: `💯 2 strong matches · 1 needs review · best: Acme 91/100`.
    const n = tally(
      [outcome({ score: 91 }), outcome({ score: 80 }), outcome({ score: 70, parkedForReview: true })],
      60,
    );
    expect(composeRunToast(n)).toEqual({
      title: '💯 2 strong matches · 1 needs review',
      message: 'best: Acme 91/100',
    });
  });

  it('names a lone parked job — even when the threshold is above 70', () => {
    // Joined: `🔍 1 needs review — Acme — Senior Dev`.
    const n = tally([outcome({ score: 70, parkedForReview: true })], 90);
    expect(composeRunToast(n)).toEqual({
      title: '🔍 1 needs review',
      message: 'Acme — Senior Dev',
    });
  });

  it('counts multiple parked jobs when no strong match landed', () => {
    const n = tally(
      [
        outcome({ score: 70, parkedForReview: true }),
        outcome({ company: 'Beta', score: 70, parkedForReview: true }),
      ],
      90,
    );
    expect(composeRunToast(n)).toEqual({ title: '🔍 2 need review', message: '' });
  });

  it('bounds the toast to the notify limits (title ≤ 200, message ≤ 500)', () => {
    const long = 'x'.repeat(600);
    const single = composeRunToast(tally([outcome({ company: long, title: long })], 60));
    expect(single!.title.length).toBeLessThanOrEqual(200);
    expect(single!.message.length).toBeLessThanOrEqual(500);

    const parked = composeRunToast(
      tally([outcome({ company: long, title: long, score: 70, parkedForReview: true })], 90),
    );
    expect(parked!.message.length).toBeLessThanOrEqual(500);
  });
});
