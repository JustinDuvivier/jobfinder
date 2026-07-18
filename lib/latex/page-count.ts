/**
 * The one-page gate's measurement primitive: read a compiled PDF's page count.
 *
 * Invariant #1 (one-page guarantee) is enforced at /api/save by requiring this
 * to return exactly 1 before the PDF is written to disk (FR-17, NFR-3). The
 * preview path also reports it so the user can see a spill onto page two.
 */
import { PDFDocument } from 'pdf-lib';

/** Count the pages in a PDF given its raw bytes. */
export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPageCount();
}

/** True iff the PDF is exactly one page — the save-time invariant. */
export async function isOnePage(bytes: Uint8Array): Promise<boolean> {
  return (await countPdfPages(bytes)) === 1;
}
