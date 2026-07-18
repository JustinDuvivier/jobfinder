/**
 * effectiveConfig resolution tests: DB config wins when a field is non-empty,
 * an empty/blank field falls back to the authored resume/ asset, and a missing
 * resume/ folder degrades to whatever the config holds instead of throwing.
 * loadResumeAssets is mocked — the file-reading itself is covered by
 * resume/load.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CONFIG } from '../test-fixtures';
import type { UserConfig } from '../types';

const { loadResumeAssetsMock } = vi.hoisted(() => ({ loadResumeAssetsMock: vi.fn() }));
vi.mock('../resume/load', () => ({ loadResumeAssets: loadResumeAssetsMock }));

import { effectiveConfig } from './effective';

const ASSETS = {
  baseResume: 'file resume',
  sourceOfTruth: 'file truth',
  scoringPrompt: 'file scoring prompt',
  rewriteRules: 'file rewrite rules',
};

function config(overrides: Partial<UserConfig> = {}): UserConfig {
  return {
    ...CONFIG,
    resumeLatex: 'db resume',
    sourceOfTruth: 'db truth',
    scoringPrompt: 'db scoring prompt',
    rewriteRules: 'db rewrite rules',
    ...overrides,
  };
}

beforeEach(() => {
  loadResumeAssetsMock.mockReset();
  loadResumeAssetsMock.mockReturnValue(ASSETS);
});

describe('effectiveConfig', () => {
  it('prefers DB config over file assets for every field', () => {
    expect(effectiveConfig(config())).toEqual({
      resumeLatex: 'db resume',
      sourceOfTruth: 'db truth',
      scoringPrompt: 'db scoring prompt',
      rewriteRules: 'db rewrite rules',
    });
  });

  it('falls back to file assets when there is no config row', () => {
    expect(effectiveConfig(undefined)).toEqual({
      resumeLatex: 'file resume',
      sourceOfTruth: 'file truth',
      scoringPrompt: 'file scoring prompt',
      rewriteRules: 'file rewrite rules',
    });
  });

  it('falls back per field: empty or blank config fields use the asset, set fields win', () => {
    const result = effectiveConfig(config({ resumeLatex: '', scoringPrompt: '   \n' }));
    expect(result).toEqual({
      resumeLatex: 'file resume',
      sourceOfTruth: 'db truth',
      scoringPrompt: 'file scoring prompt',
      rewriteRules: 'db rewrite rules',
    });
  });

  it('survives missing resume/ assets by relying on config alone', () => {
    loadResumeAssetsMock.mockImplementation(() => {
      throw new Error('Missing resume asset: resume/base_resume.tex');
    });
    expect(effectiveConfig(config())).toEqual({
      resumeLatex: 'db resume',
      sourceOfTruth: 'db truth',
      scoringPrompt: 'db scoring prompt',
      rewriteRules: 'db rewrite rules',
    });
  });

  it('yields empty fields when assets are missing and config is empty too', () => {
    loadResumeAssetsMock.mockImplementation(() => {
      throw new Error('Missing resume asset: resume/base_resume.tex');
    });
    expect(effectiveConfig(undefined)).toEqual({
      resumeLatex: '',
      sourceOfTruth: '',
      scoringPrompt: '',
      rewriteRules: '',
    });
  });
});
