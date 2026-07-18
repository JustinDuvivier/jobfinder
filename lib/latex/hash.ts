/**
 * SHA-256 of LaTeX source — the key for the compile cache and the value stored
 * in jobs.latex_hash for the most recently compiled document.
 */
import { createHash } from 'node:crypto';

export function hashLatex(latex: string): string {
  return createHash('sha256').update(latex, 'utf8').digest('hex');
}
