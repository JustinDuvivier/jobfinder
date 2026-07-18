/**
 * Tests for the shared notifier module. Pinned here: the exact spawn contract
 * (server-built script path, title/message as separate argv entries, no-shell
 * options, unref) and the `python` → `py -3` interpreter fallback with the
 * fallback's own failure swallowed. The spawn function is injected so no real
 * process is started and no toast fires.
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { fireNotifier, type SpawnLike } from './notifier';

const SCRIPT = path.join(process.cwd(), 'scripts', 'notify.py');

type ErrorListener = (err: Error) => void;

/** A fake spawn that records calls and lets tests emit 'error' per child. */
function makeFakeSpawn() {
  const children: { unref: ReturnType<typeof vi.fn>; emitError: () => void }[] = [];
  const spawn = vi.fn((..._args: Parameters<SpawnLike>) => {
    let listener: ErrorListener | undefined;
    const child = {
      on: vi.fn((_event: 'error', l: ErrorListener) => {
        listener = l;
        return child;
      }),
      unref: vi.fn(),
    };
    children.push({
      unref: child.unref,
      emitError: () => listener?.(new Error('spawn ENOENT')),
    });
    return child;
  });
  return { spawn, children };
}

describe('fireNotifier', () => {
  it('spawns `python` once with the server-built script path and separate argv entries', () => {
    const { spawn, children } = makeFakeSpawn();
    fireNotifier('JobFinder', 'a new match', spawn);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      'python',
      [SCRIPT, '--title', 'JobFinder', '--message', 'a new match'],
      { stdio: 'ignore', windowsHide: true },
    );
    expect(children[0].unref).toHaveBeenCalledTimes(1);
  });

  it('passes shell metacharacters through verbatim as argv, never a shell string', () => {
    const { spawn } = makeFakeSpawn();
    const title = 'Job "Sniper" & friends';
    const message = 'match; rm -rf / | echo $PWD';
    fireNotifier(title, message, spawn);

    const [cmd, args] = spawn.mock.calls[0];
    expect(cmd).toBe('python');
    // Each value is its own argv entry, byte-for-byte.
    expect(args[2]).toBe(title);
    expect(args[4]).toBe(message);
    // No shell is involved, so no option like `shell: true` may appear.
    expect(spawn.mock.calls[0][2]).toEqual({ stdio: 'ignore', windowsHide: true });
  });

  it('falls back to `py -3` with the same args when `python` fails to spawn', () => {
    const { spawn, children } = makeFakeSpawn();
    fireNotifier('t', 'm', spawn);

    children[0].emitError();

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenLastCalledWith(
      'py',
      ['-3', SCRIPT, '--title', 't', '--message', 'm'],
      { stdio: 'ignore', windowsHide: true },
    );
    expect(children[1].unref).toHaveBeenCalledTimes(1);
  });

  it('swallows the fallback interpreter failure instead of throwing', () => {
    const { spawn, children } = makeFakeSpawn();
    fireNotifier('t', 'm', spawn);

    children[0].emitError();
    expect(() => children[1].emitError()).not.toThrow();
    expect(spawn).toHaveBeenCalledTimes(2); // no third attempt
  });
});
