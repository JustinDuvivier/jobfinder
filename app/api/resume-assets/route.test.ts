/**
 * Tests for GET/PUT/DELETE /api/resume-assets (FR-33) — a thin mapper over the
 * repo and the resolution (both covered in lib). Pinned here: the request
 * contract (name/content validation → 400), the base-resume authoring gate
 * (compile failure and a not-one-page result → 422 with the error surfaced,
 * nothing persisted), the persist-on-success path, and DELETE returning the
 * now-effective fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repo from '@/lib/db/repo';
import { resolveResumeAssets } from '@/lib/resume/load';
import { compileLatex, LatexCompileError } from '@/lib/latex/compile';
import { GET, PUT, DELETE } from './route';

vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('@/lib/db/repo', () => ({
  setResumeAsset: vi.fn(),
  deleteResumeAsset: vi.fn(),
}));
vi.mock('@/lib/resume/load', () => ({ resolveResumeAssets: vi.fn() }));
vi.mock('@/lib/latex/compile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/latex/compile')>()),
  compileLatex: vi.fn(),
}));

const setResumeAsset = vi.mocked(repo.setResumeAsset);
const deleteResumeAsset = vi.mocked(repo.deleteResumeAsset);
const resolve = vi.mocked(resolveResumeAssets);
const compile = vi.mocked(compileLatex);

const RESOLVED = {
  base_resume: { content: 'tex', provenance: 'example' as const },
  source_of_truth: { content: 'sot', provenance: 'file' as const },
  scoring_prompt: { content: 'sp', provenance: 'example' as const },
  rewrite_rules: { content: 'rr', provenance: 'in-app' as const },
};

function request(method: 'PUT' | 'DELETE', body: unknown): Request {
  return new Request('http://127.0.0.1/api/resume-assets', {
    method,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resolve.mockReturnValue(RESOLVED);
});

describe('GET /api/resume-assets', () => {
  it('returns every asset with effective content and provenance', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assets: RESOLVED });
  });

  it('maps a broken-checkout resolution error to 500', async () => {
    resolve.mockImplementation(() => {
      throw new Error('Missing resume asset: resume/base_resume.tex');
    });
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Missing resume asset: resume/base_resume.tex' });
  });
});

describe('PUT /api/resume-assets', () => {
  it.each([
    ['unparseable body', 'not json'],
    ['missing name', { content: 'x' }],
    ['unknown name', { name: 'cover_letter', content: 'x' }],
  ])('rejects %s with 400', async (_case, body) => {
    const res = await PUT(request('PUT', body));
    expect(res.status).toBe(400);
    expect(setResumeAsset).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', { name: 'scoring_prompt' }],
    ['blank', { name: 'scoring_prompt', content: '   \n' }],
  ])('rejects %s content with 400', async (_case, body) => {
    const res = await PUT(request('PUT', body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing "content" string' });
    expect(setResumeAsset).not.toHaveBeenCalled();
  });

  it('saves a companion document without compiling', async () => {
    const res = await PUT(request('PUT', { name: 'source_of_truth', content: 'my truth' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      asset: { content: 'my truth', provenance: 'in-app' },
    });
    expect(setResumeAsset).toHaveBeenCalledWith(expect.anything(), 'source_of_truth', 'my truth');
    expect(compile).not.toHaveBeenCalled();
  });

  it('saves the base resume only after a one-page compile', async () => {
    compile.mockResolvedValue({ pdf: new Uint8Array(), pageCount: 1, hash: 'h', cached: false });
    const res = await PUT(request('PUT', { name: 'base_resume', content: '\\documentclass...' }));
    expect(res.status).toBe(200);
    expect(compile).toHaveBeenCalledWith('\\documentclass...');
    expect(setResumeAsset).toHaveBeenCalledWith(expect.anything(), 'base_resume', '\\documentclass...');
  });

  it('refuses a base resume that fails to compile with 422 and the log', async () => {
    compile.mockRejectedValue(new LatexCompileError('pdflatex exited with code 1', '! Undefined control sequence.'));
    const res = await PUT(request('PUT', { name: 'base_resume', content: 'bad tex' }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'The resume failed to compile',
      log: '! Undefined control sequence.',
    });
    expect(setResumeAsset).not.toHaveBeenCalled();
  });

  it('refuses a base resume that compiles to more than one page with 422', async () => {
    compile.mockResolvedValue({ pdf: new Uint8Array(), pageCount: 2, hash: 'h', cached: false });
    const res = await PUT(request('PUT', { name: 'base_resume', content: 'long tex' }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'The resume compiles to 2 pages — it must be exactly one page.',
    });
    expect(setResumeAsset).not.toHaveBeenCalled();
  });

  it('maps an unexpected compile failure to 500, persisting nothing', async () => {
    compile.mockRejectedValue(new Error('spawn ENOENT'));
    const res = await PUT(request('PUT', { name: 'base_resume', content: 'tex' }));
    expect(res.status).toBe(500);
    expect(setResumeAsset).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/resume-assets', () => {
  it('rejects an unknown name with 400', async () => {
    const res = await DELETE(request('DELETE', { name: 'nope' }));
    expect(res.status).toBe(400);
    expect(deleteResumeAsset).not.toHaveBeenCalled();
  });

  it('reverts the asset and returns the now-effective fallback', async () => {
    const res = await DELETE(request('DELETE', { name: 'source_of_truth' }));
    expect(res.status).toBe(200);
    expect(deleteResumeAsset).toHaveBeenCalledWith(expect.anything(), 'source_of_truth');
    expect(await res.json()).toEqual({
      ok: true,
      asset: { content: 'sot', provenance: 'file' },
    });
  });

  it('maps a missing fallback to 500 after the revert', async () => {
    resolve.mockImplementation(() => {
      throw new Error('Missing resume asset: resume/source_of_truth.md');
    });
    const res = await DELETE(request('DELETE', { name: 'source_of_truth' }));
    expect(res.status).toBe(500);
    expect(deleteResumeAsset).toHaveBeenCalled();
  });
});
