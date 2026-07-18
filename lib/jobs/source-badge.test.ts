import { describe, it, expect } from 'vitest';
import { sourceBadge } from './source-badge';

describe('sourceBadge', () => {
  it('maps linkedin to its labeled steel chip', () => {
    expect(sourceBadge('linkedin')).toEqual({
      label: 'LinkedIn',
      className: 'badge badge-linkedin',
      title: 'Scraped from LinkedIn',
    });
  });

  it('maps greenhouse to its labeled green chip', () => {
    expect(sourceBadge('greenhouse')).toEqual({
      label: 'Greenhouse',
      className: 'badge badge-greenhouse',
      title: 'Scraped from a Greenhouse job board (via the aggregator)',
    });
  });

  it('pairs the base .badge class with a per-source variant for both sources', () => {
    for (const source of ['linkedin', 'greenhouse'] as const) {
      const { className } = sourceBadge(source);
      expect(className.startsWith('badge ')).toBe(true);
      expect(className).toBe(`badge badge-${source}`);
    }
  });
});
