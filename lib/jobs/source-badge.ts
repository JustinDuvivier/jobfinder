/**
 * Presentation helper for a job's provenance. Maps the `JobSource` union to the
 * label, CSS class, and hover title of the badge rendered in the decision queue,
 * so the UI stays a thin renderer and the source→chip mapping is unit-tested in
 * one place. Purely deterministic — no I/O, no state.
 */
import type { JobSource } from '../types';

/** The renderable pieces of a source badge. `className` pairs the base `.badge`
 *  with the per-source variant defined in app/globals.css. */
export interface SourceBadge {
  label: string;
  className: string;
  title: string;
}

/** The badge to render for a job's `source`. Exhaustive over `JobSource`. */
export function sourceBadge(source: JobSource): SourceBadge {
  switch (source) {
    case 'linkedin':
      return {
        label: 'LinkedIn',
        className: 'badge badge-linkedin',
        title: 'Scraped from LinkedIn',
      };
    case 'greenhouse':
      return {
        label: 'Greenhouse',
        className: 'badge badge-greenhouse',
        title: 'Scraped from a Greenhouse job board (via the aggregator)',
      };
    default: {
      const exhaustive: never = source;
      throw new Error(`Unknown job source: ${String(exhaustive)}`);
    }
  }
}
