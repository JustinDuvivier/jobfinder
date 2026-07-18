/**
 * Tests for GET /api/rewrite/status — returns the registry snapshot as JSON.
 * The registry is faked; its lifecycle lives in lib/rewrite/registry.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRewriteRegistry, type RewriteSnapshotEntry } from '@/lib/rewrite/registry';
import { GET } from './route';

const snapshot = vi.hoisted(() => ({ value: [] as RewriteSnapshotEntry[] }));

vi.mock('@/lib/rewrite/registry', () => ({
  getRewriteRegistry: vi.fn(() => ({ snapshot: () => snapshot.value })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  snapshot.value = [];
});

describe('GET /api/rewrite/status', () => {
  it('returns an empty job list when nothing is in flight', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobs: [] });
    expect(getRewriteRegistry).toHaveBeenCalledOnce();
  });

  it('returns the registry snapshot for the tracked jobs', async () => {
    snapshot.value = [
      { jobId: 1, company: 'Stripe', title: 'AI Engineer', phase: 'running' },
      { jobId: 2, company: 'Ramp', title: 'ML Engineer', phase: 'done' },
    ];
    const res = await GET();
    expect(await res.json()).toEqual({ jobs: snapshot.value });
  });
});
