/**
 * Tests for the Tracker's approved-PDF affordance helpers: the View PDF href
 * (FR-35) and the container-mode copy-path presentation (FR-30) — the copied
 * and displayed path prefers the server-computed `./output/...` form with the
 * docker-compose hint, falling back to the raw dir without one.
 */
import { describe, it, expect } from 'vitest';
import { copyPath, copyPathNotice, pdfHref } from './affordances';

describe('pdfHref', () => {
  it('links to the PDF stream route with the job id as the only parameter', () => {
    expect(pdfHref(42)).toBe('/api/jobs/pdf?jobId=42');
  });
});

describe('copyPath', () => {
  it('prefers the compose-relative form when the server provides one', () => {
    expect(copyPath({ opened: false, dir: '/output/20260618/Acme_Dev', relativeDir: './output/20260618/Acme_Dev' })).toBe(
      './output/20260618/Acme_Dev',
    );
  });

  it('falls back to the raw dir when no relative form is provided', () => {
    expect(copyPath({ opened: false, dir: '/output/20260618/Acme_Dev' })).toBe('/output/20260618/Acme_Dev');
  });
});

describe('copyPathNotice', () => {
  const withRelative = {
    opened: false,
    dir: '/output/20260618/Acme_Dev',
    relativeDir: './output/20260618/Acme_Dev',
  };

  it('announces the copied compose-relative path with the docker-compose hint', () => {
    expect(copyPathNotice(withRelative, true)).toBe(
      'Folder path copied to clipboard: ./output/20260618/Acme_Dev (relative to your docker-compose folder)',
    );
  });

  it('shows the path with the hint when the clipboard was unavailable', () => {
    expect(copyPathNotice(withRelative, false)).toBe(
      'Saved folder: ./output/20260618/Acme_Dev (relative to your docker-compose folder)',
    );
  });

  it('omits the docker-compose hint when only the raw dir is available', () => {
    expect(copyPathNotice({ opened: false, dir: 'C:\\out\\a' }, true)).toBe(
      'Folder path copied to clipboard: C:\\out\\a',
    );
  });
});
