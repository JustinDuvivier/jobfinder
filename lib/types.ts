/**
 * Domain and row types, written once and shared by every query.
 * There is a single SQLite client, so there is no generated type layer —
 * these definitions are the single source of truth for shapes in the app.
 */

/**
 * The granular job lifecycle status. Recorded as a TEXT column constrained by a
 * CHECK in the schema; the same union is the authority in TypeScript. The set is
 * deliberately granular so it records *who acted* at each stage — see
 * jobfinder-docs.md "Status State Machine".
 */
export type JobStatus =
  | 'new' // scraped, not yet scored
  | 'scored' // scored, awaiting my decline/continue decision
  | 'passed' // I declined the job (pre-application, terminal)
  | 'rewriting' // I'm pursuing it; rewrite in progress
  | 'approved' // rewrite approved, one-page PDF saved to disk
  | 'applied' // I submitted the application
  | 'interview' // at least one interview scheduled or completed
  | 'offer' // offer received
  | 'accepted' // I accepted the offer (terminal)
  | 'rejected' // they declined me after I applied (terminal)
  | 'withdrawn' // I pulled out after applying (terminal)
  | 'ghosted'; // applied, no response after a long silence (terminal)

/** All job statuses, in lifecycle order. Mirrors the schema CHECK constraint. */
export const JOB_STATUSES: readonly JobStatus[] = [
  'new',
  'scored',
  'passed',
  'rewriting',
  'approved',
  'applied',
  'interview',
  'offer',
  'accepted',
  'rejected',
  'withdrawn',
  'ghosted',
] as const;

/** The scraper Strategy implementations selectable in Setup (FR-1, FR-25). */
export type ScraperStrategyName = 'demo' | 'linkedin' | 'proxycurl';

/** Which site a job row was scraped from. Assigned at insert time; defaults to
 *  'linkedin' so existing rows and the LinkedIn/demo path are unaffected. */
export type JobSource = 'linkedin' | 'greenhouse';

/** The scoring backends selectable in Setup (FR-6, FR-25): the local Ollama
 *  model (default — zero marginal cost) or the Anthropic cheap tier. */
export type ScoringBackendName = 'ollama' | 'anthropic';

/**
 * The four resume assets the pipeline runs on (FR-32/FR-33). The names double
 * as the `resume_assets` primary key (mirrored by its CHECK constraint — keep
 * the two in sync) and map to the on-disk filenames (`base_resume.tex`, the
 * rest `<name>.md`).
 */
export const RESUME_ASSET_NAMES = [
  'base_resume',
  'source_of_truth',
  'scoring_prompt',
  'rewrite_rules',
] as const;
export type ResumeAssetName = (typeof RESUME_ASSET_NAMES)[number];

/** Which layer an asset resolved from: authored in-app (SQLite) beats a user
 *  file in `resume/` beats the committed `resume-example/` starter (FR-33). */
export type ResumeAssetProvenance = 'in-app' | 'file' | 'example';

/** The kinds of state-changing user actions recorded in command_history. */
export type CommandType =
  | 'PassJob'
  | 'Continue'
  | 'RegenerateRewrite'
  | 'ApproveRewrite'
  | 'ChangeTrackerStatus';

/** Source of a rewritten_latex_versions row. */
export type RewriteVersionSource = 'ai_generation' | 'autosave';

/** Lifecycle status of a scrape run. */
export type ScrapeSessionStatus = 'running' | 'completed' | 'failed';

/**
 * A normalized job posting. `id` is the internal autoincrement primary key;
 * `jobId` is the LinkedIn posting ID used for cross-search deduplication (FR-3)
 * and for PathBuilder's collision-free folder disambiguator.
 */
export interface Job {
  id: number;
  jobId: string;
  company: string;
  title: string;
  location: string | null;
  salary: string | null;
  description: string | null;
  url: string;
  /** Which site this posting came from (provenance) — 'linkedin' or 'greenhouse'. */
  source: JobSource;
  postedAt: string | null;
  /** LinkedIn's structured job-criteria fields from the detail page. */
  seniorityLevel: string | null;
  employmentType: string | null;
  jobFunction: string | null;
  industries: string | null;
  /** Raw applicant caption from the detail page, e.g. "Over 200 applicants". */
  applicants: string | null;
  status: JobStatus;
  score: number | null;
  scoreReason: string | null;
  /** Auto-filter flag: scored below the configured threshold, so kept out of
   * the decision queue (FR-9a). Orthogonal to `status` — a flag, not a state. */
  belowThreshold: boolean;
  rewrittenLatex: string | null;
  /** JSON-serialized {summary, bullets} from the explanation call. */
  explanation: string | null;
  approvedPdfPath: string | null;
  /** SHA-256 of the most recently compiled LaTeX. */
  latexHash: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Fallback owner name (single-user tool) — also the schema column default. */
export const DEFAULT_OWNER_NAME = 'Alex_Candidate';

/** The single Setup configuration row (id = 1). The four resume assets are
 *  deliberately NOT here — they live in `resume_assets` (FR-33) and resolve
 *  through `lib/resume/load.ts`. */
export interface UserConfig {
  /** Reserved for the Proxycurl strategy. */
  searchUrl: string;
  scraperStrategy: ScraperStrategyName;
  /** Orthogonal toggle; Greenhouse runs alongside the primary strategy. */
  greenhouseEnabled: boolean;
  ownerName: string;
  /** Saved-search keywords (FR-2/FR-25); the LinkedIn guest strategy uses the
   * cross product of keywords × locations. */
  keywords: string[];
  locations: string[];
  /** Whole-word title terms that drop over-senior postings before insert
   * (FR-4a); empty = no title filtering. */
  excludedTitleTerms: string[];
  /** Auto-run cadence in minutes while the app is open; 0 = manual only. */
  runIntervalMinutes: number;
  /** Only scrape jobs posted within this many hours (LinkedIn f_TPR). */
  searchLookbackHours: number;
  /** Jobs scored below this (0–100) are auto-flagged out of the decision queue
   * (FR-9a). Default 50; set to 0 to disable auto-filtering. */
  scoreThreshold: number;
  /** Which backend scores jobs (FR-6): local Ollama (default) or Anthropic. */
  scoringBackend: ScoringBackendName;
  /** The Ollama model tag scoring runs on when the backend is 'ollama'. */
  ollamaModel: string;
}
