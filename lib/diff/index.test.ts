import { describe, it, expect } from 'vitest';
import { computeLatexDiff, hasEdits, type DiffBlock } from './index';

/** Reconstruct the original text from a diff (equal + delete segments). */
function reconstructOriginal(blocks: DiffBlock[]): string {
  return blocks
    .filter((b) => b.blockType !== 'insert')
    .map((b) => b.content)
    .join('');
}

/** Reconstruct the rewritten text from a diff (equal + insert segments). */
function reconstructRewritten(blocks: DiffBlock[]): string {
  return blocks
    .filter((b) => b.blockType !== 'delete')
    .map((b) => b.content)
    .join('');
}

describe('computeLatexDiff', () => {
  it('returns a single equal block for identical input', () => {
    expect(computeLatexDiff('\\textbf{Hi}', '\\textbf{Hi}')).toEqual([
      { blockType: 'equal', content: '\\textbf{Hi}', seq: 0 },
    ]);
  });

  it('represents a pure insertion', () => {
    expect(computeLatexDiff('', 'added')).toEqual([
      { blockType: 'insert', content: 'added', seq: 0 },
    ]);
  });

  it('represents a pure deletion', () => {
    expect(computeLatexDiff('removed', '')).toEqual([
      { blockType: 'delete', content: 'removed', seq: 0 },
    ]);
  });

  it('captures a substitution as delete + insert', () => {
    const blocks = computeLatexDiff('\\textbf{Old}', '\\textbf{New}');
    expect(blocks.some((b) => b.blockType === 'delete' && b.content.includes('Old'))).toBe(true);
    expect(blocks.some((b) => b.blockType === 'insert' && b.content.includes('New'))).toBe(true);
  });

  it.each([
    ['\\section{Experience}\nFoo bar', '\\section{Experience}\nFoo baz qux'],
    ['line one\nline two', 'line one changed\nline two'],
    ['', 'all new content'],
    ['everything removed', ''],
  ])('reconstructs both sides exactly (%#)', (original, rewritten) => {
    const blocks = computeLatexDiff(original, rewritten);
    expect(reconstructOriginal(blocks)).toBe(original);
    expect(reconstructRewritten(blocks)).toBe(rewritten);
  });

  it('drops empty segments and sequences blocks from 0', () => {
    const blocks = computeLatexDiff('abc def', 'abc xyz def');
    expect(blocks.every((b) => b.content.length > 0)).toBe(true);
    expect(blocks.map((b) => b.seq)).toEqual(blocks.map((_, i) => i));
  });
});

describe('hasEdits', () => {
  it('is false for an empty diff (no persisted rows)', () => {
    expect(hasEdits([])).toBe(false);
  });

  it('is false when every block is equal (rewrite identical to the base)', () => {
    expect(hasEdits(computeLatexDiff('\\textbf{Hi}', '\\textbf{Hi}'))).toBe(false);
  });

  it('is true when the diff contains an insert or a delete', () => {
    expect(hasEdits(computeLatexDiff('', 'added'))).toBe(true);
    expect(hasEdits(computeLatexDiff('removed', ''))).toBe(true);
    expect(hasEdits(computeLatexDiff('\\textbf{Old}', '\\textbf{New}'))).toBe(true);
  });
});
