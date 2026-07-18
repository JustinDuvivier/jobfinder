/**
 * The rewrite execution, factored out of the `/api/rewrite` route so the route
 * stays a thin SSE shell like /api/scrape and /api/score (FR-11–FR-13). Builds
 * the rewrite request from the job and the effective config, meters the Sonnet
 * streaming call (FR-27), emits each text token through the onToken callback,
 * and detects truncation. A truncated generation (stop_reason max_tokens)
 * persists NOTHING — the document may not compile — and is reported so the
 * caller can surface the warning. A complete generation is persisted through
 * the RecordRewrite command (lib/commands): version append, denormalized
 * LaTeX, diff refresh, and the command_history row in one transaction, so the
 * first generation is undoable back to the no-rewrite state.
 *
 * See jobfinder-docs.md "Rewrite Module" and "Rewrite prompt".
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { DB } from '@/lib/db';
import type { JobStatus } from '@/lib/types';
import * as repo from '@/lib/db/repo';
import { buildRewriteRequest, extractRewrite } from '@/lib/ai/rewrite';
import { meterCall } from '@/lib/ai/telemetry';
import { executeRecordRewrite } from '@/lib/commands';
import { effectiveConfig } from '@/lib/config/effective';
import { describeJob } from '@/lib/jobs/describe';
import { canEdit } from '@/lib/status/transitions';

export type RewriteRunResult =
  | { kind: 'done' }
  | { kind: 'truncated' }
  | { kind: 'job_not_found' }
  | { kind: 'not_editable'; status: JobStatus };

export interface RunRewriteOptions {
  /** The Anthropic client — routes pass getAnthropicClient(), tests a fake. */
  client: Anthropic;
  /** Called for each streamed text token, in order — used to stream over SSE. */
  onToken?: (text: string) => void;
}

export async function runRewrite(
  db: DB,
  jobId: number,
  opts: RunRewriteOptions,
): Promise<RewriteRunResult> {
  const job = repo.getJobById(db, jobId);
  if (!job) return { kind: 'job_not_found' };
  // Same guard executeRecordRewrite enforces, checked here BEFORE the metered
  // call: a job that cannot record the result must not pay for the generation.
  // The route already refused a non-editable job with a 409 pre-stream, so
  // this arm fires only when the status changed in between (the race fallback).
  if (!canEdit(job.status)) return { kind: 'not_editable', status: job.status };

  const eff = effectiveConfig(db);
  const request = buildRewriteRequest({
    systemPrompt: eff.rewriteRules,
    resumeLatex: eff.resumeLatex,
    jobDescription: describeJob(job),
  });
  // The meter times the whole stream and ledgers it (FR-27): an error row if
  // it dies mid-stream, otherwise the accumulated final message's usage.
  const message = await meterCall({ db, jobId }, 'rewrite', request.model, async () => {
    const stream = opts.client.messages.stream(request);
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        opts.onToken?.(event.delta.text);
      }
    }
    return stream.finalMessage();
  });

  const { latex, truncated } = extractRewrite(message);
  if (truncated) return { kind: 'truncated' };

  executeRecordRewrite(db, jobId, latex);
  return { kind: 'done' };
}
