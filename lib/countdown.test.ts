import { describe, it, expect } from 'vitest';
import { formatCountdown } from './countdown';

describe('formatCountdown', () => {
  it('formats sub-minute durations as m:ss', () => {
    expect(formatCountdown(45_000)).toBe('0:45');
    expect(formatCountdown(5_000)).toBe('0:05');
  });

  it('formats minutes as m:ss without leading-zero minutes', () => {
    expect(formatCountdown(90_000)).toBe('1:30');
    expect(formatCountdown(9 * 60_000)).toBe('9:00');
  });

  it('rounds seconds up so a fresh interval shows its full value', () => {
    // 5 minutes exactly, and just-under, both read "5:00" rather than "4:59".
    expect(formatCountdown(5 * 60_000)).toBe('5:00');
    expect(formatCountdown(5 * 60_000 - 1)).toBe('5:00');
    expect(formatCountdown(999)).toBe('0:01');
  });

  it('switches to h:mm:ss at or above one hour', () => {
    expect(formatCountdown(60 * 60_000)).toBe('1:00:00');
    expect(formatCountdown(90 * 60_000)).toBe('1:30:00');
    expect(formatCountdown((2 * 3600 + 5 * 60 + 9) * 1000)).toBe('2:05:09');
  });

  it('clamps zero and negative durations to 0:00', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5_000)).toBe('0:00');
  });
});
