/**
 * Pure helpers behind the Tracker's approved-PDF affordances — the View PDF
 * link (FR-35) and the container-mode copy-path notice (FR-30) — extracted
 * from TrackerClient so the presentation contract is testable without a DOM.
 */

/** Response shape of POST /api/open-folder. */
export type OpenFolderResult = {
  opened: boolean;
  dir: string;
  /** Container mode only: `dir` as `./output/...` relative to the compose folder. */
  relativeDir?: string;
};

/** Browser URL that streams a job's approved PDF (GET /api/jobs/pdf, FR-35). */
export function pdfHref(jobId: number): string {
  return `/api/jobs/pdf?jobId=${jobId}`;
}

/**
 * The path a container-mode open-folder response should copy/show: the
 * server-computed `./output/...` form when present (a path that actually
 * exists on the user's host), else the raw directory.
 */
export function copyPath(res: OpenFolderResult): string {
  return res.relativeDir ?? res.dir;
}

/**
 * The notice shown after a container-mode open-folder response. The
 * compose-relative form gets a hint anchoring it to the user's
 * docker-compose folder; the raw-path fallback gets no hint.
 */
export function copyPathNotice(res: OpenFolderResult, copied: boolean): string {
  const lead = copied ? 'Folder path copied to clipboard' : 'Saved folder';
  const hint = res.relativeDir !== undefined ? ' (relative to your docker-compose folder)' : '';
  return `${lead}: ${copyPath(res)}${hint}`;
}
