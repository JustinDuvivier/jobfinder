import { describe, it, expect } from 'vitest';
import {
  enumerateSearches,
  buildSearchUrl,
  buildDetailUrl,
  buildViewLink,
  DEFAULT_KEYWORDS,
  DEFAULT_LOCATIONS,
  FIXED_FILTERS,
  GUEST_SEARCH_ENDPOINT,
} from './search';

describe('enumerateSearches (FR-2 cross product)', () => {
  it('produces keywords × locations', () => {
    const searches = enumerateSearches(['A', 'B'], ['X', 'Y', 'Z']);
    expect(searches).toHaveLength(6);
  });

  it('is keyword-major, location-minor and stable', () => {
    expect(enumerateSearches(['A', 'B'], ['X', 'Y'])).toEqual([
      { keywords: 'A', location: 'X' },
      { keywords: 'A', location: 'Y' },
      { keywords: 'B', location: 'X' },
      { keywords: 'B', location: 'Y' },
    ]);
  });

  it('covers the documented default set (6 keywords × 2 locations = 12)', () => {
    expect(enumerateSearches(DEFAULT_KEYWORDS, DEFAULT_LOCATIONS)).toHaveLength(12);
  });

  it('returns empty when either dimension is empty', () => {
    expect(enumerateSearches([], DEFAULT_LOCATIONS)).toEqual([]);
    expect(enumerateSearches(DEFAULT_KEYWORDS, [])).toEqual([]);
  });
});

describe('buildSearchUrl', () => {
  it('builds the exact guest endpoint with fixed filters and the start offset', () => {
    const url = buildSearchUrl({ keywords: 'AI Engineer', location: 'New York' }, 0);
    expect(url).toBe(
      `${GUEST_SEARCH_ENDPOINT}?keywords=AI+Engineer&location=New+York&f_TPR=r3600&f_JT=F&f_E=2%2C3&start=0`,
    );
  });

  it('carries the pagination offset', () => {
    const url = buildSearchUrl({ keywords: 'ML Engineer', location: 'New Jersey' }, 50);
    expect(url).toContain('start=50');
  });

  it('applies the documented fixed filters', () => {
    const url = buildSearchUrl({ keywords: 'x', location: 'y' }, 0);
    expect(url).toContain(`f_TPR=${FIXED_FILTERS.timePostedRange}`);
    expect(url).toContain(`f_JT=${FIXED_FILTERS.jobType}`);
    expect(url).toContain('f_E=2%2C3'); // 2,3 url-encoded
  });
});

describe('buildDetailUrl / buildViewLink', () => {
  it('builds the detail endpoint for a job id', () => {
    expect(buildDetailUrl('4012345678')).toBe(
      'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4012345678',
    );
  });

  it('builds the human-facing view link', () => {
    expect(buildViewLink('4012345678')).toBe(
      'https://www.linkedin.com/jobs/view/4012345678',
    );
  });
});
