import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../db/index';
import * as repo from '../db/repo';
import {
  executePassJob,
  executeContinue,
  executeChangeTrackerStatus,
  executeMoveTrackerStatus,
  executeRecordRewrite,
  executeApproveRewrite,
  undoLastCommand,
} from './index';
import { computeLatexDiff } from '../diff';
import { CONFIG } from '../test-fixtures';
import type { JobStatus } from '../types';

let db: DB;
let seq = 0;

function seedJob(status: JobStatus, rewrittenLatex: string | null = null): number {
  seq += 1;
  const info = db
    .prepare(
      `INSERT INTO jobs (job_id, company, title, url, status, rewritten_latex)
       VALUES (?, 'Stripe', 'AI Engineer', 'https://x', ?, ?)`,
    )
    .run(`lk-${seq}`, status, rewrittenLatex);
  return Number(info.lastInsertRowid);
}

function statusOf(id: number): JobStatus {
  return repo.getJobById(db, id)!.status;
}

function commandCount(id: number): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM command_history WHERE job_id = ?`).get(id) as {
      n: number;
    }
  ).n;
}

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('PassJobCommand', () => {
  it('moves scored → passed and records the command', () => {
    const id = seedJob('scored');
    const outcome = executePassJob(db, id);
    expect(statusOf(id)).toBe('passed');
    expect(commandCount(id)).toBe(1);
    expect(outcome.status).toBe('passed');
  });

  it('rejects passing a job that is not scored', () => {
    const id = seedJob('new');
    expect(() => executePassJob(db, id)).toThrow(/Invalid status transition/);
    expect(statusOf(id)).toBe('new'); // transaction rolled back
    expect(commandCount(id)).toBe(0);
  });

  it('undo restores scored and pops the command', () => {
    const id = seedJob('scored');
    executePassJob(db, id);
    const result = undoLastCommand(db, id);
    expect(result).toMatchObject({ undone: 'PassJob', revertedTo: 'scored' });
    expect(statusOf(id)).toBe('scored');
    expect(commandCount(id)).toBe(0);
  });

  it('declines an in-progress rewrite (rewriting → passed) and undo restores rewriting', () => {
    const id = seedJob('rewriting');
    expect(executePassJob(db, id).status).toBe('passed');
    expect(statusOf(id)).toBe('passed');
    const result = undoLastCommand(db, id);
    expect(result).toMatchObject({ undone: 'PassJob', revertedTo: 'rewriting' });
    expect(statusOf(id)).toBe('rewriting');
  });
});

describe('ContinueCommand', () => {
  it('moves scored → rewriting and undo reverts', () => {
    const id = seedJob('scored');
    executeContinue(db, id);
    expect(statusOf(id)).toBe('rewriting');
    undoLastCommand(db, id);
    expect(statusOf(id)).toBe('scored');
  });

  it('rejects continue from a non-scored job', () => {
    const id = seedJob('new');
    expect(() => executeContinue(db, id)).toThrow(/scored/);
  });
});

describe('ChangeTrackerStatusCommand', () => {
  it('allows a valid pipeline transition and undoes it', () => {
    const id = seedJob('approved');
    executeChangeTrackerStatus(db, id, 'applied');
    expect(statusOf(id)).toBe('applied');
    executeChangeTrackerStatus(db, id, 'interview');
    expect(statusOf(id)).toBe('interview');

    undoLastCommand(db, id); // interview → applied
    expect(statusOf(id)).toBe('applied');
    undoLastCommand(db, id); // applied → approved
    expect(statusOf(id)).toBe('approved');
  });

  it('rejects an invalid transition (applied → offer)', () => {
    const id = seedJob('applied');
    expect(() => executeChangeTrackerStatus(db, id, 'offer')).toThrow(/Invalid status transition/);
    expect(statusOf(id)).toBe('applied');
  });
});

describe('MoveTrackerStatusCommand (free moves)', () => {
  it('allows a backward / non-forward move between tracker stages and undoes it', () => {
    const id = seedJob('interview');
    // interview → applied is NOT a forward transition, but a free tracker move allows it.
    executeMoveTrackerStatus(db, id, 'applied');
    expect(statusOf(id)).toBe('applied');
    expect(commandCount(id)).toBe(1);

    undoLastCommand(db, id); // applied → interview
    expect(statusOf(id)).toBe('interview');
  });

  it('allows jumping across stages (rejected → offer)', () => {
    const id = seedJob('rejected');
    executeMoveTrackerStatus(db, id, 'offer');
    expect(statusOf(id)).toBe('offer');
  });

  it('refuses to move a job that is not on the tracker', () => {
    const id = seedJob('scored');
    expect(() => executeMoveTrackerStatus(db, id, 'applied')).toThrow(/not on the tracker/);
    expect(statusOf(id)).toBe('scored');
  });

  it('refuses a target that is not a tracker status', () => {
    const id = seedJob('applied');
    expect(() => executeMoveTrackerStatus(db, id, 'rewriting')).toThrow(/Cannot move/);
    expect(statusOf(id)).toBe('applied');
  });
});

describe('ApproveRewriteCommand', () => {
  it('sets approved_pdf_path and status, then undo clears the path and reverts', () => {
    const id = seedJob('rewriting', '\\documentclass{article}');
    executeApproveRewrite(db, id, 'C:\\out\\20260618\\Stripe_AI_Engineer_abc123\\Alex_Resume.pdf');

    let job = repo.getJobById(db, id)!;
    expect(job.status).toBe('approved');
    expect(job.approvedPdfPath).toContain('Alex_Resume.pdf');

    undoLastCommand(db, id);
    job = repo.getJobById(db, id)!;
    expect(job.status).toBe('rewriting');
    expect(job.approvedPdfPath).toBeNull(); // path cleared; disk file left intact
  });

  it('records the LaTeX hash in the same transaction when given', () => {
    const id = seedJob('rewriting', '\\documentclass{article}');
    executeApproveRewrite(db, id, 'C:\\out\\x.pdf', 'hash-abc');
    expect(repo.getJobById(db, id)!.latexHash).toBe('hash-abc');
  });

  it('leaves the LaTeX hash untouched when omitted', () => {
    const id = seedJob('rewriting', '\\documentclass{article}');
    executeApproveRewrite(db, id, 'C:\\out\\x.pdf');
    expect(repo.getJobById(db, id)!.latexHash).toBeNull();
  });

  it('rejects approval from a non-rewriting job', () => {
    const id = seedJob('scored');
    expect(() => executeApproveRewrite(db, id, 'x')).toThrow(/Invalid status transition/);
  });
});

const RESUME = 'name: Alex\nskills: TypeScript';

function seedResumeConfig(): void {
  repo.upsertUserConfig(db, CONFIG);
  repo.setResumeAsset(db, 'base_resume', RESUME);
}

describe('RecordRewriteCommand — first generation vs regeneration', () => {
  beforeEach(seedResumeConfig);

  it('rejects recording a rewrite for a job that is not rewriting', () => {
    const id = seedJob('scored');
    expect(() => executeRecordRewrite(db, id, 'v1')).toThrow(
      `Recording a rewrite requires a job in rewriting; job ${id} is scored`,
    );
    expect(commandCount(id)).toBe(0);
    expect(repo.getLatestRewriteVersionId(db, id)).toBeUndefined(); // rolled back
  });

  it('a first generation records version_id = null; a regeneration records the prior version id', () => {
    const id = seedJob('rewriting');
    executeRecordRewrite(db, id, 'v1');
    const firstVersionId = repo.getLatestRewriteVersionId(db, id)!;
    executeRecordRewrite(db, id, 'v2');

    const rows = db
      .prepare(`SELECT version_id FROM command_history WHERE job_id = ? ORDER BY id ASC`)
      .all(id) as Array<{ version_id: number | null }>;
    expect(rows).toEqual([{ version_id: null }, { version_id: firstVersionId }]);
  });

  it('undoing a first generation restores the no-rewrite state', () => {
    const id = seedJob('rewriting');
    executeRecordRewrite(db, id, 'v1 latex');

    undoLastCommand(db, id);
    expect(repo.getJobById(db, id)!.rewrittenLatex).toBeNull();
    expect(repo.getResumeChanges(db, id)).toEqual([]);
    expect(statusOf(id)).toBe('rewriting');
    expect(commandCount(id)).toBe(0);
  });

  it('a generation after an undone first generation is a first generation again', () => {
    const id = seedJob('rewriting');
    executeRecordRewrite(db, id, 'v1');
    undoLastCommand(db, id); // back to no rewrite; v1's version row is left behind

    // The orphaned v1 row must not be recorded as the undo target: the active
    // state is "no rewrite", so this is a first generation again.
    executeRecordRewrite(db, id, 'v2');
    undoLastCommand(db, id);
    expect(repo.getJobById(db, id)!.rewrittenLatex).toBeNull();
    expect(repo.getResumeChanges(db, id)).toEqual([]);
  });
});

describe('RecordRewriteCommand — version-ID undo (autosave race)', () => {
  beforeEach(seedResumeConfig);

  it('records the pre-regenerate version and undo restores it by id', () => {
    const id = seedJob('rewriting');
    executeRecordRewrite(db, id, 'v1');

    // Regenerate to v2.
    executeRecordRewrite(db, id, 'v2');
    expect(repo.getJobById(db, id)!.rewrittenLatex).toBe('v2');

    undoLastCommand(db, id);
    expect(repo.getJobById(db, id)!.rewrittenLatex).toBe('v1');
    expect(statusOf(id)).toBe('rewriting'); // status unchanged across regenerate
  });

  it('undo is unaffected by autosaves written after the regenerate (no timestamp race)', () => {
    const id = seedJob('rewriting');
    executeRecordRewrite(db, id, 'v1');

    executeRecordRewrite(db, id, 'v2');

    // A debounced autosave fires AFTER the regenerate, appending newer versions.
    repo.appendRewriteVersion(db, id, 'v2-edited', 'autosave');
    repo.setRewrittenLatex(db, id, 'v2-edited');
    repo.appendRewriteVersion(db, id, 'v2-edited-more', 'autosave');
    repo.setRewrittenLatex(db, id, 'v2-edited-more');

    // Undo restores the exact recorded pre-regenerate version by id — NOT the
    // latest-by-timestamp, which would be the autosave.
    undoLastCommand(db, id);
    expect(repo.getJobById(db, id)!.rewrittenLatex).toBe('v1');
  });
});

describe('RecordRewriteCommand — persisted diff, one transaction', () => {
  beforeEach(seedResumeConfig);

  it('recording a rewrite recomputes resume_changes to describe the new LaTeX', () => {
    const id = seedJob('rewriting');
    executeRecordRewrite(db, id, 'v1 latex');
    expect(repo.getResumeChanges(db, id)).toEqual(computeLatexDiff(RESUME, 'v1 latex'));

    executeRecordRewrite(db, id, 'v2 latex');
    expect(repo.getResumeChanges(db, id)).toEqual(computeLatexDiff(RESUME, 'v2 latex'));
  });

  it('the version write and the diff write commit or roll back together', () => {
    const id = seedJob('rewriting');
    // Force the diff write to fail mid-command: the version append, the
    // denormalized LaTeX, and the command row must not survive without it.
    db.exec(`DROP TABLE resume_changes`);

    expect(() => executeRecordRewrite(db, id, 'v1 latex')).toThrow(/resume_changes/);
    expect(repo.getLatestRewriteVersionId(db, id)).toBeUndefined();
    expect(repo.getJobById(db, id)!.rewrittenLatex).toBeNull();
    expect(commandCount(id)).toBe(0);
  });

  it('undo recomputes resume_changes to describe the restored LaTeX', () => {
    const id = seedJob('rewriting');
    executeRecordRewrite(db, id, 'v1 latex');

    // Regenerate to v2; the command persists the v2 diff in the same transaction.
    executeRecordRewrite(db, id, 'v2 latex');
    expect(repo.getResumeChanges(db, id)).toEqual(computeLatexDiff(RESUME, 'v2 latex'));

    undoLastCommand(db, id);
    expect(repo.getJobById(db, id)!.rewrittenLatex).toBe('v1 latex');
    expect(repo.getResumeChanges(db, id)).toEqual(computeLatexDiff(RESUME, 'v1 latex'));
  });

  it('undo fails loudly (and keeps the command) when the recorded version row is missing', () => {
    const id = seedJob('rewriting');
    executeRecordRewrite(db, id, 'v1 latex');
    executeRecordRewrite(db, id, 'v2 latex');

    // Simulate a corrupted DB: the version row the command references is gone.
    // (The FK on command_history.version_id forbids this normally, so disable
    // enforcement for the corrupting delete.)
    db.pragma('foreign_keys = OFF');
    db.prepare(`DELETE FROM rewritten_latex_versions WHERE job_id = ? AND content = 'v1 latex'`).run(
      id,
    );
    db.pragma('foreign_keys = ON');

    expect(() => undoLastCommand(db, id)).toThrow(/version/i);
    expect(commandCount(id)).toBe(2); // transaction rolled back; undo not consumed
    expect(repo.getJobById(db, id)!.rewrittenLatex).toBe('v2 latex');
  });
});

describe('RecordRewriteCommand — explanation state across execute/undo', () => {
  beforeEach(seedResumeConfig);

  it('undoing a first generation clears the stored explanation with the LaTeX and diff', () => {
    const id = seedJob('rewriting');
    executeRecordRewrite(db, id, 'v1 latex');
    repo.setExplanation(db, id, '{"summary":"why v1","bullets":[]}');

    undoLastCommand(db, id);
    const job = repo.getJobById(db, id)!;
    expect(job.rewrittenLatex).toBeNull();
    expect(job.explanation).toBeNull();
    expect(repo.getResumeChanges(db, id)).toEqual([]);
  });

  it('undoing a regeneration clears the stored explanation (rationales are not versioned)', () => {
    const id = seedJob('rewriting');
    executeRecordRewrite(db, id, 'v1 latex');
    executeRecordRewrite(db, id, 'v2 latex');
    repo.setExplanation(db, id, '{"summary":"why v2","bullets":[]}');

    undoLastCommand(db, id);
    const job = repo.getJobById(db, id)!;
    expect(job.rewrittenLatex).toBe('v1 latex'); // the "what" is restored…
    expect(job.explanation).toBeNull(); // …and the discarded "why" is not left behind
  });

  it('recording a rewrite leaves an existing explanation untouched (explain overwrites it when re-run)', () => {
    const id = seedJob('rewriting');
    executeRecordRewrite(db, id, 'v1 latex');
    repo.setExplanation(db, id, '{"summary":"why v1","bullets":[]}');

    executeRecordRewrite(db, id, 'v2 latex');
    expect(repo.getJobById(db, id)!.explanation).toBe('{"summary":"why v1","bullets":[]}');
  });
});

describe('undoLastCommand — stack behavior', () => {
  it('returns null when there is nothing to undo', () => {
    const id = seedJob('scored');
    expect(undoLastCommand(db, id)).toBeNull();
  });

  it('undoes commands in last-in-first-out order', () => {
    const id = seedJob('scored');
    executeContinue(db, id); // scored → rewriting
    executeApproveRewrite(db, id, 'path'); // rewriting → approved
    executeChangeTrackerStatus(db, id, 'applied'); // approved → applied

    expect(statusOf(id)).toBe('applied');
    undoLastCommand(db, id);
    expect(statusOf(id)).toBe('approved');
    undoLastCommand(db, id);
    expect(statusOf(id)).toBe('rewriting');
    undoLastCommand(db, id);
    expect(statusOf(id)).toBe('scored');
    expect(commandCount(id)).toBe(0);
  });
});
