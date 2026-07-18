/**
 * Scraper Strategy interface and factory.
 *
 * The scraper has genuinely different implementations — static demo data, an
 * HTTP client against LinkedIn's guest job API, and the Proxycurl paid API —
 * with different dependencies and failure modes. Each satisfies the same
 * interface: given the saved searches and a maximum count, yield job records;
 * and, separately, fetch the per-job detail used to enrich a surviving job.
 *
 * The active strategy name comes from Setup; the /api/scrape handler calls
 * `createStrategy` to instantiate the matching one — swapping strategies is a
 * configuration change, not a code change.
 *
 * See jobfinder-docs.md "Strategy — Scraping" and PRD FR-1.
 */
import type { ScraperStrategyName } from '../types';
import type { RawJob } from './pipeline';
import type { JobDetail } from './linkedin-parser';
import type { SearchConfig } from './search';
import { DemoStrategy } from './strategies/demo';
import { LinkedInStrategy, type LinkedInStrategyOptions } from './strategies/linkedin';

export type { JobDetail } from './linkedin-parser';

/**
 * The strategy names a `ScraperStrategy` may report. `ScraperStrategyName` is the
 * set selectable as the primary scraper in Setup; `'greenhouse'` is an
 * orthogonal aggregator source (fantastic.jobs Active Jobs DB) that satisfies the
 * same interface but is wired in alongside the primary strategy rather than
 * chosen in Setup, so it is not part of `ScraperStrategyName` or the factory.
 */
export type StrategyName = ScraperStrategyName | 'greenhouse';

export interface ScraperStrategy {
  readonly name: StrategyName;
  /**
   * Yield search-card-level job records across the cross product of searches,
   * deduplicating by job id within the run and stopping at `maxCount`.
   */
  scrape(config: SearchConfig, maxCount: number): AsyncIterable<RawJob>;
  /**
   * Fetch per-job detail (description, salary) for a surviving job. Strategies
   * whose `scrape` already returns complete records return an empty object.
   */
  fetchDetail(jobId: string): Promise<JobDetail>;
}

export interface CreateStrategyOptions {
  linkedin?: LinkedInStrategyOptions;
}

/** Instantiate the strategy matching the configured name. */
export function createStrategy(
  name: ScraperStrategyName,
  options: CreateStrategyOptions = {},
): ScraperStrategy {
  switch (name) {
    case 'demo':
      return new DemoStrategy();
    case 'linkedin':
      return new LinkedInStrategy(options.linkedin);
    case 'proxycurl':
      // Documented fallback: switch to it only if the guest endpoints get
      // IP-blocked or volume outgrows safe request rates. Implement when needed.
      throw new Error(
        'Proxycurl strategy is a documented fallback and is not yet implemented; ' +
          'use the LinkedIn guest API (default).',
      );
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown scraper strategy: ${String(exhaustive)}`);
    }
  }
}
