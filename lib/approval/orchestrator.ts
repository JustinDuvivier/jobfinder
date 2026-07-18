/**
 * Approval orchestrator — the approve & save saga (FR-17–FR-20, invariants #1
 * and #4), extracted from the /api/save route so the one-page gate, the
 * server-side path build, and the disk-before-DB ordering are unit-tested
 * behavior rather than route code reachable only over HTTP.
 *
 * The sequence, in order:
 *   1. compile the LaTeX (sandboxed, cache-checked),
 *   2. verify the PDF is EXACTLY one page — refusing otherwise (invariant #1),
 *   3. build the output path server-side via PathBuilder (NFR-7),
 *   4. write the PDF to disk, then
 *   5. commit APPROVED + the saved path + the LaTeX hash atomically (FR-19).
 *
 * If the disk write fails the DB transaction never opens; if the DB commit
 * fails after the disk write, the transaction rolls back and the orphaned file
 * is overwritten on the next approval (documented). The compiler and the
 * filesystem are injected dependencies (the same seam discipline the LinkedIn
 * strategy uses for fetch/sleep) so every failure ordering is testable with
 * fakes; production wiring is the real compileLatex and node:fs.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import type { DB } from '../db/index';
import type { JobStatus } from '../types';
import * as repo from '../db/repo';
import { compileLatex, LatexCompileError, type CompileResult } from '../latex/compile';
import { buildResumePath } from '../path-builder';
import { canApprove } from '../status/transitions';
import { executeApproveRewrite } from '../commands';
import { DEFAULT_OWNER_NAME } from '../types';

/** The filesystem seam: directory creation is recursive, writes overwrite. */
export interface ApprovalFs {
  mkdir(dir: string): Promise<void>;
  writeFile(filePath: string, data: Uint8Array): Promise<void>;
}

export interface ApprovalDeps {
  compile: (latex: string) => Promise<CompileResult>;
  fs: ApprovalFs;
  /** Approval time — the source of the YYYYMMDD folder. */
  now: () => Date;
}

const PRODUCTION_DEPS: ApprovalDeps = {
  compile: compileLatex,
  fs: {
    mkdir: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    writeFile: (filePath, data) => writeFile(filePath, Buffer.from(data)),
  },
  now: () => new Date(),
};

export interface ApprovalInput {
  jobId: number;
  /** Server-side configured output base directory (from env). */
  baseDir: string;
}

export type ApprovalResult =
  | { kind: 'approved'; savedPath: string; relativePath: string }
  | { kind: 'job-not-found' }
  | { kind: 'invalid-status'; status: JobStatus }
  | { kind: 'no-latex' }
  | { kind: 'compile-error'; log: string }
  | { kind: 'compile-failed' }
  | { kind: 'not-one-page'; pageCount: number }
  | { kind: 'write-failed' }
  | { kind: 'db-failed' };

/**
 * Run the full approval saga for a job. Never throws — every outcome is a
 * variant of the discriminated result, which the route maps to HTTP responses.
 */
export async function approveAndSave(
  db: DB,
  input: ApprovalInput,
  deps: Partial<ApprovalDeps> = {},
): Promise<ApprovalResult> {
  const compile = deps.compile ?? PRODUCTION_DEPS.compile;
  const fs = deps.fs ?? PRODUCTION_DEPS.fs;
  const now = deps.now ?? PRODUCTION_DEPS.now;

  const job = repo.getJobById(db, input.jobId);
  if (!job) return { kind: 'job-not-found' };
  if (!canApprove(job.status)) return { kind: 'invalid-status', status: job.status };
  const latex = job.rewrittenLatex;
  if (!latex || latex.trim().length === 0) return { kind: 'no-latex' };

  // 1. Compile.
  let compiled: CompileResult;
  try {
    compiled = await compile(latex);
  } catch (err) {
    if (err instanceof LatexCompileError) return { kind: 'compile-error', log: err.log };
    return { kind: 'compile-failed' };
  }

  // 2. One-page gate — refuse anything other than exactly one page.
  if (compiled.pageCount !== 1) {
    return { kind: 'not-one-page', pageCount: compiled.pageCount };
  }

  // 3. Build the path server-side from identifiers.
  const ownerName = repo.getUserConfig(db)?.ownerName ?? DEFAULT_OWNER_NAME;
  const built = buildResumePath({
    baseDir: input.baseDir,
    jobId: job.jobId,
    company: job.company,
    title: job.title,
    ownerName,
    date: now(),
  });

  // 4. Disk write (before the DB transaction opens).
  try {
    await fs.mkdir(built.dir);
    await fs.writeFile(built.filePath, compiled.pdf);
  } catch {
    return { kind: 'write-failed' };
  }

  // 5. Atomic DB commit: APPROVED + saved path + command history + LaTeX hash.
  try {
    executeApproveRewrite(db, input.jobId, built.filePath, compiled.hash);
  } catch {
    return { kind: 'db-failed' };
  }

  return { kind: 'approved', savedPath: built.filePath, relativePath: built.relativePath };
}
