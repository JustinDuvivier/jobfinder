import { describe, it, expect } from 'vitest';
import {
  serializeScoreReason,
  parseScoreReason,
  asTapeRows,
  asExperienceRead,
  type ScoreReasonPayload,
} from './score-reason';

const PAYLOAD: ScoreReasonPayload = {
  reasoning: 'Good fit.',
  keyMatches: ['Python', 'RAG'],
  concerns: ['Junior'],
  comparison: [{ dimension: 'Years of experience', you: '3 yrs', them: '4 yrs', verdict: 'partial' }],
  experience: { requiredQuote: '4+ years', candidateYears: 3, requiredYears: 4, gapYears: 1 },
  parkedForReview: false,
};

describe('serializeScoreReason', () => {
  it('round-trips through parseScoreReason without losing any field', () => {
    expect(parseScoreReason(serializeScoreReason(PAYLOAD))).toEqual(PAYLOAD);
  });

  it('serializes exactly the payload fields — no score, nothing extra', () => {
    const parsed = JSON.parse(serializeScoreReason(PAYLOAD));
    expect(Object.keys(parsed).sort()).toEqual([
      'comparison',
      'concerns',
      'experience',
      'keyMatches',
      'parkedForReview',
      'reasoning',
    ]);
  });

  it('round-trips a parked-for-review payload with the flag intact', () => {
    const parked = { ...PAYLOAD, parkedForReview: true };
    expect(parseScoreReason(serializeScoreReason(parked))).toEqual(parked);
  });
});

describe('parseScoreReason (JSON format)', () => {
  it('preserves the experience block instead of dropping it', () => {
    const parsed = parseScoreReason(serializeScoreReason(PAYLOAD));
    expect(parsed?.experience).toEqual(PAYLOAD.experience);
  });

  it('rejects a malformed experience block to null without losing the rest', () => {
    const json = JSON.stringify({ ...PAYLOAD, experience: { requiredQuote: 42 } });
    const parsed = parseScoreReason(json);
    expect(parsed?.experience).toBeNull();
    expect(parsed?.reasoning).toBe('Good fit.');
  });

  it('recomputes an inconsistent stored gapYears instead of trusting it', () => {
    const json = JSON.stringify({
      ...PAYLOAD,
      experience: { requiredQuote: '4+ years', candidateYears: 3, requiredYears: 4, gapYears: 40 },
    });
    expect(parseScoreReason(json)?.experience).toEqual({
      requiredQuote: '4+ years',
      candidateYears: 3,
      requiredYears: 4,
      gapYears: 1,
    });
  });

  it('fills in a missing stored gapYears rather than rejecting the block', () => {
    // The gap is derived, not stored truth: a block that lacks it is still valid.
    const json = JSON.stringify({
      ...PAYLOAD,
      experience: { requiredQuote: '4+ years', candidateYears: 3, requiredYears: 4 },
    });
    expect(parseScoreReason(json)?.experience).toEqual({
      requiredQuote: '4+ years',
      candidateYears: 3,
      requiredYears: 4,
      gapYears: 1,
    });
  });

  it('defaults missing fields and filters non-strings out of the chip arrays', () => {
    // Payloads stored before the park rule have no parkedForReview: default false.
    const parsed = parseScoreReason('{"reasoning": "x", "keyMatches": ["ok", 3, null]}');
    expect(parsed).toEqual({
      reasoning: 'x',
      keyMatches: ['ok'],
      concerns: [],
      comparison: [],
      experience: null,
      parkedForReview: false,
    });
  });

  it('coerces a non-boolean parkedForReview to false', () => {
    expect(parseScoreReason('{"reasoning": "x", "parkedForReview": "yes"}')?.parkedForReview).toBe(false);
    expect(parseScoreReason('{"reasoning": "x", "parkedForReview": 1}')?.parkedForReview).toBe(false);
  });

  it('drops invalid comparison rows and coerces unknown verdicts to partial', () => {
    const json = JSON.stringify({
      reasoning: 'x',
      comparison: [
        { dimension: 'Stack', you: 'Python', them: 'Python', verdict: 'match' },
        { dimension: 'Domain', you: 'Fintech', them: 'Health', verdict: 'weird' },
        { dimension: '', you: 'x', them: 'y', verdict: 'match' }, // no dimension → dropped
        { dimension: 'Empty', you: '', them: '', verdict: 'gap' }, // no you/them → dropped
      ],
    });
    expect(parseScoreReason(json)?.comparison).toEqual([
      { dimension: 'Stack', you: 'Python', them: 'Python', verdict: 'match' },
      { dimension: 'Domain', you: 'Fintech', them: 'Health', verdict: 'partial' },
    ]);
  });
});

describe('parseScoreReason (legacy line-based format)', () => {
  it('parses reasoning plus Key matches / Concerns lines', () => {
    const legacy =
      'Strong backend match.\nKey matches: Python, SQL\nConcerns: no Go; hybrid only';
    expect(parseScoreReason(legacy)).toEqual({
      reasoning: 'Strong backend match.',
      keyMatches: ['Python', 'SQL'],
      concerns: ['no Go', 'hybrid only'],
      comparison: [],
      experience: null,
      parkedForReview: false,
    });
  });

  it('falls back to legacy parsing when the JSON is malformed', () => {
    expect(parseScoreReason('{not json')?.reasoning).toBe('{not json');
  });

  it('treats plain prose as reasoning-only', () => {
    expect(parseScoreReason('Decent fit overall.')).toEqual({
      reasoning: 'Decent fit overall.',
      keyMatches: [],
      concerns: [],
      comparison: [],
      experience: null,
      parkedForReview: false,
    });
  });
});

describe('parseScoreReason (absent input)', () => {
  it('returns null for null and for blank strings', () => {
    expect(parseScoreReason(null)).toBeNull();
    expect(parseScoreReason('')).toBeNull();
    expect(parseScoreReason('   ')).toBeNull();
  });
});

describe('asExperienceRead', () => {
  it('always recomputes gapYears from requiredYears − candidateYears', () => {
    // A missing gap is filled in; a wrong one is corrected — never trusted.
    expect(
      asExperienceRead({ requiredQuote: '5+ years', candidateYears: 2, requiredYears: 5 }),
    ).toEqual({ requiredQuote: '5+ years', candidateYears: 2, requiredYears: 5, gapYears: 3 });
    expect(
      asExperienceRead({ requiredQuote: '5+ years', candidateYears: 2, requiredYears: 5, gapYears: 99 }),
    ).toEqual({ requiredQuote: '5+ years', candidateYears: 2, requiredYears: 5, gapYears: 3 });
  });

  it('allows a negative gap (candidate exceeds the bar)', () => {
    expect(
      asExperienceRead({ requiredQuote: '3-5 years', candidateYears: 6, requiredYears: 3 }),
    ).toEqual({ requiredQuote: '3-5 years', candidateYears: 6, requiredYears: 3, gapYears: -3 });
  });

  it('returns null for non-objects and missing or non-finite fields', () => {
    expect(asExperienceRead(null)).toBeNull();
    expect(asExperienceRead('5 years')).toBeNull();
    expect(asExperienceRead({ requiredQuote: 42, candidateYears: 2, requiredYears: 5 })).toBeNull();
    expect(asExperienceRead({ requiredQuote: 'x', candidateYears: 2 })).toBeNull();
    expect(asExperienceRead({ requiredQuote: 'x', candidateYears: NaN, requiredYears: 5 })).toBeNull();
    expect(asExperienceRead({ requiredQuote: 'x', candidateYears: 2, requiredYears: '5' })).toBeNull();
  });

  it('rejects a block whose recomputed gap overflows to Infinity', () => {
    // Two individually finite years must never produce a non-finite gap.
    expect(
      asExperienceRead({ requiredQuote: 'x', candidateYears: -1e308, requiredYears: 1e308 }),
    ).toBeNull();
  });
});

describe('asTapeRows', () => {
  it('returns [] for non-arrays', () => {
    expect(asTapeRows(undefined)).toEqual([]);
    expect(asTapeRows('nope')).toEqual([]);
    expect(asTapeRows([null, 7])).toEqual([]);
  });

  it('trims fields and keeps rows with at least one side filled', () => {
    expect(asTapeRows([{ dimension: ' Stack ', you: ' Python ', them: '', verdict: 'gap' }])).toEqual([
      { dimension: 'Stack', you: 'Python', them: '', verdict: 'gap' },
    ]);
  });
});
