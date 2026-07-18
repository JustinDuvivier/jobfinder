/**
 * Compile LaTeX to PDF in a hardened sandbox, with a SHA-256 → PDF cache.
 *
 * Flow: hash the LaTeX; on a cache hit return the stored bytes + page count
 * without invoking pdflatex; on a miss write the source into an isolated temp
 * directory, run pdflatex with the sandbox flags/env, read the resulting PDF,
 * count its pages, cache it, and clean up the temp directory. Nothing is ever
 * written to the output directory here — that is /api/save's job.
 *
 * Both /api/compile (preview) and /api/save (approve) use this; /api/save then
 * enforces the one-page gate via the returned pageCount before writing to disk.
 *
 * See jobfinder-docs.md "LaTeX + PDF Pipeline".
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashLatex } from './hash';
import { LruCache } from './cache';
import { countPdfPages } from './page-count';
import {
  PDFLATEX_BIN,
  COMPILE_TIMEOUT_MS,
  TEX_JOBNAME,
  COMPILE_CACHE_MAX,
  buildPdflatexArgs,
  buildSandboxEnv,
} from './sandbox';

export interface CompileResult {
  /** Compiled PDF bytes. */
  pdf: Uint8Array;
  /** Number of pages — the one-page gate checks this is 1 at save time. */
  pageCount: number;
  /** SHA-256 of the source LaTeX (stored in jobs.latex_hash). */
  hash: string;
  /** True if served from the in-memory cache (no pdflatex invocation). */
  cached: boolean;
}

/** Thrown when pdflatex fails, times out, or cannot start. Carries the log tail. */
export class LatexCompileError extends Error {
  constructor(
    message: string,
    readonly log: string = '',
  ) {
    super(message);
    this.name = 'LatexCompileError';
  }
}

const cache = new LruCache<string, { pdf: Uint8Array; pageCount: number }>(COMPILE_CACHE_MAX);

/** Clear the process-local compile cache (used by tests). */
export function clearCompileCache(): void {
  cache.clear();
}

function tail(text: string, lines = 25): string {
  return text.split('\n').slice(-lines).join('\n');
}

function runPdflatex(dir: string, texFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(PDFLATEX_BIN, buildPdflatexArgs(dir, texFile), {
      cwd: dir,
      env: buildSandboxEnv(),
      shell: false,
      timeout: COMPILE_TIMEOUT_MS,
    });

    let out = '';
    child.stdout?.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      out += chunk;
    });

    child.on('error', (err) => {
      reject(new LatexCompileError(`pdflatex failed to start: ${err.message}`, tail(out)));
    });
    child.on('close', (code, signal) => {
      if (signal) {
        reject(
          new LatexCompileError(
            `pdflatex was killed (${signal}) — likely a timeout after ${COMPILE_TIMEOUT_MS}ms`,
            tail(out),
          ),
        );
      } else if (code !== 0) {
        reject(new LatexCompileError(`pdflatex exited with code ${code}`, tail(out)));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Compile `latex` to a PDF. Deterministic for identical input (SOURCE_DATE_EPOCH
 * is fixed) and cached by source hash.
 */
export async function compileLatex(latex: string): Promise<CompileResult> {
  const hash = hashLatex(latex);
  const hit = cache.get(hash);
  if (hit) {
    return { pdf: hit.pdf, pageCount: hit.pageCount, hash, cached: true };
  }

  const dir = await mkdtemp(join(tmpdir(), 'jobfinder-tex-'));
  try {
    const texFile = `${TEX_JOBNAME}.tex`;
    await writeFile(join(dir, texFile), latex, 'utf8');
    await runPdflatex(dir, texFile);

    const pdf = await readFile(join(dir, `${TEX_JOBNAME}.pdf`));
    const pageCount = await countPdfPages(pdf);
    const bytes = new Uint8Array(pdf);

    cache.set(hash, { pdf: bytes, pageCount });
    return { pdf: bytes, pageCount, hash, cached: false };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
