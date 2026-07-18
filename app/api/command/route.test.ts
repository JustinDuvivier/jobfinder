/**
 * Tests for POST /api/command — a thin dispatcher over the tested Command
 * layer. Pinned here: the request contract (400 for a bad jobId, unknown type,
 * or invalid target status), the delegation per command type, and the error
 * mapping ("not found" → 404, everything else the commands throw → 409).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as commands from '@/lib/commands';
import { POST } from './route';

vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('@/lib/commands', () => ({
  executePassJob: vi.fn(),
  executeContinue: vi.fn(),
  executeChangeTrackerStatus: vi.fn(),
  executeMoveTrackerStatus: vi.fn(),
  undoLastCommand: vi.fn(),
}));

const executePassJob = vi.mocked(commands.executePassJob);
const executeContinue = vi.mocked(commands.executeContinue);
const executeChangeTrackerStatus = vi.mocked(commands.executeChangeTrackerStatus);
const executeMoveTrackerStatus = vi.mocked(commands.executeMoveTrackerStatus);
const undoLastCommand = vi.mocked(commands.undoLastCommand);

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://127.0.0.1/api/command', { method: 'POST', body: JSON.stringify(body) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/command', () => {
  it('rejects a missing or non-numeric jobId with 400', async () => {
    const res = await post({ type: 'pass' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing numeric "jobId"' });
  });

  it('rejects an unknown command type with 400', async () => {
    const res = await post({ type: 'explode', jobId: 7 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown command type "explode"' });
  });

  it('rejects an invalid target status for tracker commands with 400', async () => {
    for (const type of ['tracker', 'tracker-move']) {
      const res = await post({ type, jobId: 7, to: 'nonsense' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid target status "to"' });
    }
    expect(executeChangeTrackerStatus).not.toHaveBeenCalled();
    expect(executeMoveTrackerStatus).not.toHaveBeenCalled();
  });

  it('delegates each command type to its executor', async () => {
    executePassJob.mockReturnValue({ commandId: 1, status: 'passed' });
    expect(await (await post({ type: 'pass', jobId: 7 })).json()).toEqual({
      ok: true,
      commandId: 1,
      status: 'passed',
    });
    expect(executePassJob).toHaveBeenCalledWith(expect.anything(), 7);

    executeContinue.mockReturnValue({ commandId: 2, status: 'rewriting' });
    await post({ type: 'continue', jobId: 7 });
    expect(executeContinue).toHaveBeenCalledWith(expect.anything(), 7);

    executeChangeTrackerStatus.mockReturnValue({ commandId: 3, status: 'applied' });
    await post({ type: 'tracker', jobId: 7, to: 'applied' });
    expect(executeChangeTrackerStatus).toHaveBeenCalledWith(expect.anything(), 7, 'applied');

    executeMoveTrackerStatus.mockReturnValue({ commandId: 4, status: 'interview' });
    await post({ type: 'tracker-move', jobId: 7, to: 'interview' });
    expect(executeMoveTrackerStatus).toHaveBeenCalledWith(expect.anything(), 7, 'interview');

    undoLastCommand.mockReturnValue({ undone: 'PassJob' } as never);
    expect(await (await post({ type: 'undo', jobId: 7 })).json()).toEqual({
      ok: true,
      undo: { undone: 'PassJob' },
    });
  });

  it('maps a "not found" command error to 404 and any other to 409', async () => {
    executePassJob.mockImplementation(() => {
      throw new Error('Job 7 not found');
    });
    const notFound = await post({ type: 'pass', jobId: 7 });
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: 'Job 7 not found' });

    executePassJob.mockImplementation(() => {
      throw new Error('Invalid transition scored -> approved');
    });
    const conflict = await post({ type: 'pass', jobId: 7 });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'Invalid transition scored -> approved' });
  });
});
