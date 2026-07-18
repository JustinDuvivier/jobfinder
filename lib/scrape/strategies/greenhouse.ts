/**
 * Greenhouse strategy — pulls Greenhouse-sourced jobs from the fantastic.jobs
 * "Active Jobs DB" aggregator and yields them as card-level `RawJob` records.
 *
 * It is the drop-in analog of the LinkedIn guest strategy: given the same
 * keywords/locations config it walks each search (keyword × location), requests
 * the aggregator's `active-ats` endpoint restricted to Greenhouse (`source=
 * greenhouse`), paginates by `offset`, deduplicates by aggregator job id within
 * the run, and stops at `maxCount`. `fetch` and `sleep` are injectable so the
 * pagination, dedup, and 429 backoff are unit-testable without the network.
 *
 * Unlike LinkedIn, the search response is already complete — it carries the
 * description (requested as text) and the real Greenhouse posting URL — so
 * `fetchDetail` is a no-op and each record's `url` is always populated from the
 * response (the pipeline's LinkedIn-URL fallback must never apply).
 *
 * Auth note: the provisioned key (`RAPID_API_KEY`) is a direct fantastic.jobs
 * data-API key (Zuplo-gated at `data.fantastic.jobs`), not a RapidAPI
 * marketplace key, so requests authenticate with `Authorization: Bearer <key>`
 * against `data.fantastic.jobs/v1/active-ats`. The RapidAPI proxy variant of the
 * same API (host header + `X-RapidAPI-Key`) is documented but not used, because
 * this key is not subscribed there. See jobfinder-docs.md "Strategy — Scraping".
 */
import type { ScraperStrategy, JobDetail } from '../strategy';
import type { RawJob } from '../pipeline';
import { enumerateSearches, DEFAULT_LOOKBACK_HOURS, type SearchConfig } from '../search';

/** The direct fantastic.jobs data-API base (Zuplo gateway). */
export const ACTIVE_ATS_ENDPOINT = 'https://data.fantastic.jobs/v1/active-ats';

/** The ATS source this strategy restricts to. */
export const GREENHOUSE_SOURCE = 'greenhouse';

/** Aggregator page size (the endpoint's `limit`); the docs suggest 100–1000. */
export const DEFAULT_PAGE_SIZE = 100;

export interface GreenhouseStrategyOptions {
  /** Injectable fetch (defaults to global fetch). */
  fetchFn?: typeof fetch;
  /** Injectable sleep (defaults to a real timer); lets tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Direct fantastic.jobs data-API key. Defaults to `process.env.RAPID_API_KEY`. */
  apiKey?: string;
  /** Look-back window in hours; mapped to the endpoint's `time_frame` bucket. */
  lookbackHours?: number;
  /** Per-search pagination cap (number of records), rounded up to a page. */
  maxPerSearch?: number;
  /** Records requested per page (the endpoint's `limit`). */
  pageSize?: number;
  /** Polite delay between requests, ms. */
  requestDelayMs?: number;
  /** Max 429 retries before giving up on a request. */
  maxRetries?: number;
  /** Endpoint override (tests point this at a mock; defaults to the live API). */
  endpoint?: string;
}

/**
 * The subset of an Active Jobs DB item this strategy reads. The response has
 * ~50 fields; only these feed a `RawJob`. All optional — the mapper drops any
 * item without an id and guards every field it reads.
 */
interface ActiveAtsJob {
  id?: number | string;
  title?: string;
  organization?: string;
  url?: string;
  locations_derived?: unknown;
  salary?: unknown;
  description_text?: string;
  date_posted?: string;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Trim to a non-empty string, or undefined. */
function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** First derived location string (`"City, Region, Country"`), if any. */
function primaryLocation(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    const loc = nonEmpty(entry);
    if (loc) return loc;
  }
  return undefined;
}

/**
 * Map the endpoint's `time_frame` bucket from a look-back window in hours. The
 * endpoint exposes fixed buckets (`1h`, `24h`, `7d`, `6m`); pick the smallest
 * bucket that still covers the requested window.
 */
export function timeFrameForLookback(hours: number): string {
  const h = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_LOOKBACK_HOURS;
  if (h <= 1) return '1h';
  if (h <= 24) return '24h';
  if (h <= 24 * 7) return '7d';
  return '6m';
}

/**
 * Pure response → `RawJob[]` mapping, exported so the golden test can exercise
 * it directly. Namespaces the id as `gh:<aggregatorId>` and always populates the
 * real Greenhouse posting `url` from the response. Non-array input, and items
 * lacking an id, yield nothing.
 */
export function mapActiveAtsResponse(json: unknown): RawJob[] {
  if (!Array.isArray(json)) return [];
  const jobs: RawJob[] = [];
  for (const raw of json as ActiveAtsJob[]) {
    if (raw == null || typeof raw !== 'object') continue;
    const id = raw.id;
    if (id == null || (typeof id !== 'number' && typeof id !== 'string')) continue;

    const job: RawJob = { jobId: `gh:${id}` };
    const title = nonEmpty(raw.title);
    if (title) job.title = title;
    const company = nonEmpty(raw.organization);
    if (company) job.company = company;
    const url = nonEmpty(raw.url);
    if (url) job.url = url;
    const location = primaryLocation(raw.locations_derived);
    if (location) job.location = location;
    const salary = nonEmpty(raw.salary);
    if (salary) job.salary = salary;
    const description = nonEmpty(raw.description_text);
    if (description) job.description = description;
    const postedAt = nonEmpty(raw.date_posted);
    if (postedAt) job.postedAt = postedAt;

    jobs.push(job);
  }
  return jobs;
}

export class GreenhouseStrategy implements ScraperStrategy {
  readonly name = 'greenhouse' as const;

  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly apiKey: string;
  private readonly lookbackHours: number;
  private readonly maxPerSearch: number;
  private readonly pageSize: number;
  private readonly requestDelayMs: number;
  private readonly maxRetries: number;
  private readonly endpoint: string;

  constructor(options: GreenhouseStrategyOptions = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.sleep = options.sleep ?? realSleep;
    this.apiKey = options.apiKey ?? process.env.RAPID_API_KEY ?? '';
    this.lookbackHours = options.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
    this.maxPerSearch = options.maxPerSearch ?? 100;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.requestDelayMs = options.requestDelayMs ?? 1500;
    this.maxRetries = options.maxRetries ?? 3;
    this.endpoint = options.endpoint ?? ACTIVE_ATS_ENDPOINT;
  }

  async *scrape(config: SearchConfig, maxCount: number): AsyncIterable<RawJob> {
    const seen = new Set<string>();
    const timeFrame = timeFrameForLookback(this.lookbackHours);
    let yielded = 0;

    for (const search of enumerateSearches(config.keywords, config.locations)) {
      for (let offset = 0; offset < this.maxPerSearch; offset += this.pageSize) {
        const page = await this.getPage(search.keywords, search.location, timeFrame, offset);
        const jobs = mapActiveAtsResponse(page);
        if (jobs.length === 0) break; // empty page → end of this search

        for (const job of jobs) {
          if (!job.jobId || seen.has(job.jobId)) continue; // dedup across searches (FR-3)
          seen.add(job.jobId);
          yield job;
          if (++yielded >= maxCount) return;
        }

        // A short page means the aggregator has no more for this search.
        if (jobs.length < this.pageSize) break;
        await this.sleep(this.requestDelayMs); // pace requests politely
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetchDetail(_jobId: string): Promise<JobDetail> {
    // The Active Jobs DB search response is already complete (description +
    // salary + URL), so there is nothing to enrich.
    return {};
  }

  /** Build the request URL for one search page. */
  private buildUrl(title: string, location: string, timeFrame: string, offset: number): string {
    const params = new URLSearchParams({
      time_frame: timeFrame,
      title,
      location,
      source: GREENHOUSE_SOURCE,
      description_format: 'text',
      limit: String(this.pageSize),
      offset: String(offset),
    });
    return `${this.endpoint}?${params.toString()}`;
  }

  /**
   * Fetch one search page, retrying on 429 with backoff. A non-429 error status
   * is treated as an empty page (ends the current search) rather than aborting
   * the whole scrape; exhausting 429 retries throws so the route can mark the
   * scrape session failed. Mirrors the LinkedIn strategy's backoff shape.
   */
  private async getPage(
    title: string,
    location: string,
    timeFrame: string,
    offset: number,
  ): Promise<unknown> {
    const url = this.buildUrl(title, location, timeFrame, offset);
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
        },
      });

      if (res.status === 429) {
        if (attempt >= this.maxRetries) {
          throw new Error(`Greenhouse aggregator rate limited (429) after ${this.maxRetries} retries`);
        }
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.requestDelayMs;
        await this.sleep(waitMs);
        continue;
      }

      if (!res.ok) return []; // error/empty → treat as end of this search
      try {
        return await res.json();
      } catch {
        return []; // malformed body → end of this search
      }
    }
  }
}
