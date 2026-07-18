import { describe, expect, it } from 'vitest';
import { addWeeks, jobWeekKey, mondayOf, sqliteUtcMs, weekKeyOf, weekLabel } from './week';

describe('sqliteUtcMs', () => {
  it('parses a SQLite datetime as UTC', () => {
    expect(sqliteUtcMs('2026-07-06 14:30:00')).toBe(Date.UTC(2026, 6, 6, 14, 30, 0));
  });

  it('returns NaN for garbage', () => {
    expect(sqliteUtcMs('not a date')).toBeNaN();
    expect(sqliteUtcMs('')).toBeNaN();
  });
});

describe('mondayOf / weekKeyOf', () => {
  // Local-component dates on both sides, so these hold in any timezone.
  it('maps a mid-week day to its Monday', () => {
    expect(weekKeyOf(new Date(2026, 6, 8))).toBe('2026-07-06'); // Wed Jul 8
  });

  it('maps a Monday to itself', () => {
    expect(weekKeyOf(new Date(2026, 6, 6))).toBe('2026-07-06');
  });

  it('maps a Sunday to the previous Monday, not the next', () => {
    expect(weekKeyOf(new Date(2026, 6, 12))).toBe('2026-07-06'); // Sun Jul 12
  });

  it('crosses a month boundary', () => {
    expect(weekKeyOf(new Date(2026, 7, 1))).toBe('2026-07-27'); // Sat Aug 1
  });

  it('crosses a year boundary', () => {
    expect(weekKeyOf(new Date(2026, 0, 1))).toBe('2025-12-29'); // Thu Jan 1
  });

  it('returns local midnight from mondayOf', () => {
    const m = mondayOf(new Date(2026, 6, 8, 23, 59, 59));
    expect([m.getHours(), m.getMinutes(), m.getSeconds()]).toEqual([0, 0, 0]);
  });
});

describe('addWeeks', () => {
  it('steps forward and backward', () => {
    expect(addWeeks('2026-07-06', 1)).toBe('2026-07-13');
    expect(addWeeks('2026-07-06', -1)).toBe('2026-06-29');
  });

  it('steps across a year boundary', () => {
    expect(addWeeks('2025-12-29', 1)).toBe('2026-01-05');
    expect(addWeeks('2026-01-05', -1)).toBe('2025-12-29');
  });

  it('steps across the spring DST change onto a real Monday', () => {
    // US DST starts Sun Mar 8 2026; the following key must still be a Monday.
    expect(addWeeks('2026-03-02', 1)).toBe('2026-03-09');
  });

  it('is symmetric: n weeks forward then back is identity', () => {
    expect(addWeeks(addWeeks('2026-07-06', 5), -5)).toBe('2026-07-06');
  });
});

describe('weekLabel', () => {
  it('shows the Monday–Sunday range with the year on the end date', () => {
    const label = weekLabel('2026-06-29');
    expect(label).toContain(' – ');
    expect(label).toContain('29'); // Monday Jun 29
    expect(label).toContain('5'); // Sunday Jul 5
    expect(label).toContain('2026');
    expect(label.indexOf('2026')).toBe(label.lastIndexOf('2026')); // year once when it doesn't change
  });

  it('puts a year on both ends when the week spans two years', () => {
    const label = weekLabel('2025-12-29');
    expect(label).toContain('2025');
    expect(label).toContain('2026');
  });
});

describe('jobWeekKey', () => {
  it('buckets a created_at into the same week as its parsed instant', () => {
    const ts = '2026-07-08 12:00:00';
    expect(jobWeekKey(ts)).toBe(weekKeyOf(new Date(sqliteUtcMs(ts))));
  });

  it('returns null for an unparseable timestamp', () => {
    expect(jobWeekKey('garbage')).toBeNull();
  });
});
