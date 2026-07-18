/**
 * Status transition table — the single source of truth for the job lifecycle.
 *
 * Rather than a class per status (the textbook State pattern, overkill here),
 * the status is a TypeScript union (see lib/types.ts) and this table maps each
 * status to the statuses it may move *to*. The UI asks this table ("can this
 * job continue? can it be passed?") instead of hard-coding rules, and the repo
 * builds its SQL status predicates from the named sets exported here
 * (DECISION_QUEUE_STATUSES, TRACKER_STATUSES) — this module is the only place
 * those sets are spelled out. Adding a status later is one entry in the union
 * plus its row in the table and, if it belongs on the queue or the board, its
 * named set — all in this one module; the queries and views pick it up from
 * there.
 *
 * This table governs *forward* user actions. Command undo is a separate
 * mechanism: it restores the exact previous status recorded in command_history,
 * which may not itself be a forward-valid transition, so undo deliberately does
 * not consult this table.
 *
 * See jobfinder-docs.md "Status State Machine" and PRD FR-21/FR-22.
 */
import type { JobStatus } from '../types';

/** For each status, the set of statuses a forward action may move it to. */
export const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  // Triage
  new: ['scored'], // the scorer picks these up
  scored: ['passed', 'rewriting'], // I decline (pass) or pursue (continue)
  // Pre-application terminal
  passed: [],
  // Pursuing
  rewriting: ['approved', 'passed'], // approve (compile + save), or decline if I realize I'm not a fit
  approved: ['rewriting', 'applied'], // reopen the rewrite, or send to tracker
  // Hiring pipeline
  applied: ['interview', 'rejected', 'withdrawn', 'ghosted'],
  interview: ['offer', 'rejected', 'withdrawn'],
  offer: ['accepted', 'withdrawn'],
  // Terminal outcomes
  accepted: [],
  rejected: [],
  withdrawn: [],
  ghosted: [],
} as const;

/** True if a forward transition from `from` to `to` is permitted. */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * The decision-queue (triage) statuses: jobs still awaiting a pass/continue
 * decision. `new` is waiting on a score; `scored` is waiting on the user.
 */
export const DECISION_QUEUE_STATUSES: readonly JobStatus[] = ['new', 'scored'] as const;

/**
 * The statuses shown on the Tracker board (approved and everything downstream).
 * Within this set the Tracker allows *free* moves in any direction (you can drag
 * a card from any stage to any other to correct a mistake) — distinct from the
 * forward-only `TRANSITIONS` that gate the decision queue (pass/continue/approve).
 */
export const TRACKER_STATUSES: readonly JobStatus[] = [
  'approved',
  'applied',
  'interview',
  'offer',
  'accepted',
  'rejected',
  'withdrawn',
  'ghosted',
] as const;

/** True if a status is a Tracker-board status (eligible for free moves). */
export function isTrackerStatus(status: JobStatus): boolean {
  return TRACKER_STATUSES.includes(status);
}

/**
 * Assert a forward transition is valid, throwing otherwise. Use at write
 * boundaries (commands, route handlers) so an invalid transition fails loudly
 * rather than silently corrupting the lifecycle.
 */
export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid status transition: ${from} -> ${to}`);
  }
}

/** True if no forward transition exists out of this status (a leaf state). */
export function isTerminal(status: JobStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Can this job be passed (I decline it)? Allowed from the decision queue
 *  (scored) and from an in-progress rewrite (I realized I'm not a fit). */
export function canPass(status: JobStatus): boolean {
  return canTransition(status, 'passed');
}

/** Jobs view: can this job be continued into a rewrite (I pursue it)? */
export function canContinue(status: JobStatus): boolean {
  return status === 'scored' && canTransition(status, 'rewriting');
}

/** Rewrite view: can this job be approved (compile + save the PDF)? */
export function canApprove(status: JobStatus): boolean {
  return canTransition(status, 'approved');
}

/**
 * Can the rewrite's LaTeX be edited (autosave a manual edit, regenerate)?
 * Editing is not a transition — the status stays `rewriting` — so this reads
 * the union directly rather than the table: allowed exactly while the rewrite
 * is in flight. Approval freezes the document; an approved job must be
 * reopened (approved → rewriting) before further edits.
 */
export function canEdit(status: JobStatus): boolean {
  return status === 'rewriting';
}

/**
 * Can the tailoring workspace (/rewrite/[id]) be opened for this job?
 * True mid-rewrite, or once approved — an approved job's rewrite can be
 * reopened. Both cases are read off the table: `rewriting` is the status that
 * can be approved, and `approved` is the tracked status that can transition
 * back into `rewriting`.
 */
export function canOpenRewrite(status: JobStatus): boolean {
  return canApprove(status) || (isTrackerStatus(status) && canTransition(status, 'rewriting'));
}
