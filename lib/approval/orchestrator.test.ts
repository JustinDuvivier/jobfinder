import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../db/index';
import * as repo from '../db/repo';
import { undoLastCommand } from '../commands';
import { LatexCompileError, type CompileResult } from '../latex/compile';
import { approveAndSave, type ApprovalFs } from './orchestrator';
import type { JobStatus } from '../types';

const LATEX = '\\documentclass{article}\\begin{document}resume\\end{document}';
const BASE_DIR = 'C:\\out';
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
/** Fixed approval date so the YYYYMMDD folder is deterministic. */
const NOW = (): Date => new Date(2026, 6, 11);

let db: DB;
let seq = 0;

function seedJob(status: JobStatus = 'rewriting', rewrittenLatex: string | null = LATEX): number {
  seq += 1;
  const info = db
    .prepare(
      `INSERT INTO jobs (job_id, company, title, url, status, rewritten_latex)
       VALUES (?, 'Stripe', 'AI Engineer', 'https://x', ?, ?)`,
    )
    .run(`lk-${seq}`, status, rewrittenLatex);
  return Number(info.lastInsertRowid);
}

function commandCount(id: number): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM command_history WHERE job_id = ?`).get(id) as {
      n: number;
    }
  ).n;
}

function fakeCompiler(overrides: Partial<CompileResult> = {}): {
  compile: (latex: string) => Promise<CompileResult>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    compile: async (latex: string): Promise<CompileResult> => {
      calls.push(latex);
      return { pdf: PDF_BYTES, pageCount: 1, hash: 'hash-1', cached: false, ...overrides };
    },
  };
}

function throwingCompiler(err: Error): (latex: string) => Promise<CompileResult> {
  return async () => {
    throw err;
  };
}

function fakeFs(opts: { failWrite?: boolean } = {}): {
  fs: ApprovalFs;
  dirs: string[];
  writes: Array<{ filePath: string; data: Uint8Array }>;
} {
  const dirs: string[] = [];
  const writes: Array<{ filePath: string; data: Uint8Array }> = [];
  return {
    dirs,
    writes,
    fs: {
      async mkdir(dir) {
        dirs.push(dir);
      },
      async writeFile(filePath, data) {
        if (opts.failWrite) throw new Error('ENOSPC: no space left on device');
        writes.push({ filePath, data });
      },
    },
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('approveAndSave — happy path', () => {
  it('compiles, writes the PDF, and commits the approval atomically', async () => {
    const id = seedJob();
    const compiler = fakeCompiler();
    const disk = fakeFs();

    const result = await approveAndSave(db, { jobId: id, baseDir: BASE_DIR }, {
      compile: compiler.compile,
      fs: disk.fs,
      now: NOW,
    });

    expect(result.kind).toBe('approved');
    if (result.kind !== 'approved') return;
    expect(result.savedPath).toContain('20260711');
    expect(result.savedPath).toContain('Alex_Candidate_Resume.pdf');
    expect(result.relativePath.startsWith('20260711')).toBe(true);

    expect(compiler.calls).toEqual([LATEX]);
    expect(disk.writes).toHaveLength(1);
    expect(disk.writes[0]!.filePath).toBe(result.savedPath);
    expect(disk.writes[0]!.data).toEqual(PDF_BYTES);
    expect(disk.dirs).toHaveLength(1);

    const job = repo.getJobById(db, id)!;
    expect(job.status).toBe('approved');
    expect(job.approvedPdfPath).toBe(result.savedPath);
    expect(job.latexHash).toBe('hash-1');
    expect(commandCount(id)).toBe(1);
  });

  it('uses the configured owner name in the filename', async () => {
    db.prepare(`INSERT INTO user_config (id, owner_name) VALUES (1, 'Jane_Doe')`).run();
    const id = seedJob();
    const disk = fakeFs();

    const result = await approveAndSave(db, { jobId: id, baseDir: BASE_DIR }, {
      compile: fakeCompiler().compile,
      fs: disk.fs,
      now: NOW,
    });

    expect(result.kind).toBe('approved');
    if (result.kind !== 'approved') return;
    expect(result.savedPath.endsWith('Jane_Doe_Resume.pdf')).toBe(true);
  });

  it('re-approving after undo maps to the same path (overwrite semantics, FR-20)', async () => {
    const id = seedJob();
    const deps = { compile: fakeCompiler().compile, fs: fakeFs().fs, now: NOW };

    const first = await approveAndSave(db, { jobId: id, baseDir: BASE_DIR }, deps);
    expect(first.kind).toBe('approved');
    undoLastCommand(db, id);
    expect(repo.getJobById(db, id)!.status).toBe('rewriting');

    const second = await approveAndSave(db, { jobId: id, baseDir: BASE_DIR }, deps);
    expect(second.kind).toBe('approved');
    if (first.kind !== 'approved' || second.kind !== 'approved') return;
    expect(second.savedPath).toBe(first.savedPath);
  });
});

describe('approveAndSave — one-page gate (invariant #1)', () => {
  it('refuses a two-page PDF with nothing written and status unchanged', async () => {
    const id = seedJob();
    const disk = fakeFs();

    const result = await approveAndSave(db, { jobId: id, baseDir: BASE_DIR }, {
      compile: fakeCompiler({ pageCount: 2 }).compile,
      fs: disk.fs,
      now: NOW,
    });

    expect(result).toEqual({ kind: 'not-one-page', pageCount: 2 });
    expect(disk.dirs).toHaveLength(0);
    expect(disk.writes).toHaveLength(0);
    const job = repo.getJobById(db, id)!;
    expect(job.status).toBe('rewriting');
    expect(job.approvedPdfPath).toBeNull();
    expect(commandCount(id)).toBe(0);
  });
});

describe('approveAndSave — compile failure', () => {
  it('surfaces the compile log and leaves the job untouched', async () => {
    const id = seedJob();
    const disk = fakeFs();

    const result = await approveAndSave(db, { jobId: id, baseDir: BASE_DIR }, {
      compile: throwingCompiler(new LatexCompileError('pdflatex exited with code 1', '! Undefined control sequence.')),
      fs: disk.fs,
      now: NOW,
    });

    expect(result).toEqual({ kind: 'compile-error', log: '! Undefined control sequence.' });
    expect(disk.writes).toHaveLength(0);
    expect(repo.getJobById(db, id)!.status).toBe('rewriting');
    expect(commandCount(id)).toBe(0);
  });

  it('maps an unexpected compiler error to compile-failed', async () => {
    const id = seedJob();
    const result = await approveAndSave(db, { jobId: id, baseDir: BASE_DIR }, {
      compile: throwingCompiler(new Error('mkdtemp EACCES')),
      fs: fakeFs().fs,
      now: NOW,
    });
    expect(result).toEqual({ kind: 'compile-failed' });
    expect(repo.getJobById(db, id)!.status).toBe('rewriting');
  });
});

describe('approveAndSave — disk-before-DB ordering (invariant #4)', () => {
  it('a disk-write failure means the DB commit never happens', async () => {
    const id = seedJob();
    const disk = fakeFs({ failWrite: true });

    const result = await approveAndSave(db, { jobId: id, baseDir: BASE_DIR }, {
      compile: fakeCompiler().compile,
      fs: disk.fs,
      now: NOW,
    });

    expect(result).toEqual({ kind: 'write-failed' });
    const job = repo.getJobById(db, id)!;
    expect(job.status).toBe('rewriting');
    expect(job.approvedPdfPath).toBeNull();
    expect(job.latexHash).toBeNull();
    expect(commandCount(id)).toBe(0);
  });

  it('a DB failure after the disk write rolls back and surfaces the error', async () => {
    const id = seedJob();
    const disk = fakeFs();
    // Force the command_history insert inside the approval transaction to fail.
    db.exec(`DROP TABLE command_history`);

    const result = await approveAndSave(db, { jobId: id, baseDir: BASE_DIR }, {
      compile: fakeCompiler().compile,
      fs: disk.fs,
      now: NOW,
    });

    expect(result).toEqual({ kind: 'db-failed' });
    expect(disk.writes).toHaveLength(1); // the PDF was written before the DB step
    const job = repo.getJobById(db, id)!;
    expect(job.status).toBe('rewriting'); // transaction rolled back
    expect(job.approvedPdfPath).toBeNull();
    expect(job.latexHash).toBeNull();
  });
});

describe('approveAndSave — preconditions', () => {
  it('returns job-not-found for an unknown id', async () => {
    const result = await approveAndSave(db, { jobId: 999, baseDir: BASE_DIR }, {
      compile: fakeCompiler().compile,
      fs: fakeFs().fs,
      now: NOW,
    });
    expect(result).toEqual({ kind: 'job-not-found' });
  });

  it('refuses a job that is not in rewriting', async () => {
    const id = seedJob('scored');
    const result = await approveAndSave(db, { jobId: id, baseDir: BASE_DIR }, {
      compile: fakeCompiler().compile,
      fs: fakeFs().fs,
      now: NOW,
    });
    expect(result).toEqual({ kind: 'invalid-status', status: 'scored' });
  });

  it('refuses a job with no rewritten LaTeX', async () => {
    const id = seedJob('rewriting', '   ');
    const compiler = fakeCompiler();
    const result = await approveAndSave(db, { jobId: id, baseDir: BASE_DIR }, {
      compile: compiler.compile,
      fs: fakeFs().fs,
      now: NOW,
    });
    expect(result).toEqual({ kind: 'no-latex' });
    expect(compiler.calls).toHaveLength(0);
  });
});
