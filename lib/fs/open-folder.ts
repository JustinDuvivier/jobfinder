/**
 * Open the folder containing a saved resume PDF in the OS file manager.
 *
 * SECURITY (NFR-7): this is reached only with a server-resolved path (read from
 * SQLite by job_id), never a client-supplied string, and it additionally
 * verifies the path resolves *inside* the configured output base directory
 * before opening. An "open folder" action is an OS shell operation, so the
 * identifier-in / path-out boundary is enforced here just as it is for /api/save.
 */
import { spawn } from 'node:child_process';
import { basename, dirname, relative, resolve, sep } from 'node:path';

/**
 * True iff `target` resolves to `base` or a path strictly inside it. Comparison
 * is case-insensitive on Windows and enforces a separator boundary so that
 * `.../jobs` does not match a sibling `.../jobs-other`.
 */
export function isWithinBase(target: string, base: string): boolean {
  const normalize = (p: string): string =>
    process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
  const baseResolved = normalize(base);
  const targetResolved = normalize(target);
  if (targetResolved === baseResolved) return true;
  const prefix = baseResolved.endsWith(sep) ? baseResolved : baseResolved + sep;
  return targetResolved.startsWith(prefix);
}

/** Spawn the platform's folder opener (best-effort; does not block on it). */
export function openFolder(dir: string): void {
  const command =
    process.platform === 'win32'
      ? 'explorer.exe'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  const child = spawn(command, [dir], { stdio: 'ignore', detached: true });
  // explorer.exe exits non-zero even on success; we don't await the result.
  child.on('error', () => {});
  child.unref();
}

/**
 * Verify a saved file path is inside the base directory and return its
 * containing folder, with no OS interaction. Throws if the path escapes base.
 * This is the containment step of openContainingFolder, and stands alone in
 * container mode, where the folder cannot be opened and the path is returned
 * to the client as a copy-path affordance instead.
 */
export function containedDir(filePath: string, baseDir: string): string {
  if (!isWithinBase(filePath, baseDir)) {
    throw new Error('Refusing to open a path outside the output directory');
  }
  return dirname(resolve(filePath));
}

/**
 * Present a contained directory the way the user sees it on their host: as a
 * `./`-prefixed, forward-slashed path relative to the *parent* of the base
 * directory. In the container the base is `/output`, bind-mounted from
 * `./output` next to `docker-compose.yml`, so `/output/20260618/X` is
 * presented as `./output/20260618/X` — the path relative to the user's compose
 * folder rather than a raw container path that exists nowhere on the host.
 * Pure presentation; callers pass a `dir` already verified by containedDir.
 */
export function composeRelativeDir(dir: string, baseDir: string): string {
  const base = resolve(baseDir);
  const rel = relative(base, resolve(dir)).split(sep).join('/');
  const prefix = `./${basename(base)}`;
  return rel === '' ? prefix : `${prefix}/${rel}`;
}

/**
 * Verify a saved file path is inside the base directory, then open its
 * containing folder. Returns the folder path. Throws if the path escapes base.
 */
export function openContainingFolder(filePath: string, baseDir: string): string {
  const dir = containedDir(filePath, baseDir);
  openFolder(dir);
  return dir;
}
