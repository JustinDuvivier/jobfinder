/**
 * The shared warm-first scoring loop (FR-6–FR-8, NFR-2). Every scoring
 * execution — the interactive p-limit fan-out (run.ts), the scheduler's
 * Batch API pass (batch.ts), and the scheduler's sequential local loop
 * (scheduled.ts) — is the same loop with a different transport: resolve the
 * backend, config, and the eligible jobs, score the first job alone with one
 * regular metered call, then hand the rest to the path's executor. That loop
 * lives here exactly once, parameterized by the executor, so the paths
 * cannot drift; each path's module owns only its transport.
 *
 * Why warm-first: the scoring prefix (system prompt + contract + Source of
 * Truth + resume) is identical across every job, but a cache entry only
 * becomes readable once the first response starts streaming. Firing all the
 * calls at once makes each of the first wave pay the full prefix write;
 * scoring one job first lets the rest read the entry it wrote. This matters
 * doubly for the batch path, where cache hits *inside* a batch are
 * best-effort while hits against a pre-existing warm entry are near-certain.
 *
 * Metering is shared too: the warm call goes through scoreJob → meteredCreate
 * on both paths, so a scored job is ledgered identically everywhere — the
 * only telemetry difference is the batch discount flag on the batch items,
 * which the batch executor records via meterBatchItem.
 *
 * See jobfinder-docs.md "Prompt caching" and "Scoring throughput".
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { DB } from '@/lib/db';
import type { Job, UserConfig } from '@/lib/types';
import * as repo from '@/lib/db/repo';
import { getAnthropicClient } from '@/lib/ai/client';
import { scoreJob, type ScoreInput, type ScoreResult } from '@/lib/ai/score';
import { scoreJobOllama, ensureOllamaModel } from '@/lib/ai/ollama';
import { DEFAULT_OLLAMA_MODEL } from '@/lib/ai/models';
import { serializeScoreReason } from '@/lib/score-reason';
import { effectiveConfig } from '@/lib/config/effective';
import { titleMatchesExcludedTerm } from '@/lib/scrape/pipeline';
import { latexToPlainText } from '@/lib/latex/to-plain-text';
import { describeJob } from '@/lib/jobs/describe';
import { emptyNotables, recordOutcome, type RunNotables } from '@/lib/notify/run-toast';

export interface ScoreEvent {
  jobId: number;
  score: number;
  reason: string;
  /** True when scored below the configured cutoff (FR-9a) — drop from the queue. */
  filtered: boolean;
}

export interface RunScoringOptions {
  /** Specific jobs to score; omit to score every `new` job. */
  jobIds?: number[];
  onScore?: (event: ScoreEvent) => void;
  onError?: (jobId: number, message: string) => void;
}

export interface ScoringSummary {
  scored: number;
  /** Ids that errored (e.g. truncation) — caller may retry. */
  failed: number[];
  /** Jobs dropped by the title filter before scoring (FR-4a) — never cost a call. */
  titleFiltered: number;
  /**
   * This run's toast-worthy tally — strong matches and FR-6a parks, with the
   * best strong match — derived from the jobs this run settled only, so
   * earlier runs never re-notify. The scheduler's runner composes its one
   * scheduled-run toast from it (FR-28).
   */
  notables: RunNotables;
}

/** Everything a scoring execution needs, resolved once per run. */
export interface PreparedScoring {
  /** The eligible jobs, with title-filtered rows already dropped. */
  jobs: Job[];
  /** Jobs deleted by the title filter before scoring (FR-4a). */
  titleFiltered: number;
  /** Scores below this are auto-flagged out of the decision queue (FR-9a). */
  scoreThreshold: number;
  /** The scoring-call input for one job (stable prefix + this job's posting). */
  inputFor(job: Job): ScoreInput;
}

/**
 * Resolve config and the eligible job set for a scoring run. Applies the
 * over-seniority title exclusion (FR-4a) up front — before any scoring call —
 * exactly as the scrape pipeline's title_filter stage would have, so dropped
 * jobs never reach the model. (A job scraped before the term was configured, or
 * via a strategy that bypasses the pipeline, can still be sitting in `new`.)
 */
function prepareScoring(db: DB, config: UserConfig | undefined, jobIds?: number[]): PreparedScoring {
  const eff = effectiveConfig(db);
  const scoreThreshold = config?.scoreThreshold ?? 50;
  const excludedTitleTerms = config?.excludedTitleTerms ?? [];
  const resumePlainText = latexToPlainText(eff.resumeLatex);
  const ids = jobIds ?? repo.listJobIdsByStatus(db, 'new');

  const jobs: Job[] = [];
  let titleFiltered = 0;
  for (const id of ids) {
    const job = repo.getJobById(db, id);
    if (!job) continue;
    if (titleMatchesExcludedTerm(job.title, excludedTitleTerms)) {
      repo.deleteJob(db, id);
      titleFiltered += 1;
      continue;
    }
    jobs.push(job);
  }

  return {
    jobs,
    titleFiltered,
    scoreThreshold,
    inputFor: (job) => ({
      systemPrompt: eff.scoringPrompt,
      sourceOfTruth: eff.sourceOfTruth,
      resumePlainText,
      jobDescription: describeJob(job),
    }),
  };
}

/** Persist one score (new → scored, flagging below-threshold rows, FR-9a). */
function persistScore(
  db: DB,
  jobId: number,
  result: ScoreResult,
  scoreThreshold: number,
): ScoreEvent {
  const reason = serializeScoreReason(result);
  // A parked score is a review request, not a fit verdict: it is never
  // auto-filtered, even by a threshold above the parking line (FR-6a).
  const filtered = !result.parkedForReview && result.score < scoreThreshold;
  repo.setScore(db, jobId, result.score, reason, filtered);
  return { jobId, score: result.score, reason, filtered };
}

/**
 * Which backend scores this run (FR-6), resolved once from config. The
 * Anthropic arm carries the SDK client the batch transport needs; the local
 * arm carries the model tag the Ollama transport runs.
 */
export type ScoringBackend =
  | { kind: 'anthropic'; client: Anthropic }
  | { kind: 'ollama'; model: string };

/**
 * Resolve the configured backend, failing loudly before any work: a missing
 * API key (Anthropic) or an unreachable server / unpulled model (Ollama) must
 * surface as the run's error — never a silent fallback to the other backend.
 */
async function resolveScoringBackend(config: UserConfig | undefined): Promise<ScoringBackend> {
  if (config?.scoringBackend === 'anthropic') {
    return { kind: 'anthropic', client: getAnthropicClient() };
  }
  // Local is the default (FR-6) — including before Setup is ever saved.
  const model = config?.ollamaModel.trim() || DEFAULT_OLLAMA_MODEL;
  await ensureOllamaModel(model);
  return { kind: 'ollama', model };
}

/**
 * What an executor gets to work with. `scoreOne` is the same regular metered
 * call the warm-first job went through (the interactive pool's whole
 * transport); `settle`/`fail` land results that arrived through the path's
 * own transport (the batch results loop).
 */
export interface ScoringExecution {
  backend: ScoringBackend;
  prep: PreparedScoring;
  /** Score one job with a regular metered call, persist, and notify. */
  scoreOne(job: Job): Promise<void>;
  /** Persist a result the executor's transport produced, and notify. */
  settle(jobId: number, result: ScoreResult): void;
  /** Record a job the executor's transport failed, and notify. */
  fail(jobId: number, message: string): void;
}

/** A path's transport for the jobs remaining after the warm-first call. */
export type ScoringExecutor = (rest: Job[], exec: ScoringExecution) => Promise<void>;

/**
 * Run one scoring pass: prepare, score the first eligible job alone to warm
 * the shared prefix cache, then execute the rest through the given transport.
 * A failed warm call still runs the executor — one lost job must not sink the
 * run. The executor is never invoked with an empty rest.
 */
export async function runWarmFirstScoring(
  db: DB,
  executeRest: ScoringExecutor,
  opts: RunScoringOptions = {},
): Promise<ScoringSummary> {
  // Resolve the backend before checking for work: a missing API key or an
  // unreachable/unpulled local model must fail loudly on every scoring run,
  // not only on the ones that found jobs.
  const config = repo.getUserConfig(db);
  const backend = await resolveScoringBackend(config);
  const prep = prepareScoring(db, config, opts.jobIds);

  let scored = 0;
  const failed: number[] = [];
  let notables = emptyNotables();
  const summary = (): ScoringSummary => ({
    scored,
    failed,
    titleFiltered: prep.titleFiltered,
    notables,
  });
  if (prep.jobs.length === 0) return summary();

  const jobsById = new Map(prep.jobs.map((job) => [job.id, job]));
  const settle = (jobId: number, result: ScoreResult): void => {
    // Persist unconditionally, then notify: `opts.onScore?.(persist(...))`
    // would skip the persist entirely when no callback is wired (`?.()`
    // short-circuits argument evaluation).
    const event = persistScore(db, jobId, result, prep.scoreThreshold);
    // Tally the outcome for the scheduled-run toast (FR-28) — settle is the
    // one funnel every backend's results flow through, so the tally covers
    // the warm call, the interactive pool, and batch-settled results alike.
    const job = jobsById.get(jobId);
    if (job) {
      notables = recordOutcome(
        notables,
        {
          company: job.company,
          title: job.title,
          score: result.score,
          parkedForReview: result.parkedForReview,
        },
        prep.scoreThreshold,
      );
    }
    opts.onScore?.(event);
    scored += 1;
  };
  const fail = (jobId: number, message: string): void => {
    failed.push(jobId);
    opts.onError?.(jobId, message);
  };
  const scoreOne = async (job: Job): Promise<void> => {
    try {
      const result =
        backend.kind === 'anthropic'
          ? await scoreJob(backend.client, prep.inputFor(job), { db, jobId: job.id })
          : await scoreJobOllama(backend.model, prep.inputFor(job), { db, jobId: job.id });
      settle(job.id, result);
    } catch (err) {
      fail(job.id, (err as Error).message);
    }
  };

  const [first, ...rest] = prep.jobs;
  if (first) await scoreOne(first);
  if (rest.length > 0) {
    await executeRest(rest, { backend, prep, scoreOne, settle, fail });
  }
  return summary();
}
