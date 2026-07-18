/**
 * LinkedIn Guest API strategy (the default, production strategy).
 *
 * Issues plain HTTP requests to the public guest endpoints and parses the
 * returned HTML — no browser, no login, no session cookies, so there is no
 * account to suspend. It walks each saved search's pages via `start`, parses
 * the cards, deduplicates by job id within the run, and yields card-level
 * records; the route enriches survivors via `fetchDetail`.
 *
 * Because it is unauthenticated, rate limiting is IP-based: it sets a realistic
 * User-Agent, paces requests with a delay, and backs off on 429 (honoring
 * Retry-After). `fetch` and `sleep` are injectable so the pagination, dedup,
 * and backoff logic are unit-testable without the network.
 *
 * See jobfinder-docs.md "Strategy B — LinkedIn Guest API" and "Known
 * Limitations — LinkedIn scraping detection".
 */
import type { ScraperStrategy } from '../strategy';
import type { RawJob } from '../pipeline';
import { parseJobCards, parseJobDetail, type JobDetail } from '../linkedin-parser';
import {
  buildSearchUrl,
  buildDetailUrl,
  enumerateSearches,
  PAGE_SIZE,
  type SearchConfig,
  type SearchFilters,
  FIXED_FILTERS,
} from '../search';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface LinkedInStrategyOptions {
  /** Injectable fetch (defaults to global fetch). */
  fetchFn?: typeof fetch;
  /** Injectable sleep (defaults to a real timer); lets tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
  /** Polite delay between requests, ms. */
  requestDelayMs?: number;
  /** Per-search pagination cap (number of cards), rounded up to a page. */
  maxPerSearch?: number;
  /** Max 429 retries before giving up on a request. */
  maxRetries?: number;
  filters?: SearchFilters;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class LinkedInStrategy implements ScraperStrategy {
  readonly name = 'linkedin' as const;

  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly userAgent: string;
  private readonly requestDelayMs: number;
  private readonly maxPerSearch: number;
  private readonly maxRetries: number;
  private readonly filters: SearchFilters;

  constructor(options: LinkedInStrategyOptions = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.sleep = options.sleep ?? realSleep;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.requestDelayMs = options.requestDelayMs ?? 1500;
    this.maxPerSearch = options.maxPerSearch ?? 100;
    this.maxRetries = options.maxRetries ?? 3;
    this.filters = options.filters ?? FIXED_FILTERS;
  }

  async *scrape(config: SearchConfig, maxCount: number): AsyncIterable<RawJob> {
    const seen = new Set<string>();
    let yielded = 0;

    for (const search of enumerateSearches(config.keywords, config.locations)) {
      for (let start = 0; start < this.maxPerSearch; start += PAGE_SIZE) {
        const html = await this.getSearchPage(buildSearchUrl(search, start, this.filters));
        const cards = parseJobCards(html);
        if (cards.length === 0) break; // empty page → end of this search

        for (const card of cards) {
          if (!card.jobId || seen.has(card.jobId)) continue; // dedup across searches (FR-3)
          seen.add(card.jobId);
          yield card;
          if (++yielded >= maxCount) return;
        }

        await this.sleep(this.requestDelayMs); // pace requests politely
      }
    }
  }

  async fetchDetail(jobId: string): Promise<JobDetail> {
    const res = await this.fetchFn(buildDetailUrl(jobId), {
      headers: { 'User-Agent': this.userAgent },
    });
    if (!res.ok) return {};
    return parseJobDetail(await res.text());
  }

  /**
   * Fetch one search page, retrying on 429 with backoff. A non-429 error status
   * is treated as an empty page (ends the current search) rather than aborting
   * the whole scrape; exhausting 429 retries throws so the route can mark the
   * scrape session failed.
   */
  private async getSearchPage(url: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(url, { headers: { 'User-Agent': this.userAgent } });

      if (res.status === 429) {
        if (attempt >= this.maxRetries) {
          throw new Error(`LinkedIn rate limited (429) after ${this.maxRetries} retries`);
        }
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : this.requestDelayMs;
        await this.sleep(waitMs);
        continue;
      }

      if (!res.ok) return ''; // blocked/empty → treat as end of this search
      return res.text();
    }
  }
}
