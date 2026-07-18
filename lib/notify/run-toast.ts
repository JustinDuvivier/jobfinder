/**
 * The scheduled-run toast, as pure data transforms (FR-28): fold each job the
 * run scored into a notable tally — strong matches (score at/above the FR-9a
 * threshold) and FR-6a parks, counted separately — then compose at most one
 * toast summarizing it. A park is a review request carrying a placeholder 70,
 * never an earned score, so it counts independently of the threshold in both
 * directions: it toasts even when the threshold sits above 70, and it is never
 * folded into the strong-match count when the threshold sits below 70.
 *
 * The shared notifier (notifier.ts) does not truncate, so the toast-safe
 * bounds live here with the composer, mirroring the /api/notify reference
 * limits. No side effects — the scheduler's runner fires the result.
 */

/** One scored job's toast-relevant outcome, as settled by the scoring loop. */
export interface ScoredOutcome {
  company: string;
  title: string;
  score: number;
  /** Parked at 70 under FR-6a — a review request, not a fit verdict. */
  parkedForReview: boolean;
}

/** A run's toast-worthy tally, carried on the scoring summary. */
export interface RunNotables {
  /** Jobs this run scored at/above the threshold (FR-9a); parks excluded. */
  strongMatches: number;
  /** The highest-scoring strong match, or null when none landed. */
  bestStrong: { company: string; title: string; score: number } | null;
  /** Jobs this run parked at 70 for review (FR-6a). */
  parkedForReview: number;
  /** The first parked job, naming the parked-only toast. */
  firstParked: { company: string; title: string } | null;
}

export function emptyNotables(): RunNotables {
  return { strongMatches: 0, bestStrong: null, parkedForReview: 0, firstParked: null };
}

/** Fold one scored job into the run's tally (pure — returns a new tally). */
export function recordOutcome(
  notables: RunNotables,
  outcome: ScoredOutcome,
  scoreThreshold: number,
): RunNotables {
  const { company, title, score } = outcome;
  if (outcome.parkedForReview) {
    return {
      ...notables,
      parkedForReview: notables.parkedForReview + 1,
      firstParked: notables.firstParked ?? { company, title },
    };
  }
  if (score < scoreThreshold) return notables;
  const bestStrong =
    notables.bestStrong && notables.bestStrong.score >= score
      ? notables.bestStrong
      : { company, title, score };
  return { ...notables, strongMatches: notables.strongMatches + 1, bestStrong };
}

export interface RunToast {
  title: string;
  message: string;
}

// The /api/notify reference limits; the shared notifier never truncates.
const TITLE_MAX = 200;
const MESSAGE_MAX = 500;

const toast = (title: string, message: string): RunToast => ({
  title: title.slice(0, TITLE_MAX),
  message: message.slice(0, MESSAGE_MAX),
});

const needReview = (count: number): string => `${count} need${count === 1 ? 's' : ''} review`;

/** Compose the run's single toast, or null when nothing notable scored. */
export function composeRunToast(notables: RunNotables): RunToast | null {
  const { strongMatches, bestStrong, parkedForReview, firstParked } = notables;
  if (strongMatches === 1 && parkedForReview === 0 && bestStrong) {
    return toast(
      '💯 Strong match',
      `${bestStrong.company} — ${bestStrong.title} · fit ${bestStrong.score}/100`,
    );
  }
  if (strongMatches > 0) {
    const parked = parkedForReview > 0 ? ` · ${needReview(parkedForReview)}` : '';
    return toast(
      `💯 ${strongMatches} strong match${strongMatches === 1 ? '' : 'es'}${parked}`,
      bestStrong ? `best: ${bestStrong.company} ${bestStrong.score}/100` : '',
    );
  }
  if (parkedForReview === 1 && firstParked) {
    return toast('🔍 1 needs review', `${firstParked.company} — ${firstParked.title}`);
  }
  if (parkedForReview > 0) return toast(`🔍 ${needReview(parkedForReview)}`, '');
  return null;
}
