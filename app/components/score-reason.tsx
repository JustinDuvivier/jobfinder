'use client';

/**
 * Renders a job's stored score reason — the "tale of the tape" comparison plus
 * the watch-outs. Shared by the Jobs decision queue and the Tracker table so the
 * scoring rationale stays visible long after a job has been applied to.
 *
 * The payload type and its parsing live in lib/score-reason.ts (the payload's
 * single owner); this file only decides what to show. Deliberately not
 * rendered: `experience` (the tape's "Years of experience" row already
 * presents the same read) and `keyMatches` (redundant with the tape's match
 * rows; only the concerns earn chips).
 */

import { parseScoreReason, type TapeVerdict } from '@/lib/score-reason';

const VERDICT_META: Record<TapeVerdict, { label: string; cls: string }> = {
  match: { label: '✓ match', cls: 'is-match' },
  partial: { label: '~ partial', cls: 'is-partial' },
  gap: { label: '✕ gap', cls: 'is-gap' },
};

export function ScoreReason({ reason }: { reason: string | null }) {
  const parsed = parseScoreReason(reason);
  // Emptiness is judged on the rendered fields only — a payload carrying
  // nothing but the excluded keyMatches would otherwise render an empty block.
  if (
    !parsed ||
    (!parsed.reasoning && parsed.comparison.length === 0 && parsed.concerns.length === 0)
  ) {
    return <span className="muted">Not scored yet.</span>;
  }
  return (
    <div className="score-why">
      {parsed.parkedForReview && (
        // FR-6a: the score was parked at 70 because the requirement (and so
        // the gap) was the model's inference — the user decides, not a guess.
        <span className="why-chip is-review">requirement inferred — review</span>
      )}
      {parsed.reasoning && <p className="score-why-text">{parsed.reasoning}</p>}

      {parsed.comparison.length > 0 && (
        <div className="tape">
          <div className="tape-row tape-head">
            <span className="tape-dim">Tale of the tape</span>
            <span className="tape-you">You</span>
            <span className="tape-them">Them</span>
            <span className="tape-verdict" />
          </div>
          {parsed.comparison.map((r, i) => (
            <div className={`tape-row ${VERDICT_META[r.verdict].cls}`} key={i}>
              <span className="tape-dim">{r.dimension}</span>
              <span className="tape-you">{r.you || '—'}</span>
              <span className="tape-them">{r.them || '—'}</span>
              <span className="tape-verdict">
                <span className="tape-badge">{VERDICT_META[r.verdict].label}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {parsed.concerns.length > 0 && (
        <div className="score-why-row">
          <span className="score-why-label">Watch-outs</span>
          <div className="chip-row">
            {parsed.concerns.map((c, i) => (
              <span key={i} className="why-chip is-concern">{c}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
