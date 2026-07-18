/**
 * The scrape execution, factored out of the `/api/scrape` route so it can run
 * both interactively (the route streams `onJob` over SSE) and headlessly (the
 * backend scheduler calls it with no callback). Runs each configured source —
 * the primary strategy, plus Greenhouse when enabled — through the SAME
 * Chain-of-Responsibility pipeline into one merged decision queue: every source
 * is deduped and title-filtered by the same rules (cross-source dedup works
 * because the `exists` check spans all sources and the `gh:` id namespace keeps
 * ids collision-free), enriched with its detail fetch, inserted with its own
 * provenance, and counted per-source. Each source opens its own
 * `scrape_sessions` row and gets its own `MAX_JOBS` budget.
 *
 * See jobfinder-docs.md "Scraping" and "Scheduled scraping".
 */
import type { DB } from '@/lib/db';
import type { JobSource, ScraperStrategyName } from '@/lib/types';
import type { SearchFilters } from '@/lib/scrape/search';
import * as repo from '@/lib/db/repo';
import { createStrategy, type ScraperStrategy } from '@/lib/scrape/strategy';
import { GreenhouseStrategy } from '@/lib/scrape/strategies/greenhouse';
import { hasRapidApiKey, getRapidApiKey } from '@/lib/env/rapidapi';
import { runScrapePipeline, titleMatchesExcludedTerm } from '@/lib/scrape/pipeline';
import { resolveSalary } from '@/lib/salary';
import {
  DEFAULT_KEYWORDS,
  DEFAULT_LOCATIONS,
  DEFAULT_LOOKBACK_HOURS,
  filtersForLookback,
} from '@/lib/scrape/search';

const MAX_JOBS = 75;

/** The shape streamed to the browser for each newly inserted job. */
export interface InsertedJob {
  id: number;
  jobId: string;
  company: string;
  title: string;
  location: string | null;
  salary: string | null;
  url: string;
  source: JobSource;
  postedAt: string | null;
  seniorityLevel: string | null;
  employmentType: string | null;
  jobFunction: string | null;
  industries: string | null;
  applicants: string | null;
}

/** Per-source found/blocked/inserted counts for one scrape run. */
export interface SourceScrapeCounts {
  source: JobSource;
  found: number;
  blocked: number;
  inserted: number;
}

export interface ScrapeSummary {
  /** Totals across every source that ran (back-compat with existing callers). */
  found: number;
  blocked: number;
  inserted: number;
  /** One entry per source that actually ran, in run order. */
  bySource: SourceScrapeCounts[];
  /** Non-fatal notices, e.g. Greenhouse enabled but the key is missing. */
  warnings: string[];
}

export interface RunScrapeOptions {
  /** Called for each job inserted, in order — used to stream progress over SSE. */
  onJob?: (job: InsertedJob) => void;
}

/** One source to scrape in a run: its strategy and the provenance to record. */
interface SourceRun {
  strategy: ScraperStrategy;
  source: JobSource;
}

/** Dependencies a per-source run shares across the whole scrape. */
interface SourceRunDeps {
  keywords: string[];
  locations: string[];
  blocked: Set<string>;
  excludedTitleTerms: string[];
  onJob?: (job: InsertedJob) => void;
}

/**
 * Run one source end-to-end: open its scrape session, pass each raw job through
 * the shared pipeline, enrich survivors, insert them with the source's
 * provenance, stream `onJob`, and close the session with its own counts. Errors
 * fail this source's session and rethrow (preserving the run's failure behavior).
 */
async function runSource(
  db: DB,
  { strategy, source }: SourceRun,
  deps: SourceRunDeps,
): Promise<SourceScrapeCounts> {
  const sessionId = repo.createScrapeSession(db, strategy.name);
  let found = 0;
  let blocked = 0;
  let inserted = 0;
  try {
    for await (const raw of strategy.scrape(
      { keywords: deps.keywords, locations: deps.locations },
      MAX_JOBS,
    )) {
      found += 1;
      const result = runScrapePipeline(raw, {
        isBlocked: (name) => deps.blocked.has(name),
        exists: (jobId) => repo.getJobByJobId(db, jobId) !== undefined,
        isExcludedTitle: (title) => titleMatchesExcludedTerm(title, deps.excludedTitleTerms),
      });
      if (result.kind === 'dropped') {
        if (result.stage === 'blocklist') blocked += 1;
        continue;
      }

      // Enrich survivors with the detail fetch (best-effort). Greenhouse's
      // fetchDetail is a no-op, so this leaves its already-complete records as-is.
      let job = result.job;
      try {
        const detail = await strategy.fetchDetail(job.jobId);
        const description = detail.description ?? job.description;
        // Resolve once more now that the detail is in: its dedicated salary
        // block outranks the card value as the field tier, and the fetched
        // description is minable prose. The resolver is idempotent over its
        // own output, so a detail that adds nothing changes nothing.
        const { salary } = resolveSalary({ field: detail.salary || job.salary, description });
        job = {
          ...job,
          description,
          salary,
          seniorityLevel: detail.seniorityLevel ?? job.seniorityLevel,
          employmentType: detail.employmentType ?? job.employmentType,
          jobFunction: detail.jobFunction ?? job.jobFunction,
          industries: detail.industries ?? job.industries,
          applicants: detail.applicants ?? job.applicants,
        };
      } catch {
        // detail enrichment is non-fatal
      }

      const id = repo.insertJob(db, job, source);
      inserted += 1;
      deps.onJob?.({
        id,
        jobId: job.jobId,
        company: job.company,
        title: job.title,
        location: job.location,
        salary: job.salary,
        url: job.url,
        source,
        postedAt: job.postedAt,
        seniorityLevel: job.seniorityLevel,
        employmentType: job.employmentType,
        jobFunction: job.jobFunction,
        industries: job.industries,
        applicants: job.applicants,
      });
    }
    repo.finishScrapeSession(db, sessionId, {
      found,
      blocked,
      inserted,
      status: 'completed',
    });
    return { source, found, blocked, inserted };
  } catch (err) {
    repo.finishScrapeSession(db, sessionId, {
      found,
      blocked,
      inserted,
      status: 'failed',
      error: (err as Error).message,
    });
    throw err;
  }
}

/**
 * Build the ordered list of sources for this run: the primary strategy always,
 * plus Greenhouse iff it is enabled AND the key is present. An enabled-but-keyless
 * Greenhouse is surfaced as a warning rather than silently skipped.
 */
function buildSourceRuns(
  strategyName: ScraperStrategyName,
  filters: SearchFilters,
  greenhouseEnabled: boolean,
  lookbackHours: number,
  warnings: string[],
): SourceRun[] {
  const runs: SourceRun[] = [
    { strategy: createStrategy(strategyName, { linkedin: { filters } }), source: 'linkedin' },
  ];
  if (greenhouseEnabled) {
    if (hasRapidApiKey()) {
      runs.push({
        strategy: new GreenhouseStrategy({ apiKey: getRapidApiKey(), lookbackHours }),
        source: 'greenhouse',
      });
    } else {
      warnings.push('Greenhouse is enabled but RAPID_API_KEY is not set — skipped.');
    }
  }
  return runs;
}

export async function runScrape(db: DB, opts: RunScrapeOptions = {}): Promise<ScrapeSummary> {
  const config = repo.getUserConfig(db);
  const strategyName = config?.scraperStrategy ?? 'linkedin';
  const keywords = config?.keywords.length ? config.keywords : [...DEFAULT_KEYWORDS];
  const locations = config?.locations.length ? config.locations : [...DEFAULT_LOCATIONS];

  const lookbackHours = config?.searchLookbackHours || DEFAULT_LOOKBACK_HOURS;
  const filters = filtersForLookback(lookbackHours);

  const blocked = new Set(repo.listBlockedCompanies(db));
  // Over-seniority title exclusion (FR-4a). An empty list disables the filter,
  // so an explicit clear in Settings is honored rather than coerced back on.
  const excludedTitleTerms = config?.excludedTitleTerms ?? [];

  const warnings: string[] = [];
  const sourceRuns = buildSourceRuns(
    strategyName,
    filters,
    config?.greenhouseEnabled ?? false,
    lookbackHours,
    warnings,
  );

  const deps: SourceRunDeps = {
    keywords,
    locations,
    blocked,
    excludedTitleTerms,
    onJob: opts.onJob,
  };

  const bySource: SourceScrapeCounts[] = [];
  for (const run of sourceRuns) {
    bySource.push(await runSource(db, run, deps));
  }

  const totals = bySource.reduce(
    (acc, s) => ({
      found: acc.found + s.found,
      blocked: acc.blocked + s.blocked,
      inserted: acc.inserted + s.inserted,
    }),
    { found: 0, blocked: 0, inserted: 0 },
  );

  return { ...totals, bySource, warnings };
}
