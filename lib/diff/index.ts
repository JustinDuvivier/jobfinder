/**
 * LaTeX diff for the "what changed" panel (FR-13). When a rewrite stream
 * completes, the /api/rewrite route computes the character-level diff between
 * the original and rewritten LaTeX with diff-match-patch, then runs
 * diff_cleanupSemantic so the rendered diff coalesces character-level churn
 * into human-meaningful chunks rather than fragments of LaTeX commands.
 *
 * The result maps directly to resume_changes rows (block_type, content, seq);
 * the route persists it server-side in the same transaction as the rewrite.
 * It reflects exactly what changed in the text, not a model-described summary —
 * the *why* comes from the separate explanation call.
 *
 * Pure and synchronous (well under 100ms regardless of resume length), so it is
 * exhaustively testable in Node.
 *
 * See jobfinder-docs.md "Rewrite prompt".
 */
import { diff_match_patch } from 'diff-match-patch';

export type DiffBlockType = 'insert' | 'delete' | 'equal';

export interface DiffBlock {
  blockType: DiffBlockType;
  content: string;
  /** 0-based ordering for stable rendering and resume_changes rows. */
  seq: number;
}

// diff-match-patch op codes: -1 delete, 0 equal, 1 insert.
function opToType(op: number): DiffBlockType {
  if (op < 0) return 'delete';
  if (op > 0) return 'insert';
  return 'equal';
}

/**
 * Whether a diff records any actual edit (an insert or delete block). An
 * empty or all-equal diff means the rewrite landed identical to the base —
 * a valid outcome with nothing to show in the Changes panel or explain.
 */
export function hasEdits(blocks: DiffBlock[]): boolean {
  return blocks.some((block) => block.blockType !== 'equal');
}

/**
 * Compute the semantic-cleaned diff between two LaTeX strings as ordered blocks.
 * Empty segments are dropped and the remaining blocks are sequenced from 0.
 */
export function computeLatexDiff(original: string, rewritten: string): DiffBlock[] {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(original, rewritten);
  dmp.diff_cleanupSemantic(diffs);

  const blocks: DiffBlock[] = [];
  for (const [op, text] of diffs) {
    if (text.length === 0) continue;
    blocks.push({ blockType: opToType(op), content: text, seq: blocks.length });
  }
  return blocks;
}
