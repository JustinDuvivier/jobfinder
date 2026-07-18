/**
 * POST /api/command — the small, undoable status-change writes the UI triggers
 * (FR-10, FR-21, FR-23): pass, continue, tracker-status change, and undo. Each
 * delegates to the tested Command layer, which validates the transition and
 * records command_history in a transaction. Invalid transitions surface as 409.
 */
import { getDb } from '@/lib/db';
import {
  executePassJob,
  executeContinue,
  executeChangeTrackerStatus,
  executeMoveTrackerStatus,
  undoLastCommand,
} from '@/lib/commands';
import { JOB_STATUSES } from '@/lib/types';
import type { JobStatus } from '@/lib/types';
import { requireJobId } from '@/lib/http/guards';

export const runtime = 'nodejs';

function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

export async function POST(req: Request): Promise<Response> {
  // Parse only — the Command layer owns the job lookup and reports "not found"
  // with its own message, which the catch below maps to a 404.
  const parsed = await requireJobId(req);
  if (!parsed.ok) return parsed.response;
  const { jobId, body } = parsed;
  const type = body.type;

  const db = getDb();
  try {
    switch (type) {
      case 'pass':
        return Response.json({ ok: true, ...executePassJob(db, jobId) });
      case 'continue':
        return Response.json({ ok: true, ...executeContinue(db, jobId) });
      case 'tracker': {
        if (!isJobStatus(body.to)) {
          return Response.json({ error: 'Invalid target status "to"' }, { status: 400 });
        }
        return Response.json({ ok: true, ...executeChangeTrackerStatus(db, jobId, body.to) });
      }
      case 'tracker-move': {
        // Free move between tracker stages (the board's drag-and-drop).
        if (!isJobStatus(body.to)) {
          return Response.json({ error: 'Invalid target status "to"' }, { status: 400 });
        }
        return Response.json({ ok: true, ...executeMoveTrackerStatus(db, jobId, body.to) });
      }
      case 'undo':
        return Response.json({ ok: true, undo: undoLastCommand(db, jobId) });
      default:
        return Response.json({ error: `Unknown command type "${type}"` }, { status: 400 });
    }
  } catch (err) {
    const message = (err as Error).message;
    const status = message.includes('not found') ? 404 : 409;
    return Response.json({ error: message }, { status });
  }
}
