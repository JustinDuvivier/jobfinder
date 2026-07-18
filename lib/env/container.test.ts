/**
 * Tests for the container-mode flag accessor. Pinned here: only the documented
 * value `1` (whitespace-tolerant) enables container mode — anything else,
 * including truthy-looking strings, leaves native behavior untouched. Each case
 * saves and restores process.env.JOBFINDER_CONTAINER so the cases stay
 * isolated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isContainerMode } from './container';

const ORIGINAL = process.env.JOBFINDER_CONTAINER;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.JOBFINDER_CONTAINER;
  else process.env.JOBFINDER_CONTAINER = ORIGINAL;
});

describe('isContainerMode', () => {
  it('is true when JOBFINDER_CONTAINER=1', () => {
    process.env.JOBFINDER_CONTAINER = '1';
    expect(isContainerMode()).toBe(true);
  });

  it('tolerates surrounding whitespace around the value', () => {
    process.env.JOBFINDER_CONTAINER = ' 1 ';
    expect(isContainerMode()).toBe(true);
  });

  it('is false when the variable is unset', () => {
    delete process.env.JOBFINDER_CONTAINER;
    expect(isContainerMode()).toBe(false);
  });

  it('is false for an empty string', () => {
    process.env.JOBFINDER_CONTAINER = '';
    expect(isContainerMode()).toBe(false);
  });

  it('is false for any value other than the documented "1"', () => {
    for (const value of ['0', 'true', 'yes', '2']) {
      process.env.JOBFINDER_CONTAINER = value;
      expect(isContainerMode()).toBe(false);
    }
  });
});
