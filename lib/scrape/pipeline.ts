/**
 * Scrape pipeline — a Chain of Responsibility with six ordered handlers that
 * every scraped job passes through before being written to SQLite. The order
 * is chosen to fail fast and avoid unnecessary work:
 *
 *   1. field parser        — map raw scraped data to the Job schema; drop if it
 *                            cannot extract a job id, title, or company.
 *   2. title filter        — drop over-seniority titles (FR-4a) — "Senior",
 *                            "Staff", "Lead", … — before any DB hit. LinkedIn's
 *                            experience-level filter is poster-tagged and leaky,
 *                            so a keyword search for "Software Engineer" still
 *                            returns "Senior Software Engineer"; this catches
 *                            them by title regardless.
 *   3. blocklist filter    — drop blocked companies (FR-4), before any DB hit
 *                            and long before scoring (the cheapest discard).
 *   4. deduplicator        — drop jobs already in SQLite (FR-3); runs after the
 *                            in-memory filters so the DB is never queried for
 *                            a job already being discarded.
 *   5. required-field validator — final safety net on required columns.
 *   6. salary normalizer   — resolve the salary through the salary resolver
 *                            (lib/salary: field → description prose); never
 *                            drops. Applied only to surviving, valid jobs.
 *
 * A drop short-circuits: no later handler runs. The title filter, blocklist,
 * and deduplicator read injected dependencies (predicates and an existence
 * check) so the handlers stay pure and testable.
 *
 * See jobfinder-docs.md "Chain of Responsibility — Scrape pipeline" and
 * "LinkedIn Scraping — Backend Integration"; PRD FR-3/FR-4/FR-4a.
 */
import { normalizeCompanyName } from '../companies';
import { resolveSalary } from '../salary';

/** A raw, loosely-typed job record as yielded by a scraper Strategy. */
export interface RawJob {
  jobId?: string;
  title?: string;
  company?: string;
  location?: string;
  salary?: string;
  description?: string;
  url?: string;
  postedAt?: string;
  seniorityLevel?: string;
  employmentType?: string;
  jobFunction?: string;
  industries?: string;
  applicants?: string;
}

/** A validated, normalized job ready to insert into the jobs table. */
export interface NormalizedJob {
  jobId: string;
  company: string;
  title: string;
  location: string | null;
  salary: string | null;
  description: string | null;
  url: string;
  postedAt: string | null;
  /** LinkedIn's structured job-criteria fields (detail page), when present. */
  seniorityLevel: string | null;
  employmentType: string | null;
  jobFunction: string | null;
  industries: string | null;
  /** Raw applicant caption, e.g. "Over 200 applicants". */
  applicants: string | null;
}

/** The handler stages that can drop a job. (The salary normalizer never drops.) */
export type DropStage =
  | 'field_parser'
  | 'title_filter'
  | 'blocklist'
  | 'deduplicator'
  | 'validator';

export type PipelineResult =
  | { kind: 'accepted'; job: NormalizedJob }
  | { kind: 'dropped'; stage: DropStage; reason: string };

/** Injected dependencies the filtering handlers need. */
export interface PipelineDeps {
  /** True if the (normalized) company name is on the blocklist. */
  isBlocked: (normalizedCompany: string) => boolean;
  /** True if a job with this LinkedIn job id already exists in SQLite. */
  exists: (jobId: string) => boolean;
  /**
   * True if the title is too senior to keep (FR-4a). Optional so callers that
   * only exercise the parser (e.g. the golden test) need not supply it; when
   * absent, no title is excluded.
   */
  isExcludedTitle?: (title: string) => boolean;
}

interface PipelineContext {
  raw: RawJob;
  job: NormalizedJob | null;
}

type HandlerOutcome = { pass: true } | { pass: false; reason: string };

interface ScrapeHandler {
  readonly stage: DropStage | 'salary_normalizer';
  handle(ctx: PipelineContext, deps: PipelineDeps): HandlerOutcome;
}


/** Trim a field; return null when empty so absent values are uniform. */
function clean(value: string | undefined | null): string | null {
  if (value == null) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Escape a user-supplied term for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True if a job title contains any of the (case-insensitive) exclusion terms as
 * a whole word (FR-4a). Whole-word matching via `\b…\b` keeps "Sr" / "Lead" /
 * "Staff" from misfiring on substrings ("Staffing", "Leadership", "Disregard").
 * An empty/blank term list excludes nothing.
 */
export function titleMatchesExcludedTerm(title: string, terms: readonly string[]): boolean {
  for (const term of terms) {
    const cleaned = term.trim();
    if (cleaned.length === 0) continue;
    if (new RegExp(`\\b${escapeRegExp(cleaned)}\\b`, 'i').test(title)) return true;
  }
  return false;
}

const fieldParser: ScrapeHandler = {
  stage: 'field_parser',
  handle(ctx) {
    const r = ctx.raw;
    const jobId = clean(r.jobId);
    const title = clean(r.title);
    const company = clean(r.company);
    if (!jobId) return { pass: false, reason: 'missing job id' };
    if (!title) return { pass: false, reason: 'missing title' };
    if (!company) return { pass: false, reason: 'missing company' };

    const url = clean(r.url) ?? `https://www.linkedin.com/jobs/view/${jobId}`;
    ctx.job = {
      jobId,
      title,
      company,
      url,
      location: clean(r.location),
      salary: clean(r.salary),
      // Descriptions keep their internal newlines (paragraphs/bullets), so only
      // trim the ends rather than collapsing whitespace like the other fields.
      description: r.description != null ? r.description.trim() || null : null,
      postedAt: clean(r.postedAt),
      seniorityLevel: clean(r.seniorityLevel),
      employmentType: clean(r.employmentType),
      jobFunction: clean(r.jobFunction),
      industries: clean(r.industries),
      applicants: clean(r.applicants),
    };
    return { pass: true };
  },
};

const titleFilter: ScrapeHandler = {
  stage: 'title_filter',
  handle(ctx, deps) {
    const title = ctx.job!.title;
    if (deps.isExcludedTitle?.(title)) {
      return { pass: false, reason: `excluded title: ${title}` };
    }
    return { pass: true };
  },
};

const blocklistFilter: ScrapeHandler = {
  stage: 'blocklist',
  handle(ctx, deps) {
    const company = ctx.job!.company;
    if (deps.isBlocked(normalizeCompanyName(company))) {
      return { pass: false, reason: `blocked company: ${company}` };
    }
    return { pass: true };
  },
};

const deduplicator: ScrapeHandler = {
  stage: 'deduplicator',
  handle(ctx, deps) {
    if (deps.exists(ctx.job!.jobId)) {
      return { pass: false, reason: 'duplicate job id' };
    }
    return { pass: true };
  },
};

const requiredFieldValidator: ScrapeHandler = {
  stage: 'validator',
  handle(ctx) {
    const j = ctx.job!;
    const required: ReadonlyArray<[string, string]> = [
      ['jobId', j.jobId],
      ['company', j.company],
      ['title', j.title],
      ['url', j.url],
    ];
    for (const [name, value] of required) {
      if (!value || value.trim().length === 0) {
        return { pass: false, reason: `missing ${name}` };
      }
    }
    return { pass: true };
  },
};

const salaryNormalizer: ScrapeHandler = {
  stage: 'salary_normalizer',
  handle(ctx) {
    const job = ctx.job!;
    job.salary = resolveSalary({ field: job.salary, description: job.description }).salary;
    return { pass: true };
  },
};

/** The ordered chain. The array order IS the pipeline order. */
export const HANDLERS: readonly ScrapeHandler[] = [
  fieldParser,
  titleFilter,
  blocklistFilter,
  deduplicator,
  requiredFieldValidator,
  salaryNormalizer,
];

/**
 * Run one raw job through the chain. The first handler to drop short-circuits
 * the rest; otherwise the fully normalized job is returned.
 */
export function runScrapePipeline(raw: RawJob, deps: PipelineDeps): PipelineResult {
  const ctx: PipelineContext = { raw, job: null };
  for (const handler of HANDLERS) {
    const outcome = handler.handle(ctx, deps);
    if (!outcome.pass) {
      return { kind: 'dropped', stage: handler.stage as DropStage, reason: outcome.reason };
    }
  }
  return { kind: 'accepted', job: ctx.job! };
}

/**
 * Apply only the field parser to a raw job, returning the normalized job or
 * null if it is dropped. Used by the HTML parser's golden test, which exercises
 * the scrape-HTML → normalized-Job path without DB/config-dependent stages.
 */
export function parseFields(raw: RawJob): NormalizedJob | null {
  const ctx: PipelineContext = { raw, job: null };
  const outcome = fieldParser.handle(ctx, { isBlocked: () => false, exists: () => false });
  return outcome.pass ? ctx.job : null;
}
