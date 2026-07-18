/**
 * PathBuilder — a pure, side-effect-free utility that assembles the output path
 * for a saved resume PDF from identifiers. No I/O, no filesystem access.
 *
 * SECURITY: the full path must never travel from the browser to the server.
 * The client sends identifiers (job_id, company, title, owner); /api/save calls
 * this to construct the absolute path internally from the server's own base
 * directory. See jobfinder-docs.md "File System & Path Builder" and NFR-7.
 *
 * Layout (FR-18):
 *   base / YYYYMMDD / Company_Title_<disambiguator> / Owner_Resume.pdf
 *
 * The path is collision-free by construction: the disambiguator is derived from
 * the stable job_id, so two distinct postings sharing company+title on the same
 * day land in different folders, while re-approving the *same* job maps to the
 * same folder (an intentional overwrite, FR-20).
 */
import { createHash } from 'node:crypto';

/** Windows MAX_PATH. The full path is kept strictly under this. */
const MAX_PATH = 260;

/** Length of the job_id-derived disambiguator suffix (hex). */
const DISAMBIGUATOR_LENGTH = 6;

/**
 * Windows-illegal filename characters: the punctuation set < > : " / \ | ? *
 * plus ASCII control characters (0x00-0x1F). Space (0x20) is intentionally NOT
 * in this class — spaces are converted to underscores separately, and hyphens
 * are preserved (e.g. "Front-End").
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;

/** Windows reserved device names (case-insensitive), with or without extension. */
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export interface PathBuilderInput {
  /** Server-side configured base directory (from env). */
  baseDir: string;
  /** LinkedIn job id — the stable source of the folder disambiguator. */
  jobId: string;
  company: string;
  title: string;
  /** Owner name for the filename, e.g. "Alex_Candidate". */
  ownerName: string;
  /** Date of approval; defaults to now. Used for the YYYYMMDD folder. */
  date?: Date;
}

export interface BuiltPath {
  /** Absolute directory: base / YYYYMMDD / Company_Title_xxxxxx. */
  dir: string;
  /** Absolute file path including the PDF filename. */
  filePath: string;
  /** Path relative to baseDir (for the confirmation banner). */
  relativePath: string;
  /** The YYYYMMDD date folder segment. */
  dateFolder: string;
  /** The Company_Title_xxxxxx folder segment. */
  jobFolder: string;
  /** The Owner_Resume.pdf filename. */
  fileName: string;
}

/**
 * Sanitize one path segment: remove Windows-illegal characters, collapse
 * whitespace runs to single underscores, strip leading/trailing dots, spaces,
 * and underscores, and escape reserved device names. Returns '' for input that
 * sanitizes away entirely (the caller decides how to handle an empty segment).
 */
export function sanitizeSegment(raw: string): string {
  let s = raw.normalize('NFC').replace(ILLEGAL_CHARS, '');
  s = s.replace(/\s+/g, '_'); // spaces become underscores
  s = s.replace(/_+/g, '_'); // collapse runs of underscores
  s = s.replace(/^[._\s]+|[._\s]+$/g, ''); // strip leading/trailing . _ space
  if (s.length === 0) return '';
  // Reserved name check is on the base (pre-extension) token.
  const base = s.split('.')[0]!.toUpperCase();
  if (RESERVED_NAMES.has(base)) {
    s = `_${s}`;
  }
  return s;
}

/** Format a date as YYYYMMDD (local time) so folders sort chronologically. */
export function formatDateFolder(date: Date): string {
  const y = date.getFullYear().toString().padStart(4, '0');
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return `${y}${m}${d}`;
}

/** A short, stable hex disambiguator derived from the job id. */
export function disambiguator(jobId: string): string {
  return createHash('sha256').update(jobId).digest('hex').slice(0, DISAMBIGUATOR_LENGTH);
}

function joinWin(...parts: string[]): string {
  // Server is Windows; join with backslashes, avoiding doubled separators.
  return parts
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .filter((p) => p.length > 0)
    .join('\\');
}

/**
 * Build the deterministic output path for a saved resume PDF.
 *
 * Guards against the Windows MAX_PATH (260) limit by truncating the
 * company-plus-title portion of the job folder while always preserving the
 * disambiguator suffix (which is what keeps the path collision-free).
 */
export function buildResumePath(input: PathBuilderInput): BuiltPath {
  const date = input.date ?? new Date();
  const dateFolder = formatDateFolder(date);
  const suffix = disambiguator(input.jobId);
  const fileName = `${sanitizeSegment(input.ownerName) || 'Resume'}_Resume.pdf`;

  const company = sanitizeSegment(input.company);
  const title = sanitizeSegment(input.title);
  let companyTitle = [company, title].filter((p) => p.length > 0).join('_');

  // Reserve room so the full path stays under MAX_PATH. The job folder is
  // `${companyTitle}_${suffix}`; everything else is fixed-length here.
  const fixedLength =
    joinWin(input.baseDir, dateFolder).length +
    1 /* separator before job folder */ +
    `_${suffix}`.length +
    1 /* separator before filename */ +
    fileName.length;
  const available = MAX_PATH - 1 - fixedLength;
  if (companyTitle.length > Math.max(0, available)) {
    companyTitle = companyTitle.slice(0, Math.max(0, available)).replace(/_+$/, '');
  }

  const jobFolder = companyTitle.length > 0 ? `${companyTitle}_${suffix}` : suffix;

  const dir = joinWin(input.baseDir, dateFolder, jobFolder);
  const filePath = joinWin(dir, fileName);
  const relativePath = joinWin(dateFolder, jobFolder, fileName);

  return { dir, filePath, relativePath, dateFolder, jobFolder, fileName };
}
