/**
 * The DB-coupled companion to the pure diff in ./index: recompute a job's
 * persisted resume_changes rows from its rewritten LaTeX. Shared by every
 * path that changes the active document — the RecordRewrite command (after a
 * completed stream), the RegenerateRewrite undo (after restoring a version),
 * and /api/autosave (after a manual edit) — so the stored diff always
 * describes the current document and the base-resume source and diff shape
 * can never drift between callers.
 *
 * The base resume is resolved from the effective config at call time; the
 * generation-time base is not stored.
 */
import type { DB } from '../db/index';
import * as repo from '../db/repo';
import { effectiveConfig } from '../config/effective';
import { computeLatexDiff } from './index';

/** Replace the job's stored diff with diff(effective base resume, rewrittenLatex). */
export function refreshResumeDiff(db: DB, jobId: number, rewrittenLatex: string): void {
  const { resumeLatex } = effectiveConfig(db);
  repo.replaceResumeChanges(db, jobId, computeLatexDiff(resumeLatex, rewrittenLatex));
}
