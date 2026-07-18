import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { countPdfPages, isOnePage } from './page-count';

/** Build a PDF with exactly `pages` blank pages. */
async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  return doc.save();
}

describe('countPdfPages', () => {
  it('counts a single-page PDF', async () => {
    expect(await countPdfPages(await makePdf(1))).toBe(1);
  });

  it('counts a multi-page PDF', async () => {
    expect(await countPdfPages(await makePdf(3))).toBe(3);
  });
});

describe('isOnePage (the save-time invariant)', () => {
  it('is true for one page', async () => {
    expect(await isOnePage(await makePdf(1))).toBe(true);
  });

  it('is false for two pages', async () => {
    expect(await isOnePage(await makePdf(2))).toBe(false);
  });
});
