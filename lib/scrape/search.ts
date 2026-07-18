/**
 * Deterministic search enumeration and guest-API URL building (FR-2).
 *
 * The LinkedIn guest strategy runs a fixed set of saved searches: the cross
 * product of the configured keywords and locations, each with the same fixed
 * filters (last 24h, full-time, entry + associate). The same posting often
 * appears under more than one keyword, so deduplication is by job_id and runs
 * across all searches (handled by the pipeline's deduplicator, FR-3).
 *
 * Everything here is pure and side-effect free, so it is exhaustively testable.
 * See jobfinder-docs.md "Endpoints and searches".
 */

/** Fixed query filters applied to every search. */
export interface SearchFilters {
  /** f_TPR — time posted range. r86400 = last 24 hours. */
  timePostedRange: string;
  /** f_JT — job type. F = full-time. */
  jobType: string;
  /** f_E — experience level. 2,3 = entry-level + associate. */
  experienceLevel: string;
}

/** Default look-back window in hours (LinkedIn f_TPR). Configurable in Settings. */
export const DEFAULT_LOOKBACK_HOURS = 1;

/** Build the filters for a given look-back window (hours). Full-time, entry+associate. */
export function filtersForLookback(hours: number): SearchFilters {
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_LOOKBACK_HOURS;
  return {
    timePostedRange: `r${Math.round(safeHours * 3600)}`,
    jobType: 'F',
    experienceLevel: '2,3',
  };
}

/** Default filters: last 1 hour, full-time, entry + associate. */
export const FIXED_FILTERS: SearchFilters = filtersForLookback(DEFAULT_LOOKBACK_HOURS);

/** The documented default keyword set. */
export const DEFAULT_KEYWORDS: readonly string[] = [
  'AI Engineer',
  'Machine Learning Engineer',
  'ML Engineer',
  'Software Engineer',
  'Forward Deployed Engineer',
  'Solutions Engineer',
];

/** The documented default location set. */
export const DEFAULT_LOCATIONS: readonly string[] = ['New York', 'New Jersey'];

/**
 * Default title-exclusion terms (FR-4a). LinkedIn's experience-level filter
 * (f_E) is poster-tagged and leaky, so over-senior postings slip into keyword
 * results; these whole-word terms drop everything above mid-level while keeping
 * entry / junior / associate / mid roles. User-editable in Settings; an empty
 * list disables title filtering.
 */
export const DEFAULT_EXCLUDED_TITLE_TERMS: readonly string[] = [
  'senior',
  'sr',
  'staff',
  'principal',
  'lead',
  'manager',
  'director',
  'head of',
  'vp',
  'chief',
  'scientist',
];

/** The guest job-search endpoint that backs the logged-out browse experience. */
export const GUEST_SEARCH_ENDPOINT =
  'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';

/** The guest job-detail endpoint (full description + criteria) for one job. */
export const GUEST_DETAIL_ENDPOINT =
  'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';

/** The human-facing view link base, stored on the job row. */
export const VIEW_LINK_BASE = 'https://www.linkedin.com/jobs/view';

/** Pagination step: LinkedIn pages the guest API in blocks of 25. */
export const PAGE_SIZE = 25;

/** The keywords/locations a scrape runs over (FR-25 saved-search inputs). */
export interface SearchConfig {
  keywords: readonly string[];
  locations: readonly string[];
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  keywords: DEFAULT_KEYWORDS,
  locations: DEFAULT_LOCATIONS,
};

/** One concrete search: a single keyword paired with a single location. */
export interface Search {
  keywords: string;
  location: string;
}

/**
 * Enumerate the cross product of keywords × locations (FR-2). Order is stable:
 * keyword-major, location-minor, matching the iteration the scraper walks.
 */
export function enumerateSearches(
  keywords: readonly string[],
  locations: readonly string[],
): Search[] {
  const searches: Search[] = [];
  for (const keywords_ of keywords) {
    for (const location of locations) {
      searches.push({ keywords: keywords_, location });
    }
  }
  return searches;
}

/**
 * Build the guest search URL for one search at a given pagination offset.
 * URLSearchParams handles all escaping, so callers pass raw human strings.
 */
export function buildSearchUrl(
  search: Search,
  start: number,
  filters: SearchFilters = FIXED_FILTERS,
): string {
  const params = new URLSearchParams({
    keywords: search.keywords,
    location: search.location,
    f_TPR: filters.timePostedRange,
    f_JT: filters.jobType,
    f_E: filters.experienceLevel,
    start: String(start),
  });
  return `${GUEST_SEARCH_ENDPOINT}?${params.toString()}`;
}

/** Build the guest detail URL for a single job id. */
export function buildDetailUrl(jobId: string): string {
  return `${GUEST_DETAIL_ENDPOINT}/${encodeURIComponent(jobId)}`;
}

/** Build the human-facing view link stored on the job row. */
export function buildViewLink(jobId: string): string {
  return `${VIEW_LINK_BASE}/${encodeURIComponent(jobId)}`;
}
