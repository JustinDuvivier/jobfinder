/**
 * Sandbox configuration for invoking pdflatex on untrusted (LLM-generated, then
 * user-edited) LaTeX. The hardening is on three axes (jobfinder-docs.md
 * "Compile sandboxing", NFR-7):
 *
 *   1. No shell escape — `-no-shell-escape` closes \write18 regardless of the
 *      local TeX configuration's restricted-shell-escape whitelist.
 *   2. Hard timeout — the subprocess is killed after COMPILE_TIMEOUT_MS, which
 *      defends against a "LaTeX bomb" (deeply nested / self-referential macros).
 *   3. Restricted file reads — `openin_any`/`openout_any` set to paranoid so
 *      \input{/etc/passwd} and friends cannot pull in local files, and the
 *      compile runs in an isolated temp directory.
 *
 * These functions are pure so the security contract is unit-testable without
 * running pdflatex.
 */

/** The pdflatex executable. Override via env for non-PATH installs. */
export const PDFLATEX_BIN = process.env.JOBFINDER_PDFLATEX_PATH ?? 'pdflatex';

/** Hard wall-clock cap for a single compile. Generous for a one-page resume. */
export const COMPILE_TIMEOUT_MS = 8000;

/** Fixed jobname so the output is `<jobname>.pdf` deterministically. */
export const TEX_JOBNAME = 'resume';

/**
 * Fixed epoch (2020-01-01 UTC) for SOURCE_DATE_EPOCH so pdflatex does not embed
 * the wall-clock time — making identical LaTeX compile to identical bytes
 * (NFR-6).
 */
export const SOURCE_DATE_EPOCH = '1577836800';

/** Max number of compiled PDFs held in the in-memory compile cache. */
export const COMPILE_CACHE_MAX = 32;

/**
 * Build the pdflatex argument vector. `texFile` is relative to the output
 * directory (which is also the working directory), so no client-supplied path
 * ever reaches the command line.
 */
export function buildPdflatexArgs(outputDir: string, texFile: string): string[] {
  return [
    '-no-shell-escape',
    '-interaction=nonstopmode',
    '-halt-on-error',
    `-output-directory=${outputDir}`,
    texFile,
  ];
}

/**
 * Build the child-process environment: inherit the base env (so pdflatex finds
 * its own TEXMF tree and PATH) but force the security-relevant variables —
 * deterministic timestamp and paranoid file access.
 */
export function buildSandboxEnv(
  base: Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    SOURCE_DATE_EPOCH,
    openin_any: 'p',
    openout_any: 'p',
  } as unknown as NodeJS.ProcessEnv;
}
