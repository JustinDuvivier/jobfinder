/**
 * Tests for POST /api/onboarding (FR-33) — a thin mapper that marks the guided
 * first-run flow finished.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repo from '@/lib/db/repo';
import { POST } from './route';

vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('@/lib/db/repo', () => ({ setOnboardingComplete: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/onboarding', () => {
  it('sets the onboarding flag and confirms', async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(vi.mocked(repo.setOnboardingComplete)).toHaveBeenCalledOnce();
  });
});
