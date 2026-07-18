import { describe, it, expect } from 'vitest';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { containedDir, isWithinBase } from './open-folder';

const BASE = resolve(tmpdir(), 'jobfinder-base');

describe('isWithinBase', () => {
  it('accepts a file inside the base directory', () => {
    expect(isWithinBase(join(BASE, '20260618', 'Stripe_AI_Engineer', 'r.pdf'), BASE)).toBe(true);
  });

  it('accepts the base directory itself', () => {
    expect(isWithinBase(BASE, BASE)).toBe(true);
  });

  it('rejects a directory-traversal escape', () => {
    expect(isWithinBase(join(BASE, '..', 'secret', 'r.pdf'), BASE)).toBe(false);
  });

  it('rejects a sibling that merely shares the base prefix', () => {
    expect(isWithinBase(resolve(tmpdir(), 'jobfinder-base-other', 'r.pdf'), BASE)).toBe(false);
  });

  it('rejects an unrelated absolute path', () => {
    expect(isWithinBase(resolve(tmpdir(), 'elsewhere', 'r.pdf'), BASE)).toBe(false);
  });
});

describe('containedDir', () => {
  it('returns the containing folder of a contained file without opening anything', () => {
    const file = join(BASE, '20260618', 'Stripe_AI_Engineer', 'r.pdf');
    expect(containedDir(file, BASE)).toBe(join(BASE, '20260618', 'Stripe_AI_Engineer'));
  });

  it('throws for a path that escapes the base directory', () => {
    expect(() => containedDir(join(BASE, '..', 'secret', 'r.pdf'), BASE)).toThrow(
      'Refusing to open a path outside the output directory',
    );
  });
});
