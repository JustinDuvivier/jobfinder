/**
 * Shared server-side notifier: fire a native desktop notification by shelling
 * out to the single Python notifier module (scripts/notify.py). Used by the
 * /api/notify route (browser-triggered toasts) and callable directly from
 * server code such as the scheduler, without an HTTP hop.
 *
 * Security: the script path is built server-side; the title/message are passed
 * as separate argv entries to a no-shell spawn, so their contents can never
 * inject a command.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { isContainerMode } from '@/lib/env/container';

/** The slice of ChildProcess the notifier needs — lets tests inject a fake. */
export interface NotifierChild {
  on(event: 'error', listener: (err: Error) => void): unknown;
  unref(): void;
}

/** A spawn-shaped function; defaults to node:child_process spawn. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { stdio: 'ignore'; windowsHide: boolean },
) => NotifierChild;

/** Fire-and-forget: spawn the notifier, preferring `python`, falling back to
 * the Windows `py -3` launcher if it's absent. The fallback's own failure is
 * swallowed — a missed toast must never take the server down. */
export function fireNotifier(title: string, message: string, spawnFn: SpawnLike = nodeSpawn): void {
  // Container mode (JOBFINDER_CONTAINER=1): there is no desktop to toast on,
  // so degrade to a silent no-op — no spawn, no error. This is the single flag
  // check for the notifier module; every caller (the /api/notify route and the
  // scheduler's runner) degrades through it.
  if (isContainerMode()) return;

  const script = path.join(process.cwd(), 'scripts', 'notify.py');
  const args = [script, '--title', title, '--message', message];

  const launch = (cmd: string, cmdArgs: string[], onError: () => void): void => {
    // windowsHide hides the interpreter's console window; no `detached` (on
    // Windows that spawns a visible console). unref so the toast doesn't keep
    // the Node event loop alive.
    const child = spawnFn(cmd, cmdArgs, { stdio: 'ignore', windowsHide: true });
    child.on('error', onError); // e.g. ENOENT when the interpreter isn't on PATH
    child.unref();
  };

  launch('python', args, () => launch('py', ['-3', ...args], () => {}));
}
