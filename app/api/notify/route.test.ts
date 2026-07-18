/**
 * Tests for POST /api/notify — a thin shell over the shared lib/notify
 * notifier. Pinned here: the request contract (title defaults to 'JobFinder'
 * and is sliced to 200; message defaults to '' and is sliced to 500; malformed
 * JSON falls back to the defaults), `{ ok: true }` on success, and a notifier
 * throw mapping to `{ ok: false, error }` with status 500. The notifier is
 * mocked so no real toast fires.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireNotifier } from '@/lib/notify/notifier';
import { POST } from './route';

vi.mock('@/lib/notify/notifier', () => ({ fireNotifier: vi.fn() }));

const mockedFire = vi.mocked(fireNotifier);

function post(body: string): Promise<Response> {
  return POST(new Request('http://127.0.0.1/api/notify', { method: 'POST', body }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/notify', () => {
  it('fires the notifier with the given title and body and returns ok', async () => {
    const res = await post(JSON.stringify({ title: 'JobFinder', body: 'strong match' }));
    expect(mockedFire).toHaveBeenCalledTimes(1);
    expect(mockedFire).toHaveBeenCalledWith('JobFinder', 'strong match');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('defaults the title to "JobFinder" and the message to "" when absent', async () => {
    const res = await post(JSON.stringify({}));
    expect(mockedFire).toHaveBeenCalledWith('JobFinder', '');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('applies the defaults when the body is not valid JSON', async () => {
    const res = await post('not json');
    expect(mockedFire).toHaveBeenCalledWith('JobFinder', '');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('ignores non-string title/body values', async () => {
    await post(JSON.stringify({ title: 42, body: ['x'] }));
    expect(mockedFire).toHaveBeenCalledWith('JobFinder', '');
  });

  it('truncates the title to 200 and the message to 500 characters', async () => {
    await post(JSON.stringify({ title: 'T'.repeat(300), body: 'M'.repeat(600) }));
    expect(mockedFire).toHaveBeenCalledWith('T'.repeat(200), 'M'.repeat(500));
  });

  it('maps a notifier throw to { ok: false, error } with status 500', async () => {
    mockedFire.mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await post(JSON.stringify({ title: 't' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'boom' });
  });
});
