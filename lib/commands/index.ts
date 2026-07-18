/**
 * Undoable Commands — invariant #3 (reversibility, NFR-5).
 *
 * Every status-changing user action is recorded as a row in command_history
 * (action type, job, previous/new status, and the rewritten_latex_versions row
 * id it operated on). Each `execute*` performs its DB transition and records the
 * command in a single transaction; `undoLastCommand` reads the most recent
 * command for a job and reverses the recorded transition.
 *
 * Undo restores the rewritten LaTeX by reading a specific **version row by id**,
 * not by comparing timestamps — which is what defeats the autosave-vs-undo race:
 * a debounced autosave appends new version rows, but undo reads the exact row it
 * recorded when it executed, regardless of what autosave has written since.
 *
 * Forward transitions are validated against the transitions table; undo
 * deliberately bypasses it, restoring the exact recorded prior state (which may
 * not itself be a forward-valid transition, e.g. passed → scored).
 *
 * The disk side of approval (compile, one-page gate, file write) lives in the
 * approval orchestrator (lib/approval), which calls executeApproveRewrite for
 * the atomic DB write once the one-page PDF is on disk. See jobfinder-docs.md
 * "Command — User decisions".
 */
import type { DB } from '../db/index';
import type { Job, JobStatus, CommandType } from '../types';
import { assertTransition, canEdit, isTrackerStatus } from '../status/transitions';
import { refreshResumeDiff } from '../diff/persist';
import * as repo from '../db/repo';

export interface CommandOutcome {
  commandId: number;
  status: JobStatus;
}

function requireJob(db: DB, jobId: number): Job {
  const job = repo.getJobById(db, jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  return job;
}

/**
 * The single definition of the user-facing "rewrite not recordable" copy.
 * Shared by executeRecordRewrite's throw and /api/rewrite's pre-stream 409
 * (and its mid-stream race fallback), so the message cannot drift.
 */
export function rewriteNotEditableMessage(jobId: number, status: JobStatus): string {
  return `Recording a rewrite requires a job in rewriting; job ${jobId} is ${status}`;
}

/** PassJobCommand — I decline the job (scored → passed). */
export function executePassJob(db: DB, jobId: number): CommandOutcome {
  return db.transaction((): CommandOutcome => {
    const job = requireJob(db, jobId);
    assertTransition(job.status, 'passed'); // valid only from scored
    repo.updateJobStatus(db, jobId, 'passed');
    const commandId = repo.insertCommand(db, {
      commandType: 'PassJob',
      jobId,
      previousStatus: job.status,
      newStatus: 'passed',
      versionId: null,
    });
    return { commandId, status: 'passed' };
  })();
}

/** ContinueCommand — I pursue the job (scored → rewriting). */
export function executeContinue(db: DB, jobId: number): CommandOutcome {
  return db.transaction((): CommandOutcome => {
    const job = requireJob(db, jobId);
    if (job.status !== 'scored') {
      throw new Error(`Continue requires a scored job; job ${jobId} is ${job.status}`);
    }
    assertTransition(job.status, 'rewriting');
    repo.updateJobStatus(db, jobId, 'rewriting');
    const commandId = repo.insertCommand(db, {
      commandType: 'Continue',
      jobId,
      previousStatus: job.status,
      newStatus: 'rewriting',
      versionId: null,
    });
    return { commandId, status: 'rewriting' };
  })();
}

/** ChangeTrackerStatusCommand — any valid pipeline transition (applied → interview, etc.). */
export function executeChangeTrackerStatus(db: DB, jobId: number, to: JobStatus): CommandOutcome {
  return db.transaction((): CommandOutcome => {
    const job = requireJob(db, jobId);
    assertTransition(job.status, to);
    repo.updateJobStatus(db, jobId, to);
    const commandId = repo.insertCommand(db, {
      commandType: 'ChangeTrackerStatus',
      jobId,
      previousStatus: job.status,
      newStatus: to,
      versionId: null,
    });
    return { commandId, status: to };
  })();
}

/**
 * MoveTrackerStatusCommand — a *free* move between Tracker stages (any direction),
 * so the board's drag-and-drop can correct a status in either direction. Unlike
 * executeChangeTrackerStatus it does not consult the forward-only transitions
 * table, but it is bounded: both the current and target status must be Tracker
 * statuses, so it can never be used to bypass the scored→rewriting→approved
 * gates. Still recorded as a ChangeTrackerStatus command, so undo works.
 */
export function executeMoveTrackerStatus(db: DB, jobId: number, to: JobStatus): CommandOutcome {
  return db.transaction((): CommandOutcome => {
    const job = requireJob(db, jobId);
    if (!isTrackerStatus(job.status)) {
      throw new Error(`Job ${jobId} is not on the tracker (status ${job.status})`);
    }
    if (!isTrackerStatus(to)) {
      throw new Error(`Cannot move a tracked job to ${to}`);
    }
    repo.updateJobStatus(db, jobId, to);
    const commandId = repo.insertCommand(db, {
      commandType: 'ChangeTrackerStatus',
      jobId,
      previousStatus: job.status,
      newStatus: to,
      versionId: null,
    });
    return { commandId, status: to };
  })();
}

/**
 * RecordRewriteCommand — persist a completed AI generation (status stays
 * `rewriting`). Owns the first-generation-vs-regeneration decision: the
 * "prior version exists" fact is derived exactly once, as the version id
 * recorded for undo (null for a first generation). Appends the version row,
 * updates the denormalized rewritten_latex, and recomputes the persisted diff
 * in one transaction, so the stored diff can never describe a generation that
 * failed to land. Recorded in command_history as RegenerateRewrite either
 * way: the reverser's null-version branch is exactly the restore-to-no-rewrite
 * undo a first generation needs.
 */
export function executeRecordRewrite(db: DB, jobId: number, newLatex: string): CommandOutcome {
  return db.transaction((): CommandOutcome => {
    const job = requireJob(db, jobId);
    if (!canEdit(job.status)) {
      throw new Error(rewriteNotEditableMessage(jobId, job.status));
    }
    // First-vs-regen is decided by the ACTIVE rewrite (the denormalized
    // rewritten_latex), not by bare version-row existence: an undone first
    // generation leaves its ai_generation row behind, and recording that
    // orphan as the undo target would resurrect content the user discarded.
    const previousVersionId =
      job.rewrittenLatex == null ? null : (repo.getLatestRewriteVersionId(db, jobId) ?? null);
    repo.appendRewriteVersion(db, jobId, newLatex, 'ai_generation');
    repo.setRewrittenLatex(db, jobId, newLatex);
    refreshResumeDiff(db, jobId, newLatex);
    const commandId = repo.insertCommand(db, {
      commandType: 'RegenerateRewrite',
      jobId,
      previousStatus: job.status,
      newStatus: job.status,
      versionId: previousVersionId,
    });
    return { commandId, status: job.status };
  })();
}

/**
 * ApproveRewriteCommand (DB transaction) — rewriting → approved, recording the
 * saved path and, when given, the hash of the approved LaTeX (FR-19: one
 * atomic commit). The approval orchestrator must have already compiled,
 * verified one page, and written the PDF to `approvedPdfPath` before calling
 * this.
 */
export function executeApproveRewrite(
  db: DB,
  jobId: number,
  approvedPdfPath: string,
  latexHash?: string,
): CommandOutcome {
  return db.transaction((): CommandOutcome => {
    const job = requireJob(db, jobId);
    assertTransition(job.status, 'approved'); // valid only from rewriting
    const versionId = repo.getLatestRewriteVersionId(db, jobId) ?? null;
    repo.setApprovedPdf(db, jobId, approvedPdfPath, 'approved');
    if (latexHash !== undefined) repo.setLatexHash(db, jobId, latexHash);
    const commandId = repo.insertCommand(db, {
      commandType: 'ApproveRewrite',
      jobId,
      previousStatus: job.status,
      newStatus: 'approved',
      versionId,
    });
    return { commandId, status: 'approved' };
  })();
}

/** Per-command-type reversal logic, dispatched by undoLastCommand. */
const REVERSERS: Record<CommandType, (db: DB, cmd: repo.CommandRow) => void> = {
  PassJob: (db, cmd) => revertStatus(db, cmd),
  Continue: (db, cmd) => revertStatus(db, cmd),
  ChangeTrackerStatus: (db, cmd) => revertStatus(db, cmd),
  ApproveRewrite: (db, cmd) => {
    // Clear the saved path and return to rewriting. The disk file is left
    // intact — deleting it is a separate, explicit action.
    repo.clearApprovedPdf(db, cmd.job_id, requireStatus(cmd.previous_status));
  },
  RegenerateRewrite: (db, cmd) => {
    // Restore the LaTeX from the specific recorded version row (race-free),
    // and recompute the persisted diff so resume_changes describes the restored
    // LaTeX rather than the discarded generation. The diff base is the
    // *current* effective resume — the generation-time base is not stored.
    // Both branches also drop the stored explanation: it justified the
    // discarded generation and, unlike the diff, cannot be recomputed
    // deterministically — re-running explain regenerates it.
    if (cmd.version_id != null) {
      const version = repo.getRewriteVersion(db, cmd.version_id);
      if (!version) {
        // Schema-impossible (FK from command_history.version_id) — assert it.
        throw new Error(
          `Rewrite version ${cmd.version_id} recorded by command ${cmd.id} is missing`,
        );
      }
      repo.setRewrittenLatex(db, cmd.job_id, version.content);
      refreshResumeDiff(db, cmd.job_id, version.content);
    } else {
      // The restored state predates any generation — no LaTeX and no diff.
      repo.setRewrittenLatex(db, cmd.job_id, null);
      repo.replaceResumeChanges(db, cmd.job_id, []);
    }
    repo.setExplanation(db, cmd.job_id, null);
    // Status is unchanged across a regenerate, but set it defensively.
    repo.updateJobStatus(db, cmd.job_id, requireStatus(cmd.previous_status));
  },
};

function revertStatus(db: DB, cmd: repo.CommandRow): void {
  repo.updateJobStatus(db, cmd.job_id, requireStatus(cmd.previous_status));
}

function requireStatus(status: JobStatus | null): JobStatus {
  if (status == null) throw new Error('Command has no previous_status to revert to');
  return status;
}

export interface UndoResult {
  undone: CommandType;
  revertedTo: JobStatus | null;
}

/**
 * Undo the most recent command for a job: reverse its transition, restore the
 * rewritten LaTeX if it referenced a version, and pop the command off the
 * history. Returns null if the job has no commands to undo.
 */
export function undoLastCommand(db: DB, jobId: number): UndoResult | null {
  return db.transaction(() => {
    const cmd = repo.getLatestCommand(db, jobId);
    if (!cmd) return null;
    REVERSERS[cmd.command_type](db, cmd);
    repo.deleteCommand(db, cmd.id);
    return { undone: cmd.command_type, revertedTo: cmd.previous_status };
  })();
}
