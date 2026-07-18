/**
 * Tests for the effective-config adapter: the camelCase mapping over the
 * per-asset resolution, and the broken-checkout fallback to empty strings.
 * resolveResumeAssets is mocked — the three-layer resolution itself (in-app →
 * resume/ file → example) is covered by lib/resume/load.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DB } from '../db';

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));
vi.mock('../resume/load', () => ({ resolveResumeAssets: resolveMock }));

import { effectiveConfig } from './effective';

const DB_STUB = {} as DB;

beforeEach(() => {
  resolveMock.mockReset();
});

describe('effectiveConfig', () => {
  it('maps each resolved asset to its camelCase field', () => {
    resolveMock.mockReturnValue({
      base_resume: { content: 'tex', provenance: 'in-app' },
      source_of_truth: { content: 'truth', provenance: 'file' },
      scoring_prompt: { content: 'score', provenance: 'example' },
      rewrite_rules: { content: 'rules', provenance: 'example' },
    });
    expect(effectiveConfig(DB_STUB)).toEqual({
      resumeLatex: 'tex',
      sourceOfTruth: 'truth',
      scoringPrompt: 'score',
      rewriteRules: 'rules',
    });
    expect(resolveMock).toHaveBeenCalledWith(DB_STUB);
  });

  it('returns empty strings when resolution throws (broken checkout)', () => {
    resolveMock.mockImplementation(() => {
      throw new Error('Missing resume asset: resume/base_resume.tex');
    });
    expect(effectiveConfig(DB_STUB)).toEqual({
      resumeLatex: '',
      sourceOfTruth: '',
      scoringPrompt: '',
      rewriteRules: '',
    });
  });
});
