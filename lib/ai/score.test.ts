import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  buildScoreRequest,
  parseScoreResponse,
  scoreJob,
  requiredYearsFromQuote,
  gapScoreCap,
  PARKED_REVIEW_SCORE,
  SCORING_CONTRACT,
  type ScoreInput,
} from './score';
import { SCORING_MODEL, SCORING_MAX_TOKENS, SCORING_CACHE_TTL } from './models';
import { makeTextMessage } from './mock-message';
import { serializeScoreReason, parseScoreReason } from '@/lib/score-reason';

const INPUT: ScoreInput = {
  systemPrompt: 'You are a job matching expert. Score the candidate.',
  sourceOfTruth: 'Shipped a payments service handling 10k rps.',
  resumePlainText: 'Alex Candidate — Software Engineer.',
  jobDescription: 'AI Engineer at Stripe. Build LLM features.',
};

const VALID = '{"score": 82, "reasoning": "Strong fit.", "key_matches": ["Python"], "concerns": ["No Go"]}';

describe('buildScoreRequest', () => {
  it('routes to the scoring model with the scoring budget', () => {
    const req = buildScoreRequest(INPUT);
    expect(req.model).toBe(SCORING_MODEL);
    expect(req.max_tokens).toBe(SCORING_MAX_TOKENS);
  });

  it('scores on Haiku (cheap tier; accuracy comes from quote-and-cap post-processing)', () => {
    expect(SCORING_MODEL).toMatch(/^claude-haiku/);
  });

  it('places prompt, then contract, then the cached profile block', () => {
    const system = buildScoreRequest(INPUT).system as Anthropic.TextBlockParam[];
    expect(system[0].text).toBe(INPUT.systemPrompt);
    expect(system[0].cache_control).toBeUndefined();
    expect(system[1].text).toBe(SCORING_CONTRACT);
    expect(system[1].cache_control).toBeUndefined();
    expect(system[2].text).toContain(INPUT.sourceOfTruth);
    expect(system[2].text).toContain(INPUT.resumePlainText);
  });

  it('caches the whole stable prefix with the 1-hour TTL on the last block only', () => {
    const system = buildScoreRequest(INPUT).system as Anthropic.TextBlockParam[];
    // A single breakpoint on the last system block caches everything before it;
    // the 1h TTL keeps the entry warm across scheduled runs (see SCORING_CACHE_TTL).
    expect(system[system.length - 1].cache_control).toEqual({
      type: 'ephemeral',
      ttl: SCORING_CACHE_TTL,
    });
    expect(system.filter((b) => b.cache_control).length).toBe(1);
  });

  it('keeps the contract in sync with the enforced gap caps and verdicts', () => {
    // The contract tells the model what the code does; if gapScoreCap or the
    // verdict coercion changes, this forces the contract text to change with it.
    expect(SCORING_CONTRACT).toContain('capped at 70');
    expect(SCORING_CONTRACT).toContain('capped at 50');
    expect(SCORING_CONTRACT).toContain('capped at 30');
    expect(SCORING_CONTRACT).toContain('"match"');
    expect(SCORING_CONTRACT).toContain('"partial"');
    expect(SCORING_CONTRACT).toContain('"gap"');
    expect(SCORING_CONTRACT).toContain('none stated');
    // The park rule (FR-6a): an inferred requirement never buries a job.
    expect(SCORING_CONTRACT).toContain('parks the persisted score at exactly 70');
  });

  it('keeps the contract large enough to hold the prefix over the cache floor', () => {
    // Haiku 4.5 silently skips caching prefixes under 4096 tokens; the
    // user-configurable prefix alone straddles that floor. Slimming the
    // contract below ~3000 chars risks disabling caching — re-measure with
    // scripts/diagnose-cache.mts --live before loosening this.
    expect(SCORING_CONTRACT.length).toBeGreaterThan(3000);
  });

  it('puts the job posting after the breakpoint', () => {
    const req = buildScoreRequest(INPUT);
    const system = (req.system as Anthropic.TextBlockParam[]).map((b) => b.text).join('');
    expect(req.messages[0].content).toContain(INPUT.jobDescription);
    expect(system).not.toContain(INPUT.jobDescription);
  });
});

describe('parseScoreResponse', () => {
  it('parses the {score, reasoning, key_matches, concerns} shape', () => {
    expect(parseScoreResponse(makeTextMessage(VALID))).toEqual({
      score: 82,
      reasoning: 'Strong fit.',
      keyMatches: ['Python'],
      concerns: ['No Go'],
      comparison: [],
      experience: null,
      parkedForReview: false,
    });
  });

  it('parses the comparison "tale of the tape" and normalizes the verdict', () => {
    const json =
      '{"score": 70, "reasoning": "x", "comparison": [' +
      '{"dimension": "Years of experience", "you": "2 yrs", "them": "5+ yrs", "verdict": "gap"},' +
      '{"dimension": "Stack", "you": "Python", "them": "Python", "verdict": "match"},' +
      '{"dimension": "Domain", "you": "Fintech", "them": "Health", "verdict": "weird"},' +
      '{"dimension": "", "you": "x", "them": "y", "verdict": "match"}]}'; // last row dropped (no dimension)
    const r = parseScoreResponse(makeTextMessage(json));
    expect(r.comparison).toEqual([
      { dimension: 'Years of experience', you: '2 yrs', them: '5+ yrs', verdict: 'gap' },
      { dimension: 'Stack', you: 'Python', them: 'Python', verdict: 'match' },
      { dimension: 'Domain', you: 'Fintech', them: 'Health', verdict: 'partial' }, // unknown → partial
    ]);
  });

  it('defaults the arrays/comparison when absent and tolerates a "reason" alias', () => {
    const r = parseScoreResponse(makeTextMessage('{"score": 40, "reason": "Weak."}'));
    expect(r).toEqual({
      score: 40,
      reasoning: 'Weak.',
      keyMatches: [],
      concerns: [],
      comparison: [],
      experience: null,
      parkedForReview: false,
    });
  });

  it('clamps and rounds the score', () => {
    expect(parseScoreResponse(makeTextMessage('{"score": 140, "reasoning": "x"}')).score).toBe(100);
    expect(parseScoreResponse(makeTextMessage('{"score": -5, "reasoning": "x"}')).score).toBe(0);
  });

  it('throws on a missing score or reasoning', () => {
    expect(() => parseScoreResponse(makeTextMessage('{"reasoning": "x"}'))).toThrow(/score/);
    expect(() => parseScoreResponse(makeTextMessage('{"score": 50}'))).toThrow(/reasoning/);
  });

  it('treats truncation as an error', () => {
    expect(() => parseScoreResponse(makeTextMessage(VALID, 'max_tokens'))).toThrow(/truncated/);
  });

  it('caps an overscored, underqualified candidate by the experience gap', () => {
    // Model claims 88 but the role needs 10+ years and the candidate has ~1.
    const json =
      '{"experience": {"required_quote": "10+ years of experience", "candidate_years": 1, "required_years": 10, "gap_years": 9},' +
      ' "score": 88, "reasoning": "Great stack."}';
    const r = parseScoreResponse(makeTextMessage(json));
    expect(r.score).toBe(30); // 5+ year gap caps at 30
    expect(r.parkedForReview).toBe(false); // stated digits: the cap is earned, never parked
    expect(r.experience).toEqual({
      requiredQuote: '10+ years of experience',
      candidateYears: 1,
      requiredYears: 10,
      gapYears: 9,
    });
  });

  it('parks an inferred big-gap requirement at exactly 70 with the review flag', () => {
    // Regression fixture: the IQ3 quant's verbatim eval reply for the
    // strong-fit synthetic-recall-none-stated-ai posting — it invented a
    // digit-free "Senior" requirement (required_years 6) on a posting that
    // states none. Raw 50 previously parsed to 30 via the gap cap and the job
    // vanished below the FR-9a threshold; FR-6a parks it at 70 instead.
    const iq3Reply = `{
    "experience": {
        "required_quote": "Production experience building LLM or RAG features users rely on",
        "candidate_years": 1.3,
        "required_years": 6,
        "gap_years": 4.7
    },
    "score": 50,
    "reasoning": "Candidate has ~1.3 years against an inferred Senior requirement of ~6 years (4.7-year gap), capping the score at ~50 despite a near-perfect technical stack match.",
    "comparison": [
        {"dimension": "Years of experience", "you": "~1.3 yrs", "them": "~6 yrs (Senior)", "verdict": "gap"},
        {"dimension": "Core Stack", "you": "Python, FastAPI, AWS", "them": "Python, FastAPI, AWS", "verdict": "match"},
        {"dimension": "RAG/Vector Search", "you": "pgvector, ChromaDB, LangGraph", "them": "pgvector, ChromaDB", "verdict": "match"},
        {"dimension": "Domain Relevance", "you": "Healthcare protocols, Contracts", "them": "Commercial leases, contracts", "verdict": "partial"},
        {"dimension": "Evaluation/Observability", "you": "LangSmith, LLM eval hooks", "them": "Eval & monitoring focus", "verdict": "match"}
    ],
    "key_matches": [
        "Python + FastAPI on AWS",
        "RAG with pgvector/ChromaDB",
        "Production LLM evaluation"
    ],
    "concerns": [
        "needs ~6 yrs, has ~1.3",
        "Senior role scope vs junior experience"
    ]
}`;
    const r = parseScoreResponse(makeTextMessage(iq3Reply));
    expect(r.score).toBe(PARKED_REVIEW_SCORE);
    expect(r.parkedForReview).toBe(true);
    expect(r.experience?.requiredYears).toBe(6); // the inference is still recorded
  });

  it('parks a "none stated" quote the same way, even when the raw score was high', () => {
    const json =
      '{"experience": {"required_quote": "none stated", "candidate_years": 1, "required_years": 6, "gap_years": 5},' +
      ' "score": 90, "reasoning": "x"}';
    const r = parseScoreResponse(makeTextMessage(json));
    expect(r.score).toBe(70); // exactly 70, not min(90, cap)
    expect(r.parkedForReview).toBe(true);
  });

  it('keeps the real score for an inferred requirement with a small gap', () => {
    // Gap of 2 caps at 70, which is not below the parking line: no flag.
    const json =
      '{"experience": {"required_quote": "none stated", "candidate_years": 1, "required_years": 3, "gap_years": 2},' +
      ' "score": 60, "reasoning": "x"}';
    const r = parseScoreResponse(makeTextMessage(json));
    expect(r.score).toBe(60);
    expect(r.parkedForReview).toBe(false);
  });

  it('still caps a stated small gap at 70 without the review flag', () => {
    const json =
      '{"experience": {"required_quote": "3+ years", "candidate_years": 1, "required_years": 3, "gap_years": 2},' +
      ' "score": 85, "reasoning": "x"}';
    const r = parseScoreResponse(makeTextMessage(json));
    expect(r.score).toBe(70); // min(85, cap 70) — capped, not parked
    expect(r.parkedForReview).toBe(false);
  });

  it('prefers the years read from the copied quote over the model’s required_years field', () => {
    // The classic failure: model copies "10+ years" but writes required_years: 1.
    const json =
      '{"experience": {"required_quote": "10+ years required", "candidate_years": 0, "required_years": 1, "gap_years": 1},' +
      ' "score": 80, "reasoning": "x"}';
    const r = parseScoreResponse(makeTextMessage(json));
    expect(r.experience?.requiredYears).toBe(10); // from the quote, not the bogus field
    expect(r.experience?.gapYears).toBe(10);
    expect(r.score).toBe(30); // gap binds even though the model under-read its own number
  });

  it('does not cap when the candidate meets or exceeds the requirement', () => {
    const json =
      '{"experience": {"required_quote": "3-5 years", "candidate_years": 6, "required_years": 3, "gap_years": -3},' +
      ' "score": 88, "reasoning": "x"}';
    expect(parseScoreResponse(makeTextMessage(json)).score).toBe(88);
  });

  it('recomputes the gap in code even when the model’s gap_years is inconsistent', () => {
    const json =
      '{"experience": {"required_quote": "5+ years", "candidate_years": 2, "required_years": 5, "gap_years": 0},' +
      ' "score": 80, "reasoning": "x"}';
    const r = parseScoreResponse(makeTextMessage(json));
    expect(r.experience?.gapYears).toBe(3);
    expect(r.score).toBe(50); // the recomputed 3-year gap binds, not the model's 0
  });

  it('round-trips the experience read: model reply → serialize → parse is identity', () => {
    const json =
      '{"experience": {"required_quote": "5+ years of backend experience", "candidate_years": 2, "required_years": 5, "gap_years": 3},' +
      ' "score": 48, "reasoning": "Solid stack, short on years."}';
    const result = parseScoreResponse(makeTextMessage(json));
    const stored = parseScoreReason(serializeScoreReason(result));
    expect(stored?.experience).toEqual(result.experience);
    expect(result.experience).toEqual({
      requiredQuote: '5+ years of backend experience',
      candidateYears: 2,
      requiredYears: 5,
      gapYears: 3,
    });
  });

  it('leaves a high score untouched when no usable experience read is present', () => {
    const json = '{"experience": {"required_quote": "Senior engineer"}, "score": 76, "reasoning": "x"}';
    const r = parseScoreResponse(makeTextMessage(json));
    expect(r.score).toBe(76);
    expect(r.experience).toBeNull(); // no number anywhere → no cap
    expect(r.parkedForReview).toBe(false); // 76 is above the parking line
  });

  it('parks a years-free reply whose numbers are unusable and whose score is low', () => {
    // No gap is computable (candidate_years arrived as a string), but the
    // prompt tells the model to self-cap inferred big gaps — a low raw score
    // here may be that self-applied cap, so it parks rather than persists.
    const json =
      '{"experience": {"required_quote": "none stated", "candidate_years": "1.3", "required_years": 6},' +
      ' "score": 30, "reasoning": "x"}';
    const r = parseScoreResponse(makeTextMessage(json));
    expect(r.score).toBe(PARKED_REVIEW_SCORE);
    expect(r.parkedForReview).toBe(true);
    expect(r.experience).toBeNull();
  });

  it('does not park an unusable experience block whose quote states years', () => {
    // A stated "5+ years" with a malformed candidate read: no cap is computable,
    // but the requirement is not an inference — raw score stands, unflagged.
    const json =
      '{"experience": {"required_quote": "5+ years", "candidate_years": "two"}, "score": 45, "reasoning": "x"}';
    const r = parseScoreResponse(makeTextMessage(json));
    expect(r.score).toBe(45);
    expect(r.parkedForReview).toBe(false);
  });
});

describe('requiredYearsFromQuote', () => {
  it('reads the floor of the requirement, never shrinking it', () => {
    expect(requiredYearsFromQuote('10+ years of experience')).toBe(10);
    expect(requiredYearsFromQuote('3-5 years building ML systems')).toBe(3);
    expect(requiredYearsFromQuote('7 to 10 years')).toBe(7);
    expect(requiredYearsFromQuote('11 years')).toBe(11);
  });

  it('returns null when the phrase names no number', () => {
    expect(requiredYearsFromQuote('Senior engineer')).toBeNull();
    expect(requiredYearsFromQuote('none stated')).toBeNull();
  });
});

describe('gapScoreCap', () => {
  it('maps the experience gap to the documented score ceiling', () => {
    expect(gapScoreCap(-2)).toBe(100);
    expect(gapScoreCap(0)).toBe(100);
    expect(gapScoreCap(2)).toBe(70);
    expect(gapScoreCap(4)).toBe(50);
    expect(gapScoreCap(5)).toBe(30);
    expect(gapScoreCap(11)).toBe(30);
  });
});

// serializeScoreReason lives with the payload's owner — see lib/score-reason.test.ts.

describe('scoreJob', () => {
  // Telemetry rows are the metering seam's job — see telemetry.test.ts.
  it('calls the client with the built request and returns the parsed result', async () => {
    const create = vi.fn().mockResolvedValue(makeTextMessage(VALID));
    const client = { messages: { create } } as unknown as Anthropic;
    const result = await scoreJob(client, INPUT);
    expect(create).toHaveBeenCalledWith(buildScoreRequest(INPUT));
    expect(result.score).toBe(82);
  });
});
